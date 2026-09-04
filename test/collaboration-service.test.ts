import test from "node:test";
import assert from "node:assert/strict";
import { safeSummary } from "../src/security/redact.ts";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { CollaborationService, classifyStoreFailure, describeStoreFailure } from "../src/core/collaboration-service.ts";

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
const ROOM_FIRST_JOIN = { collaborationMode: "room-first" as const, syncTurns: true };
/** One fresh durable idempotency key per logical candidate call. */
const key = (): string => randomUUID();

async function repository(prefix = "orchestratory-collaboration-source-"): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "synthetic\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: source });
  return source;
}

test("GUI, TUI and MCP service instances share one exact-seat ledger sequence", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-"));
  const gui = collaborationService(data);
  const mcp = collaborationService(data);
  t.after(() => gui.close());
  t.after(() => mcp.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  gui.ledger.createRoom("demo", "/tmp/project");
  const external = mcp.registerExternal({
    provider: "codex",
    workspace: "/tmp/project",
    hostPid: 7001,
    model: "gpt-test",
  });
  mcp.requestExternalJoin(external.id, "demo", "/tmp/project");
  const joined = gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: external.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: "frontend",
  });
  assert.equal(joined.displayName, "codex（frontend）");
  const offDutyView = gui.roomView("demo", "/tmp/project").sessions[0];
  assert.equal(offDutyView?.kind, "external-pull");
  assert.equal(offDutyView?.wakeMode, "active-tool-pull");
  assert.equal(offDutyView?.wakeable, false);
  assert.equal(offDutyView?.standbyRequested, false);
  assert.equal(offDutyView?.standbyApproved, false);

  assert.throws(() => gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "尚未核准待命",
  }), /TARGET_AGENT_STANDBY_NOT_APPROVED/u);

  const standby = mcp.requestExternalStandby(external.id, "demo", "/tmp/project");
  assert.equal(standby.standbyRequested, true);
  assert.equal(gui.roomView("demo", "/tmp/project").sessions[0]?.wakeable, false);
  gui.approveExternalStandby(external.id, "demo", "/tmp/project");
  assert.equal(gui.roomView("demo", "/tmp/project").sessions[0]?.standbyApproved, true);

  const pendingWait = mcp.waitExternal({ presenceId: external.id, roomId: "demo", timeoutMs: 1_000 });
  for (let attempt = 0; attempt < 20 && !gui.roomView("demo", "/tmp/project").sessions[0]?.wakeable; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const posted = gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "請修正登入",
  });
  assert.deepEqual(posted.dispatch, {
    wakeMode: "active-tool-pull",
    wakeable: true,
    immediate: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const claimed = await pendingWait;
  assert.ok(claimed);
  assert.equal(claimed.message.seq, posted.message.seq);
  mcp.ackExternal({ presenceId: external.id, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "read" });
  mcp.ackExternal({ presenceId: external.id, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "working" });
  const reply = await mcp.replyExternal({
    presenceId: external.id,
    deliveryId: claimed.id,
    leaseToken: claimed.leaseToken,
    text: "登入已修正",
  });

  assert.equal(reply.reply.author, "codex（frontend）");
  assert.equal(mcp.externalActor(external.id, "demo"), "codex（frontend）");
  assert.equal(mcp.heartbeatExternal(external.id).id, external.id);
  assert.equal(gui.ledger.getRange("demo", reply.reply.seq, reply.reply.seq)[0]?.text, "登入已修正");
  assert.equal(gui.roomView("demo", "/tmp/project").deliveries[0]?.state, "replied");
  assert.equal(gui.ledger.verifyChain("demo"), true);
  const nextWait = mcp.waitExternal({ presenceId: external.id, roomId: "demo", timeoutMs: 1_000 });
  for (let attempt = 0; attempt < 20 && !gui.roomView("demo", "/tmp/project").sessions[0]?.wakeable; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const failing = gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "請執行失敗案例",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const failingClaim = await nextWait;
  assert.ok(failingClaim);
  assert.equal(mcp.failExternal({
    presenceId: external.id, deliveryId: failing.delivery.id,
    leaseToken: failingClaim.leaseToken, reason: "synthetic failure",
  }).state, "failed");
  gui.revokeExternalStandby(external.id, "demo", "/tmp/project");
  assert.equal(gui.roomView("demo", "/tmp/project").sessions[0]?.standbyApproved, false);
  mcp.unregisterExternal(external.id, "test finished");
  assert.equal(gui.reconcileExternalPresence("demo", "/tmp/project").length, 0);
});

/*
 * The ledger has to tell "it read the task and did nothing" apart from "it never got the task".
 *
 * Those look identical afterwards -- no reply either way -- and they call for opposite responses:
 * chase the agent, or go wake the terminal. The fact was already known at dispatch and already
 * returned as `wakeable: false`, but only to the caller, in a JSON field, at a moment nobody is
 * reading. The ledger is where the question actually gets asked later.
 */
test("work queued for a seat that is not listening is recorded in the ledger", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-silent-seat-"));
  const gui = collaborationService(data);
  t.after(() => gui.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  gui.ledger.createRoom("demo", "/tmp/project");
  const external = gui.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7101, model: "gpt-test" });
  gui.requestExternalJoin(external.id, "demo", "/tmp/project");
  gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: external.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: "frontend",
  });
  gui.requestExternalStandby(external.id, "demo", "/tmp/project");
  gui.approveExternalStandby(external.id, "demo", "/tmp/project");

  // Approved for standby, present in the room, and not inside a room_wait: the state that used to be
  // indistinguishable from being on duty.
  const sent = gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "請看一下這個",
  });
  assert.equal(sent.dispatch.wakeable, false);
  assert.equal(sent.dispatch.immediate, false);

  const lines = gui.ledger.listAfter("demo", 0).map((message) => String(message.text));
  const note = lines.find((line: string) => line.includes(`#${sent.message.seq}`) && line.includes("沒有在收聽"));
  assert.ok(note, `the ledger must record that nobody was listening, got:\n${lines.join("\n")}`);
  // Best-effort by design, and worth being explicit about: the write is wrapped so a ledger failure
  // cannot undo a delivery that is already committed. This asserts the ordinary path, which is the
  // one a reader relies on; it is not a guarantee that the line exists under every failure.
  assert.match(String(note), /排隊/u, "and must say the work is waiting, not that it failed");

  // Strictly past tense. "要等它下次待命才會拿到" was in an earlier draft and is a promise about the
  // future that is false in both directions: the seat may open a wait a second later and answer at
  // once, or it may close and have this delivery failed as SEAT_OFFLINE and never get it. Nothing
  // retracts a ledger line, so it may only state what was true when it was written.
  assert.doesNotMatch(String(note), /要等|才會拿到|將會/u, "the ledger must not predict what happens next");

  // The delivery itself is untouched: this is a note about it, not a failure of it.
  assert.equal(sent.delivery.state, "queued");

  /*
   * Idempotent, because room_send promises in its own tool description that a retry with the same
   * clientRequestId cannot duplicate anything -- and both the chat line and the delivery honour that.
   * A non-idempotent note would have broken that promise quietly: three transport retries, one
   * delivery, three identical ledger lines.
   *
   * This has to go through the PEER path with a repeated clientRequestId, which is the only way to
   * produce the same ledger seq twice. An earlier version of this test sent a different message the
   * second time, got a new seq and therefore a new idempotency key, and passed just as happily
   * against a non-idempotent append -- a test that agreed with whatever the code did.
   */
  const peer = gui.registerExternal({ provider: "claude", workspace: "/tmp/project", hostPid: 7102, model: "claude-test" });
  gui.requestExternalJoin(peer.id, "demo", "/tmp/project");
  gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN, presenceId: peer.id, roomId: "demo", workspace: "/tmp/project", label: "peer",
  });
  gui.requestExternalStandby(peer.id, "demo", "/tmp/project");
  gui.approveExternalStandby(peer.id, "demo", "/tmp/project");

  const retryId = randomUUID();
  const first = gui.postBetweenExternals({
    roomId: "demo", workspace: "/tmp/project",
    sourcePresenceId: peer.id, targetPresenceId: external.id,
    text: "同一則，重試兩次", clientRequestId: retryId,
  });
  const retried = gui.postBetweenExternals({
    roomId: "demo", workspace: "/tmp/project",
    sourcePresenceId: peer.id, targetPresenceId: external.id,
    text: "同一則，重試兩次", clientRequestId: retryId,
  });
  assert.equal(retried.message.seq, first.message.seq, "the retry must reuse the same ledger message");
  assert.equal(retried.delivery.id, first.delivery.id, "and the same delivery");

  const afterRetry = gui.ledger.listAfter("demo", 0).map((message) => String(message.text));
  assert.equal(
    afterRetry.filter((line: string) => line.includes(`#${first.message.seq}`) && line.includes("沒有在收聽")).length,
    1,
    "one delivery, one note, however many times the transport retried",
  );
  assert.equal(
    afterRetry.filter((line: string) => line.includes(`#${sent.message.seq}`) && line.includes("沒有在收聽")).length,
    1,
    "and the earlier dispatch still has exactly its own one line",
  );
});

