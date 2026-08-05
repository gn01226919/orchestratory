import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_HARD_LIMITS, PROFILES } from "../src/config.ts";
import { RunEvents } from "../src/core/events.ts";
import { LocalStore } from "../src/core/store.ts";
import { WorkflowService } from "../src/core/workflow.ts";
import { ProviderCallGovernor } from "../src/core/provider-call-governor.ts";
import { WorkflowRequestStore } from "../src/core/workflow-request-store.ts";
import { TesterBroker } from "../src/core/tester-broker.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import {
  isNoCostProvider,
  providerBillingModel,
  providerExecutionModel,
} from "../src/providers/billing.ts";
import type { ProviderAdapter } from "../src/providers/provider.ts";
import { ApprovalService, workflowApprovalScope } from "../src/security/approval.ts";
import { decideProviderCall } from "../src/security/policy.ts";
import { WorkspacePolicy } from "../src/security/workspace-policy.ts";
import { canonicalWorkspace } from "../src/security/workspace.ts";
import { parseWorkflowRequest } from "../src/ui/request.ts";
import {
  renderTerminalDashboard,
  usageDetailLines,
  type TerminalDashboardInput,
} from "../src/ui/terminal-dashboard.ts";
import type {
  ApiModelPolicy,
  ProviderId,
  ProviderRequest,
  RunCounters,
  RunEvent,
  WorkflowRequest,
} from "../src/types.ts";

const execFileAsync = promisify(execFile);
const PLACEHOLDER_ENDPOINT = "http://127.0.0.1:11434";

/**
 * Registry whose adapters are scripted in-process, but whose registration,
 * capability and `prepareApiCall` behaviour is the real one. The local endpoint is
 * a syntactically valid loopback origin that is never contacted.
 */
class ScriptedRegistry extends ProviderRegistry {
  readonly prompts: ProviderRequest[] = [];
  readonly #script: (request: ProviderRequest) => string | Promise<string>;

  constructor(
    script: (request: ProviderRequest) => string | Promise<string>,
    policies: ReadonlyArray<Readonly<ApiModelPolicy>> = [],
  ) {
    super(policies, { localEndpoint: PLACEHOLDER_ENDPOINT });
    this.#script = script;
  }

  override get(id: ProviderId): ProviderAdapter {
    const capabilities = super.get(id).capabilities;
    return {
      capabilities,
      invoke: async (request) => {
        this.prompts.push({ ...request });
        const text = await this.#script(request);
        return {
          provider: id,
          model: request.model,
          text,
          exitCode: 0,
          durationMs: 1,
          outputBytes: Buffer.byteLength(text),
          ...(id === "local" ? { estimatedCostUsd: 0 } : {}),
        };
      },
      doctor: async () => ({ ok: true }),
      listModels: async () => [...capabilities.subscriptionModels],
    };
  }
}

