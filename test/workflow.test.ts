import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HARD_LIMITS, PROFILES } from "../src/config.ts";
import { RunEvents } from "../src/core/events.ts";
import { LocalStore } from "../src/core/store.ts";
import { WorkflowService } from "../src/core/workflow.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { TestResult, WorkflowRequest } from "../src/types.ts";
import {
  ApprovalService,
  checkpointApprovalScope,
  dirtySnapshotApprovalScope,
  workflowApprovalScope,
} from "../src/security/approval.ts";
import { canonicalWorkspace } from "../src/security/workspace.ts";
import { TesterBroker, type TestRunRequest, type TesterRunner } from "../src/core/tester-broker.ts";
import { GitBroker } from "../src/core/git-broker.ts";
import { WorkspacePolicy } from "../src/security/workspace-policy.ts";
import type { ProviderAdapter } from "../src/providers/provider.ts";
import type { ProviderId, ProviderRequest } from "../src/types.ts";
import { DirtySnapshotService } from "../src/core/dirty-snapshot-broker.ts";
import { WorktreeBroker } from "../src/core/worktree-broker.ts";

class ScriptedRegistry extends ProviderRegistry {
  readonly prompts: ProviderRequest[] = [];
  readonly #script: (request: ProviderRequest) => string;

  constructor(script: (request: ProviderRequest) => string) {
    super([]);
    this.#script = script;
  }

  override get(id: ProviderId): ProviderAdapter {
    const capabilities = super.get(id).capabilities;
    return {
      capabilities,
      invoke: async (request) => {
        this.prompts.push({ ...request });
        const text = this.#script(request);
        return {
          provider: id,
          model: request.model,
          text,
          exitCode: 0,
          durationMs: 1,
          outputBytes: Buffer.byteLength(text),
        };
      },
      doctor: async () => ({ ok: true }),
      listModels: async () => [...capabilities.subscriptionModels],
    };
  }
}

const execFileAsync = promisify(execFile);

class SequenceTester implements TesterRunner {
  calls = 0;

  hasProfile(profileId: string): boolean {
    return profileId === "synthetic-tests";
  }

  profiles() {
    return [
      {
        id: "synthetic-tests",
        displayName: "Synthetic tests",
        runtime: "docker" as const,
        image: `synthetic@sha256:${"a".repeat(64)}`,
      },
    ];
  }

  async run(_request: TestRunRequest): Promise<TestResult> {
    this.calls += 1;
    const passed = this.calls > 1;
    return {
      profileId: "synthetic-tests",
      exitCode: passed ? 0 : 1,
      durationMs: 1,
      outputBytes: 20,
      stdout: passed ? "passed" : "synthetic failure",
      stderr: "",
    };
  }
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-workflow-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "README.md"), "synthetic\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"],
    { cwd: root },
  );
  return root;
}

function fakeRequest(workspace: string): WorkflowRequest {
  return {
    workspace,
    workspaceMode: "in-place",
    worktreeConfirmed: false,
    task: "Perform a synthetic no-op review.",
    profile: "normal",
    planner: { role: "planner", provider: "fake", model: "fake", authMode: "subscription" },
    writer: { role: "writer", provider: "fake", model: "fake", authMode: "subscription" },
    reviewers: [
      { role: "reviewer", provider: "fake", model: "fake", authMode: "subscription" },
    ],
    testConfirmed: false,
    softLimits: { ...PROFILES.normal },
    apiModeConfirmed: false,
    apiMaxCostUsdPerCall: 0,
    apiBudgetUsdPerRun: 0,
  };
}

test("completes a deterministic fake-provider workflow", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const events = new RunEvents(store);
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events,
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const result = await service.run(fakeRequest(workspace));
  assert.equal(result.status, "completed");
  assert.equal(result.counters.rounds, 1);
  assert.equal(result.counters.providerCalls, 3);
  assert.ok(store.listEvents(result.id).some((event) => event.type === "workflow.completed"));
  assert.equal(service.usageView(result.id).status, "completed");
  assert.ok(service.eventsView(result.id).length > 0);
  assert.equal(service.messagesView(result.id).length, 3);
  assert.match(service.messagesView(result.id)[0]?.text ?? "", /Synthetic plan/u);
  assert.equal(
    store.listEvents(result.id).some((event) => event.summary.includes("Synthetic plan")),
    false,
  );
  assert.deepEqual(service.testsView(result.id), []);
  assert.match(await service.diffView(result.id), /Full diff is not retained/u);
});