/*
 * The nudge exists because the owner asked for a button that wakes a silent terminal, and the
 * protocol cannot provide one: a seat is reachable only from inside a room_wait it opened itself, so
 * when no such call is open there is nothing to deliver into. A server-initiated notification would
 * not help either -- it cannot make a call that does not exist return -- which is the narrower and
 * true form of "the server cannot reach it".
 * So the button records the intention instead, and what has to be guarded is mostly what it must
 * never do or claim.
 */
test("asking for a seat's attention records the intention and never claims to have woken it", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-wake-"));
  /*
   * A controlled clock, because the thing under test is a time bucket. Three real calls land inside
   * the same millisecond, so a millisecond-keyed implementation -- no bucketing at all -- would
   * dedupe them too and this test would agree with it. Moving the clock between presses is the only
   * way it can tell the two apart.
   */
  let clock = Date.parse("2026-09-02T14:12:00.000Z");
  const gui = new CollaborationService(data, { presence: { leaseMs: 120_000, now: () => clock } });
  /* The clock advances 12s, 25s, 60s and 90s to cross bucket boundaries. No single step exceeds the
     120s presence lease, but they accumulate past it, so the seat is kept alive the way a real one is:
     by heartbeating between steps. Widening the lease was the other option and it is not available --
     the store caps it at 120s on purpose. */
  /* Declared after `external` exists rather than closing over a binding that is still in its temporal
     dead zone. It only worked before because of call ordering, which is a property of this test today
     and not of the code. */
  let tick = (ms: number): void => { clock += ms; };
  t.after(() => gui.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  gui.ledger.createRoom("demo", "/tmp/project");
  const external = gui.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7301, model: "gpt-test" });
  tick = (ms: number): void => { clock += ms; gui.heartbeatExternal(external.id); };
  gui.requestExternalJoin(external.id, "demo", "/tmp/project");
  gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN, presenceId: external.id, roomId: "demo", workspace: "/tmp/project", label: "frontend",
  });

  // Refused before standby is approved. A nudge cannot help a seat that is not allowed to receive
  // work at all, and offering it there would put a plausible action next to a problem it does not
  // touch -- which is how someone clicks instead of doing the thing that works.
  assert.throws(
    () => gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id }),
    /TARGET_AGENT_STANDBY_NOT_APPROVED/u,
  );

  gui.requestExternalStandby(external.id, "demo", "/tmp/project");
  gui.approveExternalStandby(external.id, "demo", "/tmp/project");

  const recorded = gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  assert.equal(recorded.listening, false);
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.fresh, true, "the first press in a minute writes the line");
  assert.ok(recorded.recordedAt, "and reports when that line is dated");

  const lines = gui.ledger.listAfter("demo", 0).map((message) => String(message.text));
  const line = lines.find((entry: string) => entry.includes("Owner 想找"));
  assert.ok(line, `the intention must reach the ledger, got:\n${lines.join("\n")}`);
  assert.match(String(line), /沒有辦法叫醒/u, "and must say plainly that nothing was woken");
  assert.doesNotMatch(String(line), /已喚醒|已叫醒|已通知/u);

  // Held down, or clicked again out of frustration -- and it will be, because it does not visibly do
  // anything -- leaves one line for the minute rather than a column of them.
  tick(12_000);
  gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  tick(25_000);
  gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  assert.equal(
    gui.ledger.listAfter("demo", 0).filter((message) => String(message.text).includes("Owner 想找")).length,
    1,
    "three presses spread across one minute leave one line",
  );

  /*
   * A deduped press must say so. Reporting it exactly like the first press would put a timestamp on
   * screen that belongs to the earlier click -- "已記一筆（含時間）" naming a minute the owner did not
   * just act in.
   */
  const deduped = gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  assert.equal(deduped.recorded, true, "an ask for this seat in this minute is on the record");
  assert.equal(deduped.fresh, false, "but this press did not write it");
  assert.equal(deduped.recordedAt, recorded.recordedAt, "and the time reported is the line's, not now");

  // A later minute is a new ask, not a repeat of the old one, and gets its own line.
  tick(60_000);
  gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  assert.equal(
    gui.ledger.listAfter("demo", 0).filter((message) => String(message.text).includes("Owner 想找")).length,
    2,
    "asking again a minute later is a new ask",
  );

  /*
   * A seat that is listening records nothing. The click can race a seat coming back on duty, and the
   * ledger is permanent: "它當時沒有在收聽" written about a moment when it WAS would be a false line
   * that nothing retracts. This branch existed with no test walking it.
   */
  const onDuty = new AbortController();
  const duty = gui.inbox.wait({
    presenceId: external.id, roomId: "demo", ledger: gui.ledger, signal: onDuty.signal,
  }).then(() => "returned", (error: Error) => error.message);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gui.inbox.isListening(external.id, "demo"), true, "the seat must actually be on duty for this to test anything");

  const linesBefore = gui.ledger.listAfter("demo", 0).length;
  tick(90_000);
  const whileListening = gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  assert.equal(whileListening.listening, true);
  assert.equal(whileListening.recorded, false, "nothing to record about a seat that is right here");
  assert.equal(
    gui.ledger.listAfter("demo", 0).length,
    linesBefore,
    "and a fresh minute bucket must not be enough to write one anyway",
  );
  onDuty.abort();
  assert.match(String(await duty), /ROOM_WAIT_CANCELLED/u);

  /*
   * The renamed-inside-the-same-minute path, which had handling written for it and no test.
   *
   * The idempotency key is room + seat + minute, but the stored payload hash also covers the seat's
   * display name. Leaving and rejoining under a different label keeps the presence id, so pressing
   * again in the same minute is a same-key different-text write and the ledger refuses it -- correctly,
   * an ask for this seat in this minute is already on the record. The catch for that swallowed the
   * refusal but did not read the earlier line back, so `recordedAt` came out undefined on the one path
   * where naming the recorded time matters most, and the receipt showed an em dash.
   */
  const beforeRename = gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  assert.equal(beforeRename.fresh, true, "a fresh minute records a line under the current name");

  /* Renamed without moving the clock, so the next press falls in the SAME minute -- same key, and a
     payload hash that now covers a different display name. */
  gui.removeExternal({ presenceId: external.id, roomId: "demo", workspace: "/tmp/project" });
  gui.requestExternalJoin(external.id, "demo", "/tmp/project");
  gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN, presenceId: external.id, roomId: "demo", workspace: "/tmp/project", label: "改名後",
  });
  gui.requestExternalStandby(external.id, "demo", "/tmp/project");
  gui.approveExternalStandby(external.id, "demo", "/tmp/project");

  const afterRename = gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id });
  assert.equal(afterRename.recorded, true, "an ask for this seat in this minute is still on the record");
  assert.equal(afterRename.fresh, false, "but this press did not write a new line");
  assert.equal(afterRename.recordedAt, beforeRename.recordedAt,
    "and the time reported is the earlier line's, recovered rather than left undefined");

  // Offline seats are refused outright rather than recorded against.
  gui.removeExternal({ presenceId: external.id, roomId: "demo", workspace: "/tmp/project" });
  assert.throws(
    () => gui.requestExternalWake({ roomId: "demo", workspace: "/tmp/project", presenceId: external.id }),
    /TARGET_AGENT_OFFLINE/u,
  );
});

/*
 * The owner's complaint was that the list grows: work queued for a seat that is rarely on duty had no
 * time bound at all, and they would often just do the thing themselves in the meantime.
 *
 * The second half of the original spec -- "and the target seat is gone" -- is deliberately not a
 * condition. That case never reaches twelve hours: roomView reconciles any queued delivery whose
 * presence has vanished into failed/SEAT_OFFLINE on the very next poll. Requiring both would have
 * produced a rule that essentially never fires, against the accumulation it was asked to stop.
 */
test("work still in the queue ages out on view, is recorded, and is kept rather than deleted", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-expiry-"));
  let clock = Date.parse("2026-09-03T09:00:00.000Z");
  /* One clock for both stores. Expiry reads the inbox's; presence reads its own. Moving only one
     would let twelve simulated hours pass in one store while the other stayed in the same minute. */
  const gui = new CollaborationService(data, {
    presence: { leaseMs: 120_000, now: () => clock },
    inbox: { now: () => clock },
  });
  t.after(() => gui.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  gui.ledger.createRoom("demo", "/tmp/project");
  const external = gui.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7401, model: "gpt-test" });
  gui.requestExternalJoin(external.id, "demo", "/tmp/project");
  gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN, presenceId: external.id, roomId: "demo", workspace: "/tmp/project", label: "frontend",
  });
  gui.requestExternalStandby(external.id, "demo", "/tmp/project");
  gui.approveExternalStandby(external.id, "demo", "/tmp/project");

  const sent = gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "有空看一下這個",
  });
  assert.equal(sent.delivery.state, "queued");

  // The seat stays present the whole time -- heartbeating like a live terminal -- so the offline
  // reconciliation never touches this delivery. Only age does.
  /* Stepped in sub-lease increments, because a live terminal heartbeats every five seconds and the
     presence lease is 120s: jumping an hour and then heartbeating would find the seat already pruned,
     and the test would be measuring expiry against a seat that had ceased to exist -- which is the
     case this test exists to exclude. */
  const tick = (ms: number): void => {
    for (let moved = 0; moved < ms; moved += 60_000) {
      clock += Math.min(60_000, ms - moved);
      gui.heartbeatExternal(external.id);
    }
  };
  tick(11 * 60 * 60 * 1_000);
  gui.roomView("demo", "/tmp/project");
  assert.equal(gui.inbox.get(sent.delivery.id)?.state, "queued", "eleven hours is not twelve");

  tick(70 * 60 * 1_000);
  const view = gui.roomView("demo", "/tmp/project");
  const aged = view.deliveries.find((delivery) => delivery.id === sent.delivery.id);
  assert.equal(aged?.state, "expired");
  assert.equal(aged?.failReason ?? null, null, "expiry is not a failure and must not read as one");
  assert.equal(aged?.ledgerSeq, sent.delivery.ledgerSeq, "the row keeps what it was");

  const lines = gui.ledger.listAfter("demo", 0).map((message) => String(message.text));
  const note = lines.find((line: string) => line.includes(`#${sent.message.seq}`) && line.includes("已過期"));
  assert.ok(note, `expiry must be visible in the ledger, got:\n${lines.join("\n")}`);
  assert.match(String(note), /紀錄保留/u, "and must say the record was kept, since deleting is what an owner would fear");

  // Viewing again must not add a second line for the same delivery.
  gui.roomView("demo", "/tmp/project");
  assert.equal(
    gui.ledger.listAfter("demo", 0).filter((message) => String(message.text).includes("已過期")).length,
    1,
  );
});

