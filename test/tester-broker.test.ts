import test from "node:test";
import assert from "node:assert/strict";
import { buildContainerTestArguments, TesterBroker } from "../src/core/tester-broker.ts";

const profile = {
  id: "node-tests",
  displayName: "Node tests",
  runtime: "docker" as const,
  image: `node@sha256:${"a".repeat(64)}`,
  executable: "node",
  args: ["--test"],
};

test("container tester arguments enforce isolation and never pull", () => {
  const args = buildContainerTestArguments(profile, "/private/tmp/synthetic-workspace");
  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  assert.ok(args.includes("--pull=never"));
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges=true"));
  assert.ok(args.includes("--pids-limit=128"));
  assert.ok(args.includes("--mount=type=bind,source=/private/tmp/synthetic-workspace,target=/workspace,readonly"));
  assert.ok(args.includes("--entrypoint=node"));
  assert.equal(args.at(-1), "--test");
});

test("tester broker is fail-closed for unknown profiles", async () => {
  const broker = new TesterBroker([]);
  assert.equal(broker.hasProfile("missing"), false);
  await assert.rejects(
    broker.run({
      profileId: "missing",
      workspace: process.cwd(),
      timeoutMs: 1000,
      outputLimitBytes: 1024,
    }),
    /TESTER_PROFILE_NOT_CONFIGURED/u,
  );
});

test("tester arguments reject mount-option injection paths and expose only safe profile metadata", () => {
  assert.throws(
    () => buildContainerTestArguments(profile, "relative/path"),
    /TESTER_WORKSPACE_PATH_UNSUPPORTED/u,
  );
  assert.throws(
    () => buildContainerTestArguments(profile, "/tmp/source,readonly=false"),
    /TESTER_WORKSPACE_PATH_UNSUPPORTED/u,
  );
  const broker = new TesterBroker([profile]);
  assert.equal(broker.hasProfile("node-tests"), true);
  assert.deepEqual(broker.profiles(), [
    {
      id: "node-tests",
      displayName: "Node tests",
      runtime: "docker",
      image: profile.image,
    },
  ]);
});
