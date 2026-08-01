import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CollabToolBroker, handleCollabMcpMessage } from "../src/mcp/collab-server.ts";
import { RoomLedger } from "../src/core/room-ledger.ts";
import { RoomInboxStore } from "../src/core/room-inbox.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";
import { WorkflowRequestStore } from "../src/core/workflow-request-store.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { WorkspacePolicy } from "../src/security/workspace-policy.ts";
import { DEFAULT_HARD_LIMITS } from "../src/config.ts";
import type { AgentAssignment, ProviderRequest, ProviderResult } from "../src/types.ts";

function providerResult(
  assignment: AgentAssignment,
  request: ProviderRequest,
  text: string,
): ProviderResult {
  return {
    provider: assignment.provider,
    model: request.model,
    text,
    exitCode: 0,
    durationMs: 7,
    outputBytes: Buffer.byteLength(text),
  };
}

interface BrokerFixture {
  broker: CollabToolBroker;
  calls: Array<{ assignment: AgentAssignment; request: ProviderRequest }>;
  root: string;
  ledger: RoomLedger;
  workflowRequests: WorkflowRequestStore;
  cleanup(): Promise<void>;
}

async function fixture(options: {
  reply?: (assignment: AgentAssignment) => string;
  failProvider?: string;
  maxProviderCalls?: number;
  roots?: number;
  requestRoomJoin?: (roomId: string, workspace: string) => void;
  waitForRoomJoin?: (input: {
    roomId: string;
    workspace: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  cancelRoomJoin?: (roomId: string, workspace: string) => void;
  sessionRoomMode?: "room-first" | "seat-only";
} = {}): Promise<BrokerFixture> {
  const directories: string[] = [];
  for (let index = 0; index < (options.roots ?? 1); index += 1) {
    directories.push(await mkdtemp(join(tmpdir(), "orchestratory-collab-")));
  }
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collab-data-"));
  const ledger = new RoomLedger(data);
  const workflowRequests = new WorkflowRequestStore(data);
  const calls: BrokerFixture["calls"] = [];
  const workspaces = WorkspacePolicy.fromPaths(directories);
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces,
    hardLimits: {
      ...DEFAULT_HARD_LIMITS,
      ...(options.maxProviderCalls !== undefined
        ? { maxProviderCalls: options.maxProviderCalls }
        : {}),
    },
    invoke: async (assignment, request) => {
      calls.push({ assignment: { ...assignment }, request: { ...request } });
      if (assignment.provider === options.failProvider) throw new Error("SYNTHETIC_PROVIDER_FAILURE");
      return providerResult(
        assignment,
        request,
        options.reply?.(assignment) ?? `${assignment.provider} answer`,
      );
    },
    contextFactory: () => ({
      fileTree: async () => "src/app.ts\nREADME.md",
      readFiles: async () => "File: src/app.ts\nexport const app = true;",
    }),
    ledger,
    workflowRequests,
    ...(options.requestRoomJoin ? { requestRoomJoin: options.requestRoomJoin } : {}),
    ...(options.waitForRoomJoin ? { waitForRoomJoin: options.waitForRoomJoin } : {}),
    ...(options.cancelRoomJoin ? { cancelRoomJoin: options.cancelRoomJoin } : {}),
    ...(options.sessionRoomMode
      ? {
          resolveSessionRoom: () => ({
            roomId: "demo",
            workspace: workspaces.roots()[0]!.path,
            actor: "codex1",
            collaborationMode: options.sessionRoomMode!,
            syncTurns: true,
          }),
        }
      : {}),
  });
  return {
    broker,
    calls,
    root: workspaces.roots()[0]!.path,
    ledger,
    workflowRequests,
    cleanup: async () => {
      workflowRequests.close();
      ledger.close();
      await rm(data, { recursive: true, force: true });
      for (const directory of directories) await rm(directory, { recursive: true, force: true });
    },
  };
}

test("collab broker exposes only the fixed bounded tool registry", async (t) => {
  const { broker, cleanup } = await fixture();
  t.after(cleanup);
  const tools = broker.tools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "list_agents",
      "ask_codex",
      "ask_claude",
      "ask_grok",
      "room_init",
      "room_status",
      "room_post",
      "room_read",
      "room_get",
      "room_search",
      "room_mention",
      "compare_agents",
      "request_coding_workflow",
    ],
  );
  for (const tool of tools) {
    assert.equal((tool.inputSchema as { additionalProperties: boolean }).additionalProperties, false);
  }
  await assert.rejects(broker.call("write_file", {}), /UNKNOWN_COLLAB_TOOL/u);
  await assert.rejects(broker.call("ask_fake", {}), /UNKNOWN_COLLAB_TOOL/u);
  await assert.rejects(
    broker.call("room_send", {
      targetPresenceId: "11111111-1111-4111-8111-111111111111",
      clientRequestId: randomUUID(),
      text: "peer",
    }),
    /ROOM_PEER_MESSAGING_UNAVAILABLE/u,
  );
});