test("a cross-process emergency-stop epoch prevents the next workflow call", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-global-stop-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  let epoch = 0;
  const registry = new ScriptedRegistry((request) => {
    if (request.role === "planner") epoch += 1;
    return "Synthetic plan";
  });
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: registry,
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
    providerStopEpoch: () => epoch,
  });
  const result = await service.run(fakeRequest(workspace));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "GLOBAL_EMERGENCY_STOP");
  assert.equal(registry.prompts.length, 1);
});

test("stalled writer rounds stop the loop and acceptance criteria reach every prompt", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-stall-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const registry = new ScriptedRegistry((request) =>
    request.role === "reviewer"
      ? "Unmet criteria remain.\nORCHESTRATOR_VERDICT: CHANGES"
      : "ORCHESTRATOR_STATUS: DONE",
  );
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: registry,
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const request = fakeRequest(workspace);
  request.acceptanceCriteria = "所有測試通過且新增文件";
  const result = await service.run(request);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "NO_PROGRESS_STALLED");
  assert.equal(result.counters.rounds, 3);
  assert.ok(
    store.listEvents(result.id).some((event) => event.type === "round.no-progress"),
  );
  for (const role of ["planner", "writer", "reviewer"] as const) {
    const prompt = registry.prompts.find((item) => item.role === role)?.prompt ?? "";
    assert.match(prompt, /User acceptance criteria \(untrusted requirement/u);
    assert.match(prompt, /所有測試通過且新增文件/u);
  }
});

test("absolute workflow deadline aborts an in-flight provider call", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-deadline-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const request = fakeRequest(workspace);
  request.profile = "custom";
  request.softLimits = { ...request.softLimits, workflowTimeoutMs: 1 };
  const result = await service.run(request);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "WORKFLOW_TIMEOUT");
});

test("fails closed when a workspace starts dirty", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await writeFile(join(workspace, "README.md"), "changed\n", "utf8");
  const store = new LocalStore(data);
  t.after(() => store.close());
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  await assert.rejects(service.run(fakeRequest(workspace)), /WORKSPACE_MUST_START_CLEAN/u);
});

test("live subscription writers require an isolated worktree", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-live-writer-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const request = fakeRequest(workspace);
  request.writer = {
    role: "writer",
    provider: "claude",
    model: "sonnet",
    authMode: "subscription",
  };
  await assert.rejects(service.run(request), /LIVE_WRITER_REQUIRES_WORKTREE/u);
});

test("runs in an isolated worktree while leaving the source branch clean", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals,
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const request = fakeRequest(workspace);
  request.workspace = await canonicalWorkspace(workspace);
  request.workspaceMode = "worktree";
  request.worktreeConfirmed = true;
  request.worktreeApproval = approvals.issue(
    "create-worktree",
    workflowApprovalScope(request, "create-worktree"),
    "local-tui",
  ).token;
  const result = await service.run(request);
  assert.equal(result.status, "completed");
  const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace });
  const branch = await execFileAsync("git", ["branch", "--show-current"], { cwd: workspace });
  assert.equal(status.stdout, "");
  assert.equal(branch.stdout.trim(), "main");
  assert.ok(store.listEvents(result.id).some((event) => event.type === "worktree.created"));
});

test("worktree creation fails closed without a scoped approval nonce", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const request = fakeRequest(workspace);
  request.workspaceMode = "worktree";
  request.worktreeConfirmed = true;
  await assert.rejects(service.run(request), /APPROVAL_TOKEN_INVALID/u);
});

