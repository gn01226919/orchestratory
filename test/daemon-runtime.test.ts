import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { daemonRuntimeEntry } from "../src/main.ts";

test("daemon installation requires a physical digest-pinned compiled runtime", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-daemon-runtime-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const runtimeRoot = join(await realpath(data), "runtime");
  const digest = "a".repeat(64);
  const commit = "b".repeat(40);
  const digestDirectory = join(runtimeRoot, `sha256-${digest}`);
  const packageRoot = join(digestDirectory, "node_modules", "orchestratory");
  const entry = join(packageRoot, "src", "main.js");
  const entryContent = "export {};\n";
  const roomScriptContent = "export {};\n";
  const roomHtmlContent = "<!doctype html>\n";
  const inventoryFixtures = Array.from({ length: 48 }, (_, index) => ({
    path: `src/inventory-fixture-${String(index).padStart(2, "0")}.js`,
    content: `export const fixture${index} = ${index};\n`,
  }));
  const runtimeFiles = [
    { path: "public/room.html", content: roomHtmlContent },
    { path: "public/room.js", content: roomScriptContent },
    { path: "src/main.js", content: entryContent },
    ...inventoryFixtures,
  ].map(({ path, content }) => ({
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  }));
  await mkdir(join(packageRoot, "src"), { recursive: true, mode: 0o700 });
  await mkdir(join(packageRoot, "public"), { mode: 0o700 });
  await Promise.all([
    writeFile(entry, entryContent, { mode: 0o600 }),
    writeFile(join(packageRoot, "public", "room.js"), roomScriptContent, { mode: 0o600 }),
    writeFile(join(packageRoot, "public", "room.html"), roomHtmlContent, { mode: 0o600 }),
    writeFile(join(packageRoot, "runtime-manifest.json"), JSON.stringify({
      formatVersion: 1,
      sourceCommit: commit,
      files: runtimeFiles,
    }), { mode: 0o600 }),
    writeFile(join(digestDirectory, "runtime-install.json"), JSON.stringify({
      formatVersion: 1,
      artifactSha256: digest,
      sourceCommit: commit,
    }), { mode: 0o600 }),
    ...inventoryFixtures.map((fixture) => writeFile(
      join(packageRoot, fixture.path), fixture.content, { mode: 0o600 },
    )),
  ]);
  assert.ok((await stat(join(packageRoot, "runtime-manifest.json"))).size > 4_096);

  assert.equal(
    await daemonRuntimeEntry(pathToFileURL(entry).href, { runtimeRoot }),
    entry,
  );
  await assert.rejects(
    daemonRuntimeEntry(pathToFileURL("/tmp/orchestratory/src/main.ts").href, { runtimeRoot }),
    /DAEMON_INSTALL_REQUIRES_PHYSICAL_RELEASE_RUNTIME/u,
  );
  await assert.rejects(
    daemonRuntimeEntry(pathToFileURL(join(data, "repo", "src", "main.js")).href, { runtimeRoot }),
    /DAEMON_INSTALL_REQUIRES_PHYSICAL_RELEASE_RUNTIME/u,
  );

  const roomScript = join(packageRoot, "public", "room.js");
  await rm(roomScript);
  await symlink(entry, roomScript);
  await assert.rejects(
    daemonRuntimeEntry(pathToFileURL(entry).href, { runtimeRoot }),
    /DAEMON_RUNTIME_PATH_UNSAFE/u,
  );
});