test("room_join_request only proposes this terminal for the matching room", async (t) => {
  const requests: Array<{ roomId: string; workspace: string }> = [];
  const { broker, calls, ledger, root, cleanup } = await fixture({
    requestRoomJoin: (roomId, workspace) => requests.push({ roomId, workspace }),
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });
  const messagesBefore = ledger.getRoom("demo")?.messages;

  assert.equal(broker.tools().some((tool) => tool.name === "room_join_request"), true);
  const joinTool = broker.tools().find((tool) => tool.name === "room_join_request");
  assert.match(String(joinTool?.description ?? ""), /Normally pass only room/u);
  assert.match(String(joinTool?.description ?? ""), /approvalTimeoutMs defaults to 30000/u);
  assert.match(String(joinTool?.description ?? ""), /separate GUI standby request/u);
  assert.match(String(joinTool?.description ?? ""), /never changes the host's sandbox/u);
  const result = JSON.parse(await broker.call("room_join_request", { room: "demo" })) as {
    requested: boolean;
    joined: boolean;
    recording: boolean;
  };
  assert.deepEqual(result, {
    requested: true,
    joined: false,
    executionClass: "native-full-trust",
    capabilityAuthority: "host",
    hostCapabilities: "unchanged",
    recording: false,
    room: "demo",
  });
  assert.deepEqual(requests, [{ roomId: "demo", workspace: root }]);
  assert.equal(ledger.getRoom("demo")?.messages, messagesBefore);
  assert.equal(calls.length, 0);
  await assert.rejects(
    broker.call("room_join_request", { room: "demo", approve: true }),
    /UNKNOWN_ROOM_JOIN_REQUEST_ARGUMENT/u,
  );
});

test("room_join_request returns after membership approval without silently starting duty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-join-duty-root-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-join-duty-data-"));
  const ledger = new RoomLedger(data);
  const inbox = new RoomInboxStore(data);
  t.after(() => inbox.close());
  t.after(() => ledger.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  ledger.createRoom("demo", root);
  const presenceId = "11111111-1111-4111-8111-111111111111";
  let requested = false;
  let observeRequest!: () => void;
  const requestObserved = new Promise<void>((resolve) => { observeRequest = resolve; });
  let joined = false;
  let releaseApproval!: () => void;
  const approval = new Promise<void>((resolve) => { releaseApproval = resolve; });
  const calls: string[] = [];
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([root]),
    hardLimits: DEFAULT_HARD_LIMITS,
    invoke: async () => { calls.push("provider"); throw new Error("PROVIDER_MUST_NOT_RUN"); },
    ledger,
    inbox,
    resolvePresenceId: () => presenceId,
    resolveActor: () => {
      if (!joined) throw new Error("PRESENCE_NOT_JOINED");
      return "codex（即時）";
    },
    requestRoomJoin: () => { requested = true; observeRequest(); },
    waitForRoomJoin: async () => {
      await approval;
      return joined;
    },
  });

  const pending = broker.call("room_join_request", {
    room: "demo",
    approvalTimeoutMs: 5_000,
  });
  await requestObserved;
  assert.equal(requested, true);
  const mention = ledger.append("demo", "you", "@codex（即時） 請立即回覆");
  inbox.enqueue({ message: mention, targetPresenceId: presenceId, targetDisplayName: "codex（即時）" });
  joined = true;
  releaseApproval();

  const result = JSON.parse(await pending) as {
    requested: boolean;
    joined: boolean;
    duty: string;
  };
  assert.equal(result.requested, true);
  assert.equal(result.joined, true);
  assert.equal(result.duty, "standby-approval-required");
  assert.equal((result as Record<string, unknown>).executionClass, "native-full-trust");
  assert.equal((result as Record<string, unknown>).capabilityAuthority, "host");
  assert.equal((result as Record<string, unknown>).hostCapabilities, "unchanged");
  assert.equal(inbox.list("demo")[0]?.ledgerSeq, mention.seq);
  assert.deepEqual(calls, []);
});

test("room_join_request times out fail-closed and validates both bounded waits", async (t) => {
  const waits: Array<{ roomId: string; workspace: string; timeoutMs: number }> = [];
  const { broker, calls, root, cleanup } = await fixture({
    requestRoomJoin: () => undefined,
    waitForRoomJoin: async ({ roomId, workspace, timeoutMs }) => {
      waits.push({ roomId, workspace, timeoutMs });
      return false;
    },
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });

  const timedOut = JSON.parse(await broker.call("room_join_request", {
    room: "demo",
    approvalTimeoutMs: 37,
  })) as { joined: boolean; recording: boolean; duty: string };
  assert.deepEqual(timedOut, {
    requested: true,
    joined: false,
    executionClass: "native-full-trust",
    capabilityAuthority: "host",
    hostCapabilities: "unchanged",
    recording: false,
    room: "demo",
    duty: "approval-timeout",
  });
  assert.deepEqual(waits, [{ roomId: "demo", workspace: root, timeoutMs: 37 }]);
  assert.deepEqual(calls, []);
  await assert.rejects(
    broker.call("room_join_request", { room: "demo", approvalTimeoutMs: 0 }),
    /INVALID_ROOM_JOIN_APPROVAL_TIMEOUT/u,
  );
  await assert.rejects(
    broker.call("room_join_request", { room: "demo", taskTimeoutMs: 25_001 }),
    /UNKNOWN_ROOM_JOIN_REQUEST_ARGUMENT/u,
  );
});

test("room_join_request cancellation clears the stale GUI request", async (t) => {
  const cancelled: Array<{ roomId: string; workspace: string }> = [];
  let observeWait!: () => void;
  const waitObserved = new Promise<void>((resolve) => { observeWait = resolve; });
  const { broker, root, cleanup } = await fixture({
    requestRoomJoin: () => undefined,
    waitForRoomJoin: async ({ signal }) => await new Promise<boolean>((_resolve, reject) => {
      observeWait();
      signal?.addEventListener("abort", () => reject(new Error("ROOM_WAIT_CANCELLED")), { once: true });
    }),
    cancelRoomJoin: (roomId, workspace) => cancelled.push({ roomId, workspace }),
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });
  const controller = new AbortController();
  const pending = broker.call("room_join_request", { room: "demo" }, { signal: controller.signal });
  await waitObserved;
  controller.abort();
  await assert.rejects(pending, /ROOM_WAIT_CANCELLED/u);
  assert.deepEqual(cancelled, [{ roomId: "demo", workspace: root }]);
});