function passingScript(request: ProviderRequest): string {
  if (request.role === "reviewer") return "Nothing outstanding.\nORCHESTRATOR_VERDICT: PASS";
  if (request.role === "writer") return "No file changes were required.\nORCHESTRATOR_STATUS: DONE";
  return "Synthetic local plan.\nORCHESTRATOR_STATUS: DONE";
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-no-cost-"));
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

function localRequest(workspace: string, overrides: Partial<WorkflowRequest> = {}): WorkflowRequest {
  return {
    workspace,
    workspaceMode: "in-place",
    worktreeConfirmed: false,
    task: "Review this project with a no-cost local model.",
    profile: "normal",
    planner: {
      role: "planner",
      provider: "local",
      model: "synthetic-local-model",
      authMode: "subscription",
    },
    writer: { role: "writer", provider: "fake", model: "fake", authMode: "subscription" },
    reviewers: [
      { role: "reviewer", provider: "local", model: "synthetic-local-model", authMode: "subscription" },
    ],
    testConfirmed: false,
    softLimits: { ...PROFILES.normal },
    apiModeConfirmed: false,
    apiMaxCostUsdPerCall: 0,
    apiBudgetUsdPerRun: 0,
    ...overrides,
  };
}

interface Harness {
  service: WorkflowService;
  store: LocalStore;
  registry: ScriptedRegistry;
  workspace: string;
}

async function harness(
  t: TestContext,
  options: {
    script?: (request: ProviderRequest) => string | Promise<string>;
    policies?: ReadonlyArray<Readonly<ApiModelPolicy>>;
    hardLimits?: Partial<typeof DEFAULT_HARD_LIMITS>;
    approvals?: ApprovalService;
    providerStopEpoch?: () => number;
  } = {},
): Promise<Harness> {
  const workspace = await createRepository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-no-cost-data-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const registry = new ScriptedRegistry(options.script ?? passingScript, options.policies ?? []);
  const service = new WorkflowService({
    hardLimits: { ...DEFAULT_HARD_LIMITS, ...options.hardLimits },
    providers: registry,
    store,
    events: new RunEvents(store),
    approvals: options.approvals ?? new ApprovalService(),
    testers: new TesterBroker([]),
    workspaces: WorkspacePolicy.fromPaths([workspace]),
    ...(options.providerStopEpoch ? { providerStopEpoch: options.providerStopEpoch } : {}),
  });
  // Approval scopes bind the canonical workspace the service resolves, not the raw path.
  return { service, store, registry, workspace: await canonicalWorkspace(workspace) };
}

function counters(overrides: Partial<RunCounters> = {}): RunCounters {
  return {
    rounds: 0,
    providerCalls: 0,
    subprocesses: 0,
    consecutiveErrors: 0,
    outputBytes: 0,
    apiBudgetUsd: 0,
    ...overrides,
  };
}

function eventsOfType(events: RunEvent[], type: string): RunEvent[] {
  return events.filter((event) => event.type === type);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      timer.unref();
    });
  }
}

test("provider billing and execution models are declared, not inferred", () => {
  assert.equal(providerBillingModel("local"), "no-cost");
  assert.equal(providerBillingModel("fake"), "no-cost");
  for (const id of ["codex", "claude", "grok"] as const) {
    assert.equal(providerBillingModel(id), "billed");
    assert.equal(isNoCostProvider(id), false);
    assert.equal(providerExecutionModel(id), "subprocess");
  }
  assert.equal(isNoCostProvider("local"), true);
  assert.equal(providerExecutionModel("local"), "in-process");
  assert.equal(providerExecutionModel("fake"), "in-process");

  // An id that never passed a parser must fail closed instead of inheriting the
  // cheaper path by omission.
  assert.throws(
    () => providerBillingModel("future-provider" as ProviderId),
    /PROVIDER_BILLING_MODEL_UNDECLARED/u,
  );
  assert.throws(
    () => providerExecutionModel("future-provider" as ProviderId),
    /PROVIDER_EXECUTION_MODEL_UNDECLARED/u,
  );
});

test("a local call runs with no monetary reservation and records an explicit zero", async (t) => {
  const { service, store, workspace } = await harness(t);
  const result = await service.run(localRequest(workspace));
  assert.equal(result.status, "completed");
  assert.equal(result.counters.providerCalls, 3);
  assert.equal(result.counters.apiBudgetUsd, 0);
  // Neither the local calls nor the in-process fake writer spawn a subprocess.
  assert.equal(result.counters.subprocesses, 0);

  const events = store.listEvents(result.id);
  assert.deepEqual(eventsOfType(events, "api.budget-reserved"), []);
  const noCost = eventsOfType(events, "provider.no-cost");
  assert.equal(noCost.length, 3);
  assert.equal(noCost.filter((event) => event.actor === "local").length, 2);
  for (const event of noCost) {
    assert.equal(event.metadata?.estimatedCostUsd, 0);
    assert.equal(event.metadata?.billing, "no-cost");
    assert.match(event.summary, /kill-switch limits still apply/u);
  }

  const completed = eventsOfType(events, "provider.completed").filter(
    (event) => event.actor === "local",
  );
  assert.equal(completed.length, 2);
  for (const event of completed) {
    // Present and zero, never an absent field a reader would read as "not measured".
    assert.ok(Object.hasOwn(event.metadata ?? {}, "estimatedCostUsd"));
    assert.equal(event.metadata?.estimatedCostUsd, 0);
    assert.equal(event.metadata?.billing, "no-cost");
  }
});

