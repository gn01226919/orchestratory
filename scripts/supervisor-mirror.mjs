#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBoundedProcessGroup } from "./bounded-process-group.mjs";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_READ_DEADLINE_MS = 10_000;
const DEFAULT_STALE_AFTER_SECONDS = 7200;
const INTERNAL_WORKER = "--internal-mirror-worker";

function usage() {
  return [
    "Usage: node scripts/supervisor-mirror.mjs [options]",
    "",
    "Foreground-only bounded refresh of owner-local supervisor mirrors.",
    "",
    "Options:",
    "  --status-source <path>       Source Obsidian status.md",
    "  --pending-source <path>      Source Obsidian PENDING_DECISIONS.md",
    "  --status-mirror <path>       Owner-local status mirror",
    "  --pending-mirror <path>      Owner-local pending mirror",
    "  --manifest <path>            Owner-local mirror manifest",
    `  --read-deadline-ms <ms>      Process-group deadline (default: ${DEFAULT_READ_DEADLINE_MS})`,
    `  --stale-after-seconds <sec>  Freshness bound (default: ${DEFAULT_STALE_AFTER_SECONDS})`,
    "  --json                       Print the manifest",
  ].join("\n");
}

function parseInteger(value, code, minimum, maximum) {
  if (!/^[0-9]+$/u.test(value ?? "")) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    readDeadlineMs: DEFAULT_READ_DEADLINE_MS,
    staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
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
      "--status-source": "statusSource",
      "--pending-source": "pendingSource",
      "--status-mirror": "statusMirror",
      "--pending-mirror": "pendingMirror",
      "--manifest": "manifest",
      "--read-deadline-ms": "readDeadlineMs",
      "--stale-after-seconds": "staleAfterSeconds",
    }[arg];
    if (!key) throw new Error(`SUPERVISOR_MIRROR_UNKNOWN_ARGUMENT:${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`SUPERVISOR_MIRROR_VALUE_REQUIRED:${arg}`);
    options[key] = value;
    index += 1;
  }
  for (const key of ["statusSource", "pendingSource", "statusMirror", "pendingMirror", "manifest"]) {
    if (!options[key]) throw new Error(`SUPERVISOR_MIRROR_OPTION_REQUIRED:${key}`);
    if (!isAbsolute(options[key])) options[key] = resolve(options[key]);
  }
  options.readDeadlineMs = parseInteger(String(options.readDeadlineMs), "SUPERVISOR_MIRROR_DEADLINE_INVALID", 100, 120_000);
  options.staleAfterSeconds = parseInteger(String(options.staleAfterSeconds), "SUPERVISOR_MIRROR_STALENESS_INVALID", 60, 31_536_000);
  return options;
}

function ownerUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function assertOwnerDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
    (ownerUid() !== undefined && info.uid !== ownerUid())
  ) throw new Error("SUPERVISOR_MIRROR_DIRECTORY_UNSAFE");
}

async function readSource(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_BYTES) {
    throw new Error("SUPERVISOR_MIRROR_SOURCE_UNSAFE");
  }
  const content = await readFile(path);
  if (content.length !== info.size || content.length > MAX_SOURCE_BYTES) {
    throw new Error("SUPERVISOR_MIRROR_SOURCE_CHANGED_DURING_READ");
  }
  return content;
}

async function atomicOwnerWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function refreshInProcess(options) {
  const targetDirectory = dirname(options.manifest);
  if (dirname(options.statusMirror) !== targetDirectory || dirname(options.pendingMirror) !== targetDirectory) {
    throw new Error("SUPERVISOR_MIRROR_TARGETS_MUST_SHARE_DIRECTORY");
  }
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await assertOwnerDirectory(targetDirectory);
  const [statusSource, pendingSource] = await Promise.all([
    realpath(options.statusSource),
    realpath(options.pendingSource),
  ]);
  const [status, pending] = await Promise.all([readSource(statusSource), readSource(pendingSource)]);
  const mirroredAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(mirroredAt) + options.staleAfterSeconds * 1000).toISOString();
  const manifest = {
    schemaVersion: 1,
    mirroredAt,
    staleness: { staleAfterSeconds: options.staleAfterSeconds, expiresAt },
    files: {
      status: {
        source: statusSource,
        mirror: options.statusMirror,
        digest: createHash("sha256").update(status).digest("hex"),
        bytes: status.length,
      },
      pending: {
        source: pendingSource,
        mirror: options.pendingMirror,
        digest: createHash("sha256").update(pending).digest("hex"),
        bytes: pending.length,
      },
    },
  };
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (encoded.length > MAX_MANIFEST_BYTES) throw new Error("SUPERVISOR_MIRROR_MANIFEST_TOO_LARGE");

  // Manifest is committed last. A crash between mirror renames leaves the previous manifest/digest
  // disagreeing with the files, so the audit fails closed instead of accepting a mixed snapshot.
  await atomicOwnerWrite(options.statusMirror, status);
  await atomicOwnerWrite(options.pendingMirror, pending);
  await atomicOwnerWrite(options.manifest, encoded);
  return manifest;
}

function encodeOptions(options) {
  const encoded = Buffer.from(JSON.stringify(options), "utf8").toString("base64url");
  if (encoded.length > 32 * 1024) throw new Error("SUPERVISOR_MIRROR_OPTIONS_TOO_LARGE");
  return encoded;
}

function decodeOptions(encoded) {
  if (!encoded || encoded.length > 32 * 1024) throw new Error("SUPERVISOR_MIRROR_OPTIONS_INVALID");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function namedMirrorError(value, fallback = "SUPERVISOR_MIRROR_REFRESH_FAILED") {
  const line = String(value ?? "").split("\n").find((item) => item.trim())?.trim() ?? fallback;
  const match = /^(?:SUPERVISOR ALERT )?(SUPERVISOR_MIRROR_[A-Z0-9_]+)$/u.exec(line);
  return match?.[1] ?? fallback;
}

async function refreshMirrors(options) {
  const result = await runBoundedProcessGroup(process.execPath, [
    fileURLToPath(import.meta.url), INTERNAL_WORKER, encodeOptions(options),
  ], {
    timeoutMs: options.readDeadlineMs,
    maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
    env: { ...process.env, ORCHESTRATORY_SUPERVISOR_INTERNAL: "1" },
  });
  if (result.timedOut) throw new Error("SUPERVISOR_MIRROR_SOURCE_READ_DEADLINE_EXCEEDED");
  if (result.outputExceeded) throw new Error("SUPERVISOR_MIRROR_WORKER_OUTPUT_TOO_LARGE");
  if (!result.ok) throw new Error(namedMirrorError(result.stderr, "SUPERVISOR_MIRROR_SOURCE_READ_FAILED"));
  return JSON.parse(result.stdout);
}

export { parseArgs, refreshMirrors };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === INTERNAL_WORKER) {
      if (process.env.ORCHESTRATORY_SUPERVISOR_INTERNAL !== "1") throw new Error("SUPERVISOR_MIRROR_WORKER_FORBIDDEN");
      const manifest = await refreshInProcess(decodeOptions(process.argv[3]));
      process.stdout.write(JSON.stringify(manifest));
    } else {
      const options = parseArgs(process.argv.slice(2));
      if (options.help) process.stdout.write(`${usage()}\n`);
      else {
        const manifest = await refreshMirrors(options);
        process.stdout.write(options.json ? `${JSON.stringify(manifest, null, 2)}\n` : "SUPERVISOR MIRROR REFRESHED\n");
      }
    }
  } catch (error) {
    const fallback = process.argv[2] === INTERNAL_WORKER
      ? "SUPERVISOR_MIRROR_SOURCE_READ_FAILED"
      : "SUPERVISOR_MIRROR_FAILED";
    process.stderr.write(`SUPERVISOR ALERT ${namedMirrorError(error?.message, fallback)}\n`);
    process.exitCode = 2;
  }
}
