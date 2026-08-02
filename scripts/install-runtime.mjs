import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { daemonRuntimeEntry } from "../src/main.ts";
import { ensureOwnerOnlyDirectory, MAX_RELEASE_ARTIFACT_BYTES, writeIdempotentArtifact } from "./release-artifact.mjs";

const execFileAsync = promisify(execFile);

async function readOwnerArtifact(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const uid = process.getuid?.();
    if (
      !Number.isSafeInteger(uid) || !info.isFile() || info.uid !== uid || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > MAX_RELEASE_ARTIFACT_BYTES
    ) throw new Error(`UNSAFE_RUNTIME_ARTIFACT:${path}`);
    const content = await handle.readFile();
    if (content.length !== info.size) throw new Error(`RUNTIME_ARTIFACT_CHANGED:${path}`);
    return content;
  } finally {
    await handle.close();
  }
}

export async function installRuntimeArtifact(input) {
  const artifact = resolve(input.artifact);
  const checksum = resolve(input.checksum);
  const runtimeRoot = resolve(input.runtimeRoot ?? join(
    homedir(), "Library", "Application Support", "Orchestratory Runtime",
  ));
  const [artifactBytes, checksumBytes] = await Promise.all([
    readOwnerArtifact(artifact),
    readOwnerArtifact(checksum),
  ]);
  const digest = createHash("sha256").update(artifactBytes).digest("hex");
  const expectedChecksum = `${digest}  ${basename(artifact)}\n`;
  if (checksumBytes.toString("utf8") !== expectedChecksum) throw new Error("RUNTIME_ARTIFACT_CHECKSUM_MISMATCH");

  await ensureOwnerOnlyDirectory(runtimeRoot);
  if (await realpath(runtimeRoot) !== runtimeRoot) throw new Error("RUNTIME_ROOT_MUST_BE_PHYSICAL");
  const digestName = `sha256-${digest}`;
  const destination = join(runtimeRoot, digestName);
  const installedEntry = join(destination, "node_modules", "orchestratory", "src", "main.js");
  const existing = await lstat(destination).catch(() => undefined);
  if (existing) {
    const entry = await daemonRuntimeEntry(pathToFileURL(installedEntry).href, { runtimeRoot });
    return { digest, entry, reused: true };
  }

  const stagingRoot = await mkdtemp(join(runtimeRoot, ".install-"));
  const stagingDigest = join(stagingRoot, digestName);
  try {
    await mkdir(stagingDigest, { mode: 0o700 });
    await writeFile(join(stagingDigest, "package.json"), "{\"private\":true}\n", { mode: 0o600 });
    const stagedArtifact = join(stagingRoot, "runtime-package.tgz");
    await writeIdempotentArtifact("", stagedArtifact, artifactBytes);
    await execFileAsync(input.npmExecutable ?? "npm", [
      "install", "--offline", "--ignore-scripts", "--no-package-lock", "--prefix", stagingDigest, stagedArtifact,
    ], {
      env: {
        ...process.env,
        npm_config_ignore_scripts: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const packageRoot = join(stagingDigest, "node_modules", "orchestratory");
    const runtimeManifest = JSON.parse(
      await readFile(join(packageRoot, "runtime-manifest.json"), "utf8"),
    );
    if (
      runtimeManifest.formatVersion !== 1 || typeof runtimeManifest.sourceCommit !== "string" ||
      !/^[0-9a-f]{40}$/u.test(runtimeManifest.sourceCommit)
    ) throw new Error("RUNTIME_PROVENANCE_MANIFEST_INVALID");
    await writeIdempotentArtifact("", join(stagingDigest, "runtime-install.json"), `${JSON.stringify({
      formatVersion: 1,
      artifactSha256: digest,
      sourceCommit: runtimeManifest.sourceCommit,
    }, null, 2)}\n`);
    const stagingEntry = join(packageRoot, "src", "main.js");
    await daemonRuntimeEntry(pathToFileURL(stagingEntry).href, { runtimeRoot: stagingRoot });
    await rename(stagingDigest, destination);
    const entry = await daemonRuntimeEntry(pathToFileURL(installedEntry).href, { runtimeRoot });
    return { digest, entry, reused: false };
  } finally {
    const local = relative(runtimeRoot, stagingRoot);
    if (local.startsWith(".install-") && !local.includes(sep)) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

async function cli() {
  const args = process.argv.slice(2);
  const artifactIndex = args.indexOf("--artifact");
  const checksumIndex = args.indexOf("--checksum");
  if (artifactIndex < 0 || checksumIndex < 0 || !args[artifactIndex + 1] || !args[checksumIndex + 1]) {
    throw new Error("Usage: node scripts/install-runtime.mjs --artifact <tgz> --checksum <tgz.sha256>");
  }
  const result = await installRuntimeArtifact({
    artifact: args[artifactIndex + 1],
    checksum: args[checksumIndex + 1],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await cli();
}