test("scoped dirty snapshot imports only into a retained isolated worktree", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-dirty-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await writeFile(join(workspace, "README.md"), "owner pending change\n", "utf8");
  await writeFile(join(workspace, "new.txt"), "owner new file\n", "utf8");
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const dirtySnapshots = new DirtySnapshotService({ maxFiles: 10 });
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals,
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
    dirtySnapshots,
  });
  const request = fakeRequest(await canonicalWorkspace(workspace));
  request.workspaceMode = "worktree";
  request.worktreeConfirmed = true;
  request.dirtySnapshotConfirmed = true;
  const summary = await dirtySnapshots.prepare(request.workspace);
  request.dirtySnapshotId = summary.id;
  request.dirtySnapshotApproval = "a".repeat(43);
  request.worktreeApproval = approvals.issue(
    "create-worktree",
    workflowApprovalScope(request, "create-worktree"),
    "local-tui",
  ).token;
  await assert.rejects(service.run(request), /APPROVAL_INVALID_OR_REPLAYED/u);

  request.dirtySnapshotApproval = approvals.issue(
    "import-dirty-snapshot",
    dirtySnapshotApprovalScope(request, dirtySnapshots.get(summary.id)),
    "local-tui",
  ).token;
  request.worktreeApproval = approvals.issue(
    "create-worktree",
    workflowApprovalScope(request, "create-worktree"),
    "local-tui",
  ).token;
  const result = await service.run(request);
  assert.equal(result.status, "completed");
  assert.equal(await readFile(join(workspace, "README.md"), "utf8"), "owner pending change\n");
  const sourceStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace });
  assert.match(sourceStatus.stdout, /README\.md/u);
  assert.match(sourceStatus.stdout, /new\.txt/u);
  const retained = await new WorktreeBroker(data).retainedWorkspace(result.id);
  assert.ok(retained);
  assert.equal(await readFile(join(retained, "README.md"), "utf8"), "owner pending change\n");
  assert.equal(await readFile(join(retained, "new.txt"), "utf8"), "owner new file\n");
  const events = store.listEvents(result.id);
  assert.ok(events.some((event) => event.type === "workspace.dirty-snapshot-imported"));
  assert.equal(dirtySnapshots.status().pending, 0);
});

test("dirty snapshot apply failure leaves an auditable failed run instead of an orphan worktree", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-dirty-failure-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await writeFile(join(workspace, "README.md"), "captured state\n", "utf8");
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const dirtySnapshots = new DirtySnapshotService({ maxFiles: 10 });
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals,
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
    dirtySnapshots,
  });
  const request = fakeRequest(await canonicalWorkspace(workspace));
  request.workspaceMode = "worktree";
  request.worktreeConfirmed = true;
  request.dirtySnapshotConfirmed = true;
  const summary = await dirtySnapshots.prepare(request.workspace);
  request.dirtySnapshotId = summary.id;
  request.dirtySnapshotApproval = approvals.issue(
    "import-dirty-snapshot",
    dirtySnapshotApprovalScope(request, dirtySnapshots.get(summary.id)),
    "local-tui",
  ).token;
  request.worktreeApproval = approvals.issue(
    "create-worktree",
    workflowApprovalScope(request, "create-worktree"),
    "local-tui",
  ).token;
  await writeFile(join(workspace, "README.md"), "changed after approval\n", "utf8");

  const result = await service.run(request);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "DIRTY_SNAPSHOT_SOURCE_CHANGED");
  assert.equal(store.getRun(result.id)?.status, "failed");
  assert.ok(await new WorktreeBroker(data).retainedWorkspace(result.id));
  const events = store.listEvents(result.id);
  assert.ok(events.some((event) => event.type === "workflow.failed"));
  assert.equal(events.some((event) => event.type === "workspace.dirty-snapshot-imported"), false);
});

test("approved isolated tests can request a bounded writer retry", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const testers = new SequenceTester();
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals,
    testers,
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const request = fakeRequest(await canonicalWorkspace(workspace));
  request.testProfileId = "synthetic-tests";
  request.testConfirmed = true;
  request.testApproval = approvals.issue(
    "run-test",
    workflowApprovalScope(request, "run-test"),
    "local-tui",
  ).token;
  const result = await service.run(request);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.rounds, 2);
  assert.equal(result.counters.subprocesses, 2);
  assert.equal(testers.calls, 2);
  const events = store.listEvents(result.id);
  assert.equal(events.filter((event) => event.type === "tester.completed").length, 2);
  assert.ok(events.some((event) => event.actor === "tester" && event.type === "round.changes-requested"));
});

test("test execution fails closed without a scoped approval nonce", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const request = fakeRequest(workspace);
  request.testProfileId = "synthetic-tests";
  request.testConfirmed = true;
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new SequenceTester(),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  await assert.rejects(service.run(request), /APPROVAL_TOKEN_INVALID/u);
});

