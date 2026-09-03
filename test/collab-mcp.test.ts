import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

/*
 * A seat registered here is scaffolding, not the thing under test. The production presence lease is
 * 15s (`DEFAULT_LEASE_MS`) and an expired seat is pruned, so a test whose setup runs long — on a
 * loaded machine, git and worktree work easily does — loses its seat and fails at whatever it asked
 * for next, reporting PRESENCE_NOT_FOUND instead of the thing it was asserting. Measured: inserting
 * a deliberate 16s wait before the merge-request assertion reproduces exactly that, every time.
 *
 * The lease is therefore made long enough that elapsed time cannot decide the outcome. This removes
 * no coverage: `room-presence.test.ts` asserts lease and prune behaviour directly, with an injected
 * clock, which is where a test that is actually about expiry belongs.
 */
function collaborationService(data: string): CollaborationService {
  return new CollaborationService(data, { presence: { leaseMs: 120_000 } });
}


const execFileAsync = promisify(execFile);
/** One fresh durable idempotency key per logical candidate call. */
const key = (): string => randomUUID();

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
  /* Wire a collaboration service, which is what produces the join briefing. Off by default so the
     existing tests keep their narrow surface. */
  withCollaboration?: boolean;
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
  const collaboration = options.withCollaboration ? collaborationService(data) : undefined;
  let fixtureSeat: { id: string } | undefined;
  if (collaboration) {
    collaboration.ledger.createRoom("demo", workspaces.roots()[0]!.path);
    fixtureSeat = collaboration.registerExternal({
      provider: "codex", workspace: workspaces.roots()[0]!.path, hostPid: 8_101,
    });
    collaboration.requestExternalJoin(fixtureSeat.id, "demo", workspaces.roots()[0]!.path);
    collaboration.approveExternalJoin({
      presenceId: fixtureSeat.id, roomId: "demo", workspace: workspaces.roots()[0]!.path,
      label: "fixture", collaborationMode: "room-first", syncTurns: true,
    });
  }
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
    /*
     * A collaboration service AND the seat wiring that makes it usable. Supplying only the service
     * left `#seatInbox()` throwing, so every seat-scoped path -- the briefing's seat list, the
     * undeclared-start note -- silently did nothing and a test could assert against an empty result
     * without noticing the feature had not run.
     */
    ...(collaboration
      ? {
          collaboration,
          resolvePresenceId: () => fixtureSeat!.id,
          resolveActor: (roomId: string) => collaboration.externalActor(fixtureSeat!.id, roomId),
        }
      : {}),
    workflowRequests,
    ...(options.requestRoomJoin ? { requestRoomJoin: options.requestRoomJoin } : {}),
    ...(options.waitForRoomJoin ? { waitForRoomJoin: options.waitForRoomJoin } : {}),
    ...(options.cancelRoomJoin ? { cancelRoomJoin: options.cancelRoomJoin } : {}),
    ...(options.sessionRoomMode
      ? {
          resolveSessionRoom: () => ({
            roomId: "demo",
            workspace: workspaces.roots()[0]!.path,
            /*
             * Resolved the way production resolves it, not a literal. `actor: "codex1"` modelled a
             * state the product cannot produce -- the binding and `#resolveActor` both read
             * `agent_presence.display_name`, so they never disagree in a running system. A fixture
             * that made them disagree left the `ask_*`-failed-after-writing path with no possible
             * test, and set a trap: the first person to write that test would get a red bar and the
             * quickest way out would be to loosen the assertion.
             */
            actor: collaboration && fixtureSeat
              ? collaboration.externalActor(fixtureSeat.id, "demo")
              : "codex1",
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
      /* The collaboration service opens its own SQLite handles. Closing only the ledger and the
         request store left one whole set open per test that asked for one, and then removed the
         directory underneath them. */
      collaboration?.close();
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
      "room_start",
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

/*
 * The half of this feature that faces the joining agent, and it had no test at all: deleting the
 * briefing and the whole mustAnswer block from the join response left the suite green.
 *
 * What it is for: a capability declaration answers "what may I do here", not "what is already
 * happening here", and an agent with only the first either takes over a thread someone else is
 * running or rebuilds something the room already settled.
 */
/*
 * Two properties of the undeclared-start note that only hold because it is written at the dispatch,
 * after the tool returns, rather than inside each handler before the work:
 *
 *   - a REFUSED action leaves nothing, because nothing was done;
 *   - `ask_*` leaves one, because it reaches the same #callRoomWorker as room_mention -- one effect
 *     with two entry points, and instrumenting handlers one at a time missed the second.
 *
 * Both need a seat with no note yet, so they cannot be checked inside a test that has already
 * triggered one: the note is written once per seat per session, and a second attempt is a no-op
 * whether or not the code is correct.
 */
test("the undeclared-start note follows the work, not the attempt", async (t) => {
  const { broker, ledger, cleanup } = await fixture({
    requestRoomJoin: () => undefined,
    waitForRoomJoin: async () => true,
    withCollaboration: true,
    sessionRoomMode: "room-first",
  });
  t.after(cleanup);
  const notes = () => ledger.listAfter("demo", 0)
    .filter((message: { text: string }) => String(message.text).includes("還沒說明")).length;
  assert.equal(notes(), 0);

  // Refused before it does anything: no work happened, so nothing is recorded about having worked.
  await assert.rejects(broker.call("room_post", { author: "codex", text: "@codex 這會被擋下來" }), /ROOM_POST_MENTION_REQUIRES_ROOM_MENTION/u);
  assert.equal(notes(), 0, "a refused action must not be recorded as having acted");

  // Succeeds: recorded once.
  await broker.call("room_post", { author: "codex", text: "我先發了一則" });
  assert.equal(notes(), 1);
  await broker.call("room_post", { author: "codex", text: "再發一則" });
  assert.equal(notes(), 1, "once per seat per session, not once per action");
});

/*
 * `ask_*` reaches the same #callRoomWorker as `room_mention` in a bound room -- one effect, two entry
 * points. Instrumenting handlers one at a time covered the second and missed the first, while the
 * join response promised both. This is the entry point that was missed, on its own, so a regression
 * cannot hide behind the one that was not.
 */
test("asking a provider counts as starting work", async (t) => {
  const { broker, ledger, cleanup } = await fixture({
    withCollaboration: true,
    sessionRoomMode: "room-first",
  });
  t.after(cleanup);
  const notes = () => ledger.listAfter("demo", 0)
    .filter((message: { text: string }) => String(message.text).includes("還沒說明")).length;
  assert.equal(notes(), 0);
  await broker.call("ask_codex", { question: "幫我看一下這段" });
  assert.equal(notes(), 1, "ask_* starts work, so it is recorded like every other way of starting it");
});

test("joining hands back what the room is in the middle of, and the question that has to be answered", async (t) => {
  /* Wired with a collaboration service, because that is what produces the briefing -- and because a
     fixture without one is exactly how this path stayed untested: the response quietly omits the
     briefing rather than failing, so a test that did not supply one would have asserted nothing. */
  const { broker, ledger, cleanup } = await fixture({
    requestRoomJoin: () => undefined,
    waitForRoomJoin: async () => true,
    withCollaboration: true,
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });
  for (let i = 1; i <= 6; i += 1) ledger.append("demo", "you", `先前的第 ${i} 則`);

  const joined = JSON.parse(await broker.call("room_join_request", { room: "demo" })) as {
    joined: boolean;
    briefing?: { totalMessages: number; shown: number; recent: Array<{ seq: number }>; seats: unknown[]; writing: unknown[] };
    mustAnswer?: { question: string; options: Array<{ mode: string; meaning: string }>; how: string; ifYouSkipIt: string; thenWhat: string };
  };
  assert.equal(joined.joined, true);

  // The briefing, and the denominator that stops the slice reading as the whole room.
  assert.ok(joined.briefing, "joining must hand back what the room is in the middle of");
  /* The seat list was permanently empty behind a passing test, because the fixture supplied a
     collaboration service without the wiring that fills it. The fixture supplies both now, so this
     asserts the list rather than merely its type -- the previous round made it reachable, which is
     not the same as covered. */
  assert.ok(
    (joined.briefing?.seats.length ?? 0) >= 1,
    "the briefing must name who is in the room, not just how many messages there are",
  );
  assert.equal(joined.briefing?.shown, joined.briefing?.recent.length);
  assert.ok((joined.briefing?.totalMessages ?? 0) >= (joined.briefing?.shown ?? 0));
  assert.equal(joined.briefing?.recent[joined.briefing.recent.length - 1]?.seq, joined.briefing?.totalMessages,
    "and it must end at the newest message, not at an arbitrary window");

  // The fork. All five fields, because each answers a different question the agent actually has.
  assert.ok(joined.mustAnswer, "and the question that has to be answered before working");
  assert.deepEqual(joined.mustAnswer?.options.map((option) => option.mode), ["continue", "new-task"]);
  assert.match(String(joined.mustAnswer?.how), /room_start/u, "it must name the tool that answers it");
  assert.match(String(joined.mustAnswer?.ifYouSkipIt), /candidate/u,
    "and say which actions are recorded if it is skipped, rather than implying all of them are");
  assert.match(String(joined.mustAnswer?.thenWhat), /before the code/u,
    "reading order is the owner's rule; a ban on reading source is not");
  assert.doesNotMatch(String(joined.mustAnswer?.thenWhat), /Do not start reading/u);
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
  const gui = collaborationService(data);
  const mcp = collaborationService(data);
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

  // Standby with neither a timeout nor a cancellation signal is a loop with no exit at all, and since
  // the poll timer stopped being unref-ed it is also a loop that holds the process open. The MCP
  // request always supplies a signal, so this can only be reached by an in-process caller relying on
  // the `options = {}` default — which is exactly the caller that would not think to pass one.
  //
  // The two assertions above double as the ordering guard: this check has to stay BEHIND argument
  // validation, because when it sat in front of it, it silently swallowed
  // INVALID_ROOM_STANDBY_APPROVAL_TIMEOUT and the caller was told the wrong thing about their input.
  await assert.rejects(
    broker.call("room_wait", { room: "demo" }),
    /ROOM_WAIT_NEEDS_CANCELLATION/u,
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
  const codexService = collaborationService(data);
  const claudeService = collaborationService(data);
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
    codexBroker.tools().slice(-12).map((tool) => tool.name),
    [
      "room_send", "room_await_reply", "candidate_start", "candidate_checkpoint",
      "candidate_complete", "candidate_status", "main_merge_preview", "main_merge_request",
      "room_wait", "room_ack", "room_reply", "room_fail",
    ],
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

  /*
   * Saying which of the two things this seat is here to do. The tool exists because the alternative --
   * an agent that never distinguishes "pick up what is running" from "start something beside it" --
   * produces either a hijacked thread or a rebuilt wheel, and neither is visible until it is expensive.
   */
  const startTool = codexBroker.tools().find((tool) => tool.name === "room_start");
  assert.ok(startTool, "the fork has to be answerable, not only asked");
  // The tool must not claim to gate anything: nothing downstream refuses work from a seat that skipped
  // it, and a description that implied otherwise would be the usual defect in its purest form.
  assert.match(String(startTool?.description ?? ""), /Nothing forces you to call it/u);
  /*
   * Names the tools it actually covers. The first version asserted a generic "records that you acted",
   * which was true of one path -- room_send -- and false of the one that matters most, a seat that
   * opens a worktree before saying anything. The assertion protected the sentence's existence rather
   * than its truth, which is how a test turns an overclaim into a specification.
   */
  for (const covered of [/candidate/u, /post/u, /mention/u, /another seat/u]) {
    assert.match(String(startTool?.description ?? ""), covered);
  }
  assert.match(String(startTool?.description ?? ""), /records once/u,
    "one line per seat per session, not a column");

  const declared = JSON.parse(await codexBroker.call("room_start", {
    mode: "new-task", note: "改一段跟現有討論無關的樣式",
  })) as { mode: string; alreadyDeclared: boolean; ledgerSeq: number; next: string };
  assert.equal(declared.mode, "new-task");
  assert.equal(declared.alreadyDeclared, false);
  /*
   * The owner's rule is about ORDER and about who resolves a contradiction -- read the room first, and
   * bring a disagreement between ledger and code to them -- not a ban on reading source. An earlier
   * version of this text said "do not start reading the codebase on your own initiative", which would
   * stop an agent that had already been given a task.
   */
  assert.match(declared.next, /Read the room before the code/u);
  assert.match(declared.next, /owner/u, "and a contradiction is resolved by the owner, not by the agent");
  assert.doesNotMatch(declared.next, /Do not start reading/u);

  const dividerLine = codexService.ledger.getRange("demo", declared.ledgerSeq, declared.ledgerSeq)[0];
  assert.match(String(dividerLine?.text), /開始新任務/u);
  assert.match(String(dividerLine?.text), /──/u, "a new task writes a divider a later reader can see");

  // Answering again with the same words is the same answer, not a second divider.
  const again = JSON.parse(await codexBroker.call("room_start", {
    mode: "new-task", note: "改一段跟現有討論無關的樣式",
  })) as { alreadyDeclared: boolean; ledgerSeq: number };
  assert.equal(again.alreadyDeclared, true);
  assert.equal(again.ledgerSeq, declared.ledgerSeq);

  /*
   * Changing your mind is allowed, and is its own line.
   *
   * A single key per session made the same answer dedupe and a CHANGED one throw
   * ROOM_IDEMPOTENCY_CONFLICT -- an opaque code, reaching the agent on the most natural sequence
   * there is: declare one thing, read the briefing, realise it is the other. The flow this feature
   * exists to support was the flow it refused.
   */
  const changed = JSON.parse(await codexBroker.call("room_start", {
    mode: "continue", note: "看完帳本後改成接續原本那條",
  })) as { mode: string; alreadyDeclared: boolean; ledgerSeq: number };
  assert.equal(changed.mode, "continue");
  assert.equal(changed.alreadyDeclared, true, "the seat had answered before; this is a revision");
  assert.notEqual(changed.ledgerSeq, declared.ledgerSeq, "and the revision is its own line");
  assert.match(
    String(codexService.ledger.getRange("demo", changed.ledgerSeq, changed.ledgerSeq)[0]?.text),
    /接續房間現有的工作/u,
  );
  // Both stay on the record: "they started out splitting off and then rejoined" is the thing a later
  // reader needs, and neither line is rewritten.
  assert.match(
    String(codexService.ledger.getRange("demo", declared.ledgerSeq, declared.ledgerSeq)[0]?.text),
    /開始新任務/u,
  );

  // Binding and membership are fail-closed, and both are asserted rather than assumed.
  await assert.rejects(
    codexBroker.call("room_start", { mode: "continue", room: "another-room" }),
    /ROOM_START_BINDING_MISMATCH/u,
  );
  await assert.rejects(
    codexBroker.call("room_start", { mode: "sideways" }),
    /INVALID_ROOM_START_MODE/u,
  );
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
  })) as { delivery: { id: string }; dispatch: { wakeable: boolean; immediate: boolean; note: string } };

  /*
   * The target is between waits here, so this is the case the sender most needs told: the delivery
   * queued and nobody is holding it. `wakeable: false` already said so, in a place a sender has to
   * know this codebase to read. The note says the consequence in the sender's own terms, and it has
   * to include the part that is easy to get wrong -- that nothing can wake the seat from here, so
   * blocking on a reply is a choice to wait on something that may never come.
   */
  assert.equal(leftPending.dispatch.wakeable, false);
  assert.match(leftPending.dispatch.note, /NOT listening/u);
  assert.match(leftPending.dispatch.note, /queued/u, "the sender must be told the work is waiting, not lost");
  assert.match(leftPending.dispatch.note, /room_wait/u, "and what will actually deliver it");
  assert.match(leftPending.dispatch.note, /cannot push/u, "and that waking it from here is not an option");
  const timeoutPromise = codexBroker.call("room_await_reply", {
    deliveryId: leftPending.delivery.id,
    timeoutMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  /*
   * A bare { timeout: true } is exactly the shape of the owner's complaint -- work went out, nothing
   * came back, and no way to tell "busy" from "nobody was ever going to answer". The timeout has to
   * say which one it was, because the two call for opposite next moves.
   */
  const timedOut = JSON.parse(await timeoutPromise) as { timeout: boolean; targetListening?: boolean; note?: string };
  assert.equal(timedOut.timeout, true);
  assert.equal(timedOut.targetListening, false, "the target is between waits here, and the caller must be told");
  assert.match(String(timedOut.note), /NOT listening/u);
  assert.match(String(timedOut.note), /queued/u, "and that the work is waiting rather than lost");
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

test("native MCP candidate tools preserve main and end at an owner-required merge question", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-mcp-candidate-root-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-mcp-candidate-data-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "README.md"), "main\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", [
    "-c", "user.name=MCP Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial",
  ], { cwd: root });
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  service.ledger.createRoom("demo", root);
  const seat = service.registerExternal({ provider: "codex", workspace: root, hostPid: 7_909 });
  service.requestExternalJoin(seat.id, "demo", root);
  service.approveExternalJoin({
    presenceId: seat.id, roomId: "demo", workspace: root,
    collaborationMode: "room-first", syncTurns: false, label: "candidate",
  });
  const broker = new CollabToolBroker({
    providers: new ProviderRegistry([]),
    workspaces: WorkspacePolicy.fromPaths([root]),
    hardLimits: DEFAULT_HARD_LIMITS,
    invoke: async () => { throw new Error("PROVIDER_MUST_NOT_RUN"); },
    ledger: service.ledger,
    collaboration: service,
    resolvePresenceId: () => seat.id,
    resolveActor: (roomId) => service.externalActor(seat.id, roomId),
    resolveSessionRoom: () => ({
      roomId: "demo", workspace: root, actor: "codex（candidate）",
      collaborationMode: "room-first", syncTurns: false,
    }),
  });
  const mainHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const started = JSON.parse(await broker.call("candidate_start", {
    clientRequestId: key(),
    mainPath: root, task: "MCP lifecycle", acceptanceCriteria: "main untouched", room: "demo",
  })) as {
    candidate: { taskId: string; candidatePath: string };
    mainMutation: boolean;
    mainMutationScope: string;
    sharedGitMetadataMutation: boolean;
  };
  assert.equal(started.mainMutation, false);
  assert.equal(started.mainMutationScope, "canonical-main-branch-and-worktree");
  assert.equal(started.sharedGitMetadataMutation, true);

  /*
   * This seat opened a worktree without ever saying whether it was continuing the room's work or
   * starting something separate -- the highest-stakes version of skipping that question, and the one
   * the join response promises is recorded. It was the one path with no record while the promise was
   * already being made, so it needs a nail of its own.
   */
  const undeclaredLines = () => service.ledger.listAfter("demo", 0)
    .filter((message: { text: string }) => String(message.text).includes("還沒說明"));
  assert.equal(undeclaredLines().length, 1, "opening a candidate before answering must leave exactly one line");
  assert.match(String(undeclaredLines()[0]?.text), /先動手/u);

  /* The refused-action case needs a seat with no note yet, so it lives in its own test below --
     asserting it here proves nothing, because one line already exists and the note is written once. */
  await writeFile(join(started.candidate.candidatePath, "candidate.txt"), "candidate\n", "utf8");
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: started.candidate.candidatePath });
  await execFileAsync("git", [
    "-c", "user.name=MCP Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "candidate",
  ], { cwd: started.candidate.candidatePath });
  const checkpointed = JSON.parse(await broker.call("candidate_checkpoint", {
    clientRequestId: key(), taskId: started.candidate.taskId, summary: "committed",
  })) as { mainMutation: boolean; mainMutationScope: string; sharedGitMetadataMutation: boolean };
  assert.equal(checkpointed.mainMutation, false);
  assert.equal(checkpointed.mainMutationScope, "canonical-main-branch-and-worktree");
  assert.equal(checkpointed.sharedGitMetadataMutation, true);
  const completed = JSON.parse(await broker.call("candidate_complete", {
    clientRequestId: key(),
    taskId: started.candidate.taskId,
    summary: "ready",
    tests: [{ command: "node --test", status: "passed" }],
    knownRisks: ["synthetic"],
  })) as {
    completion: { mergeDecision: string; prompt: string; preview: { candidateHead: string } };
    mainMutation: boolean;
    mainMutationScope: string;
    sharedGitMetadataMutation: boolean;
  };
  assert.equal(completed.mainMutation, false);
  assert.equal(completed.mainMutationScope, "canonical-main-branch-and-worktree");
  assert.equal(completed.sharedGitMetadataMutation, true);
  assert.equal(completed.completion.mergeDecision, "owner-required");
  assert.match(completed.completion.prompt, /是否要將.*merge 到 main/u);
  const status = JSON.parse(await broker.call("candidate_status", {
    taskId: started.candidate.taskId,
  })) as { candidates: Array<{ status: string; live: { completionStale: boolean } }> };
  assert.equal(status.candidates[0]?.status, "completed");
  assert.equal(status.candidates[0]?.live.completionStale, false);

  const previewed = JSON.parse(await broker.call("main_merge_preview", {
    taskId: started.candidate.taskId, room: "demo",
  })) as {
    completionId: string; previewDigest: string; approvable: boolean; blockers: string[];
    confirmationPhrase: string; prompt: string; mainMutation: boolean;
    sharedGitMetadataMutation: boolean; mergeDecision: string;
    preview: { candidateHead: string; mergeable: boolean };
  };
  assert.equal(previewed.approvable, true);
  assert.deepEqual(previewed.blockers, []);
  assert.equal(previewed.mainMutation, false);
  // Preview writes nothing at all, not even the shared Git metadata a checkpoint would add.
  assert.equal(previewed.sharedGitMetadataMutation, false);
  assert.equal(previewed.confirmationPhrase, "MERGE INTO MAIN");
  assert.equal(previewed.mergeDecision, "owner-required");
  assert.equal(previewed.preview.candidateHead, completed.completion.preview.candidateHead);
  assert.match(previewed.prompt, /只能使用一次/u);
  const requested = JSON.parse(await broker.call("main_merge_request", {
    clientRequestId: key(), taskId: started.candidate.taskId,
    completionId: previewed.completionId, previewDigest: previewed.previewDigest,
  })) as {
    approval: { id: string; state: string; grants: string; notAuthorized: string[] };
    approved: boolean; mainMutation: boolean; sharedGitMetadataMutation: boolean; next: string;
  };
  // Requesting is not approving: no token, no authority, and nothing on disk changed.
  assert.equal(requested.approved, false);
  assert.equal(requested.approval.state, "requested");
  assert.equal(requested.approval.grants, "merge-candidate-into-main");
  assert.ok(requested.approval.notAuthorized.includes("push"));
  assert.equal(requested.mainMutation, false);
  assert.equal(requested.sharedGitMetadataMutation, false);
  assert.equal(JSON.stringify(requested).includes("approvalToken"), false);
  const afterRequest = JSON.parse(await broker.call("candidate_status", {
    taskId: started.candidate.taskId,
  })) as { candidates: Array<{ mergeApprovals: Array<{ id: string; state: string }> }> };
  assert.deepEqual(
    afterRequest.candidates[0]?.mergeApprovals.map((entry) => entry.state),
    ["requested"],
  );
  await assert.rejects(
    broker.call("main_merge_request", {
      clientRequestId: key(), taskId: started.candidate.taskId,
      completionId: previewed.completionId, previewDigest: previewed.previewDigest,
    }),
    /MAIN_MERGE_APPROVAL_ALREADY_PENDING/u,
  );
  await assert.rejects(
    broker.call("main_merge_request", {
      clientRequestId: key(), taskId: started.candidate.taskId,
      completionId: previewed.completionId, previewDigest: "not-a-digest",
    }),
    /INVALID_CANDIDATE_PREVIEW_DIGEST/u,
  );
  await assert.rejects(
    broker.call("main_merge_request", {
      clientRequestId: key(), taskId: started.candidate.taskId,
      completionId: "not-a-uuid", previewDigest: previewed.previewDigest,
    }),
    /INVALID_CANDIDATE_COMPLETION_ID/u,
  );
  await assert.rejects(
    broker.call("main_merge_request", {
      clientRequestId: "not-a-uuid", taskId: started.candidate.taskId,
      completionId: previewed.completionId, previewDigest: previewed.previewDigest,
    }),
    /INVALID_CANDIDATE_CLIENT_REQUEST_ID/u,
  );
  await assert.rejects(
    broker.call("main_merge_preview", { taskId: "not-a-uuid" }),
    /INVALID_CANDIDATE_TASK_ID/u,
  );
  await assert.rejects(
    broker.call("main_merge_preview", { taskId: started.candidate.taskId, room: "other" }),
    /CANDIDATE_ROOM_BINDING_MISMATCH/u,
  );
  await assert.rejects(
    broker.call("main_merge_request", {
      clientRequestId: key(), taskId: started.candidate.taskId,
      completionId: previewed.completionId, previewDigest: previewed.previewDigest, room: "other",
    }),
    /CANDIDATE_ROOM_BINDING_MISMATCH/u,
  );
  await assert.rejects(
    broker.call("main_merge_preview", { taskId: started.candidate.taskId, approve: true }),
    /UNKNOWN_MAIN_MERGE_PREVIEW_ARGUMENT/u,
  );
  await assert.rejects(
    broker.call("main_merge_request", {
      clientRequestId: key(), taskId: started.candidate.taskId,
      completionId: previewed.completionId, previewDigest: previewed.previewDigest, approve: true,
    }),
    /UNKNOWN_MAIN_MERGE_REQUEST_ARGUMENT/u,
  );
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), mainHead);
  await assert.rejects(
    broker.call("candidate_start", {
      clientRequestId: key(), mainPath: join(root, "other"), task: "wrong binding",
    }),
    /CANDIDATE_MAIN_PATH_BINDING_MISMATCH/u,
  );
  await assert.rejects(
    broker.call("candidate_complete", {
      clientRequestId: key(), taskId: started.candidate.taskId, summary: "x", approve: true,
    }),
    /UNKNOWN_CANDIDATE_COMPLETE_ARGUMENT/u,
  );
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

/*
 * The classification guard.
 *
 * The undeclared-start note is driven by a set of tool names, and the comment above that set says
 * adding a tool means putting a name in it "rather than someone having to remember a call". Nothing
 * held that up: the previous round's defect was exactly someone forgetting `ask_*`, and moving the
 * call to one place moved the forgetting too -- the two assertions that touch the registry check a
 * fixed count for an unseated broker and the last twelve entries, so a tool inserted anywhere in the
 * middle goes unnoticed by both.
 *
 * This reads the two lists out of the source rather than importing them, because the set is a
 * private static field and the dispatch is a private method. That makes the extraction itself
 * load-bearing, so both parses are asserted for shape before being used: a regex that quietly stops
 * matching would otherwise make this test pass by comparing nothing to nothing.
 */
test("every dispatched tool is classified as initiating work or not", async () => {
  const source = await readFile(new URL("../src/mcp/collab-server.ts", import.meta.url), "utf8");

  /* `[a-z_]+` was the first pattern here and it could not see a tool whose name carries a digit --
     `room_v2` was simply absent from the set, so it was never unclassified and never reported. The
     class of name the product actually allows is the class this must read. */
  const NAME = '"([a-z][a-z0-9_]*)"';

  const dispatchBody = source.slice(source.indexOf("async #dispatch("));
  const dispatched = new Set(
    [...dispatchBody.slice(0, dispatchBody.indexOf("UNKNOWN_COLLAB_TOOL"))
      .matchAll(new RegExp("name === " + NAME, "gu"))].map((match) => match[1]!),
  );

  const setBlock = source.slice(source.indexOf("static readonly #INITIATING_TOOLS"));
  const initiating = new Set(
    [...setBlock.slice(0, setBlock.indexOf("]")).matchAll(new RegExp(NAME, "gu"))].map((match) => match[1]!),
  );

  /* Exact, not a floor. A floor two below the real count let a rewrite that hid two tools stay green
     on this assertion and fail only on the documentation count -- whose message points at the
     documentation, so the natural fix is to edit the document down and shrink the guard for good. */
  assert.equal(dispatched.size, 27, "the dispatch no longer parses to the tools this guard classifies");
  assert.equal(initiating.size, 9, "the initiating set no longer parses to the size this guard checks");
  assert.ok(dispatched.has("room_wait") && dispatched.has("list_agents"), "extraction missed known tools");

  /*
   * Every tool that does NOT start work, with the reason it does not. A new tool belongs here or in
   * the set in the source; leaving it out of both is what this test exists to catch.
   */
  const notInitiating = new Map([
    ["room_ack", "answers work already handed to this seat"],
    ["room_reply", "answers work already handed to this seat"],
    ["room_fail", "answers work already handed to this seat"],
    ["list_agents", "read-only"],
    ["room_status", "read-only"],
    ["room_read", "read-only"],
    ["room_get", "read-only"],
    ["room_search", "read-only"],
    ["candidate_status", "read-only"],
    ["main_merge_preview", "read-only"],
    ["room_wait", "waits to be given work; being handed some is not starting it"],
    ["room_await_reply", "waits for a reply to work this seat already started"],
    ["room_init", "entering; returns the existing room for an already-bound seat"],
    ["room_join_request", "entering"],
    ["room_start", "IS the declaration, so it cannot be what goes unrecorded"],
    ["candidate_checkpoint", "continues a candidate only candidate_start could have opened"],
    ["candidate_complete", "continues a candidate only candidate_start could have opened"],
    ["main_merge_request", "continues a candidate only candidate_start could have opened"],
  ]);

  const unclassified = [...dispatched].filter((name) => !initiating.has(name) && !notInitiating.has(name));
  assert.deepEqual(
    unclassified,
    [],
    "a tool was added without deciding whether it starts work; put it in #INITIATING_TOOLS or in the list above",
  );

  const bothWays = [...initiating].filter((name) => notInitiating.has(name));
  assert.deepEqual(bothWays, [], "a tool is listed as both initiating and not");

  const undispatched = [...initiating, ...notInitiating.keys()].filter((name) => !dispatched.has(name));
  assert.deepEqual(undispatched, [], "a classified tool is no longer dispatched; remove it from both lists");

  /*
   * The tool map opens by telling a joining agent how many tools it is about to read about. That
   * number was wrong before `room_start` was added and became right by adding one -- the count had
   * drifted and the correction was a coincidence, which is the same as having no check at all. The
   * document is the first thing an agent reads on entering, so a number it states about itself
   * should not be something a person has to remember to update.
   */
  const map = await readFile(new URL("../docs/MCP_TOOLS.md", import.meta.url), "utf8");
  const claimed = map.match(/這\s*(\d+)\s*個工具/u);
  assert.ok(claimed, "docs/MCP_TOOLS.md no longer states a tool count; this guard has stopped guarding");
  assert.equal(
    Number(claimed[1]),
    dispatched.size,
    "docs/MCP_TOOLS.md states a different number of tools than the server dispatches",
  );
});

/*
 * A tool that fails AFTER changing the room is still a seat that acted.
 *
 * `#callRoomWorker` appends the mention, then "response in progress", then "response failed", and
 * only then throws. Keying the note on the tool returning meant those three lines went into the
 * ledger with no mark against the seat, while a `room_post` refused before touching anything carried
 * one -- the same asymmetry the previous round set out to remove, pointing the other way. The
 * question the mark answers is whether a later reader will see this seat working, and here they will.
 */
test("a seat that changed the room and then failed is still marked as having started work", async (t) => {
  const { broker, ledger, cleanup } = await fixture({
    failProvider: "grok",
    withCollaboration: true,
    sessionRoomMode: "room-first",
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });

  await assert.rejects(
    broker.call("room_mention", { target: "grok", text: "請檢查" }),
    /SYNTHETIC_PROVIDER_FAILURE/u,
  );

  const messages = ledger.listAfter("demo", 0);
  assert.equal(
    messages.filter((message) => message.text.includes("還沒說明是接續現有工作還是開始新任務")).length,
    1,
    "the provider was called and three lines were written; the seat acted",
  );
  assert.equal(ledger.verifyChain("demo"), true);
});

/*
 * The other direction, and the one the previous round got right: a tool refused before it touched
 * the room leaves nothing behind. Without this, "mark it when it failed too" collapses into "mark it
 * always", which is the defect that was removed.
 */
test("a seat whose tool was refused before touching the room is not marked", async (t) => {
  const { broker, ledger, cleanup } = await fixture({
    withCollaboration: true,
    sessionRoomMode: "room-first",
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });

  await assert.rejects(
    broker.call("room_post", { text: "@claude 幫我看看" }),
    /ROOM_POST_MENTION_REQUIRES_ROOM_MENTION/u,
  );

  const messages = ledger.listAfter("demo", 0);
  assert.equal(
    messages.filter((message) => message.text.includes("還沒說明是接續現有工作還是開始新任務")).length,
    0,
    "the room turned the post away, so there is no work for a reader to trace",
  );
});

/*
 * Another seat writing during a failing call is not this seat acting.
 *
 * The first version of the failure check compared the room's whole message count before and after,
 * which is every seat's writes, not this one's. A room with several live seats is the product's
 * ordinary mode -- each seat is its own MCP process against one shared ledger -- so any concurrent
 * post made the counts differ and marked a seat that had touched nothing. The window is the length
 * of the failing call, which for a provider round-trip is seconds to minutes, not microseconds.
 *
 * The other seat here writes directly through the ledger rather than through a second broker,
 * because what is being reproduced is a row appearing in the room mid-call, and its author is the
 * only part that matters.
 */
test("a concurrent write by another seat does not mark this seat", async (t) => {
  const { broker, ledger, cleanup } = await fixture({
    withCollaboration: true,
    sessionRoomMode: "room-first",
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });

  const before = ledger.listAfter("demo", 0).length;

  await assert.rejects(
    /* Refused before touching the room, exactly as in the test above -- the only thing added is
       somebody else writing while it happens. */
    (async () => {
      const attempt = broker.call("room_post", { text: "@claude 幫我看看" });
      ledger.append("demo", "you", "另一個席位在這段時間講了一句話");
      return await attempt;
    })(),
    /ROOM_POST_MENTION_REQUIRES_ROOM_MENTION/u,
  );

  const messages = ledger.listAfter("demo", 0);
  assert.equal(messages.length, before + 1, "the other seat's line is there, so the room did change");
  assert.equal(
    messages.filter((message) => message.text.includes("還沒說明是接續現有工作還是開始新任務")).length,
    0,
    "the room changed, but not because of this seat",
  );
});

/*
 * `ask_*` writes its question to the ledger and then calls the provider, so one that fails has
 * already changed the room and must be marked.
 *
 * This path had no test. The failure case that existed used `room_mention`, which resolves the
 * author through `#messageAuthor`, while `ask_*` read it off the session binding -- two sources for
 * one column, agreeing in production and disagreeing in the fixture, which hardcoded `codex1`. So
 * the assertion below would have been red for a reason that had nothing to do with the behaviour,
 * and the quickest way to a green bar would have been to weaken it.
 */
test("asking a provider, writing the question, and then failing still marks the seat", async (t) => {
  const { broker, ledger, cleanup } = await fixture({
    failProvider: "grok",
    withCollaboration: true,
    sessionRoomMode: "room-first",
  });
  t.after(cleanup);
  await broker.call("room_init", { room: "demo" });

  await assert.rejects(
    broker.call("ask_grok", { question: "這段程式在做什麼？" }),
    /SYNTHETIC_PROVIDER_FAILURE/u,
  );

  const messages = ledger.listAfter("demo", 0);
  assert.ok(
    messages.some((message) => message.text.includes("這段程式在做什麼？")),
    "the question reached the ledger, so the room changed before the provider was called",
  );
  assert.equal(
    messages.filter((message) => message.text.includes("還沒說明是接續現有工作還是開始新任務")).length,
    1,
    "a reader will see this seat asking; the mark belongs with it",
  );
  assert.equal(ledger.verifyChain("demo"), true);
});
