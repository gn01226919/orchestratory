import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const staging = await mkdtemp(join(tmpdir(), "orchestratory-repro-"));
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
  return execFileAsync(executable, args, {
    cwd,
    env: environment,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

try {
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
  await cp(resolve(root, "package-lock.json"), resolve(staging, "package-lock.json"));
  const manifest = JSON.parse(await readFile(resolve(staging, "package.json"), "utf8"));
  if (manifest.scripts?.preinstall || manifest.scripts?.install || manifest.scripts?.postinstall) {
    throw new Error("INSTALL_LIFECYCLE_SCRIPT_DENIED");
  }
  await run("npm", ["ci", "--offline", "--ignore-scripts"], staging, 180_000);
  await run("npm", ["run", "typecheck"], staging, 120_000);
  await run("npm", ["run", "test:fuzz"], staging, 120_000);
  await run("npm", ["run", "audit:local"], staging, 120_000);
  process.stdout.write(`Clean package snapshot reproduced (${files.length} published files, offline install, typecheck, fuzz, security scan).\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