test("manually restores an interrupted run only from a matching checkpoint", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const runId = "00000000-0000-4000-8000-000000000001";
  const checkpointId = "00000000-0000-4000-8000-000000000002";
  const at = new Date().toISOString();
  const counters = {
    rounds: 1,
    providerCalls: 2,
    subprocesses: 0,
    consecutiveErrors: 0,
    outputBytes: 20,
    apiBudgetUsd: 0,
  };
  const fingerprint = (await new GitBroker().inspect(workspace)).fingerprint;
  store.saveRun({
    id: runId,
    createdAt: at,
    updatedAt: at,
    status: "running",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters,
  });
  store.saveCheckpoint({
    id: checkpointId,
    runId,
    createdAt: at,
    round: 1,
    phase: "writer-complete",
    workspaceFingerprint: fingerprint,
    counters,
  });
  assert.equal(store.recoverInterruptedRuns(), 1);
  const approvals = new ApprovalService();
  const request = fakeRequest(await canonicalWorkspace(workspace));
  request.restoreRunId = runId;
  request.restoreCheckpointId = checkpointId;
  request.restoreApproval = approvals.issue(
    "restore-checkpoint",
    checkpointApprovalScope(request, runId, checkpointId),
    "local-tui",
  ).token;
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals,
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const result = await service.run(request);
  assert.equal(result.id, runId);
  assert.equal(result.status, "completed");
  assert.equal(result.counters.rounds, 1);
  assert.equal(result.counters.providerCalls, 4);
  const events = store.listEvents(runId);
  assert.ok(events.some((event) => event.type === "checkpoint.restored"));
  assert.ok(events.some((event) => event.type === "round.resumed"));
});

test("active workflow supports explicit pause and resume controls", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const started = await service.start(fakeRequest(workspace));
  assert.equal(service.pause(started.runId), true);
  assert.equal(service.pause("missing"), false);
  assert.equal(service.listActive()[0]?.status, "paused");
  assert.equal(service.resume(started.runId), true);
  assert.equal(service.resume("missing"), false);
  assert.equal((await started.completion).status, "completed");
});

test("active workflow cancellation is fail-closed and concurrency is bounded", async (t) => {
  const workspace = await createRepository();
  const secondWorkspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(secondWorkspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: new ProviderRegistry(),
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace, secondWorkspace]),
  });
  const started = await service.start(fakeRequest(workspace));
  assert.equal(service.pause(started.runId), true);
  await assert.rejects(
    service.run(fakeRequest(secondWorkspace)),
    /MAX_CONCURRENT_WORKFLOWS_REACHED/u,
  );
  assert.equal(service.cancel(started.runId), true);
  assert.equal(service.cancel("missing"), false);
  assert.equal((await started.completion).status, "cancelled");
});

test("fallback writer takes over when the primary writer's provider process fails", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-fallback-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  let writerCalls = 0;
  const registry = new ScriptedRegistry((request) => {
    if (request.role === "reviewer") return "ok\nORCHESTRATOR_VERDICT: PASS";
    if (request.role === "writer") {
      writerCalls += 1;
      if (writerCalls === 1) throw new Error("PROVIDER_EXITED:claude:quota");
      return "ORCHESTRATOR_STATUS: DONE";
    }
    return "ORCHESTRATOR_STATUS: DONE";
  });
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    providers: registry,
    store,
    events: new RunEvents(store),
    approvals: new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
  });
  const request = fakeRequest(workspace);
  request.writer = { role: "writer", provider: "fake", model: "fake", authMode: "subscription" };
  request.fallbackWriter = { role: "writer", provider: "fake", model: "fake", authMode: "subscription" };
  const result = await service.run(request);
  assert.equal(result.status, "completed");
  assert.ok(
    store.listEvents(result.id).some((e) => e.type === "writer.fallback-engaged"),
    "should emit fallback-engaged event",
  );
});

/*
 * A paused run must stay alive on its own deadline.
 *
 * This has to run in a child process, and the child must hold nothing else open. The defect is
 * "nothing ref-ed is alive, so Node decides the loop is drained and the process exits" — and a test
 * runner is itself something ref-ed and alive. Asserting this in-process would pass whether or not
 * the product is correct, which is the one thing a probe for it must not do.
 *
 * The child pauses the run from inside the planner call, so the pause lands while the run is in
 * flight and the very next `#waitIfPaused` blocks. From that moment the only thing that can ever
 * resolve the wait without a human is the workflow deadline. If that deadline does not hold the
 * loop open, the child exits with nothing written and the run is lost silently — no error, no
 * timeout, no record.
 */