/*
 * Joining used to hand back only a capability declaration -- what this terminal may do -- and nothing
 * about what the room is in the middle of. The agent then had a screenful of history and no way to
 * tell whether any of it was its business, which fails in both directions: picking up someone else's
 * half-finished task, or rebuilding something the room already settled.
 */
test("a joining agent is briefed on the room, in a slice that says how much it is not showing", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-briefing-"));
  const gui = collaborationService(data);
  t.after(() => gui.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  gui.ledger.createRoom("demo", "/tmp/project");
  for (let i = 1; i <= 120; i += 1) gui.ledger.append("demo", "you", `第 ${i} 則`);

  const busy = gui.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7501, model: "gpt-test" });
  gui.requestExternalJoin(busy.id, "demo", "/tmp/project");
  gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN, presenceId: busy.id, roomId: "demo", workspace: "/tmp/project", label: "frontend",
  });
  gui.requestExternalStandby(busy.id, "demo", "/tmp/project");
  gui.approveExternalStandby(busy.id, "demo", "/tmp/project");
  gui.postToExternal({ roomId: "demo", workspace: "/tmp/project", presenceId: busy.id, text: "這件還沒完成" });

  const briefing = gui.roomBriefing({ roomId: "demo", workspace: "/tmp/project" });

  // Bounded, and honest about the bound: a slice presented without its denominator reads as the whole.
  assert.equal(briefing.shown, 50);
  assert.equal(briefing.recent.length, 50);
  assert.ok(briefing.totalMessages > briefing.shown,
    "the briefing must say how much of the room it is not showing");
  /* Ends at the present. Asserted on the sequence number rather than on a remembered string: the last
     line is the system note the dispatch itself produced, not the dispatch, and picking the wrong one
     to look for is how a test ends up agreeing with whatever the code did. */
  assert.equal(briefing.recent[briefing.recent.length - 1]?.seq, briefing.totalMessages,
    "the slice must end at the newest message, not at an arbitrary window");
  assert.ok(briefing.recent.some((message) => String(message.text).includes("這件還沒完成")),
    "and must contain the work that is currently outstanding");

  // The seat and what it is in the middle of. Work already addressed to someone else is the clearest
  // sign of a thread a newcomer should not simply take over.
  const seat = briefing.seats.find((entry) => entry.displayName === "codex（frontend）");
  assert.ok(seat, `the briefing must list joined seats, got ${JSON.stringify(briefing.seats)}`);
  assert.equal(seat?.pending, 1, "including how much work is already waiting on them");
  assert.equal(seat?.listening, false);
  assert.equal(seat?.standbyApproved, true);

  // Nothing is being written, and the briefing says so rather than omitting the field.
  assert.deepEqual(briefing.writing, []);

  // Asking for more than the ceiling is refused rather than quietly served the whole archive.
  assert.throws(
    () => gui.roomBriefing({ roomId: "demo", workspace: "/tmp/project", messages: 5_000 }),
    /INVALID_ROOM_BRIEFING_SIZE/u,
  );
  assert.equal(gui.roomBriefing({ roomId: "demo", workspace: "/tmp/project", messages: 3 }).shown, 3);

  /*
   * The briefing ages the room before counting, the same way roomView does -- otherwise it reports
   * deliveries the GUI has already retired and the two panels disagree. Ageing appends system lines
   * of its own, so every number here has to come from one read taken AFTER that, or the slice ends
   * before a total that counted them.
   */
  gui.removeExternal({ presenceId: busy.id, roomId: "demo", workspace: "/tmp/project" });
  const afterSweep = gui.roomBriefing({ roomId: "demo", workspace: "/tmp/project" });
  assert.equal(
    afterSweep.recent[afterSweep.recent.length - 1]?.seq,
    afterSweep.totalMessages,
    "the slice must still end at the newest message once the sweeps have written their own lines",
  );
  assert.deepEqual(
    afterSweep.seats.map((entry) => entry.displayName),
    [],
    "and a seat removed from the room is no longer briefed as present",
  );
});

/*
 * The briefing tells a joining agent what the room is in the middle of; this is where it says what it
 * intends to do about that. The owner's complaint was an agent that never distinguishes "pick up the
 * thread already running" from "start something beside it" -- one produces a hijacked task, the other
 * a rebuilt wheel.
 */
test("a seat declares which of the two it is doing, and acting without saying so is visible", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-start-"));
  const gui = collaborationService(data);
  t.after(() => gui.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  gui.ledger.createRoom("demo", "/tmp/project");
  const seat = (label: string, pid: number): string => {
    const registered = gui.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: pid, model: "gpt-test" });
    gui.requestExternalJoin(registered.id, "demo", "/tmp/project");
    gui.approveExternalJoin({
      ...ROOM_FIRST_JOIN, presenceId: registered.id, roomId: "demo", workspace: "/tmp/project", label,
    });
    gui.requestExternalStandby(registered.id, "demo", "/tmp/project");
    gui.approveExternalStandby(registered.id, "demo", "/tmp/project");
    return registered.id;
  };
  const declaring = seat("declaring", 7601);
  const silent = seat("silent", 7602);

  assert.equal(gui.hasDeclaredRoomStart("demo", declaring), false, "a fresh seat has not answered yet");

  const started = gui.declareRoomStart({
    roomId: "demo", workspace: "/tmp/project", presenceId: declaring, mode: "new-task", note: "改帳本分頁",
  });
  assert.equal(started.alreadyDeclared, false);
  assert.match(String(started.message.text), /開始新任務/u);
  /*
   * COUNTED, not just matched. The first version wrote a second row under a separate key so lookups
   * would be easy, which put two identical dividers in the ledger on the very first declaration --
   * and every assertion here passed, because they all compared sequence numbers or matched text and
   * none of them asked how many lines existed. For a marker whose whole job is to show a reader where
   * one line of work ended, two of them is worse than none.
   */
  const dividers = () => gui.ledger.listAfter("demo", 0)
    .filter((message) => String(message.text).includes("開始新任務")).length;
  assert.equal(dividers(), 1, "one declaration writes exactly one line");
  assert.match(String(started.message.text), /改帳本分頁/u);
  // A divider, so a later reader can see where one line of work stopped and another began.
  assert.match(String(started.message.text), /──/u);
  assert.equal(gui.hasDeclaredRoomStart("demo", declaring), true);

  // Answering twice is the same answer, not a second line.
  const again = gui.declareRoomStart({
    roomId: "demo", workspace: "/tmp/project", presenceId: declaring, mode: "new-task", note: "改帳本分頁",
  });
  assert.equal(again.alreadyDeclared, true);
  assert.equal(again.message.seq, started.message.seq);
  assert.equal(dividers(), 1, "and repeating it adds none");

  /*
   * And the seat that never answered. The send is NOT refused -- MCP returns text and cannot make an
   * agent read a question, and a gate here would only teach the next one to route around it. What is
   * true instead is that the room shows it happened.
   */
  const sent = gui.postBetweenExternals({
    roomId: "demo", workspace: "/tmp/project",
    sourcePresenceId: silent, targetPresenceId: declaring,
    text: "我直接開始做了", clientRequestId: randomUUID(),
  });
  assert.equal(sent.delivery.state, "queued", "the work goes through; only the record changes");

  const lines = gui.ledger.listAfter("demo", 0).map((message) => String(message.text));
  const flagged = lines.find((line: string) => line.includes("codex（silent）") && line.includes("還沒說明"));
  assert.ok(flagged, `acting before declaring must be visible, got:\n${lines.join("\n")}`);

  // One line per seat per session, so a talkative agent leaves a note rather than a column.
  gui.postBetweenExternals({
    roomId: "demo", workspace: "/tmp/project",
    sourcePresenceId: silent, targetPresenceId: declaring,
    text: "還有這個", clientRequestId: randomUUID(),
  });
  assert.equal(
    gui.ledger.listAfter("demo", 0).filter((message) => String(message.text).includes("還沒說明")).length,
    1,
  );

  // A seat that HAS answered is not flagged.
  gui.postBetweenExternals({
    roomId: "demo", workspace: "/tmp/project",
    sourcePresenceId: declaring, targetPresenceId: silent,
    text: "我先前已經說明過了", clientRequestId: randomUUID(),
  });
  assert.equal(
    gui.ledger.listAfter("demo", 0).filter((message) => String(message.text).includes("codex（declaring）") && String(message.text).includes("還沒說明")).length,
    0,
  );
});

