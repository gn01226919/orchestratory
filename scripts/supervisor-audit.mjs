#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBoundedProcessGroup } from "./bounded-process-group.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_MIRROR_BYTES = 1024 * 1024;
const MAX_MIRROR_MANIFEST_BYTES = 16 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_READ_DEADLINE_MS = 45_000;
const REPORT_WRITE_DEADLINE_MS = 5_000;
const INTERNAL_AUDIT_WORKER = "--internal-audit-worker";
const INTERNAL_REPORT_WRITER = "--internal-report-writer";
const DEFAULT_BRANCH = "agent/native-full-trust-vnext";
const DEFAULT_ROOM = "orchestratory";
const DEFAULT_DATA_DIR = join(homedir(), "Library", "Application Support", "Orchestratory");
const DEFAULT_REPORT_DIR = join(DEFAULT_DATA_DIR, "supervisor");

function usage() {
  return [
    "Usage: node scripts/supervisor-audit.mjs [options]",
    "",
    "Read-only workspace and control-plane audit. Exit 0 only when every configured check passes.",
    "",
    "Options:",
    "  --workspace <path>       Canonical workspace (default: cwd)",
    `  --branch <name>          Expected branch (default: ${DEFAULT_BRANCH})`,
    `  --room <id>              Room to check (default: ${DEFAULT_ROOM})`,
    `  --data-directory <path>  Read-only control-plane data (default: ${DEFAULT_DATA_DIR})`,
    "  --status-file <path>     Owner-local status mirror to check",
    "  --pending-file <path>    Owner-local pending-decisions mirror to check",
    "  --mirror-manifest <path> Owner-local mirror metadata and freshness manifest",
    `  --read-deadline-ms <ms>  Hard process-group deadline for all reads (default: ${DEFAULT_READ_DEADLINE_MS})`,
    `  --report-dir <path>      Report directory (default: ${DEFAULT_REPORT_DIR})`,
    "  --json                   Print the complete bounded JSON report",
    "  --help                   Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const defaultReportDir = process.env.ORCHESTRATORY_SUPERVISOR_REPORT_DIR ?? DEFAULT_REPORT_DIR;
  const options = {
    workspace: process.cwd(),
    branch: DEFAULT_BRANCH,
    room: DEFAULT_ROOM,
    dataDirectory: DEFAULT_DATA_DIR,
    statusFile: join(defaultReportDir, "status-marker.md"),
    pendingFile: join(defaultReportDir, "pending-marker.md"),
    mirrorManifest: join(defaultReportDir, "mirror-manifest.json"),
    readDeadlineMs: DEFAULT_READ_DEADLINE_MS,
    reportDir: defaultReportDir,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { ...options, help: true };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const key = {
      "--workspace": "workspace",
      "--branch": "branch",
      "--room": "room",
      "--data-directory": "dataDirectory",
      "--status-file": "statusFile",
      "--pending-file": "pendingFile",
      "--mirror-manifest": "mirrorManifest",
      "--read-deadline-ms": "readDeadlineMs",
      "--report-dir": "reportDir",
    }[arg];
    if (!key) throw new Error(`SUPERVISOR_UNKNOWN_ARGUMENT:${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`SUPERVISOR_VALUE_REQUIRED:${arg}`);
    options[key] = value;
    index += 1;
  }
  options.workspace = resolve(options.workspace);
  for (const key of ["dataDirectory", "statusFile", "pendingFile", "mirrorManifest", "reportDir"]) {
    if (!isAbsolute(options[key])) options[key] = resolve(options.workspace, options[key]);
  }
  if (!/^[0-9]+$/u.test(String(options.readDeadlineMs))) throw new Error("SUPERVISOR_READ_DEADLINE_INVALID");
  options.readDeadlineMs = Number(options.readDeadlineMs);
  if (!Number.isSafeInteger(options.readDeadlineMs) || options.readDeadlineMs < 100 || options.readDeadlineMs > 120_000) {
    throw new Error("SUPERVISOR_READ_DEADLINE_INVALID");
  }
  return options;
}

function cleanDetail(value, fallback = "command failed") {
  const line = String(value ?? "").split("\n").find((item) => item.trim())?.trim() ?? fallback;
  return line.replaceAll(/\s+/gu, " ").slice(0, 500);
}

async function command(file, args, cwd) {
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 30_000,
      windowsHide: true,
    });
    return { ok: true, code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return {
      ok: false,
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: cleanDetail(error?.stderr ?? error?.message),
    };
  }
}

function check(name, ok, detail, value) {
  return { name, status: ok ? "pass" : "fail", detail, ...(value === undefined ? {} : { value }) };
}

function alert(code, detail, nextAction) {
  return { code, detail, nextAction };
}

function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function ownerUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function assertOwnerDirectory(path, errorCode) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (ownerUid() !== undefined && info.uid !== ownerUid())
  ) throw new Error(errorCode);
}

async function assertOwnerFile(path, errorCode, allowMissing = false) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return undefined;
    throw new Error(errorCode);
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    (ownerUid() !== undefined && info.uid !== ownerUid())
  ) throw new Error(errorCode);
  return info;
}

async function sqliteFiles(dataDirectory) {
  await assertOwnerDirectory(dataDirectory, "SUPERVISOR_DATA_DIRECTORY_UNSAFE");
  const entries = await readdir(dataDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sqlite"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error("SUPERVISOR_DATABASES_MISSING");
  return files;
}

async function databaseIntegrity(dataDirectory) {
  const summaries = [];
  for (const filename of await sqliteFiles(dataDirectory)) {
    const path = join(dataDirectory, filename);
    await assertOwnerFile(path, "SUPERVISOR_DATABASE_UNSAFE");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      await assertOwnerFile(`${path}${suffix}`, "SUPERVISOR_DATABASE_SIDECAR_UNSAFE", true);
    }
    let database;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
      const quickRows = database.prepare("PRAGMA quick_check").all();
      const quickCheck = quickRows.length === 1 && String(quickRows[0]?.quick_check) === "ok" ? "ok" : "invalid";
      const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? -1);
      summaries.push({ filename, quickCheck, foreignKeyViolations, schemaVersion: version });
    } finally {
      database?.close();
    }
  }
  return summaries;
}

function roomMessageHash(message, previousHash) {
  return createHash("sha256")
    .update(JSON.stringify([
      message.room_id,
      message.seq,
      message.at,
      message.author,
      message.kind,
      message.text,
      previousHash,
    ]), "utf8")
    .digest("hex");
}

async function roomIntegrity(dataDirectory, roomId) {
  const path = join(dataDirectory, "rooms.sqlite");
  await assertOwnerFile(path, "SUPERVISOR_ROOM_DATABASE_UNSAFE");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
    const room = database.prepare("SELECT id,recording FROM rooms WHERE id=?").get(roomId);
    if (!room) return { found: false, recording: undefined, messages: 0, chainValid: false };
    const messages = database.prepare(
      "SELECT room_id,seq,at,author,kind,text,hash FROM room_messages WHERE room_id=? ORDER BY seq",
    ).all(roomId);
    let previous = "genesis";
    let expectedSeq = 1;
    let chainValid = true;
    for (const message of messages) {
      if (
        message.seq !== expectedSeq ||
        message.hash !== roomMessageHash(message, previous)
      ) {
        chainValid = false;
        break;
      }
      previous = message.hash;
      expectedSeq += 1;
    }
    return { found: true, recording: room.recording, messages: messages.length, chainValid };
  } finally {
    database?.close();
  }
}

async function writeBoundedReport(report, options) {
  if (inside(options.workspace, options.reportDir)) throw new Error("SUPERVISOR_REPORT_INSIDE_WORKSPACE");
  await mkdir(options.reportDir, { recursive: true, mode: 0o700 });
  await assertOwnerDirectory(options.reportDir, "SUPERVISOR_REPORT_DIRECTORY_UNSAFE");
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_REPORT_BYTES) throw new Error("SUPERVISOR_REPORT_TOO_LARGE");
  const reportPath = join(options.reportDir, "last-report.json");
  await assertOwnerFile(reportPath, "SUPERVISOR_REPORT_FILE_UNSAFE", true);
  const temporary = join(options.reportDir, `.last-report.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, reportPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function mirrorFailure(code, detail) {
  return { valid: false, code, detail, statusText: undefined, pendingText: undefined, metadata: undefined };
}

async function validateMirrors(options, nowMs = Date.now()) {
  try {
    const manifestInfo = await assertOwnerFile(options.mirrorManifest, "OBSIDIAN_MIRROR_MANIFEST_UNSAFE");
    if (!manifestInfo || manifestInfo.size > MAX_MIRROR_MANIFEST_BYTES) {
      return mirrorFailure("OBSIDIAN_MIRROR_MANIFEST_INVALID", "Mirror manifest is missing or exceeds 16 KiB.");
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(options.mirrorManifest, "utf8"));
    } catch {
      return mirrorFailure("OBSIDIAN_MIRROR_MANIFEST_INVALID", "Mirror manifest is not valid bounded JSON.");
    }
    const mirroredAtMs = Date.parse(manifest?.mirroredAt);
    const staleAfterSeconds = manifest?.staleness?.staleAfterSeconds;
    const expectedExpiresAt = Number.isFinite(mirroredAtMs) && Number.isSafeInteger(staleAfterSeconds)
      ? new Date(mirroredAtMs + staleAfterSeconds * 1000).toISOString()
      : undefined;
    if (
      manifest?.schemaVersion !== 1 || !Number.isFinite(mirroredAtMs) || mirroredAtMs > nowMs + 300_000 ||
      !Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 60 || staleAfterSeconds > 31_536_000 ||
      manifest?.staleness?.expiresAt !== expectedExpiresAt || !manifest?.files
    ) return mirrorFailure("OBSIDIAN_MIRROR_MANIFEST_INVALID", "Mirror metadata schema, timestamp, or staleness bound is invalid.");

    const texts = {};
    const files = {};
    for (const [name, expectedPath] of [["status", options.statusFile], ["pending", options.pendingFile]]) {
      const entry = manifest.files[name];
      if (
        !entry || !isAbsolute(entry.source ?? "") || entry.mirror !== expectedPath ||
        !/^[a-f0-9]{64}$/u.test(entry.digest ?? "") ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_MIRROR_BYTES
      ) return mirrorFailure("OBSIDIAN_MIRROR_MANIFEST_INVALID", `Mirror metadata for ${name} is invalid.`);
      const info = await assertOwnerFile(expectedPath, "OBSIDIAN_MIRROR_FILE_UNSAFE");
      if (!info || info.size !== entry.bytes || info.size > MAX_MIRROR_BYTES) {
        return mirrorFailure("OBSIDIAN_MIRROR_SIZE_MISMATCH", `${name} mirror size does not match its manifest.`);
      }
      const bytes = await readFile(expectedPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== entry.bytes || digest !== entry.digest) {
        return mirrorFailure("OBSIDIAN_MIRROR_DIGEST_MISMATCH", `${name} mirror digest does not match its manifest.`);
      }
      texts[name] = bytes.toString("utf8");
      files[name] = { source: entry.source, mirror: entry.mirror, digest, bytes: entry.bytes };
    }

    const ageSeconds = Math.max(0, Math.floor((nowMs - mirroredAtMs) / 1000));
    const stale = nowMs > mirroredAtMs + staleAfterSeconds * 1000;
    const metadata = {
      manifest: options.mirrorManifest,
      mirroredAt: manifest.mirroredAt,
      ageSeconds,
      staleness: { staleAfterSeconds, expiresAt: expectedExpiresAt, stale },
      files,
    };
    if (stale) {
      return { ...mirrorFailure("OBSIDIAN_MIRROR_STALE", `Mirror is ${ageSeconds}s old; freshness bound is ${staleAfterSeconds}s.`), metadata };
    }
    return { valid: true, statusText: texts.status, pendingText: texts.pending, metadata };
  } catch (error) {
    return mirrorFailure(
      String(error?.message ?? "").startsWith("OBSIDIAN_") ? String(error.message) : "OBSIDIAN_MIRROR_UNREADABLE",
      cleanDetail(error?.message, "Mirror metadata or files could not be read."),
    );
  }
}

async function auditInProcess(options) {
  const startedAt = new Date().toISOString();
  const checks = [];
  const alerts = [];

  const root = await command("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], options.workspace);
  const expectedRoot = await realpath(options.workspace).catch(() => resolve(options.workspace));
  const actualRoot = root.ok
    ? await realpath(root.stdout.trim()).catch(() => resolve(root.stdout.trim()))
    : undefined;
  checks.push(check(
    "git-root",
    actualRoot === expectedRoot,
    actualRoot === expectedRoot ? "canonical workspace resolved" : "git root does not match workspace",
    actualRoot,
  ));
  if (actualRoot !== expectedRoot) {
    alerts.push(alert("WORKSPACE_ROOT_MISMATCH", "The supervisor is not auditing the canonical git root.", "Stop and restart it with the exact canonical workspace path."));
  }

  const branch = await command("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], options.workspace);
  const branchName = branch.ok ? branch.stdout.trim() : undefined;
  checks.push(check(
    "branch",
    branchName === options.branch,
    branchName === options.branch ? `on expected branch ${options.branch}` : `expected ${options.branch}, found ${branchName ?? "detached/unknown"}`,
    branchName,
  ));
  if (branchName !== options.branch) {
    alerts.push(alert("BRANCH_DRIFT", `Expected ${options.branch}; found ${branchName ?? "detached/unknown"}.`, "Pause code changes and return to the approved project branch; do not auto-switch branches."));
  }

  const head = await command("git", ["--no-optional-locks", "rev-parse", "HEAD"], options.workspace);
  const main = await command("git", ["--no-optional-locks", "rev-parse", "main"], options.workspace);
  const originMain = await command("git", ["--no-optional-locks", "rev-parse", "origin/main"], options.workspace);
  const headHash = head.ok ? head.stdout.trim() : undefined;
  const mainHash = main.ok ? main.stdout.trim() : undefined;
  const originMainHash = originMain.ok ? originMain.stdout.trim() : undefined;
  checks.push(check("head-main", Boolean(headHash && mainHash && headHash === mainHash), headHash === mainHash ? "HEAD matches local main" : "HEAD differs from local main", { head: headHash, main: mainHash }));
  if (headHash !== mainHash) {
    alerts.push(alert("HEAD_MAIN_DRIFT", "The checked-out work is not the local main reference.", "Review the branch/candidate state and re-establish the intended base before further work."));
  }
  checks.push(check("main-origin-main", Boolean(mainHash && originMainHash && mainHash === originMainHash), mainHash === originMainHash ? "local main matches origin/main" : originMain.ok ? "local main differs from origin/main" : "origin/main is unavailable", { main: mainHash, originMain: originMainHash }));
  if (originMain.ok && mainHash !== originMainHash) {
    alerts.push(alert("ORIGIN_MAIN_DRIFT", "local main and origin/main differ.", "Treat the remote state as drift; inspect refs and reconcile intentionally. Do not auto-fetch, reset, or push."));
  }

  const status = await command("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], options.workspace);
  const statusLines = status.ok ? status.stdout.split("\n").filter(Boolean) : [status.error ?? "git status failed"];
  checks.push(check("worktree-clean", status.ok && statusLines.length === 0, status.ok && statusLines.length === 0 ? "working tree is clean" : `${statusLines.length} changed or untracked path(s) detected`, { changedPaths: statusLines.length }));
  if (!status.ok || statusLines.length > 0) {
    alerts.push(alert("WORKTREE_DIRTY", "The canonical worktree is not clean.", "Preserve and inspect the existing changes; never reset or overwrite them automatically."));
  }

  const diffCheck = await command("git", ["--no-optional-locks", "diff", "--check"], options.workspace);
  const stagedDiffCheck = await command("git", ["--no-optional-locks", "diff", "--cached", "--check"], options.workspace);
  const diffChecksPass = diffCheck.ok && stagedDiffCheck.ok;
  checks.push(check("diff-check", diffChecksPass, diffChecksPass ? "working and staged diff checks passed" : cleanDetail(diffCheck.stderr || stagedDiffCheck.stderr, "git diff --check failed")));
  if (!diffChecksPass) alerts.push(alert("DIFF_CHECK_FAILED", cleanDetail(diffCheck.stderr || stagedDiffCheck.stderr), "Stop promotion work and fix whitespace/error markers in a candidate."));

  let roomReport;
  try {
    roomReport = await roomIntegrity(options.dataDirectory, options.room);
  } catch (error) {
    roomReport = { found: false, recording: undefined, messages: 0, chainValid: false, error: cleanDetail(error?.message) };
  }
  const roomValid = roomReport.found && roomReport.chainValid;
  checks.push(check("room-integrity", roomValid, roomValid ? "Room exists and its hash chain is valid" : roomReport.error ?? "Room is missing or its hash chain is invalid", roomReport));
  if (!roomValid) alerts.push(alert("ROOM_INTEGRITY_FAILED", "The configured Room could not be verified as valid.", "Stop collaboration-dependent work and inspect the Room ledger; do not repair or rewrite it automatically."));

  let databaseReport = [];
  let databaseError;
  try {
    databaseReport = await databaseIntegrity(options.dataDirectory);
  } catch (error) {
    databaseError = cleanDetail(error?.message);
  }
  const invalidDatabases = databaseReport.filter((item) => item.quickCheck !== "ok" || item.foreignKeyViolations > 0);
  const integrityValid = !databaseError && databaseReport.length > 0 && invalidDatabases.length === 0;
  checks.push(check("data-integrity", integrityValid, integrityValid ? `${databaseReport.length} SQLite stores passed read-only quick and foreign-key checks` : databaseError ?? `${invalidDatabases.length} SQLite store(s) invalid`, { databases: databaseReport, error: databaseError }));
  if (!integrityValid) alerts.push(alert("DATA_INTEGRITY_FAILED", "The local control-plane storage integrity report is invalid or unreadable.", "Stop modifying work and preserve the data directory for recovery and forensic review."));

  const mirrors = await validateMirrors(options);
  checks.push(check(
    "obsidian-mirror-freshness",
    mirrors.valid,
    mirrors.valid ? "owner-local Obsidian mirrors match their manifest and are fresh" : mirrors.detail,
    mirrors.metadata,
  ));
  if (!mirrors.valid) {
    alerts.push(alert(
      mirrors.code,
      mirrors.detail,
      "Refresh the mirrors from an interactive owner session; never let launchd block on iCloud or accept stale content.",
    ));
  }

  const statusText = mirrors.statusText;
  const statusMarker = statusText ? /^##\s+20\d{2}-\d{2}-\d{2}/mu.test(statusText) : false;
  checks.push(check("obsidian-status-marker", statusMarker, statusMarker ? "status.md has a dated handoff section" : "status.md is missing or has no dated handoff section", options.statusFile));
  if (!statusMarker) alerts.push(alert("OBSIDIAN_STATUS_MARKER_MISSING", "The Obsidian status handoff marker is missing.", "Update the handoff record before declaring a major item complete."));

  const pendingText = mirrors.pendingText;
  const pendingMarker = pendingText ? /D-\d{3}/u.test(pendingText) : false;
  checks.push(check("obsidian-pending-marker", pendingMarker, pendingMarker ? "pending-decisions file has decision markers" : "PENDING_DECISIONS.md is missing or has no decision markers", options.pendingFile));
  if (!pendingMarker) alerts.push(alert("OBSIDIAN_PENDING_MARKER_MISSING", "The pending-decision handoff marker is missing.", "Record undecidable work in PENDING_DECISIONS.md and continue independent work."));

  const report = {
    schemaVersion: 2,
    supervisor: "orchestratory-read-only-supervisor",
    startedAt,
    finishedAt: new Date().toISOString(),
    workspace: options.workspace,
    branch: options.branch,
    room: options.room,
    ok: alerts.length === 0,
    checks,
    alerts,
    policy: {
      mutatingCommands: false,
      providerDispatch: false,
      mergePushPublishDeployDelete: false,
      filesystemReadDeadlineMs: options.readDeadlineMs,
      iCloudReadByLaunchd: false,
      nextStepOnDrift: "alert-and-stop; require an explicit, bounded correction workflow",
    },
  };
  return report;
}

function encodePayload(value, maximum = 128 * 1024) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (encoded.length > maximum) throw new Error("SUPERVISOR_INTERNAL_PAYLOAD_TOO_LARGE");
  return encoded;
}

function decodePayload(encoded, maximum = 128 * 1024) {
  if (!encoded || encoded.length > maximum) throw new Error("SUPERVISOR_INTERNAL_PAYLOAD_INVALID");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function failureReport(options, code, detail, startedAt = new Date().toISOString()) {
  return {
    schemaVersion: 2,
    supervisor: "orchestratory-read-only-supervisor",
    startedAt,
    finishedAt: new Date().toISOString(),
    workspace: options.workspace,
    branch: options.branch,
    room: options.room,
    ok: false,
    checks: [check("filesystem-read-boundary", false, detail, { deadlineMs: options.readDeadlineMs })],
    alerts: [alert(code, detail, "Preserve the current state and inspect the named unreadable source; never retry forever or auto-repair it.")],
    policy: {
      mutatingCommands: false,
      providerDispatch: false,
      mergePushPublishDeployDelete: false,
      filesystemReadDeadlineMs: options.readDeadlineMs,
      iCloudReadByLaunchd: false,
      nextStepOnDrift: "alert-and-stop; require an explicit, bounded correction workflow",
    },
  };
}

async function persistReport(report, options) {
  const result = await runBoundedProcessGroup(process.execPath, [
    fileURLToPath(import.meta.url),
    INTERNAL_REPORT_WRITER,
    encodePayload(options, 32 * 1024),
    encodePayload(report),
  ], {
    timeoutMs: REPORT_WRITE_DEADLINE_MS,
    maxOutputBytes: 16 * 1024,
    env: { ...process.env, ORCHESTRATORY_SUPERVISOR_INTERNAL: "1" },
  });
  if (result.timedOut) return "SUPERVISOR_REPORT_WRITE_DEADLINE_EXCEEDED";
  if (result.outputExceeded) return "SUPERVISOR_REPORT_WRITER_OUTPUT_TOO_LARGE";
  if (!result.ok) return result.stderr.trim().split("\n")[0] || "SUPERVISOR_REPORT_WRITE_FAILED";
  return undefined;
}

async function audit(options) {
  const startedAt = new Date().toISOString();
  const result = await runBoundedProcessGroup(process.execPath, [
    fileURLToPath(import.meta.url),
    INTERNAL_AUDIT_WORKER,
    encodePayload(options, 32 * 1024),
  ], {
    timeoutMs: options.readDeadlineMs,
    maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
    env: { ...process.env, ORCHESTRATORY_SUPERVISOR_INTERNAL: "1" },
  });
  let report;
  if (result.timedOut) {
    report = failureReport(
      options,
      "FILESYSTEM_READ_DEADLINE_EXCEEDED",
      `Configured audit reads did not finish within ${options.readDeadlineMs}ms; the isolated process group was terminated.`,
      startedAt,
    );
  } else if (result.outputExceeded) {
    report = failureReport(options, "SUPERVISOR_AUDIT_WORKER_OUTPUT_TOO_LARGE", "The isolated audit worker exceeded its output bound.", startedAt);
  } else if (!result.ok) {
    report = failureReport(
      options,
      "SUPERVISOR_AUDIT_WORKER_FAILED",
      `The isolated audit worker failed before a complete report was available: ${cleanDetail(result.stderr, "no diagnostic")}`,
      startedAt,
    );
  } else {
    try {
      report = JSON.parse(result.stdout);
      if (report?.schemaVersion !== 2 || !Array.isArray(report?.alerts) || !Array.isArray(report?.checks)) {
        throw new Error("SUPERVISOR_AUDIT_WORKER_RESULT_INVALID");
      }
    } catch {
      report = failureReport(options, "SUPERVISOR_AUDIT_WORKER_RESULT_INVALID", "The isolated audit worker returned malformed output.", startedAt);
    }
  }

  const writeError = await persistReport(report, options);
  if (writeError) {
    report.ok = false;
    report.checks.push(check("bounded-report-write", false, writeError));
    report.alerts.push(alert(writeError, "The bounded owner-only report could not be persisted.", "Inspect the owner-local report directory; do not write inside the workspace."));
  }
  return report;
}

export { audit, parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === INTERNAL_AUDIT_WORKER) {
      if (process.env.ORCHESTRATORY_SUPERVISOR_INTERNAL !== "1") throw new Error("SUPERVISOR_AUDIT_WORKER_FORBIDDEN");
      process.stdout.write(JSON.stringify(await auditInProcess(decodePayload(process.argv[3], 32 * 1024))));
    } else if (process.argv[2] === INTERNAL_REPORT_WRITER) {
      if (process.env.ORCHESTRATORY_SUPERVISOR_INTERNAL !== "1") throw new Error("SUPERVISOR_REPORT_WRITER_FORBIDDEN");
      await writeBoundedReport(decodePayload(process.argv[4]), decodePayload(process.argv[3], 32 * 1024));
      process.stdout.write("ok");
    } else {
      const options = parseArgs(process.argv.slice(2));
      if (options.help) {
        process.stdout.write(`${usage()}\n`);
      } else {
        const report = await audit(options);
        if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else process.stdout.write(report.ok ? "SUPERVISOR PASS\n" : `SUPERVISOR ALERT ${report.alerts.map((item) => item.code).join(",")}\n`);
        if (!report.ok) process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(`${cleanDetail(error?.message, "supervisor failed")}\n`);
    process.exitCode = 2;
  }
}
