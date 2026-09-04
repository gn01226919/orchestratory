import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli-entry.ts";
import { helpText } from "../src/help.ts";
import {
  describeOrphanRecoveryRefs, describePromotions, runCandidatePromotionsCommand,
  type PromotionReleasePort,
} from "../src/main.ts";
import { defaultNaturalLanguageTeam } from "../src/ui/tui.ts";

test("global CLI help and safe entrypoint remain bounded", async () => {
  assert.match(helpText(), /natural-language TUI \+ local GUI/u);
  assert.match(helpText(), /loopback-only visual GUI/u);
  assert.match(helpText(), /approval-gated/u);
  let errorOutput = "";
  assert.equal(
    await runCli(async () => {
      throw new Error("UNKNOWN_COMMAND");
    }, (value) => {
      errorOutput += value;
    }),
    1,
  );
  assert.equal(errorOutput, "Error: UNKNOWN_COMMAND\n");
  assert.doesNotMatch(errorOutput, /\bat main\b|file:\/\//u);
  assert.equal(await runCli(async () => undefined), 0);
});

test("orphan recovery refs are reportable, explained, and never offered for deletion", () => {
  // The command has to exist in help at all: an accumulating recovery point nobody can see is the
  // defect this exit closes, and an undiscoverable command is the same defect one step removed.
  assert.match(helpText(), /candidates orphan-refs/u);
  assert.match(helpText(), /read-only; lists, never deletes/u);

  const known = "11111111-1111-4111-8111-111111111111";
  const unknown = "22222222-2222-4222-8222-222222222222";
  const empty = describeOrphanRecoveryRefs({
    mainPath: "/workspace/project", orphans: [], limit: 100, taskStatus: () => undefined,
  });
  assert.match(empty, /^No orphan recovery refs under refs\/orchestratory\/checkpoints in \/workspace\/project\.\n$/u);

  const report = describeOrphanRecoveryRefs({
    mainPath: "/workspace/project",
    orphans: [
      { ref: `refs/orchestratory/checkpoints/${known}/33333333-3333-4333-8333-333333333333`, head: "a".repeat(40) },
      { ref: `refs/orchestratory/checkpoints/${unknown}/44444444-4444-4444-8444-444444444444`, head: "b".repeat(40) },
    ],
    limit: 100,
    taskStatus: (taskId) => (taskId === known ? "completed" : undefined),
  });
  // Which ref, what it points at, which task, and why it counts as an orphan.
  assert.match(report, /Orphan recovery refs under refs\/orchestratory\/checkpoints in \/workspace\/project: 2\n/u);
  assert.match(report, new RegExp(`refs/orchestratory/checkpoints/${known}/33333333-3333-4333-8333-333333333333`, "u"));
  assert.match(report, /commit {6}a{40}/u);
  assert.match(report, new RegExp(`task {8}${known} \\(candidate status: completed\\)`, "u"));
  assert.match(report, new RegExp(`task {8}${unknown} \\(no candidate row on record\\)`, "u"));
  assert.match(report, /checkpoint {2}33333333-3333-4333-8333-333333333333 \(no checkpoint row on record\)/u);
  assert.match(report, /no owning checkpoint row in the candidate ledger/u);
  // Read-only by construction: the report must not advertise a removal path that does not exist.
  assert.match(report, /Listed only\. Removing a recovery ref is a destructive Git action and is not offered here\./u);
  assert.doesNotMatch(report, /--execute|--delete|update-ref -d/u);
  assert.doesNotMatch(report, /\(scan limit/u);

  // A truncated scan says so rather than reading as a complete inventory.
  const capped = describeOrphanRecoveryRefs({
    mainPath: "/workspace/project",
    orphans: [{ ref: `refs/orchestratory/checkpoints/${known}/55555555-5555-4555-8555-555555555555`, head: "c".repeat(40) }],
    limit: 1,
    taskStatus: () => "active",
  });
  assert.match(capped, /\(scan limit 1 reached — more may exist\)/u);
});

test("natural-language mode defaults to Codex 5.6 Sol with a Claude Fable 5 writer", () => {
  const team = defaultNaturalLanguageTeam();
  assert.deepEqual(team.planner, {
    role: "planner",
    provider: "codex",
    model: "gpt-5.6-sol",
    authMode: "subscription",
  });
  assert.deepEqual(team.writer, {
    role: "writer",
    provider: "claude",
    model: "claude-fable-5",
    authMode: "subscription",
  });
  assert.deepEqual(team.reviewer, {
    role: "reviewer",
    provider: "codex",
    model: "gpt-5.6-sol",
    authMode: "subscription",
  });
});

test("conversation slash commands dispatch without a terminal", async () => {
  const { runConversationCommand } = await import("../src/ui/tui.ts");
  const { NaturalLanguageSession } = await import("../src/core/session.ts");
  const { ProviderRegistry } = await import("../src/providers/registry.ts");
  const { DEFAULT_HARD_LIMITS } = await import("../src/config.ts");
  // Slash commands never call invoke, so the default provider path is unused here.
  const makeSession = () => new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
  });
  const opts = { guiUrl: "http://127.0.0.1:4317", maxProviderCalls: 500 };

  assert.deepEqual(runConversationCommand("/exit", makeSession(), opts), { exit: true, openAdvanced: false, lines: [] });
  assert.deepEqual(runConversationCommand("/quit", makeSession(), opts).exit, true);
  assert.match(runConversationCommand("/help", makeSession(), opts).lines.join("\n"), /\/advanced/u);
  assert.match(runConversationCommand("/agents", makeSession(), opts).lines.join("\n"), /主代理/u);
  assert.match(runConversationCommand("/status", makeSession(), opts).lines.join("\n"), /session .* 回合/u);
  assert.match(runConversationCommand("/gui", makeSession(), opts).lines.join("\n"), /4317/u);
  assert.match(runConversationCommand("/gui", makeSession(), { maxProviderCalls: 500 }).lines.join("\n"), /沒有啟動 GUI/u);
  assert.match(runConversationCommand("/nope", makeSession(), opts).lines.join("\n"), /未知指令/u);
  assert.equal(runConversationCommand("/advanced", makeSession(), opts).openAdvanced, true);

  const cleared = makeSession();
  assert.match(runConversationCommand("/new", cleared, opts).lines.join("\n"), /已清除/u);

  // /model view, switch, and validation.
  assert.match(runConversationCommand("/model", makeSession(), opts).lines.join("\n"), /主代理：codex/u);
  assert.match(runConversationCommand("/model claude", makeSession(), opts).lines.join("\n"), /用法/u);
  const switched = makeSession();
  assert.match(runConversationCommand("/model claude claude-fable-5", switched, opts).lines.join("\n"), /已切換為 claude/u);
  assert.equal(switched.status().mainAgent.provider, "claude");
  assert.match(runConversationCommand("/model shell x", makeSession(), opts).lines.join("\n"), /無法切換主代理/u);
});