test("a local assignment can never take the billed API path", async (t) => {
  const approvals = new ApprovalService();
  const { service, store, workspace } = await harness(t, { approvals });
  const request = localRequest(workspace, {
    planner: {
      role: "planner",
      provider: "local",
      model: "synthetic-local-model",
      authMode: "api",
    },
    reviewers: [{ role: "reviewer", provider: "fake", model: "fake", authMode: "subscription" }],
    apiModeConfirmed: true,
    apiMaxCostUsdPerCall: 1,
    apiBudgetUsdPerRun: 2,
  });
  const issued = approvals.issue("use-api", workflowApprovalScope(request, "use-api"), "local-tui");
  request.apiApproval = issued.token;

  const result = await service.run(request);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "NO_COST_PROVIDER_HAS_NO_API_MODE");
  assert.deepEqual(eventsOfType(store.listEvents(result.id), "api.budget-reserved"), []);
  assert.equal(result.counters.apiBudgetUsd, 0);
});

test("a billed provider still reserves its worst-case budget alongside a local call", async (t) => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-not-real-secret";
  t.after(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
  const approvals = new ApprovalService();
  const policies: ApiModelPolicy[] = [
    {
      provider: "codex",
      model: "synthetic-api-model",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      maxOutputTokens: 1_000,
    },
  ];
  const { service, store, workspace } = await harness(t, { approvals, policies });
  const request = localRequest(workspace, {
    planner: {
      role: "planner",
      provider: "codex",
      model: "synthetic-api-model",
      authMode: "api",
    },
    apiModeConfirmed: true,
    apiMaxCostUsdPerCall: 1,
    apiBudgetUsdPerRun: 2,
  });
  request.apiApproval = approvals.issue(
    "use-api",
    workflowApprovalScope(request, "use-api"),
    "local-tui",
  ).token;

  const result = await service.run(request);
  assert.equal(result.status, "completed");
  assert.ok(result.counters.apiBudgetUsd > 0);
  const events = store.listEvents(result.id);
  const reserved = eventsOfType(events, "api.budget-reserved");
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0]?.actor, "codex");
  // The billed planner never takes the no-cost path; the local reviewer always does.
  const noCost = eventsOfType(events, "provider.no-cost");
  assert.equal(noCost.some((event) => event.actor === "codex"), false);
  assert.ok(noCost.some((event) => event.actor === "local"));
  assert.equal(
    eventsOfType(events, "provider.completed").find((event) => event.actor === "codex")?.metadata
      ?.billing,
    "billed",
  );
});

test("a billed provider is still refused when the per-call ceiling is too low", async (t) => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-not-real-secret";
  t.after(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
  const approvals = new ApprovalService();
  const { service, workspace } = await harness(t, {
    approvals,
    policies: [
      {
        provider: "codex",
        model: "synthetic-api-model",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
        maxOutputTokens: 1_000,
      },
    ],
  });
  const request = localRequest(workspace, {
    planner: {
      role: "planner",
      provider: "codex",
      model: "synthetic-api-model",
      authMode: "api",
    },
    apiModeConfirmed: true,
    apiMaxCostUsdPerCall: 0.000_001,
    apiBudgetUsdPerRun: 2,
  });
  request.apiApproval = approvals.issue(
    "use-api",
    workflowApprovalScope(request, "use-api"),
    "local-tui",
  ).token;
  const result = await service.run(request);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "API_CALL_BUDGET_TOO_LOW_FOR_WORST_CASE");
});

test("a billed subscription provider still books a subprocess and no cost figure", async (t) => {
  const { service, store, workspace } = await harness(t);
  const result = await service.run(
    localRequest(workspace, {
      planner: {
        role: "planner",
        provider: "codex",
        model: "synthetic-cli-model",
        authMode: "subscription",
      },
    }),
  );
  assert.equal(result.status, "completed");
  // The CLI provider launches a child process; the local and fake calls do not.
  assert.equal(result.counters.subprocesses, 1);
  const completed = store
    .listEvents(result.id)
    .filter((event) => event.type === "provider.completed" && event.actor === "codex");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.metadata?.billing, "billed");
  // A billed provider that reports no figure must not be dressed up as a measured zero.
  assert.equal(Object.hasOwn(completed[0]?.metadata ?? {}, "estimatedCostUsd"), false);
});