test("exact terminal seats exchange authenticated multi-turn threads without provider fallback", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-peer-thread-"));
  const codexProcess = collaborationService(data);
  const claudeProcess = collaborationService(data);
  t.after(() => codexProcess.close());
  t.after(() => claudeProcess.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  codexProcess.ledger.createRoom("demo", "/tmp/project");
  const codex = codexProcess.registerExternal({
    provider: "codex", workspace: "/tmp/project", hostPid: 7201,
  });
  const claude = claudeProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7202,
  });
  for (const seat of [codex, claude]) {
    codexProcess.requestExternalJoin(seat.id, "demo", "/tmp/project");
    codexProcess.approveExternalJoin({
      ...ROOM_FIRST_JOIN,
      presenceId: seat.id,
      roomId: "demo",
      workspace: "/tmp/project",
      label: seat.provider,
    });
    codexProcess.requestExternalStandby(seat.id, "demo", "/tmp/project");
    codexProcess.approveExternalStandby(seat.id, "demo", "/tmp/project");
  }

  const firstRequestId = randomUUID();
  const firstInput = {
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: codex.id,
    targetPresenceId: claude.id,
    clientRequestId: firstRequestId,
    text: "請檢查登入修正",
    taskId: "login-task",
  };
  const first = codexProcess.postBetweenExternals(firstInput);
  const firstRetry = codexProcess.postBetweenExternals(firstInput);
  assert.equal(firstRetry.delivery.id, first.delivery.id);
  assert.equal(firstRetry.message.seq, first.message.seq);
  const claudeWait = claudeProcess.waitExternal({
    presenceId: claude.id, roomId: "demo", timeoutMs: 1_000,
  });
  assert.equal(first.message.author, "codex（codex）");
  assert.equal(first.delivery.sourcePresenceId, codex.id);
  assert.equal(first.delivery.sourceDisplayName, "codex（codex）");
  assert.equal(first.delivery.targetPresenceId, claude.id);

  const claimedByClaude = await claudeWait;
  assert.ok(claimedByClaude);
  assert.equal(claimedByClaude.sourcePresenceId, codex.id);
  assert.equal(claimedByClaude.threadId, first.delivery.threadId);
  claudeProcess.ackExternal({
    presenceId: claude.id, deliveryId: claimedByClaude.id,
    leaseToken: claimedByClaude.leaseToken, phase: "read",
  });
  claudeProcess.ackExternal({
    presenceId: claude.id, deliveryId: claimedByClaude.id,
    leaseToken: claimedByClaude.leaseToken, phase: "working",
  });
  await claudeProcess.replyExternal({
    presenceId: claude.id,
    deliveryId: claimedByClaude.id,
    leaseToken: claimedByClaude.leaseToken,
    text: "已檢查，請補一個回歸測試",
  });
  const firstOutcome = await codexProcess.waitForExternalReply({
    presenceId: codex.id, deliveryId: first.delivery.id, timeoutMs: 1_000,
  });
  assert.equal(firstOutcome?.delivery.state, "replied");
  assert.equal(firstOutcome?.reply?.author, "claude（claude）");

  const followUp = claudeProcess.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: claude.id,
    targetPresenceId: codex.id,
    clientRequestId: randomUUID(),
    text: "回歸測試補好了嗎？",
    threadId: first.delivery.threadId,
    replyToDeliveryId: first.delivery.id,
    taskId: "login-task",
  });
  const codexWait = codexProcess.waitExternal({
    presenceId: codex.id, roomId: "demo", timeoutMs: 1_000,
  });
  assert.equal(followUp.delivery.threadId, first.delivery.threadId);
  assert.equal(followUp.delivery.replyToDeliveryId, first.delivery.id);
  const claimedByCodex = await codexWait;
  assert.ok(claimedByCodex);
  assert.equal(claimedByCodex.sourcePresenceId, claude.id);
  assert.equal(claimedByCodex.threadId, first.delivery.threadId);
  await assert.rejects(
    claudeProcess.waitForExternalReply({
      presenceId: codex.id, deliveryId: followUp.delivery.id, timeoutMs: 1,
    }),
    /DELIVERY_NOT_FOUND/u,
  );
  codexProcess.ackExternal({
    presenceId: codex.id, deliveryId: claimedByCodex.id,
    leaseToken: claimedByCodex.leaseToken, phase: "read",
  });
  codexProcess.ackExternal({
    presenceId: codex.id, deliveryId: claimedByCodex.id,
    leaseToken: claimedByCodex.leaseToken, phase: "working",
  });
  await codexProcess.replyExternal({
    presenceId: codex.id,
    deliveryId: claimedByCodex.id,
    leaseToken: claimedByCodex.leaseToken,
    text: "已補回歸測試",
  });
  assert.equal((await claudeProcess.waitForExternalReply({
    presenceId: claude.id, deliveryId: followUp.delivery.id, timeoutMs: 1_000,
  }))?.delivery.state, "replied");

  let previous = followUp.delivery;
  for (let turn = 3; turn <= 20; turn += 1) {
    const codexIsSource = turn % 2 === 1;
    const sourceService = codexIsSource ? codexProcess : claudeProcess;
    const targetService = codexIsSource ? claudeProcess : codexProcess;
    const sourceSeat = codexIsSource ? codex : claude;
    const targetSeat = codexIsSource ? claude : codex;
    const sent = sourceService.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sourceSeat.id,
      targetPresenceId: targetSeat.id,
      clientRequestId: randomUUID(),
      text: `無固定上限驗收第 ${turn} 輪`,
      threadId: first.delivery.threadId,
      replyToDeliveryId: previous.id,
      taskId: "login-task",
    });
    const claimed = await targetService.waitExternal({
      presenceId: targetSeat.id, roomId: "demo", timeoutMs: 1_000,
    });
    assert.ok(claimed);
    targetService.ackExternal({
      presenceId: targetSeat.id, deliveryId: claimed.id,
      leaseToken: claimed.leaseToken, phase: "read",
    });
    targetService.ackExternal({
      presenceId: targetSeat.id, deliveryId: claimed.id,
      leaseToken: claimed.leaseToken, phase: "working",
    });
    await targetService.replyExternal({
      presenceId: targetSeat.id,
      deliveryId: claimed.id,
      leaseToken: claimed.leaseToken,
      text: `第 ${turn} 輪已回覆`,
    });
    const outcome = await sourceService.waitForExternalReply({
      presenceId: sourceSeat.id, deliveryId: sent.delivery.id, timeoutMs: 1_000,
    });
    assert.equal(outcome?.delivery.state, "replied");
    assert.equal(sent.delivery.threadId, first.delivery.threadId);
    previous = sent.delivery;
  }
  const grok = codexProcess.registerExternal({
    provider: "grok", workspace: "/tmp/project", hostPid: 7203,
  });
  codexProcess.requestExternalJoin(grok.id, "demo", "/tmp/project");
  codexProcess.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: grok.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: grok.provider,
  });
  codexProcess.requestExternalStandby(grok.id, "demo", "/tmp/project");
  codexProcess.approveExternalStandby(grok.id, "demo", "/tmp/project");
  const messagesBeforeRejectedRoutes = codexProcess.ledger.getRoom("demo")?.messages;
  assert.throws(
    () => codexProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: grok.id,
      targetPresenceId: codex.id,
      clientRequestId: randomUUID(),
      text: "第三席不可插入既有 thread",
      threadId: first.delivery.threadId,
      replyToDeliveryId: previous.id,
      taskId: "login-task",
    }),
    /THREAD_PARTICIPANT_MISMATCH/u,
  );
  assert.throws(
    () => codexProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: codex.id,
      targetPresenceId: claude.id,
      clientRequestId: randomUUID(),
      text: "不可偷換 task",
      threadId: first.delivery.threadId,
      replyToDeliveryId: previous.id,
      taskId: "different-task",
    }),
    /THREAD_TASK_MISMATCH/u,
  );
  assert.throws(
    () => codexProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: codex.id,
      targetPresenceId: claude.id,
      clientRequestId: randomUUID(),
      text: "reply-to 不能省略 thread ID",
      replyToDeliveryId: previous.id,
      taskId: "login-task",
    }),
    /THREAD_CONTINUATION_FIELDS_MISMATCH/u,
  );
  assert.equal(codexProcess.ledger.getRoom("demo")?.messages, messagesBeforeRejectedRoutes);
});

