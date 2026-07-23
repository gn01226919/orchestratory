import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAppContext } from "../src/app.ts";
import { startWebServer } from "../src/ui/web.ts";
import { GitBroker } from "../src/core/git-broker.ts";
import { WorktreeBroker } from "../src/core/worktree-broker.ts";
import { RoomPresenceStore } from "../src/core/room-presence.ts";
import { RoomLedger } from "../src/core/room-ledger.ts";
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
    csrf: string;
    testerProfiles: Array<{ id: string }>;
    recoverableCheckpoints: Array<{ runId: string }>;
    workspaceRoots: Array<{ id: string }>;
    providerCallUsage: { calls: number; maxCalls: number; killEpoch: number };
    pendingWorkflowRequests: Array<{ id: string; status: string; task: string }>;
  };
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
      wakeMode: string;
      wakeable: boolean;
    }>;
  };
  assert.equal(availableBody.sessions[0]?.id, availableSession.id);
  assert.equal(availableBody.sessions[0]?.joined, false);
  assert.equal(availableBody.sessions[0]?.requested, true);
  assert.equal(availableBody.sessions[0]?.kind, "external-pull");
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
    };
  };
  assert.equal(joinedPresenceBody.session.displayName, "codex（前端 2）");
  assert.equal(joinedPresenceBody.session.collaborationMode, "room-first");
  assert.equal(joinedPresenceBody.session.syncTurns, true);
  assert.equal(joinedPresenceBody.session.standbyRequested, false);
  assert.equal(joinedPresenceBody.session.standbyApproved, false);
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
      displayName: string;
      wakeMode: string;
      wakeable: boolean;
      busy: boolean;
    };
  };
  assert.equal(managedCreateBody.agent.kind, "managed-subagent");
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
  const joinedExternalCannotWrite = await fetch(`${server.url}/api/rooms/writers/grant`, {
    method: "POST", headers: csrfHeaders,
    body: JSON.stringify({
      room: "presence-demo", taskId: "external-codex-disabled",
      candidate: { origin: "external", actorId: availableSession.id },
    }),
  });
  assert.equal(joinedExternalCannotWrite.status, 400);
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
    error?: string;
  };
  assert.equal(completeWriter.status, 200, JSON.stringify(completeWriterBody));
  assert.equal(completeWriterBody.preview?.files, 0);
  assert.equal(completeWriterBody.preview?.risk.level, "low");
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
        confirmation: "APPLY WRITER web-task TO PROJECT",
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
  assert.match(roomHtml, /「全程帳本協作」或「僅加入房間」/u);
  assert.match(roomHtml, /獨立決定是否同步此終端可見對話/u);
  assert.match(roomHtml, /原生旁路無法攔截/u);
  assert.match(roomHtml, /關閉終端會自動移除 session 與待命授權/u);
  assert.match(roomHtml, /不建立替身 Agent/u);
  assert.match(roomHtml, /id="writer-run-cancel"/u);
  assert.match(roomHtml, /共用目前 task worktree 並由系統序列執行/u);
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
  assert.match(roomScript, /const BASE_OFFICE_AGENTS = Object\.freeze\(\["you", "codex", "claude", "grok"\]\)/u);
  assert.match(roomScript, /function syncOfficeDesks\(/u);
  assert.match(roomScript, /value\.session/u);
  assert.match(roomScript, /filter\(\(entry\) => entry\.id !== value\.session\.id\)/u);
  assert.match(roomScript, /核准加入房間/u);
  assert.match(roomScript, /核准 room-wait 待命/u);
  assert.match(roomScript, /撤銷 room-wait 待命/u);
  assert.match(roomScript, /全程帳本協作/u);
  assert.match(roomScript, /終端對話同步/u);
  assert.match(roomScript, /room-wait 待命中，可由 GUI 喚醒/u);
  assert.match(roomScript, /已申請 room-wait，等待 Owner 核准/u);
  assert.match(roomScript, /待命已核准，但終端目前未掛起 room_wait/u);
  assert.match(roomScript, /已加入，尚未申請 room-wait/u);
  assert.match(roomScript, /已排隊（待命已核准，等待終端重新掛起 room_wait）/u);
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
  };
  assert.equal(preparedApplyBody.preview.files, 1);
  assert.equal(preparedApplyBody.preview.changes[0]?.path, "README.md");
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
      confirmation: "APPLY BACK TO SOURCE",
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