async function runChildScript(
  script: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a paused run is kept alive by its own deadline, not by whoever happens to be watching", async (t) => {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-workflow-paused-deadline-"));
  const scriptDir = await mkdtemp(join(tmpdir(), "orchestratory-workflow-paused-child-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(scriptDir, { recursive: true, force: true }));

  const root = new URL("..", import.meta.url).pathname;
  const script = join(scriptDir, "paused-deadline-child.ts");
  await writeFile(script, [
    `import { DEFAULT_HARD_LIMITS, PROFILES } from ${JSON.stringify(`${root}src/config.ts`)};`,
    `import { RunEvents } from ${JSON.stringify(`${root}src/core/events.ts`)};`,
    `import { LocalStore } from ${JSON.stringify(`${root}src/core/store.ts`)};`,
    `import { WorkflowService } from ${JSON.stringify(`${root}src/core/workflow.ts`)};`,
    `import { ProviderRegistry } from ${JSON.stringify(`${root}src/providers/registry.ts`)};`,
    `import { ApprovalService } from ${JSON.stringify(`${root}src/security/approval.ts`)};`,
    `import { TesterBroker } from ${JSON.stringify(`${root}src/core/tester-broker.ts`)};`,
    `import { WorkspacePolicy } from ${JSON.stringify(`${root}src/security/workspace-policy.ts`)};`,
    `import type { ProviderAdapter } from ${JSON.stringify(`${root}src/providers/provider.ts`)};`,
    `import type { ProviderId } from ${JSON.stringify(`${root}src/types.ts`)};`,
    "",
    "const workspace = process.argv[2] as string;",
    "const data = process.argv[3] as string;",
    "const store = new LocalStore(data);",
    "const events = new RunEvents(store);",
    "let runId = \"\";",
    "let paused = false;",
    "",
    "class PausingRegistry extends ProviderRegistry {",
    "  override get(id: ProviderId): ProviderAdapter {",
    "    const capabilities = super.get(id).capabilities;",
    "    return {",
    "      capabilities,",
    "      invoke: async (request) => {",
    "        // Pause from inside the call, so the pause lands mid-run and the next wait point blocks.",
    "        if (runId && !paused) paused = service.pause(runId);",
    "        const text = \"Synthetic plan\";",
    "        return {",
    "          provider: id, model: request.model, text, exitCode: 0,",
    "          durationMs: 1, outputBytes: Buffer.byteLength(text),",
    "        };",
    "      },",
    "      doctor: async () => ({ ok: true }),",
    "      listModels: async () => [...capabilities.subscriptionModels],",
    "    };",
    "  }",
    "}",
    "",
    "const service = new WorkflowService({",
    "  hardLimits: { ...DEFAULT_HARD_LIMITS, workflowTimeoutMs: 700 },",
    "  providers: new PausingRegistry([]),",
    "  store,",
    "  events,",
    "  approvals: new ApprovalService(),",
    "  testers: new TesterBroker([]),",
    "  workspaces: WorkspacePolicy.fromPaths([workspace]),",
    "});",
    "",
    "const request = {",
    "  workspace, workspaceMode: \"in-place\" as const, worktreeConfirmed: false,",
    "  task: \"Perform a synthetic no-op review.\", profile: \"normal\" as const,",
    "  planner: { role: \"planner\" as const, provider: \"fake\" as const, model: \"fake\", authMode: \"subscription\" as const },",
    "  writer: { role: \"writer\" as const, provider: \"fake\" as const, model: \"fake\", authMode: \"subscription\" as const },",
    "  reviewers: [{ role: \"reviewer\" as const, provider: \"fake\" as const, model: \"fake\", authMode: \"subscription\" as const }],",
    "  testConfirmed: false,",
    "  softLimits: { ...PROFILES.normal, workflowTimeoutMs: 700 },",
    "  apiModeConfirmed: false, apiMaxCostUsdPerCall: 0, apiBudgetUsdPerRun: 0,",
    "};",
    "",
    "const result = await service.run(request, (record) => { runId = record.id; });",
    "// Reached only if something kept the process alive while the run sat paused.",
    "process.stdout.write(JSON.stringify({",
    "  completionResolved: true, paused, status: result.status, errorCode: result.errorCode,",
    "}));",
    "store.close();",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });

  const child = await runChildScript(script, [workspace, data]);
  assert.equal(
    child.code,
    0,
    `the child must not exit before the run settles (code ${child.code}); stderr: ${child.stderr}`,
  );
  const report: unknown = JSON.parse(child.stdout.trim());
  assert.deepEqual(report, {
    completionResolved: true,
    paused: true,
    status: "failed",
    errorCode: "WORKFLOW_TIMEOUT",
  });
});