test("exact native seat owns a durable candidate lifecycle while main remains untouched", async (t) => {
  const source = await repository("orchestratory-candidate-service-source-");
  const data = await mkdtemp(join(tmpdir(), "orchestratory-candidate-service-data-"));
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const seat = service.registerExternal({ provider: "codex", workspace: source, hostPid: 7_777 });
  service.requestExternalJoin(seat.id, "demo", source);
  service.approveExternalJoin({
    ...ROOM_FIRST_JOIN, presenceId: seat.id, roomId: "demo", workspace: source, label: "candidate",
  });
  await writeFile(join(source, "owner-draft.txt"), "preserve me\n", "utf8");
  const mainHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();

  const candidate = await service.startCandidate({
    presenceId: seat.id, clientRequestId: key(), roomId: "demo", workspace: source,
    task: "Implement without touching main", acceptanceCriteria: "owner draft survives",
  });
  assert.equal(candidate.baseline.clean, false);
  await writeFile(join(candidate.candidatePath, "implemented.txt"), "candidate only\n", "utf8");
  await execFileAsync("git", ["add", "implemented.txt"], { cwd: candidate.candidatePath });
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "candidate implementation",
  ], { cwd: candidate.candidatePath });
  const checkpoint = await service.checkpointCandidate({
    presenceId: seat.id, clientRequestId: key(), roomId: "demo", workspace: source,
    taskId: candidate.taskId, summary: "committed checkpoint",
  });
  const completed = await service.completeCandidate({
    presenceId: seat.id, clientRequestId: key(), roomId: "demo", workspace: source,
    taskId: candidate.taskId, summary: "ready for owner",
    tests: [{ command: "node --test", status: "passed" }], knownRisks: [],
  });
  assert.equal(checkpoint.candidateHead, completed.completion.preview.candidateHead);
  assert.equal(completed.completion.mergeDecision, "owner-required");
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), mainHead);
  assert.equal(await readFile(join(source, "owner-draft.txt"), "utf8"), "preserve me\n");
  assert.equal((await service.candidateStatus({
    presenceId: seat.id, roomId: "demo", workspace: source, taskId: candidate.taskId,
  }))[0]?.status, "completed");
  assert.deepEqual(
    service.audit.list({ roomId: "demo", limit: 20 }).filter((event) => event.taskId === candidate.taskId)
      .map((event) => event.type),
    ["candidate.started", "candidate.checkpointed", "candidate.completed"],
  );
  const roomMessages = service.ledger.getRoom("demo")?.messages ?? 0;
  assert.match(service.ledger.getRange("demo", 1, roomMessages).map((entry) => entry.text).join("\n"), /Owner 明確核准/u);
  await assert.rejects(
    service.candidateStatus({ presenceId: randomUUID(), roomId: "demo", workspace: source }),
    /PRESENCE_NOT_FOUND/u,
  );
});

test("target unregister races cannot leave a new exact-seat delivery active", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-peer-offline-race-"));
  const senderProcess = collaborationService(data);
  const targetProcess = collaborationService(data);
  t.after(() => senderProcess.close());
  t.after(() => targetProcess.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  senderProcess.ledger.createRoom("demo", "/tmp/project");
  const sender = senderProcess.registerExternal({
    provider: "codex", workspace: "/tmp/project", hostPid: 7401,
  });
  const admit = (seat: ReturnType<CollaborationService["registerExternal"]>) => {
    senderProcess.requestExternalJoin(seat.id, "demo", "/tmp/project");
    senderProcess.approveExternalJoin({
      ...ROOM_FIRST_JOIN,
      presenceId: seat.id,
      roomId: "demo",
      workspace: "/tmp/project",
      label: seat.provider,
    });
    senderProcess.requestExternalStandby(seat.id, "demo", "/tmp/project");
    senderProcess.approveExternalStandby(seat.id, "demo", "/tmp/project");
  };
  admit(sender);

  const firstTarget = targetProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7402,
  });
  admit(firstTarget);
  const append = senderProcess.ledger.appendIdempotent.bind(senderProcess.ledger);
  senderProcess.ledger.appendIdempotent = (...args) => {
    const message = append(...args);
    targetProcess.unregisterExternal(firstTarget.id);
    return message;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sender.id,
      targetPresenceId: firstTarget.id,
      clientRequestId: randomUUID(),
      text: "append 後 target 離線",
    }),
    /TARGET_AGENT_OFFLINE/u,
  );
  senderProcess.ledger.appendIdempotent = append;
  assert.equal(senderProcess.presence.get(firstTarget.id), undefined);
  assert.equal(senderProcess.inbox.list("demo").some((item) => item.targetPresenceId === firstTarget.id), false);

  const secondTarget = targetProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7403,
  });
  admit(secondTarget);
  const enqueue = senderProcess.inbox.enqueue.bind(senderProcess.inbox);
  senderProcess.inbox.enqueue = (...args) => {
    const delivery = enqueue(...args);
    targetProcess.unregisterExternal(secondTarget.id);
    return delivery;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sender.id,
      targetPresenceId: secondTarget.id,
      clientRequestId: randomUUID(),
      text: "enqueue 後 target 離線",
    }),
    /TARGET_AGENT_OFFLINE/u,
  );
  senderProcess.inbox.enqueue = enqueue;
  const raced = senderProcess.inbox.list("demo").find((item) => item.targetPresenceId === secondTarget.id);
  assert.equal(raced?.state, "failed");
  assert.equal(senderProcess.inbox.list("demo").some(
    (item) => item.targetPresenceId === secondTarget.id && ["queued", "delivered", "read", "working"].includes(item.state),
  ), false);

  const thirdTarget = targetProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7404,
  });
  admit(thirdTarget);
  senderProcess.ledger.appendIdempotent = (...args) => {
    const message = append(...args);
    targetProcess.unregisterExternal(sender.id);
    return message;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sender.id,
      targetPresenceId: thirdTarget.id,
      clientRequestId: randomUUID(),
      text: "append 後 source 離線",
    }),
    /SOURCE_AGENT_OFFLINE/u,
  );
  senderProcess.ledger.appendIdempotent = append;
  assert.equal(senderProcess.inbox.list("demo").some((item) => item.targetPresenceId === thirdTarget.id), false);

  const secondSender = senderProcess.registerExternal({
    provider: "codex", workspace: "/tmp/project", hostPid: 7405,
  });
  admit(secondSender);
  senderProcess.inbox.enqueue = (...args) => {
    const delivery = enqueue(...args);
    targetProcess.unregisterExternal(secondSender.id);
    return delivery;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: secondSender.id,
      targetPresenceId: thirdTarget.id,
      clientRequestId: randomUUID(),
      text: "enqueue 後 source 離線",
    }),
    /SOURCE_AGENT_OFFLINE/u,
  );
  senderProcess.inbox.enqueue = enqueue;
  const sourceRaced = senderProcess.inbox.list("demo").find(
    (item) => item.sourcePresenceId === secondSender.id && item.targetPresenceId === thirdTarget.id,
  );
  assert.equal(sourceRaced?.state, "cancelled");
});

test("abnormal target death is reconciled by reply wait and room visibility without presence polling", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-peer-crash-reconcile-"));
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("demo", "/tmp/project");
  const admit = (provider: "codex" | "claude", hostPid: number) => {
    const seat = service.registerExternal({ provider, workspace: "/tmp/project", hostPid });
    service.requestExternalJoin(seat.id, "demo", "/tmp/project");
    service.approveExternalJoin({
      ...ROOM_FIRST_JOIN,
      presenceId: seat.id,
      roomId: "demo",
      workspace: "/tmp/project",
      label: provider,
    });
    service.requestExternalStandby(seat.id, "demo", "/tmp/project");
    service.approveExternalStandby(seat.id, "demo", "/tmp/project");
    return seat;
  };
  const source = admit("codex", 7501);
  const waitTarget = admit("claude", 7502);
  const waiting = service.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: source.id,
    targetPresenceId: waitTarget.id,
    clientRequestId: randomUUID(),
    text: "target crash should fail during reply wait",
  });

  service.presence.unregister(waitTarget.id);
  const outcome = await service.waitForExternalReply({
    presenceId: source.id,
    deliveryId: waiting.delivery.id,
    timeoutMs: 1_000,
  });
  assert.equal(outcome?.delivery.state, "failed");
  assert.equal(outcome?.delivery.failReason, "TARGET_SEAT_OFFLINE_DURING_REPLY_WAIT");

  const visibleTarget = admit("claude", 7503);
  const visible = service.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: source.id,
    targetPresenceId: visibleTarget.id,
    clientRequestId: randomUUID(),
    text: "target crash should fail when room becomes visible",
  });
  service.presence.unregister(visibleTarget.id);
  const reconciled = service.roomView("demo", "/tmp/project").deliveries.find(
    (delivery) => delivery.id === visible.delivery.id,
  );
  assert.equal(reconciled?.state, "failed");
  assert.equal(reconciled?.failReason, "SEAT_OFFLINE");

  const raceTarget = admit("claude", 7504);
  const oldDelivery = service.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: source.id,
    targetPresenceId: raceTarget.id,
    clientRequestId: randomUUID(),
    text: "only the delivery observed before rejoin may fail",
  });
  service.presence.leave(raceTarget.id, "demo");
  const preciseFail = service.inbox.failDeliveryIfTargetUnavailable.bind(service.inbox);
  let newDelivery: ReturnType<CollaborationService["postBetweenExternals"]> | undefined;
  service.inbox.failDeliveryIfTargetUnavailable = (input) => {
    if (!newDelivery) {
      service.requestExternalJoin(raceTarget.id, "demo", "/tmp/project");
      service.approveExternalJoin({
        ...ROOM_FIRST_JOIN,
        presenceId: raceTarget.id,
        roomId: "demo",
        workspace: "/tmp/project",
        label: "claude",
      });
      service.requestExternalStandby(raceTarget.id, "demo", "/tmp/project");
      service.approveExternalStandby(raceTarget.id, "demo", "/tmp/project");
      newDelivery = service.postBetweenExternals({
        roomId: "demo",
        workspace: "/tmp/project",
        sourcePresenceId: source.id,
        targetPresenceId: raceTarget.id,
        clientRequestId: randomUUID(),
        text: "new work after exact-seat rejoin must survive stale reconciliation",
      });
    }
    return preciseFail(input);
  };
  const raceView = service.roomView("demo", "/tmp/project");
  service.inbox.failDeliveryIfTargetUnavailable = preciseFail;
  assert.equal(raceView.deliveries.find((item) => item.id === oldDelivery.delivery.id)?.state, "failed");
  assert.equal(raceView.deliveries.find((item) => item.id === newDelivery?.delivery.id)?.state, "queued");
});