test("room_wait requests GUI standby approval for the exact joined session before listening", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-standby-root-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-standby-data-"));
  const gui = new CollaborationService(data);
  const mcp = new CollaborationService(data);
  t.after(() => gui.close());
  t.after(() => mcp.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  gui.ledger.createRoom("demo", root);
  const session = mcp.registerExternal({
    provider: "codex",
    workspace: root,
    hostPid: 9_001,
    client: "Codex MCP",
  });
  mcp.requestExternalJoin(session.id, "demo", root);
  gui.approveExternalJoin({
    presenceId: session.id,
    roomId: "demo",
    workspace: root,
    collaborationMode: "room-first",
    syncTurns: false,
    label: "待命測試",
  });
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([root]),
    hardLimits: DEFAULT_HARD_LIMITS,
    ledger: mcp.ledger,
    collaboration: mcp,
    resolvePresenceId: () => session.id,
    resolveActor: () => mcp.externalActor(session.id, "demo"),
    resolveSessionRoom: () => ({
      roomId: "demo",
      workspace: root,
      actor: "codex（待命測試）",
      collaborationMode: "room-first",
      syncTurns: false,
    }),
  });

  const waiting = broker.call("room_wait", {
    room: "demo",
    approvalTimeoutMs: 1_000,
    timeoutMs: 1_000,
  });
  for (let attempt = 0; attempt < 20 && !gui.presence.get(session.id)?.standbyRequested; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gui.presence.get(session.id)?.standbyRequested, true);
  assert.equal(gui.roomView("demo", root).sessions[0]?.wakeable, false);
  gui.approveExternalStandby(session.id, "demo", root);
  for (let attempt = 0; attempt < 80 && !gui.roomView("demo", root).sessions[0]?.wakeable; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const posted = gui.postToExternal({
    roomId: "demo",
    workspace: root,
    presenceId: session.id,
    text: "核准後才可喚醒",
  });
  assert.equal(posted.dispatch.immediate, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = JSON.parse(await waiting) as {
    timeout: boolean;
    standbyApproved: boolean;
    delivery: { message: { seq: number } };
  };
  assert.equal(result.timeout, false);
  assert.equal(result.standbyApproved, true);
  assert.equal(result.delivery.message.seq, posted.message.seq);

  const cancelled = new AbortController();
  gui.revokeExternalStandby(session.id, "demo", root);
  const pendingApproval = broker.call("room_wait", {
    room: "demo",
    approvalTimeoutMs: 1_000,
    timeoutMs: 1_000,
  }, { signal: cancelled.signal });
  for (let attempt = 0; attempt < 20 && !gui.presence.get(session.id)?.standbyRequested; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  cancelled.abort();
  await assert.rejects(pendingApproval, /ROOM_WAIT_CANCELLED/u);
  assert.equal(gui.presence.get(session.id)?.standbyRequested, false);
  assert.equal(gui.presence.get(session.id)?.standbyApproved, false);

  const approvalTimeout = broker.call("room_wait", {
    room: "demo",
    approvalTimeoutMs: 1,
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(await approvalTimeout), {
    timeout: true,
    phase: "standby-approval",
    actor: "codex（待命測試）",
    room: "demo",
  });
  assert.equal(gui.presence.get(session.id)?.standbyRequested, false);
  await assert.rejects(
    broker.call("room_wait", { room: "demo", approvalTimeoutMs: 120_001 }),
    /INVALID_ROOM_STANDBY_APPROVAL_TIMEOUT/u,
  );
  await assert.rejects(
    broker.call("room_wait", { room: "demo", timeoutMs: 14_400_001 }),
    /INVALID_ROOM_WAIT_TIMEOUT/u,
  );
});

test("coding workflow tool only queues an owner-reviewed proposal without provider calls", async (t) => {
  const { broker, calls, workflowRequests, cleanup } = await fixture();
  t.after(cleanup);
  const value = JSON.parse(await broker.call("request_coding_workflow", {
    task: "新增安全登入流程",
    acceptanceCriteria: "測試通過，不新增外連",
    profile: "long",
    planner: "grok:grok-4.5",
    writer: "claude:claude-fable-5",
    reviewers: ["codex:gpt-5.6-sol"],
  })) as { approved: boolean; started: boolean; request: { id: string; status: string } };
  assert.equal(value.approved, false);
  assert.equal(value.started, false);
  assert.equal(value.request.status, "pending");
  assert.equal(workflowRequests.listPending()[0]?.task, "新增安全登入流程");
  assert.equal(calls.length, 0);

  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x", writer: "codex" }),
    /WORKFLOW_REQUEST_WRITER_IS_READ_ONLY/u,
  );
  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x", shell: "touch /tmp/x" }),
    /UNKNOWN_WORKFLOW_REQUEST_ARGUMENT/u,
  );
  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x", reviewers: [] }),
    /INVALID_WORKFLOW_REQUEST_REVIEWERS/u,
  );
  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x", reviewers: ["codex", "grok"] }),
    /INVALID_WORKFLOW_REQUEST_REVIEWERS/u,
  );
  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x", profile: "forever" }),
    /INVALID_WORKFLOW_REQUEST_PROFILE/u,
  );
  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x", planner: 42 }),
    /INVALID_WORKFLOW_REQUEST_TARGET/u,
  );
  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x", planner: "shell" }),
    /INVALID_WORKFLOW_REQUEST_TARGET/u,
  );
  assert.equal(calls.length, 0);
});

test("coding workflow proposal is unavailable without its bounded queue", async (t) => {
  const base = await fixture();
  t.after(base.cleanup);
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([base.root]),
    hardLimits: { ...DEFAULT_HARD_LIMITS },
  });
  assert.equal(broker.tools().some((tool) => tool.name === "request_coding_workflow"), false);
  await assert.rejects(
    broker.call("request_coding_workflow", { task: "x" }),
    /WORKFLOW_REQUEST_QUEUE_UNAVAILABLE/u,
  );
});

test("list_agents reports subscription providers, roots, and usage", async (t) => {
  const { broker, cleanup } = await fixture();
  t.after(cleanup);
  const value = JSON.parse(await broker.call("list_agents", {})) as {
    providers: Array<{ id: string; canWriteSubscription: boolean }>;
    workspaceRoots: Array<{ path: string }>;
    usage: { calls: number; maxCalls: number };
  };
  assert.deepEqual(value.providers.map((item) => item.id), ["fake", "codex", "claude", "grok"]);
  assert.equal(value.providers.find((item) => item.id === "claude")?.canWriteSubscription, true);
  assert.equal(value.providers.find((item) => item.id === "codex")?.canWriteSubscription, false);
  assert.equal(value.workspaceRoots.length, 1);
  assert.equal(value.usage.calls, 0);
  await assert.rejects(broker.call("list_agents", { extra: 1 }), /UNKNOWN_LIST_AGENTS_ARGUMENT/u);
});

test("ask tools inject bounded project context and requested file contents", async (t) => {
  const { broker, calls, cleanup } = await fixture();
  t.after(cleanup);
  const value = JSON.parse(await broker.call("ask_claude", {
    question: "架構如何？",
    files: ["src/app.ts"],
  })) as {
    provider: string;
    model: string;
    answer: string;
    durationMs: number;
  };
  assert.equal(value.provider, "claude");
  assert.equal(value.model, "claude-fable-5");
  assert.equal(value.answer, "claude answer");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.request.access, "read-only");
  assert.equal(calls[0]?.request.authMode, "subscription");
  assert.match(calls[0]?.request.prompt ?? "", /read-only worker agent/u);
  assert.match(calls[0]?.request.prompt ?? "", /Project file list \(untrusted repository data\)/u);
  assert.match(calls[0]?.request.prompt ?? "", /Requested file contents \(untrusted repository data\)/u);
  assert.match(calls[0]?.request.prompt ?? "", /export const app = true/u);
  assert.match(calls[0]?.request.prompt ?? "", /Question: 架構如何？/u);
});

