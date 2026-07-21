import { opendir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRules } from "./scan-rules.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist", "build"]);
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

async function* files(directory) {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) yield path;
  }
}

export async function runSecurityScan() {
  const findings = [];
  for await (const path of files(root)) {
    const content = await readFile(path, "utf8");
    for (const [name, pattern] of scanRules) {
      if (pattern.test(content)) findings.push(`${name}: ${relative(root, path)}`);
    }
  }

  if (findings.length > 0) {
    process.stderr.write(`${findings.join("\n")}\n`);
    return false;
  }
  process.stdout.write("Local security scan passed.\n");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!(await runSecurityScan())) process.exitCode = 1;
}