test("call-count and consecutive-failure limits still refuse a local call", () => {
  const request = localRequest("/tmp/synthetic-project");
  const shared = {
    request,
    hard: { ...DEFAULT_HARD_LIMITS },
    soft: request.softLimits,
    access: "read-only" as const,
    role: "planner",
  };
  assert.deepEqual(
    decideProviderCall({ ...shared, counters: counters({ providerCalls: 15 }) }),
    { decision: "deny", reason: "MAX_PROVIDER_CALLS_REACHED" },
  );
  assert.deepEqual(
    decideProviderCall({ ...shared, counters: counters({ consecutiveErrors: 3 }) }),
    { decision: "deny", reason: "CIRCUIT_BREAKER_OPEN" },
  );
  assert.deepEqual(
    decideProviderCall({ ...shared, counters: counters() }),
    { decision: "allow", reason: "POLICY_ALLOW" },
  );
});

test("the soft call ceiling stops a local workflow mid-run", async (t) => {
  const { service, workspace } = await harness(t);
  const result = await service.run(
    localRequest(workspace, {
      profile: "custom",
      softLimits: {
        maxRounds: 5,
        maxProviderCalls: 1,
        workflowTimeoutMs: 60_000,
        providerTimeoutMs: 10_000,
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "MAX_PROVIDER_CALLS_REACHED");
  assert.equal(result.counters.providerCalls, 1);
});

test("a failing local call still feeds the consecutive-failure counter", async (t) => {
  const { service, workspace } = await harness(t, {
    script: (request) => {
      if (request.role === "planner") throw new Error("LOCAL_ENDPOINT_UNREACHABLE");
      return passingScript(request);
    },
  });
  const result = await service.run(localRequest(workspace));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "LOCAL_ENDPOINT_UNREACHABLE");
  assert.equal(result.counters.consecutiveErrors, 1);
});

test("the concurrency ceiling refuses a second local workflow", async (t) => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = true;
  const { service, workspace, registry } = await harness(t, {
    hardLimits: { maxConcurrentWorkflows: 1 },
    script: async (request) => {
      if (request.role === "planner" && gated) {
        gated = false;
        await gate;
      }
      return passingScript(request);
    },
  });
  const first = service.run(localRequest(workspace));
  await waitFor(() => registry.prompts.length >= 1);
  await assert.rejects(
    async () => await service.run(localRequest(workspace)),
    /MAX_CONCURRENT_WORKFLOWS_REACHED/u,
  );
  release();
  assert.equal((await first).status, "completed");
});

test("a kill-epoch change stops the next local call", async (t) => {
  let epoch = 0;
  const { service, workspace, registry } = await harness(t, {
    providerStopEpoch: () => epoch,
    script: (request) => {
      if (request.role === "planner") epoch += 1;
      return passingScript(request);
    },
  });
  const result = await service.run(localRequest(workspace));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "GLOBAL_EMERGENCY_STOP");
  assert.equal(registry.prompts.length, 1);
});