test("ask tools fail closed on schema, workspace, and model violations", async (t) => {
  const { broker, root, cleanup } = await fixture({ roots: 2 });
  t.after(cleanup);
  await assert.rejects(broker.call("ask_codex", {}), /INVALID_QUESTION/u);
  await assert.rejects(broker.call("ask_codex", { question: "   " }), /INVALID_QUESTION/u);
  await assert.rejects(
    broker.call("ask_codex", { question: "x".repeat(20_001) }),
    /INVALID_QUESTION/u,
  );
  await assert.rejects(
    broker.call("ask_codex", { question: "q", shell: "rm" }),
    /UNKNOWN_ASK_ARGUMENT/u,
  );
  await assert.rejects(
    broker.call("ask_codex", { question: "q" }),
    /WORKSPACE_SELECTION_REQUIRED/u,
  );
  await assert.rejects(
    broker.call("ask_codex", { question: "q", workspace: "/" }),
    /WORKSPACE_NOT_ALLOWLISTED/u,
  );
  await assert.rejects(
    broker.call("ask_codex", { question: "q", workspace: root, model: "bad model" }),
    /INVALID_MODEL_ID/u,
  );
  await assert.rejects(
    broker.call("ask_codex", { question: "q", workspace: root, files: Array(9).fill("README.md") }),
    /INVALID_CONTEXT_PATHS/u,
  );
  await assert.rejects(
    broker.call("ask_codex", { question: "q", workspace: root, files: "README.md" }),
    /INVALID_CONTEXT_PATHS/u,
  );
  await assert.rejects(
    broker.call("ask_codex", { question: "q", workspace: root, files: [" "] }),
    /INVALID_CONTEXT_PATHS/u,
  );
});

test("empty allowlist fails closed before any provider call", async (t) => {
  const calls: unknown[] = [];
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: new WorkspacePolicy([]),
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => {
      calls.push(assignment);
      return providerResult(assignment, request, "never");
    },
  });
  t.after(() => undefined);
  await assert.rejects(broker.call("ask_claude", { question: "q" }), /WORKSPACE_ALLOWLIST_EMPTY/u);
  assert.equal(calls.length, 0);
});

test("compare_agents fans out to deduplicated bounded targets", async (t) => {
  const { broker, calls, cleanup } = await fixture();
  t.after(cleanup);
  const value = JSON.parse(
    await broker.call("compare_agents", {
      question: "這個設計好嗎？",
      targets: ["codex", "claude:claude-fable-5", "codex"],
    }),
  ) as { answers: Array<{ provider: string; model: string; answer: string }> };
  assert.deepEqual(
    value.answers.map((item) => `${item.provider}/${item.model}`),
    ["codex/gpt-5.6-sol", "claude/claude-fable-5"],
  );
  assert.equal(calls.length, 2);

  await assert.rejects(
    broker.call("compare_agents", { question: "q", targets: ["codex"] }),
    /INVALID_COMPARE_TARGETS/u,
  );
  await assert.rejects(
    broker.call("compare_agents", { question: "q", targets: ["codex", "codex"] }),
    /INVALID_COMPARE_TARGETS/u,
  );
  await assert.rejects(
    broker.call("compare_agents", { question: "q", targets: ["codex", "shell"] }),
    /INVALID_COMPARE_TARGETS/u,
  );
  await assert.rejects(
    broker.call("compare_agents", {
      question: "q",
      targets: ["codex", "claude", "grok", "fake"],
    }),
    /INVALID_COMPARE_TARGETS/u,
  );
});

test("compare_agents preserves successful answers when one worker fails", async (t) => {
  const { broker, cleanup } = await fixture({ failProvider: "claude" });
  t.after(cleanup);
  const value = JSON.parse(await broker.call("compare_agents", {
    question: "保留部分結果",
    targets: ["codex", "claude"],
    files: ["README.md", "README.md"],
  })) as { answers: Array<{ provider: string; answer?: string; error?: string }> };
  assert.equal(value.answers[0]?.provider, "codex");
  assert.equal(value.answers[0]?.answer, "codex answer");
  assert.equal(value.answers[1]?.provider, "claude");
  assert.match(value.answers[1]?.error ?? "", /SYNTHETIC_PROVIDER_FAILURE/u);
});