test("managed and external seats cannot claim the same room display identity", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-name-"));
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("demo", "/tmp/project");

  const external = service.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7101 });
  service.requestExternalJoin(external.id, "demo", "/tmp/project");
  service.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: external.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: "same",
  });
  assert.throws(() => service.createManaged({
    roomId: "demo",
    workspace: "/tmp/project",
    provider: "codex",
    model: "gpt-test",
    label: "same",
  }), /MANAGED_AGENT_DISPLAY_NAME_IN_USE/u);

  service.createManaged({
    roomId: "demo",
    workspace: "/tmp/project",
    provider: "claude",
    model: "claude-test",
    label: "reserved",
  });
  const another = service.registerExternal({ provider: "claude", workspace: "/tmp/project", hostPid: 7102 });
  service.requestExternalJoin(another.id, "demo", "/tmp/project");
  assert.throws(() => service.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: another.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: "reserved",
  }), /PRESENCE_DISPLAY_NAME_IN_USE/u);
  assert.equal(service.presence.get(another.id)?.joined, false);
});

test("a second GUI preserves a live cross-process Writer run and revokes it only after the heartbeat stops", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-restart-"));
  const first = collaborationService(data);
  const second = collaborationService(data);
  t.after(() => first.close());
  t.after(() => second.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  first.ledger.createRoom("demo", "/tmp/project");
  const granted = first.writerLeases.grant({
    taskId: "live-across-gui",
    roomId: "demo",
    workspace: "/tmp/project",
    worktree: "/tmp/project-live-across-gui",
    writer: { origin: "resident", provider: "codex", actorId: "codex", displayName: "codex" },
  });
  const runId = "00000000-0000-4000-8000-000000000077";
  first.writerLeases.beginRun("live-across-gui", runId, "first-gui");
  assert.equal(second.revokeUnrecoverableWriters(), 0);
  assert.equal(second.writerLeases.current("live-across-gui")?.id, granted.lease.id);
  first.writerLeases.finishRun("live-across-gui", runId, "first-gui");
  assert.equal(second.revokeUnrecoverableWriters(), 1);
  assert.equal(first.writerLeases.current("live-across-gui"), undefined);
  assert.equal(second.audit.verify(), true);
});

test("vNext revokes persisted external Writer capabilities and runs while preserving managed leases", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-legacy-external-"));
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("demo", "/tmp/project");

  const legacy = service.writerLeases.grant({
    taskId: "legacy-external",
    roomId: "demo",
    workspace: "/tmp/project",
    worktree: "/tmp/project-legacy-external",
    writer: {
      origin: "external",
      provider: "codex",
      actorId: "codex-legacy-seat",
      displayName: "codex（legacy）",
    },
  });
  const writableChild = service.writerDelegations.create({
    parent: legacy.lease,
    childProvider: "codex",
    label: "legacy-write",
    workspace: legacy.lease.worktree,
  });
  const readonlyChild = service.writerDelegations.create({
    parent: legacy.lease,
    childProvider: "claude",
    label: "legacy-review",
    workspace: legacy.lease.worktree,
  });
  const legacyRunId = "00000000-0000-4000-8000-000000000078";
  service.writerLeases.beginRun(legacy.lease.taskId, legacyRunId, "legacy-gui");

  assert.throws(() => service.assertWriterWrite({
    taskId: legacy.lease.taskId,
    roomId: "demo",
    workspace: "/tmp/project",
    epoch: legacy.lease.epoch,
    capabilityToken: legacy.capabilityToken,
    executedBy: legacy.lease.executedBy,
  }), /NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED/u);
  assert.throws(() => service.assertDelegatedWrite({
    delegationId: writableChild.delegation.id,
    taskId: legacy.lease.taskId,
    roomId: "demo",
    workspace: "/tmp/project",
    capabilityToken: writableChild.capabilityToken!,
    executedBy: writableChild.delegation.executedBy,
  }), /NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED/u);
  assert.throws(() => service.assertDelegatedRead({
    delegationId: readonlyChild.delegation.id,
    taskId: legacy.lease.taskId,
    roomId: "demo",
    workspace: "/tmp/project",
    executedBy: readonlyChild.delegation.executedBy,
  }), /NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED/u);

  const managed = service.writerLeases.grant({
    taskId: "managed-live",
    roomId: "demo",
    workspace: "/tmp/project",
    worktree: "/tmp/project-managed-live",
    writer: {
      origin: "managed",
      provider: "claude",
      actorId: "managed-claude",
      displayName: "claude（managed）",
    },
  });
  const managedRunId = "00000000-0000-4000-8000-000000000079";
  service.writerLeases.beginRun(managed.lease.taskId, managedRunId, "current-gui");

  assert.equal(service.revokeUnrecoverableWriters(), 1);
  assert.equal(service.writerLeases.current(legacy.lease.taskId), undefined);
  assert.equal(service.writerLeases.hasActiveRun(legacy.lease.taskId), false);
  assert.throws(
    () => service.writerLeases.heartbeatRun(legacy.lease.taskId, legacyRunId, "legacy-gui"),
    /WRITER_RUN_LOCK_LOST/u,
  );
  assert.equal(service.writerLeases.current(managed.lease.taskId)?.id, managed.lease.id);
  assert.equal(service.writerLeases.hasActiveRun(managed.lease.taskId), true);
  assert.deepEqual(
    service.writerDelegations.list("demo")
      .filter((delegation) => delegation.parentLeaseId === legacy.lease.id)
      .map((delegation) => delegation.state),
    ["revoked", "revoked"],
  );
  assert.equal(service.writerLeases.taskScope(legacy.lease.taskId)?.worktree, legacy.lease.worktree);
  const revocation = service.audit.list({ roomId: "demo" })
    .find((event) => event.action === "revoke-legacy-external");
  assert.equal(revocation?.outcome, "succeeded");
  assert.equal((revocation?.detail as { terminatedRun?: boolean }).terminatedRun, true);

  service.writerLeases.finishRun(managed.lease.taskId, managedRunId, "current-gui");
});

test("service rejects cross-room removal and delivery impersonation", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-guard-"));
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("first", "/tmp/project");
  service.ledger.createRoom("second", "/tmp/project");
  const first = service.registerExternal({ provider: "claude", workspace: "/tmp/project", hostPid: 7002 });
  const second = service.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7003 });
  const foreign = service.registerExternal({ provider: "grok", workspace: "/tmp/other", hostPid: 7004 });
  assert.throws(
    () => service.requestExternalJoin(foreign.id, "first", "/tmp/project"),
    /PRESENCE_WORKSPACE_MISMATCH/u,
  );
  service.requestExternalJoin(first.id, "first", "/tmp/project");
  service.requestExternalJoin(second.id, "first", "/tmp/project");
  service.approveExternalJoin({ ...ROOM_FIRST_JOIN, presenceId: first.id, roomId: "first", workspace: "/tmp/project" });
  service.approveExternalJoin({ ...ROOM_FIRST_JOIN, presenceId: second.id, roomId: "first", workspace: "/tmp/project" });
  service.requestExternalStandby(first.id, "first", "/tmp/project");
  service.approveExternalStandby(first.id, "first", "/tmp/project");
  const posted = service.postToExternal({ roomId: "first", workspace: "/tmp/project", presenceId: first.id, text: "task" });

  assert.throws(
    () => service.removeExternal({ presenceId: first.id, roomId: "second", workspace: "/tmp/project" }),
    /PRESENCE_NOT_JOINED/u,
  );
  assert.throws(
    () => service.ackExternal({
      presenceId: second.id,
      deliveryId: posted.delivery.id,
      leaseToken: "33333333-3333-4333-8333-333333333333",
      phase: "read",
    }),
    /DELIVERY_NOT_FOUND/u,
  );
});

