import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { runInNewContext } from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAppContext } from "../src/app.ts";
import { APPLY_BACK_CONFIRMATION, startWebServer } from "../src/ui/web.ts";
import { GitBroker } from "../src/core/git-broker.ts";
import { isNoCostProvider } from "../src/providers/billing.ts";
import { ALL_PROVIDER_IDS } from "../src/providers/selection.ts";
import { WorktreeBroker } from "../src/core/worktree-broker.ts";
import { RoomPresenceStore } from "../src/core/room-presence.ts";
import { RoomLedger } from "../src/core/room-ledger.ts";
import { RoomInboxStore } from "../src/core/room-inbox.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";
import type { ProviderAdapter } from "../src/providers/provider.ts";

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-web-workspace-"));
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

test("Web dashboard enforces session, CSRF, origin and Host checks", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-web-data-"));
  const workspace = await repository();
  const pickerWorkspace = await repository();
  await writeFile(
    join(data, "tester-profiles.json"),
    `${JSON.stringify([
      {
        id: "synthetic-tests",
        displayName: "Synthetic tests",
        runtime: "docker",
        image: `synthetic@sha256:${"a".repeat(64)}`,
        executable: "node",
        args: ["--test"],
      },
    ])}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(
    join(data, "workspace-roots.json"),
    `${JSON.stringify([{ id: "synthetic-root", label: "Synthetic root", path: workspace }])}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  t.after(async () => await rm(pickerWorkspace, { recursive: true, force: true }));
  const app = await createAppContext(data);
  t.after(() => app.close());
  const pendingWorkflow = app.workflowRequests.enqueue({
    workspace,
    task: "Review this pending workflow",
    profile: "normal",
    planner: { provider: "codex", model: "gpt-5.6-sol" },
    writer: { provider: "claude", model: "claude-fable-5" },
    reviewers: [{ provider: "codex", model: "gpt-5.6-sol" }],
  }, "claude");
  const restoreRunId = "00000000-0000-4000-8000-000000000011";
  const restoreCheckpointId = "00000000-0000-4000-8000-000000000012";
  const now = new Date().toISOString();
  const restoreCounters = {
    rounds: 1,
    providerCalls: 2,
    subprocesses: 0,
    consecutiveErrors: 0,
    outputBytes: 20,
    apiBudgetUsd: 0,
  };
  app.store.saveRun({
    id: restoreRunId,
    createdAt: now,
    updatedAt: now,
    status: "running",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: restoreCounters,
  });
  app.store.saveCheckpoint({
    id: restoreCheckpointId,
    runId: restoreRunId,
    createdAt: now,
    round: 1,
    phase: "writer-complete",
    workspaceFingerprint: (await new GitBroker().inspect(workspace)).fingerprint,
    counters: restoreCounters,
  });
  app.store.recoverInterruptedRuns();
  await assert.rejects(startWebServer(app, -1), /INVALID_PORT/u);
  let chatTurns = 0;
  let chatCalls = 0;
  let chatClears = 0;
  let chatAbortObserved = false;
  let markChatStarted: (() => void) | undefined;
  const chatStarted = new Promise<void>((resolve) => {
    markChatStarted = resolve;
  });
  let chatConversationsCreated = 0;
  const managedPrompts: string[] = [];
  const writerPrompts: string[] = [];
  const delegatedPrompts: string[] = [];
  const originalProviderGet = app.providers.get.bind(app.providers);
  const syntheticProviders = new Map<string, ProviderAdapter>();
  for (const id of ["claude", "codex", "grok"] as const) {
    const capabilities = originalProviderGet(id).capabilities;
    syntheticProviders.set(id, {
      capabilities,
      invoke: async (request) => {
        if (request.prompt.includes("Task from parent Writer: FAIL_DELEGATED_AGENT")) {
          throw new Error("synthetic delegated failure");
        }
        if (request.prompt.includes("You are delegated child Agent")) {
          delegatedPrompts.push(request.prompt);
          assert.ok(request.writerAuthorization?.delegationId);
          if (request.access === "workspace-write") {
            assert.match(request.writerAuthorization?.capabilityToken ?? "", /^[0-9a-f-]{36}$/u);
          } else {
            assert.equal(request.writerAuthorization?.capabilityToken, undefined);
          }
          return {
            provider: id, model: request.model, text: "synthetic delegated checkpoint",
            exitCode: 0, durationMs: 1, outputBytes: 32,
          };
        }
        writerPrompts.push(request.prompt);
        assert.match(request.writerAuthorization?.capabilityToken ?? "", /^[0-9a-f-]{36}$/u);
        return {
          provider: id, model: request.model, text: "synthetic Writer checkpoint",
          exitCode: 0, durationMs: 1, outputBytes: 28,
        };
      },
      doctor: async () => ({ ok: true }),
      listModels: async () => [...capabilities.subscriptionModels],
    });
  }
  app.providers.get = ((id) => syntheticProviders.get(id) ?? originalProviderGet(id)) as typeof app.providers.get;
  let chatAgent = { provider: "codex", model: "gpt-5.6-sol" };
  const server = await startWebServer(app, 0, {
    pickWorkspace: async () => pickerWorkspace,
    createConversation: ({ provider, model }) => {
      chatConversationsCreated += 1;
      chatAgent = { provider, model };
      return {
        turn: async (message: string, signal?: AbortSignal) => {
          chatTurns += 1;
          chatCalls += 1;
          if (message === "wait for stop") {
            markChatStarted?.();
            return await new Promise((_, reject) => {
              signal?.addEventListener("abort", () => {
                chatAbortObserved = true;
                reject(new Error("PROVIDER_ABORTED"));
              }, { once: true });
            });
          }
          return message === "change files"
            ? { kind: "tool" as const, tool: "coding_team" as const, input: "change files safely" }
            : { kind: "message" as const, message: `reply: ${message}`, source: "codex" as const };
        },
        status: () => ({
          id: "00000000-0000-4000-8000-000000000099",
          turns: chatTurns,
          providerCalls: chatCalls,
          historyBytes: 0,
          mainAgent: {
            role: "planner" as const,
            provider: chatAgent.provider as "codex",
            model: chatAgent.model,
            authMode: "subscription" as const,
          },
          tools: [],
        }),
        clear: () => {
          chatTurns = 0;
          chatClears += 1;
        },
        setMainAgent: (next: { provider: string; model: string }) => {
          chatAgent = { ...next };
        },
      };
    },
    invokeManagedAgent: async ({ agent, prompt }) => {
      managedPrompts.push(prompt);
      return `${agent.displayName} synthetic reply`;
    },
  });
  t.after(async () => await server.close());

  const index = await fetch(server.url);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
  const cookie = (index.headers.get("set-cookie") ?? "").split(";")[0];
  const indexHtml = await index.text();
  assert.match(indexHtml, /Orchestratory/u);
  assert.match(indexHtml, /直接輸入需求就開始/u);
  assert.match(indexHtml, /主代理/u);
  assert.match(indexHtml, /gpt-5\.6-sol/u);
  assert.match(indexHtml, /@模型 指定／比稿/u);
  assert.match(indexHtml, /Room 即時協作/u);
  assert.match(indexHtml, /歷史紀錄/u);
  assert.match(indexHtml, /id="workspace-onboarding"/u);
  assert.match(indexHtml, /id="workspace-pick"/u);
  assert.match(indexHtml, /id="workspace-path"/u);
  assert.ok(cookie);
  assert.match(cookie, /^orchestratory_session_[0-9]+=/u);

  const secondServer = await startWebServer(app, 0);
  try {
    const secondIndex = await fetch(secondServer.url);
    const secondCookie = (secondIndex.headers.get("set-cookie") ?? "").split(";")[0];
    assert.ok(secondCookie);
    assert.match(secondCookie, /^orchestratory_session_[0-9]+=/u);
    assert.notEqual(secondCookie.split("=")[0], cookie.split("=")[0]);
    assert.equal(
      (await fetch(`${secondServer.url}/api/bootstrap`, { headers: { Cookie: cookie } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${server.url}/api/bootstrap`, { headers: { Cookie: secondCookie } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${secondServer.url}/api/bootstrap`, { headers: { Cookie: secondCookie } })).status,
      200,
    );
    let unauthorizedThrottled = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(`${secondServer.url}/api/bootstrap`);
      if (response.status !== 429) continue;
      unauthorizedThrottled = true;
      assert.equal(response.headers.get("retry-after"), "60");
      assert.deepEqual(await response.json(), { error: "RATE_LIMITED" });
      break;
    }
    assert.equal(unauthorizedThrottled, true);
    assert.equal(
      (await fetch(`${secondServer.url}/api/bootstrap`, { headers: { Cookie: secondCookie } })).status,
      200,
    );
  } finally {
    await secondServer.close();
  }

  const unauthorized = await fetch(`${server.url}/api/bootstrap`);
  assert.equal(unauthorized.status, 401);

  const bootstrap = await fetch(`${server.url}/api/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(bootstrap.status, 200);
  const bootstrapBody = (await bootstrap.json()) as {
    roomUiProtocol: number;
    csrf: string;
    testerProfiles: Array<{ id: string }>;
    recoverableCheckpoints: Array<{ runId: string }>;
    workspaceRoots: Array<{ id: string }>;
    providerCallUsage: { calls: number; maxCalls: number; killEpoch: number };
    pendingWorkflowRequests: Array<{ id: string; status: string; task: string }>;
  };
  assert.equal(bootstrapBody.roomUiProtocol, 2);
  assert.ok(bootstrapBody.csrf.length > 20);
  assert.equal(bootstrapBody.testerProfiles[0]?.id, "synthetic-tests");
  assert.equal(bootstrapBody.recoverableCheckpoints[0]?.runId, restoreRunId);
  assert.equal(bootstrapBody.workspaceRoots[0]?.id, "synthetic-root");
  assert.equal(bootstrapBody.providerCallUsage.calls, 0);
  assert.equal(bootstrapBody.providerCallUsage.maxCalls, app.hardLimits.maxProviderCalls);
  assert.equal(bootstrapBody.providerCallUsage.killEpoch, 0);
  assert.deepEqual(bootstrapBody.pendingWorkflowRequests.map((item) => item.id), [pendingWorkflow.id]);
  assert.equal(bootstrapBody.pendingWorkflowRequests[0]?.status, "pending");

  const postChat = async (body: unknown) => await fetch(`${server.url}/api/chat`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const chat = await postChat({ workspace, model: "gpt-5.6-sol", message: "hello" });
  assert.equal(chat.status, 200);
  assert.deepEqual((await chat.json()) as unknown, {
    decision: { kind: "message", message: "reply: hello", source: "codex" },
    status: {
      id: "00000000-0000-4000-8000-000000000099",
      turns: 1,
      providerCalls: 1,
      historyBytes: 0,
      mainAgent: { role: "planner", provider: "codex", model: "gpt-5.6-sol", authMode: "subscription" },
      tools: [],
    },
  });
  const toolChat = await postChat({ workspace, model: "gpt-5.6-sol", message: "change files" });
  assert.equal(toolChat.status, 200);
  assert.deepEqual(((await toolChat.json()) as { decision: unknown }).decision, {
    kind: "tool",
    tool: "coding_team",
    input: "change files safely",
  });
  const switchedChat = await postChat({
    workspace,
    provider: "claude",
    model: "claude-fable-5",
    message: "switch please",
  });
  assert.equal(switchedChat.status, 200);
  const switchedBody = (await switchedChat.json()) as {
    status: { turns: number; mainAgent: { provider: string; model: string } };
  };
  assert.equal(switchedBody.status.turns, 3);
  assert.deepEqual(
    {
      provider: switchedBody.status.mainAgent.provider,
      model: switchedBody.status.mainAgent.model,
    },
    { provider: "claude", model: "claude-fable-5" },
  );
  assert.equal(chatConversationsCreated, 1);
  const unknownChatField = await postChat({ workspace, model: "gpt-5.6-sol", message: "hello", extra: true });
  assert.equal(unknownChatField.status, 400);
  const invalidChatModel = await postChat({ workspace, model: "bad model", message: "hello" });
  assert.equal(invalidChatModel.status, 400);
  const invalidChatProvider = await postChat({
    workspace,
    provider: "shell",
    model: "gpt-5.6-sol",
    message: "hello",
  });
  assert.equal(invalidChatProvider.status, 400);
  const resetChat = await fetch(`${server.url}/api/chat/reset`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(resetChat.status, 200);
  assert.equal(chatClears, 1);
  assert.equal(((await resetChat.json()) as { status: { turns: number; providerCalls: number } }).status.turns, 0);
  assert.equal(chatCalls, 3);

  const models = await fetch(`${server.url}/api/models?provider=fake&authMode=subscription`, {
    headers: { Cookie: cookie },
  });
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()) as unknown, { models: ["fake"] });
  const invalidModels = await fetch(`${server.url}/api/models?provider=unknown&authMode=subscription`, {
    headers: { Cookie: cookie },
  });
  assert.equal(invalidModels.status, 400);
  // The local endpoint is a legal menu choice, so the model route accepts the id;
  // with no owner-approved endpoint the registry still fails closed behind it.
  const localModels = await fetch(`${server.url}/api/models?provider=local&authMode=subscription`, {
    headers: { Cookie: cookie },
  });
  assert.equal(localModels.status, 400);
  assert.match(((await localModels.json()) as { error: string }).error, /PROVIDER_NOT_REGISTERED/u);
  // …and it is never offered on the conversation surface.
  const localChat = await fetch(`${server.url}/api/chat`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workspace, provider: "local", model: "llama3", message: "hi" }),
  });
  assert.equal(localChat.status, 400);
  assert.match(((await localChat.json()) as { error: string }).error, /INVALID_PROVIDER_ID/u);

  const csrfHeaders = {
    Cookie: cookie,
    Origin: server.url,
    "X-CSRF-Token": bootstrapBody.csrf,
    "Content-Type": "application/json",
  };
  const blockedWorkspacePreview = await fetch(`${server.url}/api/workspaces/preview`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ path: "/" }),
  });
  assert.equal(blockedWorkspacePreview.status, 200);
  const blockedWorkspaceBody = (await blockedWorkspacePreview.json()) as {
    preview: { id: string; confirmation: string; blocked: boolean };
  };
  assert.equal(blockedWorkspaceBody.preview.blocked, true);
  const blockedWorkspaceConfirm = await fetch(`${server.url}/api/workspaces/confirm`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      previewId: blockedWorkspaceBody.preview.id,
      confirmation: blockedWorkspaceBody.preview.confirmation,
    }),
  });
  assert.equal(blockedWorkspaceConfirm.status, 400);

  const pickerResponse = await fetch(`${server.url}/api/workspaces/pick`, {
    method: "POST",
    headers: csrfHeaders,
    body: "{}",
  });
  assert.equal(pickerResponse.status, 200);
  const pickerBody = (await pickerResponse.json()) as {
    cancelled: boolean;
    preview: { id: string; label: string; canonicalPath: string; confirmation: string; blocked: boolean };
  };
  assert.equal(pickerBody.cancelled, false);
  assert.equal(pickerBody.preview.label, "orchestratory-web-workspace-" + pickerWorkspace.split("orchestratory-web-workspace-")[1]);
  assert.equal(pickerBody.preview.canonicalPath, await realpath(pickerWorkspace));
  assert.equal(pickerBody.preview.blocked, false);
  const confirmPickedWorkspace = await fetch(`${server.url}/api/workspaces/confirm`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      previewId: pickerBody.preview.id,
      confirmation: pickerBody.preview.confirmation,
    }),
  });
  assert.equal(confirmPickedWorkspace.status, 201);
  const confirmedWorkspaceBody = (await confirmPickedWorkspace.json()) as {
    root: { path: string };
    added: boolean;
  };
  assert.equal(confirmedWorkspaceBody.added, true);
  assert.equal(confirmedWorkspaceBody.root.path, await realpath(pickerWorkspace));
  assert.equal(app.workspaces.allowsCanonical(await realpath(pickerWorkspace)), true);

  const invalidWorkspacePreview = await fetch(`${server.url}/api/workspaces/preview`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ path: pickerWorkspace, extra: true }),
  });
  assert.equal(invalidWorkspacePreview.status, 400);
  const roomsEmpty = await fetch(`${server.url}/api/rooms`, { headers: { Cookie: cookie } });
  assert.deepEqual((await roomsEmpty.json()) as unknown, { rooms: [] });
  const { RoomLedger } = await import("../src/core/room-ledger.ts");
  const sharedLedger = new RoomLedger(app.store.dataDirectory);
  sharedLedger.createRoom("demo", await realpath(workspace));
  sharedLedger.close();
  // The owner's acknowledgement endpoint. It exists because the proof it produces lives in the
  // memory of the process that runs promotions, and the CLI is not that process — it starts, answers
  // and exits. Asserted here, on the real server, because "there is a way out" is the claim.
  const postAcknowledge = async (body: unknown, headers: Record<string, string> = {}) =>
    await fetch(`${server.url}/api/rooms/merge-promotions/acknowledge`, {
      method: "POST",
      headers: {
        Cookie: cookie, Origin: server.url, "X-CSRF-Token": bootstrapBody.csrf,
        "Content-Type": "application/json", ...headers,
      },
      body: JSON.stringify(body),
    });
  // Shares the POST guards rather than inventing its own: no CSRF token, no acknowledgement.
  assert.equal((await postAcknowledge(
    { room: "demo", confirmation: "x" }, { "X-CSRF-Token": "wrong" },
  )).status, 403);
  // Unknown fields are refused rather than ignored — a field this handler does not read is a field
  // whose meaning it cannot honour.
  assert.equal((await postAcknowledge(
    { room: "demo", confirmation: "x", taskId: "anything" },
  )).status, 400);
  assert.equal((await postAcknowledge({ room: "demo" })).status, 400);
  // A wrong phrase is refused before anything is surveyed: a near-miss must not become a listing of
  // what the owner would have been accepting.
  const wrongPhrase = await postAcknowledge({ room: "demo", confirmation: "yes" });
  assert.equal(wrongPhrase.status, 400);
  // The exact phrase is accepted, and the response says plainly what it did NOT do. Zero records is
  // the honest answer for a project that has never promoted, and it is still a success.
  const acknowledged = await postAcknowledge({
    room: "demo",
    confirmation: "I HAVE CHECKED THIS PROJECT MYSELF AND NO EARLIER PROMOTION IS STILL RUNNING",
  });
  assert.equal(acknowledged.status, 200);
  assert.deepEqual((await acknowledged.json()) as unknown, {
    acknowledged: [],
    skipped: [],
    verifiedByProduct: false,
    promotionStoreMutation: false,
    mainMutation: false,
    scope: "this-process-only",
  });

  // The release route shares the same guards and the same schema discipline.
  const postRelease = async (body: unknown, headers: Record<string, string> = {}) =>
    await fetch(`${server.url}/api/rooms/merge-promotions/release`, {
      method: "POST",
      headers: {
        Cookie: cookie, Origin: server.url, "X-CSRF-Token": bootstrapBody.csrf,
        "Content-Type": "application/json", ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await postRelease(
    { room: "demo", promotionId: "p", confirmation: "P" }, { "X-CSRF-Token": "wrong" },
  )).status, 403);
  assert.equal((await postRelease({ room: "demo", promotionId: "p" })).status, 400);
  assert.equal((await postRelease(
    { room: "demo", promotionId: "p", confirmation: "P", taskId: "x" },
  )).status, 400);
  // A pid that is not a safe integer is refused rather than coerced: a release lands on a number.
  assert.equal((await postRelease(
    { room: "demo", promotionId: "p", confirmation: "P", pid: 1.5 },
  )).status, 400);
  // A well-formed request for a promotion that does not exist is refused by the registry, not
  // rounded down to a success.
  assert.equal((await postRelease(
    { room: "demo", promotionId: "11111111-1111-4111-8111-111111111111", confirmation: "P" },
  )).status >= 400, true);

  const roomsByProject = await fetch(`${server.url}/api/rooms`, { headers: { Cookie: cookie } });
  const roomsByProjectBody = (await roomsByProject.json()) as {
    rooms: Array<{
      id: string;
      projectName: string;
      workspace: string;
      pendingAgentRequests: number;
      pendingStandbyRequests: number;
      joinedExternalSeats: number;
      wakeableExternalSeats: number;
    }>;
  };
  assert.deepEqual(roomsByProjectBody.rooms[0], {
    ...(roomsByProjectBody.rooms[0] ?? {}),
    id: "demo",
    projectName: basename(workspace),
    workspace: await realpath(workspace),
    pendingAgentRequests: 0,
    pendingStandbyRequests: 0,
    joinedExternalSeats: 0,
    wakeableExternalSeats: 0,
  });
  const roomWorkflowRequest = await fetch(`${server.url}/api/rooms/workflow-request`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "demo",
      task: "Implement the approved room improvement",
      acceptanceCriteria: "The owner can review the proposal before RUN",
    }),
  });
  assert.equal(roomWorkflowRequest.status, 201);
  const roomWorkflowBody = (await roomWorkflowRequest.json()) as {
    request: { id: string; actor: string; workspace: string; writer: { provider: string } };
    approved: boolean;
    started: boolean;
    next: string;
  };
  assert.equal(roomWorkflowBody.request.actor, "room-owner");
  assert.equal(roomWorkflowBody.request.workspace, await realpath(workspace));
  assert.equal(roomWorkflowBody.request.writer.provider, "claude");
  assert.equal(roomWorkflowBody.approved, false);
  assert.equal(roomWorkflowBody.started, false);
  assert.equal(roomWorkflowBody.next, "/");
  assert.equal(app.workflowRequests.listPending().length, 2);
  const resolveRoomWorkflow = await fetch(`${server.url}/api/workflow-requests/resolve`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ id: roomWorkflowBody.request.id, decision: "declined" }),
  });
  assert.equal(resolveRoomWorkflow.status, 200);
  assert.deepEqual(app.workflowRequests.listPending().map((item) => item.id), [pendingWorkflow.id]);
  const invalidRoomWorkflowRequest = await fetch(`${server.url}/api/rooms/workflow-request`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", task: "unsafe", writer: "grok" }),
  });
  assert.equal(invalidRoomWorkflowRequest.status, 400);
  const roomPost = await fetch(`${server.url}/api/rooms/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", text: "hello room" }),
  });
  assert.equal(roomPost.status, 200);
  const roomMessages = await fetch(`${server.url}/api/rooms/messages?room=demo&after=0`, {
    headers: { Cookie: cookie },
  });
  const roomBody = (await roomMessages.json()) as {
    messages: Array<{ seq: number; author: string }>;
    room: { recording: string };
  };
  assert.equal(roomBody.messages.length, 2);
  assert.equal(roomBody.messages[1]?.author, "you");
  const roomHistory = await fetch(`${server.url}/api/rooms/messages?room=demo&before=0`, {
    headers: { Cookie: cookie },
  });
  assert.equal(roomHistory.status, 200);
  const roomHistoryBody = (await roomHistory.json()) as {
    messages: Array<{ seq: number }>;
    hasMoreBefore: boolean;
  };
  assert.deepEqual(roomHistoryBody.messages.map((message) => message.seq), [1, 2]);
  assert.equal(roomHistoryBody.hasMoreBefore, false);
  const pagedLedger = new RoomLedger(app.store.dataDirectory);
  for (let index = 0; index < 105; index += 1) {
    pagedLedger.append("demo", "you", `history ${index + 1}`);
  }
  pagedLedger.close();
  const latestHistory = await fetch(`${server.url}/api/rooms/messages?room=demo&before=0`, {
    headers: { Cookie: cookie },
  });
  const latestHistoryBody = (await latestHistory.json()) as {
    messages: Array<{ seq: number }>;
    hasMoreBefore: boolean;
  };
  assert.equal(latestHistoryBody.messages.length, 100);
  assert.equal(latestHistoryBody.messages[0]?.seq, 8);
  assert.equal(latestHistoryBody.messages[99]?.seq, 107);
  assert.equal(latestHistoryBody.hasMoreBefore, true);
  const olderHistory = await fetch(`${server.url}/api/rooms/messages?room=demo&before=8`, {
    headers: { Cookie: cookie },
  });
  const olderHistoryBody = (await olderHistory.json()) as {
    messages: Array<{ seq: number }>;
    hasMoreBefore: boolean;
  };
  assert.deepEqual(olderHistoryBody.messages.map((message) => message.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(olderHistoryBody.hasMoreBefore, false);
  const roomMention = await fetch(`${server.url}/api/rooms/mention`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", target: "fake", text: "請回應 #2" }),
  });
  assert.equal(roomMention.status, 200);
  const mentionBody = (await roomMention.json()) as {
    mention: { seq: number; author: string; text: string };
    reply: { author: string };
  };
  assert.equal(mentionBody.mention.author, "you");
  assert.match(mentionBody.mention.text, /^@fake/u);
  assert.equal(mentionBody.reply.author, "fake");
  const mentionLedger = new RoomLedger(app.store.dataDirectory);
  assert.match(
    mentionLedger.listAfter("demo", mentionBody.mention.seq)
      .find((message) => message.kind === "system")?.text ?? "",
    new RegExp(`@fake 回應處理中（提及 #${mentionBody.mention.seq}）`, "u"),
  );
  mentionLedger.close();
  const summarize = await fetch(`${server.url}/api/rooms/summarize`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", provider: "fake" }),
  });
  assert.equal(summarize.status, 200);
  const summaryBody = (await summarize.json()) as { message: { author: string; text: string } };
  assert.equal(summaryBody.message.author, "fake");
  assert.match(summaryBody.message.text, /【摘要】/u);
  const staleMention = await fetch(`${server.url}/api/rooms/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", text: "@codex 尚未執行的等待" }),
  });
  assert.equal(staleMention.status, 200);
  const staleSeq = ((await staleMention.json()) as { message: { seq: number } }).message.seq;
  const clearStaleMention = await fetch(`${server.url}/api/rooms/mention/cancel`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", seq: staleSeq }),
  });
  assert.equal(clearStaleMention.status, 200);
  assert.deepEqual(await clearStaleMention.json(), { cancelled: false, cleared: true, seq: staleSeq });
  const clearedLedger = new RoomLedger(app.store.dataDirectory);
  assert.match(clearedLedger.listAfter("demo", staleSeq).at(-1)?.text ?? "", /等待已清除/u);
  clearedLedger.close();
  const badSummarize = await fetch(`${server.url}/api/rooms/summarize`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", provider: "shell" }),
  });
  assert.equal(badSummarize.status, 400);
  const wsRequest = await fetch(`${server.url}/api/workspaces/request`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ path: "/tmp/some-project" }),
  });
  assert.equal(wsRequest.status, 200);
  assert.equal(((await wsRequest.json()) as { pending: number }).pending, 1);
  const roomPause = await fetch(`${server.url}/api/rooms/recording`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", state: "paused" }),
  });
  assert.equal(roomPause.status, 200);
  const pausedPost = await fetch(`${server.url}/api/rooms/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", text: "blocked" }),
  });
  assert.equal(pausedPost.status, 400);
  const pendingChat = postChat({ workspace, model: "gpt-5.6-sol", message: "wait for stop" });
  await chatStarted;
  const stopAll = await fetch(`${server.url}/api/stop-all`, {
    method: "POST",
    headers: csrfHeaders,
    body: "{}",
  });
  const stopped = (await stopAll.json()) as {
    stopped: number;
    workflows: number;
    providerCalls: number;
    killEpoch: number;
  };
  assert.deepEqual(
    { stopped: stopped.stopped, workflows: stopped.workflows, providerCalls: stopped.providerCalls },
    { stopped: 1, workflows: 0, providerCalls: 1 },
  );
  assert.equal(stopped.killEpoch, 1);
  assert.equal((await pendingChat).status, 400);
  assert.equal(chatAbortObserved, true);

  const presenceLedger = new RoomLedger(app.store.dataDirectory);
  presenceLedger.createRoom("presence-demo", await realpath(workspace));
  presenceLedger.close();
  const presenceStore = new RoomPresenceStore(app.store.dataDirectory);
  const availableSession = presenceStore.register({
    provider: "codex",
    workspace: await realpath(workspace),
    hostPid: 98765,
    client: "Codex CLI",
  });
  const hidden = await fetch(`${server.url}/api/rooms/presence?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  const hiddenBody = (await hidden.json()) as { sessions?: Array<unknown>; error?: string };
  assert.equal(hidden.status, 200, JSON.stringify(hiddenBody));
  assert.deepEqual(
    hiddenBody.sessions,
    [],
  );
  presenceStore.requestJoin(availableSession.id, "presence-demo", await realpath(workspace));
  const roomsWithPendingAgent = await fetch(`${server.url}/api/rooms`, { headers: { Cookie: cookie } });
  const pendingRoomSummary = ((await roomsWithPendingAgent.json()) as {
    rooms: Array<{
      id: string;
      projectName: string;
      pendingAgentRequests: number;
      pendingStandbyRequests: number;
    }>;
  }).rooms.find((room) => room.id === "presence-demo");
  assert.equal(pendingRoomSummary?.projectName, basename(workspace));
  assert.equal(pendingRoomSummary?.pendingAgentRequests, 1);
  assert.equal(pendingRoomSummary?.pendingStandbyRequests, 0);
  const available = await fetch(`${server.url}/api/rooms/presence?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  const availableBody = (await available.json()) as {
    sessions: Array<Record<string, unknown> & {
      id: string;
      joined: boolean;
      requested: boolean;
      kind: string;
      executionClass: string;
      capabilityAuthority: string;
      hostCapabilities: string;
      wakeMode: string;
      wakeable: boolean;
    }>;
  };
  assert.equal(availableBody.sessions[0]?.id, availableSession.id);
  assert.equal(availableBody.sessions[0]?.joined, false);
  assert.equal(availableBody.sessions[0]?.requested, true);
  assert.equal(availableBody.sessions[0]?.kind, "external-pull");
  assert.equal(availableBody.sessions[0]?.executionClass, "native-full-trust");
  assert.equal(availableBody.sessions[0]?.capabilityAuthority, "host");
  assert.equal(availableBody.sessions[0]?.hostCapabilities, "unchanged");
  assert.equal(availableBody.sessions[0]?.wakeMode, "active-tool-pull");
  assert.equal(availableBody.sessions[0]?.wakeable, false);
  assert.equal("hostPid" in (availableBody.sessions[0] ?? {}), false);

  const joinWithoutCsrf = await fetch(`${server.url}/api/rooms/presence/join`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: server.url, "Content-Type": "application/json" },
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(joinWithoutCsrf.status, 403);
  const joinWithoutMode = await fetch(`${server.url}/api/rooms/presence/join`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, label: "前端 2" }),
  });
  assert.equal(joinWithoutMode.status, 400);
  assert.deepEqual(await joinWithoutMode.json(), { error: "INVALID_PRESENCE_JOIN_REQUEST" });
  const joinPresence = await fetch(`${server.url}/api/rooms/presence/join`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo",
      presenceId: availableSession.id,
      label: "前端 2",
      collaborationMode: "room-first",
      syncTurns: true,
    }),
  });
  assert.equal(joinPresence.status, 200);
  const joinedPresenceBody = (await joinPresence.json()) as {
    session: {
      displayName: string;
      collaborationMode: string;
      syncTurns: boolean;
      standbyRequested: boolean;
      standbyApproved: boolean;
      executionClass: string;
      capabilityAuthority: string;
      hostCapabilities: string;
    };
  };
  assert.equal(joinedPresenceBody.session.displayName, "codex（前端 2）");
  assert.equal(joinedPresenceBody.session.collaborationMode, "room-first");
  assert.equal(joinedPresenceBody.session.syncTurns, true);
  assert.equal(joinedPresenceBody.session.standbyRequested, false);
  assert.equal(joinedPresenceBody.session.standbyApproved, false);
  assert.equal(joinedPresenceBody.session.executionClass, "native-full-trust");
  assert.equal(joinedPresenceBody.session.capabilityAuthority, "host");
  assert.equal(joinedPresenceBody.session.hostCapabilities, "unchanged");
  const joined = await fetch(`${server.url}/api/rooms/presence?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  assert.equal(
    ((await joined.json()) as { sessions: Array<{ joined: boolean }> }).sessions[0]?.joined,
    true,
  );
  const emptyPresencePost = await fetch(`${server.url}/api/rooms/presence/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, text: "   " }),
  });
  assert.equal(emptyPresencePost.status, 400);
  assert.deepEqual(await emptyPresencePost.json(), { error: "INVALID_PRESENCE_MESSAGE" });
  const presencePostBeforeStandbyApproval = await fetch(`${server.url}/api/rooms/presence/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, text: "尚未核准" }),
  });
  assert.equal(presencePostBeforeStandbyApproval.status, 400);
  assert.deepEqual(
    await presencePostBeforeStandbyApproval.json(),
    { error: "TARGET_AGENT_STANDBY_NOT_APPROVED" },
  );
  presenceStore.requestStandby(availableSession.id, "presence-demo");
  const roomsWithPendingStandby = await fetch(`${server.url}/api/rooms`, { headers: { Cookie: cookie } });
  const pendingStandbyRoom = ((await roomsWithPendingStandby.json()) as {
    rooms: Array<{ id: string; pendingAgentRequests: number; pendingStandbyRequests: number }>;
  }).rooms.find((room) => room.id === "presence-demo");
  assert.equal(pendingStandbyRoom?.pendingAgentRequests, 0);
  assert.equal(pendingStandbyRoom?.pendingStandbyRequests, 1);
  const standbyApproveWithoutCsrf = await fetch(`${server.url}/api/rooms/presence/standby/approve`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: server.url, "Content-Type": "application/json" },
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(standbyApproveWithoutCsrf.status, 403);
  const invalidStandbyApprove = await fetch(`${server.url}/api/rooms/presence/standby/approve`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, extra: true }),
  });
  assert.equal(invalidStandbyApprove.status, 400);
  assert.deepEqual(await invalidStandbyApprove.json(), { error: "INVALID_PRESENCE_STANDBY_REQUEST" });
  const standbyApprove = await fetch(`${server.url}/api/rooms/presence/standby/approve`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(standbyApprove.status, 200);
  const standbyApproveBody = (await standbyApprove.json()) as {
    session: { standbyRequested: boolean; standbyApproved: boolean; wakeable: boolean };
  };
  assert.equal(standbyApproveBody.session.standbyRequested, false);
  assert.equal(standbyApproveBody.session.standbyApproved, true);
  assert.equal(standbyApproveBody.session.wakeable, false);
  /*
   * The nudge. It cannot wake anything -- MCP over stdio cannot push to a terminal that is not asking
   * -- so what is asserted here is mostly what it must NOT claim. `woke: false` is in the response
   * shape on purpose: a caller reading this JSON should not be able to come away with a different
   * impression than the person who clicked the button.
   */
  const nudgeWithoutCsrf = await fetch(`${server.url}/api/rooms/presence/nudge`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: server.url, "Content-Type": "application/json" },
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(nudgeWithoutCsrf.status, 403);
  const nudgeInvalid = await fetch(`${server.url}/api/rooms/presence/nudge`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, extra: 1 }),
  });
  assert.equal(nudgeInvalid.status, 400);
  assert.deepEqual(await nudgeInvalid.json(), { error: "INVALID_PRESENCE_WAKE_REQUEST" });

  const nudge = await fetch(`${server.url}/api/rooms/presence/nudge`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(nudge.status, 200);
  const nudgeBody = (await nudge.json()) as { recorded: boolean; listening: boolean; woke: boolean };
  assert.equal(nudgeBody.listening, false);
  assert.equal(nudgeBody.recorded, true);
  assert.equal(nudgeBody.woke, false, "nothing here can wake a terminal, and the response must not suggest it");

  // Pressed again: one line, not a column of them. Someone clicking a button that does not visibly do
  // anything will click it again.
  //
  // Scope, stated because it is easy to overread: this proves the write is idempotent, NOT that the
  // key is bucketed by minute -- a constant key would pass here too. What separates those two is the
  // service test, which moves a controlled clock across a minute boundary and requires a second line.
  // It also runs on the wall clock, so two presses straddling :59/:00 would legitimately produce two.
  const nudgeAgain = await fetch(`${server.url}/api/rooms/presence/nudge`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(nudgeAgain.status, 200);
  const nudgeLines = (await (await fetch(`${server.url}/api/rooms/messages?room=presence-demo&after=0`, {
    headers: { Cookie: cookie },
  })).json()) as { messages: { text: string; at: string }[] };
  /*
   * Stated as the property that is actually true on a wall clock: two presses collapse to one line,
   * UNLESS they straddled a minute boundary, in which case the two lines must be in different
   * minutes. An earlier version asserted exactly one line and admitted in its own comment that a
   * :59/:00 straddle would legitimately produce two -- a known-flaky assertion, written down as such
   * and left in place.
   */
  const nudgeMessages = nudgeLines.messages.filter((message) => String(message.text).includes("Owner 想找"));
  assert.ok(nudgeMessages.length === 1 || nudgeMessages.length === 2, `unexpected line count ${nudgeMessages.length}`);
  if (nudgeMessages.length === 2) {
    const minutes = nudgeMessages.map((message) => String((message as { at: string }).at).slice(0, 16));
    assert.notEqual(minutes[0], minutes[1], "a second line is only legitimate across a minute boundary");
  }
  const nudgeLine = nudgeMessages[0];
  assert.match(String(nudgeLine?.text), /沒有辦法叫醒/u, "the ledger line must not read as a wake");

  const presencePost = await fetch(`${server.url}/api/rooms/presence/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, text: "請處理前端任務" }),
  });
  assert.equal(presencePost.status, 202);
  const presencePostBody = (await presencePost.json()) as {
    message: { author: string; text: string };
    target: { id: string; displayName: string };
    delivery: { id: string; state: string; targetPresenceId: string };
    dispatch: { wakeMode: string; wakeable: boolean; immediate: boolean };
  };
  assert.equal(presencePostBody.message.author, "you");
  assert.equal(presencePostBody.message.text, "@codex（前端 2） 請處理前端任務");
  assert.equal(presencePostBody.target.id, availableSession.id);
  assert.equal(presencePostBody.target.displayName, "codex（前端 2）");
  assert.equal(presencePostBody.delivery.state, "queued");
  assert.equal(presencePostBody.delivery.targetPresenceId, availableSession.id);
  assert.deepEqual(presencePostBody.dispatch, {
    wakeMode: "active-tool-pull",
    wakeable: false,
    immediate: false,
  });
  const deliveries = await fetch(`${server.url}/api/rooms/deliveries?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  assert.equal(deliveries.status, 200);
  assert.equal(
    ((await deliveries.json()) as { deliveries: Array<{ id: string }> }).deliveries[0]?.id,
    presencePostBody.delivery.id,
  );
  const cancelDelivery = await fetch(`${server.url}/api/rooms/deliveries/cancel`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", deliveryId: presencePostBody.delivery.id }),
  });
  assert.equal(cancelDelivery.status, 200);
  assert.equal(((await cancelDelivery.json()) as { delivery: { state: string } }).delivery.state, "cancelled");
  const retryDelivery = await fetch(`${server.url}/api/rooms/deliveries/retry`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", deliveryId: presencePostBody.delivery.id }),
  });
  assert.equal(retryDelivery.status, 200);
  assert.equal(((await retryDelivery.json()) as { delivery: { state: string } }).delivery.state, "queued");
  const managedCreate = await fetch(`${server.url}/api/rooms/managed-agents`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", provider: "claude", label: "即時審查" }),
  });
  assert.equal(managedCreate.status, 201);
  const managedCreateBody = (await managedCreate.json()) as {
    agent: {
      id: string;
      kind: string;
      executionClass: string;
      capabilityAuthority: string;
      conversationAccess: string;
      writeAccess: string;
      displayName: string;
      wakeMode: string;
      wakeable: boolean;
      busy: boolean;
    };
  };
  assert.equal(managedCreateBody.agent.kind, "managed-subagent");
  assert.equal(managedCreateBody.agent.executionClass, "gui-managed");
  assert.equal(managedCreateBody.agent.capabilityAuthority, "orchestratory");
  assert.equal(managedCreateBody.agent.conversationAccess, "read-only");
  assert.equal(managedCreateBody.agent.writeAccess, "owner-writer-lease-required");
  assert.equal(managedCreateBody.agent.displayName, "claude（即時審查）");
  assert.equal(managedCreateBody.agent.wakeMode, "managed-provider-call");
  assert.equal(managedCreateBody.agent.wakeable, true);
  assert.equal(managedCreateBody.agent.busy, false);
  const managedList = await fetch(`${server.url}/api/rooms/managed-agents?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  assert.equal(managedList.status, 200);
  assert.equal(
    ((await managedList.json()) as { agents: Array<{ id: string }> }).agents[0]?.id,
    managedCreateBody.agent.id,
  );
  const managedMention = await fetch(`${server.url}/api/rooms/managed-agents/mention`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo",
      agentId: managedCreateBody.agent.id,
      text: "請獨立審查這個任務",
    }),
  });
  assert.equal(managedMention.status, 200);
  const managedMentionBody = (await managedMention.json()) as {
    mention: { author: string; text: string };
    reply: { author: string; text: string };
  };
  assert.equal(managedMentionBody.mention.author, "you");
  assert.equal(managedMentionBody.mention.text, "@claude（即時審查） 請獨立審查這個任務");
  assert.equal(managedMentionBody.reply.author, "claude（即時審查）");
  assert.equal(managedMentionBody.reply.text, "claude（即時審查） synthetic reply");
  assert.match(managedPrompts[0] ?? "", /independent room identity/u);
  assert.match(managedPrompts[0] ?? "", /read-only/u);
  const writerCandidates = await fetch(`${server.url}/api/rooms/writers?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  assert.equal(writerCandidates.status, 200);
  const writerCandidatesBody = (await writerCandidates.json()) as {
    candidates: Array<{ origin: string; provider: string; eligible: boolean }>;
  };
  assert.ok(writerCandidatesBody.candidates.some((candidate) =>
    candidate.origin === "resident" && candidate.provider === "claude" && candidate.eligible));
  assert.equal(writerCandidatesBody.candidates.some((candidate) => candidate.origin === "external"), false);
  const joinedExternalCannotWrite = await fetch(`${server.url}/api/rooms/writers/grant`, {
    method: "POST", headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "external-codex-disabled",
      candidate: { origin: "external", actorId: availableSession.id },
    }),
  });
  assert.equal(joinedExternalCannotWrite.status, 400);
  const legacyExternalService = new CollaborationService(app.store.dataDirectory);
  const legacyExternalLease = legacyExternalService.writerLeases.grant({
    taskId: "legacy-external-web-run",
    roomId: "presence-demo",
    workspace: await realpath(workspace),
    worktree: join(await realpath(workspace), ".legacy-external-web-run"),
    writer: {
      origin: "external",
      provider: "codex",
      actorId: availableSession.id,
      displayName: "codex（legacy）",
    },
  });
  const legacyExternalDelegation = legacyExternalService.writerDelegations.create({
    parent: legacyExternalLease.lease,
    childProvider: "claude",
    label: "legacy-review",
    workspace: legacyExternalLease.lease.worktree,
  });
  const legacyExternalRun = await fetch(`${server.url}/api/rooms/writers/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo",
      taskId: "legacy-external-web-run",
      task: "must remain blocked after upgrade",
    }),
  });
  assert.equal(legacyExternalRun.status, 400);
  assert.deepEqual(await legacyExternalRun.json(), { error: "NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED" });
  const legacyExternalDelegatedRun = await fetch(`${server.url}/api/rooms/writers/delegations/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo",
      taskId: legacyExternalLease.lease.taskId,
      delegationId: legacyExternalDelegation.delegation.id,
      task: "must not invoke a delegated provider after upgrade",
    }),
  });
  assert.equal(legacyExternalDelegatedRun.status, 400);
  assert.deepEqual(await legacyExternalDelegatedRun.json(), { error: "NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED" });
  assert.equal(legacyExternalService.revokeUnrecoverableWriters("test cleanup"), 1);
  legacyExternalService.close();
  for (const candidate of [
    null,
    { origin: "resident", provider: "claude", extra: true },
    { origin: "external", actorId: 5 },
    { origin: "unknown", actorId: "unknown" },
    { origin: "resident", provider: "fake" },
  ]) {
    const response = await fetch(`${server.url}/api/rooms/writers/grant`, {
      method: "POST", headers: csrfHeaders,
      body: JSON.stringify({ room: "presence-demo", taskId: "invalid-writer", candidate }),
    });
    assert.equal(response.status, 400);
  }
  const grantWriter = await fetch(`${server.url}/api/rooms/writers/grant`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task",
      candidate: { origin: "resident", provider: "claude" },
    }),
  });
  const grantWriterBody = (await grantWriter.json()) as { lease?: { id: string; epoch: number; worktree: string }; error?: string };
  assert.equal(grantWriter.status, 201, JSON.stringify(grantWriterBody));
  assert.equal(grantWriterBody.lease?.epoch, 1);
  assert.notEqual(grantWriterBody.lease?.worktree, workspace);
  for (const invalid of [
    {},
    { room: "presence-demo", taskId: "web-task", task: "ok", acceptanceCriteria: 9 },
    { room: "presence-demo", taskId: "missing-task", task: "ok" },
    { room: "missing-room", taskId: "web-task", task: "ok" },
  ]) {
    const response = await fetch(`${server.url}/api/rooms/writers/run`, {
      method: "POST", headers: csrfHeaders, body: JSON.stringify(invalid),
    });
    assert.equal(response.status, 400);
  }
  const idleCancel = await fetch(`${server.url}/api/rooms/writers/cancel`, {
    method: "POST", headers: csrfHeaders, body: JSON.stringify({ room: "presence-demo", taskId: "web-task" }),
  });
  assert.equal(idleCancel.status, 400);
  const unscopedCancel = await fetch(`${server.url}/api/rooms/writers/cancel`, {
    method: "POST", headers: csrfHeaders, body: JSON.stringify({ taskId: "web-task" }),
  });
  assert.equal(unscopedCancel.status, 400);
  const invalidSwitch = await fetch(`${server.url}/api/rooms/writers/switch`, {
    method: "POST", headers: csrfHeaders, body: JSON.stringify({}),
  });
  assert.equal(invalidSwitch.status, 400);
  const invalidComplete = await fetch(`${server.url}/api/rooms/writers/complete`, {
    method: "POST", headers: csrfHeaders, body: JSON.stringify({}),
  });
  assert.equal(invalidComplete.status, 400);
  const delegateWriter = await fetch(`${server.url}/api/rooms/writers/delegate`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", taskId: "web-task", childProvider: "claude", label: "子實作" }),
  });
  const delegateWriterBody = (await delegateWriter.json()) as {
    delegation?: { id: string; access: string; workspace: string; displayName: string };
    error?: string;
  };
  assert.equal(delegateWriter.status, 201, JSON.stringify(delegateWriterBody));
  assert.equal(delegateWriterBody.delegation?.access, "write");
  assert.equal(delegateWriterBody.delegation?.workspace, grantWriterBody.lease?.worktree);
  const invalidDelegationRequests = [
    {},
    { room: "presence-demo", taskId: "web-task", delegationId: delegateWriterBody.delegation?.id, task: "ok", acceptanceCriteria: 5 },
    { room: "presence-demo", taskId: "wrong-task", delegationId: delegateWriterBody.delegation?.id, task: "ok" },
    { room: "presence-demo", taskId: "web-task", delegationId: "00000000-0000-4000-8000-000000000099", task: "ok" },
    { room: "missing-room", taskId: "web-task", delegationId: delegateWriterBody.delegation?.id, task: "ok" },
  ];
  for (const invalid of invalidDelegationRequests) {
    const response = await fetch(`${server.url}/api/rooms/writers/delegations/run`, {
      method: "POST", headers: csrfHeaders, body: JSON.stringify(invalid),
    });
    assert.equal(response.status, 400);
  }
  const invalidDelegateProvider = await fetch(`${server.url}/api/rooms/writers/delegate`, {
    method: "POST", headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", taskId: "web-task", childProvider: "fake", label: "bad" }),
  });
  assert.equal(invalidDelegateProvider.status, 400);
  const runDelegation = await fetch(`${server.url}/api/rooms/writers/delegations/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", delegationId: delegateWriterBody.delegation?.id,
      task: "在 child worktree 補測試", acceptanceCriteria: "不可轉派",
    }),
  });
  const runDelegationBody = (await runDelegation.json()) as { reply?: { author: string; text: string }; error?: string };
  assert.equal(runDelegation.status, 200, JSON.stringify(runDelegationBody));
  assert.equal(runDelegationBody.reply?.author, delegateWriterBody.delegation?.displayName);
  assert.match(runDelegationBody.reply?.text ?? "", /synthetic delegated checkpoint/u);
  assert.match(delegatedPrompts[0] ?? "", /shared parent Writer task worktree/u);
  assert.match(delegatedPrompts[0] ?? "", /may not redelegate/u);
  const failedDelegation = await fetch(`${server.url}/api/rooms/writers/delegations/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", delegationId: delegateWriterBody.delegation?.id,
      task: "FAIL_DELEGATED_AGENT", acceptanceCriteria: "失敗必須入帳",
    }),
  });
  assert.equal(failedDelegation.status, 400);
  assert.match(JSON.stringify(await failedDelegation.json()), /synthetic delegated failure/u);
  const crossProviderChild = await fetch(`${server.url}/api/rooms/writers/delegate`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", taskId: "web-task", childProvider: "codex", label: "唯讀審查" }),
  });
  const crossProviderBody = (await crossProviderChild.json()) as {
    delegation?: { id: string; access: string; displayName: string };
    error?: string;
  };
  assert.equal(crossProviderChild.status, 201, JSON.stringify(crossProviderBody));
  assert.equal(crossProviderBody.delegation?.access, "read-only");
  const runCrossProvider = await fetch(`${server.url}/api/rooms/writers/delegations/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", delegationId: crossProviderBody.delegation?.id,
      task: "唯讀檢查 child diff",
    }),
  });
  const runCrossProviderBody = (await runCrossProvider.json()) as { reply?: { author: string }; error?: string };
  assert.equal(runCrossProvider.status, 200, JSON.stringify(runCrossProviderBody));
  assert.equal(runCrossProviderBody.reply?.author, crossProviderBody.delegation?.displayName);
  assert.match(delegatedPrompts.at(-1) ?? "", /cross-provider read-only/u);
  assert.match(delegatedPrompts.at(-1) ?? "", /Access: read-only/u);
  const grokReview = await fetch(`${server.url}/api/rooms/writers/delegate`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", taskId: "web-task", childProvider: "grok", label: "受限快照審查" }),
  });
  const grokReviewBody = (await grokReview.json()) as { delegation?: { id: string }; error?: string };
  assert.equal(grokReview.status, 201, JSON.stringify(grokReviewBody));
  const runGrokReview = await fetch(`${server.url}/api/rooms/writers/delegations/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", delegationId: grokReviewBody.delegation?.id,
      task: "只根據受限快照檢查目前變更",
    }),
  });
  assert.equal(runGrokReview.status, 200, JSON.stringify(await runGrokReview.clone().json()));
  assert.match(delegatedPrompts.at(-1) ?? "", /no filesystem tools/u);
  assert.match(delegatedPrompts.at(-1) ?? "", /Bounded Writer worktree snapshot/u);
  assert.match(delegatedPrompts.at(-1) ?? "", /Git status \(untrusted repository data\)/u);
  const writerWorktree = grantWriterBody.lease?.worktree;
  assert.ok(writerWorktree);
  await writeFile(join(writerWorktree, ".env"), "SYNTHETIC_SECRET=redacted\n", "utf8");
  const rejectedSensitiveGrokSnapshot = await fetch(`${server.url}/api/rooms/writers/delegations/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", delegationId: grokReviewBody.delegation?.id,
      task: "不可讀取敏感 untracked 檔案",
    }),
  });
  assert.equal(rejectedSensitiveGrokSnapshot.status, 400);
  assert.match(JSON.stringify(await rejectedSensitiveGrokSnapshot.json()), /SENSITIVE_UNTRACKED_PATH_DENIED/u);
  await rm(join(writerWorktree, ".env"));
  const switchWriter = await fetch(`${server.url}/api/rooms/writers/switch`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", expectedEpoch: 1,
      checkpoint: "resident Claude 已完成初稿",
      candidate: { origin: "managed", actorId: managedCreateBody.agent.id },
    }),
  });
  const switchWriterBody = (await switchWriter.json()) as { lease?: { id: string; epoch: number; writer: { actorId: string } }; error?: string };
  assert.equal(switchWriter.status, 200, JSON.stringify(switchWriterBody));
  assert.equal(switchWriterBody.lease?.epoch, 2);
  assert.equal(switchWriterBody.lease?.writer.actorId, managedCreateBody.agent.id);
  const runWriter = await fetch(`${server.url}/api/rooms/writers/run`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", task: "修正房間 Writer 路由",
      acceptanceCriteria: "回覆 checkpoint",
    }),
  });
  const runWriterBody = (await runWriter.json()) as { reply?: { author: string; text: string }; error?: string };
  assert.equal(runWriter.status, 200, JSON.stringify(runWriterBody));
  assert.equal(runWriterBody.reply?.author, "claude（即時審查）");
  assert.match(runWriterBody.reply?.text ?? "", /synthetic Writer checkpoint/u);
  assert.match(writerPrompts[0] ?? "", /Writer Lease epoch: 2/u);
  assert.match(writerPrompts[0] ?? "", /Do not merge, delete, publish, or redelegate/u);
  const writerAudit = await fetch(`${server.url}/api/rooms/audit?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  const writerAuditBody = (await writerAudit.json()) as { chainValid: boolean; events: Array<{ type: string }> };
  assert.equal(writerAudit.status, 200);
  assert.equal(writerAuditBody.chainValid, true);
  assert.ok(writerAuditBody.events.some((event) => event.type === "writer.delegated"));
  const completeWriter = await fetch(`${server.url}/api/rooms/writers/complete`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", taskId: "web-task", epoch: 2, checkpoint: "完成" }),
  });
  const completeWriterBody = (await completeWriter.json()) as {
    preview?: { id: string; files: number; risk: { level: string } };
    confirmationPhrase?: string;
    error?: string;
  };
  assert.equal(completeWriter.status, 200, JSON.stringify(completeWriterBody));
  assert.equal(completeWriterBody.preview?.files, 0);
  assert.equal(completeWriterBody.preview?.risk.level, "low");
  /*
   * P0-2: the phrase the owner is shown has to be the phrase this endpoint accepts.
   * It travels with the preview instead of being spelled out a second time in the browser,
   * so there is no second copy that can drift away from the comparison below.
   */
  assert.equal(completeWriterBody.confirmationPhrase, APPLY_BACK_CONFIRMATION);
  const reviewReadyWriters = await fetch(`${server.url}/api/rooms/writers?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  const reviewReadyBody = (await reviewReadyWriters.json()) as { leases: Array<{ taskId: string; taskPhase: string }> };
  assert.ok(reviewReadyBody.leases.some((lease) =>
    lease.taskId === "web-task" && lease.taskPhase === "review-ready"));
  const wrongWriterApply = await fetch(`${server.url}/api/rooms/writers/apply-back/apply`, {
    method: "POST", headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", previewId: completeWriterBody.preview?.id,
      confirmation: "APPLY BACK TO SOURCE",
    }),
  });
  assert.equal(wrongWriterApply.status, 400);
  /*
   * The identifier-shaped phrase this path used to demand is now refused. It only ever proved
   * that the request body agreed with itself: the taskId inside the phrase was compared against
   * the taskId in the same body, which an owner never had to read anything to satisfy.
   */
  const retiredWriterPhrase = await fetch(`${server.url}/api/rooms/writers/apply-back/apply`, {
    method: "POST", headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "web-task", previewId: completeWriterBody.preview?.id,
      confirmation: "APPLY WRITER web-task TO PROJECT",
    }),
  });
  assert.equal(retiredWriterPhrase.status, 400);
  assert.equal(
    ((await retiredWriterPhrase.json()) as { error?: string }).error,
    "APPLY_BACK_CONFIRMATION_MISMATCH",
  );
  const originalAppendSystem = RoomLedger.prototype.appendSystem;
  RoomLedger.prototype.appendSystem = function () {
    throw new Error("ROOM_LEDGER_LIMIT_REACHED");
  };
  let writerApply: Response;
  try {
    writerApply = await fetch(`${server.url}/api/rooms/writers/apply-back/apply`, {
      method: "POST", headers: csrfHeaders,
      body: JSON.stringify({
        room: "presence-demo", taskId: "web-task", previewId: completeWriterBody.preview?.id,
        /* Exactly what the endpoint handed the browser a few lines above — no second spelling. */
        confirmation: completeWriterBody.confirmationPhrase,
      }),
    });
  } finally {
    RoomLedger.prototype.appendSystem = originalAppendSystem;
  }
  assert.equal(writerApply.status, 200, JSON.stringify(await writerApply.clone().json()));
  const appliedWriters = await fetch(`${server.url}/api/rooms/writers?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  const appliedWriterBody = (await appliedWriters.json()) as { leases: Array<{ taskId: string; taskPhase: string }> };
  assert.equal(appliedWriterBody.leases.find((lease) => lease.taskId === "web-task")?.taskPhase, "applied");
  const applyAuditResponse = await fetch(`${server.url}/api/rooms/audit?room=presence-demo`, {
    headers: { Cookie: cookie },
  });
  const applyAuditBody = (await applyAuditResponse.json()) as { chainValid: boolean; events: Array<{ type: string }> };
  assert.equal(applyAuditResponse.status, 200);
  assert.equal(applyAuditBody.chainValid, true);
  const applyCompletedIndex = applyAuditBody.events.findIndex((event) => event.type === "writer.apply-back-completed");
  const noticeSkippedIndex = applyAuditBody.events.findIndex(
    (event) => event.type === "writer.apply-back-ledger-notification-skipped",
  );
  assert.ok(applyCompletedIndex >= 0);
  assert.ok(noticeSkippedIndex > applyCompletedIndex);
  const managedArchive = await fetch(`${server.url}/api/rooms/managed-agents/archive`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", agentId: managedCreateBody.agent.id }),
  });
  assert.equal(managedArchive.status, 200);
  const standbyRevoke = await fetch(`${server.url}/api/rooms/presence/standby/revoke`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(standbyRevoke.status, 200);
  const standbyRevokeBody = (await standbyRevoke.json()) as {
    session: { standbyRequested: boolean; standbyApproved: boolean; wakeable: boolean };
  };
  assert.equal(standbyRevokeBody.session.standbyRequested, false);
  assert.equal(standbyRevokeBody.session.standbyApproved, false);
  assert.equal(standbyRevokeBody.session.wakeable, false);
  const revokedPresencePost = await fetch(`${server.url}/api/rooms/presence/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, text: "撤銷後不可投遞" }),
  });
  assert.equal(revokedPresencePost.status, 400);
  assert.deepEqual(await revokedPresencePost.json(), { error: "TARGET_AGENT_STANDBY_NOT_APPROVED" });
  const crossRoomLeave = await fetch(`${server.url}/api/rooms/presence/leave`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "demo", presenceId: availableSession.id }),
  });
  assert.equal(crossRoomLeave.status, 400);
  assert.deepEqual(await crossRoomLeave.json(), { error: "PRESENCE_NOT_JOINED" });
  const leavePresence = await fetch(`${server.url}/api/rooms/presence/leave`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id }),
  });
  assert.equal(leavePresence.status, 200);
  const leavePresenceBody = (await leavePresence.json()) as { session: Record<string, unknown> };
  assert.equal(leavePresenceBody.session.executionClass, "native-full-trust");
  assert.equal(leavePresenceBody.session.capabilityAuthority, "host");
  assert.equal(leavePresenceBody.session.hostCapabilities, "unchanged");
  const offlinePresencePost = await fetch(`${server.url}/api/rooms/presence/post`, {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ room: "presence-demo", presenceId: availableSession.id, text: "不可投遞" }),
  });
  assert.equal(offlinePresencePost.status, 400);
  assert.deepEqual(await offlinePresencePost.json(), { error: "TARGET_AGENT_OFFLINE" });
  presenceStore.close();

  const roomPage = await fetch(`${server.url}/room`);
  assert.equal(roomPage.status, 200);
  const roomHtml = await roomPage.text();
  assert.match(roomHtml, /Room 控制室/u);
  assert.match(roomHtml, /歷史紀錄/u);
  assert.match(roomHtml, /載入更早紀錄/u);
  assert.match(roomHtml, /id="office-floor"/u);
  assert.match(roomHtml, /href="\/styles\.css"/u);
  assert.match(roomHtml, /src="\/room\.js"/u);
  assert.match(roomHtml, /id="office-task-toggle"/u);
  assert.match(roomHtml, /id="office-notification-toggle"/u);
  assert.match(roomHtml, /id="office-theme-toggle"/u);
  assert.match(roomHtml, /id="office-quiet-toggle"/u);
  assert.match(roomHtml, /id="office-idle-toggle"/u);
  assert.match(roomHtml, /id="office-fullscreen-toggle"/u);
  assert.match(roomHtml, /id="agent-requests-open"/u);
  assert.match(roomHtml, /id="agent-request-count"/u);
  assert.match(roomHtml, /id="agent-requests-panel"/u);
  assert.match(roomHtml, /room_join_request/u);
  assert.match(roomHtml, /room_wait/u);
  assert.match(roomHtml, /Enter 兩次送出/u);
  assert.match(roomHtml, /⌘ Enter 立即送出/u);
  assert.match(roomHtml, /id="managed-agent-create"/u);
  assert.match(roomHtml, /受控即時 Agent/u);
  assert.match(roomHtml, /外接終端＝Native Full-Trust/u);
  assert.match(roomHtml, /不會改變 host 原有的 sandbox/u);
  assert.match(roomHtml, /待命，這也只控制協作收件，不是能力授權/u);
  assert.match(roomHtml, /GUI Managed/u);
  assert.match(roomHtml, /原生旁路無法攔截/u);
  assert.match(roomHtml, /id="writer-run-cancel"/u);
  assert.match(roomHtml, /共用目前任務草稿區並由系統序列執行/u);
  assert.doesNotMatch(roomHtml, /(?:src|href)="https?:\/\//u);
  const roomScriptResponse = await fetch(`${server.url}/room.js`);
  assert.equal(roomScriptResponse.status, 200);
  const roomScript = await roomScriptResponse.text();
  assert.match(roomScript, /const IDLE_ACTIVITIES = Object\.freeze\(\[/u);
  assert.match(roomScript, /function startIdleActivity\(/u);
  assert.match(roomScript, /function refreshOfficeControlPlane\(/u);
  assert.match(roomScript, /function refreshRoomCatalog\(/u);
  assert.match(roomScript, /function mentionLifecycle\(/u);
  assert.match(roomScript, /function installMacComposerKeyboard\(/u);
  assert.match(roomScript, /event\.isComposing/u);
  assert.match(roomScript, /event\.metaKey/u);
  assert.match(roomScript, /DOUBLE_ENTER_WINDOW_MS/u);
  assert.match(roomScript, /state\.polling/u);
  assert.match(roomScript, /document\.addEventListener\("visibilitychange"/u);
  assert.match(roomScript, /setInterval\(poll, 2000\)/u);
  assert.match(roomScript, /回應處理中/u);
  assert.match(roomScript, /件申請/u);
  assert.match(roomScript, /有申請/u);
  // Office desks are derived from the mirrored selection constant, not written
  // out again — test/provider-selection.test.ts pins that constant to the table.
  assert.match(roomScript, /const ROOM_RESIDENT_PROVIDER_IDS = Object\.freeze\(\["codex", "claude", "grok"\]\)/u);
  assert.match(roomScript, /const BASE_OFFICE_AGENTS = Object\.freeze\(\["you", \.\.\.ROOM_RESIDENT_PROVIDER_IDS\]\)/u);
  assert.match(roomScript, /function syncOfficeDesks\(/u);
  assert.match(roomScript, /value\.session/u);
  assert.match(roomScript, /filter\(\(entry\) => entry\.id !== value\.session\.id\)/u);
  assert.match(roomScript, /核准加入房間/u);
  assert.match(roomScript, /核准 room-wait 待命/u);
  assert.match(roomScript, /撤銷 room-wait 待命/u);
  assert.match(roomScript, /全程帳本協作/u);
  assert.match(roomScript, /Native Full-Trust · host 能力不變/u);
  assert.match(roomScript, /Native Full-Trust · host-controlled/u);
  assert.match(roomScript, /GUI Managed · 對話唯讀/u);
  assert.match(roomScript, /終端對話同步/u);
  assert.match(roomScript, /交辦會直接送到它手上/u);
  // 待命 means "approved for standby" everywhere else on this screen -- stage two, the approve and
  // revoke buttons -- and the badge exists to show the gap between that and actually listening. One
  // word cannot carry both halves of the distinction it is drawing.
  assert.match(roomScript, /text: "可交辦"/u);
  assert.doesNotMatch(roomScript, /text: "正在待命"/u);
  assert.match(roomScript, /交辦會進它的收件匣排隊，等它下次 room_wait/u);
  // The receipt now composes its label from the same state function instead of keeping a second
  // hand-written copy of the branches -- that copy collapsed two states into one line, directly under
  // a comment claiming there was one answer per state "where it cannot drift".
  assert.match(roomScript, /已排隊：\$\{targetState\.text\}/u);
  assert.match(roomScript, /const targetState = target \? seatListeningState\(target\) : undefined;/u);
  // Refused, not queued. A seat without standby authority throws TARGET_AGENT_STANDBY_NOT_APPROVED
  // before anything is enqueued, so telling the reader it will wait in a queue is simply false --
  // and that was the shape of the contradiction the first pass shipped.
  assert.match(roomScript, /還不能送，先在這裡按核准/u);
  assert.match(roomScript, /還不能送，它沒有待命授權/u);
  // The office is where work is actually handed over, so it has to answer the same question the
  // sidebar does. It used to say "可對話 · 待命" for a seat whose terminal had stopped asking.
  assert.match(roomScript, /怎麼辦：\$\{deskListening\.fix\}|怎麼辦：\$\{listening\.fix\}/u);

  /*
   * Wiring anchors. The pure-function test slices seatListeningState out of this file and runs it in
   * a bare context, so it cannot see a single caller: delete the three lines that put the state on
   * screen and every other assertion here still passes while the feature disappears.
   */
  // The office desk label, which is the most glanceable element on that view.
  assert.match(roomScript, /deskLabelState && deskLabelState\.key !== "listening"/u);
  // The composer hint, re-derived each poll and bound to the DELIVERY target rather than the visual
  // selection -- sending clears the target but leaves the selection, and keying off the selection
  // left the line claiming a route the next send would not take.
  assert.match(roomScript, /composer\?\.dataset\.presenceId === selectedSeat\.id/u);
  // The notification panel, where "② 待命已處理" used to cover both "approved" and "the request
  // lapsed and this seat can no longer be reached" -- opposite outcomes, and the second one is what
  // an owner who does not click within room_wait's 30s approval window gets.
  assert.match(roomScript, /seatState\?\.key === "no-standby"/u);
  assert.match(roomScript, /這個申請已經失效/u);
  assert.doesNotMatch(roomScript, /"② 待命已處理"/u);
  // Wording: 待命 is the authority, 收聽 is actually listening. The receipt and the titles have to
  // hold the same line the badge does.
  assert.doesNotMatch(roomScript, /"它正在待命，正在送過去"/u);

  /*
   * The nudge button. The owner asked for one that wakes a silent terminal; the protocol cannot
   * provide it, so this records the intention instead. Everything asserted here is about it not
   * reading as an action on the seat -- a button believed to have summoned help stops the owner from
   * looking for the reason help is not coming.
   */
  assert.match(roomScript, /presence-wake/u);
  assert.match(roomScript, /在帳本記一筆：我找過它/u);
  // Not a bell on THIS button: a bell reads as "summon" and would be the most conspicuous character in
  // the row, so the icon would contradict the label -- and an icon outranks a label. Scoped to the
  // assignment, because the file legitimately contains a bell elsewhere (the quiet-mode toggle) and
  // because the comment explaining this choice names the character it rejects.
  assert.doesNotMatch(roomScript, /wake\.textContent = "[^"]*🔔/u);
  // The disclaimer alone leaves "then why press it" unanswered, and a control with no stated purpose
  // gets assigned one by the person looking at it.
  assert.match(roomScript, /給你自己留個時間點/u, "the button must say what it is FOR, not only what it is not");
  assert.match(roomScript, /直接交辦——交辦會排隊等它/u, "and must point at the thing that does work");
  assert.match(roomScript, /這不會叫醒它/u);
  // Anchored to the guard itself, not to two strings being near each other. A proximity match proves
  // "a not-listening check appears within 400 characters", which is not the same as "the button is
  // built inside that check" -- and proximity assertions are exactly what this round replaced
  // elsewhere for saying more than they check.
  assert.match(
    roomScript,
    /if \(listening\.key === "not-listening"\) \{\s*\n\s*const wake = document\.createElement\("button"\);/u,
    "the button must be created inside the not-listening guard, not merely near one",
  );
  // Scope stated exactly: this scans room.js for a handful of Chinese phrasings that would read as
  // having woken or reached the seat. It is a tripwire for the obvious regressions, not a proof about
  // the whole product -- "已送達" or an equivalent claim in another file would sail past it.
  assert.doesNotMatch(roomScript, /已(喚|叫)醒|(喚|叫)醒了|已通知它|它已收到/u,
    "room.js must not use these phrasings, which read as having woken or reached the terminal");
  // The value proposition must not be a promise about the other end either: nothing delivers the
  // ledger to a returning seat -- room_wait and room_join_request carry no tail, and agents are told
  // to re-enter room_wait rather than to read.
  assert.doesNotMatch(roomScript, /下次上線時看到|一定會看到|它會看到/u,
    "the button may not promise the seat will read what was recorded");
  assert.match(roomScript, /也不保證它會去讀帳本/u);
  // The outcome sentence goes on screen, not into a tooltip: it is the whole point of the button,
  // and a tooltip is unreachable on touch and unreliable to a screen reader.
  assert.match(roomScript, /is-wake-notice/u);
  /*
   * Scoped to the silence it describes, and dropped when that silence ends. Left unscoped, the notice
   * survives the seat coming back and ends up sitting under a "可交辦" badge with the button and the
   * "怎麼辦" line already gone -- which reads as "I rang, and it came back", every time, and still
   * carries an instruction that would interrupt the wait the seat is now in.
   */
  // The "recorded" receipt is about an ongoing silence, so it goes when the silence does.
  assert.match(roomScript, /listening\.key === "not-listening" \? wakeEntry\.text : ""/u,
    "the recorded notice must not render once the seat is listening again");
  // The "already listening" receipt is about the CLICK, not the seat. Gating it on the seat being
  // silent made it unreachable -- the only way to produce it is the seat being listening -- which left
  // that path showing a vanishing button, a badge flipping to 可交辦, and no words at all.
  // Anchored to what the no-op branch is actually gated on -- elapsed time -- rather than to the
  // absence of a word nearby. A proximity check cannot tell "the noop branch is gated on
  // not-listening" from "the noop branch is followed by the recorded branch, which correctly is".
  assert.match(roomScript, /wakeEntry\.kind === "noop"\s*\?\s*\(Date\.now\(\) - wakeEntry\.at/u,
    "the no-op receipt is about the click, so it expires on time rather than on seat state");
  // Anchored to the PREDICATE, not to the presence of a delete. The earlier assertion only proved a
  // delete existed somewhere; the clearing set could have been anything -- and it was: `!listening` is
  // wider than the renderer's condition, so notices survived hidden on other states and came back.
  assert.match(roomScript, /seatListeningState\(session\)\.key === "not-listening"\)\.map/u,
    "clearing must use the same predicate the renderer uses, not an approximation of it");
  // The clearing side needs its own no-op branch too. Without it the receipt is deleted on the very
  // next refresh -- a listening seat is not in the still-silent set -- which is the same disappearing
  // act, moved from the renderer into the state. The renderer's anchor cannot catch that: it names
  // `wakeEntry`, and the clearing loop names `entry`.
  assert.match(roomScript, /entry\.kind === "noop"[\s\S]{0,160}WAKE_NOOP_NOTICE_MS/u,
    "the clearing loop must keep a no-op receipt until it expires, not until the seat is listening");
  /*
   * Three uses, one declaration, all naming the same constant -- asserted as three specific uses
   * rather than as a total count. A count was the first attempt and it broke immediately: writing a
   * comment that mentions the constant made it five, which is a legitimate edit failing a test for
   * measuring the wrong thing. What matters is that no site hardcodes its own literal, and these
   * three matches say exactly that.
   */
  assert.match(roomScript, /^const WAKE_NOOP_NOTICE_MS = /mu, "one declaration");
  assert.match(roomScript, /Date\.now\(\) - wakeEntry\.at < WAKE_NOOP_NOTICE_MS/u, "the renderer expires on it");
  assert.match(roomScript, /Date\.now\(\) - entry\.at >= WAKE_NOOP_NOTICE_MS/u, "the clearing loop expires on it");
  assert.match(roomScript, /\}, WAKE_NOOP_NOTICE_MS \+ 250\)/u, "and the repaint is scheduled from it");
  // And something has to repaint when it expires: this receipt only exists while the seat is
  // listening, that state then stops changing, and the panel re-renders only on a presence change.
  assert.match(roomScript, /state\.wakeNoticeTimers\[session\.id\] = setTimeout/u,
    "one repaint timer per seat: a shared one let a second seat's click cancel the first seat's repaint");
  // A nudge changes nothing about the seat, so it must not reorder the list the way the handlers that
  // DO change something legitimately can -- their reordering is undone by the next refresh, and this
  // one's never would be.
  // Counted, not measured by proximity: the mutant that adds the splice back lands past any window
  // small enough to be meaningful, so a nearby-text check silently passes. Two handlers legitimately
  // re-insert a session (join and standby/membership); a third occurrence means the nudge grew one.
  assert.equal(
    (roomScript.match(/state\.presences = \[\.\.\.(\(state\.presences \|\| \[\]\)|state\.presences)\.filter/gu) ?? []).length,
    2,
    "only handlers that actually change server state may re-insert a session (count includes join and standby/membership; update this number when adding a legitimate one)",
  );
  // It must still ADOPT the returned session, in place. On the no-op path the click has just proved
  // the row is stale -- the seat is listening and the badge says it is not -- and refreshPresence is
  // throttled to five seconds, so discarding the server's answer leaves the receipt contradicting the
  // badge beside it for that long.
  assert.match(
    roomScript,
    /state\.presences = \(state\.presences \|\| \[\]\)\.map\(\(entry\) => \(entry\.id === value\.session\.id \? value\.session : entry\)\)/u,
    "the nudge must adopt the returned session without reordering the list",
  );
  // The repaint timer belongs to the no-op receipt only. The recorded one expires when the seat stops
  // being silent, which is already a presence change; scheduling a rebuild for it would drop any open
  // select and the focus in it for nothing.
  assert.match(roomScript, /if \(value\.listening\) \{[\s\S]{0,800}state\.wakeNoticeTimers\[session\.id\] = setTimeout/u,
    "the repaint timer must sit under the listening branch (proximity check: it proves the two appear together, not that the nesting is exactly this)");
  // Anchored to the ASSIGNMENT, not to the words: the comment that explains why this line was
  // removed quotes the old string, and a bare substring check would fail on the explanation itself.
  assert.doesNotMatch(roomScript, /:\s*"可對話 · 待命";/u, "the office must not call a deaf seat 待命");
  assert.match(roomScript, /selectedPresenceId/u);
  assert.match(roomScript, /managedAgentId/u);
  assert.match(roomScript, /\/api\/rooms\/managed-agents\/mention/u);
  assert.match(roomScript, /\/api\/rooms\/writers\/cancel/u);
  assert.match(roomScript, /function offlineExternalMention\(/u);
  assert.match(roomScript, /taskPhase === "applied"/u);
  assert.match(roomScript, /classList\.add\("real-busy"/u);
  assert.match(roomScript, /function renderAgentCard\(/u);
  assert.match(roomScript, /requestFullscreen/u);
  assert.match(roomScript, /office-pet pet-cat/u);
  assert.match(roomScript, /office-pet pet-dino/u);
  assert.match(roomScript, /document\.hidden/u);
  assert.doesNotMatch(roomScript, /localStorage/u);
  // Room errors are translated inline; no blocking native dialog may report them.
  assert.doesNotMatch(roomScript, /\balert\(/u);
  assert.match(roomScript, /function humanError\(/u);
  assert.match(roomScript, /function showRoomError\(/u);
  assert.match(roomScript, /TARGET_AGENT_STANDBY_NOT_APPROVED:/u);
  assert.match(roomScript, /conn-action/u);
  assert.match(roomScript, /核准 \$\{target\.displayName \|\| target\.provider\} 的 room-wait 待命/u);
  // The status indicator must not keep claiming 直播中 while polling is suspended.
  assert.match(roomScript, /已暫停（分頁在背景）/u);
  assert.match(roomScript, /補抓中…/u);
  assert.match(roomScript, /function setConnectionState\(/u);
  // A lease waiting for apply-back must survive a freshly generated task id.
  assert.match(roomScript, /ready\.find\(\(lease\) => lease\.taskId === taskId\) \|\| ready\[0\]/u);
  assert.match(roomScript, /terminal\.find\(\(lease\) => lease\.taskId === taskId\) \|\| terminal\[0\]/u);
  assert.match(roomScript, /function pendingWriterLease\(/u);
  assert.match(roomScript, /pendingWriterLease\(\)\?\.taskId \|\| `task-\$\{Date\.now\(\)\.toString\(36\)\}`/u);
  // Completing a Writer revokes access, so the button says so and confirms once inline.
  assert.match(roomScript, /結束並 apply-back/u);
  assert.match(roomScript, /再按一次：結束 Writer 並撤銷寫入權/u);
  assert.match(roomScript, /writerCompleteConfirm/u);
  assert.match(roomScript, /階段 1／2（結束 Writer）失敗/u);
  assert.match(roomScript, /階段 2／2（apply-back 主專案）失敗/u);

  // ── P0-2: the Writer apply-back approval is an in-page dialog, not window.prompt ──
  // A native prompt can be silenced for good (it then returns null and the approval UI fails
  // silently), it truncates the phrase printed under a long change list, and it freezes the page
  // while a 120s preview TTL runs out underneath it. One dialog answers all three.
  const writerDialogStart = roomScript.indexOf("writer apply-back approval dialog");
  const writerDialogEnd = roomScript.indexOf("merge-into-main approval dialog");
  assert.ok(writerDialogStart > 0, "room.js must carry the writer apply-back approval dialog");
  assert.ok(writerDialogEnd > writerDialogStart, "the writer dialog must precede the merge dialog");
  // Bounded on both sides: the merge dialog below legitimately spells out its own phrase, and
  // an unbounded slice would let the writer dialog hide its own hard-coded copy behind it.
  const writerDialogScript = roomScript.slice(writerDialogStart, writerDialogEnd);
  assert.doesNotMatch(writerDialogScript, /window\.(?:alert|confirm|prompt)\s*\(/u);
  assert.doesNotMatch(writerDialogScript, /(?<![.\w])(?:alert|confirm|prompt)\s*\(/u);
  // Ceiling, not a spot check: the one remaining native dialog in room.js is the chat-consent
  // confirm, a separate finding. A second one anywhere in this file must fail this test.
  assert.equal((roomScript.match(/window\.(?:alert|confirm|prompt)\s*\(/gu) ?? []).length, 1);
  // The phrase is never spelled out in the browser: it arrives with the preview and is printed,
  // compared and sent back unchanged, so no second copy exists to drift from the endpoint.
  assert.doesNotMatch(writerDialogScript, /"APPLY WRITER|APPLY BACK TO SOURCE|MERGE INTO MAIN/u);
  assert.match(writerDialogScript, /typeof prepared\.confirmationPhrase === "string" \? prepared\.confirmationPhrase : ""/u);
  assert.match(writerDialogScript, /byId\("writer-apply-back-phrase"\)\.textContent = view\.phrase;/u);
  assert.match(writerDialogScript, /if \(!view\.phrase \|\| input\.value !== view\.phrase\) return;/u);
  assert.match(writerDialogScript, /const confirmation = input\.value;/u);
  assert.match(roomScript, /phrase = typeof value\.confirmationPhrase === "string" \? value\.confirmationPhrase : "";/u);
  // Scroll-gate wired to both scroll and details toggle, plus the type-to-enable input.
  assert.match(writerDialogScript, /byId\("writer-apply-back-diff"\)\.addEventListener\("scroll"/u);
  assert.match(writerDialogScript, /byId\("writer-apply-back-diff"\)\.addEventListener\("toggle"/u);
  assert.match(writerDialogScript, /if \(input\.value !== gate\.inputValue\) input\.value = gate\.inputValue;/u);
  assert.match(writerDialogScript, /input\.disabled = gate\.inputDisabled;/u);
  assert.match(writerDialogScript, /confirmButton\.disabled = gate\.confirmDisabled;/u);
  // The countdown a native prompt could never show, and the blocking section above the content.
  assert.match(writerDialogScript, /setInterval\(tickWriterApplyBackTtl, 1000\)/u);
  assert.match(writerDialogScript, /已逾時 · expired/u);
  assert.match(writerDialogScript, /blocking\.hidden = view\.blockers\.length === 0;/u);
  assert.match(writerDialogScript, /byId\("writer-apply-back-cancel"\)\.focus\(\);/u);
  // Risk reasons one by one, the change content itself, and every change listed rather than 24.
  assert.match(writerDialogScript, /preview\.risk\.reasons/u);
  assert.match(writerDialogScript, /kind=diff/u);
  assert.match(writerDialogScript, /看不到要寫回什麼就不可核准/u);
  assert.doesNotMatch(roomScript, /筆變更未列出/u);
  assert.doesNotMatch(roomScript, /allChanges\.slice\(0, 24\)/u);
  // A refused apply-back discards the preview so the whole gate has to be passed again.
  assert.match(writerDialogScript, /view\.preview = null;\n {4}view\.diffState = "idle";/u);
  // Recovery is read-only here: after a crash the product has no first-hand observation, so the
  // command it hands over must not be able to destroy more than the failure already did. Bounded to
  // the function that builds that command — the prose elsewhere names the verbs it is avoiding, and
  // an unbounded search would be answered by the comment rather than by the command.
  const recoveryBody = /^function renderWriterApplyBackRecovery\([\s\S]*?^\}$/mu.exec(writerDialogScript);
  assert.ok(recoveryBody, "the writer dialog must build its own recovery command");
  assert.doesNotMatch(recoveryBody[0], /reset --hard|clean|stash|checkout|\brm\b|--force|-f\b/u);
  assert.match(recoveryBody[0], /git -C \$\{target\} status --short/u);
  assert.match(recoveryBody[0], /ls \$\{WRITER_APPLY_BACK_TRASH_ROOT\}/u);
  // It reuses the existing .workspace-onboarding / .merge-approval component, not a new one.
  assert.match(writerDialogScript, /"workspace-onboarding merge-approval"/u);
  assert.match(writerDialogScript, /"workspace-onboarding-card merge-approval-card"/u);
  // Join and standby render as one progressive card with the approve button in place.
  assert.match(roomScript, /presence-stages/u);
  assert.match(roomScript, /① 已加入房間/u);
  assert.match(roomScript, /② 待命待核准/u);
  assert.match(roomScript, /office-notification-action/u);
  assert.match(roomScript, /standby-approve/u);
  assert.match(roomHtml, /id="writer-complete" type="button" disabled>結束並 apply-back/u);
  const appScriptResponse = await fetch(`${server.url}/app.js`);
  assert.equal(appScriptResponse.status, 200);
  const appScript = await appScriptResponse.text();
  // Cancelling the dirty-snapshot confirmation must restore the proposal card.
  assert.match(appScript, /function restoreProposalCard\(/u);
  assert.match(appScript, /const snapshotApproved = Boolean\(snapshot\) && window\.confirm\(/u);
  assert.match(appScript, /已取消，主專案與安全分支都沒有變更。/u);

  // ── P0-3: the main-workspace apply-back must carry the same friction as room.js ──
  // The old flow wrote into the main project behind a single window.confirm: no risk level,
  // no change content, no phrase. Two write-into-main paths, one strict and one loose, damage
  // trust more than either level of strictness on its own.
  assert.doesNotMatch(appScript, /協作完成，是否把安全分支套用回主專案/u);
  assert.doesNotMatch(appScript, /confirmation: "APPLY BACK TO SOURCE"/u);
  // Ceiling, not a spot check: the three remaining native confirms are other findings
  // (chat consent, run consent, dirty-snapshot import). A fourth one must fail this test.
  assert.equal((appScript.match(/window\.confirm\(/gu) ?? []).length, 3);
  // The highest-risk dialog must not open itself and burn the 120s preview TTL unasked.
  assert.doesNotMatch(appScript, /setTimeout\(\(\) => \{ void card\.autoApplyBack/u);
  assert.match(appScript, /要寫回主專案時按「套用回主專案」/u);

  const applyBackStart = appScript.indexOf("apply-back approval dialog (main workspace)");
  assert.ok(applyBackStart > 0, "app.js must carry the main-workspace apply-back approval dialog");
  const applyBackScript = appScript.slice(applyBackStart);
  // No native dialog may gate this path either: they can be permanently silenced, they freeze
  // the page, and a TTL countdown is physically impossible underneath them.
  assert.doesNotMatch(applyBackScript, /window\.(?:alert|confirm|prompt)\s*\(/u);
  assert.doesNotMatch(applyBackScript, /(?<![.\w])(?:alert|confirm|prompt)\s*\(/u);
  // Same semantic phrase as room.js, bilingual, carrying no identifier to transcribe.
  assert.match(applyBackScript, /const APPLY_BACK_CONFIRMATION_PHRASE = "MERGE INTO MAIN";/u);
  // P0-2: the sentence the owner types is the sentence that goes on the wire. The dialog used to
  // ask for one phrase and send a different constant, so the phrase the endpoint compared against
  // was one nobody had ever typed. There is no wire-only constant left to declare or substitute —
  // checked at the declaration and inside the function that sends, because the comment explaining
  // the removal names the constant and would otherwise answer an unbounded search for it.
  assert.doesNotMatch(appScript, /const APPLY_BACK_API_CONFIRMATION\s*=/u);
  const confirmApplyBackBody = /^async function confirmApplyBack\([\s\S]*?^\}$/mu.exec(applyBackScript);
  assert.ok(confirmApplyBackBody, "app.js must still carry confirmApplyBack()");
  assert.doesNotMatch(confirmApplyBackBody[0], /APPLY_BACK_API_CONFIRMATION|APPLY BACK TO SOURCE|MERGE INTO MAIN/u);
  assert.match(confirmApplyBackBody[0], /if \(!view\.phrase \|\| input\.value !== view\.phrase\) return;/u);
  assert.match(confirmApplyBackBody[0], /body: JSON\.stringify\(\{ previewId, confirmation \}\)/u);
  assert.match(applyBackScript, /view\.phrase = typeof prepared\.confirmationPhrase === "string" \? prepared\.confirmationPhrase : "";/u);
  assert.match(applyBackScript, /byId\("apply-back-phrase"\)\.textContent = view\.phrase \|\| "";/u);
  // The phrase going missing is a blocking item, not a silent fall back to the copy still sitting
  // in applyBackGate()'s signature — that fallback is unreachable only because this line exists.
  assert.match(applyBackScript, /view\.blockers\.push\("後端沒有給這次回寫的確認短語/u);
  // Risk reasons are listed one by one; a bare level would hide a 200-file overwrite.
  assert.match(applyBackScript, /preview\.risk\.reasons/u);
  assert.match(applyBackScript, /風險原因 · Risk reason/u);
  // Scroll-gate plus the type-to-enable input, wired to both scroll and details toggle.
  assert.match(applyBackScript, /byId\("apply-back-diff"\)\.addEventListener\("scroll"/u);
  assert.match(applyBackScript, /byId\("apply-back-diff"\)\.addEventListener\("toggle"/u);
  assert.match(applyBackScript, /if \(input\.value !== gate\.inputValue\) input\.value = gate\.inputValue;/u);
  assert.match(applyBackScript, /input\.disabled = gate\.inputDisabled;/u);
  assert.match(applyBackScript, /confirmButton\.disabled = gate\.confirmDisabled;/u);
  // Blocking section above the change content, TTL countdown, cancel takes default focus.
  assert.match(applyBackScript, /blocking\.hidden = view\.blockers\.length === 0;/u);
  assert.match(applyBackScript, /setInterval\(tickApplyBackTtl, 1000\)/u);
  assert.match(applyBackScript, /已逾時 · expired/u);
  assert.match(applyBackScript, /byId\("apply-back-cancel"\)\.focus\(\);/u);
  // The change content itself, and a failure to load it is a blocker rather than a hint.
  assert.match(applyBackScript, /kind=diff/u);
  assert.match(applyBackScript, /看不到要寫回什麼就不可核准/u);
  // A refused apply-back discards the preview so the whole gate has to be passed again.
  assert.match(applyBackScript, /view\.preview = null;\n {4}view\.diffState = "idle";/u);
  // It reuses the existing .workspace-onboarding / .merge-approval component, not a new one.
  assert.match(applyBackScript, /"workspace-onboarding merge-approval"/u);
  assert.match(applyBackScript, /"workspace-onboarding-card merge-approval-card"/u);
  const roomStylesResponse = await fetch(`${server.url}/styles.css`);
  assert.equal(roomStylesResponse.status, 200);
  const roomStyles = await roomStylesResponse.text();
  assert.match(roomStyles, /\.desk\.real-busy::after/u);
  assert.match(roomStyles, /\.office\.outcome-completed/u);
  assert.match(roomStyles, /\.office\.day-mode/u);
  assert.match(roomStyles, /@keyframes cat-office-roam/u);
  assert.match(roomStyles, /@keyframes dino-office-roam/u);
  assert.match(roomStyles, /@keyframes cat-leg-forward/u);
  assert.match(roomStyles, /@keyframes cat-leg-backward/u);
  assert.match(roomStyles, /@keyframes dino-leg-forward/u);
  assert.match(roomStyles, /@keyframes dino-leg-backward/u);
  assert.match(roomScript, /cat-leg-front-near/u);
  assert.match(roomScript, /dino-leg-near/u);
  assert.match(roomStyles, /\.conn\.paused/u);
  assert.match(roomStyles, /\.conn \.conn-action/u);
  assert.match(roomStyles, /\.presence-stage\.is-waiting/u);
  assert.match(roomStyles, /\.office-notification-action/u);
  // The apply-back dialog shares the merge-approval rules instead of duplicating them.
  assert.match(roomStyles, /#merge-approval-confirm-area, #apply-back-confirm-area/u);
  assert.match(roomStyles, /#merge-approval-confirmation, #apply-back-confirmation/u);
  assert.match(roomStyles, /#merge-approval-restore, #apply-back-restore/u);
  assert.match(roomStyles, /\.apply-back-diff-text/u);

  // ── Phase 5-3 bar item 6: the merge-into-main approval dialog ──────────────
  // The highest-risk pending action gets the same global count badge as agent requests.
  assert.match(roomHtml, /id="merge-approvals-open"/u);
  assert.match(roomHtml, /id="merge-approval-count" aria-label="0 件待核准">0</u);
  assert.match(roomHtml, /class="agent-requests-open merge-approvals-open"/u);
  // The pending-approval button stays in the topbar at 0 (neutral, disabled) instead of appearing on demand.
  assert.doesNotMatch(roomHtml, /id="merge-active-task"/u);
  assert.match(roomHtml, /<span>⑂ <span class="merge-nav-full">待核准<\/span><span class="merge-nav-short">待核<\/span><\/span><b id="merge-approval-count"/u);
  assert.doesNotMatch(roomHtml, /id="merge-approvals-open"[^>]*\sdisabled/u);
  assert.match(roomHtml, /id="merge-history-open"/u);
  assert.match(roomHtml, /▤ 併入紀錄/u);
  assert.match(roomHtml, /id="merge-records-attention" class="merge-records-attention" hidden/u);
  assert.match(roomHtml, /需檢查</u);
  assert.match(roomHtml, /稽核紀錄（不是待辦）/u);
  assert.doesNotMatch(roomHtml, /id="merge-history-count"/u);
  assert.doesNotMatch(roomHtml, /id="merge-history-other-open"/u);
  assert.match(roomHtml, /id="merge-outcome-nav-status"[^>]*aria-live="polite"/u);
  assert.match(roomHtml, /id="merge-history-merged-list"/u);
  assert.match(roomHtml, /id="merge-history-review-list"/u);
  assert.match(roomHtml, /id="merge-history-unpromoted-list"/u);
  assert.match(roomHtml, /DURABLE OUTCOME ARCHIVE/u);
  assert.match(roomHtml, /關閉紀錄</u);
  assert.doesNotMatch(roomHtml, />完成 · Done</u);
  assert.match(
    roomStyles,
    /\.app \{ grid-template-columns: 1fr; grid-template-rows: auto 100vh; height: auto; min-height: 100vh; \}/u,
  );
  // It reuses the .workspace-onboarding dialog component as a variant, not a new design language.
  assert.match(
    roomHtml,
    /<section id="merge-approval" class="workspace-onboarding merge-approval" hidden role="dialog" aria-modal="true" aria-labelledby="merge-approval-title">/u,
  );
  assert.match(roomHtml, /class="workspace-onboarding-card merge-approval-card"/u);
  // Layout, top to bottom: header, blocking section above the diff, diff, recovery, TTL, actions.
  assert.match(roomHtml, /id="merge-approval-risk"/u);
  assert.match(roomHtml, /id="merge-approval-task"/u);
  assert.match(roomHtml, /草稿版 → 正式版 main/u);
  assert.match(roomHtml, /id="merge-approval-risks"/u);
  assert.match(roomHtml, /<b>無法核准<\/b>/u);
  assert.match(
    roomHtml,
    /一般阻擋項目不會鎖住輸入，但逾時／終局核准不能復活。/u,
  );
  assert.match(roomHtml, /id="merge-approval-repreview" type="button">↻ 重新產生預覽</u);
  // The scroll-gated region holds the promotion disclosure BEFORE the file list, so its label has
  // to say so: the owner is being asked to scroll past what would run, not only past the diff.
  assert.match(roomHtml, /這次併入會執行什麼、覆蓋什麼，以及變更檔案（預設收合，請捲到底）/u);
  assert.match(roomHtml, /id="merge-approval-diff-label"/u);
  assert.match(roomHtml, /id="merge-approval-diff"/u);
  assert.match(roomHtml, /id="merge-approval-diff"[^>]*tabindex="0"[^>]*aria-describedby="merge-approval-scroll-hint"/u);
  assert.match(roomHtml, /<b>還原點<\/b>/u);
  assert.match(roomHtml, /id="merge-approval-restore"/u);
  assert.match(roomHtml, /⧉ 複製還原指令</u);
  assert.match(roomHtml, /核准視窗剩餘</u);
  assert.match(roomHtml, /id="merge-approval-refresh" type="button">↻ 重新產生預覽</u);
  // Static HTML ships fail-closed; renderMergeApproval enables the field for a live pending row.
  assert.match(roomHtml, /id="merge-approval-confirmation" type="text" maxlength="64" autocomplete="off" spellcheck="false" aria-describedby="merge-approval-confirmation-feedback" disabled/u);
  assert.match(roomHtml, /id="merge-approval-confirmation-feedback" class="merge-confirmation-feedback" aria-live="polite"/u);
  assert.match(roomHtml, /<code id="merge-approval-phrase">MERGE INTO MAIN<\/code>/u);
  assert.match(roomHtml, /可先輸入/u);
  assert.match(roomHtml, /捲完內層變更清單且沒有阻擋項目後，最終按鈕才解鎖/u);
  // Cancel takes default focus; the merge button is the only primary and is styled danger.
  assert.match(roomHtml, /id="merge-approval-cancel" type="button">取消</u);
  assert.match(roomHtml, /id="merge-approval-confirm" class="danger" type="button" aria-disabled="true" aria-describedby="merge-approval-scroll-hint merge-approval-confirmation-feedback merge-approval-status" disabled>核准併入 main</u);
  assert.match(roomHtml, /id="merge-approval-reject" type="button">拒絕並保留草稿版</u);
  assert.doesNotMatch(roomHtml, /id="merge-approval-confirm"[^>]*class="[^"]*primary/u);

  const mergeDialogStart = roomScript.indexOf("merge-into-main approval dialog");
  assert.ok(mergeDialogStart > 0, "room.js must carry the merge-into-main approval dialog");
  const mergeDialogScript = roomScript.slice(mergeDialogStart);
  // D-001: no native dialog may ever gate the highest-risk action — they can be silenced,
  // they freeze the page, and a TTL countdown is physically impossible underneath them.
  assert.doesNotMatch(mergeDialogScript, /window\.(?:alert|confirm|prompt)\s*\(/u);
  assert.doesNotMatch(mergeDialogScript, /(?<![.\w])(?:alert|confirm|prompt)\s*\(/u);
  // The phrase is exact, semantic and carries no taskId; the backend value wins if it differs.
  assert.match(mergeDialogScript, /const MERGE_CONFIRMATION_PHRASE = "MERGE INTO MAIN";/u);
  assert.match(mergeDialogScript, /state\.mergeConfirmationPhrase = value\.confirmationPhrase/u);
  // Scroll-gate: bottom of the diff AND an empty blocking section, then type-to-enable.
  assert.match(mergeDialogScript, /function mergeDiffScrolledToBottom\(/u);
  assert.match(mergeDialogScript, /region\.scrollTop \+ region\.clientHeight >= region\.scrollHeight - 4/u);
  assert.match(mergeDialogScript, /function mergeApprovalGate\(/u);
  assert.match(mergeDialogScript, /input\.disabled = gate\.inputDisabled;/u);
  assert.match(mergeDialogScript, /input\.setAttribute\("aria-invalid", String\(gate\.ariaInvalid\)\);/u);
  assert.match(mergeDialogScript, /confirm\.disabled = gate\.inputDisabled \|\| state\.mergeApprovalSubmitting;/u);
  assert.match(mergeDialogScript, /confirm\.setAttribute\("aria-disabled", String\(gate\.confirmDisabled \|\| state\.mergeApprovalSubmitting\)\);/u);
  assert.match(mergeDialogScript, /function handleMergeApprovalPrimaryIntent\(/u);
  assert.match(mergeDialogScript, /function handleMergeApprovalConfirmationKeydown\(/u);
  assert.match(mergeDialogScript, /event\.key !== "Enter" \|\| event\.isComposing \|\| event\.keyCode === 229/u);
  assert.match(mergeDialogScript, /focusMergeApprovalRequirement\(byId\("merge-approval-confirm"\)\)/u);
  assert.match(mergeDialogScript, /尚未送出、尚未 Merge。確認短語與閱讀條件已完成/u);
  assert.match(mergeDialogScript, /if \(target === "submit"\) \{\s+await approveMergeIntoMain\(\);/u);
  assert.match(mergeDialogScript, /target === "diff"/u);
  assert.match(mergeDialogScript, /focusMergeApprovalRequirement\(byId\("merge-approval-diff"\)\)/u);
  assert.match(mergeDialogScript, /尚未送出、尚未 Merge。已將焦點移到內層深色變更清單/u);
  assert.match(
    mergeDialogScript,
    /byId\("merge-approval-confirm"\)\.addEventListener\("click", \(\) => void handleMergeApprovalPrimaryIntent\(\)\);/u,
  );
  assert.match(mergeDialogScript, /if \(state\.mergeApprovalSubmitting\) \{/u);
  assert.match(mergeDialogScript, /state\.mergeApprovalSubmitting = true;\s+confirm\.disabled = true;/u);
  assert.match(mergeDialogScript, /finally \{\s+state\.mergeApprovalSubmitting = false;/u);
  assert.match(mergeDialogScript, /status\.textContent = "";\s+requestAnimationFrame/u);
  assert.match(mergeDialogScript, /byId\("merge-approval-diff"\)\.addEventListener\("scroll"/u);
  assert.match(mergeDialogScript, /byId\("merge-approval-diff"\)\.addEventListener\("toggle"/u);
  assert.match(
    mergeDialogScript,
    /byId\("merge-approval-confirmation"\)\.addEventListener\("input", \(\) => \{\s+clearMergeApprovalIntentGuide\(\);\s+updateMergeApprovalGate\(\);/u,
  );
  // Blocking section: conflicts, every truncation flag and an invalid binding keep it disabled.
  assert.match(mergeDialogScript, /function mergeApprovalBlockers\(/u);
  assert.match(mergeDialogScript, /binding\.valid === false/u);
  // A binding check that could not run is reported as such, never as "the bound values changed".
  assert.match(mergeDialogScript, /if \(binding && binding\.unavailable\)/u);
  assert.match(mergeDialogScript, /無法比對綁定值/u);
  assert.match(mergeDialogScript, /preview\.mergeable === false/u);
  assert.match(mergeDialogScript, /preview\.mergeConflictsTruncated/u);
  assert.match(mergeDialogScript, /preview\.filesTruncated/u);
  assert.match(mergeDialogScript, /preview\.submodulesTruncated/u);
  assert.match(mergeDialogScript, /preview\.largeFileScanTruncated/u);
  assert.match(mergeDialogScript, /blockingSection\.hidden = blockers\.length === 0;/u);
  assert.match(mergeDialogScript, /function repreviewMergeApproval\(/u);
  assert.match(mergeDialogScript, /function retryMergeApprovalWithFreshSnapshot\(/u);
  assert.match(mergeDialogScript, /\/api\/rooms\/merge-approvals\/retry/u);
  assert.match(mergeDialogScript, /state\.mergeApprovalInputApprovalId = ""/u);
  assert.match(mergeDialogScript, /await loadMergeApproval\(fresh\.id\)/u);
  assert.match(mergeDialogScript, /舊核准.*保持終局/u);
  // Mode changes, submodules and opaque files are marked as such, not as ordinary edits.
  assert.match(mergeDialogScript, /模式變更 \$\{file\.mode\.from\} → \$\{file\.mode\.to\}，不是一般檔案編輯/u);
  assert.match(mergeDialogScript, /Submodule 指標變更，不是一般檔案編輯/u);
  assert.match(mergeDialogScript, /二進位／過大：無法顯示，將整檔取代/u);
  assert.match(mergeDialogScript, /\["二進位", /u);
  // Recovery point: base SHA, the recovery ref and a one-click-copy restore command.
  assert.match(mergeDialogScript, /\["基準 main", binding\.baseMainHead\]/u);
  assert.match(mergeDialogScript, /還原點 ref/u);
  assert.match(mergeDialogScript, /navigator\.clipboard\.writeText/u);
  assert.match(mergeDialogScript, /git -C \$\{mainPath\} rev-parse \$\{ref\}/u);
  // TTL countdown, which window.prompt made physically impossible.
  assert.match(mergeDialogScript, /function formatCountdown\(/u);
  assert.match(mergeDialogScript, /setInterval\(tickMergeApprovalTtl, 1000\)/u);
  assert.match(mergeDialogScript, /"已逾時"/u);
  // Expiry while the owner is typing or scrolling is composed, not merely styled: the ticker marks
  // the exact approval expired and synchronously re-renders; updateMergeApprovalGate receives that
  // bit and the pure gate clears/locks the input. A stale client click remains server-refused.
  assert.match(mergeDialogScript, /approval\.expired = true;\s+renderMergeApproval\(\);/u);
  assert.match(mergeDialogScript, /expired: state\.mergeApproval\?\.expired === true/u);
  assert.match(mergeDialogScript, /if \(!approval \|\| \(state\.mergeApprovalBlockers \|\| \[\]\)\.length > 0 \|\| !state\.mergeApprovalScrolled\)/u);
  // The digest sent on approve is the one that was rendered; inspect stays read-only polling.
  assert.match(mergeDialogScript, /previewDigest: approval\.previewDigest,/u);
  assert.match(mergeDialogScript, /\/api\/rooms\/merge-approvals\/approve/u);
  assert.match(mergeDialogScript, /\/api\/rooms\/merge-history\?room=/u);
  assert.match(mergeDialogScript, /\/api\/rooms\/merge-approvals\/inspect\?room=/u);
  assert.match(mergeDialogScript, /setInterval\(\(\) => void repollMergeApproval\(\), 5000\)/u);
  // A no-op poll must not re-render: rebuilding the diff would reset the scroll position and
  // silently close a scroll-gate the owner had already passed.
  assert.match(mergeDialogScript, /function mergeApprovalSignature\(/u);
  assert.match(
    mergeDialogScript,
    /=== mergeApprovalSignature\(approval, state\.mergeApprovalBinding, state\.mergeApprovalOverwrites\)\) return;/u,
  );
  // Clicking the final control now performs the promotion. Success is only rendered from the
  // durable state plus the independent authorized-merge observation; approval alone is insufficient.
  assert.match(mergeDialogScript, /function mergeHistorySucceeded\(/u);
  assert.match(mergeDialogScript, /entry\?\.state === "applied"/u);
  assert.match(mergeDialogScript, /entry\?\.observation\?\.authorizedMergeCommit === true/u);
  assert.match(mergeDialogScript, /value\.mainMutated === true/u);
  assert.match(mergeDialogScript, /✓ 併入成功/u);
  assert.match(mergeDialogScript, /function returnToRoomAfterSuccessfulMerge\(\)/u);
  assert.match(mergeDialogScript, /closeMergeApprovalDialog\(\);[\s\S]{0,200}switchView\(state\.mode === "history" \? "ledger" : "office"\);/u);
  assert.match(mergeDialogScript, /const succeeded = mergeHistorySucceeded\(promotion\) && value\.mainMutated === true;/u);
  assert.match(mergeDialogScript, /完成，回辦公室/u);
  assert.equal(
    mergeDialogScript.match(/完成，回辦公室/gu)?.length,
    1,
  );
  assert.match(
    mergeDialogScript,
    /if \(succeeded\) \{[\s\S]*?returnButton = document\.createElement\("button"\);[\s\S]*?\} else if \(promotion\.state === "rolled-back"/u,
  );
  const nonSuccessResultBranches = mergeDialogScript.slice(
    mergeDialogScript.indexOf('} else if (promotion.state === "rolled-back"'),
    mergeDialogScript.indexOf("log.textContent =", mergeDialogScript.indexOf('} else if (promotion.state === "rolled-back"')),
  );
  assert.doesNotMatch(nonSuccessResultBranches, /merge-success-return|完成，回辦公室/u);
  assert.match(mergeDialogScript, /returnButton\.addEventListener\("click", returnToRoomAfterSuccessfulMerge\);/u);
  assert.match(mergeDialogScript, /if \(returnButton\) result\.append\(returnButton\);\s+result\.hidden = false;\s+returnButton\?\.focus\(\);/u);
  assert.match(mergeDialogScript, /尚未能確認併入成功/u);
  assert.match(mergeDialogScript, /不會重複 apply/u);
  // Rejection describes what this ACTION did and never declares the current state of anything: the
  // three `*Retained` constants it used to print were assertions made by a path that reads nothing.
  assert.match(mergeDialogScript, /value\.deletedByThisRejection === "nothing"/u);
  assert.doesNotMatch(mergeDialogScript, /value\.candidateRetained/u);
  assert.doesNotMatch(mergeDialogScript, /value\.checkpointsRetained/u);
  assert.doesNotMatch(mergeDialogScript, /value\.recoveryRefRetained/u);
  // And it says so: the rendered sentence states that this view did not re-read the current state,
  // instead of declaring one. (Matching on the old wording would hit the comment explaining it.)
  assert.match(mergeDialogScript, /未重新讀取/u);
  assert.match(mergeDialogScript, /拒絕不等於刪除授權/u);
  // Bilingual state text, and a binding refusal that says which bound values moved.
  assert.match(mergeDialogScript, /按它只會帶你到阻擋項目，不會送出/u);
  assert.match(mergeDialogScript, /只會帶你到內層清單，不會送出/u);
  assert.match(roomScript, /MAIN_MERGE_APPROVAL_BINDING_CHANGED:/u);
  assert.match(roomScript, /const MERGE_BINDING_LABELS = \{/u);
  assert.match(roomScript, /function renderMergeApprovalBadge\(/u);
  assert.match(roomScript, /function refreshMergeApprovals\(/u);
  assert.match(roomStyles, /\.merge-approvals-open b \{/u);
  assert.match(roomStyles, /\.merge-approval-blocking \{/u);
  assert.match(roomStyles, /\.merge-approval-diff \{/u);
  assert.match(roomStyles, /\.merge-approval-diff:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/u);
  assert.match(roomStyles, /\.merge-file-tag\.is-mode/u);
  assert.match(roomStyles, /\.merge-approval-recovery \{/u);
  assert.match(roomStyles, /\.merge-success-return \{ min-height: 44px;/u);
  assert.match(roomStyles, /\.merge-confirmation-feedback\.is-invalid/u);
  assert.match(roomStyles, /#merge-approval-confirm\[aria-disabled="true"\]:not\(:disabled\)/u);
  assert.match(roomStyles, /merge-requirement-attention/u);
  assert.match(roomStyles, /#merge-approval-confirmation\[aria-invalid="true"\]/u);

  const usageView = await fetch(
    `${server.url}/api/view?runId=${restoreRunId}&kind=usage`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(usageView.status, 200);
  const messagesView = await fetch(
    `${server.url}/api/view?runId=${restoreRunId}&kind=messages`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(messagesView.status, 200);
  assert.deepEqual((await messagesView.json()) as unknown, { messages: [], persisted: false });
  const invalidView = await fetch(
    `${server.url}/api/view?runId=${restoreRunId}&kind=unknown`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(invalidView.status, 400);

  const badEvents = await fetch(`${server.url}/api/events?runId=bad&after=-1`, {
    headers: { Cookie: cookie },
  });
  assert.equal(badEvents.status, 400);
  const missingRoute = await fetch(`${server.url}/api/missing`, { headers: { Cookie: cookie } });
  assert.equal(missingRoute.status, 404);

  const noCsrf = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: server.url, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noCsrf.status, 403);

  const resolvedWorkflowRequest = await fetch(`${server.url}/api/workflow-requests/resolve`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: pendingWorkflow.id, decision: "declined" }),
  });
  assert.equal(resolvedWorkflowRequest.status, 200);
  assert.equal(
    ((await resolvedWorkflowRequest.json()) as { request: { status: string } }).request.status,
    "declined",
  );
  assert.deepEqual(app.workflowRequests.listPending(), []);
  const replayWorkflowResolution = await fetch(`${server.url}/api/workflow-requests/resolve`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: pendingWorkflow.id, decision: "accepted" }),
  });
  assert.equal(replayWorkflowResolution.status, 400);

  const badOrigin = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "http://attacker.invalid",
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(badOrigin.status, 403);

  const invalidApproval = await fetch(`${server.url}/api/approvals`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "unknown", confirmation: "none", workflow: {} }),
  });
  assert.equal(invalidApproval.status, 400);

  const invalidRunAction = await fetch(`${server.url}/api/runs/pause`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ runId: "bad" }),
  });
  assert.equal(invalidRunAction.status, 400);

  const worktreeWorkflow = {
    workspace,
    workspaceMode: "worktree",
    worktreeConfirmed: true,
    task: "Synthetic approval workflow",
    profile: "normal",
    planner: { provider: "fake", model: "fake", authMode: "subscription" },
    writer: { provider: "fake", model: "fake", authMode: "subscription" },
    reviewers: [{ provider: "fake", model: "fake", authMode: "subscription" }],
    apiModeConfirmed: false,
  };
  const wrongApproval = await fetch(`${server.url}/api/approvals`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "create-worktree",
      confirmation: "wrong",
      workflow: worktreeWorkflow,
    }),
  });
  assert.equal(wrongApproval.status, 400);
  const approved = await fetch(`${server.url}/api/approvals`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "create-worktree",
      confirmation: "APPROVE WORKTREE",
      workflow: worktreeWorkflow,
    }),
  });
  assert.equal(approved.status, 201);
  const approvalBody = (await approved.json()) as { token: string; expiresAt: string };
  assert.match(approvalBody.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.ok(Date.parse(approvalBody.expiresAt) > Date.now());

  await writeFile(join(workspace, "README.md"), "private pending content\n", "utf8");
  const dirtyApproved = await fetch(`${server.url}/api/approvals`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "import-dirty-snapshot",
      confirmation: "APPROVE DIRTY SNAPSHOT",
      workflow: { ...worktreeWorkflow, dirtySnapshotConfirmed: true },
    }),
  });
  assert.equal(dirtyApproved.status, 201);
  const dirtyApprovalBody = (await dirtyApproved.json()) as {
    token: string;
    snapshot: { id: string; files: number; writes: number; deletes: number; totalBytes: number };
  };
  assert.match(dirtyApprovalBody.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(dirtyApprovalBody.snapshot.id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(
    {
      files: dirtyApprovalBody.snapshot.files,
      writes: dirtyApprovalBody.snapshot.writes,
      deletes: dirtyApprovalBody.snapshot.deletes,
    },
    { files: 1, writes: 1, deletes: 0 },
  );
  assert.equal(JSON.stringify(dirtyApprovalBody).includes("private pending content"), false);
  await writeFile(join(workspace, "README.md"), "synthetic\n", "utf8");

  const testApproved = await fetch(`${server.url}/api/approvals`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "run-test",
      confirmation: "APPROVE TEST",
      workflow: {
        ...worktreeWorkflow,
        workspaceMode: "in-place",
        worktreeConfirmed: false,
        testProfileId: "synthetic-tests",
        testConfirmed: true,
      },
    }),
  });
  assert.equal(testApproved.status, 201);
  assert.match(
    ((await testApproved.json()) as { token: string }).token,
    /^[A-Za-z0-9_-]{43}$/u,
  );

  const restoreApproved = await fetch(`${server.url}/api/approvals`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "restore-checkpoint",
      confirmation: "APPROVE RESTORE",
      workflow: {
        ...worktreeWorkflow,
        workspaceMode: "in-place",
        worktreeConfirmed: false,
        restoreRunId,
        restoreCheckpointId,
      },
    }),
  });
  assert.equal(restoreApproved.status, 201);
  assert.match(
    ((await restoreApproved.json()) as { token: string }).token,
    /^[A-Za-z0-9_-]{43}$/u,
  );

  const applyRunId = "00000000-0000-4000-8000-000000000088";
  const applyBaseline = await new GitBroker().inspect(workspace);
  const applyHead = await new GitBroker().headSha(workspace);
  app.store.saveRun({
    id: applyRunId,
    createdAt: now,
    updatedAt: now,
    status: "completed",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: { ...restoreCounters },
  });
  app.events.emit({
    runId: applyRunId,
    type: "workspace.source-baseline",
    actor: "git",
    status: "info",
    summary: "Synthetic apply-back baseline.",
    metadata: { fingerprint: applyBaseline.fingerprint, headSha: applyHead, dirtySnapshot: false },
  });
  const applyWorktree = await new WorktreeBroker(data).create(workspace, applyRunId);
  await writeFile(join(applyWorktree.workspace, "README.md"), "web applied\n", "utf8");
  const preparedApply = await fetch(`${server.url}/api/apply-back/prepare`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ runId: applyRunId }),
  });
  assert.equal(preparedApply.status, 201);
  const preparedApplyBody = (await preparedApply.json()) as {
    preview: { id: string; files: number; changes: Array<{ path: string }> };
    confirmationPhrase?: string;
  };
  assert.equal(preparedApplyBody.preview.files, 1);
  assert.equal(preparedApplyBody.preview.changes[0]?.path, "README.md");
  /* The phrase the dialog will print comes from here, so the dialog cannot print a different one. */
  assert.equal(preparedApplyBody.confirmationPhrase, APPLY_BACK_CONFIRMATION);
  const rejectedApply = await fetch(`${server.url}/api/apply-back/apply`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ previewId: preparedApplyBody.preview.id, confirmation: "wrong" }),
  });
  assert.equal(rejectedApply.status, 400);
  /*
   * The wire-only constant this path used to require is refused now. It was never shown to
   * anyone: the dialog asked for one sentence and the browser substituted another on send,
   * so the sentence the endpoint checked was one the owner had never typed.
   */
  const retiredWireConstant = await fetch(`${server.url}/api/apply-back/apply`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      previewId: preparedApplyBody.preview.id,
      confirmation: "APPLY BACK TO SOURCE",
    }),
  });
  assert.equal(retiredWireConstant.status, 400);
  assert.equal(
    ((await retiredWireConstant.json()) as { error?: string }).error,
    "APPLY_BACK_CONFIRMATION_MISMATCH",
  );
  const applied = await fetch(`${server.url}/api/apply-back/apply`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      previewId: preparedApplyBody.preview.id,
      /* Exactly what prepare handed back, which is exactly what the owner is shown. */
      confirmation: preparedApplyBody.confirmationPhrase,
    }),
  });
  assert.equal(applied.status, 200);
  assert.equal(await readFile(join(workspace, "README.md"), "utf8"), "web applied\n");
  await writeFile(join(workspace, "README.md"), "synthetic\n", "utf8");

  const payload = {
    workspace,
    workspaceMode: "in-place",
    worktreeConfirmed: false,
    task: "Synthetic dashboard workflow",
    profile: "normal",
    planner: { provider: "fake", model: "fake", authMode: "subscription" },
    writer: { provider: "fake", model: "fake", authMode: "subscription" },
    reviewers: [{ provider: "fake", model: "fake", authMode: "subscription" }],
    apiModeConfirmed: false,
  };
  const started = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.url,
      "X-CSRF-Token": bootstrapBody.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(started.status, 202);
  const { runId } = (await started.json()) as { runId: string };
  assert.match(runId, /^[0-9a-f-]{36}$/u);

  await new Promise((resolvePromise, reject) => {
    const target = new URL(server.url);
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: "/",
        headers: { Host: "attacker.invalid" },
      },
      (response) => {
        assert.equal(response.statusCode, 421);
        response.resume();
        response.on("end", resolvePromise);
      },
    );
    req.on("error", reject);
    req.end();
  });
});

test("Merge confirmation gives truthful, retryable feedback for exact and incorrect phrases", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start merge-approval-gate");
  const end = source.indexOf("/* @pure-end merge-approval-gate */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free merge approval gate block");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const gate = runInNewContext(
    `${block}\n({ mergeApprovalGate, mergeApprovalInputScope, mergeApprovalIntentTarget, mergeApprovalFailureStatus, mergeApprovalRetryEligible });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as { mergeApprovalGate: (view: unknown) => {
    ready: boolean; inputDisabled: boolean; inputValue: string; confirmDisabled: boolean;
    feedback: string; tone: string; ariaInvalid: boolean; hint: string;
  }; mergeApprovalInputScope: (currentApprovalId: unknown, loadedApprovalId: unknown, typed: unknown) => {
    approvalId: string; value: string;
  }; mergeApprovalIntentTarget: (view: unknown) => string;
  mergeApprovalFailureStatus: (approvalFailure: unknown, refreshFailure?: unknown) => string;
  mergeApprovalRetryEligible: (approval: unknown) => boolean };
  const passing = {
    blockers: [], scrolled: true, decided: false, phrase: "MERGE INTO MAIN", typed: "MERGE INTO MAIN",
  };
  const exact = gate.mergeApprovalGate(passing);
  assert.equal(exact.inputDisabled, false);
  assert.equal(exact.confirmDisabled, false);
  assert.equal(exact.ariaInvalid, false);
  assert.equal(exact.tone, "is-valid");
  assert.equal(gate.mergeApprovalIntentTarget(passing), "submit");
  assert.match(exact.feedback, /確認短語正確/u);
  assert.match(exact.feedback, /仍尚未 Merge/u);

  for (const typed of [
    "marge into main", "merge into main", "MERGE INTO MAIN ", " MERGE INTO MAIN",
    "MERGE  INTO MAIN", "MERGE INTO MAI",
  ]) {
    const wrong = gate.mergeApprovalGate({ ...passing, typed });
    assert.equal(wrong.inputDisabled, false, typed);
    assert.equal(wrong.inputValue, typed, typed);
    assert.equal(wrong.confirmDisabled, true, typed);
    assert.equal(wrong.ariaInvalid, true, typed);
    assert.equal(wrong.tone, "is-invalid", typed);
    assert.match(wrong.feedback, /確認短語不正確/u, typed);
    assert.match(wrong.feedback, /尚未送出、尚未 Merge，main 沒有被修改/u, typed);
    assert.match(wrong.feedback, /MERGE INTO MAIN/u, typed);
  }

  const empty = gate.mergeApprovalGate({ ...passing, typed: "" });
  assert.equal(empty.inputDisabled, false);
  assert.equal(empty.confirmDisabled, true);
  assert.equal(empty.ariaInvalid, false);
  assert.match(empty.feedback, /尚未輸入/u);

  const unread = gate.mergeApprovalGate({ ...passing, typed: "marge into main", scrolled: false });
  assert.equal(unread.inputDisabled, false);
  assert.equal(unread.inputValue, "marge into main");
  assert.equal(unread.confirmDisabled, true);
  assert.equal(unread.ariaInvalid, true);
  assert.match(unread.feedback, /輸入框仍可修改/u);
  assert.match(unread.feedback, /上方深色變更清單方框內捲到底/u);
  assert.match(unread.feedback, /main 未修改/u);

  const exactUnread = gate.mergeApprovalGate({ ...passing, scrolled: false });
  assert.equal(exactUnread.inputDisabled, false);
  assert.equal(exactUnread.inputValue, "MERGE INTO MAIN");
  assert.equal(exactUnread.confirmDisabled, true);
  assert.equal(exactUnread.ariaInvalid, false);
  assert.equal(exactUnread.tone, "is-waiting");
  assert.match(exactUnread.feedback, /確認短語正確/u);
  assert.match(exactUnread.feedback, /還沒捲完內層變更清單/u);
  assert.match(exactUnread.feedback, /不是捲外層視窗/u);
  assert.equal(gate.mergeApprovalIntentTarget({ ...passing, scrolled: false }), "diff");

  const emptyUnread = gate.mergeApprovalGate({ ...passing, typed: "", scrolled: false });
  assert.equal(emptyUnread.inputDisabled, false);
  assert.equal(emptyUnread.confirmDisabled, true);
  assert.match(emptyUnread.feedback, /可以先輸入/u);
  assert.match(emptyUnread.feedback, /內層變更清單/u);

  const blocked = gate.mergeApprovalGate({ ...passing, blockers: ["conflict"] });
  assert.equal(blocked.inputDisabled, false);
  assert.equal(blocked.inputValue, "MERGE INTO MAIN");
  assert.equal(blocked.confirmDisabled, true);
  assert.equal(blocked.tone, "is-waiting");
  assert.match(blocked.feedback, /阻擋項目/u);
  assert.match(blocked.feedback, /尚未 Merge/u);
  assert.equal(gate.mergeApprovalIntentTarget({ ...passing, blockers: ["conflict"] }), "blockers");

  const blockedWrong = gate.mergeApprovalGate({ ...passing, typed: "marge", blockers: ["conflict"] });
  assert.equal(blockedWrong.inputDisabled, false);
  assert.equal(blockedWrong.confirmDisabled, true);
  assert.equal(blockedWrong.ariaInvalid, true);
  assert.match(blockedWrong.feedback, /輸入框仍可修改/u);
  assert.match(blockedWrong.feedback, /阻擋項目/u);

  const expired = gate.mergeApprovalGate({ ...passing, expired: true });
  assert.equal(expired.inputDisabled, true);
  assert.equal(expired.inputValue, "");
  assert.equal(expired.confirmDisabled, true);
  assert.equal(expired.ariaInvalid, false);
  assert.match(expired.hint, /已逾時且不能復活/u);
  assert.match(expired.feedback, /重新產生預覽不會讓這筆逾時核准恢復/u);
  assert.match(expired.feedback, /尚未送出、尚未 Merge/u);
  assert.equal(gate.mergeApprovalIntentTarget({ ...passing, expired: true }), "unavailable");

  const decided = gate.mergeApprovalGate({ ...passing, decided: true });
  assert.equal(decided.inputDisabled, true);
  assert.equal(decided.inputValue, "");
  assert.match(decided.feedback, /併入紀錄/u);

  const malformed = gate.mergeApprovalGate(undefined);
  assert.equal(malformed.inputDisabled, true);
  assert.equal(malformed.confirmDisabled, true);
  assert.equal(gate.mergeApprovalIntentTarget(undefined), "unavailable");
  assert.equal(gate.mergeApprovalIntentTarget({ ...passing, typed: "marge" }), "input");
  assert.equal(gate.mergeApprovalIntentTarget({ ...passing, typed: "" }), "input");
  assert.equal(gate.mergeApprovalIntentTarget({ ...passing, decided: true }), "unavailable");

  const sameApproval = gate.mergeApprovalInputScope("approval-a", "approval-a", "MERGE INTO MAIN");
  assert.equal(sameApproval.approvalId, "approval-a");
  assert.equal(sameApproval.value, "MERGE INTO MAIN");
  const freshApproval = gate.mergeApprovalInputScope("approval-a", "approval-b", "MERGE INTO MAIN");
  assert.equal(freshApproval.approvalId, "approval-b");
  assert.equal(freshApproval.value, "");
  const malformedApproval = gate.mergeApprovalInputScope("approval-a", undefined, "MERGE INTO MAIN");
  assert.equal(malformedApproval.approvalId, "");
  assert.equal(malformedApproval.value, "");

  const refused = gate.mergeApprovalFailureStatus("MAIN_MERGE_APPROVAL_EXPIRED");
  assert.match(refused, /核准失敗/u);
  assert.match(refused, /MAIN_MERGE_APPROVAL_EXPIRED/u);
  assert.match(refused, /建立一筆全新的 snapshot-bound 核准/u);
  assert.equal(gate.mergeApprovalRetryEligible({ state: "rejected" }), true);
  assert.equal(gate.mergeApprovalRetryEligible({ state: "invalidated" }), true);
  assert.equal(gate.mergeApprovalRetryEligible({ state: "expired" }), true);
  assert.equal(gate.mergeApprovalRetryEligible({ state: "consumed" }), false);
  assert.equal(gate.mergeApprovalRetryEligible({ state: "requested" }), false);
  const nestedFailure = gate.mergeApprovalFailureStatus(
    "MAIN_MERGE_APPROVAL_EXPIRED",
    "NETWORK_UNAVAILABLE",
  );
  assert.match(nestedFailure, /live state 重新讀取也失敗/u);
  assert.match(nestedFailure, /這不是 Merge 成功/u);
  assert.match(nestedFailure, /MAIN_MERGE_APPROVAL_EXPIRED/u);
  assert.match(nestedFailure, /NETWORK_UNAVAILABLE/u);
});

test("Merge outcome archive counts only verified success as merged", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start merge-history-buckets");
  const end = source.indexOf("/* @pure-end merge-history-buckets */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free outcome classifier");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const classifier = runInNewContext(
    `${block}\n({ mergeHistorySucceeded, mergeHistoryBuckets });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as {
    mergeHistorySucceeded: (entry: unknown) => boolean;
    mergeHistoryBuckets: (promotions: unknown, approvals: unknown) => {
      mergedPromotions: unknown[]; reviewPromotions: unknown[];
      notStartedApprovals: unknown[]; reviewApprovals: unknown[]; otherCount: number;
    };
  };
  const verified = {
    id: "verified", state: "applied", mainHeadAfter: "a".repeat(40),
    observation: { authorizedMergeCommit: true },
  };
  const missingObservation = { id: "missing-observation", state: "applied", mainHeadAfter: "b".repeat(40) };
  const missingHead = { id: "missing-head", state: "applied", observation: { authorizedMergeCommit: true } };
  const rolledBack = { id: "rolled-back", state: "rolled-back", mainHeadAfter: "c".repeat(40) };
  const unattested = {
    id: "unattested", state: "unreadable", storedState: "applied",
    unreadableReason: "promotion-attestation",
    // Even if hostile input carries old positive-looking fields, the non-applied public state wins.
    mainHeadAfter: "d".repeat(40), observation: { authorizedMergeCommit: true },
  };
  const approvals = [
    { id: "expired", state: "expired" },
    { id: "rejected", state: "rejected" },
    { id: "invalidated", state: "invalidated" },
    { id: "consumed-without-row", state: "consumed" },
    { id: "approved-without-row", state: "approved" },
  ];
  const buckets = classifier.mergeHistoryBuckets(
    [verified, missingObservation, missingHead, rolledBack, unattested],
    approvals,
  );
  assert.equal(classifier.mergeHistorySucceeded(verified), true);
  assert.equal(classifier.mergeHistorySucceeded(missingObservation), false);
  assert.equal(classifier.mergeHistorySucceeded(missingHead), false);
  assert.equal(classifier.mergeHistorySucceeded({ ...verified, state: "needs-manual-review" }), false);
  assert.equal(classifier.mergeHistorySucceeded({ ...verified, mainHeadAfter: "" }), false);
  assert.equal(classifier.mergeHistorySucceeded(unattested), false);
  assert.equal(classifier.mergeHistorySucceeded(undefined), false);
  assert.deepEqual(Array.from(buckets.mergedPromotions), [verified]);
  assert.deepEqual(Array.from(buckets.reviewPromotions), [missingObservation, missingHead, rolledBack, unattested]);
  assert.deepEqual(Array.from(buckets.notStartedApprovals), approvals.slice(0, 3));
  assert.deepEqual(Array.from(buckets.reviewApprovals), approvals.slice(3));
  assert.equal(buckets.otherCount, 9);
  const everyRow = [
    ...buckets.mergedPromotions,
    ...buckets.reviewPromotions,
    ...buckets.notStartedApprovals,
    ...buckets.reviewApprovals,
  ];
  assert.equal(everyRow.length, 10, "the mutually exclusive buckets preserve every input row");
  assert.equal(new Set(everyRow).size, 10, "no row can appear in two outcome buckets");
  assert.equal(buckets.mergedPromotions.length + buckets.otherCount, 10);
});

test("ending a wait is offered only when the record names both a phrase and its number", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start merge-wait-release");
  const end = source.indexOf("/* @pure-end merge-wait-release */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free wait-release selector");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const selector = runInNewContext(
    `${block}\n({ mergeWaitRelease });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as { mergeWaitRelease: (entry: unknown) => Record<string, unknown> | null };
  const call = (entry: unknown): string =>
    JSON.stringify(selector.mergeWaitRelease(entry) ?? null);

  // Nothing to end.
  assert.equal(call({}), "null");
  assert.equal(call({ pending: {} }), "null");
  // A phrase with no number, in a state that HAS one to quote, is not actionable: the control would
  // have to guess a pid, and guessing one is how a release lands on the wrong process.
  assert.equal(call({ pending: { code: "MERGE_END_NOT_OBSERVED", release: "P" } }), "null");
  assert.equal(call({ pending: { code: "OWNER_PROCESS_STILL_RUNNING", release: "P" } }), "null");
  assert.equal(
    call({ pending: { code: "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING", release: "P", pid: 7 } }),
    "null", "the both-processes state needs BOTH numbers, and only one was reported",
  );
  // The one state that legitimately names no number carries it all in the phrase.
  assert.equal(
    call({ pending: { code: "MERGE_IDENTITY_UNACCOUNTED", release: "P" } }),
    JSON.stringify({ confirmation: "P", code: "MERGE_IDENTITY_UNACCOUNTED" }),
  );
  // The three shapes that are actionable, each quoting exactly what the record showed.
  assert.equal(
    call({ pending: { code: "MERGE_END_NOT_OBSERVED", release: "P", pid: 9 } }),
    JSON.stringify({ confirmation: "P", pgid: 9, code: "MERGE_END_NOT_OBSERVED" }),
  );
  assert.equal(
    call({ pending: { code: "OWNER_PROCESS_STILL_RUNNING", release: "P", pid: 9 } }),
    JSON.stringify({ confirmation: "P", pid: 9, code: "OWNER_PROCESS_STILL_RUNNING" }),
  );
  assert.equal(
    call({
      pending: {
        code: "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING", release: "P", pid: 9,
        alsoBlockedBy: { pid: 11 },
      },
    }),
    JSON.stringify({ confirmation: "P", pid: 9, pgid: 11, code: "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING" }),
  );

  // The copy, for the same reason the acknowledgement's copy is asserted: the control must not read
  // as the product having decided the merge is over.
  const offer = source.slice(source.indexOf("function renderPromotionWaitRelease"));
  const body = offer.slice(0, offer.indexOf("\n  box.append(what, warn, phrase, act);"));
  assert.match(body, /不會終止任何程序/u);
  assert.match(body, /不會寫入 main/u);
  assert.match(body, /不會修復紀錄/u);
  assert.match(body, /不代表產品判斷併入已/u);
  assert.match(body, /\/api\/rooms\/merge-promotions\/release/u);
  assert.doesNotMatch(body, /merge-approvals\/approve|promoteMainMerge|reset --hard/u);
});

test("the acknowledgement offer is narrow, and says what it is not", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start merge-history-unattested");
  const end = source.indexOf("/* @pure-end merge-history-unattested */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free unattested selector");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const selector = runInNewContext(
    `${block}\n({ mergeHistoryUnattested });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as { mergeHistoryUnattested: (promotions: unknown) => Array<{ id: string }> };

  const unattested = {
    id: "unattested", state: "unreadable", unreadableReason: "promotion-attestation",
    holdsProjectExclusiveMarker: true,
  };
  // A corrupt row that is STILL holding the project has to be offered the way out too: it is the
  // condition a promotion is refused on, and excluding it left that project with no exit at all.
  const corrupt = {
    id: "corrupt", state: "unreadable", unreadableReason: "row-integrity",
    holdsProjectExclusiveMarker: true,
  };
  // One that has already been let go is not offered anything, whatever its reason says.
  const released = {
    id: "released", state: "unreadable", unreadableReason: "row-integrity",
    holdsProjectExclusiveMarker: false,
  };
  const applied = { id: "applied", state: "applied", observation: { authorizedMergeCommit: true } };
  const applying = { id: "applying", state: "applying" };
  // Joined rather than compared as arrays: the selector runs in another realm, so its Array is a
  // different constructor and a strict deep comparison fails on the prototype rather than the values.
  const ids = (input: unknown): string =>
    selector.mergeHistoryUnattested(input).map((entry) => entry.id).join(",");
  assert.equal(
    ids([unattested, corrupt, released, applied, applying]), "unattested",
    "a corrupt row was offered a phrase that skips the probe its own release performs",
  );
  assert.equal(ids(undefined), "");
  assert.equal(
    ids([{ id: "not-holding", state: "unreadable" }]), "",
    "a record the daemon does not say is holding the project must not be offered a way out of it",
  );
  assert.equal(
    ids([{ id: "readable", state: "applied", holdsProjectExclusiveMarker: true }]), "",
    "only a record the daemon reports as unreadable is in question here",
  );

  // The wording the owner reads is part of the control. A button that implied the product had
  // checked something would be the same measured falsehood this round removed, so the copy is
  // asserted rather than left to drift.
  const offer = source.slice(source.indexOf("function renderUnattestedAcknowledgement"));
  const body = offer.slice(0, offer.indexOf("\nasync function refreshMergeHistory"));
  assert.match(body, /不會修復任何紀錄/u);
  assert.match(body, /不會寫入 main/u);
  assert.match(body, /不代表產品驗證過什麼/u);
  assert.match(body, /重新啟動後會再問一次/u);
  assert.match(body, /I HAVE CHECKED THIS PROJECT MYSELF AND NO EARLIER PROMOTION IS STILL RUNNING/u);
  assert.match(body, /\/api\/rooms\/merge-promotions\/acknowledge/u);
  // It must not be able to reach anything that writes main.
  assert.doesNotMatch(body, /merge-approvals\/approve|promoteMainMerge|reset --hard/u);
});

test("Merge pending badge accepts only active unexpired requested approvals", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start merge-approval-pending */");
  const end = source.indexOf("/* @pure-end merge-approval-pending */");
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  const pending = runInNewContext(
    `${block}\nmergeApprovalPending;`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as (approval: unknown) => boolean;
  const active = { id: "active", state: "requested", expired: false };
  assert.equal(pending(active), true);
  assert.equal(pending({ ...active, expired: true }), false);
  assert.equal(pending({ ...active, state: "approved" }), false);
  assert.equal(pending({ ...active, state: "rejected" }), false);
  assert.equal(pending(undefined), false);
  assert.deepEqual([active, { state: "requested", expired: true }, { state: "approved" }].filter(pending), [active]);
});

test("Merge task sidebar disappears when every request is complete or terminal", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const pendingStart = source.indexOf("/* @pure-start merge-approval-pending */");
  const pendingEnd = source.indexOf("/* @pure-end merge-approval-pending */");
  const summaryStart = source.indexOf("/* @pure-start merge-task-summary */");
  const summaryEnd = source.indexOf("/* @pure-end merge-task-summary */");
  assert.ok(pendingStart > 0 && pendingEnd > pendingStart && summaryStart > pendingEnd && summaryEnd > summaryStart);
  const block = `${source.slice(pendingStart, pendingEnd)}\n${source.slice(summaryStart, summaryEnd)}`;
  const summarize = runInNewContext(
    `${block}\nmergeTaskSummary;`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as (approvals: unknown) => { pending: unknown[]; count: number; visible: boolean };
  const terminal = summarize([
    { state: "consumed", expired: false },
    { state: "rejected", expired: false },
    { state: "requested", expired: true },
  ]);
  assert.equal(terminal.count, 0);
  assert.equal(terminal.visible, false);
  assert.deepEqual(Array.from(terminal.pending), []);
  const active = { state: "requested", expired: false };
  const mixed = summarize([active, { state: "consumed", expired: false }]);
  assert.equal(mixed.count, 1);
  assert.equal(mixed.visible, true);
  assert.deepEqual(Array.from(mixed.pending), [active]);
  // The topbar button is always present: 0 pending disables it and drops the red state, never hides it.
  assert.match(source, /button\.disabled = false;\n\s*button\.classList\.toggle\("is-pending", summary\.visible\);/u);
  assert.doesNotMatch(source, /merge-active-task/u);
});

test("with nothing pending the approval button still opens the layer, as an empty state", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/room.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const open = /^function openMergeApprovalDialog\(approvalId\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(open, /dialog\.classList\.toggle\("is-empty", !target\);/u);
  assert.match(open, /if \(!target\) \{ openMergeApprovalEmptyState\(dialog\); return; \}/u);
  const empty = /^function openMergeApprovalEmptyState\(dialog\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  /* No fetch, ticker or poll: there is nothing to bind to. Focus lands on the way back. */
  assert.doesNotMatch(empty, /loadMergeApproval|setInterval|api\(/u);
  assert.match(empty, /byId\("merge-approval-empty-close"\)\.focus\(\);/u);
  assert.match(source, /byId\("merge-approval-empty-close"\)\?\.addEventListener\("click", closeMergeApprovalDialog\);/u);
  /* A div, not a section: the shipped-docs guard cuts the approval layer at the first </section>. */
  assert.match(html, /<div id="merge-approval-empty" class="merge-approval-empty" hidden/u);
  assert.match(html, /目前沒有草稿版待核准。/u);
  assert.match(html, /<button id="merge-approval-empty-history"[^>]*>▤ 看併入紀錄<\/button>/u);
  assert.match(html, /<button id="merge-approval-empty-close"[^>]*>← 回辦公室<\/button>/u);
  /* The confirmation row (input included) and the review body are hidden by the state class. */
  assert.match(styles, /\.merge-approval\.is-empty \.merge-approval-body, \.merge-approval\.is-empty \.merge-approval-confirm,/u);
});

test("the narrow topbar keeps words on the approval and records buttons, not icons alone", async () => {
  const html = await readFile(new URL("../public/room.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /<span class="merge-nav-short">待核<\/span>/u);
  assert.match(html, /<span class="merge-nav-short">紀錄<\/span>/u);
  const narrow = /@media \(max-width: 760px\) \{\n {2}\.topbar \{ flex-wrap: wrap;[\s\S]*?\n\}/u.exec(styles)?.[0] ?? "";
  assert.notEqual(narrow, "", "the narrow topbar block exists");
  assert.match(narrow, /\.merge-nav-full \{ display: none; \}/u);
  assert.match(narrow, /\.merge-nav-short \{ display: inline; \}/u);
  assert.doesNotMatch(narrow, /merge-(approvals|history)-open span \{ font-size: 0/u);
});

test("Merge records shows nonnumeric attention only for outcomes requiring review", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start merge-records-attention */");
  const end = source.indexOf("/* @pure-end merge-records-attention */");
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  const requiresAttention = runInNewContext(
    `${block}\nmergeRecordsAttention;`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as (buckets: unknown) => boolean;
  assert.equal(requiresAttention({ reviewPromotions: [{}], reviewApprovals: [] }), true);
  assert.equal(requiresAttention({ reviewPromotions: [], reviewApprovals: [{}] }), true);
  assert.equal(requiresAttention({
    mergedPromotions: [{}],
    reviewPromotions: [],
    reviewApprovals: [],
    notStartedApprovals: [{ state: "expired" }, { state: "rejected" }],
  }), false);
  assert.equal(requiresAttention(undefined), false);
  assert.match(source, /attention\.hidden = !requiresReview/u);
  assert.doesNotMatch(source, /merge-records-attention[\s\S]{0,500}textContent\s*=\s*String/u);
});

/*
 * H. The owner renames a joined terminal seat from the GUI so the floor reads "which terminal is
 * which" instead of codex1 / codex2. Owner-only like every presence route (401 without the session
 * cookie, 403 without CSRF); the seat keeps its id and standby approval; the ledger records old and
 * new names in one system line; a seat with an in-flight delivery keeps its name, because that
 * delivery is bound to the target's display name and would otherwise fail on the next reconcile.
 */
test("Web dashboard lets the owner rename a joined seat in place", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-web-rename-data-"));
  const workspace = await realpath(await repository());
  await writeFile(
    join(data, "workspace-roots.json"),
    `${JSON.stringify([{ id: "rename-root", label: "Rename root", path: workspace }])}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));

  const app = await createAppContext(data);
  t.after(() => app.close());
  const ledger = new RoomLedger(app.store.dataDirectory);
  ledger.createRoom("rename-room", workspace);
  ledger.close();
  const presenceStore = new RoomPresenceStore(app.store.dataDirectory);
  t.after(() => presenceStore.close());
  const codexSeat = presenceStore.register({ provider: "codex", workspace, hostPid: 98771, client: "Codex CLI" });
  const claudeSeat = presenceStore.register({ provider: "claude", workspace, hostPid: 98772, client: "Claude Code" });
  const pendingSeat = presenceStore.register({ provider: "grok", workspace, hostPid: 98773 });
  for (const seat of [codexSeat, claudeSeat, pendingSeat]) presenceStore.requestJoin(seat.id, "rename-room", workspace);
  presenceStore.join(codexSeat.id, "rename-room", workspace, { collaborationMode: "room-first", syncTurns: true, label: "前端 2" });
  presenceStore.join(claudeSeat.id, "rename-room", workspace, { collaborationMode: "seat-only", syncTurns: false });
  presenceStore.requestStandby(codexSeat.id, "rename-room");
  presenceStore.approveStandby(codexSeat.id, "rename-room");

  const server = await startWebServer(app, 0);
  t.after(async () => await server.close());
  const index = await fetch(server.url);
  const cookie = (index.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const bootstrap = await fetch(`${server.url}/api/bootstrap`, { headers: { Cookie: cookie } });
  const { csrf } = (await bootstrap.json()) as { csrf: string };
  const headers = { Cookie: cookie, Origin: server.url, "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const rename = (body: Record<string, unknown>, overrides: Record<string, string> = headers) =>
    fetch(`${server.url}/api/rooms/presence/rename`, { method: "POST", headers: overrides, body: JSON.stringify(body) });
  const ledgerTail = async (after: number) => ((await (await fetch(
    `${server.url}/api/rooms/messages?room=rename-room&after=${after}`,
    { headers: { Cookie: cookie } },
  )).json()) as { messages: { seq: number; author: string; text: string }[] }).messages;

  // Not the owner: no session cookie is 401, a session without the CSRF token is 403.
  const withoutCookie = await rename(
    { room: "rename-room", presenceId: codexSeat.id, label: "前端組長" },
    { Origin: server.url, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
  );
  assert.equal(withoutCookie.status, 401);
  const withoutCsrf = await rename(
    { room: "rename-room", presenceId: codexSeat.id, label: "前端組長" },
    { Cookie: cookie, Origin: server.url, "Content-Type": "application/json" },
  );
  assert.equal(withoutCsrf.status, 403);
  assert.equal(presenceStore.get(codexSeat.id)?.displayName, "codex（前端 2）");

  // Shape: exactly room + presenceId + label, all strings.
  const wrongField = await rename({ room: "rename-room", presenceId: codexSeat.id, displayName: "前端組長" });
  assert.equal(wrongField.status, 400);
  assert.deepEqual(await wrongField.json(), { error: "INVALID_PRESENCE_RENAME_REQUEST" });
  for (const bad of ["   ", "x".repeat(25), "<script>"]) {
    const response = await rename({ room: "rename-room", presenceId: codexSeat.id, label: bad });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "PRESENCE_NAME_INVALID" });
  }
  const notJoined = await rename({ room: "rename-room", presenceId: pendingSeat.id, label: "前端組長" });
  assert.equal(notJoined.status, 400);
  assert.deepEqual(await notJoined.json(), { error: "PRESENCE_NOT_JOINED" });
  const unknownSeat = await rename({ room: "rename-room", presenceId: "missing", label: "前端組長" });
  assert.equal(unknownSeat.status, 400);
  assert.deepEqual(await unknownSeat.json(), { error: "PRESENCE_NOT_FOUND" });

  // Taken: another terminal seat, or a managed agent, already holds that exact name.
  const takenBySeat = await rename({ room: "rename-room", presenceId: claudeSeat.id, label: "前端 2" });
  assert.equal(takenBySeat.status, 200, "different provider prefix, so claude（前端 2） is a different name");
  const managed = await fetch(`${server.url}/api/rooms/managed-agents`, {
    method: "POST", headers, body: JSON.stringify({ room: "rename-room", provider: "codex", label: "即時審查" }),
  });
  assert.equal(managed.status, 201);
  const takenByManaged = await rename({ room: "rename-room", presenceId: codexSeat.id, label: "即時審查" });
  assert.equal(takenByManaged.status, 400);
  assert.deepEqual(await takenByManaged.json(), { error: "PRESENCE_NAME_TAKEN" });
  const codexTwin = presenceStore.register({ provider: "codex", workspace, hostPid: 98774 });
  presenceStore.requestJoin(codexTwin.id, "rename-room", workspace);
  presenceStore.join(codexTwin.id, "rename-room", workspace, { collaborationMode: "seat-only", syncTurns: false });
  const takenByTwin = await rename({ room: "rename-room", presenceId: codexTwin.id, label: " 前端 2 " });
  assert.equal(takenByTwin.status, 400);
  assert.deepEqual(await takenByTwin.json(), { error: "PRESENCE_NAME_TAKEN" });

  // Success: label trimmed, provider kept in front, id and standby approval untouched, one ledger line.
  const before = (await ledgerTail(0)).at(-1)?.seq ?? 0;
  const renamed = await rename({ room: "rename-room", presenceId: codexSeat.id, label: " 前端組長 " });
  assert.equal(renamed.status, 200);
  const renamedBody = (await renamed.json()) as {
    session: { id: string; displayName: string; standbyApproved: boolean; collaborationMode: string };
    previousDisplayName: string;
    displayName: string;
  };
  assert.equal(renamedBody.previousDisplayName, "codex（前端 2）");
  assert.equal(renamedBody.displayName, "codex（前端組長）");
  assert.equal(renamedBody.session.id, codexSeat.id);
  assert.equal(renamedBody.session.displayName, "codex（前端組長）");
  assert.equal(renamedBody.session.standbyApproved, true);
  assert.equal(renamedBody.session.collaborationMode, "room-first");
  const lines = await ledgerTail(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.author, "system");
  assert.equal(lines[0]?.text, `席位 ${codexSeat.id.slice(0, 8)} 更名：codex（前端 2） → codex（前端組長）`);
  const listed = (await (await fetch(`${server.url}/api/rooms/presence?room=rename-room`, { headers: { Cookie: cookie } })).json()) as {
    sessions: Array<{ id: string; displayName?: string }>;
  };
  assert.equal(listed.sessions.find((session) => session.id === codexSeat.id)?.displayName, "codex（前端組長）");
  // Same name again is a no-op: 200, no second ledger line.
  const unchanged = await rename({ room: "rename-room", presenceId: codexSeat.id, label: "前端組長" });
  assert.equal(unchanged.status, 200);
  assert.equal((await ledgerTail(before)).length, 1);

  // In-flight work pins the name; once that delivery is cancelled the rename goes through.
  const posted = await fetch(`${server.url}/api/rooms/presence/post`, {
    method: "POST", headers, body: JSON.stringify({ room: "rename-room", presenceId: codexSeat.id, text: "先看一下前端" }),
  });
  assert.equal(posted.status, 202);
  const delivery = ((await posted.json()) as { delivery: { id: string } }).delivery;
  const busy = await rename({ room: "rename-room", presenceId: codexSeat.id, label: "前端 2" });
  assert.equal(busy.status, 400);
  assert.deepEqual(await busy.json(), { error: "PRESENCE_RENAME_BUSY" });
  assert.equal(presenceStore.get(codexSeat.id)?.displayName, "codex（前端組長）");
  const cancelled = await fetch(`${server.url}/api/rooms/deliveries/cancel`, {
    method: "POST", headers, body: JSON.stringify({ room: "rename-room", deliveryId: delivery.id }),
  });
  assert.equal(cancelled.status, 200);
  const afterCancel = await rename({ room: "rename-room", presenceId: codexSeat.id, label: "前端 2" });
  assert.equal(afterCancel.status, 200);
  assert.equal(((await afterCancel.json()) as { displayName: string }).displayName, "codex（前端 2）");
});

/*
 * H. The owner turns a pending join request down from the GUI. Owner-only (401 without the session
 * cookie, 403 without CSRF); the request disappears from the room's presence list, the terminal
 * itself stays registered and may ask again, and the ledger records the refusal in one system line.
 */
test("Web dashboard lets the owner reject a pending join request", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-web-reject-data-"));
  const workspace = await realpath(await repository());
  await writeFile(
    join(data, "workspace-roots.json"),
    `${JSON.stringify([{ id: "reject-root", label: "Reject root", path: workspace }])}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));

  const app = await createAppContext(data);
  t.after(() => app.close());
  const ledger = new RoomLedger(app.store.dataDirectory);
  ledger.createRoom("reject-room", workspace);
  ledger.close();
  const presenceStore = new RoomPresenceStore(app.store.dataDirectory);
  t.after(() => presenceStore.close());
  const pending = presenceStore.register({ provider: "codex", workspace, hostPid: 98781, client: "Codex CLI" });
  const joined = presenceStore.register({ provider: "claude", workspace, hostPid: 98782 });
  const silent = presenceStore.register({ provider: "grok", workspace, hostPid: 98783 });
  presenceStore.requestJoin(pending.id, "reject-room", workspace);
  presenceStore.requestJoin(joined.id, "reject-room", workspace);
  presenceStore.join(joined.id, "reject-room", workspace, { collaborationMode: "seat-only", syncTurns: false });

  const server = await startWebServer(app, 0);
  t.after(async () => await server.close());
  const index = await fetch(server.url);
  const cookie = (index.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const bootstrap = await fetch(`${server.url}/api/bootstrap`, { headers: { Cookie: cookie } });
  const { csrf } = (await bootstrap.json()) as { csrf: string };
  const headers = { Cookie: cookie, Origin: server.url, "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const reject = (body: Record<string, unknown>, overrides: Record<string, string> = headers) =>
    fetch(`${server.url}/api/rooms/presence/reject`, { method: "POST", headers: overrides, body: JSON.stringify(body) });
  const sessions = async () => ((await (await fetch(`${server.url}/api/rooms/presence?room=reject-room`, {
    headers: { Cookie: cookie },
  })).json()) as { sessions: Array<{ id: string; joined: boolean; requested: boolean }> }).sessions;

  const withoutCookie = await reject(
    { room: "reject-room", presenceId: pending.id },
    { Origin: server.url, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
  );
  assert.equal(withoutCookie.status, 401);
  const withoutCsrf = await reject(
    { room: "reject-room", presenceId: pending.id },
    { Cookie: cookie, Origin: server.url, "Content-Type": "application/json" },
  );
  assert.equal(withoutCsrf.status, 403);
  assert.equal((await sessions()).some((session) => session.id === pending.id && session.requested), true);

  const wrongShape = await reject({ room: "reject-room", presenceId: pending.id, reason: "no" });
  assert.equal(wrongShape.status, 400);
  assert.deepEqual(await wrongShape.json(), { error: "INVALID_PRESENCE_REJECT_REQUEST" });
  const unknownRoom = await reject({ room: "missing-room", presenceId: pending.id });
  assert.equal(unknownRoom.status, 400);
  assert.deepEqual(await unknownRoom.json(), { error: "ROOM_NOT_FOUND" });
  const unknownSeat = await reject({ room: "reject-room", presenceId: "missing" });
  assert.equal(unknownSeat.status, 400);
  assert.deepEqual(await unknownSeat.json(), { error: "PRESENCE_NOT_FOUND" });
  const alreadyJoined = await reject({ room: "reject-room", presenceId: joined.id });
  assert.equal(alreadyJoined.status, 400);
  assert.deepEqual(await alreadyJoined.json(), { error: "PRESENCE_ALREADY_JOINED" });
  const neverAsked = await reject({ room: "reject-room", presenceId: silent.id });
  assert.equal(neverAsked.status, 400);
  assert.deepEqual(await neverAsked.json(), { error: "PRESENCE_JOIN_NOT_REQUESTED" });

  const ledgerBefore = ((await (await fetch(`${server.url}/api/rooms/messages?room=reject-room&after=0`, {
    headers: { Cookie: cookie },
  })).json()) as { messages: { seq: number }[] }).messages.at(-1)?.seq ?? 0;
  const rejected = await reject({ room: "reject-room", presenceId: pending.id });
  assert.equal(rejected.status, 200);
  const rejectedBody = (await rejected.json()) as {
    session: { id: string; joined: boolean; requested: boolean; executionClass: string; capabilityAuthority: string; hostCapabilities: string };
  };
  assert.equal(rejectedBody.session.id, pending.id);
  assert.equal(rejectedBody.session.joined, false);
  assert.equal(rejectedBody.session.requested, false);
  assert.equal(rejectedBody.session.executionClass, "native-full-trust");
  assert.equal(rejectedBody.session.capabilityAuthority, "host");
  assert.equal(rejectedBody.session.hostCapabilities, "unchanged");
  assert.equal((await sessions()).some((session) => session.id === pending.id), false, "a refused request leaves the room's list");
  assert.equal(presenceStore.get(pending.id)?.id, pending.id, "the terminal itself stays registered");
  const lines = ((await (await fetch(`${server.url}/api/rooms/messages?room=reject-room&after=${ledgerBefore}`, {
    headers: { Cookie: cookie },
  })).json()) as { messages: { author: string; text: string }[] }).messages;
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.author, "system");
  assert.equal(lines[0]?.text, `拒絕 codex 終端的加入申請（席位 ${pending.id.slice(0, 8)}）`);
  const again = await reject({ room: "reject-room", presenceId: pending.id });
  assert.equal(again.status, 400);
  assert.deepEqual(await again.json(), { error: "PRESENCE_JOIN_NOT_REQUESTED" });
  // The terminal may ask again afterwards.
  presenceStore.requestJoin(pending.id, "reject-room", workspace);
  assert.equal((await sessions()).some((session) => session.id === pending.id && session.requested), true);
});

test("Web dashboard cancels only the exact active Writer run", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-web-cancel-data-"));
  const workspace = await repository();
  await writeFile(
    join(data, "workspace-roots.json"),
    `${JSON.stringify([{ id: "cancel-root", label: "Cancel root", path: workspace }])}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));

  const app = await createAppContext(data);
  t.after(() => app.close());
  const ledger = new RoomLedger(app.store.dataDirectory);
  ledger.createRoom("cancel-room", await realpath(workspace));
  ledger.close();

  let cancelObserved = false;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const server = await startWebServer(app, 0, {
    invokeWriter: async ({ signal }) => {
      markStarted?.();
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          cancelObserved = true;
          reject(new Error("PROVIDER_ABORTED"));
        }, { once: true });
      });
    },
  });
  t.after(async () => await server.close());

  const index = await fetch(server.url);
  const cookie = (index.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.match(cookie, /^orchestratory_session_[0-9]+=/u);
  const bootstrap = await fetch(`${server.url}/api/bootstrap`, { headers: { Cookie: cookie } });
  const { csrf } = (await bootstrap.json()) as { csrf: string };
  const headers = {
    Cookie: cookie,
    Origin: server.url,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };

  const grant = await fetch(`${server.url}/api/rooms/writers/grant`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      room: "cancel-room",
      taskId: "cancel-task",
      candidate: { origin: "resident", provider: "claude" },
    }),
  });
  const grantBody = (await grant.json()) as { lease?: { id: string }; error?: string };
  assert.equal(grant.status, 201, JSON.stringify(grantBody));
  assert.ok(grantBody.lease?.id);

  const running = fetch(`${server.url}/api/rooms/writers/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ room: "cancel-room", taskId: "cancel-task", task: "wait until cancelled" }),
  });
  await Promise.race([
    started,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("WRITER_RUN_START_TIMEOUT")), 2_000);
    }),
  ]);

  const busy = await fetch(`${server.url}/api/rooms/writers?room=cancel-room`, {
    headers: { Cookie: cookie },
  });
  const busyBody = (await busy.json()) as { busyLeaseIds: string[] };
  assert.deepEqual(busyBody.busyLeaseIds, [grantBody.lease.id]);

  const wrongRoom = await fetch(`${server.url}/api/rooms/writers/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ room: "missing-room", taskId: "cancel-task" }),
  });
  assert.equal(wrongRoom.status, 400);

  const cancelled = await fetch(`${server.url}/api/rooms/writers/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ room: "cancel-room", taskId: "cancel-task" }),
  });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal((await running).status, 400);
  assert.equal(cancelObserved, true);
});

/*
 * PITFALLS #83: asserting that a source line exists proves nothing about whether it ever runs.
 * The apply-back gate is therefore written as a DOM-free block that this test actually executes,
 * so every claim below is about behaviour. The repository has no DOM runner (D-006), so the
 * DOM wiring around this block still needs manual browser acceptance.
 */
test("Main-workspace apply-back gate behaves correctly when executed", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start apply-back-gate");
  const end = source.indexOf("/* @pure-end apply-back-gate */");
  assert.ok(start > 0 && end > start, "public/app.js must expose the DOM-free apply-back gate block");
  const block = source.slice(start, end);
  // Executing a slice only proves behaviour if the slice really is free of DOM, network and timers.
  // Matched on use, not on the words themselves, so bilingual copy may still say "window".
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );

  const gate = runInNewContext(
    `${block}\n({ applyBackGate, applyBackBlockers, applyBackScrolledToBottom, applyBackRisk,`
    + " formatApplyBackCountdown, formatApplyBackBytes, APPLY_BACK_CONFIRMATION_PHRASE });",
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as {
    applyBackGate: (view: unknown) => {
      ready: boolean;
      inputDisabled: boolean;
      inputValue: string;
      confirmDisabled: boolean;
      hint: string;
    };
    applyBackBlockers: (view: unknown) => string[];
    applyBackScrolledToBottom: (metrics: unknown) => boolean;
    applyBackRisk: (preview: unknown, blockerCount: number) => { key: string; text: string };
    formatApplyBackCountdown: (ms: number) => string;
    formatApplyBackBytes: (bytes: unknown) => string;
    APPLY_BACK_CONFIRMATION_PHRASE: string;
  };

  // The phrase is the same semantic one room.js uses, and carries no identifier to transcribe.
  assert.equal(gate.APPLY_BACK_CONFIRMATION_PHRASE, "MERGE INTO MAIN");

  const passing = { blockers: [], scrolled: true, decided: false, typed: "MERGE INTO MAIN" };
  const open = gate.applyBackGate(passing);
  assert.equal(open.ready, true);
  assert.equal(open.inputDisabled, false);
  assert.equal(open.confirmDisabled, false);

  // Scroll-gate: without having reached the bottom the input is disabled and its value is wiped,
  // so a phrase typed before the content was read cannot survive into an approval.
  const unread = gate.applyBackGate({ ...passing, scrolled: false });
  assert.equal(unread.ready, false);
  assert.equal(unread.inputDisabled, true);
  assert.equal(unread.inputValue, "");
  assert.equal(unread.confirmDisabled, true);
  assert.match(unread.hint, /捲到底/u);

  // A blocking item holds both controls down even when everything else is satisfied.
  const blocked = gate.applyBackGate({ ...passing, blockers: ["衝突"] });
  assert.equal(blocked.inputDisabled, true);
  assert.equal(blocked.inputValue, "");
  assert.equal(blocked.confirmDisabled, true);
  assert.match(blocked.hint, /阻擋區/u);

  // An already decided apply-back cannot be decided a second time.
  const decided = gate.applyBackGate({ ...passing, decided: true });
  assert.equal(decided.confirmDisabled, true);
  assert.equal(decided.inputDisabled, true);
  assert.match(decided.hint, /已經有結果/u);

  // Near misses must not open the gate.
  for (const typed of ["", "merge into main", "MERGE INTO MAIN ", " MERGE INTO MAIN", "MERGE  INTO MAIN", "MERGE INTO MAI"]) {
    assert.equal(gate.applyBackGate({ ...passing, typed }).confirmDisabled, true, typed);
  }
  // Missing and malformed inputs fail closed rather than open.
  assert.equal(gate.applyBackGate(undefined).confirmDisabled, true);
  assert.equal(gate.applyBackGate({}).confirmDisabled, true);

  // Scroll detection, including the 4px tolerance and unusable metrics.
  assert.equal(gate.applyBackScrolledToBottom({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 }), false);
  assert.equal(gate.applyBackScrolledToBottom({ scrollTop: 200, clientHeight: 100, scrollHeight: 400 }), false);
  assert.equal(gate.applyBackScrolledToBottom({ scrollTop: 297, clientHeight: 100, scrollHeight: 400 }), true);
  assert.equal(gate.applyBackScrolledToBottom({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }), true);
  // Content shorter than the viewport is already at the bottom.
  assert.equal(gate.applyBackScrolledToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 120 }), true);
  assert.equal(gate.applyBackScrolledToBottom(null), false);
  assert.equal(gate.applyBackScrolledToBottom({}), false);

  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const preview = {
    id: "preview",
    expiresAt: new Date(now + 60_000).toISOString(),
    files: 2,
    changes: [{ path: "a" }, { path: "b" }],
    risk: { level: "medium", reasons: ["1 個既有檔案內容將被覆寫"] },
  };
  // A complete, unexpired preview with loaded content blocks nothing.
  assert.equal(gate.applyBackBlockers({ preview, diffState: "loaded", applying: false, now }).length, 0);
  assert.equal(gate.applyBackGate({ ...passing, blockers: [] }).confirmDisabled, false);
  // Every one of these is a blocker, and each one alone keeps the gate shut.
  const cases: Array<[string, unknown]> = [
    ["no preview", { preview: null, diffState: "loaded", now }],
    ["expired preview", { preview: { ...preview, expiresAt: new Date(now - 1).toISOString() }, diffState: "loaded", now }],
    ["unparsable expiry", { preview: { ...preview, expiresAt: "not-a-date" }, diffState: "loaded", now }],
    ["change content failed", { preview, diffState: "failed", now }],
    ["change content still loading", { preview, diffState: "loading", now }],
    ["truncated change list", { preview: { ...preview, files: 5 }, diffState: "loaded", now }],
    ["already applying", { preview, diffState: "loaded", applying: true, now }],
  ];
  for (const [name, view] of cases) {
    const blockers = gate.applyBackBlockers(view);
    assert.ok(blockers.length > 0, name);
    assert.equal(gate.applyBackGate({ ...passing, blockers }).confirmDisabled, true, name);
    assert.equal(gate.applyBackGate({ ...passing, blockers }).inputDisabled, true, name);
  }

  // Risk level: any blocker forces HIGH, and an unknown or missing level fails closed to HIGH.
  assert.equal(gate.applyBackRisk({ risk: { level: "low" } }, 0).key, "low");
  assert.equal(gate.applyBackRisk({ risk: { level: "medium" } }, 0).key, "medium");
  assert.equal(gate.applyBackRisk({ risk: { level: "high" } }, 0).key, "high");
  assert.equal(gate.applyBackRisk({ risk: { level: "low" } }, 1).key, "high");
  assert.equal(gate.applyBackRisk({ risk: { level: "toString" } }, 0).key, "high");
  assert.equal(gate.applyBackRisk({ risk: {} }, 0).key, "high");
  assert.equal(gate.applyBackRisk(null, 0).key, "high");
  assert.match(gate.applyBackRisk({ risk: { level: "medium" } }, 0).text, /中風險 · MEDIUM/u);

  // The countdown room.js proved window.prompt could never show.
  assert.equal(gate.formatApplyBackCountdown(125_000), "02:05");
  assert.equal(gate.formatApplyBackCountdown(0), "00:00");
  assert.equal(gate.formatApplyBackCountdown(-5_000), "00:00");
  assert.equal(gate.formatApplyBackBytes(512), "512 B");
  assert.equal(gate.formatApplyBackBytes(2_048), "2.0 KB");
  assert.equal(gate.formatApplyBackBytes("nope"), "—");
});

/*
 * P0-2. The Writer apply-back approval used to be a window.prompt, which fails three separate
 * ways: a browser can silence it for good (it then returns null and the approval UI dies without
 * saying so), it truncates the phrase printed beneath a long change list, and it freezes the page
 * while the 120s preview TTL expires underneath it. The replacement dialog's gate is written as a
 * DOM-free block so this test can execute it rather than grep for it (PITFALLS #83). The DOM
 * wiring around it still needs manual browser acceptance (D-006).
 */
test("Room Writer apply-back gate behaves correctly when executed", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start writer-apply-back-gate");
  const end = source.indexOf("/* @pure-end writer-apply-back-gate */");
  assert.ok(start > 0 && end > start, "public/room.js must expose the DOM-free writer apply-back gate block");
  const block = source.slice(start, end);
  // Executing a slice only proves behaviour if the slice really is free of DOM, network and timers.
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );

  const gate = runInNewContext(
    `${block}\n({ writerApplyBackGate, writerApplyBackBlockers, writerApplyBackScrolledToBottom,`
    + " writerApplyBackRisk, formatWriterApplyBackCountdown, formatWriterApplyBackBytes });",
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as {
    writerApplyBackGate: (view: unknown) => {
      ready: boolean;
      phrase: string;
      inputDisabled: boolean;
      inputValue: string;
      confirmDisabled: boolean;
      hint: string;
    };
    writerApplyBackBlockers: (view: unknown) => string[];
    writerApplyBackScrolledToBottom: (metrics: unknown) => boolean;
    writerApplyBackRisk: (preview: unknown, blockerCount: number) => { key: string; text: string };
    formatWriterApplyBackCountdown: (ms: number) => string;
    formatWriterApplyBackBytes: (bytes: unknown) => string;
  };

  // No phrase is spelled out in this block at all: there is nothing here to drift from the endpoint.
  assert.doesNotMatch(block, /APPLY WRITER|APPLY BACK TO SOURCE|MERGE INTO MAIN/u);

  const passing = {
    blockers: [],
    scrolled: true,
    decided: false,
    phrase: APPLY_BACK_CONFIRMATION,
    typed: APPLY_BACK_CONFIRMATION,
  };
  const open = gate.writerApplyBackGate(passing);
  assert.equal(open.ready, true);
  assert.equal(open.inputDisabled, false);
  assert.equal(open.confirmDisabled, false);
  assert.equal(open.phrase, APPLY_BACK_CONFIRMATION);

  /*
   * The phrase is whatever the backend said, not a copy kept here. Change the value and the gate
   * follows it in both directions: the new sentence opens the gate, and the sentence that used to
   * open it no longer does. A hard-coded fallback would fail the second half.
   */
  const relabelled = { ...passing, phrase: "WRITE INTO THE PROJECT", typed: "WRITE INTO THE PROJECT" };
  assert.equal(gate.writerApplyBackGate(relabelled).confirmDisabled, false);
  assert.equal(gate.writerApplyBackGate(relabelled).phrase, "WRITE INTO THE PROJECT");
  assert.equal(
    gate.writerApplyBackGate({ ...relabelled, typed: APPLY_BACK_CONFIRMATION }).confirmDisabled,
    true,
  );

  // A missing phrase fails towards "cannot approve", never towards a default sentence.
  for (const phrase of ["", undefined, null, 42, {}]) {
    const missing = gate.writerApplyBackGate({ ...passing, phrase });
    assert.equal(missing.ready, false, String(phrase));
    assert.equal(missing.inputDisabled, true, String(phrase));
    assert.equal(missing.inputValue, "", String(phrase));
    assert.equal(missing.confirmDisabled, true, String(phrase));
    assert.equal(missing.phrase, "", String(phrase));
  }
  assert.match(gate.writerApplyBackGate({ ...passing, phrase: "" }).hint, /沒有給確認短語/u);

  // Scroll-gate: without having reached the bottom the input is disabled and its value is wiped.
  const unread = gate.writerApplyBackGate({ ...passing, scrolled: false });
  assert.equal(unread.ready, false);
  assert.equal(unread.inputDisabled, true);
  assert.equal(unread.inputValue, "");
  assert.equal(unread.confirmDisabled, true);
  assert.match(unread.hint, /捲到底/u);

  const blocked = gate.writerApplyBackGate({ ...passing, blockers: ["衝突"] });
  assert.equal(blocked.inputDisabled, true);
  assert.equal(blocked.inputValue, "");
  assert.equal(blocked.confirmDisabled, true);
  assert.match(blocked.hint, /阻擋區/u);

  const decided = gate.writerApplyBackGate({ ...passing, decided: true });
  assert.equal(decided.confirmDisabled, true);
  assert.equal(decided.inputDisabled, true);
  assert.match(decided.hint, /已經有結果/u);

  // Near misses must not open the gate.
  for (const typed of ["", "merge into main", "MERGE INTO MAIN ", " MERGE INTO MAIN", "MERGE  INTO MAIN", "MERGE INTO MAI"]) {
    assert.equal(gate.writerApplyBackGate({ ...passing, typed }).confirmDisabled, true, typed);
  }
  assert.equal(gate.writerApplyBackGate(undefined).confirmDisabled, true);
  assert.equal(gate.writerApplyBackGate({}).confirmDisabled, true);

  assert.equal(gate.writerApplyBackScrolledToBottom({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 }), false);
  assert.equal(gate.writerApplyBackScrolledToBottom({ scrollTop: 297, clientHeight: 100, scrollHeight: 400 }), true);
  assert.equal(gate.writerApplyBackScrolledToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 120 }), true);
  assert.equal(gate.writerApplyBackScrolledToBottom(null), false);
  assert.equal(gate.writerApplyBackScrolledToBottom({}), false);

  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const preview = {
    id: "preview",
    expiresAt: new Date(now + 60_000).toISOString(),
    files: 2,
    changes: [{ path: "a" }, { path: "b" }],
    risk: { level: "medium", reasons: ["1 個既有檔案內容將被覆寫"] },
  };
  const clean = { preview, phrase: APPLY_BACK_CONFIRMATION, diffState: "loaded", applying: false, now };
  assert.equal(gate.writerApplyBackBlockers(clean).length, 0);
  // Every one of these is a blocker, and each one alone keeps the gate shut.
  const cases: Array<[string, unknown]> = [
    ["no preview", { ...clean, preview: null }],
    ["no phrase from the backend", { ...clean, phrase: "" }],
    ["non-string phrase", { ...clean, phrase: 7 }],
    ["expired preview", { ...clean, preview: { ...preview, expiresAt: new Date(now - 1).toISOString() } }],
    ["unparsable expiry", { ...clean, preview: { ...preview, expiresAt: "not-a-date" } }],
    ["change content failed", { ...clean, diffState: "failed" }],
    ["change content still loading", { ...clean, diffState: "loading" }],
    ["truncated change list", { ...clean, preview: { ...preview, files: 5 } }],
    ["already applying", { ...clean, applying: true }],
  ];
  for (const [name, view] of cases) {
    const blockers = gate.writerApplyBackBlockers(view);
    assert.ok(blockers.length > 0, name);
    assert.equal(gate.writerApplyBackGate({ ...passing, blockers }).confirmDisabled, true, name);
    assert.equal(gate.writerApplyBackGate({ ...passing, blockers }).inputDisabled, true, name);
  }

  // Risk level: any blocker forces HIGH, and an unknown or missing level fails closed to HIGH.
  assert.equal(gate.writerApplyBackRisk({ risk: { level: "low" } }, 0).key, "low");
  assert.equal(gate.writerApplyBackRisk({ risk: { level: "high" } }, 0).key, "high");
  assert.equal(gate.writerApplyBackRisk({ risk: { level: "low" } }, 1).key, "high");
  assert.equal(gate.writerApplyBackRisk({ risk: { level: "toString" } }, 0).key, "high");
  assert.equal(gate.writerApplyBackRisk({ risk: {} }, 0).key, "high");
  assert.equal(gate.writerApplyBackRisk(null, 0).key, "high");

  // The countdown window.prompt could never show, because it froze the page while it ran.
  assert.equal(gate.formatWriterApplyBackCountdown(125_000), "02:05");
  assert.equal(gate.formatWriterApplyBackCountdown(0), "00:00");
  assert.equal(gate.formatWriterApplyBackCountdown(-5_000), "00:00");
  assert.equal(gate.formatWriterApplyBackBytes(512), "512 B");
  assert.equal(gate.formatWriterApplyBackBytes(2_048), "2.0 KB");
  assert.equal(gate.formatWriterApplyBackBytes("nope"), "—");
});

/*
 * The GUI used to hard-code "everything except fake costs quota". When the local
 * loopback provider became a selectable planner/reviewer, that line started telling
 * the owner their no-cost run would spend subscription quota — the exact opposite of
 * why they picked it. The browser cannot import the TypeScript billing table, so the
 * mirrored constant is compared against it here: drift fails this test.
 */
test("the dashboard bundle stays in sync with the provider billing table", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const match = source.match(/const NO_COST_PROVIDER_IDS = Object\.freeze\((\[[^\]]*\])\)/u);
  assert.ok(match?.[1], "NO_COST_PROVIDER_IDS literal not found in public/app.js");
  const mirrored = JSON.parse(match[1]) as string[];
  assert.deepEqual(mirrored, ALL_PROVIDER_IDS.filter((id) => isNoCostProvider(id)));
  // The list must exist exactly once: a second hard-coded copy is what caused the bug.
  assert.equal(source.includes('provider !== "fake"'), false);
  assert.equal(source.includes('item.provider !== "fake"'), false);
  assert.equal(source.includes('team.writer.provider === "fake"'), false);
});

/*
 * And the copy itself, executed rather than grepped: picking only no-cost providers
 * must produce no quota warning at all, not a softer one.
 */
test("no-cost provider selections produce no subscription-quota copy", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start provider-cost");
  const end = source.indexOf("/* @pure-end provider-cost */");
  assert.ok(start >= 0 && end > start, "public/app.js must expose the DOM-free provider-cost block");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout)\s*\()/u,
  );
  const cost = runInNewContext(
    `${block}\n({ isNoCostProvider, teamUsesPaidQuota, quotaFactValue, runConsentMessage, chatConsentMessage,`
    + " NO_COST_PROVIDER_IDS });",
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as {
    isNoCostProvider: (id: unknown) => boolean;
    teamUsesPaidQuota: (members: unknown) => boolean;
    quotaFactValue: (members: unknown) => string;
    runConsentMessage: (members: unknown) => string;
    chatConsentMessage: (id: unknown) => string;
    NO_COST_PROVIDER_IDS: readonly string[];
  };

  for (const id of ALL_PROVIDER_IDS) {
    assert.equal(cost.isNoCostProvider(id), isNoCostProvider(id), id);
  }
  // An id the browser has never heard of is treated as billed, never as free.
  for (const unknown of ["", "future-provider", undefined, null, 42]) {
    assert.equal(cost.isNoCostProvider(unknown), false, String(unknown));
  }

  const local = { provider: "local" };
  const fake = { provider: "fake" };
  const codex = { provider: "codex" };
  // The exact combination the reviewer drove in a real browser: planner and reviewer
  // local, writer fake. No dialog at all, and the fact row says the quota is not used.
  const noCostTeam = [local, fake, local];
  assert.equal(cost.teamUsesPaidQuota(noCostTeam), false);
  assert.equal(cost.runConsentMessage(noCostTeam), "");
  assert.equal(cost.quotaFactValue(noCostTeam), "不使用");
  // One billed member anywhere in the team brings the warning back, with the quota wording.
  for (const team of [[codex, fake, local], [local, codex, local], [local, fake, codex]]) {
    assert.equal(cost.teamUsesPaidQuota(team), true);
    assert.match(cost.runConsentMessage(team), /訂閱額度/u);
    assert.equal(cost.quotaFactValue(team), "訂閱");
  }
  // Same rule for the conversation's first call.
  assert.equal(cost.chatConsentMessage("local"), "");
  assert.equal(cost.chatConsentMessage("fake"), "");
  assert.match(cost.chatConsentMessage("codex"), /訂閱額度/u);
  assert.match(cost.chatConsentMessage("claude"), /訂閱額度/u);
  assert.match(cost.chatConsentMessage("unknown"), /訂閱額度/u);
});

/*
 * "Joined" and "listening" are different facts, and the gap between them is the whole reason work
 * gets sent to nobody. This asserts the seat row says which one is true in words that answer the
 * reader's real question -- will anything happen if I send this now -- rather than naming the tool
 * call that is or is not open.
 */
test("a seat row distinguishes listening from merely present, in plain words", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start seat-listening-state");
  const end = source.indexOf("/* @pure-end seat-listening-state */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free seat state");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const seat = runInNewContext(
    `${block}\n({ seatListeningState });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as {
    seatListeningState: (session: unknown) => { key: string; mark: string; text: string; title: string; send: string; fix: string; cls: string };
  };

  const listening = seat.seatListeningState({ joined: true, standbyApproved: true, listening: true });
  const silent = seat.seatListeningState({ joined: true, standbyApproved: true, listening: false });
  const pending = seat.seatListeningState({ joined: true, standbyRequested: true, standbyApproved: false });
  const noStandby = seat.seatListeningState({ joined: true });
  const notJoined = seat.seatListeningState({ joined: false });

  assert.deepEqual(
    [listening.key, silent.key, pending.key, noStandby.key, notJoined.key],
    ["listening", "not-listening", "awaiting-approval", "no-standby", "not-joined"],
  );

  // The one that used to be invisible: approved AND present AND still deaf. It must not read as a
  // milder version of "listening" -- the reader's next action is different.
  assert.notEqual(silent.text, listening.text);
  // Refused is not queued. postToExternal throws TARGET_AGENT_STANDBY_NOT_APPROVED before anything is
  // enqueued, so a state without standby authority must never promise the work will wait for it --
  // the first pass said "會排隊等著" for exactly these two states, contradicting its own badge.
  assert.match(silent.send, /排隊/u);
  assert.doesNotMatch(pending.send, /排隊/u, "a seat awaiting approval refuses the send, it does not queue it");
  assert.doesNotMatch(noStandby.send, /排隊/u, "and neither does one with no standby authority");
  assert.match(pending.fix, /核准/u, "the fix for an unapproved seat is a button here, not a trip to the terminal");
  assert.match(silent.fix, /room_wait/u, "the fix for a silent seat is at its terminal");
  assert.equal(listening.fix, "", "a listening seat needs nothing fixed");

  assert.match(silent.title, /排隊/u, "a silent seat must say the work will WAIT, not that it was delivered");
  assert.match(silent.title, /沒有辦法從這裡叫醒/u, "and must not imply the GUI can wake it, because it cannot");
  // Deliberately NOT a promise of arrival. The liveness lease runs up to 15s and the GUI polls every
  // 5s, so a seat killed a moment ago still reads as listening for a short while. What we can state
  // is what we do with the delivery, not what the other end will do with it.
  assert.match(listening.title, /直接送過去/u);
  assert.doesNotMatch(listening.title, /馬上收到|立刻收到|一定/u,
    "a 15s lease cannot support a promise that the other end receives it");

  // Distinguishable without colour. Every state carries its own mark, and no two share one, so the
  // row still reads for someone who cannot separate the greens from the greys.
  // All FIVE, including notJoined: the collision this replaced was between not-joined and
  // no-standby, and a set that leaves one of them out cannot catch it coming back.
  const marks = [listening.mark, silent.mark, pending.mark, noStandby.mark, notJoined.mark];
  assert.equal(new Set(marks).size, marks.length, "each listening state needs its own mark, not just its own colour");
  // The pure function passing proves nothing about the badge being on screen: this test slices the
  // block out of the file and runs it in a bare context, so deleting `badge` from the row would leave
  // every assertion here green and the state invisible. These two anchor the wiring.
  assert.match(source, /seatListeningState\(session\)/u, "the presence row must actually consult the state");
  assert.match(source, /identity\.append\(dot, label, badge, detail\)/u, "and must actually render the badge");
  assert.match(source, /seatListeningState\(seatBehindDesk\)/u, "the office card must consult it too");

  for (const stateValue of [listening, silent, pending, noStandby, notJoined]) {
    assert.ok(stateValue.text.length > 0 && stateValue.title.length > 0);
    assert.doesNotMatch(stateValue.text, /room_wait|standby|MCP/u,
      `"${stateValue.text}" names the mechanism where it should answer the question`);
  }
});

/*
 * The office task footer names a draft area by its candidate id, and the only place that id travels
 * today is the candidate path the registry builds. Reading it back has to be strict: a task id, a
 * mangled id, a trailing slash or some other directory under the data root must all come back as
 * null, because the footer would otherwise print an identifier that is not on disk.
 */
test("the task footer takes a candidate id only from a well-formed candidates/<uuid> path", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start candidate-id-from-approval");
  const end = source.indexOf("/* @pure-end candidate-id-from-approval */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free candidate id reader");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const reader = runInNewContext(
    `${block}\n({ candidateIdFromApproval });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as { candidateIdFromApproval: (approval: unknown) => string | null };
  const id = "1dca001d-0000-4000-8000-000000000001";
  assert.equal(reader.candidateIdFromApproval({ binding: { candidatePath: `/data/candidates/${id}` } }), id);
  assert.equal(reader.candidateIdFromApproval({ candidateId: id }), id, "an explicit id of the right shape is accepted");
  // Malformed UUID: the registry never mints this, so it is not a draft area.
  assert.equal(reader.candidateIdFromApproval({ binding: { candidatePath: "/data/candidates/1dca001d-not-a-uuid" } }), null);
  // Trailing slash: the last segment is empty, and the id must not be fished out of the one before.
  assert.equal(reader.candidateIdFromApproval({ binding: { candidatePath: `/data/candidates/${id}/` } }), null);
  // Not under candidates/: a worktree or any other directory is a different thing entirely.
  assert.equal(reader.candidateIdFromApproval({ binding: { candidatePath: `/data/worktrees/${id}` } }), null);
  // And a task id is never a substitute.
  assert.equal(reader.candidateIdFromApproval({ taskId: id, binding: { candidatePath: "/data/main" } }), null);
  assert.equal(reader.candidateIdFromApproval(undefined), null);
  // Wiring: the footer must consult the reader rather than carry its own parse.
  assert.match(source, /candidateId: candidateIdFromApproval\(approval\)/u);
});

test("the ledger groups by LOCAL day and opens the newest one", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start ledger-day-groups");
  const end = source.indexOf("/* @pure-end ledger-day-groups */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free ledger grouper");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const grouper = runInNewContext(
    `${block}\n({ ledgerDayKey, ledgerDayLabel, ledgerDayGroups });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as {
    ledgerDayKey: (at: unknown) => string;
    ledgerDayLabel: (key: string, todayKey: string) => string;
    ledgerDayGroups: (messages: unknown, todayKey: string) => {
      groups: { key: string; label: string; messages: { seq: number }[] }[];
      openKey: string;
    };
  };

  // Built from LOCAL components on purpose: the assertion below is about the local calendar, and a
  // literal ISO string would encode this machine's offset into the expectation.
  const localIso = (y: number, m: number, d: number, h: number, min: number): string =>
    new Date(y, m - 1, d, h, min).toISOString();

  // The boundary the naive implementation gets wrong. In any zone east of UTC these two are the
  // same UTC date, so `at.slice(0, 10)` files them together; they are different evenings to a
  // reader, and that is whose day this is.
  const lateNight = localIso(2026, 8, 20, 23, 30);
  const justAfter = localIso(2026, 8, 21, 0, 10);
  assert.notEqual(
    grouper.ledgerDayKey(lateNight),
    grouper.ledgerDayKey(justAfter),
    "40 minutes across local midnight must be two days, whatever UTC says",
  );
  assert.equal(grouper.ledgerDayKey(lateNight), "2026-08-20");
  assert.equal(grouper.ledgerDayKey(justAfter), "2026-08-21");

  const messages = [
    { seq: 1, at: localIso(2026, 8, 19, 9, 0) },
    { seq: 2, at: lateNight },
    { seq: 3, at: justAfter },
    { seq: 4, at: localIso(2026, 8, 21, 18, 0) },
  ];
  const { groups, openKey } = grouper.ledgerDayGroups(messages, "2026-08-21");
  // `[...x]` re-homes the value: the grouper runs in another vm context, so the array it builds has
  // that context's Array prototype and deepEqual (strict) refuses it as a different kind of thing.
  assert.deepEqual([...groups].map((group) => group.key), ["2026-08-19", "2026-08-20", "2026-08-21"]);
  assert.deepEqual([...groups].map((group) => group.messages.length), [1, 1, 2]);
  // Oldest first, so the newest ends up nearest the composer the stream already scrolls to.
  assert.equal(openKey, "2026-08-21", "the newest day is the one a reader arrived for");
  assert.deepEqual([...groups].map((group) => group.label), ["8 月 19 日", "昨天", "今天"]);

  // A year that is not this one is spelled out; the same date in the current year is not.
  assert.equal(grouper.ledgerDayLabel("2025-12-31", "2026-08-21"), "2025 年 12 月 31 日");

  // Order comes from the DATE, not from the order the messages arrived. This matters because the
  // ledger is served newest-first with older pages loaded on scroll, so the input is routinely NOT
  // sorted oldest-first. An earlier version kept insertion order and called the last bucket the
  // newest, which passed the sorted case above and got both the order and the open day wrong here.
  const shuffled = grouper.ledgerDayGroups([
    { seq: 4, at: localIso(2026, 8, 21, 18, 0) },
    { seq: 1, at: localIso(2026, 8, 19, 9, 0) },
    { seq: 3, at: justAfter },
    { seq: 2, at: lateNight },
  ], "2026-08-21");
  assert.deepEqual([...shuffled.groups].map((group) => group.key), ["2026-08-19", "2026-08-20", "2026-08-21"]);
  assert.equal(shuffled.openKey, "2026-08-21", "the newest DAY opens, not the day of the first message in");

  // Untrusted input: a malformed timestamp becomes its own named bucket rather than throwing or
  // silently joining a real day.
  const broken = grouper.ledgerDayGroups([{ seq: 9, at: "not-a-date" }], "2026-08-21");
  assert.equal(broken.groups.length, 1);
  assert.equal(broken.groups[0]?.label, "日期不明");

  // A NaN check alone is not enough: `new Date(null)` is the epoch and `new Date(0)` is a real
  // instant, so anything that is not a parseable string used to be filed under 1970-01-01 — a real
  // day bucket, shown with the same confidence as a true one.
  assert.equal(grouper.ledgerDayKey(null), "");
  assert.equal(grouper.ledgerDayKey(0), "");
  assert.equal(grouper.ledgerDayKey(undefined), "");

  // The undated bucket sorts to the front and can never be the open one. Parked last it would sit
  // against the composer and auto-expand, reading as "the newest thing that happened".
  const mixed = grouper.ledgerDayGroups([
    { seq: 1, at: localIso(2026, 8, 21, 10, 0) },
    { seq: 2, at: "not-a-date" },
  ], "2026-08-21");
  assert.deepEqual([...mixed.groups].map((group) => group.key), ["", "2026-08-21"]);
  assert.equal(mixed.openKey, "2026-08-21", "an undated bucket must not be mistaken for the newest day");

  const empty = grouper.ledgerDayGroups([], "2026-08-21");
  assert.equal([...empty.groups].length, 0);
  assert.equal(empty.openKey, "");
});

/*
 * The records panel can be opened from inside the merge approval layer. Closing it used to call
 * renderMergeApproval(), which rebuilds the diff region and sets scrollTop back to 0 -- so the
 * scroll-gate the owner had just passed was silently closed again, and the typed phrase, the
 * enabled state of the final button and the focus target could all move underneath them. This
 * runs the real closeMergeHistory() against a recording DOM stand-in and asserts that the only
 * thing it touches in the open approval layer is the one-line records summary.
 */
test("closing the records panel leaves the open approval gate exactly as the owner left it", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const fn = (name: string) => {
    const found = new RegExp(String.raw`^(?:async )?function ${name}\([\s\S]*?^\}$`, "mu").exec(source);
    assert.ok(found, `${name}() is gone from public/room.js`);
    return found[0];
  };
  const bucketsStart = source.indexOf("/* @pure-start merge-history-buckets");
  const bucketsEnd = source.indexOf("/* @pure-end merge-history-buckets */");
  assert.ok(bucketsStart > 0 && bucketsEnd > bucketsStart);
  const closeSource = fn("closeMergeHistory");
  // The guard itself, stated on the source: no full re-render from the close path.
  assert.doesNotMatch(closeSource, /renderMergeApproval\(|renderMergeDiff\(|loadMergeApproval\(|updateMergeApprovalGate\(/u);
  assert.match(closeSource, /renderMergeApprovalHistorySummary\(\);/u);

  type Node = {
    id: string; hidden: boolean; textContent: string; value: string; scrollTop: number; disabled: boolean;
    attrs: Record<string, string>; setAttribute: (k: string, v: string) => void; getAttribute: (k: string) => string | null;
    focus: () => void; classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  };
  const focusLog: string[] = [];
  const node = (id: string, init: Partial<Node> = {}): Node => ({
    id, hidden: false, textContent: "", value: "", scrollTop: 0, disabled: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    focus() { focusLog.push(this.id); },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    ...init,
  });
  const nodes: Record<string, Node> = {};
  for (const n of [
    node("merge-history", { hidden: false }),
    node("merge-outcome-nav-status"),
    node("merge-approval", { hidden: false }),
    node("merge-approval-diff", { scrollTop: 358 }),
    node("merge-approval-confirmation", { value: "MERGE INTO MAIN", disabled: false }),
    node("merge-approval-confirm", { attrs: { "aria-disabled": "false" }, disabled: false }),
    node("merge-approval-ttl", { textContent: "04:11（12:52:24 到期）" }),
    node("merge-approval-scroll-hint", { textContent: "變更清單已捲到底" }),
    node("merge-approval-history-summary", { textContent: "尚未讀取" }),
    node("merge-approval-history-open"),
  ]) nodes[n.id] = n;
  /* Reads go through this rather than indexing directly. `Record<string, Node>` under
     noUncheckedIndexedAccess makes every lookup `Node | undefined`, and the twenty assertions below
     would each need a `!` to compile -- twenty places where a mistyped id would silently become
     undefined and the assertion would compare against nothing. Naming the missing id instead turns
     a fixture typo into the failure it is. */
  const at = (id: string): Node => {
    const found = nodes[id];
    if (!found) throw new Error(`the fixture has no node with id ${id}`);
    return found;
  };
  const state = {
    room: "demo",
    mergeApproval: { id: "a1", taskId: "t1", state: "requested", expired: false },
    mergeApprovalScrolled: true,
    mergeHistoryLoaded: true,
    mergeHistoryRoom: "demo",
    mergeHistory: [
      { id: "p1", state: "applied", mainHeadAfter: "abc", observation: { authorizedMergeCommit: true } },
      { id: "p2", state: "applying", observation: {} },
    ],
    mergeUnpromotedApprovals: [{ id: "a0", state: "expired", retry: { eligible: true } }],
    mergeHistoryReturnFocus: at("merge-approval-history-open"),
  };
  const sandbox = {
    state,
    byId: (id: string) => nodes[id] ?? null,
    document: { body: { classList: { add() {}, remove() {} } }, activeElement: null },
  };
  runInNewContext(
    `${source.slice(bucketsStart, bucketsEnd)}\n${fn("renderMergeApprovalHistorySummary")}\n${closeSource}\ncloseMergeHistory();`,
    sandbox,
    { timeout: 2_000 },
  );
  // What closing must do.
  assert.equal(at("merge-history").hidden, true);
  assert.equal(at("merge-approval-history-summary").textContent, "已併入 1 · 需檢查 1 · 未進入 1");
  assert.deepEqual(focusLog, ["merge-approval-history-open"], "focus returns to the control that opened the panel");
  assert.equal(state.mergeHistoryReturnFocus, null);
  // What closing must NOT do: the open approval layer is left exactly as the owner had it.
  assert.equal(at("merge-approval").hidden, false);
  assert.equal(at("merge-approval-diff").scrollTop, 358, "the scroll-gate the owner passed stays passed");
  assert.equal(at("merge-approval-confirmation").value, "MERGE INTO MAIN");
  assert.equal(at("merge-approval-confirmation").disabled, false);
  assert.equal(at("merge-approval-confirm").getAttribute("aria-disabled"), "false");
  assert.equal(at("merge-approval-confirm").disabled, false);
  assert.equal(at("merge-approval-ttl").textContent, "04:11（12:52:24 到期）");
  assert.equal(at("merge-approval-scroll-hint").textContent, "變更清單已捲到底");
  assert.equal(state.mergeApprovalScrolled, true);
  assert.equal(state.mergeApproval.id, "a1");
});

/*
 * Escape closes one surface at a time, top-most first. The top-bar popups (room menu, terminal
 * drawer) float above the approval layer, so an Escape pressed while the room menu is open must
 * close only the menu and hand focus back to its toggle -- the approval the owner is reviewing must
 * still be there for the next Escape. Runs the real handler against a recording DOM stand-in.
 */
test("Escape closes the top-bar popup first and only then the approval layer", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const fn = (name: string) => {
    const found = new RegExp(String.raw`^(?:async )?function ${name}\([\s\S]*?^\}$`, "mu").exec(source);
    assert.ok(found, `${name}() is gone from public/room.js`);
    return found[0];
  };
  assert.match(source, /document\.addEventListener\("keydown", handleEscapeKeydown\);/u);
  type Node = {
    id: string; hidden: boolean; value: string; disabled: boolean; attrs: Record<string, string>;
    setAttribute: (k: string, v: string) => void; getAttribute: (k: string) => string | null; focus: () => void;
  };
  const focusLog: string[] = [];
  const node = (id: string, init: Partial<Node> = {}): Node => ({
    id, hidden: true, value: "", disabled: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    focus() { focusLog.push(this.id); },
    ...init,
  });
  const nodes: Record<string, Node> = {};
  for (const n of [
    node("room-menu-panel", { hidden: false }),
    node("room-menu-toggle", { attrs: { "aria-expanded": "true" } }),
    node("agent-requests-panel", { hidden: true }),
    node("agent-requests-open", { attrs: { "aria-expanded": "false" } }),
    node("merge-history", { hidden: true }),
    node("merge-approval", { hidden: false }),
    node("merge-approval-confirmation", { value: "MERGE INTO MAIN" }),
    node("merge-approval-confirm"),
    node("merge-approval-cancel"),
  ]) nodes[n.id] = n;
  /* Reads go through this rather than indexing directly. `Record<string, Node>` under
     noUncheckedIndexedAccess makes every lookup `Node | undefined`, and the twenty assertions below
     would each need a `!` to compile -- twenty places where a mistyped id would silently become
     undefined and the assertion would compare against nothing. Naming the missing id instead turns
     a fixture typo into the failure it is. */
  const at = (id: string): Node => {
    const found = nodes[id];
    if (!found) throw new Error(`the fixture has no node with id ${id}`);
    return found;
  };
  const state = {
    mergeApproval: { id: "a1" }, mergeApprovalTicker: 7, mergeApprovalPoll: 8, mergeApprovalSubmitting: false,
    mergeApprovalInputApprovalId: "a1", mergeApprovalScrolled: true, mergeApprovalBlockers: [],
    mergeApprovalReturnFocus: at("merge-approval-cancel"),
  };
  const cleared: unknown[] = [];
  const sandbox = {
    state,
    byId: (id: string) => nodes[id] ?? null,
    document: { body: { classList: { add() {}, remove() {} } }, activeElement: null },
    clearInterval: (handle: unknown) => { cleared.push(handle); },
  };
  const escape = { key: "Escape" };
  runInNewContext(
    `${fn("setRoomMenuOpen")}\n${fn("setAgentRequestsOpen")}\n${fn("closeMergeHistory")}\n${fn("renderMergeApprovalHistorySummary")}\n`
      + `${fn("closeMergeApprovalDialog")}\n${fn("handleEscapeKeydown")}\n`
      + "function mergeHistoryBuckets() { throw new Error('the summary must not be rendered here'); }\n"
      + "globalThis.press = () => handleEscapeKeydown(escape);",
    Object.assign(sandbox, { escape }),
    { timeout: 2_000 },
  );
  const press = (sandbox as unknown as { press: () => void }).press;
  press();
  // First Escape: only the menu goes, focus returns to its toggle, the approval stays open and intact.
  assert.equal(at("room-menu-panel").hidden, true);
  assert.equal(at("room-menu-toggle").getAttribute("aria-expanded"), "false");
  assert.deepEqual(focusLog, ["room-menu-toggle"]);
  assert.equal(at("merge-approval").hidden, false);
  assert.equal(at("merge-approval-confirmation").value, "MERGE INTO MAIN");
  assert.equal(state.mergeApproval?.id, "a1");
  assert.deepEqual(cleared, []);
  // Second Escape: nothing floats above the approval layer any more, so it closes.
  press();
  assert.equal(at("merge-approval").hidden, true);
  assert.equal(state.mergeApproval, null);
  assert.deepEqual(focusLog, ["room-menu-toggle", "merge-approval-cancel"]);
  // And the drawer takes the same precedence as the menu.
  at("merge-approval").hidden = false;
  at("agent-requests-panel").hidden = false;
  press();
  assert.equal(at("agent-requests-panel").hidden, true);
  assert.equal(at("agent-requests-open").getAttribute("aria-expanded"), "false");
  assert.equal(at("merge-approval").hidden, false);
  assert.equal(focusLog.at(-1), "agent-requests-open");
});

/*
 * The task drawer's seat rows show the wake receipt, and the "noop" kind expires on a clock. The
 * drawer used to be repainted at that moment only when something else happened to render it, so
 * the receipt outlived its window on screen. The delay is computed by a DOM-free function that this
 * test executes; the wiring (every render books the repaint, a room switch drops it) is pinned.
 */
test("Room task drawer books one repaint for the next wake-receipt expiry", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start wake-notice-repaint");
  const end = source.indexOf("/* @pure-end wake-notice-repaint */");
  assert.ok(start > 0 && end > start, "public/room.js must expose the DOM-free wake-notice repaint block");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const sandbox: { delay?: (notices: unknown, now: number, ttl: number) => number | null } = {};
  runInNewContext(`${block}\nglobalThis.delay = wakeNoticeRepaintDelay;`, sandbox, { timeout: 2_000 });
  const delay = sandbox.delay;
  assert.ok(delay, "wakeNoticeRepaintDelay was not defined by the block");
  const ttl = 15_000;
  assert.equal(delay(undefined, 1_000_000, ttl), null);
  assert.equal(delay({}, 1_000_000, ttl), null);
  // A recorded receipt is retired by a presence change, never by the clock.
  assert.equal(delay({ a: { kind: "recorded", at: 999_000 } }, 1_000_000, ttl), null);
  // One noop receipt: the time left in its window.
  assert.equal(delay({ a: { kind: "noop", at: 990_000 } }, 1_000_000, ttl), 5_000);
  // Already past its window: seatWakeNotice draws it as absent, so nothing to wait for.
  assert.equal(delay({ a: { kind: "noop", at: 900_000 } }, 1_000_000, ttl), null);
  // Several: the earliest expiry wins, and junk entries are skipped rather than thrown on.
  assert.equal(
    delay({ a: { kind: "noop", at: 995_000 }, b: { kind: "noop", at: 990_000 }, c: null, d: { kind: "noop", at: "x" } }, 1_000_000, ttl),
    5_000,
  );
  // Wiring: the drawer books the repaint on every render and a room switch drops the booking.
  const render = /^function renderTaskCenter\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(render, /scheduleTaskCenterRepaint\(\);/u);
  const select = /^async function selectRoom\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(select, /clearTaskCenterRepaint\(\);/u);
  assert.match(source, /officeTaskRepaintTimer = setTimeout\(\(\) => \{\n {4}officeTaskRepaintTimer = null;\n {4}renderTaskCenter\(\);/u);
  assert.doesNotMatch(source, /setInterval\([^)]*renderTaskCenter/u);
});

test("the topbar carries an office/ledger switch the owner can use to pick either surface", async () => {
  const html = await readFile(new URL("../public/room.html", import.meta.url), "utf8");
  const topbar = /<header class="topbar"[\s\S]*?<\/header>/u.exec(html)?.[0] ?? "";
  assert.notEqual(topbar, "", "the room page has a topbar");
  /* Both buttons keep the ids switchView already toggles, so the existing wiring lights them up. */
  assert.match(topbar, /<button id="view-office" class="view-switch-button is-active" type="button" aria-pressed="true"/u);
  assert.match(topbar, /<button id="view-ledger" class="view-switch-button" type="button" aria-pressed="false"/u);
  assert.match(topbar, /<div class="view-switch" role="group"/u);
  /* The switch sits between the room menu and the count chips, and never inside the digested merge nav. */
  assert.ok(topbar.indexOf('id="room-menu"') < topbar.indexOf('class="view-switch"'));
  assert.ok(topbar.indexOf('class="view-switch"') < topbar.indexOf('class="topbar-chips"'));
  assert.ok(topbar.indexOf('class="topbar-chips"') < topbar.indexOf('class="merge-outcome-nav"'));
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  assert.match(source, /byId\("view-office"\)\?\.addEventListener\("click", \(\) => switchView\("office"\)\);/u);
  assert.match(source, /byId\("view-ledger"\)\?\.addEventListener\("click", \(\) => switchView\("ledger"\)\);/u);
  const switchView = /^function switchView\(view\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(switchView, /button\.setAttribute\("aria-pressed", String\(active\)\);/u);
  assert.match(switchView, /document\.body\.classList\.toggle\("view-office", office\);/u);
});

test("the bell drawer lists every waiting seat under 要你動手, wired to the panel's own approve handlers", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const render = /^function renderOfficeNotifications\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(render, "", "room.js keeps renderOfficeNotifications");
  /* Rows come from the seat list, not from whichever notifications survived the cap of thirty. */
  assert.match(render, /const seatRequests = pendingSeatRequests\(\);/u);
  assert.match(render, /if \(seatRequests\.length \|\| actionable\.length\) \{\s*list\.append\(groupHead\("要你動手"\)\);/u);
  assert.match(render, /seatRequestActions\(request\)/u);
  const actions = /^function seatRequestActions\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(actions, /approve\.textContent = "核准";/u);
  /* Same handlers as the terminal panel: nothing about approval is re-implemented for the drawer. */
  assert.match(actions, /changePresenceMembership\(session, approve\)/u);
  assert.match(actions, /changePresenceStandby\(session, "approve", approve\)/u);
  assert.match(actions, /changePresenceStandby\(session, "revoke", reject\)/u);
  /* Refusing a join is a server call, never a local put-away. */
  assert.match(actions, /reject\.textContent = "拒絕";[\s\S]*?rejectSeatJoin\(session, reject\)/u);
  assert.doesNotMatch(source, /dismissedSeatRequests|textContent = "不核准"/u);
  const rejectFn = /^async function rejectSeatJoin\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(rejectFn, /api\("\/api\/rooms\/presence\/reject", \{\s*method: "POST",\s*body: JSON\.stringify\(\{ room: state\.room, presenceId: session\.id \}\)/u);
  /* The announcement is unread and says where the button is; a lapse is reported, not swallowed. */
  assert.match(source, /"在這裡按核准，或到任務清單底部「⚙ 終端加入設定」[^"]*",\s*true,\s*\{ kind: "join-approve", presenceId: session\.id \}/u);
  assert.match(source, /的加入申請已逾時`/u);
  assert.doesNotMatch(source, /左側「新增 Agents」/u);
});

test("a new seat request puts a red banner on the stage, and the bell keeps counting after the banner goes", async () => {
  const html = await readFile(new URL("../public/room.html", import.meta.url), "utf8");
  const stage = /<section class="office-stage"[\s\S]*?<\/section>/u.exec(html)?.[0] ?? "";
  assert.match(stage, /<div id="office-seat-banner" class="office-seat-banner" hidden role="alert"/u);
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  assert.match(source, /^const SEAT_BANNER_AUTO_HIDE_MS = 20_000;$/mu);
  const banner = /^function renderSeatRequestBanner\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(banner, "", "room.js keeps renderSeatRequestBanner");
  assert.match(banner, /setTimeout\(dismissSeatRequestBanner, SEAT_BANNER_AUTO_HIDE_MS\)/u);
  /* The banner's buttons are the drawer's buttons: the same builder, the same handlers. */
  assert.match(banner, /seatRequestActions\(first\)/u);
  assert.match(banner, /later\.textContent = "稍後";/u);
  assert.match(banner, /筆，到 🔔 處理`/u);
  /* No browser permission prompt: the page never asks for Notification. */
  assert.doesNotMatch(source, /Notification\.requestPermission|new Notification\(/u);
  const render = /^function renderOfficeNotifications\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(render, /document\.title = pendingCount \? `\(\$\{pendingCount\}\) \$\{state\.documentTitle\}` : state\.documentTitle;/u);
  assert.match(render, /classList\.toggle\("has-seat-request", pendingCount > 0\)/u);
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.office-seat-banner \{[^}]*border: 2px solid #e66d73;/u);
  assert.match(css, /\.office-rail-button\.has-seat-request \{ animation: office-bell-pulse/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.office-seat-banner \{ animation: none; \}\s*\.office-rail-button\.has-seat-request \{ animation: none;/u);
});

test("no room copy points the owner at the sidebar that was removed", async () => {
  const html = await readFile(new URL("../public/room.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  /* Only quoted strings and markup text are copy; a comment that mentions a sidebar is history. */
  const strings = source.match(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/gu) ?? [];
  for (const literal of strings) {
    assert.doesNotMatch(literal, /左側|側欄|新增 Agents|左邊/u, `stale copy in room.js: ${literal}`);
  }
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/gu, ""), /左側|側欄|新增 Agents|左邊/u);
  /* The one place a join request is explained in the task drawer names the panel it means. */
  assert.match(source, /要取名或改協作模式，用下方「終端加入設定」/u);
});

test("a request card that lapsed or was answered goes grey and says which, with no buttons left", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const render = /^function renderOfficeNotifications\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  const informational = render.slice(render.indexOf("for (const item of informational) {"));
  assert.match(informational, /row\.classList\.add\("is-expired"\);/u);
  assert.match(informational, /tag\.textContent = rejected \? "已拒絕" : handled \? "已處理" : "已過期";/u);
  /* Only live requests get buttons: the informational loop never builds seatRequestActions. */
  assert.doesNotMatch(informational, /seatRequestActions\(|office-notification-action/u);
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.office-notification\.is-expired \{ opacity: \.55; \}/u);
  assert.match(css, /\.office-notification\.is-expired::before \{ display: none; \}/u);
});

test("the terminal panel states that turns mirror into the ledger, and offers no switch to turn it off", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const panel = /^function renderPresencePanel\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(panel, /syncLabel\.textContent = "此終端的對話會鏡射進帳本";/u);
  /* No control of any kind: not a switch, not a checkbox, no per-seat sync state to read. */
  assert.doesNotMatch(panel, /role", "switch"|presence-sync-input|presenceTurnSync|可選/u);
  assert.doesNotMatch(source, /presenceTurnSync/u);
  const join = /^async function changePresenceMembership\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  /* The join payload always carries syncTurns: true, from a literal, never from a UI value. */
  assert.match(join, /syncTurns: true,/u);
  assert.doesNotMatch(join, /syncTurns: (?!true,)/u);
});

test("the bell carries system state only: no reply or chat ever becomes a notification", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const calls = [...source.matchAll(/addOfficeNotification\(\s*"([a-z-]+)"/gu)].map((match) => match[1] ?? "");
  assert.ok(calls.length > 0, "room.js still raises office notifications");
  for (const kind of calls) assert.ok(!["message", "reply", "chat", "mention"].includes(kind), `chat-class notification kind: ${kind}`);
  assert.doesNotMatch(source, /有新回覆/u);
  const ingest = /^function ingestRoomNotifications\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(ingest, "");
  assert.doesNotMatch(ingest, /message\.kind === "chat"/u);
  assert.match(ingest, /message\.kind === "system"/u);
});

test("machine records in the ledger fold to a one-line summary; conversation never does", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start ledger-log-kind");
  const end = source.indexOf("/* @pure-end ledger-log-kind */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free ledger log classifier");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const reader = runInNewContext(`${block}\n({ ledgerLogKind });`, Object.create(null) as object, { timeout: 2_000 }) as {
    ledgerLogKind: (text: unknown) => { kind: string; summary: string } | null;
  };
  // Objects born in the vm realm carry that realm's prototype; compare their content, not their identity.
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

  // The three shapes visible-turn sync mirrors in, each with the summary a reader scans by.
  const notification = "<task-notification>\n<task-id>kvwybvp0i</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>";
  assert.deepEqual(plain(reader.ledgerLogKind(notification)), {
    kind: "task-notification",
    summary: "⚙ 系統紀錄 · task-notification · kvwybvp0i · completed",
  });
  const envelope = "<cross-session-message from=\"peer-57\" at=\"2026-09-04T13:02:11Z\">\n收工。\n</cross-session-message>";
  assert.deepEqual(plain(reader.ledgerLogKind(envelope)), { kind: "cross-session-message", summary: "⚙ 跨 session 訊息 · 來自 peer-57" });
  const json = JSON.stringify({ event: "candidate.checkpoint", taskId: "t-8f2a" }, null, 2);
  assert.equal(reader.ledgerLogKind(json)?.kind, "json");
  assert.equal(reader.ledgerLogKind(json)?.summary, '⚙ 機器紀錄 · JSON · {"event":"candidate.checkpoint","taskId":"t-8f2a"}');
  const stack = ["Error: DELIVERY_LEASE_EXPIRED", ...Array.from({ length: 14 }, (_, i) => `    at RoomInboxStore.#x (src/core/room-inbox.ts:${1395 + i}:21)`)].join("\n");
  assert.equal(reader.ledgerLogKind(stack)?.kind, "code");
  assert.equal(reader.ledgerLogKind(stack)?.summary, "⚙ 機器紀錄 · 15 行 · Error: DELIVERY_LEASE_EXPIRED");
  // A long first line is clipped, not dumped into the summary.
  const longJson = JSON.stringify({ text: "x".repeat(200) });
  const clipped = reader.ledgerLogKind(longJson)?.summary ?? "";
  assert.ok(clipped.endsWith("…") && clipped.length < 100, clipped);

  // Things a person wrote stay open, however long or however much they mention the tags.
  assert.equal(reader.ledgerLogKind("看了 P0-3：缺 test/web.test.ts 的 keyboard 案例，其餘都在。"), null);
  assert.equal(reader.ledgerLogKind("我看到 <task-notification> 進來了，這種要收合。"), null);
  assert.equal(reader.ledgerLogKind(Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 點：這一段是人寫的說明，不是程式碼。`).join("\n")), null);
  assert.equal(reader.ledgerLogKind("{ 這不是 JSON }"), null);
  // A long markdown answer -- heading, bullets, numbered points -- is a person's (or an agent's) writing.
  const markdown = ["## 檢查結果", ...Array.from({ length: 10 }, (_, i) => `- 第 ${i + 1} 項：已核對`), ...Array.from({ length: 4 }, (_, i) => `${i + 1}. 待辦：補測試`)].join("\n");
  assert.equal(reader.ledgerLogKind(markdown), null);
  assert.equal(reader.ledgerLogKind("42"), null);
  assert.equal(reader.ledgerLogKind(""), null);
  assert.equal(reader.ledgerLogKind(undefined), null);

  // Wiring: renderMessage folds through the classifier into a closed <details>, with the text kept.
  const render = /^function renderMessage\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(render, /ledgerLogKind\(message\.text\)/u);
  assert.match(render, /createElement\("details"\)/u);
  assert.match(render, /fold\.className = "msg-log"/u);
  assert.doesNotMatch(render, /fold\.open = true/u);
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /^\.msg\.is-log \{ opacity: 0\.72; \}$/mu);
});

test("an author name in the ledger is a button that tags that seat in the composer", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const render = /^function renderMessage\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(render, /tagButton\.className = "msg-author"/u);
  assert.match(render, /tagButton\.type = "button"/u);
  // Only seats get a control; the owner and the system line are not someone to tag.
  assert.match(render, /author !== "you" && author !== "system"/u);
  assert.match(render, /insertMentionIntoComposer\(author\)/u);

  const insert = /^function insertMentionIntoComposer\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(insert, "");
  // A tiny textarea double: value, selection, focus, and the input event the composer hints listen to.
  const makeInput = (value: string, start = value.length, end = start) => {
    const input = {
      value, selectionStart: start, selectionEnd: end, focused: false, events: 0,
      setSelectionRange(s: number, e: number) { input.selectionStart = s; input.selectionEnd = e; },
      dispatchEvent() { input.events += 1; return true; },
      focus() { input.focused = true; },
    };
    return input;
  };
  const run = (input: ReturnType<typeof makeInput>, name: string): boolean => runInNewContext(
    `${insert}\ninsertMentionIntoComposer(${JSON.stringify(name)});`,
    { visibleComposer: () => input, Event: class { type: string; constructor(type: string) { this.type = type; } } },
    { timeout: 2_000 },
  ) as boolean;

  // Into an empty box: the tag, a space, focus, caret after it.
  const empty = makeInput("");
  assert.equal(run(empty, "claude（CCUI）"), true);
  assert.equal(empty.value, "@claude（CCUI） ");
  assert.equal(empty.selectionStart, empty.value.length);
  assert.ok(empty.focused && empty.events === 1);
  // At the caret, not at the end, with a separating space when the text before it needs one.
  const middle = makeInput("請 幫我看 P0-3", 2, 2);
  run(middle, "codex1");
  assert.equal(middle.value, "請 @codex1 幫我看 P0-3");
  const glued = makeInput("請幫我看", 1, 1);
  run(glued, "codex1");
  assert.equal(glued.value, "請 @codex1 幫我看");
  // Never twice -- the click only returns focus. A longer name that merely starts the same is not a hit.
  const tagged = makeInput("@codex1 幫我看 P0-3");
  assert.equal(run(tagged, "codex1"), false);
  assert.equal(tagged.value, "@codex1 幫我看 P0-3");
  assert.ok(tagged.focused && tagged.events === 0);
  const longer = makeInput("@codex12 幫我看");
  assert.equal(run(longer, "codex1"), true);
  assert.equal(longer.value, "@codex12 幫我看 @codex1 ");

  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /^\.msg-author \{ appearance: none; background: none; border: 0;/mu);
  assert.match(css, /^\.msg-author:focus-visible \{/mu);
});

test("Enter twice sends; the Enter that commits an IME composition ends the composition and nothing more", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("const DOUBLE_ENTER_WINDOW_MS");
  const end = source.indexOf("async function submitRoomText(");
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);

  type Listener = (event: Record<string, unknown>) => void;
  const build = () => {
    let now = 0;
    const listeners: Record<string, Listener[]> = {};
    const input = {
      value: "", selectionStart: 0, selectionEnd: 0,
      addEventListener(type: string, fn: Listener) { (listeners[type] ??= []).push(fn); },
    };
    const form = { submits: 0, requestSubmit() { form.submits += 1; } };
    runInNewContext(
      `${block}\ninstallMacComposerKeyboard(input, form, { disabled: false });`,
      { input, form, WeakMap, WeakSet, performance: { now: () => now } },
      { timeout: 2_000 },
    );
    const fire = (type: string, init: Record<string, unknown>) => {
      const event = { isComposing: false, keyCode: 0, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, repeat: false, prevented: false, preventDefault() { event.prevented = true; }, ...init };
      for (const fn of listeners[type] ?? []) fn(event);
      return event;
    };
    const setText = (value: string) => { input.value = value; input.selectionStart = input.selectionEnd = value.length; };
    // A plain Enter the page did not prevent: the browser inserts a newline before keyup.
    const enter = (init: Record<string, unknown> = {}) => {
      now += 50;
      const down = fire("keydown", { key: "Enter", keyCode: 13, ...init });
      if (!down.prevented && !init.metaKey) setText(`${input.value}\n`);
      now += 40;
      fire("keyup", { key: "Enter", keyCode: 13, ...init, isComposing: false });
    };
    const typePlain = (text: string) => {
      for (const ch of text) { fire("keydown", { key: ch, keyCode: 65 }); setText(input.value + ch); fire("keyup", { key: ch, keyCode: 65 }); }
    };
    // Chrome on macOS while a composition is open: every keydown carries keyCode 229 and isComposing.
    const composeKeys = (keys: string, shown: string) => {
      for (const key of keys) { fire("keydown", { key, keyCode: 229, isComposing: true }); setText(shown); fire("keyup", { key, keyCode: 229, isComposing: true }); }
    };
    return { input, form, fire, setText, enter, typePlain, composeKeys, tick: (ms: number) => { now += ms; } };
  };

  // Plain text: Enter, Enter.
  {
    const t = build();
    t.typePlain("hi");
    t.enter();
    assert.equal(t.form.submits, 0);
    t.enter();
    assert.equal(t.form.submits, 1);
  }
  // 注音, candidate taken with Enter. That Enter belongs to the input method: it ends the
  // composition and resets the pair, so sending still takes two plain Enters after it -- one
  // more would send on a single press, which the box never does. Three shapes of the same commit:
  // Chrome (keydown 229 + isComposing, compositionend, keyup Enter 13), Safari (compositionend
  // first, keydown 229 with isComposing false), Chrome on Windows (every composing key is "Process").
  const commitShapes = [
    { key: "Enter", isComposing: true },
    { key: "Enter", isComposing: false },
    { key: "Process", isComposing: true },
  ];
  for (const shape of commitShapes) {
    const t = build();
    t.composeKeys("su3", "ㄋㄧˇ");
    t.fire("keydown", { keyCode: 229, ...shape });
    t.setText("你");
    t.fire("keyup", { key: "Enter", keyCode: 13, isComposing: false });
    assert.equal(t.form.submits, 0);
    assert.equal(t.input.value, "你", "the commit Enter must not add a newline of its own");
    t.enter();
    assert.equal(t.form.submits, 0, `commit Enter + Enter must NOT send (${JSON.stringify(shape)})`);
    t.enter();
    assert.equal(t.form.submits, 1, `commit Enter + Enter + Enter sends (${JSON.stringify(shape)})`);
  }
  // Candidate taken with Space instead: two plain Enters after it send. This took THREE before,
  // because the composing keydowns left a flag that ate the first Enter's keyup.
  {
    const t = build();
    t.composeKeys("su3", "ㄋㄧˇ");
    t.fire("keydown", { key: " ", keyCode: 229, isComposing: true });
    t.setText("你");
    t.fire("keyup", { key: " ", keyCode: 32, isComposing: false });
    t.enter();
    assert.equal(t.form.submits, 0);
    t.enter();
    assert.equal(t.form.submits, 1);
  }
  // A plain Enter armed, then a composition opened and committed with Enter: the pair is reset,
  // so the commit Enter cannot complete a pair started before the composition.
  {
    const t = build();
    t.typePlain("a");
    t.enter();
    t.composeKeys("su3", "ㄋㄧˇ");
    t.fire("keydown", { key: "Enter", keyCode: 229, isComposing: true });
    t.setText("a\n你");
    t.fire("keyup", { key: "Enter", keyCode: 13, isComposing: false });
    t.enter();
    assert.equal(t.form.submits, 0);
    t.enter();
    assert.equal(t.form.submits, 1);
  }
  // Edited between the two presses, or too slow: no send.
  {
    const t = build();
    t.typePlain("a");
    t.enter();
    t.typePlain("b");
    t.enter();
    assert.equal(t.form.submits, 0);
    t.tick(2_000);
    t.enter();
    assert.equal(t.form.submits, 0);
  }
  // ⌘Enter sends at once; ⇧Enter and ⌥Enter only break the line.
  {
    const t = build();
    t.typePlain("a");
    t.enter({ metaKey: true });
    assert.equal(t.form.submits, 1);
    t.fire("keyup", { key: "Meta" });
    t.enter({ shiftKey: true });
    t.enter({ altKey: true });
    assert.equal(t.form.submits, 1);
    assert.equal(t.input.value, "a\n\n");
  }
});

test("a replied delivery receipt points at the reply instead of counting attempts", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const receipt = /^function renderDeliveryReceipt\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(receipt, "");
  assert.match(receipt, /delivery\.state === "replied" && Number\.isInteger\(delivery\.replyLedgerSeq\)/u);
  // Through the ref renderer, so "#12" is the same clickable quote link a message body gets.
  assert.match(receipt, /renderTextWithRefs\(text, `\$\{deliveryLabel\} → #\$\{delivery\.replyLedgerSeq\} · \$\{delivery\.targetDisplayName\}`\)/u);
  // Every other state keeps the attempt count: there the ask is still in flight or has stopped.
  assert.match(receipt, /嘗試 \$\{delivery\.attempt\}\/\$\{delivery\.maxAttempts\}/u);
});

test("a desk on the office floor opens its own task-drawer row, not the composer", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const desk = /^function createOfficeDesk\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(desk, "", "room.js keeps createOfficeDesk");
  // Click, Enter/Space and the figure all land in the task drawer; none of them address the composer.
  assert.match(desk, /cube\.addEventListener\("keydown", \(event\) => \{\s*if \(event\.key === "Enter" \|\| event\.key === " "\) \{\s*event\.preventDefault\(\);\s*focusOfficeTaskRow\(agent\);/u);
  assert.match(desk, /if \(!cube\.dataset\.dragMoved\) focusOfficeTaskRow\(agent\);/u);
  assert.match(desk, /desk\.addEventListener\("click", \(\) => focusOfficeTaskRow\(agent\)\);/u);
  assert.doesNotMatch(desk, /focusAgentComposer/u);
  const focus = /^function focusOfficeTaskRow\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(focus, "", "room.js keeps focusOfficeTaskRow");
  // The owner's desk does nothing; a resident gets the card; everyone else gets their expanded row.
  assert.match(focus, /if \(!agent \|\| agent === "you"\) return "";/u);
  assert.match(focus, /ROOM_RESIDENT_PROVIDER_IDS\.includes\(agent\)/u);
  assert.match(focus, /officeTaskExpanded\.add\(key\)/u);
  assert.match(focus, /openOfficeDrawer\("office-task-center"\)/u);
  assert.doesNotMatch(focus, /office-drawer-chat|focusAgentComposer/u);
  const spotlight = /^function spotlightOfficeTaskNode\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(spotlight, /node\.classList\.add\("is-focused"\)/u);
  assert.match(spotlight, /setTimeout\(\(\) => node\.classList\.remove\("is-focused"\), 1500\)/u);
  // Rows are found by the keys the row builders use, so the lookup cannot drift from the render.
  const keyFn = /^function officeTaskRowKeyForAgent\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(keyFn, /return `seat:\$\{session\.id\}`;/u);
  assert.match(keyFn, /return `child:\$\{managed\.id\}`;/u);
  // The seat chips still dock the seat above the composer: that path is theirs, not the desk's.
  const chips = /^function renderSeatChips\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(chips, /button\.addEventListener\("click", \(\) => focusAgentComposer\(chip\.agent\)\);/u);
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /^\.office-task-row\.is-focused, \.office-resident-card\.is-focused \{/mu);
});

test("a resident model gets a card above the 終端 group that says it holds no seat and cannot be removed", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const card = /^function renderOfficeResidentCard\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.notEqual(card, "", "room.js keeps renderOfficeResidentCard");
  assert.match(card, /title\.textContent = `常駐模型 · \$\{provider\}`;/u);
  assert.match(card, /note\.textContent = `透過 @\$\{provider\} 喚醒，不占席位、不可移除。`;/u);
  // "@ 帶入" opens the chat drawer first, then inserts through the one shared mention helper.
  assert.match(card, /officeButton\("@ 帶入", \(\) => \{\s*openOfficeDrawer\("office-drawer-chat"\);\s*insertMentionIntoComposer\(provider\);/u);
  // No remove button of any kind on the card.
  assert.doesNotMatch(card, /officeButton\("移|changePresenceMembership|changeManagedAgent|lockRemovalButton/u);
  const render = /^function renderTaskCenter\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(render, /if \(name === "終端" && officeResidentFocus\) list\.append\(renderOfficeResidentCard\(officeResidentFocus\)\);/u);
  // The card is part of what the drawer paints, so it is part of the signature that decides a repaint.
  assert.match(render, /resident: officeResidentFocus,/u);
});

test("one removal lock, greyed at every entrance and re-checked at the click", async () => {
  const source = await readFile(new URL("../public/room.js", import.meta.url), "utf8");
  const start = source.indexOf("/* @pure-start seat-removal-lock");
  const end = source.indexOf("/* @pure-end seat-removal-lock */");
  assert.ok(start > 0 && end > start, "room.js must expose the DOM-free removal lock");
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /(?:\b(?:document|window|navigator|localStorage|state)\s*\.|\b(?:fetch|byId|api|setInterval|setTimeout|require|import)\s*\()/u,
  );
  const lock = runInNewContext(
    `${block}\n({ seatRemovalLock });`,
    Object.create(null) as object,
    { timeout: 2_000 },
  ) as { seatRemovalLock: (subject: unknown, snapshot: unknown) => { locked: boolean; reason: string } };
  // Spread into this realm: a vm object carries the other context's prototype, which strict deepEqual rejects.
  const lockOf = (subject: unknown, snapshot: unknown) => ({ ...lock.seatRemovalLock(subject, snapshot) });
  const leases = [{ state: "active", writer: { displayName: "claude2" } }, { state: "ended", writer: { displayName: "codex1" } }];
  const deliveries = [
    { targetPresenceId: "p-1", state: "delivered", ledgerSeq: 1101, sourceDisplayName: "codex（backend）" },
    { targetPresenceId: "p-1", state: "working", ledgerSeq: 1099, sourceDisplayName: "codex（backend）" },
    { targetPresenceId: "p-2", state: "queued", ledgerSeq: 1102 },
    { targetPresenceId: "p-3", state: "read", ledgerSeq: 1103 },
  ];
  assert.deepEqual(lockOf({ displayName: "claude2", presenceId: "p-9" }, { leases, deliveries }), { locked: true, reason: "正在當 Writer，先交接或結束 Writer 才能移除" });
  // The line furthest along is the one named, as a ref the reader can click, with who asked.
  assert.deepEqual(lockOf({ displayName: "grok1", presenceId: "p-1" }, { leases, deliveries }), { locked: true, reason: "有交辦執行中（#1099，來自 codex（backend）），先請求取消或等它回覆", ledgerSeq: 1099 });
  assert.deepEqual(lockOf({ displayName: "grok2", presenceId: "p-3" }, { leases, deliveries }), { locked: true, reason: "有交辦執行中（#1103），先請求取消或等它回覆", ledgerSeq: 1103 });
  // An ended lease, a delivery still only queued, or a seat nobody is addressing: removable.
  assert.deepEqual(lockOf({ displayName: "codex1", presenceId: "p-2" }, { leases, deliveries }), { locked: false, reason: "" });
  assert.deepEqual(lockOf({ displayName: "reviewer" }, { leases: [], deliveries }), { locked: false, reason: "" });
  assert.deepEqual(lockOf(undefined, undefined), { locked: false, reason: "" });
  // The server's refusal codes have plain words, and the delivery one names the line the server sent back.
  for (const code of ["PRESENCE_REMOVE_WRITER_ACTIVE", "PRESENCE_REMOVE_DELIVERY_ACTIVE", "MANAGED_AGENT_REMOVE_WRITER_ACTIVE", "MANAGED_AGENT_REMOVE_DELIVERY_ACTIVE"]) {
    assert.match(source, new RegExp(`^  ${code}: "[^"]+",$`, "mu"), `${code} has a human message`);
  }
  const human = /^function humanError\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(human, /code\.endsWith\("_REMOVE_DELIVERY_ACTIVE"\) && Number\.isInteger\(error\?\.details\?\.ledgerSeq\)/u);
  assert.match(human, /removalDeliveryReason\(error\.details\.ledgerSeq, error\.details\.sourceDisplayName\)/u);
  const apiFn = /^async function api\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(apiFn, /error\.details = value;/u);
  const shown = /^function showRoomError\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(shown, /renderTextWithRefs\(text, /u);
  // Every entrance gets the button from one builder, which greys it in place: no text matching anywhere.
  const panel = /^function seatActionButtons\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(panel, /membership\.dataset\.action = session\.joined \? "remove" : "join";/u);
  assert.match(panel, /const note = session\.joined \? applyRemovalLock\(membership, presenceRemovalLock\(session\)\) : null;/u);
  const managed = /^function managedAgentActions\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(managed, /button\.dataset\.action = agent\.busy \? "cancel-child" : "remove-child";/u);
  assert.match(managed, /const note = agent\.busy \? null : applyRemovalLock\(button, managedAgentRemovalLock\(agent\)\);/u);
  const grey = /^function applyRemovalLock\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(grey, /button\.disabled = Boolean\(lock\.locked\);/u);
  assert.match(grey, /note\.className = "seat-removal-lock";/u);
  assert.doesNotMatch(source, /lockRemovalButton|textContent === "移出房間"|textContent === "移除子 Agent"/u);
  // The side panel, the task drawer and the running list all draw the managed control through the builder.
  assert.match(source, /row\.append\(identity, \.\.\.managedAgentActions\(agent\)\);/u);
  const children = /^function officeChildRows\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(children, /\.\.\.managedAgentActions\(agent\)\]/u);
  const seats = /^function officeSeatRows\(\) \{[\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(seats, /actions\.push\(\.\.\.seatActionButtons\(session, listening\)\.children\);/u);
  assert.doesNotMatch(source, /officeButton\("移除子 Agent"|action\.textContent = agent\.busy/u);
  // The click checks the lock again and does not send.
  const leave = /^async function changePresenceMembership\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(leave, /if \(!joining\) \{\s*const lock = presenceRemovalLock\(session\);\s*if \(lock\.locked\) \{\s*applyRemovalLock\(button, lock\);\s*showRoomError\(lock\.reason, \{ prefix: "移出房間失敗" \}\);\s*return;/u);
  const archive = /^async function changeManagedAgent\([\s\S]*?^\}$/mu.exec(source)?.[0] ?? "";
  assert.match(archive, /if \(!agent\.busy\) \{\s*const lock = managedAgentRemovalLock\(agent\);\s*if \(lock\.locked\) \{\s*applyRemovalLock\(button, lock\);\s*showRoomError\(lock\.reason, \{ prefix: "移除子 Agent 失敗" \}\);\s*return;/u);
});

/*
 * The removal routes refuse, before anything is aborted or written, a seat that is the active
 * Writer or holds a delivery it has taken on -- the server's own state, not the GUI's snapshot. The
 * body names what is holding the seat so the owner can release it and try again.
 */
test("the leave and archive routes refuse a seat that is Writer or mid-delivery, and allow it once released", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-web-remove-data-"));
  const workspace = await realpath(await repository());
  await writeFile(
    join(data, "workspace-roots.json"),
    `${JSON.stringify([{ id: "remove-root", label: "Remove root", path: workspace }])}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const app = await createAppContext(data);
  t.after(() => app.close());
  const ledger = new RoomLedger(app.store.dataDirectory);
  t.after(() => ledger.close());
  ledger.createRoom("remove-room", workspace);
  const presenceStore = new RoomPresenceStore(app.store.dataDirectory);
  t.after(() => presenceStore.close());
  const inbox = new RoomInboxStore(app.store.dataDirectory);
  t.after(() => inbox.close());
  const seat = presenceStore.register({ provider: "codex", workspace, hostPid: 98781, client: "Codex CLI" });
  presenceStore.requestJoin(seat.id, "remove-room", workspace);
  const joined = presenceStore.join(seat.id, "remove-room", workspace, { collaborationMode: "room-first", syncTurns: true, label: "frontend" });
  const seatName = joined.displayName ?? "";

  const server = await startWebServer(app, 0);
  t.after(async () => await server.close());
  const index = await fetch(server.url);
  const cookie = (index.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const bootstrap = await fetch(`${server.url}/api/bootstrap`, { headers: { Cookie: cookie } });
  const { csrf } = (await bootstrap.json()) as { csrf: string };
  const headers = { Cookie: cookie, Origin: server.url, "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${server.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  // A delivery the seat has taken on, created after any GUI snapshot could have seen it.
  const mention = ledger.append("remove-room", "you", `@${seatName} 請看登入`);
  inbox.enqueue({ message: mention, targetPresenceId: seat.id, targetDisplayName: seatName });
  const claimed = await inbox.wait({ presenceId: seat.id, roomId: "remove-room", timeoutMs: 100, ledger });
  assert.ok(claimed);
  inbox.ack({ presenceId: seat.id, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "read" });
  inbox.ack({ presenceId: seat.id, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "working" });
  const refusedLeave = await post("/api/rooms/presence/leave", { room: "remove-room", presenceId: seat.id });
  assert.equal(refusedLeave.status, 400);
  assert.deepEqual(await refusedLeave.json(), {
    error: "PRESENCE_REMOVE_DELIVERY_ACTIVE", ledgerSeq: mention.seq, deliveryId: claimed.id, deliveryState: "working",
  });
  assert.equal(presenceStore.get(seat.id)?.roomId, "remove-room", "the refusal leaves the seat in the room");
  assert.equal(inbox.get(claimed.id)?.state, "working", "and the delivery untouched");
  inbox.fail({ presenceId: seat.id, deliveryId: claimed.id, leaseToken: claimed.leaseToken, reason: "交給別人" });
  const leave = await post("/api/rooms/presence/leave", { room: "remove-room", presenceId: seat.id });
  assert.equal(leave.status, 200, JSON.stringify(await leave.clone().json()));

  // A managed agent that holds the Writer lease cannot be archived until the lease ends.
  const created = await post("/api/rooms/managed-agents", { room: "remove-room", provider: "claude", label: "審查" });
  const createdBody = (await created.json()) as { agent?: { id: string }; error?: string };
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  const agentId = createdBody.agent?.id ?? "";
  // A managed agent is handed the lease by a switch, never by a first grant (WRITER_CANDIDATE_WRITE_NOT_ALLOWED).
  const grant = await post("/api/rooms/writers/grant", {
    room: "remove-room", taskId: "remove-task", candidate: { origin: "resident", provider: "claude" },
  });
  assert.equal(grant.status, 201, JSON.stringify(await grant.clone().json()));
  const handoff = await post("/api/rooms/writers/switch", {
    room: "remove-room", taskId: "remove-task", expectedEpoch: 1, checkpoint: "初稿完成",
    candidate: { origin: "managed", actorId: agentId },
  });
  assert.equal(handoff.status, 200, JSON.stringify(await handoff.clone().json()));
  const refusedArchive = await post("/api/rooms/managed-agents/archive", { room: "remove-room", agentId });
  assert.equal(refusedArchive.status, 400);
  assert.deepEqual(await refusedArchive.json(), { error: "MANAGED_AGENT_REMOVE_WRITER_ACTIVE", taskId: "remove-task" });
  const stillWriter = await fetch(`${server.url}/api/rooms/writers?room=remove-room`, { headers: { Cookie: cookie } });
  const stillWriterBody = (await stillWriter.json()) as { leases: Array<{ taskId: string; state: string }> };
  // Epoch 1 was revoked by the hand-off; the epoch the agent holds must still be active.
  assert.ok(stillWriterBody.leases.some((lease) => lease.taskId === "remove-task" && lease.state === "active"), "the refusal leaves the lease active");
  const complete = await post("/api/rooms/writers/complete", { room: "remove-room", taskId: "remove-task", epoch: 2, checkpoint: "完成" });
  assert.equal(complete.status, 200, JSON.stringify(await complete.clone().json()));
  const archive = await post("/api/rooms/managed-agents/archive", { room: "remove-room", agentId });
  assert.equal(archive.status, 200, JSON.stringify(await archive.clone().json()));
});
