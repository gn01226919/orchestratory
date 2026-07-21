import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const staging = await mkdtemp(join(dirname(root), ".orchestratory-repro-"));
const cacheResult = await execFileAsync("npm", ["config", "get", "cache"], {
  cwd: root,
  timeout: 30_000,
  maxBuffer: 16_384,
});
const npmCache = cacheResult.stdout.trim();
if (!isAbsolute(npmCache) || npmCache.includes("\0")) throw new Error("INVALID_NPM_CACHE_PATH");
const environment = {
  PATH: process.env.PATH,
  HOME: staging,
  npm_config_ignore_scripts: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_cache: npmCache,
  npm_config_logs_dir: join(staging, "npm-logs"),
};

async function run(executable, args, cwd, timeout = 120_000) {
  try {
    return await execFileAsync(executable, args, {
      cwd,
      env: environment,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = error && typeof error === "object" && "stdout" in error &&
      typeof error.stdout === "string" ? error.stdout : "";
    if (output) {
      const lines = output.split("\n");
      const failures = lines.flatMap((line, index) =>
        line.startsWith("not ok ") ? lines.slice(Math.max(0, index - 2), index + 24) : []
      );
      const diagnostic = failures.length ? failures.join("\n") : output.slice(-12_000);
      process.stderr.write(`${diagnostic}\n`);
    }
    throw error;
  }
}

try {
  const clone = resolve(staging, "clean-clone");
  await run("git", ["clone", "--local", "--no-hardlinks", "--quiet", root, clone], staging, 120_000);
  const [sourceHead, cloneHead, cloneStatus] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], root),
    run("git", ["rev-parse", "HEAD"], clone),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], clone),
  ]);
  if (sourceHead.stdout.trim() !== cloneHead.stdout.trim()) throw new Error("CLEAN_CLONE_HEAD_MISMATCH");
  if (cloneStatus.stdout.trim()) throw new Error("CLEAN_CLONE_NOT_CLEAN");
  await run("npm", ["ci", "--offline", "--ignore-scripts"], clone, 180_000);
  await run("npm", ["run", "check"], clone, 240_000);

  const packed = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], root);
  const inventory = JSON.parse(packed.stdout);
  const files = inventory[0]?.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 1_000) {
    throw new Error("INVALID_PACKAGE_INVENTORY");
  }
  for (const entry of files) {
    const path = entry.path;
    if (typeof path !== "string") throw new Error("INVALID_PACKAGE_PATH");
    const source = resolve(root, path);
    const local = relative(root, source);
    if (local.startsWith(`..${sep}`) || local === "..") throw new Error("PACKAGE_PATH_ESCAPE");
    const destination = resolve(staging, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: false, dereference: false });
  }
  const publishedPaths = files.map((entry) => entry.path);
  const deniedPublishedPrefixes = [
    ".github/", "test/", "scripts/", ".claude/", ".codex/", "coverage/", "node_modules/",
  ];
  const deniedPublishedFiles = new Set([
    "AGENTS.md", "CLAUDE.md", "tsconfig.json", "package-lock.json", ".node-version", ".npmrc",
  ]);
  const allowedRuntimeScripts = new Set([
    "scripts/history-scan.d.mts", "scripts/history-scan.mjs", "scripts/scan-rules.mjs",
    "scripts/security-scan.d.mts", "scripts/security-scan.mjs",
  ]);
  for (const path of publishedPaths) {
    const deniedPrefix = deniedPublishedPrefixes.some((prefix) => path.startsWith(prefix));
    if (deniedPublishedFiles.has(path) || (deniedPrefix && !allowedRuntimeScripts.has(path))) {
      throw new Error(`DENIED_PACKAGE_ENTRY:${path}`);
    }
  }
  for (const required of [
    "package.json", "README.md", "LICENSE", "NOTICE", "SECURITY.md", "sbom.cdx.json",
    "bin/orchestrator.mjs", "src/main.ts", "public/index.html",
    "scripts/history-scan.d.mts", "scripts/history-scan.mjs", "scripts/scan-rules.mjs",
    "scripts/security-scan.d.mts", "scripts/security-scan.mjs",
  ]) {
    if (!publishedPaths.includes(required)) throw new Error(`MISSING_PACKAGE_ENTRY:${required}`);
  }
  await cp(resolve(root, "package-lock.json"), resolve(staging, "package-lock.json"));
  await cp(resolve(root, "tsconfig.json"), resolve(staging, "tsconfig.json"));
  const manifest = JSON.parse(await readFile(resolve(staging, "package.json"), "utf8"));
  if (manifest.private !== true) throw new Error("PACKAGE_MUST_REMAIN_PRIVATE_BEFORE_OWNER_RELEASE_APPROVAL");
  if (!Array.isArray(manifest.files) || manifest.files.length < 1) throw new Error("PACKAGE_FILES_ALLOWLIST_REQUIRED");
  if (manifest.scripts?.preinstall || manifest.scripts?.install || manifest.scripts?.postinstall) {
    throw new Error("INSTALL_LIFECYCLE_SCRIPT_DENIED");
  }
  await run("npm", ["ci", "--offline", "--ignore-scripts"], staging, 180_000);
  for (const path of publishedPaths.filter((path) => /\.(?:js|mjs)$/u.test(path))) {
    await run("node", ["--check", path], staging, 30_000);
  }
  await run("npm", ["run", "typecheck"], staging, 120_000);
  const help = await run("node", ["bin/orchestrator.mjs", "--help"], staging, 30_000);
  if (!help.stdout.includes("Orchestratory 0.0.1")) throw new Error("PACKAGED_CLI_SMOKE_FAILED");
  const audit = await run("node", ["bin/orchestrator.mjs", "audit"], staging, 30_000);
  if (!audit.stdout.includes("Local security scan passed.") ||
      !audit.stdout.includes("Git history security scan not applicable")) {
    throw new Error("PACKAGED_AUDIT_SMOKE_FAILED");
  }
  process.stdout.write(
    `Clean clone verified at ${cloneHead.stdout.trim().slice(0, 12)}; package snapshot reproduced ` +
    `(${files.length} allowlisted files, offline installs, JS syntax, TS typecheck, CLI and audit smoke).\n`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