test("room-first mode forces ask and compare through the shared ledger", async (t) => {
  const { broker, calls, ledger, root, cleanup } = await fixture({
    sessionRoomMode: "room-first",
    reply: (assignment) => `${assignment.provider} ledger answer`,
  });
  t.after(cleanup);
  ledger.createRoom("demo", root);
  ledger.append("demo", "claude", "第一手架構資訊");

  const asked = JSON.parse(await broker.call("ask_codex", { question: "請審查" })) as {
    answer: string;
    ledger: { room: string; mentionSeq: number; replySeq: number; readThroughSeq: number };
  };
  assert.equal(asked.answer, "codex ledger answer");
  assert.equal(asked.ledger.room, "demo");
  assert.equal(asked.ledger.readThroughSeq, 2);
  assert.match(calls[0]?.request.prompt ?? "", /#2 claude: 第一手架構資訊/u);
  assert.equal(ledger.getRange("demo", asked.ledger.mentionSeq, asked.ledger.mentionSeq)[0]?.author, "codex1");
  assert.equal(ledger.getRange("demo", asked.ledger.replySeq, asked.ledger.replySeq)[0]?.author, "codex");

  const compared = JSON.parse(await broker.call("compare_agents", {
    question: "依最新帳本比較",
    targets: ["codex", "claude"],
  })) as { answers: Array<{ provider: string; ledger?: { room: string; readThroughSeq: number } }> };
  assert.equal(compared.answers.every((answer) => answer.ledger?.room === "demo"), true);
  assert.match(calls.at(-1)?.request.prompt ?? "", /codex ledger answer/u);
  assert.equal(ledger.verifyChain("demo"), true);
});

test("seat-only stays standalone while room-first cannot escape its bound workspace", async (t) => {
  const seat = await fixture({ sessionRoomMode: "seat-only" });
  t.after(seat.cleanup);
  seat.ledger.createRoom("demo", seat.root);
  await seat.broker.call("ask_codex", { question: "一次性諮詢" });
  assert.equal(seat.ledger.getRoom("demo")?.messages, 1);
  assert.doesNotMatch(seat.calls[0]?.request.prompt ?? "", /Recent room messages/u);

  const bound = await fixture({ sessionRoomMode: "room-first", roots: 2 });
  t.after(bound.cleanup);
  bound.ledger.createRoom("demo", bound.root);
  const otherWorkspace = (JSON.parse(await bound.broker.call("list_agents", {})) as {
    workspaceRoots: Array<{ path: string }>;
  }).workspaceRoots[1]!.path;
  const implicit = JSON.parse(await bound.broker.call("ask_codex", { question: "使用已綁定專案" })) as {
    ledger: { room: string };
  };
  assert.equal(implicit.ledger.room, "demo");
  await assert.rejects(
    bound.broker.call("ask_codex", { question: "跨專案繞過", workspace: otherWorkspace }),
    /ROOM_FIRST_WORKSPACE_MISMATCH/u,
  );
  assert.equal(bound.calls.length, 1);
});

test("room tools post, read, and search the shared numbered ledger", async (t) => {
  const { broker, ledger, root, cleanup } = await fixture();
  t.after(cleanup);
  const created = JSON.parse(await broker.call("room_init", {})) as { id: string };
  assert.equal(ledger.getRoom(created.id)?.workspace, root);
  const again = JSON.parse(await broker.call("room_init", {})) as { id: string };
  assert.equal(again.id, created.id);
  const status = JSON.parse(await broker.call("room_status", {})) as { chainValid: boolean };
  assert.equal(status.chainValid, true);
  const posted = JSON.parse(
    await broker.call("room_post", { author: "you", text: "改 passkey 的提案在這" }),
  ) as { seq: number };
  assert.equal(posted.seq, 2);
  const read = JSON.parse(await broker.call("room_read", { after: 1 })) as {
    messages: Array<{ seq: number; author: string }>;
  };
  assert.deepEqual(read.messages.map((item) => item.author), ["you"]);
  const got = JSON.parse(await broker.call("room_get", { from: 2, to: 2 })) as {
    messages: Array<{ text: string }>;
  };
  assert.match(got.messages[0]?.text ?? "", /passkey/u);
  const found = JSON.parse(await broker.call("room_search", { query: "passkey" })) as {
    messages: Array<{ seq: number }>;
  };
  assert.equal(found.messages[0]?.seq, 2);
  await assert.rejects(broker.call("room_post", { author: "you" }), /INVALID_ROOM_MESSAGE/u);
  await assert.rejects(
    broker.call("room_post", { author: "you", text: "@claude 請真正回應" }),
    /ROOM_POST_MENTION_REQUIRES_ROOM_MENTION/u,
  );
  assert.equal(ledger.listAfter(created.id, posted.seq).length, 0);
  await assert.rejects(
    broker.call("room_post", { author: "you", text: "x", extra: 1 }),
    /UNKNOWN_ROOM_POST_ARGUMENT/u,
  );
  await assert.rejects(broker.call("room_get", { from: 1, to: 900 }), /INVALID_ROOM_RANGE/u);
});

test("exact-seat MCP tools wait, acknowledge, and reply without provider fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-seat-root-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-seat-data-"));
  const ledger = new RoomLedger(data);
  const inbox = new RoomInboxStore(data);
  t.after(() => inbox.close());
  t.after(() => ledger.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  ledger.createRoom("demo", root);
  const firstSeat = "11111111-1111-4111-8111-111111111111";
  const secondSeat = "22222222-2222-4222-8222-222222222222";
  const calls: string[] = [];
  const makeBroker = (presenceId: string, actor: string) => new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([root]),
    hardLimits: DEFAULT_HARD_LIMITS,
    invoke: async () => { calls.push("provider"); throw new Error("PROVIDER_MUST_NOT_RUN"); },
    ledger,
    inbox,
    resolvePresenceId: () => presenceId,
    resolveActor: () => actor,
  });
  const broker = makeBroker(firstSeat, "codex（外接）");
  assert.deepEqual(
    broker.tools().slice(-4).map((tool) => tool.name),
    ["room_wait", "room_ack", "room_reply", "room_fail"],
  );
  const mention = ledger.append("demo", "you", "@codex（外接） 請處理任務");
  inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "codex（外接）" });
  const waited = JSON.parse(await broker.call("room_wait", { room: "demo", timeoutMs: 100 })) as {
    timeout: boolean;
    delivery: { id: string; leaseToken: string; message: { seq: number } };
  };
  assert.equal(waited.timeout, false);
  assert.equal(waited.delivery.message.seq, mention.seq);
  const intruder = makeBroker(secondSeat, "codex（另一席）");
  await assert.rejects(
    intruder.call("room_ack", {
      deliveryId: waited.delivery.id,
      leaseToken: waited.delivery.leaseToken,
      phase: "read",
    }),
    /DELIVERY_ACTOR_MISMATCH/u,
  );
  await broker.call("room_ack", { deliveryId: waited.delivery.id, leaseToken: waited.delivery.leaseToken, phase: "read" });
  await broker.call("room_ack", { deliveryId: waited.delivery.id, leaseToken: waited.delivery.leaseToken, phase: "working" });
  const replied = JSON.parse(await broker.call("room_reply", {
    deliveryId: waited.delivery.id,
    leaseToken: waited.delivery.leaseToken,
    text: "任務完成",
  })) as { delivery: { state: string }; reply: { author: string } };
  assert.equal(replied.delivery.state, "replied");
  assert.equal(replied.reply.author, "codex（外接）");
  assert.deepEqual(calls, []);
});