test("/local applies for the loopback endpoint and never registers it itself", async () => {
  const { runConversationCommand } = await import("../src/ui/tui.ts");
  const { NaturalLanguageSession } = await import("../src/core/session.ts");
  const { ProviderRegistry } = await import("../src/providers/registry.ts");
  const { DEFAULT_HARD_LIMITS } = await import("../src/config.ts");
  const registry = new ProviderRegistry([]);
  const session = new NaturalLanguageSession({
    providers: registry,
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
  });
  const opts = { maxProviderCalls: 500 };

  // Bare /local explains the gate instead of opening it.
  const help = runConversationCommand("/local", session, opts);
  assert.equal(help.localEndpointRequest, undefined);
  assert.match(help.lines.join("\n"), /loopback/u);
  assert.match(help.lines.join("\n"), /唯讀角色/u);

  // A candidate is only ever handed back for confirmation, never registered here.
  const applied = runConversationCommand("/local http://127.0.0.1:11434", session, opts);
  assert.equal(applied.localEndpointRequest, "http://127.0.0.1:11434");
  assert.equal(applied.lines.length, 0);
  assert.equal(registry.has("local"), false);

  // Extra words are rejected rather than silently truncated to the first token.
  assert.equal(
    runConversationCommand("/local http://127.0.0.1:11434 extra", session, opts).localEndpointRequest,
    undefined,
  );

  // Once registered the command reports state and refuses to re-point the id.
  assert.equal(
    runConversationCommand("/local http://127.0.0.1:11434", session, {
      ...opts,
      localEndpointRegistered: true,
    }).localEndpointRequest,
    undefined,
  );
  assert.match(
    runConversationCommand("/local", session, { ...opts, localEndpointRegistered: true })
      .lines.join("\n"),
    /已在這次啟動中加入/u,
  );
  assert.match(runConversationCommand("/help", session, opts).lines.join("\n"), /\/local/u);
});