test("service grants and switches Writer only to eligible room identities", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-writer-"));
  const source = await repository();
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const external = service.registerExternal({ provider: "codex", workspace: source, hostPid: 7010 });
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "external", actorId: external.id } as never,
  }), /WRITER_CANDIDATE_NOT_ELIGIBLE/u);
  service.requestExternalJoin(external.id, "demo", source);
  const joined = service.approveExternalJoin({ ...ROOM_FIRST_JOIN, presenceId: external.id, roomId: "demo", workspace: source, label: "修復" });
  const nativeView = service.roomView("demo", source).sessions.find((session) => session.id === joined.id);
  assert.equal(nativeView?.executionClass, "native-full-trust");
  assert.equal(nativeView?.capabilityAuthority, "host");
  assert.equal(nativeView?.hostCapabilities, "unchanged");
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "external", actorId: external.id } as never,
  }), /WRITER_CANDIDATE_NOT_ELIGIBLE/u);
  const granted = await service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "codex" },
  });
  assert.equal(granted.lease.writer.displayName, "codex");
  assert.equal(granted.lease.executedBy, "codex");

  const managed = service.createManaged({ roomId: "demo", workspace: source, provider: "claude", model: "claude-test", label: "審查" });
  const switched = service.switchWriter({
    taskId: "task-1", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "外接 Codex 已完成初稿。\n尚未合併。", candidate: { origin: "managed", actorId: managed.id },
  });
  assert.equal(switched.lease.epoch, 2);
  assert.equal(switched.lease.writer.displayName, managed.displayName);
  assert.equal(switched.lease.executedBy, managed.id);
  assert.ok(service.ledger.listAfter("demo", 0, 30)
    .filter((message) => message.kind === "system")
    .every((message) => !message.text.includes("\n")));
  assert.equal(service.roomView("demo", source).writerLeases.at(-1)?.id, switched.lease.id);
  assert.equal(service.assertWriterWrite({
    taskId: "task-1", roomId: "demo", workspace: source, epoch: 2,
    capabilityToken: switched.capabilityToken, executedBy: managed.id,
  }).id, switched.lease.id);

  service.ledger.createRoom("other", source);
  assert.throws(() => service.assertWriterWrite({
    taskId: "task-1", roomId: "other", workspace: source, epoch: 2,
    capabilityToken: switched.capabilityToken, executedBy: managed.id,
  }), /WRITER_TASK_SCOPE_MISMATCH/u);
  assert.throws(() => service.completeWriter({
    taskId: "task-1", roomId: "other", workspace: source, epoch: 2, checkpoint: "wrong room",
  }), /WRITER_TASK_SCOPE_MISMATCH/u);

  service.archiveManaged(managed.id, "demo", source);
  assert.equal(service.writerLeases.current("task-1"), undefined);
  assert.throws(() => service.assertWriterWrite({
    taskId: "task-1", roomId: "demo", workspace: source, epoch: 2,
    capabilityToken: switched.capabilityToken, executedBy: managed.id,
  }), /WRITER_LEASE_NOT_ACTIVE/u);

  const resumed = await service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  });
  assert.equal(resumed.lease.epoch, 3);
  assert.equal(resumed.lease.worktree, granted.lease.worktree);
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_LEASE_ALREADY_ACTIVE/u);
  assert.throws(() => service.switchWriter({
    taskId: "missing-task", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "missing", candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_TASK_SCOPE_MISMATCH/u);
  await assert.rejects(service.grantWriter({
    taskId: "managed-missing", roomId: "demo", workspace: source,
    candidate: { origin: "managed", actorId: "00000000-0000-4000-8000-000000000099" },
  }), /WRITER_CANDIDATE_NOT_ELIGIBLE/u);

  service.removeExternal({ presenceId: external.id, roomId: "demo", workspace: source });
  service.completeWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    epoch: resumed.lease.epoch, checkpoint: "完成後保留 worktree",
  });
  await rm(resumed.lease.worktree, { recursive: true, force: true });
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_RETAINED_WORKTREE_MISSING/u);
});

test("Writer grant explains that a repository without a base commit cannot create a worktree", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "orchestratory-writer-empty-source-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-writer-empty-data-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("empty", source);
  await assert.rejects(service.grantWriter({
    taskId: "no-base", roomId: "empty", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_BASE_COMMIT_REQUIRED/u);
});

test("Writer serializes same-provider writable children in the task worktree and keeps cross-provider children read-only", async (t) => {
  const source = await repository("orchestratory-delegation-source-");
  const data = await mkdtemp(join(tmpdir(), "orchestratory-delegation-service-"));
  const service = collaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const writer = await service.grantWriter({
    taskId: "task-delegate", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "codex" },
  });

  const writable = await service.delegateWriterChild({
    taskId: "task-delegate", roomId: "demo", workspace: source, epoch: writer.lease.epoch,
    capabilityToken: writer.capabilityToken, executedBy: writer.lease.executedBy,
    childProvider: "codex", label: "實作",
  });
  assert.equal(writable.delegation.access, "write");
  assert.equal(writable.delegation.workspace, writer.lease.worktree);
  assert.equal(service.assertDelegatedWrite({
    delegationId: writable.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    capabilityToken: writable.capabilityToken!, executedBy: writable.delegation.executedBy,
  }).workspace, writable.delegation.workspace);

  const readonly = await service.delegateWriterChild({
    taskId: "task-delegate", roomId: "demo", workspace: source, epoch: writer.lease.epoch,
    capabilityToken: writer.capabilityToken, executedBy: writer.lease.executedBy,
    childProvider: "claude", label: "審查",
  });
  assert.equal(readonly.delegation.access, "read-only");
  assert.equal(readonly.delegation.workspace, writer.lease.worktree);
  assert.equal(service.assertDelegatedRead({
    delegationId: readonly.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    executedBy: readonly.delegation.executedBy,
  }).id, readonly.delegation.id);
  assert.throws(() => service.assertDelegatedRead({
    delegationId: readonly.delegation.id, taskId: "missing-task", roomId: "demo", workspace: source,
    executedBy: readonly.delegation.executedBy,
  }), /DELEGATION_PARENT_LEASE_STALE/u);
  assert.throws(() => service.assertDelegatedWrite({
    delegationId: readonly.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    capabilityToken: "00000000-0000-4000-8000-000000000000", executedBy: readonly.delegation.executedBy,
  }), /DELEGATION_WRITE_DENIED/u);

  const switched = service.switchWriter({
    taskId: "task-delegate", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "Codex 子工作已停止。", candidate: { origin: "resident", provider: "claude" },
  });
  assert.deepEqual(service.writerDelegations.list("demo").map((child) => child.state), ["revoked", "revoked"]);
  assert.throws(() => service.assertDelegatedWrite({
    delegationId: writable.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    capabilityToken: writable.capabilityToken!, executedBy: writable.delegation.executedBy,
  }), /DELEGATION_NOT_ACTIVE/u);
  for (const action of ["list_files", "read_file", "create_directory", "write_file"] as const) {
    service.recordWorkspaceOperation({
      taskId: "task-delegate", roomId: "demo", workspace: source,
      actor: switched.lease.writer.displayName, onBehalfOf: switched.lease.onBehalfOf,
      executedBy: switched.lease.executedBy, leaseEpoch: switched.lease.epoch,
      action, ...(action === "list_files" ? {} : { path: `src/${action}.ts` }), outcome: "succeeded",
    });
  }
  const originalGetRoom = service.ledger.getRoom.bind(service.ledger);
  service.ledger.getRoom = ((roomId: string) => {
    const room = originalGetRoom(roomId);
    return room ? { ...room, messages: 4_500 } : undefined;
  }) as typeof service.ledger.getRoom;
  service.recordWorkspaceOperation({
    taskId: "task-delegate", roomId: "demo", workspace: source,
    actor: switched.lease.writer.displayName, onBehalfOf: switched.lease.onBehalfOf,
    executedBy: switched.lease.executedBy, leaseEpoch: switched.lease.epoch,
    action: "write_file", path: "src/ledger-reserve.ts", outcome: "succeeded",
  });
  service.ledger.getRoom = originalGetRoom;
  assert.equal(service.completeWriter({
    taskId: "task-delegate", roomId: "demo", workspace: source,
    epoch: switched.lease.epoch, checkpoint: "Claude Writer 完成",
  }).state, "completed");
  assert.equal(service.revokeUnrecoverableWriters(), 0);
});

/*
 * A store whose schema is newer than this build refuses to open, and that refusal is correct —
 * old code misreading new rows is worse than old code stopping. What was not correct was the blast
 * radius: the inbox is constructed in the service constructor, so its refusal threw there and took
 * every other store, and every tool built on them, down with it. Twenty-one of the twenty-seven MCP
 * tools never touch the inbox.
 *
 * This reproduces the real failure — a database written by a later build — rather than injecting a
 * fake error, because what matters is that the actual guard produces a degraded service and not a
 * dead one.
 */
