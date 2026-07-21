import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOwnerOnlyDirectory, writeIdempotentArtifact } from "./release-artifact.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputArguments = process.argv.slice(2);
const retainArtifact = outputArguments.length === 2 && outputArguments[0] === "--output";
if (outputArguments.length !== 0 && !retainArtifact) throw new Error("INVALID_REPRO_ARGUMENTS");
const releaseDirectory = resolve(root, "dist", "release");
if (retainArtifact && resolve(root, outputArguments[1]) !== releaseDirectory) {
  throw new Error("RELEASE_OUTPUT_MUST_BE_DIST_RELEASE");
}
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

async function runExpectedFailure(executable, args, cwd, timeout = 30_000) {
  try {
    await execFileAsync(executable, args, {
      cwd,
      env: environment,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error &&
        typeof error.code === "number" && error.code !== 0) return error;
    throw error;
  }
  throw new Error("EXPECTED_COMMAND_FAILURE");
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
  if (retainArtifact) {
    const sourceStatus = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
    if (sourceStatus.stdout.trim()) throw new Error("RELEASE_SOURCE_NOT_CLEAN");
  }
  await run("npm", ["ci", "--offline", "--ignore-scripts"], clone, 180_000);
  await run("npm", ["run", "check"], clone, 240_000);

  const sourcePublish = await run("npm", ["publish", "--dry-run"], clone);
  const sourcePublishOutput = `${sourcePublish.stdout}\n${sourcePublish.stderr}`;
  if (!sourcePublishOutput.includes("http://127.0.0.1:9")) {
    throw new Error("SOURCE_PACKAGE_PUBLISH_SINK_MISSING");
  }

  const packed = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], clone);
  const inventory = JSON.parse(packed.stdout);
  const files = inventory[0]?.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 1_000) {
    throw new Error("INVALID_PACKAGE_INVENTORY");
  }
  for (const entry of files) {
    const path = entry.path;
    if (typeof path !== "string") throw new Error("INVALID_PACKAGE_PATH");
    const source = resolve(clone, path);
    const local = relative(clone, source);
    if (local.startsWith(`..${sep}`) || local === "..") throw new Error("PACKAGE_PATH_ESCAPE");
    const destination = resolve(staging, "package-source", path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: false, dereference: false });
  }
  const publishedPaths = files.map((entry) => entry.path);
  const trackedPaths = new Set(
    (await run("git", ["ls-files", "-z"], clone)).stdout.split("\0").filter(Boolean),
  );
  for (const path of publishedPaths) {
    if (!trackedPaths.has(path)) throw new Error(`UNTRACKED_PACKAGE_ENTRY:${path}`);
  }
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
    "docs/orchestrator-interactive-guide.html",
    "scripts/history-scan.d.mts", "scripts/history-scan.mjs", "scripts/scan-rules.mjs",
    "scripts/security-scan.d.mts", "scripts/security-scan.mjs",
  ]) {
    if (!publishedPaths.includes(required)) throw new Error(`MISSING_PACKAGE_ENTRY:${required}`);
  }
  const packageSource = resolve(staging, "package-source");
  const manifest = JSON.parse(await readFile(resolve(packageSource, "package.json"), "utf8"));
  if (manifest.private !== true) throw new Error("PACKAGE_MUST_REMAIN_PRIVATE_BEFORE_OWNER_RELEASE_APPROVAL");
  if (manifest.publishConfig?.registry !== "http://127.0.0.1:9") {
    throw new Error("SOURCE_PACKAGE_PUBLISH_SINK_REQUIRED");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1) throw new Error("PACKAGE_FILES_ALLOWLIST_REQUIRED");
  if (manifest.scripts?.preinstall || manifest.scripts?.install || manifest.scripts?.postinstall) {
    throw new Error("INSTALL_LIFECYCLE_SCRIPT_DENIED");
  }

  const runtimeManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    type: manifest.type,
    engines: manifest.engines,
    bin: manifest.bin,
    files: manifest.files.filter((path) => !path.endsWith(".d.mts")),
    scripts: {
      start: manifest.scripts?.start,
      doctor: manifest.scripts?.doctor,
      web: manifest.scripts?.web,
    },
    license: manifest.license,
  };
  if (Object.values(runtimeManifest.scripts).some((value) => typeof value !== "string" || !value)) {
    throw new Error("RUNTIME_PACKAGE_SCRIPT_MISSING");
  }
  await writeFile(
    resolve(packageSource, "package.json"),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const typeScriptSources = publishedPaths
    .filter((path) => path.startsWith("src/") && path.endsWith(".ts"))
    .map((path) => resolve(clone, path));
  if (typeScriptSources.length < 1) throw new Error("RUNTIME_TYPESCRIPT_SOURCES_MISSING");
  await rm(resolve(packageSource, "src"), { recursive: true, force: true });
  await Promise.all([
    rm(resolve(packageSource, "scripts", "history-scan.d.mts"), { force: true }),
    rm(resolve(packageSource, "scripts", "security-scan.d.mts"), { force: true }),
  ]);
  await run(resolve(clone, "node_modules", ".bin", "tsc"), [
    "--target", "ES2023",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--strict",
    "--noUncheckedIndexedAccess",
    "--exactOptionalPropertyTypes",
    "--noImplicitOverride",
    "--useUnknownInCatchVariables",
    "--verbatimModuleSyntax",
    "--allowImportingTsExtensions",
    "--rewriteRelativeImportExtensions",
    "--types", "node",
    "--typeRoots", resolve(clone, "node_modules", "@types"),
    "--rootDir", clone,
    "--outDir", packageSource,
    "--declaration", "false",
    "--sourceMap", "false",
    ...typeScriptSources,
  ], staging, 120_000);
  for (const path of ["bin/orchestrator.mjs", "bin/workspace-mcp.mjs"]) {
    const binPath = resolve(packageSource, path);
    const source = await readFile(binPath, "utf8");
    const rewritten = source.replace(/\.ts(?=["'])/gu, ".js");
    if (rewritten === source || rewritten.includes(".ts\"")) {
      throw new Error(`RUNTIME_BIN_REWRITE_FAILED:${path}`);
    }
    await writeFile(binPath, rewritten, "utf8");
  }

  const artifactDirectory = resolve(staging, "artifact");
  await mkdir(artifactDirectory, { recursive: true });
  const artifactResult = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactDirectory],
    packageSource,
  );
  const artifactInventory = JSON.parse(artifactResult.stdout);
  const artifactFiles = artifactInventory[0]?.files;
  const artifactFilename = artifactInventory[0]?.filename;
  if (!Array.isArray(artifactFiles) || typeof artifactFilename !== "string") {
    throw new Error("INVALID_PACKAGE_ARTIFACT");
  }
  const artifactPaths = artifactFiles.map((entry) => entry.path).sort();
  const expectedArtifactPaths = publishedPaths.flatMap((path) => {
    if (path.endsWith(".d.mts")) return [];
    if (path.startsWith("src/") && path.endsWith(".ts")) return [path.replace(/\.ts$/u, ".js")];
    return [path];
  }).sort();
  if (JSON.stringify(artifactPaths) !== JSON.stringify(expectedArtifactPaths)) {
    throw new Error("PACKAGE_ARTIFACT_INVENTORY_MISMATCH");
  }
  const artifactPath = resolve(artifactDirectory, artifactFilename);
  if (relative(artifactDirectory, artifactPath).startsWith(`..${sep}`)) {
    throw new Error("PACKAGE_ARTIFACT_PATH_ESCAPE");
  }

  const installation = resolve(staging, "installation");
  await mkdir(installation, { recursive: true });
  await writeFile(resolve(installation, "package.json"), "{\"private\":true}\n", { mode: 0o600 });
  await run(
    "npm",
    ["install", "--offline", "--ignore-scripts", "--no-package-lock", artifactPath],
    installation,
    180_000,
  );
  const installedPackage = resolve(installation, "node_modules", manifest.name);
  const installedManifest = JSON.parse(await readFile(resolve(installedPackage, "package.json"), "utf8"));
  if ("private" in installedManifest || "publishConfig" in installedManifest ||
      JSON.stringify(Object.keys(installedManifest.scripts ?? {}).sort()) !==
        JSON.stringify(["doctor", "start", "web"])) {
    throw new Error("RUNTIME_PACKAGE_MANIFEST_INVALID");
  }
  for (const path of artifactPaths.filter((path) => /\.(?:js|mjs)$/u.test(path))) {
    await run("node", ["--check", resolve(installedPackage, path)], installation, 30_000);
  }

  const installedBin = resolve(installation, "node_modules", ".bin", "orchestrator");
  const [binLink, binTarget] = await Promise.all([lstat(installedBin), stat(installedBin)]);
  if (!binLink.isSymbolicLink() || !binTarget.isFile() || (binTarget.mode & 0o111) === 0) {
    throw new Error("INSTALLED_BIN_LINK_INVALID");
  }
  const help = await run(installedBin, ["--help"], installation, 30_000);
  if (!help.stdout.includes("Orchestratory 0.0.1")) throw new Error("PACKAGED_CLI_SMOKE_FAILED");
  const audit = await run(installedBin, ["audit"], installation, 30_000);
  if (!audit.stdout.includes("Local security scan passed.") ||
      !audit.stdout.includes("Git history security scan not applicable")) {
    throw new Error("PACKAGED_AUDIT_SMOKE_FAILED");
  }

  const canaryValue = `${["api", "key"].join("_")}="${["synthetic", "secret", "value"].join("-")}"\n`;
  const canaryPath = resolve(installedPackage, "synthetic-audit-canary.txt");
  await writeFile(canaryPath, canaryValue, { mode: 0o600 });
  const rejectedAudit = await runExpectedFailure(installedBin, ["audit"], installation);
  const rejectedOutput = `${"stdout" in rejectedAudit ? rejectedAudit.stdout : ""}\n` +
    `${"stderr" in rejectedAudit ? rejectedAudit.stderr : ""}`;
  if (!rejectedOutput.includes("secret-assignment: synthetic-audit-canary.txt") ||
      !rejectedOutput.includes("SECURITY_AUDIT_FAILED") || rejectedOutput.includes(canaryValue.trim())) {
    throw new Error("PACKAGED_AUDIT_NEGATIVE_SMOKE_FAILED");
  }
  await rm(canaryPath, { force: true });
  let retainedMessage = "";
  if (retainArtifact) {
    await ensureOwnerOnlyDirectory(resolve(root, "dist"));
    await ensureOwnerOnlyDirectory(releaseDirectory);
    const artifactBytes = await readFile(artifactPath);
    const digest = createHash("sha256").update(artifactBytes).digest("hex");
    const commit = cloneHead.stdout.trim().slice(0, 12);
    if (!/^[A-Za-z0-9._-]+\.tgz$/u.test(artifactFilename)) {
      throw new Error("INVALID_RELEASE_ARTIFACT_FILENAME");
    }
    const retainedFilename = artifactFilename.replace(/\.tgz$/u, `-${commit}.tgz`);
    const retainedPath = resolve(releaseDirectory, retainedFilename);
    if (relative(releaseDirectory, retainedPath).startsWith(`..${sep}`)) {
      throw new Error("RELEASE_ARTIFACT_PATH_ESCAPE");
    }
    const checksumPath = `${retainedPath}.sha256`;
    await writeIdempotentArtifact(artifactPath, retainedPath);
    const retainedDigest = createHash("sha256").update(await readFile(retainedPath)).digest("hex");
    if (retainedDigest !== digest) throw new Error("RETAINED_RELEASE_ARTIFACT_HASH_MISMATCH");
    await writeIdempotentArtifact("", checksumPath, `${digest}  ${retainedFilename}\n`);
    retainedMessage = ` Retained ${relative(root, retainedPath)} with SHA-256 ${digest}.`;
  }
  process.stdout.write(
    `Clean clone verified at ${cloneHead.stdout.trim().slice(0, 12)}; package snapshot reproduced ` +
    `(${artifactFiles.length} tracked allowlisted files, pinned TS-to-JS build, tgz install, bin link, JS syntax, ` +
    `CLI and positive/negative audit smoke).${retainedMessage}\n`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