test("MCP exact terminal seats discover, send, await, and continue threads directly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-peer-mcp-root-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-peer-mcp-data-"));
  const codexService = new CollaborationService(data);
  const claudeService = new CollaborationService(data);
  t.after(() => codexService.close());
  t.after(() => claudeService.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  codexService.ledger.createRoom("demo", root);
  const codex = codexService.registerExternal({ provider: "codex", workspace: root, hostPid: 7301 });
  const claude = claudeService.registerExternal({ provider: "claude", workspace: root, hostPid: 7302 });
  for (const seat of [codex, claude]) {
    codexService.requestExternalJoin(seat.id, "demo", root);
    codexService.approveExternalJoin({
      presenceId: seat.id,
      roomId: "demo",
      workspace: root,
      collaborationMode: "room-first",
      syncTurns: false,
      label: seat.provider,
    });
    codexService.requestExternalStandby(seat.id, "demo", root);
    codexService.approveExternalStandby(seat.id, "demo", root);
  }
  const providerCalls: string[] = [];
  const makeBroker = (service: CollaborationService, presenceId: string) => new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([root]),
    hardLimits: DEFAULT_HARD_LIMITS,
    invoke: async () => {
      providerCalls.push("provider");
      throw new Error("PROVIDER_MUST_NOT_RUN");
    },
    ledger: service.ledger,
    collaboration: service,
    resolvePresenceId: () => presenceId,
    resolveActor: (roomId) => service.externalActor(presenceId, roomId),
    resolveSessionRoom: () => {
      const current = service.presence.get(presenceId)!;
      return {
        roomId: current.roomId!,
        workspace: current.workspace,
        actor: current.displayName!,
        collaborationMode: current.collaborationMode!,
        syncTurns: current.syncTurns!,
      };
    },
  });
  const codexBroker = makeBroker(codexService, codex.id);
  const claudeBroker = makeBroker(claudeService, claude.id);
  assert.deepEqual(
    codexBroker.tools().slice(-6).map((tool) => tool.name),
    ["room_send", "room_await_reply", "room_wait", "room_ack", "room_reply", "room_fail"],
  );
  const agents = JSON.parse(await codexBroker.call("list_agents", {})) as {
    terminalSeats: Array<{
      id: string;
      displayName: string;
      self: boolean;
      executionClass: string;
      capabilityAuthority: string;
      hostCapabilities: string;
    }>;
  };
  assert.deepEqual(agents.terminalSeats.map((seat) => seat.id), [codex.id, claude.id]);
  assert.equal(agents.terminalSeats.find((seat) => seat.id === codex.id)?.self, true);
  assert.ok(agents.terminalSeats.every((seat) => seat.executionClass === "native-full-trust"));
  assert.ok(agents.terminalSeats.every((seat) => seat.capabilityAuthority === "host"));
  assert.ok(agents.terminalSeats.every((seat) => seat.hostCapabilities === "unchanged"));

  const sent = JSON.parse(await codexBroker.call("room_send", {
    targetPresenceId: claude.id,
    clientRequestId: randomUUID(),
    text: "請直接檢查這個修正",
    taskId: "peer-task",
  })) as { delivery: { id: string; threadId: string; sourcePresenceId: string } };
  assert.equal(sent.delivery.sourcePresenceId, codex.id);
  const claimed = JSON.parse(await claudeBroker.call("room_wait", {
    room: "demo", timeoutMs: 100,
  })) as { delivery: { id: string; leaseToken: string; threadId: string; sourcePresenceId: string } };
  assert.equal(claimed.delivery.threadId, sent.delivery.threadId);
  assert.equal(claimed.delivery.sourcePresenceId, codex.id);
  await claudeBroker.call("room_ack", {
    deliveryId: claimed.delivery.id, leaseToken: claimed.delivery.leaseToken, phase: "read",
  });
  await claudeBroker.call("room_ack", {
    deliveryId: claimed.delivery.id, leaseToken: claimed.delivery.leaseToken, phase: "working",
  });
  await claudeBroker.call("room_reply", {
    deliveryId: claimed.delivery.id,
    leaseToken: claimed.delivery.leaseToken,
    text: "我已直接檢查，建議補測試",
  });
  const outcome = JSON.parse(await codexBroker.call("room_await_reply", {
    deliveryId: sent.delivery.id,
    timeoutMs: 100,
  })) as { timeout: boolean; reply: { author: string } };
  assert.equal(outcome.timeout, false);
  assert.equal(outcome.reply.author, "claude（claude）");
  const sendAndWait = codexBroker.call("room_send", {
    targetPresenceId: claude.id,
    clientRequestId: randomUUID(),
    text: "請直接回覆第二輪",
    threadId: sent.delivery.threadId,
    replyToDeliveryId: sent.delivery.id,
    taskId: "peer-task",
    waitForReplyMs: 1_000,
  });
  const secondClaim = JSON.parse(await claudeBroker.call("room_wait", {
    room: "demo", timeoutMs: 100,
  })) as { delivery: { id: string; leaseToken: string } };
  await claudeBroker.call("room_ack", {
    deliveryId: secondClaim.delivery.id, leaseToken: secondClaim.delivery.leaseToken, phase: "read",
  });
  await claudeBroker.call("room_ack", {
    deliveryId: secondClaim.delivery.id, leaseToken: secondClaim.delivery.leaseToken, phase: "working",
  });
  await claudeBroker.call("room_reply", {
    deliveryId: secondClaim.delivery.id,
    leaseToken: secondClaim.delivery.leaseToken,
    text: "第二輪已直接回覆",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const combined = JSON.parse(await sendAndWait) as {
    replyWait: { timeout: boolean; reply: { author: string } };
  };
  assert.equal(combined.replyWait.timeout, false);
  assert.equal(combined.replyWait.reply.author, "claude（claude）");

  const leftPending = JSON.parse(await codexBroker.call("room_send", {
    targetPresenceId: claude.id,
    clientRequestId: randomUUID(),
    text: "這一則刻意測 transport timeout",
  })) as { delivery: { id: string } };
  const timeoutPromise = codexBroker.call("room_await_reply", {
    deliveryId: leftPending.delivery.id,
    timeoutMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(JSON.parse(await timeoutPromise), { timeout: true });
  const resumed = JSON.parse(await claudeBroker.call("room_wait", {
    room: "demo", timeoutMs: 100,
  })) as { delivery: { id: string; leaseToken: string } };
  assert.equal(resumed.delivery.id, leftPending.delivery.id);
  await claudeBroker.call("room_ack", {
    deliveryId: resumed.delivery.id, leaseToken: resumed.delivery.leaseToken, phase: "read",
  });
  await claudeBroker.call("room_ack", {
    deliveryId: resumed.delivery.id, leaseToken: resumed.delivery.leaseToken, phase: "working",
  });
  await claudeBroker.call("room_reply", {
    deliveryId: resumed.delivery.id,
    leaseToken: resumed.delivery.leaseToken,
    text: "逾時後仍可重新接續",
  });
  const resumedOutcome = JSON.parse(await codexBroker.call("room_await_reply", {
    deliveryId: leftPending.delivery.id,
    timeoutMs: 100,
  })) as { timeout: boolean; delivery: { state: string } };
  assert.equal(resumedOutcome.timeout, false);
  assert.equal(resumedOutcome.delivery.state, "replied");
  await assert.rejects(
    codexBroker.call("room_send", {
      targetPresenceId: "claude",
      clientRequestId: randomUUID(),
      text: "不可 fallback",
    }),
    /INVALID_TARGET_PRESENCE_ID/u,
  );
  await assert.rejects(
    codexBroker.call("room_send", {
      targetPresenceId: claude.id,
      clientRequestId: "retry-me",
      text: "idempotency key 必須是 UUID",
    }),
    /INVALID_CLIENT_REQUEST_ID/u,
  );
  await assert.rejects(
    codexBroker.call("room_send", {
      targetPresenceId: claude.id,
      clientRequestId: randomUUID(),
      text: "不可冒名",
      author: "you",
    }),
    /UNKNOWN_ROOM_SEND_ARGUMENT/u,
  );
  for (const invalid of [
    { targetPresenceId: claude.id, clientRequestId: randomUUID(), text: "x", threadId: "bad" },
    { targetPresenceId: claude.id, clientRequestId: randomUUID(), text: "x", threadId: sent.delivery.threadId },
    { targetPresenceId: claude.id, clientRequestId: randomUUID(), text: "x", replyToDeliveryId: "bad" },
    { targetPresenceId: claude.id, clientRequestId: randomUUID(), text: "x", replyToDeliveryId: sent.delivery.id },
    { targetPresenceId: claude.id, clientRequestId: randomUUID(), text: "x", taskId: "" },
    { targetPresenceId: claude.id, clientRequestId: randomUUID(), text: "x", waitForReplyMs: 0 },
  ]) {
    await assert.rejects(
      codexBroker.call("room_send", invalid),
      /INVALID_THREAD_ID|THREAD_CONTINUATION_FIELDS_MISMATCH|INVALID_REPLY_TO_DELIVERY_ID|INVALID_DELIVERY_TASK_ID|INVALID_ROOM_REPLY_WAIT_TIMEOUT/u,
    );
  }
  await assert.rejects(
    codexBroker.call("room_await_reply", { deliveryId: "bad" }),
    /INVALID_DELIVERY_ID/u,
  );
  await assert.rejects(
    codexBroker.call("room_await_reply", { deliveryId: sent.delivery.id, timeoutMs: 0 }),
    /INVALID_ROOM_REPLY_WAIT_TIMEOUT/u,
  );
  assert.deepEqual(providerCalls, []);
});

test("MCP notifications/cancelled abort an in-flight room_wait and clear wakeable state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-cancel-root-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-cancel-data-"));
  const ledger = new RoomLedger(data);
  const inbox = new RoomInboxStore(data);
  t.after(() => inbox.close());
  t.after(() => ledger.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  ledger.createRoom("demo", root);
  const presenceId = "11111111-1111-4111-8111-111111111111";
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([root]),
    hardLimits: DEFAULT_HARD_LIMITS,
    ledger,
    inbox,
    resolvePresenceId: () => presenceId,
    resolveActor: () => "codex（外接）",
  });
  const inflight = new Map<string, AbortController>();
  const emitted: Array<Record<string, unknown>> = [];
  const pending = handleCollabMcpMessage(broker, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "room_wait", arguments: { room: "demo", timeoutMs: 1_000 } },
  }, inflight, (value) => emitted.push(value));
  for (let attempt = 0; attempt < 20 && !inbox.isListening(presenceId, "demo"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(inbox.isListening(presenceId, "demo"), true);
  await handleCollabMcpMessage(broker, {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7, reason: "owner cancelled" },
  }, inflight, (value) => emitted.push(value));
  await pending;
  assert.equal(inbox.isListening(presenceId, "demo"), false);
  assert.equal(inflight.size, 0);
  assert.match(String((emitted[0]?.error as { message?: string } | undefined)?.message), /ROOM_WAIT_CANCELLED/u);
});

