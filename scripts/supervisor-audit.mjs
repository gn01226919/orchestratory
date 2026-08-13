#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const DEFAULT_BRANCH = "agent/native-full-trust-vnext";
const DEFAULT_ROOM = "orchestratory";
const DEFAULT_DATA_DIR = join(homedir(), "Library", "Application Support", "Orchestratory");
const DEFAULT_REPORT_DIR = join(DEFAULT_DATA_DIR, "supervisor");
const DEFAULT_VAULT = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "Vault",
);

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
    "  --status-file <path>     Obsidian status.md to check",
    "  --pending-file <path>    Obsidian PENDING_DECISIONS.md to check",
    `  --report-dir <path>      Report directory (default: ${DEFAULT_REPORT_DIR})`,
    "  --json                   Print the complete bounded JSON report",
    "  --help                   Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(),
    branch: DEFAULT_BRANCH,
    room: DEFAULT_ROOM,
    dataDirectory: DEFAULT_DATA_DIR,
    statusFile: join(DEFAULT_VAULT, "projects", "orchestrator", "status.md"),
    pendingFile: join(DEFAULT_VAULT, "projects", "orchestrator", "PENDING_DECISIONS.md"),
    reportDir: process.env.ORCHESTRATORY_SUPERVISOR_REPORT_DIR ?? DEFAULT_REPORT_DIR,
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
      "--report-dir": "reportDir",
    }[arg];
    if (!key) throw new Error(`SUPERVISOR_UNKNOWN_ARGUMENT:${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`SUPERVISOR_VALUE_REQUIRED:${arg}`);
    options[key] = value;
    index += 1;
  }
  options.workspace = resolve(options.workspace);
  for (const key of ["dataDirectory", "statusFile", "pendingFile", "reportDir"]) {
    if (!isAbsolute(options[key])) options[key] = resolve(options.workspace, options[key]);
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

async function fileText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function audit(options) {
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

  const statusText = await fileText(options.statusFile);
  const statusMarker = statusText ? /^##\s+20\d{2}-\d{2}-\d{2}/mu.test(statusText) : false;
  checks.push(check("obsidian-status-marker", statusMarker, statusMarker ? "status.md has a dated handoff section" : "status.md is missing or has no dated handoff section", options.statusFile));
  if (!statusMarker) alerts.push(alert("OBSIDIAN_STATUS_MARKER_MISSING", "The Obsidian status handoff marker is missing.", "Update the handoff record before declaring a major item complete."));

  const pendingText = await fileText(options.pendingFile);
  const pendingMarker = pendingText ? /D-\d{3}/u.test(pendingText) : false;
  checks.push(check("obsidian-pending-marker", pendingMarker, pendingMarker ? "pending-decisions file has decision markers" : "PENDING_DECISIONS.md is missing or has no decision markers", options.pendingFile));
  if (!pendingMarker) alerts.push(alert("OBSIDIAN_PENDING_MARKER_MISSING", "The pending-decision handoff marker is missing.", "Record undecidable work in PENDING_DECISIONS.md and continue independent work."));

  const report = {
    schemaVersion: 1,
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
      nextStepOnDrift: "alert-and-stop; require an explicit, bounded correction workflow",
    },
  };
  await writeBoundedReport(report, options);
  return report;
}

export { audit, parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const report = await audit(options);
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(report.ok ? "SUPERVISOR PASS\n" : `SUPERVISOR ALERT ${report.alerts.length}\n`);
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${cleanDetail(error?.message, "supervisor failed")}\n`);
    process.exitCode = 2;
  }
}