test("an inbox from a newer build disables its own features and nothing else", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-ahead-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));

  /* Let the real store create the file, then stamp a version this build cannot know. */
  const seed = new CollaborationService(data, { presence: { leaseMs: 120_000 } });
  assert.equal(seed.inboxAvailable, true, "the seeded service must start healthy");
  seed.close();

  const raw = new DatabaseSync(join(data, "room-inbox.sqlite"));
  raw.exec("PRAGMA user_version = 9999");
  raw.close();

  const service = new CollaborationService(data, { presence: { leaseMs: 120_000 } });
  t.after(() => service.close());

  assert.equal(service.inboxAvailable, false);

  /* The reason has to be actionable. A bare code tells the person relaying it nothing they can do,
     and the person is usually not the one who knows what a schema version is. */
  const reason = service.inboxUnavailableReason ?? "";
  assert.match(reason, /SCHEMA_TOO_NEW/u);
  /* The wording matters, not just the presence of reassurance. This used to assert 「其餘工具正常運作」,
     which promised the other stores were healthy — a guarantee this code cannot make, since it only
     knows the inbox failed. The sentence now scopes the promise to non-involvement, and the assertion
     pins that narrower claim so a future widening back to 「正常運作」 has to go red first. */
  assert.match(reason, /不使用收件匣的工具不受這件事影響/u, "it must scope what is unaffected, not vouch for the rest");
  assert.match(reason, /install:runtime/u, "it must say what to do about it");

  /* Everything that does not need the inbox still does. This is the whole point of the change. */
  const room = service.ledger.createRoom("degraded", data);
  /* Relative, not absolute: creating a room writes its own opening line, so a hard 0 here would be
     asserting an implementation detail rather than the property being tested — that appending still
     works while the inbox is down. */
  const before = service.ledger.getRoom(room.id)?.messages ?? 0;
  service.ledger.append(room.id, "you", "帳本照常運作");
  assert.equal(service.ledger.getRoom(room.id)?.messages, before + 1);
  assert.ok(service.ledger.listAfter(room.id, 0).some((m) => m.text === "帳本照常運作"));
  assert.equal(service.presence.list(data).length, 0);
  assert.ok(service.candidates);
  assert.ok(service.audit);

  /* And asking for the inbox gives the actionable reason, at the call rather than at construction. */
  assert.throws(() => service.inbox.list(room.id), /SCHEMA_TOO_NEW/u);
});

test("a store that cannot open takes the ones opened before it down with it", async (t) => {
  /*
   * The branch the previous round claimed and never tested. "Corruption and permissions still fail
   * closed" was true about the throw and silent about everything else: the ledger and presence
   * stores were already open when the inbox threw, the throw escaped the constructor, and with no
   * instance there was no `close()` anyone could call. Each store cleans up after its own failed
   * constructor, which is exactly why nobody noticed -- the leak lives between them.
   */
  const data = await mkdtemp(join(tmpdir(), "orchestratory-store-fail-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));

  /* Let the real stores create their files, then make the inbox unopenable in a way that is not a
     version mismatch, so it must not degrade. */
  const seed = new CollaborationService(data, { presence: { leaseMs: 120_000 } });
  seed.close();
  await writeFile(join(data, "room-inbox.sqlite"), "this is not a database", "utf8");

  assert.throws(
    () => new CollaborationService(data, { presence: { leaseMs: 120_000 } }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /STORE_UNAVAILABLE:room-inbox:CORRUPT/u, "the class has to be actionable");
      /* Asserted against the path this run actually used, not against a spelling of somebody's home
         directory. Writing that spelling here would put it in a file the repository scanner reads,
         which is the same mistake in a different place -- and this is the stronger check anyway: it
         catches a leak of THIS path rather than a leak that happens to look like a Mac. */
      assert.equal(message.includes(data), false, "the message must not repeat the data directory");
      assert.ok(error instanceof Error && error.cause !== undefined, "the original must stay reachable");
      return true;
    },
  );

  /*
   * The stores really were closed. A leaked SQLite connection leaves its WAL sidecar behind because
   * nothing checkpointed it; a closed one does not. Asserting on the sidecar is the observable
   * consequence rather than a restatement of the code.
   */
  const leftovers = await readdir(data);
  assert.equal(
    leftovers.some((name) => name === "rooms.sqlite-wal" || name === "room-presence.sqlite-wal"),
    false,
    `stores opened before the failure were left open: ${leftovers.join(", ")}`,
  );
});

test("failure classes say what to do, and never repeat what the failure said", () => {
  /* Each class exists because the reader's next action differs. A message that cannot tell them
     apart sends someone to retry a full disk or to reopen a corrupt file. */
  assert.equal(classifyStoreFailure(new Error("UNSAFE_SQLITE_FILE")), "PERMISSION");
  assert.equal(classifyStoreFailure(Object.assign(new Error("x"), { code: "EACCES" })), "PERMISSION");
  assert.equal(classifyStoreFailure(Object.assign(new Error("x"), { code: "ENOSPC" })), "DISK_FULL");
  assert.equal(classifyStoreFailure(new Error("database or disk is full")), "DISK_FULL");
  assert.equal(classifyStoreFailure(new Error("ROOM_INBOX_CORRUPT")), "CORRUPT");
  assert.equal(classifyStoreFailure(new Error("file is not a database")), "CORRUPT");
  assert.equal(classifyStoreFailure(new Error("something nobody has seen")), "UNRECOGNISED");

  /* The property that matters more than the classification: nothing from the failure is echoed. */
  /* Spelled with the placeholder the repository scan already allows, rather than assembled from
     parts to slip past it. Getting around a rule that guards a public repository is not a smaller
     version of obeying it, and this file would be a strange place to start. */
  const secret = "/Users/example/private/data.sqlite";
  const leaky = Object.assign(
    new Error(`ENOENT: no such file or directory, open '${secret}'`),
    { code: "EACCES" },
  );
  const described = describeStoreFailure("room-inbox", leaky);
  assert.equal(described.includes(secret), false, "the path must not survive into the description");
  assert.equal(described.includes(leaky.message), false, "nothing the failure said may be echoed");
  assert.match(described, /STORE_UNAVAILABLE:room-inbox:PERMISSION/u);
});

test("the original failure stays reachable locally, and the summariser drops it", async (t) => {
  /*
   * `cause` is how a person debugging keeps the real error after it has been classified, and it is
   * the obvious place for the path to escape from: the message is scrubbed, and then the thing it
   * was scrubbed of travels attached to it.
   *
   * What this proves, exactly: `safeSummary` applied to the wrapped message drops the original,
   * which is the shape both MCP servers use for their JSON-RPC error field.
   *
   * What it does NOT prove, and the name said it did: that no future code path sends the whole
   * Error or summarises `cause` alongside `message`. Nothing here constructs a server or reads a
   * response, so a change like that would ship green past this test. The earlier name --
   * "never reaches the wire" -- claimed the second thing while testing the first, in a round whose
   * subject is exactly that gap.
   *
   * Today nothing serialises `cause`: the MCP layer sends `error.message` through `safeSummary`,
   * and no caller reads `.cause`. That is verified by reading, not by this test, and is recorded in
   * ADR-045 as a property held by convention rather than by a guard.
   */
  const secret = "/Users/example/private/data.sqlite";
  const original = Object.assign(new Error(`EACCES: permission denied, open '${secret}'`), {
    code: "EACCES",
  });
  const wrapped = new Error(describeStoreFailure("room-inbox", original), { cause: original });

  /* Local debugging keeps everything. */
  assert.equal(wrapped.cause, original, "the original must remain reachable in-process");
  assert.ok(String((wrapped.cause as Error).message).includes(secret));

  /* The wire gets the message, summarised, and nothing else -- the exact shape collab-server.ts and
     workspace-server.ts both use for their JSON-RPC error field. */
  const onTheWire = safeSummary(wrapped instanceof Error ? wrapped.message : "MCP_ERROR", 200);
  assert.equal(onTheWire.includes(secret), false, "the path must not survive summarisation");
  assert.equal(onTheWire.includes("EACCES: permission denied"), false, "nor may the original text");
  assert.match(onTheWire, /STORE_UNAVAILABLE:room-inbox:PERMISSION/u);
});

test("a permission failure is a real one, produced by the filesystem rather than by a hand-built Error", async (t) => {
  /*
   * The classification tests above construct Errors and check how they are read. That verifies the
   * reading and nothing about whether such an Error ever arrives. This one loosens a real data
   * directory to 0755 and lets the store refuse it, so the path from "the filesystem said no" to
   * "the person is told what to check" is exercised end to end at least once.
   *
   * 0755 rather than 0000 on purpose: an unreadable directory fails everywhere and proves little,
   * while a group-readable one is the mistake people actually make -- a `chmod -R 755`, a restore
   * from a backup, a directory created before the product existed.
   */
  const data = await mkdtemp(join(tmpdir(), "orchestratory-perm-"));
  t.after(async () => {
    await chmod(data, 0o700).catch(() => undefined);
    await rm(data, { recursive: true, force: true });
  });

  const seed = new CollaborationService(data, { presence: { leaseMs: 120_000 } });
  seed.close();
  await chmod(data, 0o755);

  /* Running as root, or on a filesystem that ignores the mode bits, makes this unobservable. Say so
     rather than passing quietly: a test that measures nothing is the thing this round is about. */
  const enforced = (await stat(data)).mode & 0o777;
  if (enforced !== 0o755) {
    t.skip(`this filesystem reported mode ${enforced.toString(8)}; the permission cannot be observed here`);
    return;
  }

  assert.throws(
    () => new CollaborationService(data, { presence: { leaseMs: 120_000 } }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /STORE_UNAVAILABLE:[a-z-]+:PERMISSION/u, "a real refusal must classify as PERMISSION");
      assert.match(message, /chmod|權限/u, "and must say what to check");
      assert.equal(message.includes(data), false, "without repeating the path");
      return true;
    },
  );
});
