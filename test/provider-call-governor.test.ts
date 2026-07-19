import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderCallGovernor } from "../src/core/provider-call-governor.ts";
import type { ProviderRequest, ProviderResult } from "../src/types.ts";
import { DatabaseSync } from "node:sqlite";

function request(signal?: AbortSignal): ProviderRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    role: "planner",
    access: "read-only",
    workspace: "/tmp/synthetic",
    prompt: "synthetic",
    model: "fake",
    authMode: "subscription",
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
    ...(signal ? { signal } : {}),
  };
}

const result: ProviderResult = {
  provider: "fake",
  model: "fake",
  text: "ok",
  exitCode: 0,
  durationMs: 1,
  outputBytes: 2,
};

test("provider call ceiling persists across processes and the database is owner-only", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-governor-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const first = new ProviderCallGovernor(data, 2, { pollMs: 10 });
  const second = new ProviderCallGovernor(data, 2, { pollMs: 10 });
  t.after(() => first.close());
  t.after(() => second.close());
  await first.invoke(request(), async () => result);
  await second.invoke(request(), async () => result);
  assert.equal(first.status().calls, 2);
  assert.deepEqual(first.integrity(), {
    schemaVersion: 1,
    quickCheck: "ok",
    stateRows: 1,
    stateValid: true,
  });
  await assert.rejects(
    first.invoke(request(), async () => result),
    /GLOBAL_PROVIDER_CALL_LIMIT_REACHED/u,
  );
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal(first.status(Date.now() + 25 * 60 * 60 * 1_000).calls, 0);
  assert.throws(() => new ProviderCallGovernor(data, 0), /INVALID_PROVIDER_CALL_LIMIT/u);
  assert.throws(() => new ProviderCallGovernor(data, 2, { pollMs: 1 }), /INVALID_PROVIDER_GOVERNOR_POLL/u);
});

test("governor resets expired persisted windows and rejects future schemas", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-governor-expired-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const governor = new ProviderCallGovernor(data, 1, { pollMs: 10 });
  const raw = new DatabaseSync(governor.path);
  raw.prepare("UPDATE provider_governor_state SET window_started_at = 0, calls = 99 WHERE id = 1").run();
  raw.close();
  await governor.invoke(request(), async () => result);
  assert.equal(governor.status().calls, 1);
  governor.close();
  governor.close();
  assert.throws(() => governor.status(), /PROVIDER_GOVERNOR_CLOSED/u);

  const schema = new DatabaseSync(governor.path);
  schema.exec("PRAGMA user_version = 999");
  schema.close();
  assert.throws(
    () => new ProviderCallGovernor(data, 1, { pollMs: 10 }),
    /PROVIDER_GOVERNOR_SCHEMA_UNSUPPORTED/u,
  );
});

test("governor rejects pre-aborted calls and reports invalid shared state", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-governor-invalid-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const governor = new ProviderCallGovernor(data, 2, { pollMs: 10 });
  t.after(() => governor.close());
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(governor.invoke(request(caller.signal), async () => result), /PROVIDER_ABORTED/u);
  const raw = new DatabaseSync(governor.path);
  raw.prepare("DELETE FROM provider_governor_state").run();
  raw.close();
  assert.equal(governor.integrity().stateValid, false);
  assert.throws(() => governor.status(), /PROVIDER_GOVERNOR_STATE_MISSING/u);
});

test("a shared kill epoch aborts an in-flight call in another process", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-governor-stop-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const worker = new ProviderCallGovernor(data, 5, { pollMs: 10 });
  const control = new ProviderCallGovernor(data, 5, { pollMs: 10 });
  t.after(() => worker.close());
  t.after(() => control.close());
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const running = worker.invoke(request(), async (governed) => {
    started();
    return await new Promise<ProviderResult>((_resolve, reject) => {
      governed.signal?.addEventListener("abort", () => reject(new Error("ABORTED_BY_TEST")), { once: true });
    });
  });
  await ready;
  const stopped = control.stopAll();
  assert.equal(stopped.activeLocal, 0);
  await assert.rejects(running, /ABORTED_BY_TEST/u);
  assert.equal(worker.status().activeLocal, 0);
});

test("caller cancellation aborts locally without requiring a global stop", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-governor-cancel-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const governor = new ProviderCallGovernor(data, 5, { pollMs: 10 });
  t.after(() => governor.close());
  const caller = new AbortController();
  const running = governor.invoke(request(caller.signal), async (governed) =>
    await new Promise<ProviderResult>((_resolve, reject) => {
      governed.signal?.addEventListener("abort", () => reject(new Error("CALLER_ABORTED")), { once: true });
      caller.abort();
    }));
  await assert.rejects(running, /CALLER_ABORTED/u);
  assert.equal(governor.status().calls, 1);
});