test("MCP transport returns bounded protocol metadata and ignores notifications", async (t) => {
  const { broker, cleanup } = await fixture();
  t.after(cleanup);
  const inflight = new Map<string, AbortController>();
  const emitted: Array<Record<string, unknown>> = [];
  const emit = (value: Record<string, unknown>): number => emitted.push(value);

  await handleCollabMcpMessage(
    broker,
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    inflight,
    emit,
  );
  await handleCollabMcpMessage(
    broker,
    { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "test-version" } },
    inflight,
    emit,
  );
  await handleCollabMcpMessage(broker, { jsonrpc: "2.0", id: 2, method: "ping" }, inflight, emit);
  await handleCollabMcpMessage(broker, { jsonrpc: "2.0", id: 3, method: "tools/list" }, inflight, emit);
  await handleCollabMcpMessage(
    broker,
    { jsonrpc: "2.0", method: "notifications/progress", params: null },
    inflight,
    emit,
  );
  await handleCollabMcpMessage(broker, { jsonrpc: "2.0", id: 4, method: "unknown" }, inflight, emit);

  assert.equal((emitted[0]?.result as { protocolVersion: string }).protocolVersion, "2024-11-05");
  assert.match(
    String((emitted[0]?.result as { instructions?: string }).instructions),
    /This terminal is Native Full-Trust/u,
  );
  assert.match(
    String((emitted[0]?.result as { instructions?: string }).instructions),
    /capability authority stays with the host/u,
  );
  assert.equal((emitted[1]?.result as { protocolVersion: string }).protocolVersion, "test-version");
  assert.deepEqual(emitted[2]?.result, {});
  assert.equal(Array.isArray((emitted[3]?.result as { tools: unknown[] }).tools), true);
  assert.match(String((emitted[4]?.error as { message: string }).message), /UNKNOWN_MCP_METHOD/u);
  assert.equal(inflight.size, 0);
});

