import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRules } from "./scan-rules.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(args, maxBuffer = 8 * 1024 * 1024) {
  const result = await execFileAsync("git", args, { cwd: root, env, maxBuffer });
  return result.stdout;
}

function isMissingRepository(error) {
  return error !== null && typeof error === "object" && "stderr" in error &&
    String(error.stderr).includes("not a git repository");
}

function findings(label, content) {
  return scanRules
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => `${name}: ${label}`);
}

export async function runHistoryScan() {
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"], 1024)).trim() !== "true") {
      throw new Error("GIT_WORKTREE_REQUIRED");
    }
  } catch (error) {
    if (!isMissingRepository(error)) throw error;
    process.stdout.write("Git history security scan not applicable (package has no repository metadata).\n");
    return true;
  }

  const objectLines = (await git(["rev-list", "--objects", "--all"]))
    .split("\n")
    .filter(Boolean);
  if (objectLines.length > 100_000) throw new Error("HISTORY_OBJECT_LIMIT_REACHED");

  const detected = [];
  for (const line of objectLines) {
    const separator = line.indexOf(" ");
    const objectId = separator < 0 ? line : line.slice(0, separator);
    const label = separator < 0 ? objectId : line.slice(separator + 1);
    const type = (await git(["cat-file", "-t", objectId], 1024)).trim();
    if (type !== "blob") continue;
    const size = Number((await git(["cat-file", "-s", objectId], 1024)).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("INVALID_GIT_OBJECT_SIZE");
    if (size > 5 * 1024 * 1024) {
      detected.push(`oversized-unscanned-blob: ${label}`);
      continue;
    }
    detected.push(...findings(label, await git(["cat-file", "-p", objectId], 6 * 1024 * 1024)));
  }

  const historyMetadata = await git(["log", "--all", "--format=%H%n%an%n%ae%n%B"], 8 * 1024 * 1024);
  detected.push(...findings("commit-metadata", historyMetadata));

  if (detected.length > 0) {
    process.stderr.write(`${detected.join("\n")}\n`);
    return false;
  }
  process.stdout.write(`Git history security scan passed (${objectLines.length} objects).\n`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!(await runHistoryScan())) process.exitCode = 1;
}