/*
 * Bar item 11 requires that any state which occupies a task's one open question have a PRODUCT-SIDE
 * path to release it. Until this command existed, `promotions()` and the three release actions had
 * no CLI, HTTP, MCP or GUI caller anywhere — the only way to reach them was for the owner to write a
 * Node script against a private SQLite file, which is not a product-side path.
 *
 * These cover the report and the argument handling. The command driving a REAL registry against a
 * REAL blocked promotion is in test/merge-promotion.test.ts, where the git fixtures live.
 */
test("promotion records are listable and releasable from the CLI, and the two are separate verbs", async () => {
  assert.match(helpText(), /candidates promotions <workspace>/u);
  // FINDING F-3 (sixth round). Both of these used to say "read-only", and the listing is not:
  // `promotions()` re-observes every unsettled record, which moves the authoritative row, appends to
  // the audit chain and appends to the room ledger. Measured against `orphan-refs` as a control,
  // which changed none of the three. The writing is bar item 13 working; the label was the defect.
  assert.match(helpText(), /re-observes and names unsettled records/u);
  assert.doesNotMatch(helpText(), /promotions <workspace> {4}# read-only/u);
  assert.match(helpText(), /kills nothing, never writes main/u);
  // Writing to main deliberately has no product-side exit, and help must not imply otherwise.
  assert.doesNotMatch(helpText(), /promote|merge-candidate-into-main/u);

  const id = "11111111-1111-4111-8111-111111111111";
  const taskId = "22222222-2222-4222-8222-222222222222";
  assert.match(
    describePromotions({ mainPath: "/workspace/project", promotions: [] }),
    /^No promotion records for \/workspace\/project\.\n$/u,
  );

  const blocked = describePromotions({
    mainPath: "/workspace/project",
    promotions: [{
      id, taskId, state: "applying",
      mainHeadBefore: "a".repeat(40), mainHeadAfter: null, ownerAlive: true,
      startedAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:01.000Z",
      observation: { code: "PROMOTION_STILL_APPLYING", observedAt: "2026-08-07T00:00:01.000Z" },
      pending: {
        code: "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING", pid: 4242,
        inspect: "ps -o pid,ppid,pgid,stat,lstart,command -p 4242",
        release: "STOP WAITING FOR BOTH PROCESSES OF A PROMOTION THAT MAY STILL BE WRITING TO MAIN",
        alsoBlockedBy: { pid: 4343, inspect: "ps -o pid,ppid,pgid,stat,lstart,command -g 4343" },
      },
    } as unknown as Parameters<typeof describePromotions>[0]["promotions"][number]],
  });
  // Which record, what it waits on, and the exact invocation that would release it.
  assert.match(blocked, /PROMOTION_OWNER_AND_MERGE_STILL_RUNNING \(pid 4242\)/u);
  assert.match(blocked, /and on {6}pid 4343/u);
  assert.match(blocked, /--pid 4242 --pgid 4343/u);
  assert.match(blocked, /Listing re-observes and names unsettled records; it never treats persistent bytes as proof or writes main\./u);
  assert.match(blocked, /Releasing a record stops it waiting; it never kills a process either\./u);
  // The header must not claim to be read-only while the call that produced it writes.
  assert.doesNotMatch(blocked, /Read-only\./u);
  // Nothing it prints may be a command that writes.
  assert.doesNotMatch(blocked, /reset --hard|git clean|kill /u);

  const unreadable = describePromotions({
    mainPath: "/workspace/project",
    promotions: [{
      id, taskId, state: "unreadable", unreadable: true,
      storedState: "applying", holdsProjectExclusiveMarker: true,
      release: {
        confirmation: "STOP LETTING AN UNREADABLE RECORD BLOCK THIS PROJECT WHILE ONE OF ITS"
          + " PROCESSES IS STILL ALIVE AND MAY BE WRITING TO MAIN",
        alive: [{ kind: "merge", pid: 5151, inspect: "ps -o pid,ppid,pgid,stat,lstart,command -g 5151" }],
      },
    } as unknown as Parameters<typeof describePromotions>[0]["promotions"][number]],
  });
  assert.match(unreadable, /state {7}unreadable/u);
  assert.match(unreadable, /stored {6}applying/u);
  assert.match(unreadable, /exclusive {3}held — every other task in this project is refused while it is/u);
  assert.match(unreadable, /alive {7}merge pid 5151/u);
  assert.match(unreadable, /--pgid 5151/u);
  assert.match(unreadable, /MAY BE WRITING TO MAIN/u);

  const unattested = describePromotions({
    mainPath: "/workspace/project",
    promotions: [{
      id, taskId, state: "unreadable", unreadable: true,
      unreadableReason: "promotion-attestation", storedState: "applied",
      holdsProjectExclusiveMarker: true,
    } as unknown as Parameters<typeof describePromotions>[0]["promotions"][number]],
  });
  assert.match(unattested, /left 'applying' before this process started/u);
  assert.match(unattested, /persistent bytes are not proof of who ended it/u);
  // Bar item 11 applies to this state too: a record that refuses must print the way out of it, and
  // the way out of THIS one is not a release — it names a different verb, and says so.
  assert.match(unattested, /acknowledge --confirm/u);
  assert.doesNotMatch(unattested, /integrity check fails/u,
    "an unattested record was reported as a corrupt one; they have different exits");
  assert.match(unattested, /stored {6}applied/u);
  assert.match(unattested, /exclusive {3}held/u);
  assert.doesNotMatch(unattested, /Merge succeeded|state {7}applied/u);

  // FINDING F-5/F-1 (sixth round). An empty `alive` list means one of two opposite things, and the
  // owner is the one deciding whether to hand back a marker over a merge that may be writing. The
  // listing must not render "probed and found nothing" and "could not probe" as the same screen.
  const unprobed = describePromotions({
    mainPath: "/workspace/project",
    promotions: [{
      id, taskId, state: "unreadable", unreadable: true,
      storedState: "applying", holdsProjectExclusiveMarker: true,
      release: {
        confirmation: "STOP LETTING AN UNREADABLE RECORD BLOCK THIS PROJECT WHILE ONE OF ITS"
          + " PROCESSES IS STILL ALIVE AND MAY BE WRITING TO MAIN",
        alive: [], probeReadable: false,
      },
    } as unknown as Parameters<typeof describePromotions>[0]["promotions"][number]],
  });
  assert.match(unprobed, /alive {7}UNKNOWN — this record's merge group could not be read at all/u);
  assert.match(unprobed, /MAY BE WRITING TO MAIN/u);
  assert.doesNotMatch(unprobed, /--pgid/u);

  // FINDING P0 (seventh round). When two sources name different groups the owner must see BOTH
  // numbers. Printing only the one that probed alive would show them the same screen as a record
  // with a single source, and "the column was preferred" is not a fact about their machine — it was
  // the preference that released the project's marker over a merge that was still writing.
  const contested = describePromotions({
    mainPath: "/workspace/project",
    promotions: [{
      id, taskId, state: "unreadable", unreadable: true,
      storedState: "applying", holdsProjectExclusiveMarker: true,
      release: {
        confirmation: "STOP LETTING AN UNREADABLE RECORD BLOCK THIS PROJECT WHILE ONE OF ITS"
          + " PROCESSES IS STILL ALIVE AND MAY BE WRITING TO MAIN",
        alive: [{ kind: "merge", pid: 5151, inspect: "ps -o pid,ppid,pgid,stat,lstart,command -g 5151" }],
        probeReadable: false,
        recordedGroups: [
          { source: "column", pgid: 999_999, bootAtSec: 1_776_000_000 },
          { source: "payload", pgid: 5151, bootAtSec: 1_776_000_000 },
        ],
      },
    } as unknown as Parameters<typeof describePromotions>[0]["promotions"][number]],
  });
  assert.match(contested, /recorded {4}column says pgid 999999 \(boot 1776000000\)/u);
  assert.match(contested, /recorded {4}payload says pgid 5151 \(boot 1776000000\)/u);
  assert.match(contested, /recorded {4}the sources above do not agree; none of them can be ruled out/u);
  // The dead number is reported as recorded, never as alive: an audit line is an observation.
  assert.doesNotMatch(contested, /alive {7}merge pid 999999/u);
  assert.match(contested, /--pgid 5151/u);

  // Argument handling, both directions: which release is called is decided by which numbers the
  // owner quoted, and a request with no phrase never reaches any of them.
  const calls: string[] = [];
  const port = {
    promotions: async () => [],
    abandonMergeProcessGroup: async (input: { pgid: number }) => {
      calls.push(`group:${input.pgid}`); return undefined;
    },
    abandonPromotionOwnerProcess: async (input: { pid: number }) => {
      calls.push(`owner:${input.pid}`); return undefined;
    },
    abandonPromotionEntirely: async (input: { pid: number; pgid: number }) => {
      calls.push(`both:${input.pid}:${input.pgid}`); return undefined;
    },
    acknowledgeUnattestedPromotions: async (input: { confirmation: string }) => {
      calls.push(`acknowledge:${input.confirmation}`);
      return {
        acknowledged: [{ id, taskId, storedState: "applied" }],
        skipped: [{ id: "99999999-9999-4999-8999-999999999999", taskId, reason: "row-integrity" }],
      };
    },
  } as unknown as PromotionReleasePort;
  const run = async (args: string[]): Promise<string> => await runCandidatePromotionsCommand({
    args, roomId: "demo", mainPath: "/workspace/project", registry: port, decidedBy: "local-cli",
  });

  assert.match(await run([]), /^No promotion records/u);
  assert.equal(calls.length, 0, "the read-only listing must not release anything");
  await assert.rejects(run(["unknown"]), /CANDIDATE_PROMOTIONS_UNKNOWN_SUBCOMMAND/u);
  await assert.rejects(run(["release"]), /CANDIDATE_PROMOTION_ID_REQUIRED/u);
  await assert.rejects(run(["release", id]), /CANDIDATE_PROMOTION_RELEASE_CONFIRMATION_REQUIRED/u);
  await assert.rejects(run(["release", id, "--confirm"]), /CONFIRM_VALUE_REQUIRED/u);
  await assert.rejects(
    run(["release", id, "--confirm", "P", "--pid", "0"]), /CANDIDATE_PROMOTION_PID_INVALID/u,
  );
  await assert.rejects(
    run(["release", id, "--confirm", "P", "--pgid", "notanumber"]), /CANDIDATE_PROMOTION_PID_INVALID/u,
  );
  assert.equal(calls.length, 0, "a refused invocation must not reach a release");

  await run(["release", id, "--confirm", "P", "--pgid", "77"]);
  await run(["release", id, "--confirm", "P", "--pid", "88"]);
  await run(["release", id, "--confirm", "P", "--pid", "88", "--pgid", "77"]);
  // The fourth form carries no number at all: it is the unreadable-row release, the one state with
  // nothing on the record to quote. It must reach the same action, with a pgid that is not a number.
  await run(["release", id, "--confirm", "P"]);
  assert.deepEqual(calls, ["group:77", "owner:88", "both:88:77", "group:NaN"]);

  // The fifth verb, and it is a verb rather than a fifth shape of `release`: it quotes no number
  // because the records it covers have already left `applying`, and it answers a different question
  // — not "stop waiting for this pid" but "I checked the project and nothing earlier is running".
  calls.length = 0;
  await assert.rejects(
    run(["acknowledge"]), /CANDIDATE_PROMOTION_ACKNOWLEDGE_CONFIRMATION_REQUIRED/u,
  );
  await assert.rejects(run(["acknowledge", "--confirm"]), /CONFIRM_VALUE_REQUIRED/u);
  assert.equal(calls.length, 0, "a refused invocation must not reach the acknowledgement");
  const acknowledged = await run(["acknowledge", "--confirm", "PHRASE"]);
  assert.deepEqual(calls, ["acknowledge:PHRASE"]);
  // The report has to say what was accepted AND that nothing was written, or an owner reasonably
  // reads a successful-looking command as the product having verified something.
  assert.match(acknowledged, /Acknowledged unattested promotion records .*: 1/u);
  assert.match(acknowledged, new RegExp(`${id}\\s+task ${taskId}\\s+claimed applied`, "u"));
  assert.match(acknowledged, /This wrote nothing/u);
  assert.match(acknowledged, /main was not touched/u);
  // The most important sentence this command prints. A review found that the CLI's own process ends
  // when this returns, so the proof it just produced can never reach the daemon that runs
  // promotions — a command that let the owner believe otherwise would be worse than no command.
  assert.match(acknowledged, /does NOT unblock a promotion/u);
  // A refused record is reported, with the reason and the verb that can actually clear it. Silence
  // would leave the owner believing the project was free when one record still holds it.
  assert.match(acknowledged, /SKIPPED 99999999-9999-4999-8999-999999999999.*row-integrity/u);
  assert.match(acknowledged, /still holding this project/u);
  assert.match(acknowledged, /cannot be trusted/u);
  assert.match(acknowledged, /release <id>/u);
  assert.match(acknowledged, /web daemon's own process/u);
  // And it must not be reachable as a release: the two are separate verbs on purpose.
  assert.doesNotMatch(acknowledged, /Released as/u);
});