test("the shared governor still bounds local calls and honours the kill switch", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-no-cost-governor-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  let hold: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const server = createServer((_request, response: ServerResponse) => {
    if (hold) {
      arrived?.();
      // Never answered: the call may only end through the governor's abort.
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { content: "local reply" } }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const governor = new ProviderCallGovernor(data, 2, { pollMs: 10 });
  t.after(() => governor.close());
  const registry = new ProviderRegistry([], {
    governor,
    localEndpoint: `http://127.0.0.1:${port}`,
  });
  const local = registry.get("local");
  const request: ProviderRequest = {
    runId: "00000000-0000-4000-8000-0000000000bb",
    role: "reviewer",
    access: "read-only",
    workspace: process.cwd(),
    prompt: "synthetic prompt",
    model: "synthetic-local-model",
    authMode: "subscription",
    timeoutMs: 5_000,
    outputLimitBytes: 65_536,
  };

  const first = await local.invoke(request);
  assert.equal(first.estimatedCostUsd, 0);
  assert.equal(governor.status().calls, 1);

  // The kill switch aborts an in-flight local call.
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  hold = () => {};
  const pending = assert.rejects(async () => await local.invoke(request), /LOCAL_CANCELLED/u);
  await seen;
  governor.stopAll();
  await pending;

  // The 24-hour call ceiling is a count, not a cost: a no-cost provider is still bound.
  hold = undefined;
  await assert.rejects(
    async () => await local.invoke(request),
    /GLOBAL_PROVIDER_CALL_LIMIT_REACHED/u,
  );
});

function dashboardInput(provider: ProviderId): TerminalDashboardInput {
  const createdAt = "2026-08-05T03:30:00.000Z";
  return {
    runId: "00000000-0000-4000-8000-000000000009",
    task: "Review with a no-cost local model",
    workspace: "/tmp/synthetic-project",
    workspaceMode: "in-place",
    profile: "normal",
    assignments: [
      { role: "planner", provider, model: "synthetic-local-model", authMode: "subscription" },
    ],
    record: {
      id: "00000000-0000-4000-8000-000000000009",
      createdAt,
      updatedAt: createdAt,
      status: "running",
      workspaceLabel: "synthetic-project",
      profile: "normal",
      counters: counters({ rounds: 1, providerCalls: 1 }),
    },
    events: [],
    softLimits: { ...PROFILES.normal },
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    view: "usage",
    nowMs: Date.parse("2026-08-05T03:31:00.000Z"),
  };
}

test("usage surfaces report a local call as an explicit zero, not as quota spend", () => {
  const localLines = usageDetailLines(dashboardInput("local"));
  assert.ok(localLines.some((line) => line.includes("Reserved API budget    $0.00")));
  const explicit = localLines.find((line) => line.startsWith("No-cost providers"));
  assert.ok(explicit);
  assert.match(explicit, /local/u);
  assert.match(explicit, /measured cost \$0\.00 \(no monetary reservation\)/u);

  const output = renderTerminalDashboard(dashboardInput("local"), {
    columns: 100,
    rows: 30,
    color: false,
  });
  assert.match(output, /planner\s+local\/synthetic-local-model\s+waiting\s+no cost/u);
  assert.doesNotMatch(output, /planner.*subscription/u);

  // A billed provider keeps reporting its real auth mode and gains no free line.
  const billed = usageDetailLines(dashboardInput("claude"));
  assert.equal(billed.some((line) => line.startsWith("No-cost providers")), false);
  assert.match(
    renderTerminalDashboard(dashboardInput("claude"), { columns: 100, rows: 30, color: false }),
    /planner\s+claude\/synthetic-local-model\s+waiting\s+subscription/u,
  );
});

test("the local provider stays unreachable from every workflow request surface", async (t) => {
  const registry = new ProviderRegistry([], { localEndpoint: PLACEHOLDER_ENDPOINT });
  const proposal = {
    workspace: "/tmp/synthetic-project",
    workspaceMode: "in-place",
    task: "Synthetic task",
    profile: "normal",
    planner: { provider: "local", model: "synthetic-local-model" },
    writer: { provider: "fake", model: "fake" },
    reviewers: [{ provider: "fake", model: "fake" }],
    testConfirmed: false,
  };
  assert.throws(() => parseWorkflowRequest(proposal, registry), /UNKNOWN_PROVIDER/u);

  const data = await mkdtemp(join(tmpdir(), "orchestratory-no-cost-queue-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new WorkflowRequestStore(data);
  t.after(() => store.close());
  assert.throws(
    () =>
      store.enqueue(
        {
          workspace: "/tmp/synthetic-project",
          task: "Synthetic task",
          profile: "normal",
          planner: { provider: "local", model: "synthetic-local-model" },
          writer: { provider: "fake", model: "fake" },
          reviewers: [{ provider: "fake", model: "fake" }],
        },
        "claude",
      ),
    /WORKFLOW_REQUEST_TARGET_INVALID/u,
  );
});