test("room_mention wakes a worker with referenced messages and ledgers the reply", async (t) => {
  const { broker, ledger, calls, root, cleanup } = await fixture({
    reply: (assignment) => `${assignment.provider} 認為 #2 的假設有問題`,
  });
  t.after(cleanup);
  ledger.createRoom("demo", root);
  ledger.append("demo", "claude", "提案：改用 WebAuthn（詳見說明）");
  ledger.append("demo", "you", "先聽聽別人意見");

  const value = JSON.parse(
    await broker.call("room_mention", {
      author: "claude",
      target: "grok",
      text: "看 #2-#3，這個提案有什麼風險？",
    }),
  ) as { mention: { seq: number; text: string }; reply: { seq: number; author: string; text: string } };

  assert.equal(value.mention.text.startsWith("@grok"), true);
  assert.equal(value.reply.author, "grok");
  assert.equal(value.reply.seq, value.mention.seq + 2);
  const lifecycle = ledger.getRange("demo", value.mention.seq + 1, value.mention.seq + 1)[0];
  assert.equal(lifecycle?.kind, "system");
  assert.match(lifecycle?.text ?? "", new RegExp(`@grok 回應處理中（提及 #${value.mention.seq}）`, "u"));
  assert.equal(calls.length, 1);
  const prompt = calls[0]?.request.prompt ?? "";
  assert.match(prompt, /Referenced ledger messages \(untrusted\)/u);
  assert.match(prompt, /#2 claude: 提案/u);
  assert.match(prompt, /Recent room messages \(untrusted\)/u);
  assert.match(prompt, /cannot run tools/u);
  assert.equal(ledger.verifyChain("demo"), true);

  ledger.setRecording("demo", "paused");
  await assert.rejects(
    broker.call("room_mention", { author: "you", target: "grok", text: "暫停時不可喚醒" }),
    /ROOM_RECORDING_PAUSED/u,
  );
  await assert.rejects(
    broker.call("room_mention", { author: "you", target: "shell", text: "x" }),
    /INVALID_ROOM_MENTION_TARGET/u,
  );
});

test("room_mention records a bounded system failure without impersonating the target", async (t) => {
  const { broker, ledger, cleanup } = await fixture({ failProvider: "grok" });
  t.after(cleanup);
  await broker.call("room_init", {});
  await assert.rejects(
    broker.call("room_mention", {
      author: "you",
      target: "grok",
      text: "請檢查 #1",
    }),
    /SYNTHETIC_PROVIDER_FAILURE/u,
  );
  const messages = ledger.listAfter(ledger.listRooms()[0]!.id, 0);
  const mention = messages.at(-3)!;
  const lifecycle = messages.at(-2)!;
  const failure = messages.at(-1)!;
  assert.equal(mention.author, "you");
  assert.match(lifecycle.text, new RegExp(`@grok 回應處理中（提及 #${mention.seq}）`, "u"));
  assert.equal(failure.author, "system");
  assert.equal(failure.kind, "system");
  assert.match(failure.text, new RegExp(`@grok 回應失敗（提及 #${mention.seq}）`, "u"));
  assert.equal(messages.some((message) => message.author === "grok"), false);
  assert.equal(ledger.verifyChain(ledger.listRooms()[0]!.id), true);
});

test("room_mention supports bounded caller cancellation and records it", async (t) => {
  const base = await fixture();
  t.after(base.cleanup);
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  let abortObserved = false;
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([base.root]),
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (_assignment, request) => await new Promise<ProviderResult>((_resolve, reject) => {
      started();
      request.signal?.addEventListener("abort", () => {
        abortObserved = true;
        reject(new Error("PROVIDER_TERMINATED:cancelled"));
      }, { once: true });
    }),
    ledger: base.ledger,
  });
  await broker.call("room_init", {});
  const controller = new AbortController();
  let mentionSeq = 0;
  const pending = broker.call("room_mention", {
    author: "you",
    target: "codex",
    text: "請稍後回覆",
  }, {
    signal: controller.signal,
    onRoomMention: (mention) => { mentionSeq = mention.seq; },
  });
  await providerStarted;
  controller.abort();
  await assert.rejects(pending, /ROOM_MENTION_CANCELLED/u);
  const messages = base.ledger.listAfter(base.ledger.listRooms()[0]!.id, 0);
  assert.equal(abortObserved, true);
  assert.ok(mentionSeq > 0);
  assert.match(messages.at(-1)?.text ?? "", new RegExp(`@codex 回應已取消（提及 #${mentionSeq}）`, "u"));
  assert.equal(messages.some((message) => message.author === "codex"), false);
});

test("a fixed room actor cannot be spoofed by tool arguments", async (t) => {
  const base = await fixture();
  t.after(base.cleanup);
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([base.root]),
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => providerResult(assignment, request, "ok"),
    ledger: base.ledger,
    actor: "claude",
  });
  await broker.call("room_init", {});
  const posted = JSON.parse(await broker.call("room_post", { text: "固定身分" })) as { author: string };
  assert.equal(posted.author, "claude");
  const matching = JSON.parse(
    await broker.call("room_post", { author: "claude", text: "同一身分可明示" }),
  ) as { author: string };
  assert.equal(matching.author, "claude");
  await assert.rejects(
    broker.call("room_post", { author: "codex", text: "冒名" }),
    /ROOM_ACTOR_MISMATCH/u,
  );
});

test("an MCP room actor cannot post until the owner joins that exact session", async (t) => {
  const base = await fixture();
  t.after(base.cleanup);
  let joined = false;
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([base.root]),
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    ledger: base.ledger,
    resolveActor: () => {
      if (!joined) throw new Error("PRESENCE_NOT_JOINED");
      return "codex（前端 2）";
    },
  });
  await broker.call("room_init", {});
  await assert.rejects(broker.call("room_post", { text: "尚未加入" }), /PRESENCE_NOT_JOINED/u);
  joined = true;
  const posted = JSON.parse(await broker.call("room_post", { text: "加入後發言" })) as { author: string };
  assert.equal(posted.author, "codex（前端 2）");
  const legacyProvider = JSON.parse(
    await broker.call("room_post", { author: "codex", text: "舊版 provider 名稱會映射回本席位" }),
  ) as { author: string };
  assert.equal(legacyProvider.author, "codex（前端 2）");
  await assert.rejects(
    broker.call("room_post", { author: "claude", text: "不可冒用其他 provider" }),
    /ROOM_ACTOR_MISMATCH/u,
  );
});

test("worker context failures degrade to a bounded answer without widening access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-collab-context-fail-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const calls: ProviderRequest[] = [];
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([root]),
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => {
      calls.push(request);
      return providerResult(assignment, request, "bounded");
    },
    contextFactory: () => ({
      fileTree: async () => { throw new Error("TREE_FAILED"); },
      readFiles: async () => { throw new Error("READ_FAILED"); },
    }),
  });
  await broker.call("ask_codex", { question: "仍可回答", files: ["README.md"] });
  assert.doesNotMatch(calls[0]?.prompt ?? "", /TREE_FAILED|READ_FAILED/u);
  assert.match(calls[0]?.prompt ?? "", /Question: 仍可回答/u);
});

test("collab call ceiling is enforced and never resets", async (t) => {
  const { broker, cleanup } = await fixture({ maxProviderCalls: 2 });
  t.after(cleanup);
  await broker.call("ask_claude", { question: "one" });
  await broker.call("ask_codex", { question: "two" });
  await assert.rejects(broker.call("ask_grok", { question: "three" }), /COLLAB_CALL_LIMIT_REACHED/u);
  assert.deepEqual(broker.status(), { calls: 2, maxCalls: 2 });
});
