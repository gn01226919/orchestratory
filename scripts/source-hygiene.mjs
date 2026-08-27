import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { unexplainedTestUnrefLines } from "./hygiene-rules.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const gitEnvironment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".mts", ".ts", ".txt", ".yaml", ".yml",
]);
const textNames = new Set([
  ".gitignore", ".node-version", ".npmignore", ".npmrc", "AGENTS.md", "CLAUDE.md", "LICENSE", "NOTICE",
]);
const semanticCodePrefixes = ["bin/", "public/", "scripts/", "src/"];
const forbiddenCode = [
  ["debugger", /\bdebugger\s*;/u],
  ["dynamic-eval", /\beval\s*\(/u],
  ["dynamic-function", /\bnew\s+Function\s*\(/u],
  ["shell-true", /\bshell\s*:\s*true\b/u],
];

const result = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  env: gitEnvironment,
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
});
const paths = result.stdout.split("\0").filter(Boolean);
if (paths.length < 1 || paths.length > 1_000) throw new Error("TRACKED_FILE_COUNT_INVALID");

const findings = [];
let totalBytes = 0;
for (const path of paths) {
  if (path.startsWith(`..${sep}`) || path.includes("\0") || /[\r\n]/u.test(path)) {
    findings.push(`unsafe-path:${path}`);
    continue;
  }
  const absolute = resolve(root, path);
  const info = await lstat(absolute);
  if (!info.isFile()) findings.push(`non-regular-file:${path}`);
  const executable = (info.mode & 0o111) !== 0;
  if (path === "bin/orchestrator.mjs" ? !executable : executable) {
    findings.push(`unexpected-executable-mode:${path}`);
  }
  if (info.size > 5 * 1024 * 1024) findings.push(`oversized-tracked-file:${path}`);
  totalBytes += info.size;
  if (totalBytes > 32 * 1024 * 1024) throw new Error("TRACKED_TEXT_TOTAL_LIMIT_REACHED");

  if (!textExtensions.has(extname(path)) && !textNames.has(path)) continue;
  const buffer = await readFile(absolute);
  const content = buffer.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(buffer)) findings.push(`invalid-utf8:${path}`);
  if (content.includes("\0")) findings.push(`nul-byte:${path}`);
  if (content.includes("\r")) findings.push(`non-lf-newline:${path}`);
  if (content.includes("\t")) findings.push(`tab-character:${path}`);
  if (/[ ]+$/mu.test(content)) findings.push(`trailing-whitespace:${path}`);
  if (content.length > 0 && !content.endsWith("\n")) findings.push(`missing-final-newline:${path}`);

  if (path !== "scripts/source-hygiene.mjs" &&
      semanticCodePrefixes.some((prefix) => path.startsWith(prefix))) {
    for (const [name, pattern] of forbiddenCode) {
      if (pattern.test(content)) findings.push(`${name}:${path}`);
    }
  }
  // See `scripts/hygiene-rules.mjs` for why `test/` needs its own rule and what the marker means.
  if (path.startsWith("test/")) {
    for (const line of unexplainedTestUnrefLines(content)) {
      findings.push(`unexplained-test-unref:${path}:${line}`);
    }
  }
  if (extname(path) === ".json") {
    try {
      JSON.parse(content);
    } catch {
      findings.push(`invalid-json:${path}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`${findings.slice(0, 50).join("\n")}\n`);
  if (findings.length > 50) process.stderr.write(`and ${findings.length - 50} more findings\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Repository source hygiene passed (${paths.length} files, ${totalBytes} bytes).\n`);
}
