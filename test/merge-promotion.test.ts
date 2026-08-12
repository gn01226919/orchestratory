import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import {
  CandidateRegistry,
  MERGE_APPROVAL_CONFIRMATION,
  MERGE_APPROVAL_GRANT,
  MERGE_GROUP_ABANDON_CONFIRMATION,
  MERGE_LIVE_ABANDON_CONFIRMATION,
  MERGE_OWNER_ABANDON_CONFIRMATION,
  MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS,
  MERGE_PROMOTION_ABANDON_CONFIRMATION,
  MERGE_UNACCOUNTED_ABANDON_CONFIRMATION,
  MERGE_UNREADABLE_ABANDON_CONFIRMATION,
  MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
  type CandidateTask,
  type MergeApproval,
  type MergePromotion,
  type UnreadableMergePromotion,
} from "../src/core/candidate-registry.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";
import { GitBroker, readExecutedHooks, readLeaderSessionOpened } from "../src/core/git-broker.ts";
import { runCandidatePromotionsCommand } from "../src/main.ts";
import { helpText } from "../src/help.ts";

/*
 * Phase 5-5. Everything here drives a REAL git repository and a REAL merge into a real canonical
 * main; nothing is simulated. Each fixture builds its own throwaway repository under the OS temp
 * directory, and no test in this file touches any repository it did not create.
 *
 * The scenarios are the ones the Phase 5-5 bar (v2) names, and several of them exist because a
 * measurement contradicted an assumption:
 *  - a merge into a working tree whose `git status --porcelain` is completely EMPTY silently
 *    replaces the contents of an ignored file, exits 0, and reports a clean tree afterwards;
 *  - `kill -9` during a hook leaves HEAD unmoved and no MERGE_HEAD, while the index and working
 *    tree have been fully rewritten — indistinguishable from work the owner staged themselves.
 */

const execFileAsync = promisify(execFile);
const key = (): string => randomUUID();
const author = ["-c", "user.name=orchestratory-test", "-c", "user.email=test@localhost"];

interface Fixture {
  root: string;
  source: string;
  data: string;
  path: string;
  registry: CandidateRegistry;
  task: CandidateTask;
}

async function commit(workspace: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(join(workspace, file), contents, "utf8");
  await execFileAsync("git", ["add", "--", file], { cwd: workspace });
  await execFileAsync("git", [...author, "commit", "-m", message], { cwd: workspace });
}

/** A completed, clean, recoverable candidate over a real repository. */
async function fixture(t: TestContext, options: {
  ignore?: string;
  /** Extra files committed into the INITIAL commit, so both sides share them from the merge base. */
  initial?: Record<string, string>;
  /**
   * Runs after `git init` and BEFORE the initial commit, so anything it creates is tracked content
   * both sides inherit from the merge base — which is the only way to build the amendment (X-1)
   * scenario, where the hook the merge runs is a file the merge itself writes.
   */
  beforeInitialCommit?: (source: string) => Promise<void>;
  /** Runs after the candidate exists and BEFORE it is completed, so its head stays the one bound. */
  beforeComplete?: (context: { source: string; candidatePath: string }) => Promise<void>;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-promotion-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, ".gitignore"), options.ignore ?? "*.cache\n", "utf8");
  await writeFile(join(source, "README.md"), "committed main\n", "utf8");
  for (const [name, contents] of Object.entries(options.initial ?? {})) {
    await writeFile(join(source, name), contents, "utf8");
  }
  await options.beforeInitialCommit?.(source);
  await execFileAsync("git", ["add", "-A"], { cwd: source });
  await execFileAsync("git", [...author, "commit", "-m", "initial"], { cwd: source });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "promotion",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
  await options.beforeComplete?.({ source, candidatePath: task.candidatePath });
  await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready for owner review",
  });
  return { root, source, data, path: registry.path, registry, task };
}

async function raise(f: Fixture): Promise<MergeApproval> {
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.approvable, true, `not approvable: ${preview.blockers.join(",")}`);
  return await f.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
    mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
}

async function grant(f: Fixture, approval: MergeApproval): Promise<string> {
  const granted = await f.registry.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: f.source,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  });
  return granted.approvalToken;
}

async function promote(f: Fixture, approval: MergeApproval, token: string): ReturnType<CandidateRegistry["promoteMainMerge"]> {
  return await f.registry.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
}

/** Installs an executable hook in the shared common `.git/hooks`, which is where git looks. */
async function hook(f: Fixture, name: string, script: string): Promise<string> {
  const path = join(f.source, ".git", "hooks", name);
  await writeFile(path, script, { encoding: "utf8", mode: 0o700 });
  return path;
}

async function head(workspace: string): Promise<string> {
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
}

async function status(workspace: string): Promise<string> {
  return (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: workspace })).stdout;
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true).catch(() => false);
}

/**
 * Whether ONE process still exists, asked the same way `probe()` asks about a group leader.
 *
 * Separate from `groupAlive` because `kill(-pid, 0)` answers `ESRCH` for a pid that is not a group
 * leader, and a hook that backgrounds a child hands this product exactly such a number.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Whether a whole process group still exists, asked the same way the product asks. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * What `ps -g <pgid>` shows, which is the exact read-only command the record hands the owner.
 *
 * `groupAlive()` asks the kernel with `kill(pgid, 0)`; this asks the same question the way a human
 * would, and the difference matters for a precondition ([[PITFALLS]] #106): a test that claims "the
 * merge is provably still writing" should be able to show the merge.
 */
async function psGroup(pgid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "pid,ppid,pgid,stat,command", "-g", String(pgid)]);
  return stdout;
}

async function waitForGroupExit(pgid: number, attempts = 600): Promise<void> {
  for (let attempt = 0; attempt < attempts && groupAlive(pgid); attempt += 1) await delay(100);
}

/**
 * Content and mode of every file under a directory, `.git` included, as one digest.
 *
 * The whole point of crash reconciliation is that it only READS. A product claim that broad cannot
 * be guarded by checking a few chosen paths — a `merge --abort`, a `reset`, a removed lock file or a
 * rewritten `.git/config` all land somewhere a spot check was not looking. So the assertion is the
 * strongest one available: nothing anywhere under the repository moved by a single byte.
 */
async function treeDigest(root: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const info = await lstat(path);
      const relative = path.slice(root.length);
      if (info.isDirectory()) {
        entries.push(`d ${relative}`);
        await walk(path);
      } else if (info.isSymbolicLink()) entries.push(`l ${relative} ${await readlink(path)}`);
      else {
        entries.push(`f ${relative} ${info.size} ${(info.mode & 0o777).toString(8)} ${
          createHash("sha256").update(await readFile(path)).digest("hex")}`);
      }
    }
  };
  await walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/**
 * Starts a promotion in a SEPARATE OS process and returns once its merge is provably under way.
 *
 * A reconcile function called inside the process that crashed is not a restart; every crash test
 * here kills a real child and rebuilds the answer in a new `CandidateRegistry` from durable state.
 */
async function promoteInChild(
  f: Fixture, approval: MergeApproval, token: string,
): Promise<ReturnType<typeof spawn>> {
  const module = fileURLToPath(new URL("../src/core/candidate-registry.ts", import.meta.url));
  const script = join(f.root, `promote-child-${randomUUID()}.mjs`);
  await writeFile(script, [
    "const [data, source, approvalId, token, taskId] = process.argv.slice(2);",
    `const { CandidateRegistry } = await import(${JSON.stringify(module)});`,
    "const registry = new CandidateRegistry(data);",
    "process.stdout.write('ready\\n');",
    "await registry.promoteMainMerge({",
    "  approvalId, token, action: 'merge-candidate-into-main', taskId, roomId: 'demo', mainPath: source,",
    "});",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return spawn(process.execPath, [script, f.data, f.source, approval.id, token, f.task.taskId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function unreadable(
  entry: Awaited<ReturnType<CandidateRegistry["promotions"]>>[number] | undefined,
): UnreadableMergePromotion {
  assert.ok(entry !== undefined && entry.state === "unreadable", `expected an unreadable row: ${JSON.stringify(entry)}`);
  return entry;
}

function readable(entry: Awaited<ReturnType<CandidateRegistry["promotions"]>>[number] | undefined): MergePromotion {
  assert.ok(entry && !("unreadable" in entry), "the promotion row could not be read");
  return entry as MergePromotion;
}

/**
 * Ends the wait on a crashed promotion the way amendment (T) leaves as the only route.
 *
 * Before the eleventh round a crashed promotion converged on its own as soon as the numbers in its
 * own row probed gone. Those numbers come from a row an owner-uid process can write under an
 * unkeyed hash, and a repository hook was measured writing them, so "every number probes gone" is a
 * hint now and the record waits for a person. What the person does is exactly what the record
 * prints: quote the number it reports, or — when it reports none — the phrase that says so.
 *
 * It is a helper rather than four copies because the tests that use it are about what happens
 * AFTER, and the reviewer's own rule is that a step nobody can see is a step nobody checked: every
 * caller keeps its own assertions about the state it was in before this ran.
 */
/**
 * Every declaration a record still waiting after amendment (V-3) needs, in the order it names them.
 *
 * A promotion that ran a hook is not settled by its leader's exit, so `promoteMainMerge` returns
 * with the record still `applying` — and while the orchestrator that ran it is alive, that process
 * is one of the things the record names. Nothing here decides what happened to main: each step only
 * stops the record waiting on one named number, and the re-observation after it reads the
 * repository. It refuses to loop forever rather than assuming two steps are always enough.
 */
async function endEveryWait(
  registry: CandidateRegistry, mainPath: string, taskId: string,
): Promise<MergePromotion> {
  let latest: MergePromotion | undefined;
  for (let step = 0; step < 4; step += 1) {
    const listed = (await registry.promotions({ roomId: "demo", mainPath }))
      .find((entry) => !("unreadable" in entry) && entry.taskId === taskId);
    latest = readable(listed);
    const pending = latest.pending;
    if (pending === undefined) return latest;
    assert.ok(pending.release !== undefined, `${pending.code} names no way out ([[PITFALLS]] bar 11)`);
    assert.ok(!/reset --hard/u.test(latest.observation.recovery ?? ""),
      `a destructive command was offered while the record was still waiting: ${latest.observation.recovery}`);
    if (pending.code === "OWNER_PROCESS_STILL_RUNNING") {
      await registry.abandonPromotionOwnerProcess({
        promotionId: latest.id, roomId: "demo", mainPath, pid: pending.pid,
        confirmation: pending.release, decidedBy: "local-cli",
      });
      continue;
    }
    await registry.abandonMergeProcessGroup({
      promotionId: latest.id, roomId: "demo", mainPath, pgid: pending.pid ?? 0,
      confirmation: pending.release, decidedBy: "local-cli",
    });
  }
  assert.ok(latest !== undefined && latest.pending === undefined,
    `the record was still waiting after four declarations: ${JSON.stringify(latest?.pending)}`);
  return latest;
}

async function ownerEndsTheWait(registry: CandidateRegistry, f: Fixture): Promise<MergePromotion> {
  const listed = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pending = listed.pending;
  assert.ok(pending !== undefined, "the record was not waiting on anything");
  assert.ok(pending.release !== undefined, `${pending.code} names no way out ([[PITFALLS]] bar 11)`);
  const released = await registry.abandonMergeProcessGroup({
    promotionId: listed.id, roomId: "demo", mainPath: f.source,
    pgid: pending.pid ?? 0, confirmation: pending.release, decidedBy: "local-cli",
  });
  assert.ok(!("unreadable" in released));
  return released;
}

// ---------------------------------------------------------------------------------------------
// Bar item 3: hooks
// ---------------------------------------------------------------------------------------------

test("a real promotion runs the repository's hooks and a preview never does", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "hooks-that-ran.txt");
  for (const name of ["pre-merge-commit", "commit-msg", "post-merge"]) {
    await hook(f, name, `#!/bin/sh\nprintf '%s\\n' "${name}" >> ${JSON.stringify(marker)}\nexit 0\n`);
  }

  // The preview is computed AFTER the hooks are installed, and it must not run a single one of them.
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(await exists(marker), false, "the preview executed a repository hook");
  // And the owner is shown exactly what would run, by name and content hash — not a general warning.
  assert.deepEqual(
    preview.hooks.hooks.map((entry) => entry.name).sort(),
    ["commit-msg", "post-merge", "pre-merge-commit"],
  );
  assert.ok(preview.hooks.hooks.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sha256)));
  assert.match(preview.prompt, /會以你的身分、無沙箱執行下列 repo hook/u);
  for (const entry of preview.hooks.hooks) assert.ok(preview.prompt.includes(entry.name));

  const approval = await raise(f);
  const token = await grant(f, approval);
  const result = await promote(f, approval, token);
  assert.equal(result.mainMutated, true);
  assert.equal(result.promotion.state, "applied");
  // Measured, not asserted from a flag: the hooks left evidence on disk.
  const ran = (await readFile(marker, "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(ran.sort(), ["commit-msg", "post-merge", "pre-merge-commit"]);
});

for (const hookName of ["pre-merge-commit", "post-merge"]) {
  test(`a ${hookName} hook that exits non-zero leaves main exactly as it was, and a retry succeeds`, async (t) => {
    const f = await fixture(t);
    const gate = join(f.root, "hook-should-fail");
    await writeFile(gate, "yes\n", "utf8");
    await hook(f, hookName, `#!/bin/sh\n[ -f ${JSON.stringify(gate)} ] && exit 1\nexit 0\n`);

    const approval = await raise(f);
    const token = await grant(f, approval);
    const before = { head: await head(f.source), status: await status(f.source) };
    const result = await promote(f, approval, token);

    if (hookName === "pre-merge-commit") {
      // git stops before creating the commit, leaving the merge in progress; the promotion undoes
      // that IN THIS PROCESS (not after a crash) and proves the undo by comparing fingerprints.
      //
      // ⛔ This used to assert a terminal `rolled-back` here. Amendment (V-3): a hook ran, so the
      // leader's exit does not settle the record — what main looks like is still read first-hand and
      // still asserted below, and what changed is that the record says, by name, that it is waiting
      // for the owner instead of concluding for them. The retry at the end of this test is what
      // proves bar item 4 still holds; it now costs the owner the declarations the record prints.
      assert.equal(result.mainMutated, false);
      assert.equal(result.promotion.state, "applying");
      assert.equal(result.promotion.observation.mergeConclusion,
        "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
      assert.deepEqual(result.promotion.observation.differences, []);
      assert.equal(result.promotion.observation.worktreeRestored, true);
      assert.equal(result.promotion.observation.reflogPreserved, true);
      assert.equal(await head(f.source), before.head);
      assert.equal(await status(f.source), before.status);
      assert.equal(await exists(join(f.source, "candidate.txt")), false);
    } else {
      // `post-merge` runs AFTER the merge commit exists. git reports the failure but the merge has
      // already happened, and the record has to say so rather than call a completed merge a failure.
      assert.equal(result.promotion.state, "applied");
      assert.equal(result.mainMutated, true);
      assert.equal(result.promotion.observation.authorizedMergeCommit, true);
    }
    // The candidate and its recovery point are untouched either way.
    assert.equal(
      (await execFileAsync("git", ["rev-parse", "--verify", `${approval.binding.recoveryRef}^{commit}`],
        { cwd: f.source })).stdout.trim(),
      approval.binding.candidateHead,
    );

    if (hookName === "post-merge") return;
    // Recovery is only "recovered" if the owner can still get their merge. The external condition is
    // restored — nothing inside `.git` is edited by this test — and the whole flow runs again.
    // Amendment (V-3) adds one step to that: the owner ends the wait the record printed, which is
    // the substitute for the product deciding on its own that nothing survived the hook.
    const cleared = await endEveryWait(f.registry, f.source, f.task.taskId);
    assert.equal(cleared.state, "rolled-back");
    assert.deepEqual(cleared.observation.differences, []);
    await rm(gate);
    const second = await raise(f);
    const secondToken = await grant(f, second);
    const retried = await promote(f, second, secondToken);
    assert.equal(retried.mainMutated, true);
    assert.equal(retried.promotion.state, "applied");
    assert.equal(await exists(join(f.source, "candidate.txt")), true);
  });
}

test("a hook that hangs is stopped by a deadline and leaves no surviving process", async (t) => {
  const f = await fixture(t);
  const pidFile = join(f.root, "hook.pid");
  await hook(
    f, "pre-merge-commit",
    `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nsleep 600\n`,
  );
  const approval = await raise(f);
  const token = await grant(f, approval);
  const before = await head(f.source);
  // A short deadline for the test; the shipped one is MERGE_TIMEOUT_MS. What is being proved is that
  // there IS one and that it terminates the whole process tree, not the specific number.
  const result = await f.registry.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source, mergeTimeoutMs: 3_000,
  });
  assert.equal(result.promotion.observation.attempt?.timedOut, true);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), before);
  // The hook's own process is gone, not merely the git process that started it.
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await delay(200);
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
    "the hung hook process outlived the promotion that started it",
  );
});

// ---------------------------------------------------------------------------------------------
// Bar item 3: ignored files whose contents a merge destroys silently
// ---------------------------------------------------------------------------------------------

test("an ignored file the merge would overwrite is named before approval, and blocks it", async (t) => {
  // The candidate tracks a file at a path main ignores. This is the shape that was MEASURED to
  // destroy data: git overwrites the ignored file, exits 0, and still calls the tree clean.
  const f = await fixture(t, {
    ignore: "secrets.env\n",
    beforeComplete: async ({ candidatePath }) => {
      await writeFile(join(candidatePath, "secrets.env"), "FROM_CANDIDATE=1\n", "utf8");
      await execFileAsync("git", ["add", "-f", "--", "secrets.env"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "track secrets.env"], { cwd: candidatePath });
    },
  });

  // main holds a local secret at that exact path, and main is completely clean by git's own report.
  await writeFile(join(f.source, "secrets.env"), "OWNER_LOCAL_SECRET=1\n", "utf8");
  assert.equal(await status(f.source), "", "the fixture must present a clean main");

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  // Named, not summarised: the owner is told WHICH file, and cannot approve.
  assert.equal(preview.approvable, false);
  assert.ok(preview.blockers.includes("IGNORED_FILES_WOULD_BE_OVERWRITTEN"), preview.blockers.join(","));
  assert.deepEqual(preview.overwrites.ignored, ["secrets.env"]);
  assert.match(preview.prompt, /secrets\.env/u);
  await assert.rejects(
    f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
      mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
    }),
    /MAIN_MERGE_PROMOTION_REFUSED:.*IGNORED_FILES_WOULD_BE_OVERWRITTEN/u,
  );
  // Refused before anything was asked, so the file still holds the owner's bytes.
  assert.equal(await readFile(join(f.source, "secrets.env"), "utf8"), "OWNER_LOCAL_SECRET=1\n");
});

// ---------------------------------------------------------------------------------------------
// Bar item 3: what "clean" means
// ---------------------------------------------------------------------------------------------

test("main is refused for every condition that makes a working tree unable to receive a merge", async (t) => {
  for (const condition of [
    {
      label: "a tracked modification",
      code: "MAIN_STATUS_NOT_EMPTY",
      apply: async (f: Fixture) => await writeFile(join(f.source, "README.md"), "edited\n", "utf8"),
    },
    {
      label: "an untracked file",
      code: "MAIN_STATUS_NOT_EMPTY",
      apply: async (f: Fixture) => await writeFile(join(f.source, "scratch.txt"), "x\n", "utf8"),
    },
    {
      label: "a skip-worktree entry that git status hides completely",
      code: "MAIN_INDEX_HAS_SKIPPED_ENTRIES",
      apply: async (f: Fixture) => {
        await execFileAsync("git", ["update-index", "--skip-worktree", "README.md"], { cwd: f.source });
      },
    },
    // Every spelling git itself accepts as true, because `=== "true"` is not how git reads a boolean
    // and a gate that only recognises one of these is a gate the next repository walks past.
    // Measured: `git config --type=bool` returns "true" for all four.
    ...["true", "1", "yes", "on"].map((value) => ({
      label: `sparse checkout written as ${value}`,
      code: "MAIN_SPARSE_CHECKOUT_ENABLED",
      apply: async (f: Fixture) => {
        await execFileAsync("git", ["config", "core.sparseCheckout", value], { cwd: f.source });
      },
    })),
    {
      label: "a merge already in progress",
      code: "MAIN_MERGE_HEAD_PRESENT",
      apply: async (f: Fixture) => {
        await writeFile(join(f.source, ".git", "MERGE_HEAD"), `${await head(f.source)}\n`, "utf8");
      },
    },
    {
      label: "a held index lock",
      code: "MAIN_INDEX_LOCKED",
      apply: async (f: Fixture) => await writeFile(join(f.source, ".git", "index.lock"), "", "utf8"),
    },
    // The rest of the in-progress markers. `REBASE_HEAD` is not decoration: measured on this
    // machine, an interactive rebase stopped at `edit` leaves `git status --porcelain` completely
    // EMPTY while a real `git merge` in that state exits 0 and merges anyway. Every one of these was
    // listed in the gate and none of them had a test watching it.
    ...([
      ["REBASE_HEAD", "MAIN_REBASE_IN_PROGRESS"],
      ["CHERRY_PICK_HEAD", "MAIN_CHERRY_PICK_IN_PROGRESS"],
      ["REVERT_HEAD", "MAIN_REVERT_IN_PROGRESS"],
      ["AUTO_MERGE", "MAIN_AUTO_MERGE_PRESENT"],
      ["MERGE_MSG", "MAIN_MERGE_MSG_PRESENT"],
    ] as const).map(([name, code]) => ({
      label: `a leftover ${name} in the git directory`,
      code,
      apply: async (f: Fixture) => {
        await writeFile(join(f.source, ".git", name), `${await head(f.source)}\n`, "utf8");
      },
    })),
    {
      label: "submodules declared in .gitmodules",
      code: "MAIN_HAS_SUBMODULES",
      apply: async (f: Fixture) => await writeFile(join(f.source, ".gitmodules"), "[submodule \"x\"]\n", "utf8"),
    },
    {
      // The fact, rather than the description of it. `.gitmodules` is tracked content a repository
      // may simply not have; the gitlink in the index is what makes a submodule a submodule, and a
      // committed one leaves `git status --porcelain` completely empty.
      label: "a 160000 gitlink in the index with no .gitmodules at all",
      code: "MAIN_HAS_SUBMODULES",
      apply: async (f: Fixture) => {
        const inner = join(f.source, "vendor", "mod");
        await mkdir(inner, { recursive: true });
        await execFileAsync("git", ["init", "-b", "main"], { cwd: inner });
        await writeFile(join(inner, "a.txt"), "a\n", "utf8");
        await execFileAsync("git", ["add", "-A"], { cwd: inner });
        await execFileAsync("git", [...author, "commit", "-m", "inner"], { cwd: inner });
        await execFileAsync("git", ["update-index", "--add", "--cacheinfo",
          `160000,${await head(inner)},vendor/mod`], { cwd: f.source });
        await execFileAsync("git", [...author, "commit", "-m", "gitlink"], { cwd: f.source });
        assert.equal(await status(f.source), "", "the gitlink was supposed to leave status empty");
      },
    },
    {
      label: "an LFS or other content filter",
      code: "MAIN_HAS_CONTENT_FILTERS",
      apply: async (f: Fixture) => {
        await execFileAsync("git", ["config", "filter.lfs.clean", "git-lfs clean -- %f"], { cwd: f.source });
      },
    },
    // git consults an attributes file in every directory it descends into, plus the git directory's
    // own `info/attributes` and `core.attributesFile`. Reading only the root one reported each of
    // these as a repository with no filters at all.
    {
      label: "a filter declared in the root .gitattributes",
      code: "MAIN_ATTRIBUTES_DECLARE_FILTER",
      apply: async (f: Fixture) => {
        await writeFile(join(f.source, ".gitattributes"), "*.bin filter=lfs -text\n", "utf8");
        await execFileAsync("git", ["add", "-A"], { cwd: f.source });
        await execFileAsync("git", [...author, "commit", "-m", "attrs"], { cwd: f.source });
      },
    },
    {
      label: "a filter declared in a NESTED .gitattributes",
      code: "MAIN_ATTRIBUTES_DECLARE_FILTER",
      apply: async (f: Fixture) => {
        await mkdir(join(f.source, "sub", "deep"), { recursive: true });
        await writeFile(join(f.source, "sub", "deep", ".gitattributes"), "*.bin filter=lfs -text\n", "utf8");
        await execFileAsync("git", ["add", "-A"], { cwd: f.source });
        await execFileAsync("git", [...author, "commit", "-m", "attrs"], { cwd: f.source });
      },
    },
    {
      label: "a filter declared in an IGNORED .gitattributes",
      code: "MAIN_ATTRIBUTES_DECLARE_FILTER",
      apply: async (f: Fixture) => {
        await writeFile(join(f.source, ".gitignore"), "*.cache\nvendorattrs/\n", "utf8");
        await execFileAsync("git", ["add", "-A"], { cwd: f.source });
        await execFileAsync("git", [...author, "commit", "-m", "ignore"], { cwd: f.source });
        await mkdir(join(f.source, "vendorattrs"), { recursive: true });
        await writeFile(join(f.source, "vendorattrs", ".gitattributes"), "*.bin filter=lfs -text\n", "utf8");
        assert.equal(await status(f.source), "", "the ignored attributes file was supposed to be invisible");
      },
    },
    {
      label: "a filter declared in .git/info/attributes",
      code: "MAIN_ATTRIBUTES_DECLARE_FILTER",
      apply: async (f: Fixture) => {
        await mkdir(join(f.source, ".git", "info"), { recursive: true });
        await writeFile(join(f.source, ".git", "info", "attributes"), "*.bin filter=lfs -text\n", "utf8");
      },
    },
    {
      label: "a filter declared in a core.attributesFile outside the repository",
      code: "MAIN_ATTRIBUTES_DECLARE_FILTER",
      apply: async (f: Fixture) => {
        const path = join(f.root, "external-attributes");
        await writeFile(path, "*.bin filter=lfs -text\n", "utf8");
        await execFileAsync("git", ["config", "core.attributesFile", path], { cwd: f.source });
      },
    },
  ]) {
    await t.test(condition.label, async (child) => {
      const f = await fixture(child);
      await condition.apply(f);
      const preview = await f.registry.previewMainMerge({
        taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
      });
      assert.equal(preview.approvable, false, condition.label);
      assert.ok(
        preview.blockers.includes(condition.code),
        `${condition.label}: expected ${condition.code}, got ${preview.blockers.join(",") || "none"}`,
      );
      // And the owner is never asked about a snapshot that cannot be promoted.
      await assert.rejects(
        f.registry.requestMainMerge({
          actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
          mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
        }),
        /MAIN_MERGE_PROMOTION_REFUSED/u,
      );
    });
  }
});

/*
 * The gate that runs at the LAST possible moment, immediately before the approval is spent.
 *
 * A mutation test is why this exists: removing the live-main gate from the promotion path left every
 * other test in this file green, because they are all refused earlier, at preview time. The window
 * between "the owner approved" and "git starts writing" is exactly where an index lock or a merge
 * left behind by another process appears, and neither of those is a bound value the drift check
 * would notice — `.git/index.lock` is not in any tree, any index or any fingerprint.
 */
test("a lock or a stray merge that appears after approval refuses the promotion without spending it", async (t) => {
  for (const condition of [
    { label: "an index lock held by another process", file: "index.lock", contents: "", code: "MAIN_INDEX_LOCKED" },
    { label: "a merge another process left in progress", file: "MERGE_HEAD", contents: "", code: "MAIN_MERGE_HEAD_PRESENT" },
  ]) {
    await t.test(condition.label, async (child) => {
      const f = await fixture(child);
      const approval = await raise(f);
      const token = await grant(f, approval);
      const before = await head(f.source);
      const path = join(f.source, ".git", condition.file);
      await writeFile(path, condition.contents || `${before}\n`, "utf8");

      await assert.rejects(
        promote(f, approval, token),
        (error: Error) => {
          assert.equal(error.name, "MergePromotionRefusedError");
          assert.match(error.message, new RegExp(condition.code, "u"));
          return true;
        },
      );
      // Refused, not consumed: the owner's decision survives, main is untouched, and no promotion
      // was ever started. Refusing before spending is what makes "clear the lock and retry" possible.
      assert.equal(await head(f.source), before);
      assert.equal(await status(f.source), "");
      const promotions = await f.registry.promotions({ roomId: "demo", mainPath: f.source });
      assert.deepEqual(promotions, []);

      await rm(path);
      const result = await promote(f, approval, token);
      assert.equal(result.mainMutated, true);
      assert.equal(result.promotion.state, "applied");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Bar item 4: real failures, and recovery that actually recovers
// ---------------------------------------------------------------------------------------------

test("a read-only git directory refuses the promotion and the owner can retry once it is writable", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const before = await head(f.source);
  const dotGit = join(f.source, ".git");
  await chmod(dotGit, 0o500);
  try {
    // A promotion does not throw on a failed merge — it records what it OBSERVED. What must not
    // happen is a claim that anything the owner approved moved: an unwritable repository is a fact
    // about this attempt, not about the snapshot.
    const refused = await promote(f, approval, token).catch((error: Error) => {
      assert.doesNotMatch(error.message, /BINDING_CHANGED/u);
      return undefined;
    });
    if (refused) {
      assert.equal(refused.mainMutated, false);
      assert.notEqual(refused.promotion.state, "applied");
    }
  } finally {
    await chmod(dotGit, 0o755);
  }
  assert.equal(await head(f.source), before);
  assert.equal(await status(f.source), "");

  // Environment restored — only the permission bit, nothing inside `.git` edited — and the owner
  // gets their merge.
  const second = await raise(f);
  const retried = await promote(f, second, await grant(f, second));
  assert.equal(retried.mainMutated, true);
  assert.equal(retried.promotion.state, "applied");
});

test("a merge driver that fails during the real merge rolls main back and a retry succeeds", async (t) => {
  let gate = "";
  const f = await fixture(t, {
    initial: { ".gitattributes": "*.conf merge=boom\n", "shared.conf": "base\n" },
    beforeComplete: async ({ source, candidatePath }) => {
      const root = join(source, "..");
      const driver = join(root, "driver.sh");
      gate = join(root, "driver-should-fail");
      // The simulation runs in the candidate's LINKED worktree, where `.git` is a file; the real
      // merge runs in main, where `.git` is a directory. So this driver simulates cleanly and fails
      // only where it actually matters, and only while a marker outside the repository exists —
      // which is what makes "restore the environment and retry" a real assertion rather than a wish.
      await writeFile(gate, "yes\n", "utf8");
      await writeFile(
        driver,
        `#!/bin/sh\n[ -f "$PWD/.git" ] && exit 0\n[ -f ${JSON.stringify(gate)} ] && exit 1\nexit 0\n`,
        { encoding: "utf8", mode: 0o700 },
      );
      await execFileAsync("git", ["config", "merge.boom.name", "test driver"], { cwd: source });
      await execFileAsync("git", ["config", "merge.boom.driver", `${driver} %A %O %B %L %P`], { cwd: source });
      // Both sides must edit the same file, from the same merge base, for a driver to run at all.
      await commit(source, "shared.conf", "from main\n", "main edit");
      await commit(candidatePath, "shared.conf", "from candidate\n", "candidate edit");
    },
  });

  const approval = await raise(f);
  const token = await grant(f, approval);
  const before = { head: await head(f.source), status: await status(f.source) };
  const result = await promote(f, approval, token);
  assert.equal(result.mainMutated, false);
  // Amendment (V-3): a merge driver is repository code run as the owner with no sandbox — the same
  // trust boundary as a hook, and THREAT_MODEL F26 has said so through six corrections — so the
  // leader's exit does not settle this either. What main looks like is unchanged and still asserted.
  assert.equal(result.promotion.state, "applying");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.deepEqual(result.promotion.observation.differences, []);
  assert.equal(await head(f.source), before.head);
  assert.equal(await status(f.source), before.status);
  assert.equal(await readFile(join(f.source, "shared.conf"), "utf8"), "from main\n");

  const cleared = await endEveryWait(f.registry, f.source, f.task.taskId);
  assert.equal(cleared.state, "rolled-back");
  await rm(gate);
  const second = await raise(f);
  const retried = await promote(f, second, await grant(f, second));
  assert.equal(retried.mainMutated, true);
});

// ---------------------------------------------------------------------------------------------
// Bar item 6: one candidate, one application
// ---------------------------------------------------------------------------------------------

test("a candidate that has been merged is terminal and cannot be promoted a second time", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const result = await promote(f, approval, await grant(f, approval));
  assert.equal(result.mainMutated, true);
  assert.equal(f.registry.get(f.task.taskId)?.status, "merged");

  // Every door is closed by name, and closed BEFORE anything could be approved. The scenario this
  // exists for: the owner reverts the merge, and a second promotion silently re-applies exactly the
  // change they deliberately took back.
  await execFileAsync("git", [...author, "revert", "--no-edit", "-m", "1", "HEAD"], { cwd: f.source });
  // One at a time, deliberately. Building both promises up front leaves the second one rejected with
  // no handler attached for a turn of the loop, which node reports as an unhandled rejection — an
  // intermittent failure in a test whose subject has nothing to do with scheduling.
  await assert.rejects(
    f.registry.previewMainMerge({ taskId: f.task.taskId, roomId: "demo", mainPath: f.source }),
    /MAIN_MERGE_CANDIDATE_ALREADY_MERGED/u,
  );
  await assert.rejects(
    f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
      mainPath: f.source, completionId: approval.binding.completionId,
      previewDigest: approval.binding.previewDigest,
    }),
    /MAIN_MERGE_CANDIDATE_ALREADY_MERGED/u,
  );
});

// ---------------------------------------------------------------------------------------------
// Bar items 1 and 2: a real kill, and an answer rebuilt in a NEW process from durable state alone
// ---------------------------------------------------------------------------------------------

test("a promotion killed during a hook is reported by a new process as needing a human, by name", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  // The hook signals that the merge has reached the point where the index and working tree are
  // already rewritten, then stalls so the kill lands exactly there. This is the interruption that
  // leaves HEAD unmoved and NO MERGE_HEAD, which `git merge --abort` cannot undo and which is
  // bit-for-bit indistinguishable from work the owner staged themselves.
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChild(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  // Wait for the merge to actually be in progress, observed rather than timed.
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  assert.equal(await exists(started), true, "the hook never ran, so nothing was interrupted");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  // A NEW process, opening the same durable state, with no memory of the attempt.
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());

  // Killing the orchestrator does NOT kill the merge: the subprocess is detached, so `git merge` and
  // the hook it is running are still alive right now. While that is true there is no answer to give
  // — main is still being written — and the record must say the write is in flight rather than
  // freeze a verdict over a moving repository.
  const inFlight = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(inFlight.state, "applying");
  const pgid = inFlight.observation.mergePgid;
  assert.ok(typeof pgid === "number" && pgid > 1, "the merge process group was never recorded");
  assert.equal(groupAlive(pgid), true, "the orphaned merge was expected to still be running");

  // Now the machine really is gone: the whole orphaned group dies. THIS is the state the crash
  // report is about, and it is reached without this product running one writing Git command.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);

  // Amendment (T). The group this record names is gone, and that is where the eleventh round drew
  // the line: the number came out of a row the merge's own hooks can rewrite under an unkeyed hash,
  // so a probe of it cannot be this product's evidence that the write to main is over. The record
  // still names the number, still says what to look at, and still has a one-step exit — what it no
  // longer does is take that step by itself.
  const waiting = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(waiting.state, "applying");
  assert.equal(waiting.pending?.code, "MERGE_END_NOT_OBSERVED");
  assert.equal(waiting.pending?.pid, pgid, "a state that names no number is not actionable");
  assert.equal(waiting.pending?.release, MERGE_GROUP_ABANDON_CONFIRMATION);
  assert.equal(waiting.observation.recovery, undefined,
    "a record that cannot say what happened offered a command anyway");
  // The differences are named even before the owner acts: observing is read-only, and it is
  // concluding that needs evidence.
  assert.ok((waiting.observation.differences ?? []).length > 0, "no differences were named");

  await ownerEndsTheWait(reopened, f);
  const promotions = await reopened.promotions({ roomId: "demo", mainPath: f.source });
  assert.equal(promotions.length, 1);
  const promotion = promotions[0];
  assert.ok(promotion && !("unreadable" in promotion));
  if (!promotion || "unreadable" in promotion) return;
  // One of the three answers, and the only honest one here.
  assert.equal(promotion.state, "needs-manual-review");
  // Naming what moved is the requirement: "needs a human" without saying where is not an answer.
  assert.ok((promotion.observation.differences ?? []).length > 0, "no differences were named");
  assert.ok(
    (promotion.observation.differences ?? []).some((name) => name === "index" || name === "trackedWorkingTree"),
    `expected the rewritten index/worktree to be named, got ${JSON.stringify(promotion.observation.differences)}`,
  );
  // A copy-and-paste command — and amendment (T-1) is what decides WHICH one. This process did not
  // watch the merge leader close; the orchestrator that did is gone, which is the whole reason this
  // record exists. So what the owner is handed is a read-only look at the number they just quoted,
  // not `git reset --hard`, whose failure mode is [[PITFALLS]] #94: it does not undo a write it
  // races, and it deletes the ignored files a merge overwrote rather than restoring them.
  assert.equal(promotion.observation.recoveryKind, "inspect-disowned-merge");
  assert.equal(promotion.observation.recovery, `ps -o pid,ppid,pgid,stat,lstart,command -g ${pgid}`);
  assert.ok(!(promotion.observation.recovery ?? "").includes("reset --hard"));
  assert.equal(promotion.mainHeadBefore, beforeHead);
  assert.equal(await realpath(f.source), promotion.mainPath);
  // Nothing was retried and nothing was rolled back: HEAD is exactly where it was, and the half
  // applied state is still on disk for the owner to look at rather than silently discarded.
  assert.equal(await head(f.source), beforeHead);
  // The candidate and its recovery point survived untouched.
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "--verify", `${approval.binding.recoveryRef}^{commit}`],
      { cwd: f.source })).stdout.trim(),
    approval.binding.candidateHead,
  );
  // And nothing may act on this task until a human resolves it.
  await assert.rejects(
    reopened.previewMainMerge({ taskId: f.task.taskId, roomId: "demo", mainPath: f.source }),
    /MAIN_MERGE_PROMOTION_UNRESOLVED|MAIN_MERGE_CANDIDATE/u,
  ).catch(async () => {
    await assert.rejects(
      reopened.requestMainMerge({
        actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
        mainPath: f.source, completionId: approval.binding.completionId,
        previewDigest: approval.binding.previewDigest,
      }),
      /MAIN_MERGE_PROMOTION_UNRESOLVED/u,
    );
  });
});

/*
 * The merge subprocess is spawned `detached`, so `kill -9` on the orchestrator does not stop it. It
 * keeps running and finishes writing canonical main. Measured: HEAD moved to a real authorized merge
 * commit AFTER the crash, main's `git status` came back completely clean, and the durable record
 * still said "undetermined" with a `reset --hard <pre-promotion head>` on offer — a command that,
 * followed, would have silently thrown away a merge that succeeded.
 */
test("a merge orphaned by a crash that finishes is later observed as applied, not frozen as unknown", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  // Long enough that the kill lands inside it, short enough that the merge then completes on its own.
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 6\nexit 0\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChild(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  assert.equal(await exists(started), true, "the hook never ran, so nothing was interrupted");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const inFlight = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // While the orphan is still writing there is nothing to conclude, and no conclusion is written.
  assert.equal(inFlight.state, "applying");
  const pgid = inFlight.observation.mergePgid;
  assert.ok(typeof pgid === "number" && pgid > 1, "the merge process group was never recorded");

  // Deliberately NOT killed: the orphan is allowed to do exactly what it does in the wild.
  await waitForGroupExit(pgid);
  const mergedHead = await head(f.source);
  assert.notEqual(mergedHead, beforeHead, "the orphaned merge did not finish");
  // Measured: main's porcelain status comes back completely empty, which is exactly why a record
  // frozen on "undetermined" was so dangerous — nothing on the surface contradicted it.
  assert.equal(await status(f.source), "");

  const observed = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // Killed after committing but before git cleared MERGE_HEAD, so this is not finished — but it is
  // named, and it is not "undetermined": the record says the authorized merge is in main.
  assert.equal(observed.observation.code, "AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_STATE_LEFT_BEHIND");
  assert.equal(observed.mainHeadAfter, mergedHead, "the record still points at the pre-operation head");
  assert.equal(observed.observation.recoveryKind, "inspect-observed-merge");
  assert.ok(!(observed.observation.recovery ?? "").includes("reset --hard"),
    `a command that would discard a successful merge was offered: ${observed.observation.recovery}`);
  assert.ok((observed.observation.differences ?? []).includes("leftover:MAIN_MERGE_HEAD_PRESENT"));

  // The owner clears what the record named. The product does none of it.
  for (const name of ["MERGE_HEAD", "AUTO_MERGE", "MERGE_MSG"]) {
    await rm(join(f.source, ".git", name), { force: true });
  }
  const settled = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(settled.state, "applied");
  assert.equal(settled.observation.code, "AUTHORIZED_MERGE_COMMIT_OBSERVED_IN_MAIN");
  assert.equal(settled.mainHeadAfter, mergedHead);
  // The candidate reaches its terminal state even though the process that started it never returned.
  assert.equal(reopened.get(f.task.taskId)?.status, "merged");
});

/*
 * Bar item 2, the read-only half, guarded at full strength.
 *
 * The claim "crash reconciliation never writes to main" was in the commit message, in ADR-035, in
 * F26 and in VERIFICATION, and a mutation that inserted `git merge --abort` into the reconciliation
 * path left the whole suite green. Nothing was watching. This watches the only way that claim can be
 * watched: every byte under the repository, `.git` included.
 */
test("crash reconciliation does not change one byte of the repository, .git included", async (t) => {
  for (const scenario of [
    {
      // HEAD unmoved, no MERGE_HEAD, index and working tree fully rewritten. `git merge --abort`
      // cannot undo this one, so it is the case a careless "tidy up" would get away with.
      label: "after a kill during a hook, with no MERGE_HEAD to abort",
      hook: "sleep 600",
      killOrphan: true,
    },
    {
      // The orphan finished the merge and was killed before git cleared MERGE_HEAD. Here
      // `git merge --abort` DOES work — and would throw away a merge that succeeded. This is the
      // scenario in which a reconciliation that writes is not untidy but destructive.
      label: "after an orphaned merge finished and left MERGE_HEAD behind",
      hook: "sleep 6",
      killOrphan: false,
    },
  ]) {
    await t.test(scenario.label, async (child) => {
      const f = await fixture(child);
      const started = join(f.root, "hook-entered");
      await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\n${scenario.hook}\n`);
      const approval = await raise(f);
      const token = await grant(f, approval);

      const worker = await promoteInChild(f, approval, token);
      child.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
      for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
      assert.equal(await exists(started), true, "the hook never ran, so nothing was interrupted");
      worker.kill("SIGKILL");
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));

      const reopened = new CandidateRegistry(f.data);
      child.after(() => reopened.close());
      const inFlight = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
      const pgid = inFlight.observation.mergePgid;
      assert.ok(typeof pgid === "number" && pgid > 1);
      if (scenario.killOrphan) process.kill(-pgid, "SIGKILL");
      await waitForGroupExit(pgid);

      // The precondition that makes this mean something: the crash really did leave main altered, so
      // a reconciliation that "tidied up" would have plenty to do and the digest would move.
      const before = await treeDigest(f.source);
      // Amendment (T): the shape that has to be walked through the owner's exit is the one where
      // main was left half-applied. The one where the orphan committed the authorized merge is its
      // own evidence — main's HEAD IS the write — and converges without anybody being asked.
      if (scenario.killOrphan) await ownerEndsTheWait(reopened, f);
      const first = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
      assert.equal(first.state, "needs-manual-review");
      assert.ok((first.observation.differences ?? []).length > 0, "the crash left main unchanged");
      // Every read surface that reaches the reconciliation path, not just the one that reports it.
      await reopened.promotions({ roomId: "demo", mainPath: f.source });
      await reopened.status({ roomId: "demo", mainPath: f.source });
      await assert.rejects(
        reopened.requestMainMerge({
          actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
          mainPath: f.source, completionId: approval.binding.completionId,
          previewDigest: approval.binding.previewDigest,
        }),
        /MAIN_MERGE_PROMOTION_UNRESOLVED|MAIN_MERGE_PREVIEW_DIGEST_STALE/u,
      );
      assert.equal(await treeDigest(f.source), before, "reconciliation wrote to the repository");
    });
  }
});

/*
 * Bar item 4's other half, and the way out of `needs-manual-review`.
 *
 * A hook that merely runs too long is not a crash: nothing is killed, the process tree is cleaned up
 * correctly, and yet main is left half applied and the promotion ends unresolved. Before this, that
 * task could never be promoted again by any path — the gate read a conclusion somebody wrote once.
 * The owner restoring their own repository has to be enough, and the product must reach that answer
 * by looking rather than by being told.
 */
test("an owner who restores main themselves clears a needs-manual-review promotion", async (t) => {
  const f = await fixture(t);
  await hook(f, "pre-merge-commit", "#!/bin/sh\nsleep 600\n");
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const timedOut = await f.registry.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source, mergeTimeoutMs: 3_000,
  });
  // Amendment (V-3): a hook ran, so this does not settle on the leader's exit. The record says what
  // it is waiting for, and it costs the owner the declarations it prints; what it must NOT do is
  // decide for them. The half-applied main below is unchanged, and so is the ending.
  assert.equal(timedOut.promotion.state, "applying");
  assert.equal(timedOut.promotion.observation.attempt?.timedOut, true);
  assert.ok((timedOut.promotion.observation.differences ?? []).length > 0);
  // Until the owner acts, the owner cannot even be asked again.
  await assert.rejects(
    f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
      mainPath: f.source, completionId: approval.binding.completionId,
      previewDigest: approval.binding.previewDigest,
    }),
    /MAIN_MERGE_PROMOTION_UNRESOLVED/u,
  );
  const waited = await endEveryWait(f.registry, f.source, f.task.taskId);
  assert.equal(waited.state, "needs-manual-review");
  assert.ok((waited.observation.differences ?? []).length > 0);
  assert.ok(!/reset --hard/u.test(waited.observation.recovery ?? ""),
    "a declaration licensed a rewrite of a repository a hook had just run over");

  // The owner does what the record told them to, in their own terminal. The product does none of it.
  await execFileAsync("git", ["reset", "--hard", beforeHead], { cwd: f.source });
  await rm(join(f.source, ".git", "AUTO_MERGE"), { force: true });
  await rm(join(f.source, ".git", "MERGE_MSG"), { force: true });
  await rm(join(f.source, ".git", "hooks", "pre-merge-commit"), { force: true });
  assert.equal(await status(f.source), "");

  // Reopened in a new registry, so the answer comes from the repository and durable state alone.
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const resolved = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(resolved.state, "rolled-back");
  assert.equal(resolved.observation.code, "MAIN_OBSERVED_IDENTICAL_TO_PRE_PROMOTION_FINGERPRINTS");
  // Removing the hook that hung is the ONLY way a retry can ever succeed, so it must not be the
  // thing that seals the previous attempt as unresolved forever. It is reported, not disqualifying.
  assert.deepEqual(resolved.observation.differences, ["hookEnvironment"]);
  // And the owner can be asked again — the single previous answer no longer holds the task shut.
  const second = await reopened.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(second.approvable, true, `not approvable: ${second.blockers.join(",")}`);
  const request = await reopened.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
    mainPath: f.source, completionId: second.completionId, previewDigest: second.previewDigest,
  });
  const retried = await reopened.promoteMainMerge({
    approvalId: request.id,
    token: (await reopened.grantMainMerge({
      approvalId: request.id, roomId: "demo", mainPath: f.source,
      previewDigest: request.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    })).approvalToken,
    action: MERGE_APPROVAL_GRANT, taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(retried.mainMutated, true);
});

/*
 * The same gate, on the CONSUME side.
 *
 * A mutation is why this exists: deleting `#assertNoUnresolvedPromotion` from the authorization path
 * left the whole suite green, which means the only thing standing between an unknown main and a
 * second write to it had no test at all. It is the first refusal an unresolved task gets, and it is
 * the one that names the actual problem rather than a consequence of it.
 */
test("an approval cannot be spent while the task's last promotion is unresolved", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChild(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  assert.equal(await exists(started), true, "the hook never ran, so nothing was interrupted");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const inFlight = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = inFlight.observation.mergePgid;
  assert.ok(typeof pgid === "number" && pgid > 1);
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  // Amendment (T): a crashed promotion no longer concludes on the strength of its own numbers, so
  // the owner ends the wait first. The gate this test is about is the same either way — an
  // `applying` row refuses just as an unresolved `needs-manual-review` one does — and taking the
  // longer route means the refusal below is measured against the state the test names.
  await ownerEndsTheWait(reopened, f);
  assert.equal(
    readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]).state,
    "needs-manual-review",
  );

  // The same token, against a main nobody can describe. It is refused by the unresolved-promotion
  // gate specifically — not by the single-use check that happens to also be closed here — because
  // "main is in an unknown state" is what the owner has to act on.
  await assert.rejects(
    reopened.promoteMainMerge({
      approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    }),
    /^Error: MAIN_MERGE_PROMOTION_UNRESOLVED$/u,
  );
  // And nothing about main moved because of the attempt.
  assert.equal(
    readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]).state,
    "needs-manual-review",
  );
});

// ---------------------------------------------------------------------------------------------
// The upgrade: an owner decision recorded by the PREVIOUS release
// ---------------------------------------------------------------------------------------------

/**
 * Turns a live v5 database into a genuine v4 one, without touching anything the upgrade preserves.
 *
 * Two facts make this a faithful reproduction rather than an approximation, and both were measured
 * against the previous commit's code rather than assumed: the v4→v5 upgrade is exactly one
 * `CREATE TABLE`, and a v4 `preview_json` is byte-for-byte a v5 one minus the trailing `promotion`
 * key (same keys, same order, same structure). So removing that key and the promotion table, and
 * rewinding `user_version`, produces the same bytes the previous release wrote — with correct
 * hashes, because a real v4 row is not tampered with and must not read as if it were.
 */
function rewindToV4(path: string, taskId: string): { approvalHash: string; approvalState: string } {
  return rewindPreview(path, taskId, (preview) => { delete preview.promotion; }, { toV4: true });
}

/**
 * Rewrites the stored preview of one task's candidate and approval, leaving both rows' hashes and
 * their `preview_digest` internally consistent — a legitimately stored older row, not a tampered one.
 */
function rewindPreview(
  path: string, taskId: string, edit: (preview: Record<string, unknown>) => void,
  options: { toV4?: boolean } = {},
): { approvalHash: string; approvalState: string } {
  const db = new DatabaseSync(path);
  const candidate = db.prepare("SELECT * FROM candidates WHERE task_id=?")
    .get(taskId) as unknown as Record<string, unknown>;
  const completion = JSON.parse(String(candidate.completion_json)) as {
    preview: Record<string, unknown>; previewDigest: string;
  };
  edit(completion.preview);
  completion.previewDigest = createHash("sha256")
    .update(JSON.stringify(completion.preview), "utf8").digest("hex");
  const completionJson = JSON.stringify(completion);
  const candidateHash = createHash("sha256").update(JSON.stringify([
    candidate.task_id, candidate.candidate_id, candidate.room_id, candidate.main_path,
    candidate.main_branch, candidate.base_main_head, candidate.candidate_path,
    candidate.candidate_branch, candidate.task_text, candidate.acceptance_criteria,
    candidate.status, candidate.baseline_json, completionJson, candidate.created_at_ms,
    candidate.updated_at_ms, candidate.completed_at_ms,
  ]), "utf8").digest("hex");
  assert.equal(Number(db.prepare("UPDATE candidates SET completion_json=?,row_hash=? WHERE task_id=?")
    .run(completionJson, candidateHash, taskId).changes), 1);

  const approval = db.prepare("SELECT * FROM candidate_merge_approvals WHERE task_id=?")
    .get(taskId) as unknown as Record<string, unknown>;
  const preview = JSON.parse(String(approval.preview_json)) as Record<string, unknown>;
  edit(preview);
  const previewJson = JSON.stringify(preview);
  const previewDigest = createHash("sha256").update(previewJson, "utf8").digest("hex");
  const approvalHash = createHash("sha256").update(JSON.stringify([
    approval.id, approval.client_request_id, approval.input_digest, approval.task_id,
    approval.completion_id, approval.room_id, approval.main_path, approval.main_branch,
    approval.candidate_path, approval.base_main_head, approval.candidate_head, approval.main_head,
    approval.main_fingerprint, approval.main_ignored_fingerprint, approval.recovery_ref,
    previewDigest, previewJson, approval.grant_action, approval.state, approval.token_hash,
    approval.actor, approval.decided_by, approval.refusal_json, approval.created_at_ms,
    approval.updated_at_ms, approval.expires_at_ms,
  ]), "utf8").digest("hex");
  assert.equal(Number(db.prepare(
    "UPDATE candidate_merge_approvals SET preview_json=?,preview_digest=?,row_hash=? WHERE id=?",
  ).run(previewJson, previewDigest, approvalHash, String(approval.id)).changes), 1);

  if (options.toV4 === true) db.exec("DROP TABLE candidate_merge_promotions; PRAGMA user_version=4;");
  db.close();
  return { approvalHash, approvalState: String(approval.state) };
}

function storedApproval(path: string, id: string): { state: string; row_hash: string; refusal_json: string | null } {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT state,row_hash,refusal_json FROM candidate_merge_approvals WHERE id=?")
    .get(id) as unknown as { state: string; row_hash: string; refusal_json: string | null };
  db.close();
  return row;
}

function schemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  db.close();
  return version;
}

/**
 * The blast radius of a perfectly legitimate approval written by the previous release.
 *
 * Measured on the shipped code: an owner-GRANTED v4 approval made every single read and write
 * surface throw `MAIN_MERGE_APPROVAL_ROW_TAMPERED` — list, inspect, reject, promote — while its
 * `row_hash` was, and still is, exactly right. Nothing was tampered with. Because the row could
 * never be read it could never be rejected and never expire either, so it held the task's one open
 * question slot permanently: `requestMainMerge` answered `ALREADY_PENDING` forever, at 24 hours as
 * readily as at one second. The task could never be promoted again by any path, and the product
 * offered none to clear it. This is PITFALLS #85 exactly: "this snapshot is older than the feature"
 * folded into "this row was tampered with", with the destructive answer as the default.
 */
test("an owner's approval from the previous release upgrades to a terminal state, not a wedged task", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  f.registry.close();

  const before = rewindToV4(f.path, f.task.taskId);
  assert.equal(before.approvalState, "approved", "the owner really had granted it");
  assert.equal(schemaVersion(f.path), 4);

  // Opening runs the real v4→v5 upgrade. It reads no approval row and rewrites none.
  const upgraded = new CandidateRegistry(f.data);
  t.after(() => upgraded.close());
  assert.equal(schemaVersion(f.path), 6);
  assert.equal(storedApproval(f.path, approval.id).row_hash, before.approvalHash,
    "the upgrade rewrote an existing approval row");

  // Every surface answers. None of them throws an integrity error about a row whose integrity is
  // perfect, and the answer names the real reason.
  assert.deepEqual((await upgraded.status({ roomId: "demo", mainPath: f.source })).map((row) => row.status),
    ["completed"]);
  const listed = await upgraded.mergeApprovals({ roomId: "demo", mainPath: f.source });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.state, "invalidated");
  assert.equal(listed[0]?.refusal?.code, "PREVIEW_PREDATES_PROMOTION_GATES");
  const inspected = await upgraded.inspectMergeApproval({
    approvalId: approval.id, roomId: "demo", mainPath: f.source,
  });
  assert.equal(inspected.approval.state, "invalidated");
  // Terminal, durably — so it is not holding anything open in the next process either.
  assert.equal(storedApproval(f.path, approval.id).state, "invalidated");

  // The token the owner was handed under the previous release cannot write main, and says why.
  await assert.rejects(
    upgraded.promoteMainMerge({
      approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_APPROVAL_NOT_APPROVED|PREVIEW_PREDATES_PROMOTION_GATES/u,
  );

  // And the whole point: the slot is free, so the owner can be asked again against a fresh snapshot
  // that HAS been checked against the promotion gates, and that promotion works.
  const second = await raise({ ...f, registry: upgraded });
  const result = await promote({ ...f, registry: upgraded }, second,
    await grant({ ...f, registry: upgraded }, second));
  assert.equal(result.mainMutated, true);
});

test("a previous-release approval can still be rejected, and rejecting it frees the task", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  f.registry.close();
  rewindToV4(f.path, f.task.taskId);

  const upgraded = new CandidateRegistry(f.data);
  t.after(() => upgraded.close());
  // Reject is the owner's own way out, and it is reached without any other surface being read first.
  const rejected = await upgraded.rejectMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: f.source,
    decidedBy: "local-web", reason: "raised before the promotion gates existed",
  });
  assert.equal(rejected.state, "rejected");
  const second = await raise({ ...f, registry: upgraded });
  assert.notEqual(second.id, approval.id);
});

test("a previous-release approval cannot be granted, and says so by name", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  f.registry.close();
  rewindToV4(f.path, f.task.taskId);

  const upgraded = new CandidateRegistry(f.data);
  t.after(() => upgraded.close());
  await assert.rejects(
    upgraded.grantMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: f.source,
      previewDigest: storedApprovalDigest(f.path, approval.id),
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    }),
    /^Error: PREVIEW_PREDATES_PROMOTION_GATES$/u,
  );
  assert.equal(storedApproval(f.path, approval.id).state, "invalidated");
  // The refusal names the reason rather than reporting drift in values that never moved.
  assert.equal(
    JSON.parse(storedApproval(f.path, approval.id).refusal_json ?? "{}").code,
    "PREVIEW_PREDATES_PROMOTION_GATES",
  );
});

function storedApprovalDigest(path: string, id: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT preview_digest FROM candidate_merge_approvals WHERE id=?")
    .get(id) as unknown as { preview_digest: string };
  db.close();
  return row.preview_digest;
}

// =============================================================================================
// Round-2 findings. Everything below exists because a measurement contradicted the previous
// round's record, and each block names the finding it closes.
// =============================================================================================

/** Starts a promotion in a separate OS process, optionally killing itself at a named step. */
async function promoteInChildAt(
  f: Fixture, approval: MergeApproval, token: string, faultPoint?: string,
): Promise<ReturnType<typeof spawn>> {
  const module = fileURLToPath(new URL("../src/core/candidate-registry.ts", import.meta.url));
  const script = join(f.root, `promote-fault-${randomUUID()}.mjs`);
  await writeFile(script, [
    "const [data, source, approvalId, token, taskId, point] = process.argv.slice(2);",
    `const { CandidateRegistry } = await import(${JSON.stringify(module)});`,
    // A REAL SIGKILL to this real process, delivered from inside the step being tested. Nothing is
    // simulated: SQLite sees a process that vanished mid-transaction.
    "const registry = new CandidateRegistry(data, point === '-' ? {} : {",
    "  faultPoint: (name) => { if (name === point) process.kill(process.pid, 'SIGKILL'); },",
    "});",
    "process.stdout.write('ready\\n');",
    "await registry.promoteMainMerge({",
    "  approvalId, token, action: 'merge-candidate-into-main', taskId, roomId: 'demo', mainPath: source,",
    "});",
    "process.stdout.write('done\\n');",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return spawn(process.execPath, [
    script, f.data, f.source, approval.id, token, f.task.taskId, faultPoint ?? "-",
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

/** Polls a promotion until it leaves `applying`, or gives up and returns what it last saw. */
async function settledPromotion(
  registry: CandidateRegistry, source: string, attempts = 300,
): Promise<ReturnType<typeof readable>> {
  let last = readable((await registry.promotions({ roomId: "demo", mainPath: source }))[0]);
  for (let attempt = 0; attempt < attempts && last.state === "applying"; attempt += 1) {
    await delay(100);
    last = readable((await registry.promotions({ roomId: "demo", mainPath: source }))[0]);
  }
  return last;
}

/*
 * FINDING 1. A hook that backgrounds ANYTHING — a dev server, a watcher, a log tailer — leaves the
 * merge's process GROUP alive for as long as that child lives. Measured on the previous commit:
 * main was fully merged, `git status --porcelain` was completely empty, and the record stayed frozen
 * on `applying` ("still being written") forever, with no product path able to release it.
 *
 * The group is no longer what a conclusion waits on. The group LEADER is the `git merge` itself
 * (children are spawned detached, so the leader's pid is the group id), and that is the process
 * whose life decides whether main is still being written.
 */
test("a hook that leaves a background process behind does not freeze the promotion forever", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const lingering = join(f.root, "lingering.pid");
  await hook(f, "pre-merge-commit", `#!/bin/sh
touch ${JSON.stringify(started)}
sleep 900 &
echo $! > ${JSON.stringify(lingering)}
sleep 3
exit 0
`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  assert.equal(await exists(started), true, "the hook never ran, so nothing was interrupted");
  child.kill("SIGKILL");
  await waitForExit(child);

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const inFlight = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = inFlight.observation.mergePgid;
  assert.ok(typeof pgid === "number" && pgid > 1, "the merge process group was never recorded");
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  // The orphaned merge finishes on its own and writes main. The group does NOT end with it: the
  // backgrounded `sleep 900` keeps it alive, which is the entire point.
  for (let attempt = 0; attempt < 600 && await head(f.source) === beforeHead; attempt += 1) {
    await delay(100);
  }
  const mergedHead = await head(f.source);
  assert.notEqual(mergedHead, beforeHead, "the orphaned merge never wrote main");
  assert.equal(await status(f.source), "", "main was expected to be clean after the orphan finished");
  assert.equal(groupAlive(pgid), true, "the backgrounded hook child was expected to still be alive");

  // Previously this stayed on `applying` — "still being written" — for the rest of the row's life.
  const observed = await settledPromotion(reopened, f.source);
  assert.notEqual(observed.state, "applying", "the record is still frozen on a lingering group");
  assert.equal(observed.observation.code, "AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_STATE_LEFT_BEHIND");
  assert.equal(observed.mainHeadAfter, mergedHead);
  // Amendment (T) changed what `pending` says here, and the change is honest rather than incidental.
  // The record is no longer frozen — that is the assertion above, and it is the one this test is
  // named for — but nothing this process watched says the merge process is over, so the record goes
  // on naming the group instead of reporting "nothing is in the way". What it must NOT say is that
  // a merge is still writing main, because a leader that has exited is not that.
  assert.notEqual(observed.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  assert.notEqual(observed.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");
  // The survivors are reported by name rather than silently ignored, with a read-only command.
  assert.equal(observed.observation.mergeGroupSurvivors?.pgid, pgid);
  assert.match(observed.observation.mergeGroupSurvivors?.inspect ?? "", new RegExp(`ps .*-g ${pgid}$`, "u"));

  // The owner clears what the record named; the product does none of it.
  for (const name of ["MERGE_HEAD", "AUTO_MERGE", "MERGE_MSG"]) {
    await rm(join(f.source, ".git", name), { force: true });
  }
  const settled = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // ⛔ This used to assert `applied`. Amendment (V-4): the merge landed and everything that follows
  // from THAT is unchanged — the candidate is terminally merged, `mainHeadAfter` is the merge — but
  // the project's exclusive marker is not handed back while a process this merge left is alive, and
  // the assertion two lines down is that it demonstrably still is.
  assert.equal(settled.state, "applying", `state ${settled.state}: ${settled.observation.code}`);
  assert.equal(settled.observation.code, "AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_GROUP_SURVIVORS");
  assert.equal(settled.observation.authorizedMergeCommit, true);
  assert.equal(reopened.get(f.task.taskId)?.status, "merged");
  // And the group really was still alive throughout, so this is not a race that resolved itself.
  assert.equal(groupAlive(pgid), true);

  // The name of this test, restated where it now lands: nothing here is frozen. The lingering child
  // is what the record is waiting on, and when it goes the record settles by itself — no phrase, no
  // declaration, no write to main.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  const free = await settledPromotion(reopened, f.source);
  assert.equal(free.state, "applied", `still ${free.state}: ${free.observation.code}`);
  assert.equal(free.mainHeadAfter, mergedHead);
});

/*
 * FINDING 1 (b). A pgid recorded once was carried into every later observation forever, including
 * into settled `needs-manual-review` rows whose group had been dead for a long time. A pid is a
 * name the operating system reuses; on macOS it wraps near 99999 and a reboot restarts the
 * numbering from the bottom — and a reboot is the likeliest reason a promotion is unresolved at all.
 */
test("a promotion that has been observed to be over stops carrying its process group id", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  assert.equal(await exists(started), true);
  child.kill("SIGKILL");
  await waitForExit(child);

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const inFlight = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = inFlight.observation.mergePgid;
  assert.ok(typeof pgid === "number" && pgid > 1);

  // While the merge is genuinely still running the record must name the exact process responsible.
  assert.equal(inFlight.state, "applying");
  assert.equal(inFlight.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  assert.equal(inFlight.pending?.pid, pgid);
  assert.match(inFlight.pending?.inspect ?? "", new RegExp(`ps .*-g ${pgid}$`, "u"));
  // A live leader is offered the longer phrase; the short one belongs to a group nobody can decide
  // about, and handing it out here is what let a provably live merge be disowned.
  assert.equal(inFlight.pending?.release, MERGE_LIVE_ABANDON_CONFIRMATION);

  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);

  // Amendment (T): the number probing gone is a hint, so it is still on the record — and it has to
  // be, because it is what the owner quotes. The finding this test is about is what happens once
  // something HAS concluded, and after the eleventh round the only thing that can conclude here is
  // the owner. So the number survives exactly as long as it is still needed, and no longer.
  const waiting = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(waiting.pending?.code, "MERGE_END_NOT_OBSERVED");
  assert.equal(waiting.observation.mergePgid, pgid,
    "the number the owner has to quote was erased before they could quote it");
  await ownerEndsTheWait(reopened, f);

  const settled = await settledPromotion(reopened, f.source);
  assert.equal(settled.state, "needs-manual-review");
  // The whole finding, in one assertion: the number is gone from the record, not carried forever.
  assert.equal(settled.observation.mergePgid, null);
  assert.equal(settled.observation.mergeGroup, null);
  assert.equal(settled.pending, undefined);
  assert.ok((settled.observation.differences ?? []).length > 0, "no differences were named");
});

/*
 * FINDING 1 (c). Identity, not just a number. A recorded group is scoped to the boot it was
 * recorded in; a pid from before a reboot names something else entirely afterwards, and believing it
 * is what keeps a record waiting on a process that cannot exist.
 */
test("a process group recorded before a reboot is not believed to be the running merge", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const inFlight = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = inFlight.observation.mergePgid;
  assert.ok(typeof pgid === "number" && pgid > 1);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  // Control: with the identity intact and the leader alive, the record refuses to conclude.
  assert.equal(inFlight.state, "applying");
  assert.equal(inFlight.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  reopened.close();

  // Rewrite ONLY the recorded boot instant in the payload, to a value from a previous boot, and
  // re-hash the row exactly as the store does. This is NOT what a reboot looks like — git's own
  // trace for this promotion still says the merge started during THIS boot — and the record must
  // say so rather than settle: two sources disagreeing about which boot a live pid belongs to is
  // the shape amendment (F) is about, and the number is alive right now.
  //
  // The previous version of this test stopped here and asserted the record settled. It passed
  // because the only source consulted was the one it had just rewritten ([[PITFALLS]] #84 — a test
  // whose setup does not create the situation it names).
  rewritePromotionRow(f.path, ({ observation }) => ({
    observation: {
      ...observation,
      mergeGroup: { ...(observation.mergeGroup as Record<string, unknown>), bootAtSec: 1_000 },
    },
  }));
  const disagreeing = new CandidateRegistry(f.data);
  t.after(() => disagreeing.close());
  const contested = await settledPromotion(disagreeing, f.source, 5);
  assert.equal(groupAlive(pgid), true, "this assertion is only evidence while the merge is alive");
  assert.equal(contested.state, "applying",
    "one source saying `another boot` while git's own trace says `this boot` is not a settled record");
  assert.equal(contested.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  assert.equal(contested.pending?.pid, pgid);
  disagreeing.close();

  // Now the reboot itself, in EVERY source. git's trace does not record a boot; it records when git
  // started, and a git that started before this machine booted cannot hold a pid this boot issued.
  // Moving that instant back is what a reboot actually leaves behind, and it is the precondition the
  // finding is about ([[PITFALLS]] #106).
  const tracePath = join(f.data, "promotion-traces", `${contested.id}.jsonl`);
  const lines = (await readFile(tracePath, "utf8")).split("\n");
  await writeFile(tracePath, lines.map((line) => {
    if (line.length === 0) return line;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.event !== "start") return line;
    return JSON.stringify({ ...event, time: new Date(1_000_000).toISOString() });
  }).join("\n"), { encoding: "utf8", mode: 0o600 });

  const afterReboot = new CandidateRegistry(f.data);
  t.after(() => afterReboot.close());
  // Amendment (T): ruling the number out is what this test is about, and it still happens — the
  // record stops reporting a merge as RUNNING. Concluding is a separate act, and after the
  // eleventh round the only thing that can perform it here is the owner.
  await ownerEndsTheWait(afterReboot, f);
  const settled = await settledPromotion(afterReboot, f.source, 50);
  assert.notEqual(settled.state, "applying");
  assert.equal(settled.state, "needs-manual-review");
  assert.equal(settled.observation.mergePgid, null);
  // The live process is still there; it was simply no longer identified as this promotion's merge.
  assert.equal(groupAlive(pgid), true);
});

/**
 * Rewrites a promotion row in place, recomputing the row hash exactly as the store does.
 *
 * Used to put a specific process identity into a record whose live processes the test cannot
 * otherwise control. The hash is recomputed rather than bypassed, so a drift between this and the
 * store fails loudly as a tampered row instead of quietly proving nothing.
 */
function rewritePromotionRow(path: string, change: (current: {
  ownerPid: number;
  observation: Record<string, unknown>;
}) => { ownerPid?: number; observation?: Record<string, unknown> }): void {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1").get() as unknown as
    Record<string, string | number | null>;
  const observation = JSON.parse(String(row.observation_json)) as Record<string, unknown>;
  const result = change({ ownerPid: Number(row.owner_pid), observation });
  const ownerPid = result.ownerPid ?? Number(row.owner_pid);
  const next = result.observation ?? observation;
  const observationJson = JSON.stringify(next);
  // The merge group columns are a projection of the observation, exactly as `#writePromotion`
  // computes them. A helper that left them stale would produce a row the product would call
  // tampered, and the tests below would then be measuring the helper rather than the product.
  const pgid = typeof next.mergePgid === "number" && Number.isSafeInteger(next.mergePgid)
    && next.mergePgid > 1 ? next.mergePgid : null;
  const group = next.mergeGroup as { bootAtSec?: unknown } | null | undefined;
  const boot = pgid !== null && typeof group?.bootAtSec === "number"
    && Number.isSafeInteger(group.bootAtSec) ? group.bootAtSec : null;
  const base = [
    row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
    row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
    row.restore_json, observationJson, row.state, ownerPid, row.started_at_ms,
    row.updated_at_ms,
  ];
  const rowHash = createHash("sha256").update(JSON.stringify(
    pgid === null && boot === null ? base : [...base, pgid, boot],
  ), "utf8").digest("hex");
  assert.equal(
    Number(db.prepare(
      `UPDATE candidate_merge_promotions
       SET owner_pid=?,observation_json=?,row_hash=?,merge_pgid=?,merge_boot_at_sec=? WHERE id=?`,
    ).run(ownerPid, observationJson, rowHash, pgid, boot, String(row.id)).changes),
    1,
  );
  db.close();
}

/**
 * Rewrites a promotion row to values of the CALLER's choosing and recomputes `row_hash` so the row
 * passes every integrity check the product has. The forging primitive amendment (T-3) requires.
 *
 * It differs from `rewritePromotionRow` in the one way that matters here: it does NOT project the
 * columns from the payload. The two in-row sources are separately addressable, so "forge the column"
 * and "forge the payload" are different acts with different consequences, exactly as deleting them
 * separately is.
 *
 * The hash is computed the way `mergePromotionHash()` computes it, including the rule that the two
 * merge-group columns join the hashed tuple only when they are not both NULL. That is not a
 * convenience: a hook with write access to this file computes it the same way, from public columns,
 * with an unkeyed SHA-256 and no chain — which is the whole of amendment (T).
 */
function forgePromotionRow(path: string, edit: (current: {
  observation: Record<string, unknown>;
  mergePgid: number | null;
  mergeBootAtSec: number | null;
}) => {
  observation?: Record<string, unknown>;
  mergePgid?: number | null;
  mergeBootAtSec?: number | null;
}): void {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(
      `SELECT * FROM candidate_merge_promotions WHERE state IN ('applying','needs-manual-review')
       ORDER BY CASE state WHEN 'applying' THEN 0 ELSE 1 END LIMIT 1`,
    ).get() as unknown as Record<string, string | number | null>;
    const observation = JSON.parse(String(row.observation_json)) as Record<string, unknown>;
    const current = {
      observation,
      mergePgid: row.merge_pgid === null ? null : Number(row.merge_pgid),
      mergeBootAtSec: row.merge_boot_at_sec === null ? null : Number(row.merge_boot_at_sec),
    };
    const result = edit(current);
    const observationJson = JSON.stringify(result.observation ?? current.observation);
    const pgid = result.mergePgid === undefined ? current.mergePgid : result.mergePgid;
    const boot = result.mergeBootAtSec === undefined ? current.mergeBootAtSec : result.mergeBootAtSec;
    const base = [
      row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
      row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
      row.restore_json, observationJson, row.state, row.owner_pid, row.started_at_ms,
      row.updated_at_ms,
    ];
    const rowHash = createHash("sha256").update(JSON.stringify(
      pgid === null && boot === null ? base : [...base, pgid, boot],
    ), "utf8").digest("hex");
    assert.equal(Number(db.prepare(
      `UPDATE candidate_merge_promotions
       SET observation_json=?,row_hash=?,merge_pgid=?,merge_boot_at_sec=? WHERE id=?`,
    ).run(observationJson, rowHash, pgid, boot, String(row.id)).changes), 1);
  } finally { db.close(); }
}

/**
 * Rewrites the APPROVAL row to say it was never spent, recomputing its hash the same way.
 *
 * This is amendment (O)'s first positive fact — "the approval was never spent, so no Git command
 * that writes main was invoked" — attacked with the capability that was measured against the
 * promotion row. The tenth round's comment called this table "the hash-chained database … the merge
 * cannot reach past the chain": `mergeApprovalHash()` is `sha(JSON.stringify([...public columns]))`
 * with no key and no chain, and `#verify()` does not cover it.
 */
function forgeApprovalNeverSpent(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT * FROM candidate_merge_approvals WHERE state='consumed' LIMIT 1")
      .get() as unknown as Record<string, string | number | null>;
    assert.ok(row !== undefined, "there was no consumed approval to forge");
    // The token hash goes back with the state, and leaving it out is how the FIRST version of this
    // forge quietly proved nothing ([[PITFALLS]] #106). `#assertMergeApprovalRow` holds the
    // invariant "a usable secret exists only while the approval is usable"
    // (`(state === "approved") !== (token_hash !== null)`), so `approved` beside a NULL token is a
    // TAMPERED row, `#promotionApprovalSpent` catches it and answers `true`, and the attack never
    // reached the gate it is named for. It was the surviving SPENTCONC mutation that showed this,
    // not inspection. The value need not be the hash of any real token: this path reads `state`.
    const forgedToken = createHash("sha256").update("forged-token", "utf8").digest("hex");
    const next: Record<string, string | number | null> = {
      ...row, state: "approved", token_hash: forgedToken,
    };
    const rowHash = createHash("sha256").update(JSON.stringify([
      next.id, next.client_request_id, next.input_digest, next.task_id, next.completion_id,
      next.room_id, next.main_path, next.main_branch, next.candidate_path, next.base_main_head,
      next.candidate_head, next.main_head, next.main_fingerprint, next.main_ignored_fingerprint,
      next.recovery_ref, next.preview_digest, next.preview_json, next.grant_action, next.state,
      next.token_hash, next.actor, next.decided_by, next.refusal_json, next.created_at_ms,
      next.updated_at_ms, next.expires_at_ms,
    ]), "utf8").digest("hex");
    assert.equal(Number(db.prepare(
      "UPDATE candidate_merge_approvals SET state=?,token_hash=?,row_hash=? WHERE id=?",
    ).run("approved", forgedToken, rowHash, String(row.id)).changes), 1);
  } finally { db.close(); }
}

/** A pid that is certainly not in use: spawn something trivial, wait for it, keep the number. */
async function deadPid(): Promise<number> {
  const child = spawn("/bin/sh", ["-c", ":"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 1);
  await waitForExit(child);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch { return pid; }
    await delay(25);
  }
  throw new Error("the pid chosen as dead is still answering");
}

/**
 * Damages a promotion row the way corruption actually does — WITHOUT touching the row hash to match.
 *
 * The fifth round's probe zeroed `row_hash` and left the payload intact, so every fix it produced was
 * only ever exercised against a row whose `observation_json` still parsed. Real damage does not pick
 * fields. This writes the row as given and leaves the hash stale, which is what makes the row
 * unreadable in the first place.
 */
function damagePromotionRow(path: string, change: {
  observationJson?: string;
  mergePgid?: number | null;
  mergeBootAtSec?: number | null;
}): string {
  const db = new DatabaseSync(path);
  // An `applying` row when there is one — every caller that has one means that one — and otherwise
  // the unsettled row this fixture left behind, so a record that has already converged can be
  // damaged too.
  const row = db.prepare(
    `SELECT * FROM candidate_merge_promotions WHERE state IN ('applying','needs-manual-review')
     ORDER BY CASE state WHEN 'applying' THEN 0 ELSE 1 END LIMIT 1`,
  ).get() as unknown as Record<string, string | number | null>;
  const id = String(row.id);
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (change.observationJson !== undefined) {
    sets.push("observation_json=?");
    values.push(change.observationJson);
  }
  if (change.mergePgid !== undefined) {
    sets.push("merge_pgid=?");
    values.push(change.mergePgid);
  }
  if (change.mergeBootAtSec !== undefined) {
    sets.push("merge_boot_at_sec=?");
    values.push(change.mergeBootAtSec);
  }
  sets.push("row_hash=?");
  values.push("0".repeat(64));
  assert.equal(Number(db.prepare(
    `UPDATE candidate_merge_promotions SET ${sets.join(",")} WHERE id=?`,
  ).run(...values, id).changes), 1);
  db.close();
  return id;
}

/*
 * FINDING 1 (d). "Needs manual review" converges by re-observation, but a promotion blocked on a
 * process group that never ends — an orphaned merge stuck in a hook that hangs forever — had no
 * exit at all, and it holds the one open question a task is allowed to have. The bar's item 11
 * requires a product-side path to release any state that occupies a structural slot.
 */
test("the owner can stop a promotion waiting on a process group, without anything being killed", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = blocked.observation.mergePgid;
  assert.ok(typeof pgid === "number" && pgid > 1);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(blocked.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");

  const args = {
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pgid,
    confirmation: MERGE_LIVE_ABANDON_CONFIRMATION, decidedBy: "local-web",
  };
  // This merge is not merely unwitnessed: `ps` can show it writing. The record says so by handing
  // out the LONGER phrase, and the short one — the one an owner would use for a group nobody can
  // decide about — is refused here by name, with the pid and a read-only command to look at it.
  assert.equal(blocked.pending?.release, MERGE_LIVE_ABANDON_CONFIRMATION);
  await assert.rejects(
    reopened.abandonMergeProcessGroup({ ...args, confirmation: MERGE_GROUP_ABANDON_CONFIRMATION }),
    (error: Error & { pid?: number; confirmation?: string; inspect?: string }) =>
      error.message === "MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING"
      && error.pid === pgid
      && error.confirmation === MERGE_LIVE_ABANDON_CONFIRMATION
      && (error.inspect ?? "").includes(String(pgid)),
  );
  // The phrase and the pid are both required: an owner who did not look at the record has neither.
  await assert.rejects(
    reopened.abandonMergeProcessGroup({ ...args, confirmation: "yes" }),
    /MERGE_GROUP_ABANDON_CONFIRMATION_MISMATCH/u,
  );
  await assert.rejects(
    reopened.abandonMergeProcessGroup({ ...args, pgid: pgid + 1 }),
    /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
  );

  const before = await treeDigest(f.source);
  const released = readable(await reopened.abandonMergeProcessGroup(args));
  // And for as long as that process is alive, the command on offer only LOOKS. Handing over
  // `git reset --hard` here is PITFALLS #94: it does not undo the write, it races it.
  assert.equal(released.observation.recoveryKind, "inspect-live-merge");
  assert.ok(!(released.observation.recovery ?? "").includes("reset"),
    `a destructive recovery was offered mid-merge: ${released.observation.recovery ?? ""}`);
  assert.equal(released.observation.mergeGroupDisowned?.whileRunning, true);
  // Nothing was killed and nothing in the repository moved: this releases a record, not a process.
  assert.equal(groupAlive(pgid), true, "abandoning the wait must not kill anything");
  assert.equal(await treeDigest(f.source), before, "abandoning the wait wrote to the repository");
  assert.equal(await head(f.source), beforeHead);
  // The declaration is attributed to the owner rather than dressed up as an observation.
  assert.equal(released.observation.mergeGroupDisowned?.pgid, pgid);
  assert.equal(released.observation.mergeGroupDisowned?.decidedBy, "local-web");
  assert.equal(released.state, "needs-manual-review");
  assert.equal(released.pending, undefined);
  assert.ok((released.observation.differences ?? []).length > 0, "no differences were named");
  // A second attempt has nothing left to release, and says so instead of pretending to act.
  await assert.rejects(
    reopened.abandonMergeProcessGroup(args), /MAIN_MERGE_PROMOTION_NOT_BLOCKED/u,
  );

  // And the state is now one the owner can actually clear: restoring main themselves converges it.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  await execFileAsync("git", ["reset", "--hard", beforeHead], { cwd: f.source });
  await rm(join(f.source, ".git", "hooks", "pre-merge-commit"), { force: true });
  const converged = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(converged.state, "rolled-back");
  const second = await raise(f);
  const retried = await promote(f, second, await grant(f, second));
  assert.equal(retried.promotion.state, "applied");
});

/*
 * FINDING 2. The attributes gate enumerated the files it believed git would read, and the comment
 * beside it claimed that list was every one of them. Measured with `git check-attr` in the product's
 * exact environment, two were missing, and both are reachable from `.git/config`, which the threat
 * model already says a terminal agent can write:
 *   - `core.attributesFile = ~/attrs`: git expands `~`, the product joined it under the workspace,
 *     producing `<main>/~/attrs`, an ENOENT, and zero blockers;
 *   - no `core.attributesFile` at all: git still reads `$XDG_CONFIG_HOME/git/attributes`, because
 *     `GIT_CONFIG_GLOBAL=/dev/null` overrides the global CONFIG file and not the global ATTRIBUTES
 *     file.
 * The fix does not extend the list; it asks git.
 */
for (const attributes of [
  {
    label: "core.attributesFile spelled with a leading ~, which git expands and a join() does not",
    install: async (f: Fixture, home: string) => {
      await writeFile(join(home, "attrs"), "* filter=lfs\n", "utf8");
      await execFileAsync("git", ["config", "core.attributesFile", "~/attrs"], { cwd: f.source });
    },
  },
  {
    label: "the XDG global attributes file, which GIT_CONFIG_GLOBAL=/dev/null does not suppress",
    install: async (_f: Fixture, home: string) => {
      await mkdir(join(home, ".config", "git"), { recursive: true });
      await writeFile(join(home, ".config", "git", "attributes"), "* filter=lfs\n", "utf8");
    },
  },
]) {
  test(`main is refused when a filter comes from ${attributes.label}`, async (t) => {
    const f = await fixture(t);
    const home = join(f.root, "home");
    await mkdir(home, { recursive: true });
    // The product builds git's environment from `process.env`, so this is the same HOME the merge
    // would run under. Restored whatever happens.
    const previous = process.env.HOME;
    t.after(() => { process.env.HOME = previous; });
    process.env.HOME = home;
    await attributes.install(f, home);

    // First: git itself, asked directly, agrees that a filter applies here. Without this the test
    // would prove only that the product refuses, not that it refuses something real.
    const seen = await execFileAsync("git", ["check-attr", "filter", "--", "probe.bin"], {
      cwd: f.source,
      env: {
        PATH: process.env.PATH ?? "", HOME: home,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      },
    });
    assert.match(seen.stdout, /filter: lfs/u, "git does not actually apply a filter in this setup");

    const preview = await f.registry.previewMainMerge({
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    });
    assert.equal(preview.approvable, false);
    assert.ok(
      preview.blockers.includes("MAIN_ATTRIBUTES_DECLARE_FILTER")
      || preview.blockers.includes("MAIN_ATTRIBUTES_UNREADABLE"),
      `expected an attributes refusal, got ${JSON.stringify(preview.blockers)}`,
    );
  });
}

test("main is refused when a global filter matches only a new candidate path", async (t) => {
  const f = await fixture(t, {
    beforeComplete: async ({ candidatePath }) => {
      await commit(candidatePath, "latent.zed", "candidate secret\n", "candidate secret");
    },
  });
  const home = join(f.root, "home");
  await mkdir(join(home, ".config", "git"), { recursive: true });
  await writeFile(join(home, ".config", "git", "attributes"), "latent.zed filter=lfs\n", "utf8");
  const previousHome = process.env.HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.env.HOME = home;

  const gitEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const probe = await execFileAsync("git", ["check-attr", "filter", "--", "probe.zed"], {
    cwd: f.source, env: gitEnv,
  });
  assert.match(probe.stdout, /unspecified/u,
    "the representative probes must not already match this global rule");
  const exact = await execFileAsync("git", ["check-attr", "filter", "--", "latent.zed"], {
    cwd: f.source, env: gitEnv,
  });
  assert.match(exact.stdout, /filter: lfs/u,
    "git must apply the filter to the candidate-only path");

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.approvable, false);
  assert.ok(
    preview.blockers.includes("MAIN_ATTRIBUTES_DECLARE_FILTER")
    || preview.blockers.includes("MAIN_ATTRIBUTES_UNREADABLE"),
    `expected an exact-path attributes refusal, got ${JSON.stringify(preview.blockers)}`,
  );
});

/*
 * FINDING 3. `promoteMainMerge` wrote no audit event and no room ledger line at all, on either path.
 * `runProcess` also only ever saw the merge's overall exit code, so nothing could say WHICH hooks
 * ran or what they returned — and `hooks: ok` written from a flag is PITFALLS #86 with a costume on.
 * Both HEAD observations, the executed hooks and their exit codes are now read and recorded.
 */
test("both promotion paths are written to the audit chain and the room ledger, with observed facts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-promotion-audit-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "committed main\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: source });
  await execFileAsync("git", [...author, "commit", "-m", "initial"], { cwd: source });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  // The production wiring: the service is what supplies the audit chain and the ledger.
  const service = new CollaborationService(data);
  t.after(() => service.close());
  service.ledger.createRoom("demo", source);

  const run = async (taskName: string): Promise<{ taskId: string; approvalId: string }> => {
    const task = await service.candidates.start({
      actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: taskName,
    });
    await commit(task.candidatePath, `${taskName}.txt`, "candidate work\n", "candidate work");
    await service.candidates.complete({
      actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo",
      mainPath: source, summary: "ready",
    });
    const preview = await service.candidates.previewMainMerge({
      taskId: task.taskId, roomId: "demo", mainPath: source,
    });
    assert.equal(preview.approvable, true, preview.blockers.join(","));
    const approval = await service.candidates.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo",
      mainPath: source, completionId: preview.completionId, previewDigest: preview.previewDigest,
    });
    const granted = await service.candidates.grantMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: source,
      previewDigest: approval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    });
    await service.candidates.promoteMainMerge({
      approvalId: approval.id, token: granted.approvalToken, action: MERGE_APPROVAL_GRANT,
      taskId: task.taskId, roomId: "demo", mainPath: source,
    }).catch(() => undefined);
    return { taskId: task.taskId, approvalId: approval.id };
  };

  // --- the success path, with hooks whose exit codes must be READ rather than assumed
  const hookMarker = join(root, "hooks-that-ran.txt");
  for (const [name, code] of [["pre-merge-commit", 0], ["post-merge", 3]] as const) {
    await writeFile(join(source, ".git", "hooks", name),
      `#!/bin/sh\nprintf '%s\\n' "${name}" >> ${JSON.stringify(hookMarker)}\nexit ${code}\n`,
      { encoding: "utf8", mode: 0o700 });
  }
  const headBefore = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  const applied = await run("audited-success");
  const headAfter = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  assert.notEqual(headAfter, headBefore);
  assert.equal((await readFile(hookMarker, "utf8")).split("\n").filter(Boolean).length, 2);

  const events = service.audit.list({ roomId: "demo" })
    .filter((event) => event.type.startsWith("candidate.main-merge-"));
  // The chain verifying is not evidence on its own — an empty chain verifies too. The count and the
  // content are asserted separately.
  assert.equal(service.audit.verify(), true);
  assert.equal(events.length, 2, `expected a started and a settled record, got ${events.length}`);
  const startedEvent = events.find((event) => event.type === "candidate.main-merge-started");
  const settledEvent = events.find((event) => event.type === "candidate.main-merge-settled");
  assert.ok(startedEvent && settledEvent);
  assert.equal(startedEvent.outcome, "allowed");
  assert.equal(settledEvent.outcome, "succeeded");
  const detail = settledEvent.detail as Record<string, unknown>;
  // BOTH observations of HEAD, kept apart, so an applied merge cannot be confused with a no-op.
  assert.equal(detail.mainHeadBefore, headBefore);
  assert.equal(detail.mainHeadAfter, headAfter);
  assert.equal(detail.mainHeadUnchanged, false);
  assert.equal(detail.mainMutation, true);
  assert.equal(detail.authorizedMergeCommit, true);
  // The hooks that really ran, by name, with the exit code each really returned.
  assert.deepEqual(
    (detail.hooksExecuted as Array<{ name: string; exitCode: number }>)
      .map((entry) => [entry.name, entry.exitCode]),
    [["pre-merge-commit", 0], ["post-merge", 3]],
  );
  // Who approved it, pointing at the approval row rather than at a constant.
  assert.equal(detail.decidedBy, "local-web");
  assert.equal(detail.approvalState, "consumed");
  assert.equal(detail.approvalId, applied.approvalId);
  assert.match(String(detail.previewDigest), /^[0-9a-f]{64}$/u);

  // --- the failure path: a pre-merge-commit hook that exits non-zero, rolled back
  await writeFile(join(source, ".git", "hooks", "pre-merge-commit"),
    "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o700 });
  const rolledBack = await run("audited-failure");
  const failureEvents = service.audit.list({ roomId: "demo" })
    .filter((event) => event.type === "candidate.main-merge-settled" && event.taskId === rolledBack.taskId);
  assert.equal(failureEvents.length, 1, "a failed promotion left no terminal record");
  const failure = failureEvents[0]?.detail as Record<string, unknown>;
  // ⛔ This used to be `failed` / `rolled-back` in one step. Amendment (V-3): this promotion ran a
  // hook, so the leader's exit does not settle it — the settle record says, by name, that it is
  // waiting, and main is still reported as untouched. The terminal record is the one after the owner
  // has looked, below. Bar item 5 asks that a failure and a promotion that never happened be
  // distinguishable, and both of these records are the failure, said twice.
  assert.equal(failureEvents[0]?.outcome, "denied");
  assert.equal(failure.state, "applying");
  assert.equal(failure.code, "MERGE_UNACCOUNTED_FOR_NOTHING_CONCLUDED");
  assert.equal(failure.mainMutation, false);
  // A silent failure and a promotion that never happened are distinguishable: this one names the
  // hook that ran, what it returned, and that every fingerprint came back.
  assert.deepEqual(
    (failure.hooksExecuted as Array<{ name: string; exitCode: number }>)
      .map((entry) => [entry.name, entry.exitCode]),
    [["pre-merge-commit", 1]],
  );
  assert.deepEqual(failure.differences, []);
  assert.equal(failure.mainHeadUnchanged, true);

  // The owner reads what the record names and ends the wait. That is what (V-3) puts in place of the
  // product concluding on their behalf, and the terminal record follows from the RE-OBSERVATION, so
  // it is still the repository that decides — not the declaration. It costs two declarations here
  // because this process is BOTH the orchestrator that is still alive and the one that ran the
  // merge, which is the ordinary shape of a record that did not settle.
  await endEveryWait(service.candidates, source, rolledBack.taskId);
  const terminalEvents = service.audit.list({ roomId: "demo" })
    .filter((event) => event.type === "candidate.main-merge-re-observed" && event.taskId === rolledBack.taskId);
  assert.equal(terminalEvents.length, 1, "a failed promotion left no terminal record");
  const terminal = terminalEvents[0]?.detail as Record<string, unknown>;
  assert.equal(terminalEvents[0]?.outcome, "failed");
  assert.equal(terminal.state, "rolled-back");
  assert.equal(terminal.mainMutation, false);
  assert.deepEqual(
    (terminal.hooksExecuted as Array<{ name: string; exitCode: number }>)
      .map((entry) => [entry.name, entry.exitCode]),
    [["pre-merge-commit", 1]],
  );
  assert.deepEqual(terminal.differences, []);
  assert.equal(service.audit.verify(), true);

  // The public ledger carries both, and neither leaks the project path, the approval id or a token.
  assert.equal(service.ledger.verifyChain("demo"), true);
  const lines = service.ledger.listAfter("demo", 0).map((entry) => entry.text);
  const promotionLines = lines.filter((text: string) => text.includes("promotion"));
  assert.ok(promotionLines.length >= 4, `expected both paths in the ledger, got ${promotionLines.length}`);
  assert.ok(promotionLines.some((text: string) => /已套用/u.test(text) && /pre-merge-commit\(exit 0\)/u.test(text)));
  assert.ok(promotionLines.some((text: string) => /未套用/u.test(text) && /pre-merge-commit\(exit 1\)/u.test(text)));
  for (const text of promotionLines) {
    assert.equal(text.includes(source), false, `the ledger leaked the project path: ${text}`);
    assert.equal(text.includes(applied.approvalId), false);
  }

  // --- amendment (V-4): the third path, where the two facts the trail used to conflate come apart.
  // The merge SUCCEEDS and its hook leaves a process behind, so the record stays visibly unsettled
  // while main really has been written. Reading the write off the record's state — which is what the
  // trail did — puts `mainMutation: false` into the audit chain and the public ledger for a merge
  // that is in main. Bar item 5: every fact asserted here has to be one that was observed.
  const survivorWrote = join(root, "audited-survivor-wrote");
  await writeFile(join(source, ".git", "hooks", "pre-merge-commit"),
    survivorHook(join(root, "audited-survivor-started"), survivorWrote, join(source, "README.md"))
      .replace("exit 1", "exit 0"),
    { encoding: "utf8", mode: 0o700 });
  const withSurvivor = await run("audited-survivor");
  const survivorEvents = service.audit.list({ roomId: "demo" })
    .filter((event) => event.type === "candidate.main-merge-settled" && event.taskId === withSurvivor.taskId);
  assert.equal(survivorEvents.length, 1);
  const withSurvivorDetail = survivorEvents[0]?.detail as Record<string, unknown>;
  const survivorGroup = (withSurvivorDetail.mergeGroupSurvivors as { pgid?: number } | undefined)?.pgid;
  assert.ok(typeof survivorGroup === "number" && survivorGroup > 1,
    "the hook left nothing behind, so this is not the (V-4) scenario");
  t.after(() => { try { process.kill(-survivorGroup, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(groupAlive(survivorGroup), true, "the survivor is already gone; this proves nothing");
  assert.equal(withSurvivorDetail.state, "applying");
  assert.equal(withSurvivorDetail.code, "AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_GROUP_SURVIVORS");
  assert.equal(withSurvivorDetail.authorizedMergeCommit, true);
  assert.equal(withSurvivorDetail.mainMutation, true,
    "the trail says main was not written for a promotion whose merge commit is in main");
  assert.equal(withSurvivorDetail.mainHeadUnchanged, false);
  assert.equal(service.audit.verify(), true);
  assert.equal(service.ledger.verifyChain("demo"), true);
});

/*
 * FINDING 4. Bar item 1 names four interruption points; only the merge itself had a test. These are
 * the other three, each a real `kill -9` delivered from INSIDE the step, with the answer rebuilt in
 * a new OS process from durable state alone.
 */
test("a kill inside the intent-record write leaves nothing recorded and nothing spent", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const before = { head: await head(f.source), tree: await treeDigest(f.source) };

  const child = await promoteInChildAt(f, approval, token, "promotion-intent-write");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await waitForExit(child);
  assert.equal(child.signalCode, "SIGKILL", "the child was expected to die inside the write");

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  // The transaction never committed, so there is no promotion at all — which is itself one of the
  // three answers, and the correct one: main was never touched.
  assert.deepEqual(await reopened.promotions({ roomId: "demo", mainPath: f.source }), []);
  assert.equal(await head(f.source), before.head);
  assert.equal(await treeDigest(f.source), before.tree);
  // The approval was not spent, so the same token still works and the owner loses nothing.
  const retried = await reopened.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(retried.promotion.state, "applied");
  assert.equal(retried.mainMutated, true);
});

test("a kill inside the approval-consuming write waits for the owner, and the task stays usable", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const before = { head: await head(f.source), tree: await treeDigest(f.source) };

  const child = await promoteInChildAt(f, approval, token, "approval-consume-write");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await waitForExit(child);
  assert.equal(child.signalCode, "SIGKILL");

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const crashed = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // ⛔ This assertion used to be `state === "rolled-back"`, with the comment "an intent row beside an
  // approval that is still `approved` says unambiguously that no Git command ran". Amendment (T)
  // already demoted that sentence — `candidate_merge_approvals` is a row in the same owner-writable
  // file under the same unkeyed hash, and the eleventh round measured a hook putting `approved`
  // back. What was still carrying this case was the OTHER exemption,
  // `observed.state === "rolled-back" && !trace.spawned`, and amendment (U) is that `!trace.spawned`
  // is an absence: a merge driver was measured supplying it while a `git merge` waited to write.
  //
  // So this is the cost, restated as a measurement rather than as prose. Nothing is wedged, and the
  // owner's step is exactly the one the record prints.
  assert.equal(crashed.state, "applying");
  assert.equal(crashed.observation.code, "MERGE_UNACCOUNTED_FOR_NOTHING_CONCLUDED");
  assert.equal(crashed.pending?.code, "MERGE_IDENTITY_UNACCOUNTED");
  assert.equal(crashed.pending?.release, MERGE_UNACCOUNTED_ABANDON_CONFIRMATION);
  assert.equal(crashed.observation.recovery, undefined,
    "a record that cannot say what happened offered a command anyway");
  assert.equal(await head(f.source), before.head);
  assert.equal(await treeDigest(f.source), before.tree);

  const settled = await ownerEndsTheWait(reopened, f);
  assert.equal(settled.state, "rolled-back");
  assert.equal(settled.observation.code, "APPROVAL_NEVER_SPENT_NO_GIT_COMMAND_RAN");
  assert.equal(await treeDigest(f.source), before.tree, "ending a wait wrote to the repository");

  // The intent row is already claimed by that approval, so the SAME approval cannot start a second
  // promotion — the exclusivity marker doing its job. The owner's route is the ordinary one: reject
  // the stale decision and be asked again. The task is not wedged.
  await assert.rejects(reopened.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  }), /MAIN_MERGE_PROMOTION_ALREADY_STARTED/u);
  await reopened.rejectMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: f.source, decidedBy: "local-web",
    reason: "restarting after a crash",
  });
  const second = await raise(f);
  const retried = await promote(f, second, await grant(f, second));
  assert.equal(retried.promotion.state, "applied");
  assert.equal(f.registry.get(f.task.taskId)?.status, "merged");
});

test("a kill inside the final-result write is resolved by re-observation, not left unknown", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token, "promotion-outcome-write");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await waitForExit(child);
  assert.equal(child.signalCode, "SIGKILL");
  // The merge itself completed before the record could be written — the exact window where a
  // product that trusted its own record would report a merge that happened as not having happened.
  assert.notEqual(await head(f.source), beforeHead);

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const settled = await settledPromotion(reopened, f.source);
  assert.equal(settled.state, "applied");
  assert.equal(settled.observation.code, "AUTHORIZED_MERGE_COMMIT_OBSERVED_IN_MAIN");
  assert.equal(settled.mainHeadAfter, await head(f.source));
  assert.equal(reopened.get(f.task.taskId)?.status, "merged");
  assert.equal(settled.observation.mergePgid, null);
});

/*
 * FINDING 5. Bar item 7 asks for an external process advancing main between the checkout and the
 * commit. Measured here, with a hook that moves `refs/heads/main` while the merge is mid-flight:
 * git detects the race itself and exits 128 with `cannot lock ref 'HEAD'`, main's HEAD ends up on
 * the EXTERNAL commit, and the index carries the merged content. The requirement this test actually
 * guards is that the product does not call that "applied": an authorized merge commit is one whose
 * first parent is the pre-promotion head, and this one's is not.
 */
test("an external process that advances main mid-merge is not reported as an applied promotion", async (t) => {
  const f = await fixture(t);
  const external = (await execFileAsync("git", [
    ...author, "commit-tree", `${await head(f.source)}^{tree}`, "-p", await head(f.source), "-m", "external",
  ], { cwd: f.source })).stdout.trim();
  await hook(f, "pre-merge-commit",
    `#!/bin/sh\ngit update-ref refs/heads/main ${external}\nexit 0\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const result = await promote(f, approval, token);
  assert.equal(result.mainMutated, false, "a merge that lost the ref race was reported as applied");
  assert.notEqual(result.promotion.state, "applied");
  assert.equal(result.promotion.observation.authorizedMergeCommit, false);
  // main really did move, and the record says so rather than claiming the pre-promotion head.
  assert.equal(await head(f.source), external);
  assert.notEqual(external, beforeHead);
  assert.ok((result.promotion.observation.differences ?? []).includes("HEAD"),
    `expected HEAD to be named, got ${JSON.stringify(result.promotion.observation.differences)}`);
  // The candidate is NOT terminal: nothing authorized was applied, so nothing may be marked merged.
  assert.notEqual(f.registry.get(f.task.taskId)?.status, "merged");
});

/*
 * FINDING 6. `MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS` had zero references anywhere in `test/`. The
 * fixture below really does exceed the 30-second recompute deadline — a custom merge driver that
 * sleeps, which `git merge-tree` genuinely invokes (measured) — so the deadline is reached rather
 * than simulated.
 */
test("a preview recompute that exceeds its deadline is a readable state, throttled, and still grantable", async (t) => {
  const gate = join(tmpdir(), `orchestratory-slow-merge-${randomUUID()}`);
  const f = await fixture(t, {
    initial: { "f.txt": "base\n", ".gitattributes": "f.txt merge=slow\n" },
    beforeComplete: async ({ source, candidatePath }) => {
      // Both sides touch the same file, which is what makes git call the driver at all.
      await commit(candidatePath, "f.txt", "candidate side\n", "candidate edit");
      await commit(source, "f.txt", "main side\n", "main edit");
      await execFileAsync("git", ["config", "merge.slow.name", "deliberately slow"], { cwd: source });
      // The configuration is FIXED, so the approval's hook/driver binding never changes; only the
      // external gate file toggles, exactly as the other recovery tests do it.
      await execFileAsync("git", ["config", "merge.slow.driver",
        `sh -c 'if [ -f ${gate} ]; then sleep 300; fi; exit 0'`], { cwd: source });
    },
  });
  t.after(async () => await rm(gate, { force: true }));

  const approval = await raise(f);
  const token = await grant(f, approval);
  // Now the repository becomes one whose recompute cannot finish inside the deadline.
  await writeFile(gate, "slow\n", "utf8");

  const slowStart = Date.now();
  const first = (await f.registry.mergeApprovals({ roomId: "demo", mainPath: f.source }))[0];
  const slowMs = Date.now() - slowStart;
  // The merge simulation's own deadline is 60s; the driver would sleep far past it and is killed.
  assert.ok(slowMs > 60_000, `the fixture did not exceed the deadline (${slowMs}ms)`);
  // A deadline reported as a deadline: an owner whose repository has simply outgrown the budget can
  // tell that apart from a repository that cannot be read.
  assert.equal(first?.bindingCheck?.unavailable, "MAIN_MERGE_PREVIEW_DEADLINE_EXCEEDED");
  assert.equal(first?.state, "approved", "a deadline must not destroy the owner's decision");

  // Killing a merge driver mid-flight leaves git's own `.merge_file_XXXXXX` scratch files behind in
  // the candidate worktree. Removing exactly those, by name, restores the state the approval was
  // bound to — the same "put the external condition back" step every other recovery test performs,
  // and emphatically not a `git clean`, which would take untracked and ignored files with it.
  const debris = (await readdir(f.task.candidatePath))
    .filter((name) => name.startsWith(".merge_file_"));
  assert.ok(debris.length > 0, "the driver was expected to be killed mid-write");
  for (const name of debris) await rm(join(f.task.candidatePath, name), { force: true });

  // The throttle: within the window the answer is reused, so a dialog that polls does not spend
  // another minute — and it still reaches an approvable, actionable state.
  const throttledStart = Date.now();
  const second = (await f.registry.mergeApprovals({ roomId: "demo", mainPath: f.source }))[0];
  const throttledMs = Date.now() - throttledStart;
  assert.ok(throttledMs < MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS,
    `the throttled observation took ${throttledMs}ms`);
  assert.equal(second?.bindingCheck?.unavailable, "MAIN_MERGE_PREVIEW_DEADLINE_EXCEEDED");
  assert.equal(second?.state, "approved");

  // With the external condition gone the owner's decision is still spendable: the deadline cost a
  // reading, never the approval.
  await rm(gate, { force: true });
  const promoted = await promote(f, approval, token);
  assert.equal(promoted.promotion.state, "applied");
  assert.equal(promoted.mainMutated, true);
});

/*
 * FINDING 7. The unresolved-promotion gate ran before the token was checked, so anyone who could
 * name an approval id could make the process hash the whole working tree, repeatedly. The gate still
 * answers first — pointing an owner at their repository rather than at a spent token is the whole
 * reason it is there — but the expensive half is now offered on proof, and refused otherwise.
 */
test("an unauthenticated caller cannot make the unresolved-promotion gate re-read the repository", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const counter = new CountingGitBroker();
  const reopened = new CandidateRegistry(f.data, { gitBroker: counter });
  t.after(() => reopened.close());
  const pgid = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  // Settle it once, so the row is `needs-manual-review` rather than decidable by a pid probe alone.
  await ownerEndsTheWait(reopened, f);
  assert.equal((await settledPromotion(reopened, f.source)).state, "needs-manual-review");

  // A token of the RIGHT SHAPE and the wrong value. Measured the hard way: a 64-character hex string
  // fails `MERGE_APPROVAL_TOKEN_PATTERN` (43 base64url characters) and is refused before the gate is
  // ever reached, which made the first version of this test prove nothing at all — a mutation that
  // disabled the throttle entirely left it green ([[PITFALLS]] #97).
  const wrongToken = "A".repeat(43);
  counter.restorePoints = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(reopened.promoteMainMerge({
      approvalId: approval.id, token: wrongToken, action: MERGE_APPROVAL_GRANT,
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    }), /MAIN_MERGE_PROMOTION_UNRESOLVED|MAIN_MERGE_APPROVAL_TOKEN_INVALID/u);
  }
  assert.ok(counter.restorePoints <= 2,
    `five unauthenticated attempts caused ${counter.restorePoints} full-tree reads`);
});

/** A GitBroker that counts the expensive read, so a cost claim can be asserted instead of timed. */
class CountingGitBroker extends GitBroker {
  restorePoints = 0;
  override async restorePoint(
    workspace: string, additionalAttributePaths?: readonly string[],
  ): ReturnType<GitBroker["restorePoint"]> {
    this.restorePoints += 1;
    return await super.restorePoint(workspace, additionalAttributePaths);
  }
}

/*
 * FINDING 1 (f). `owner_pid` carried the same defect as the pgid, one level up, and the project's
 * own threat model already said so about `owner_pid` in another context (F20). After a reboot the
 * number names some unrelated process, `kill(pid, 0)` answers "yes", and an `applying` row waits on
 * it for the rest of its life — while a reboot is one of the likeliest ways a promotion is left
 * unresolved in the first place. It is now scoped to the boot it was recorded in.
 */
test("an owning process id from a previous boot does not keep a promotion waiting", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const first = new CandidateRegistry(f.data);
  const pgid = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  first.close();

  // A LIVE pid in the owner slot — this very test process — with the recorded boot left alone. The
  // row now looks exactly like a promotion still running in another window, and is left alone.
  rewritePromotionRow(f.path, () => ({ ownerPid: process.pid }));
  const waiting = new CandidateRegistry(f.data);
  t.after(() => waiting.close());
  const blocked = readable((await waiting.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(blocked.state, "applying");
  assert.equal(blocked.pending?.code, "OWNER_PROCESS_STILL_RUNNING");
  assert.equal(blocked.pending?.pid, process.pid);
  assert.equal(blocked.ownerAlive, true);
  waiting.close();

  // The same live pid, recorded against a boot that is not this one. It cannot be that process, so
  // the record stops waiting on it and answers from the repository instead.
  rewritePromotionRow(f.path, ({ observation }) => ({
    observation: { ...observation, ownerBootAtSec: 1_000 },
  }));
  const afterReboot = new CandidateRegistry(f.data);
  t.after(() => afterReboot.close());
  // The owner pid is ruled out by its boot, which is this test's subject. The merge group still has
  // to be accounted for by a person (amendment (T)), and that is one call rather than a wall.
  await ownerEndsTheWait(afterReboot, f);
  const settled = await settledPromotion(afterReboot, f.source, 50);
  assert.equal(settled.state, "needs-manual-review");
  assert.equal(settled.pending, undefined);
  assert.ok((settled.observation.differences ?? []).length > 0, "no differences were named");
});

/*
 * FINDING 7 (d). The `from === 1` / `from === 3` upgrade branches are additive at the STORAGE layer
 * and were described as supported on that basis. They are not: a candidate completed before
 * `a75e904` carries a `completion_json` the current reader rejects, so the whole registry — the
 * authoritative candidates and checkpoints included — fails to open with a generic
 * `CANDIDATE_COMPLETION_PREVIEW_INVALID` that names neither the cause nor the version.
 *
 * This is not a fix; it is a fail-loud, searchable NAME, asked before any DDL runs so the database
 * is left untouched and gives the same answer on every open. The gap itself stays in the residual
 * risk table, with the condition under which it stops being acceptable.
 */
test("a pre-v4 database whose completions this release cannot read is refused by name", async (t) => {
  const f = await fixture(t);
  f.registry.close();

  const db = new DatabaseSync(f.path);
  const candidate = db.prepare("SELECT * FROM candidates WHERE task_id=?")
    .get(f.task.taskId) as unknown as Record<string, unknown>;
  // A completion shape from before the current preview validator existed. The row hash is
  // recomputed, so this is a legitimately-stored old row rather than a tampered one — the whole
  // point is that the row is INTACT and still unreadable.
  const completionJson = JSON.stringify({ id: randomUUID(), summary: "old", preview: "not-an-object" });
  const candidateHash = createHash("sha256").update(JSON.stringify([
    candidate.task_id, candidate.candidate_id, candidate.room_id, candidate.main_path,
    candidate.main_branch, candidate.base_main_head, candidate.candidate_path,
    candidate.candidate_branch, candidate.task_text, candidate.acceptance_criteria,
    candidate.status, candidate.baseline_json, completionJson, candidate.created_at_ms,
    candidate.updated_at_ms, candidate.completed_at_ms,
  ]), "utf8").digest("hex");
  assert.equal(Number(db.prepare("UPDATE candidates SET completion_json=?,row_hash=? WHERE task_id=?")
    .run(completionJson, candidateHash, f.task.taskId).changes), 1);
  db.exec(`DROP TABLE candidate_merge_promotions;
    DROP TABLE candidate_merge_approvals;
    PRAGMA user_version=3;`);
  db.close();

  assert.throws(
    () => new CandidateRegistry(f.data),
    /CANDIDATE_REGISTRY_PRE_V4_COMPLETION_UNSUPPORTED/u,
  );
  // Asked before the DDL, so the refusal is stable: the database is still v3 and still says the same
  // thing, rather than becoming a half-upgraded v5 that fails for a different reason next time.
  const after = new DatabaseSync(f.path);
  assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
  after.close();
  assert.throws(
    () => new CandidateRegistry(f.data),
    /CANDIDATE_REGISTRY_PRE_V4_COMPLETION_UNSUPPORTED/u,
  );
});

/**
 * A pid that exists and belongs to somebody else, discovered rather than hardcoded.
 *
 * `kill(pid, 0)` on it raises `EPERM`, which is the only way to reach that branch without being
 * root. Returns undefined when this machine cannot produce one (running as root, or a container
 * with no foreign processes), and the caller says so loudly instead of passing quietly.
 */
function foreignPid(): number | undefined {
  const mine = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (mine === undefined || mine === 0) return undefined;
  let listing = "";
  try {
    listing = execFileSync("ps", ["-A", "-o", "pid=,uid="], { encoding: "utf8" });
  } catch { return undefined; }
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid <= 1 || Number(match[2]) === mine) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return pid;
    }
  }
  return undefined;
}

/*
 * FINDING 1 (g), found by the coordinator's own mutation rather than by mine.
 *
 * `probe()` classifies `EPERM` as "this pid exists and is not ours". That is one of this round's
 * load-bearing decisions: the previous code read any non-`ESRCH` error as "our merge is still
 * writing", so somebody else's recycled pid could keep a finished promotion unresolvable forever.
 * A mutation flipping `EPERM` back to "alive" left all 59 tests green — the branch had no test in
 * EITHER direction, mine included, and the second round's own N-2 mutation had missed it too.
 */
test("a process group id now held by another user is not our merge, and does not block the answer", async (t) => {
  const other = foreignPid();
  assert.ok(other !== undefined,
    "this machine could not produce a foreign pid, so the EPERM branch was not exercised");
  if (other === undefined) return;
  // The premise, asserted rather than assumed: this pid really does answer EPERM.
  assert.throws(() => process.kill(other, 0), (error: NodeJS.ErrnoException) => error.code === "EPERM");

  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const first = new CandidateRegistry(f.data);
  const recorded = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  assert.ok(typeof recorded === "number" && recorded > 1);
  process.kill(-recorded, "SIGKILL");
  await waitForGroupExit(recorded);
  first.close();

  // Exactly the shape a wrapped-around or reboot-reused pid produces: the number in the record is
  // now a live process belonging to somebody else. Nothing else about the row is touched.
  rewritePromotionRow(f.path, ({ observation }) => ({
    observation: {
      ...observation,
      mergePgid: other,
      mergeGroup: { ...(observation.mergeGroup as Record<string, unknown>), pgid: other },
    },
  }));

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  // `foreign` still means "not our merge", which is the finding. Amendment (T) only changed who
  // gets to turn that into a conclusion.
  await ownerEndsTheWait(reopened, f);
  const settled = await settledPromotion(reopened, f.source, 50);
  assert.notEqual(settled.state, "applying",
    "a pid belonging to another user was treated as proof our merge was still writing");
  assert.equal(settled.state, "needs-manual-review");
  assert.equal(settled.pending, undefined);
  // Both directions of the record, not just the decision: the number AND its identity are written
  // out as null, so nothing carries it into the next observation.
  assert.equal(settled.observation.mergePgid, null);
  assert.equal(settled.observation.mergeGroup, null);
  assert.ok((settled.observation.differences ?? []).length > 0, "no differences were named");
  // And the foreign process is still exactly where it was: nothing here signals anything.
  assert.throws(() => process.kill(other, 0), (error: NodeJS.ErrnoException) => error.code === "EPERM");
});

/*
 * FINDING 1 (h). The fourth answer `probe()` can give — neither "it is there", nor "it is gone",
 * nor "it is somebody else's" — is the one that must NOT settle: concluding over a group nobody
 * could decide about is publishing a verdict on a repository that may still be being written.
 *
 * The comment that used to be here said this branch was unreachable through the public surface,
 * because `kill(pid, 0)` with a validated positive integer returns only `ESRCH` or `EPERM` on POSIX.
 * That was wrong, and the sixth-round review measured it: nothing validated that the recorded number
 * was a PID, and any value at or above 2^31 makes `process.kill` throw `ERR_INVALID_ARG_TYPE`, which
 * is neither. The test for that reachable route is "a recorded process group too large to be a pid"
 * below; it needs no monkey-patching at all.
 *
 * This test stays, because it covers a different input: an errno that is neither `ESRCH` nor `EPERM`
 * on a number that IS a plausible pid. It replaces the global `process.kill` for ONE pid — the same
 * function the module calls — so the branch really executes. It proves the classification and the
 * release path, and it does NOT prove anything about a real operating system producing that error;
 * that limit is the reason it is written down here.
 */
test("a process group nobody can decide about blocks the answer, and the owner can release it", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const first = new CandidateRegistry(f.data);
  const recorded = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  process.kill(-recorded, "SIGKILL");
  await waitForGroupExit(recorded);
  first.close();

  const undecidable = 999_983;
  rewritePromotionRow(f.path, ({ observation }) => ({
    observation: {
      ...observation,
      mergePgid: undecidable,
      mergeGroup: { ...(observation.mergeGroup as Record<string, unknown>), pgid: undecidable },
    },
  }));

  const real = process.kill.bind(process);
  t.after(() => { process.kill = real; });
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid === undecidable || pid === -undecidable) {
      const error = new Error("kill: cannot be decided") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return real(pid, signal as never);
  }) as typeof process.kill;

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // Undecidable is not "finished". It blocks exactly as a running merge does, but under its own
  // name, so it can be seen rather than silently waited on.
  assert.equal(blocked.state, "applying");
  assert.equal(blocked.pending?.code, "MERGE_PROCESS_GROUP_UNDECIDABLE");
  assert.equal(blocked.pending?.pid, undecidable);
  assert.equal(blocked.pending?.release, MERGE_GROUP_ABANDON_CONFIRMATION);
  assert.equal(blocked.observation.mergePgid, undecidable);

  // And it has the same way out as any other blocked wait, so an undecidable probe cannot retire a
  // task permanently either.
  const released = await reopened.abandonMergeProcessGroup({
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pgid: undecidable,
    confirmation: MERGE_GROUP_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });
  assert.equal(released.state, "needs-manual-review");
  assert.equal(released.pending, undefined);
  assert.equal(released.observation.mergeGroupDisowned?.pgid, undecidable);
});

// ---------------------------------------------------------------------------------------------
// Round 4. Bar item 3 named four configuration keys; a name list is not a criterion.
// ---------------------------------------------------------------------------------------------

/*
 * FINDING P0. `hookEnvironment()` bound `core.hooksPath`, the hook files, `merge.*.driver` and
 * `filter.*`. It did not bind `commit.gpgsign` or `gpg.program` — so a candidate worktree, which
 * shares main's common `.git`, could write both AFTER the owner approved, and `git merge --no-ff`
 * executed that program as the owner while all three defences (the binding, the disclosure and the
 * re-verification before the token is spent) saw nothing at all. Measured on a real repository.
 *
 * The fix is not a longer list. What is bound now is main's WHOLE effective configuration under the
 * promotion environment, so a key this code has never heard of is caught by the same mechanism —
 * which is what the last two cases below assert, one of them with a key that exists nowhere in git.
 */
for (const attack of [
  {
    label: "a signing program (gpg.program) installed after the owner approved",
    keys: [["commit.gpgsign", "true"], ["gpg.program", "@SCRIPT@"]],
    executes: true,
  },
  {
    label: "core.sshCommand, which no list in this file mentioned before",
    keys: [["core.sshCommand", "@SCRIPT@"]],
    executes: false,
  },
  {
    label: "credential.helper, which can name a shell snippet",
    keys: [["credential.helper", "!@SCRIPT@"]],
    executes: false,
  },
  {
    label: "a key that does not exist in any version of git, so no enumeration could contain it",
    keys: [["future.someTool.program", "@SCRIPT@"]],
    executes: false,
  },
]) {
  // `executes: false` means git does not invoke that program during a local merge in the first
  // place, so "the marker is absent" is trivially true for those three; what they assert is the
  // REFUSAL, and that it comes from the binding rather than from any list of key names. Only the
  // first case asserts its own premise, because only it can.
  test(`main's config is bound: ${attack.label} is refused and does not run`, async (t) => {
    const f = await fixture(t);
    const approval = await raise(f);
    const token = await grant(f, approval);
    const beforeHead = await head(f.source);

    // Written from inside the CANDIDATE worktree with no access to main's directory: a linked
    // worktree shares the common git dir, so `git config --local` here writes MAIN's config.
    const marker = join(f.root, "program-ran");
    const script = join(f.root, "program.sh");
    await writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    for (const [key, value] of attack.keys) {
      await execFileAsync("git", ["config", "--local", key as string, (value as string).replace("@SCRIPT@", script)],
        { cwd: f.task.candidatePath });
    }
    // The premise for the first case, asserted rather than assumed: without the product involved at
    // all, a plain `git merge` in this repository really does execute that program.
    if (attack.executes) {
      const proof = join(f.root, "proof");
      await execFileAsync("git", ["clone", "--quiet", f.source, proof]);
      await execFileAsync("git", ["config", "user.email", "t@localhost"], { cwd: proof });
      await execFileAsync("git", ["config", "user.name", "t"], { cwd: proof });
      await execFileAsync("git", ["checkout", "--quiet", "-b", "side"], { cwd: proof });
      await execFileAsync("git", ["commit", "--allow-empty", "--no-gpg-sign", "-m", "side"], { cwd: proof });
      await execFileAsync("git", ["checkout", "--quiet", "-"], { cwd: proof });
      await execFileAsync("git", ["config", "commit.gpgsign", "true"], { cwd: proof });
      await execFileAsync("git", ["config", "gpg.program", script], { cwd: proof });
      await execFileAsync("git", ["merge", "--no-ff", "--no-edit", "side"], { cwd: proof })
        .catch(() => undefined);
      assert.equal(await exists(marker), true, "git does not run this program at all in this setup");
      await rm(marker, { force: true });
    }

    await assert.rejects(
      promote(f, approval, token),
      (error: Error) => /MAIN_MERGE_APPROVAL_BINDING_CHANGED/u.test(error.message),
      "a program installed after approval was not refused",
    );
    assert.equal(await exists(marker), false, "the program ran");
    assert.equal(await head(f.source), beforeHead, "main moved");
    assert.equal((await f.registry.status({ roomId: "demo", mainPath: f.source }))
      .find((entry) => entry.taskId === f.task.taskId)?.status, "completed");
  });
}

/*
 * The other half, and the one that holds even when the program was configured BEFORE the owner
 * looked — where there is no drift to notice. `promotionGitEnvironment` pins the behaviours that
 * reach a configured program, with command-line precedence, so `.git/config` cannot switch them on.
 * A promotion merge commit is therefore not signed, which is written down rather than discovered.
 */
test("a signing program already configured before the owner looked is disclosed and never runs", async (t) => {
  const marker = join(await mkdtemp(join(tmpdir(), "orchestratory-gpgpin-")), "signer-ran");
  const f = await fixture(t, {
    beforeComplete: async ({ source }) => {
      const script = join(source, "..", "signer.sh");
      await writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
      await execFileAsync("git", ["config", "commit.gpgsign", "true"], { cwd: source });
      await execFileAsync("git", ["config", "gpg.program", script], { cwd: source });
      await execFileAsync("git", ["config", "merge.verifySignatures", "true"], { cwd: source });
    },
  });

  // Itemised on the approval screen, by key. The values are deliberately not there: this list is
  // rendered to the owner and `credential.helper` can carry a secret. They are covered by the digest.
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  const programs = preview.hooks.programs ?? [];
  assert.deepEqual([...programs].sort(),
    ["commit.gpgsign", "gpg.program", "merge.verifysignatures"]);
  assert.equal(typeof preview.hooks.configDigest, "string");
  assert.ok(!JSON.stringify(programs).includes("signer.sh"), "a config VALUE reached the approval screen");

  const approval = await raise(f);
  const result = await promote(f, approval, await grant(f, approval));
  assert.equal(result.promotion.state, "applied");
  assert.equal(await exists(marker), false, "the configured signing program was executed");
  // And the consequence, stated: the merge commit this product made carries no signature.
  const signature = await execFileAsync("git", ["log", "-1", "--format=%G?"], { cwd: f.source });
  assert.equal(signature.stdout.trim(), "N");
});

/*
 * FINDING P2 (mutation D). "Not read" and "read, and no hook ran" are different facts, and the code
 * kept them apart — with nothing testing it. Turning both `return null`s into `return []` left all
 * 61 tests green, which means the distinction was documented and unguarded.
 */
test("a hook trace that could not be read is absent, not an empty list of hooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-trace-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  assert.equal(await readExecutedHooks({ path: join(root, "does-not-exist.jsonl") }), null,
    "a trace that does not exist must not read as 'no hooks ran'");
  await mkdir(join(root, "a-directory.jsonl"));
  assert.equal(await readExecutedHooks({ path: join(root, "a-directory.jsonl") }), null);

  // Read, and genuinely empty of hooks: git wrote a trace, no `child_class:"hook"` event is in it.
  const empty = join(root, "empty.jsonl");
  await writeFile(empty, `${JSON.stringify({ event: "version", sid: "s" })}\n`, "utf8");
  assert.deepEqual(await readExecutedHooks({ path: empty }), []);

  // And one that did record a hook, so the empty answer above is not simply what this always says.
  const one = join(root, "one.jsonl");
  await writeFile(one, [
    JSON.stringify({ event: "child_start", sid: "s", child_id: 0, child_class: "hook", hook_name: "pre-merge-commit", argv: ["/x/pre-merge-commit"] }),
    JSON.stringify({ event: "child_exit", sid: "s", child_id: 0, code: 3 }),
    "",
  ].join("\n"), "utf8");
  assert.deepEqual(await readExecutedHooks({ path: one }),
    [{ name: "pre-merge-commit", path: "/x/pre-merge-commit", exitCode: 3 }]);
});

/*
 * AMENDMENT (Y-2), at the function boundary, because that is the only place this leg is reachable.
 *
 * Through the product, every hook-based doctoring of a trace is caught one leg earlier — the hook is
 * a child git started, so either its `child_start` is still on the inode the descriptor holds, or
 * git's own later `child_exit` is left as an orphan. Asserting the pid comparison through
 * `promoteMainMerge` therefore measures the other legs ([[PITFALLS]] #129: the attack must actually
 * reach the gate under test). What the pid is FOR is a trace doctored by something that is not a
 * child of this merge at all — a process the merge left behind, editing the file after the merge has
 * exited — and the honest way to test that is to hand this function the two traces directly.
 */
test("a top-level session is only the leader's when it carries the pid this process spawned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-leadersid-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const trace = async (name: string, sid: string): Promise<string> => {
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify({ event: "start", sid, argv: ["git", "merge"] })}\n`, "utf8");
    return path;
  };
  // Measured on git 2.50.1: the pid is the last field of the session id, in hex, zero-padded.
  const leader = await trace("leader.jsonl", "20260809T000000.000000Z-Habcdef01-P000131a4");
  assert.equal(await readLeaderSessionOpened({ path: leader }, 0x131a4), true);
  assert.equal(await readLeaderSessionOpened({ path: leader }, 0x131a5), false,
    "a top-level session belonging to another git answered for this promotion");
  assert.equal(await readLeaderSessionOpened({ path: leader }, null), false,
    "no pid in hand is not the same as a matching pid");

  // A forged flat session id with an invented pid — the `k4` shape, with nothing else in the file.
  const forged = await trace("forged.jsonl", "20260809T000000.000000Z-Hdeadbeef-P0000f4b7");
  assert.equal(await readLeaderSessionOpened({ path: forged }, 0x131a4), false,
    "a forged top-level session id stood in for the session this process started");

  // And a session id git no longer spells this way is an unanswered question, never a yes.
  const unshaped = await trace("unshaped.jsonl", "20260809T000000.000000Z-Habcdef01");
  assert.equal(await readLeaderSessionOpened({ path: unshaped }, 0x131a4), false);
  const nested = await trace("nested.jsonl",
    "20260809T000000.000000Z-Habcdef01-P000131a4/20260809T000001.000000Z-Habcdef01-P000131a4");
  assert.equal(await readLeaderSessionOpened({ path: nested }, 0x131a4), false,
    "a nested session stood in for the top-level one");

  // Seventeenth round. Only a `start` OPENS a session, and that restriction had no assertion of its
  // own. git writes `atexit` — and, once a hook has emptied the file, the `child_exit` for that very
  // hook — under the leader's own flat session id carrying the leader's own pid. A reader that
  // accepted any event would therefore let git's own CLOSING events stand in for the opening ones
  // that were just erased, and the pid comparison would agree with it, because the pid genuinely is
  // the leader's. This is asserted here rather than through `promoteMainMerge` for the reason the
  // comment above this test gives: through the product that shape is caught one leg earlier.
  const closingOnly = join(root, "closing-only.jsonl");
  await writeFile(closingOnly, [
    JSON.stringify({ event: "atexit", sid: "20260809T000000.000000Z-Habcdef01-P000131a4", code: 0 }),
    JSON.stringify({
      event: "child_exit", sid: "20260809T000000.000000Z-Habcdef01-P000131a4", child_id: 0, code: 1,
    }),
    "",
  ].join("\n"), "utf8");
  assert.equal(await readLeaderSessionOpened({ path: closingOnly }, 0x131a4), false,
    "git's own closing events stood in for the `start` a hook had erased");
});

/*
 * FINDING F4 (mutation J). The guard that refuses to disown the merge of a promotion whose OWNER
 * process is still alive had no test at all: deleting the line left all 61 green. Its own comment
 * says why it exists — "disowning its merge would let two readers describe one repository" — and it
 * is the newest write-adjacent owner action in the product.
 */
test("a promotion whose owner process is still running cannot have its merge disowned", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const first = new CandidateRegistry(f.data);
  const pgid = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  assert.ok(typeof pgid === "number" && pgid > 1);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  first.close();

  // Exactly ONE of the two waits may be in the way, or this is the doubly-blocked state, which has
  // its own release and its own test. The merge is ended first so the owner process is the only
  // reason left.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  // A LIVE owner pid — this very test process — so the row looks exactly like a promotion running in
  // another window. Its merge is a merge somebody else is waiting on.
  rewritePromotionRow(f.path, () => ({ ownerPid: process.pid }));
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(blocked.pending?.code, "OWNER_PROCESS_STILL_RUNNING");

  await assert.rejects(
    reopened.abandonMergeProcessGroup({
      promotionId: blocked.id, roomId: "demo", mainPath: f.source, pgid,
      confirmation: MERGE_LIVE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    /MAIN_MERGE_PROMOTION_STILL_OWNED/u,
  );
  // And nothing was written on the way to that refusal.
  const after = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(after.observation.mergeGroupDisowned, undefined);
  assert.equal(after.observation.mergePgid, pgid);
});

/*
 * FINDING F5. `processAlive` read `EPERM` as "alive" while `probe` read it as "belongs to somebody
 * else, so it is not ours" — two fields of one record, fixed in one round, pointing in opposite
 * directions. The consequence was not cosmetic: an `owner_pid` recycled WITHIN one boot pinned the
 * row on `OWNER_PROCESS_STILL_RUNNING`, `abandonMergeProcessGroup` refused it by name, and
 * `#assertNoUnresolvedPromotion` refused every later approval for that task. No product path out.
 */
test("an owner pid now held by another user is not our process, and does not keep a promotion waiting", async (t) => {
  const other = foreignPid();
  assert.ok(other !== undefined,
    "this machine could not produce a foreign pid, so the EPERM branch was not exercised");
  if (other === undefined) return;
  assert.throws(() => process.kill(other, 0), (error: NodeJS.ErrnoException) => error.code === "EPERM");

  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const first = new CandidateRegistry(f.data);
  const pgid = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  first.close();

  rewritePromotionRow(f.path, () => ({ ownerPid: other }));
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  await ownerEndsTheWait(reopened, f);
  const settled = await settledPromotion(reopened, f.source, 50);
  assert.notEqual(settled.state, "applying",
    "a pid belonging to another user was treated as the orchestrator that started this promotion");
  assert.equal(settled.pending, undefined);
  assert.equal(settled.ownerAlive, null);
  assert.throws(() => process.kill(other, 0), (error: NodeJS.ErrnoException) => error.code === "EPERM");
});

/*
 * FINDING F5, the other half: the exit. Removing the cross-boot and other-user cases still leaves
 * one the operating system can produce — the same user's next process holding that number — and no
 * probe can tell it apart. So there is an owner-side release, shaped exactly like the process-group
 * one, and refusing exactly what that one refuses: a merge that is provably still writing.
 */
test("the owner can stop a promotion waiting on its own owner process, but not while the merge runs", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const first = new CandidateRegistry(f.data);
  const pgid = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  first.close();
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  rewritePromotionRow(f.path, () => ({ ownerPid: process.pid }));
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // Both numbers are alive here, which is its own state and its own release; the narrow owner
  // release is refused and hands over the route rather than the wall it used to be.
  assert.equal(blocked.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");

  const args = {
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pid: process.pid,
    confirmation: MERGE_OWNER_ABANDON_CONFIRMATION, decidedBy: "local-web",
  };
  // While that merge is alive, releasing the owner wait would disown the caller AND the writer at
  // once, and the next read would describe a repository something is still writing.
  await assert.rejects(
    reopened.abandonPromotionOwnerProcess(args),
    (error: Error & { ownerPid?: number; mergePgid?: number; confirmation?: string }) =>
      error.message === "MERGE_ABANDON_REFUSED_BOTH_PROCESSES_RUNNING"
      && error.ownerPid === process.pid && error.mergePgid === pgid
      && error.confirmation === MERGE_PROMOTION_ABANDON_CONFIRMATION,
  );

  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  // Only the owner process is in the way now, and only then does the narrow release apply.
  const owned = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(owned.pending?.code, "OWNER_PROCESS_STILL_RUNNING");
  assert.equal(owned.pending?.pid, process.pid);
  assert.equal(owned.pending?.release, MERGE_OWNER_ABANDON_CONFIRMATION);
  // The phrase and the pid are both required, exactly as for a process group.
  await assert.rejects(
    reopened.abandonPromotionOwnerProcess({ ...args, confirmation: "yes" }),
    /MERGE_OWNER_ABANDON_CONFIRMATION_MISMATCH/u,
  );
  await assert.rejects(
    reopened.abandonPromotionOwnerProcess({ ...args, pid: process.pid + 1 }),
    /MERGE_OWNER_ABANDON_PID_MISMATCH/u,
  );

  const before = await treeDigest(f.source);
  const released = await reopened.abandonPromotionOwnerProcess(args);
  assert.equal(await treeDigest(f.source), before, "releasing the wait wrote to the repository");
  assert.equal(released.observation.ownerProcessDisowned?.pid, process.pid);
  assert.equal(released.observation.ownerProcessDisowned?.decidedBy, "local-web");
  // Amendment (T): this release says one thing — stop waiting for the process that STARTED the
  // promotion. It says nothing about the merge, and the number the record holds for the merge is a
  // number the merge's own hooks can write, so the record goes on naming it until somebody accounts
  // for it. What it must no longer report is the owner process.
  assert.notEqual(released.pending?.code, "OWNER_PROCESS_STILL_RUNNING");
  assert.notEqual(released.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");
  await ownerEndsTheWait(reopened, f);
  // The declaration survives re-reading: it is a decision, not a probe result.
  const again = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(again.observation.ownerProcessDisowned?.pid, process.pid);
  assert.notEqual(again.state, "applying");
  assert.equal(again.pending, undefined);
  // And the task is usable again once the owner restores main themselves.
  await execFileAsync("git", ["reset", "--hard", beforeHead], { cwd: f.source });
  await rm(join(f.source, ".git", "hooks", "pre-merge-commit"), { force: true });
  assert.equal((await settledPromotion(reopened, f.source, 50)).state, "rolled-back");
  const second = await raise(f);
  assert.equal((await promote(f, second, await grant(f, second))).promotion.state, "applied");
});

/*
 * FINDING P2 (exclusivity). The exclusive marker was `approval_id UNIQUE`, which two DIFFERENT
 * approvals over one project satisfy completely. When that was measured the second promotion was
 * refused — by the dirty-working-tree gate, because the first merge had already written something.
 * A gate that holds by coincidence is not a gate, so the marker is now the repository: a partial
 * unique index on `main_path` where `state='applying'`, read before any live gate.
 */
test("one project has one promotion applying at a time, and the second is told so by name", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);

  // A SECOND task over the same main, completed and approved BEFORE anything starts writing — so
  // its refusal cannot come from the first merge having dirtied the tree.
  const second = await f.registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
  });
  await commit(second.candidatePath, "second.txt", "second work\n", "second work");
  await f.registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, summary: "also ready",
  });
  const secondPreview = await f.registry.previewMainMerge({
    taskId: second.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(secondPreview.approvable, true, secondPreview.blockers.join(","));
  const secondApproval = await f.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, completionId: secondPreview.completionId,
    previewDigest: secondPreview.previewDigest,
  });
  const secondToken = (await f.registry.grantMainMerge({
    approvalId: secondApproval.id, roomId: "demo", mainPath: f.source,
    previewDigest: secondApproval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  })).approvalToken;

  const approval = await raise(f);
  const token = await grant(f, approval);
  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);

  const other = new CandidateRegistry(f.data);
  t.after(() => other.close());
  await assert.rejects(
    other.promoteMainMerge({
      approvalId: secondApproval.id, token: secondToken, action: MERGE_APPROVAL_GRANT,
      taskId: second.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
    "a second promotion into a project already being promoted was not refused by the marker",
  );
  // The second approval was not SPENT on the way to that refusal, and no second intent record was
  // written. (Reading it afterwards does end it — main really is dirty now, because the first merge
  // is writing it, and the drift rule invalidates an approval whose snapshot has stopped describing
  // the repository. That is a different mechanism from this gate, and it is not "consumed".)
  const stored = (await other.mergeApprovals({ roomId: "demo", mainPath: f.source, taskId: second.taskId }))
    .find((entry) => entry.id === secondApproval.id);
  assert.notEqual(stored?.state, "consumed");
  assert.equal((await other.promotions({ roomId: "demo", mainPath: f.source }))
    .filter((entry) => !("unreadable" in entry)).length, 1, "a second promotion record was written");

  // And the marker is the database's, not this function's: a second `applying` row over one main
  // cannot be stored even by something that skips every check above.
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  const row = db.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1").get() as Record<string, unknown>;
  assert.throws(() => db.prepare("INSERT INTO candidate_merge_promotions (id,approval_id,task_id,room_id,main_path,main_branch,candidate_head,recovery_ref,main_head_before,main_head_after,restore_json,observation_json,state,owner_pid,started_at_ms,updated_at_ms,row_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), randomUUID(), String(row.task_id), String(row.room_id), String(row.main_path),
      String(row.main_branch), String(row.candidate_head), `${String(row.recovery_ref)}-2`,
      String(row.main_head_before), null, String(row.restore_json), String(row.observation_json),
      "applying", 1, Number(row.started_at_ms), Number(row.updated_at_ms), String(row.row_hash)),
    /UNIQUE|constraint/iu);

  child.kill("SIGKILL");
  await waitForExit(child);
  const pgid = readable((await other.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  if (typeof pgid === "number" && pgid > 1) {
    process.kill(-pgid, "SIGKILL");
    await waitForGroupExit(pgid);
  }
});

/*
 * The exclusive marker on an existing database. A v5 database written by an earlier commit of this
 * branch is schema-current and has no such index, so it would be exclusive on paper and not in the
 * store — the shape [[PITFALLS]] #100 is about: the storage upgrade is fine and the READING layer is
 * where the hole is. Creating it at open is idempotent; failing to create it means the invariant is
 * already broken, and that is a named refusal to open rather than a silent downgrade.
 */
test("a database written before the exclusive marker existed gets it, or is refused by name", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  assert.equal((await promote(f, approval, await grant(f, approval))).promotion.state, "applied");
  f.registry.close();

  const dropped = new DatabaseSync(f.path);
  dropped.exec("DROP INDEX candidate_merge_promotions_applying");
  dropped.close();

  const upgraded = new CandidateRegistry(f.data);
  const check = new DatabaseSync(f.path);
  assert.ok(check.prepare("SELECT sql FROM sqlite_schema WHERE name='candidate_merge_promotions_applying'").get(),
    "the exclusive marker was not created on an existing database");
  check.close();
  upgraded.close();

  // Now the same database with the invariant ALREADY broken: two `applying` rows over one main.
  const broken = new DatabaseSync(f.path);
  broken.exec("DROP INDEX candidate_merge_promotions_applying");
  const row = broken.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1").get() as Record<string, unknown>;
  for (const suffix of ["a", "b"]) {
    broken.prepare("INSERT INTO candidate_merge_promotions (id,approval_id,task_id,room_id,main_path,main_branch,candidate_head,recovery_ref,main_head_before,main_head_after,restore_json,observation_json,state,owner_pid,started_at_ms,updated_at_ms,row_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), randomUUID(), String(row.task_id), String(row.room_id), String(row.main_path),
        String(row.main_branch), String(row.candidate_head), `${String(row.recovery_ref)}-${suffix}`,
        String(row.main_head_before), null, String(row.restore_json), String(row.observation_json),
        "applying", 1, Number(row.started_at_ms), Number(row.updated_at_ms), String(row.row_hash));
  }
  broken.close();

  assert.throws(() => new CandidateRegistry(f.data),
    /CANDIDATE_MERGE_PROMOTION_MAIN_PATH_NOT_EXCLUSIVE/u);
  // And the refusal is stable: nothing was deleted or rewritten to make the database fit.
  const after = new DatabaseSync(f.path);
  assert.equal(Number((after.prepare(
    "SELECT COUNT(*) c FROM candidate_merge_promotions WHERE state='applying'").get() as { c: number }).c), 2);
  after.close();
  assert.throws(() => new CandidateRegistry(f.data),
    /CANDIDATE_MERGE_PROMOTION_MAIN_PATH_NOT_EXCLUSIVE/u);
});

/*
 * The upgrade path for this round's binding change, asked the way [[PITFALLS]] #100 says to ask it:
 * open a row the PREVIOUS commit would have written and check that every read/write surface still
 * works. An approval stored before main's configuration was bound carries a `previewDigest` computed
 * without it, so the recomputation no longer matches — and the answer has to be a named refusal that
 * frees the task, not a wedge and not a silent acceptance of a snapshot that was never checked.
 */
test("an approval whose snapshot predates the configuration binding cannot write main, and frees the task", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  f.registry.close();

  // Promotion facts, hook inventory and ignored fingerprint all present — and no record of main's
  // configuration, because on that commit nothing bound it.
  rewindPreview(f.path, f.task.taskId, (preview) => {
    const hooks = (preview.promotion as { hooks: Record<string, unknown> }).hooks;
    delete hooks.programs;
    delete hooks.configDigest;
  });

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  await assert.rejects(
    reopened.promoteMainMerge({
      approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_APPROVAL_BINDING_CHANGED|PREVIEW_PREDATES_PROMOTION_GATES/u,
    "an approval that was never checked against main's configuration was allowed to write main",
  );
  assert.equal(await head(f.source), approval.binding.mainHead, "main moved");
  // Terminal, so the one open question per task is released rather than held by a row nobody can use.
  const stored = storedApproval(f.path, approval.id);
  assert.ok(stored.state === "invalidated" || stored.state === "rejected", stored.state);
  const listed = await reopened.mergeApprovals({ roomId: "demo", mainPath: f.source });
  assert.equal(listed.length, 1);
  assert.notEqual(listed[0]?.state, "approved");

  // And the owner can be asked again against a snapshot that HAS been checked against it.
  const second = await raise({ ...f, registry: reopened });
  const result = await promote({ ...f, registry: reopened }, second,
    await grant({ ...f, registry: reopened }, second));
  assert.equal(result.promotion.state, "applied");
});

/*
 * FINDING F-A (fourth round). The two releases added last round refuse each other, and each refusal
 * is right on its own — but together they were a cycle. Measured on a real promotion whose merge had
 * been killed outright and whose two recorded numbers had been recycled to live processes of the
 * same user within one boot ([[PITFALLS]] #105's shape): `abandonMergeProcessGroup` answered
 * `MAIN_MERGE_PROMOTION_STILL_OWNED`, `abandonPromotionOwnerProcess` answered
 * `MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING`, and the task could never be promoted again. Bar item
 * 11 forbids exactly that. Both waits therefore open together, behind one phrase that says so.
 */
test("both of a promotion's waits can be opened together when neither can be opened alone", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const first = new CandidateRegistry(f.data);
  const pgid = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  assert.ok(typeof pgid === "number" && pgid > 1);
  first.close();
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  // Both numbers alive at once: the merge leader really is (it is sleeping in the hook), and the
  // owner pid is this very test process, which is what a recycled number looks like from inside.
  rewritePromotionRow(f.path, () => ({ ownerPid: process.pid }));
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(blocked.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");
  assert.equal(blocked.pending?.pid, process.pid);
  assert.equal(blocked.pending?.alsoBlockedBy?.pid, pgid);
  assert.equal(blocked.pending?.release, MERGE_PROMOTION_ABANDON_CONFIRMATION);
  // Everything the record offers here only LOOKS. A promotion that may still be writing main must
  // never be handed a command that writes ([[PITFALLS]] #94).
  for (const command of [blocked.pending?.inspect ?? "", blocked.pending?.alsoBlockedBy?.inspect ?? ""]) {
    assert.ok(command.length > 0 && !/reset|kill|clean|checkout/u.test(command), command);
  }

  // Neither narrow release works, and neither is a wall any more: both hand back both pids and the
  // phrase that does work. This is the assertion the cycle would fail.
  const doublyBlocked = (error: Error & {
    ownerPid?: number; mergePgid?: number; confirmation?: string; inspect?: readonly string[];
  }): boolean =>
    error.message === "MERGE_ABANDON_REFUSED_BOTH_PROCESSES_RUNNING"
    && error.ownerPid === process.pid && error.mergePgid === pgid
    && error.confirmation === MERGE_PROMOTION_ABANDON_CONFIRMATION
    && (error.inspect ?? []).length === 2;
  await assert.rejects(reopened.abandonMergeProcessGroup({
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pgid,
    confirmation: MERGE_LIVE_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }), doublyBlocked);
  await assert.rejects(reopened.abandonPromotionOwnerProcess({
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pid: process.pid,
    confirmation: MERGE_OWNER_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }), doublyBlocked);

  const args = {
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pid: process.pid, pgid,
    confirmation: MERGE_PROMOTION_ABANDON_CONFIRMATION, decidedBy: "local-web",
  };
  // The phrase and BOTH numbers are required: an owner who cannot quote the record has not read it.
  await assert.rejects(
    reopened.abandonPromotionEntirely({ ...args, confirmation: MERGE_OWNER_ABANDON_CONFIRMATION }),
    /MERGE_PROMOTION_ABANDON_CONFIRMATION_MISMATCH/u,
  );
  await assert.rejects(
    reopened.abandonPromotionEntirely({ ...args, pid: process.pid + 1 }),
    /MERGE_OWNER_ABANDON_PID_MISMATCH/u,
  );
  await assert.rejects(
    reopened.abandonPromotionEntirely({ ...args, pgid: pgid + 1 }),
    /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
  );

  const before = await treeDigest(f.source);
  const released = await reopened.abandonPromotionEntirely(args);
  // Nothing was killed, nothing in the repository moved: this releases a record, not a process.
  assert.equal(groupAlive(pgid), true, "abandoning the waits must not kill anything");
  assert.equal(await treeDigest(f.source), before, "abandoning the waits wrote to the repository");
  assert.equal(await head(f.source), beforeHead);
  assert.equal(released.pending, undefined, "the record is still waiting on something");
  assert.equal(released.observation.ownerProcessDisowned?.pid, process.pid);
  assert.equal(released.observation.mergeGroupDisowned?.pgid, pgid);
  assert.equal(released.observation.mergeGroupDisowned?.whileRunning, true);
  assert.equal(released.observation.mergeGroupDisowned?.decidedBy, "local-web");
  // Still no destructive command while that merge may be writing.
  assert.equal(released.observation.recoveryKind, "inspect-live-merge");
  assert.ok(!(released.observation.recovery ?? "").includes("reset"),
    `a destructive recovery was offered mid-merge: ${released.observation.recovery ?? ""}`);
  assert.ok((released.observation.differences ?? []).length > 0, "no differences were named");

  // The declaration survives re-reading: it is a decision, not a probe result.
  const again = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(again.pending, undefined);
  assert.equal(again.observation.ownerProcessDisowned?.pid, process.pid);
  assert.equal(again.observation.mergeGroupDisowned?.pgid, pgid);

  // And this is the whole point: the task is not retired. Once the owner really has ended the merge
  // and put main back themselves, the record converges and the task can be promoted again.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  await execFileAsync("git", ["reset", "--hard", beforeHead], { cwd: f.source });
  await rm(join(f.source, ".git", "hooks", "pre-merge-commit"), { force: true });
  assert.equal((await settledPromotion(reopened, f.source, 50)).state, "rolled-back");
  const second = await raise({ ...f, registry: reopened });
  assert.equal((await promote({ ...f, registry: reopened }, second,
    await grant({ ...f, registry: reopened }, second))).promotion.state, "applied");
});

/*
 * FINDING F-B (fourth round). The exclusive marker is read through `#assertPromotionRow`, so a
 * single row whose hash no longer verifies refused EVERY other task in the project — and the one
 * action that could have cleared it answered `MAIN_MERGE_PROMOTION_NOT_FOUND`, because the reader it
 * uses drops unreadable rows. One corrupted row therefore retired a whole project rather than the
 * one task it belongs to; before the marker existed the same corruption poisoned only its own task.
 * That is [[PITFALLS]] #100 at a new granularity, and bar item 11 again.
 */
test("one unreadable promotion row is named, and does not retire the whole project", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);

  // A second task over the same main, so "the project" is more than the corrupted row's own task.
  const other = await f.registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "other",
  });
  await commit(other.candidatePath, "other.txt", "other work\n", "other work");
  await f.registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: other.taskId, roomId: "demo",
    mainPath: f.source, summary: "also ready",
  });
  // Approved BEFORE anything starts writing, so its later refusal cannot come from a dirty tree.
  const otherPreview = await f.registry.previewMainMerge({
    taskId: other.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(otherPreview.approvable, true, otherPreview.blockers.join(","));
  const otherApproval = await f.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: other.taskId, roomId: "demo",
    mainPath: f.source, completionId: otherPreview.completionId,
    previewDigest: otherPreview.previewDigest,
  });
  const otherToken = (await f.registry.grantMainMerge({
    approvalId: otherApproval.id, roomId: "demo", mainPath: f.source,
    previewDigest: otherApproval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  })).approvalToken;

  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);
  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  f.registry.close();

  const withPgid = new CandidateRegistry(f.data);
  const pgid = readable((await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  withPgid.close();
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  // One byte of corruption in the `applying` row, and nothing else.
  const db = new DatabaseSync(f.path);
  const promotionId = String((db.prepare(
    "SELECT id FROM candidate_merge_promotions WHERE state='applying'").get() as { id: string }).id);
  assert.equal(Number(db.prepare("UPDATE candidate_merge_promotions SET row_hash=? WHERE id=?")
    .run("0".repeat(64), promotionId).changes), 1);
  db.close();

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const listed = (await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0];
  assert.equal(listed?.state, "unreadable");
  assert.equal(unreadable(listed).holdsProjectExclusiveMarker, true);

  /*
   * FINDING F1 (fifth round). `ps -g` proves the `git merge`, its hook and its `sleep` are all
   * alive, and main is already half-applied — and this release accepted the SHORT phrase, ignored
   * the pgid argument entirely (`999999` was taken), and let the project's exclusive marker go while
   * that merge went on writing. The phrase it accepted does not mention main at all.
   *
   * So the precondition is asserted FIRST ([[PITFALLS]] #106): the merge really is alive here.
   */
  assert.equal(groupAlive(pgid), true, "this test is only meaningful while the merge is alive");
  assert.equal(unreadable(listed).release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  assert.deepEqual(
    unreadable(listed).release?.alive.map((entry) => [entry.kind, entry.pid]), [["merge", pgid]],
  );
  // Read-only, like every other command a live merge is described with ([[PITFALLS]] #94).
  for (const alive of unreadable(listed).release?.alive ?? []) {
    assert.ok(alive.inspect.startsWith("ps ") && !/reset|kill|clean|checkout/u.test(alive.inspect), alive.inspect);
  }

  // The other task is refused — an unreadable row is not evidence main is fine — but it is told what
  // is actually wrong. "Somebody is promoting" would send the owner looking for a promotion, and the
  // phrase it hands over is the one that applies right now, not the short one.
  await assert.rejects(
    reopened.promoteMainMerge({
      approvalId: otherApproval.id, token: otherToken, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    (error: Error & { confirmation?: string; alive?: ReadonlyArray<{ pid: number }> }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION
      && (error.alive ?? []).some((entry) => entry.pid === pgid),
  );

  const args = {
    promotionId, roomId: "demo", mainPath: f.source, pgid, decidedBy: "local-web",
  };
  // Neither the ordinary abandon phrase nor the SHORT unreadable phrase releases a marker while a
  // merge that may be writing main is still answering "alive".
  for (const wrong of [MERGE_LIVE_ABANDON_CONFIRMATION, MERGE_UNREADABLE_ABANDON_CONFIRMATION]) {
    await assert.rejects(
      reopened.abandonMergeProcessGroup({ ...args, confirmation: wrong }),
      (error: Error & { confirmation?: string }) =>
        error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
        && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
    );
  }
  // And the pgid argument is not decoration: it used to be ignored outright.
  await assert.rejects(
    reopened.abandonMergeProcessGroup({
      ...args, pgid: 999_999, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
    }),
    /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
  );
  assert.equal(
    unreadable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]).storedState,
    "applying", "a refused release must leave the marker exactly where it was",
  );

  const before = await treeDigest(f.source);
  const released = await reopened.abandonMergeProcessGroup({
    ...args, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
  });
  assert.equal(await treeDigest(f.source), before, "releasing the marker wrote to the repository");
  assert.equal(groupAlive(pgid), true, "releasing the marker must not kill anything");
  // Nothing was repaired and nothing was decided: the row is still unreadable, and it still says so.
  assert.ok("unreadable" in released && released.unreadable);
  assert.equal(released.state, "unreadable");
  assert.equal(released.storedState, "needs-manual-review");
  assert.equal(released.holdsProjectExclusiveMarker, false);
  assert.equal(released.releasedFromExclusiveMarker?.decidedBy, "local-web");
  assert.equal((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]?.state, "unreadable");

  // The project is usable again once the owner has ended the merge and restored main themselves.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  await execFileAsync("git", ["reset", "--hard", beforeHead], { cwd: f.source });
  await rm(join(f.source, ".git", "hooks", "pre-merge-commit"), { force: true });
  const preview = await reopened.previewMainMerge({
    taskId: other.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.approvable, true, preview.blockers.join(","));
  const raised = await reopened.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: other.taskId, roomId: "demo",
    mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  const granted = await reopened.grantMainMerge({
    approvalId: raised.id, roomId: "demo", mainPath: f.source,
    previewDigest: raised.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  });
  const result = await reopened.promoteMainMerge({
    approvalId: raised.id, token: granted.approvalToken, action: MERGE_APPROVAL_GRANT,
    taskId: other.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(result.promotion.state, "applied");
});

/*
 * FINDING P2 (fourth round). `promotionFacts()` has two conditions and only the first had ever been
 * reached by a test: the existing coverage rewinds a database to v4, which drops the `promotion` key
 * outright, so `if (facts === undefined) return undefined` answered before the second condition ran.
 * Mutating the second one away — `return facts` — left every test green ([[PITFALLS]] #106: a green
 * mutation usually means the test never got there). A v5 snapshot that HAS `promotion` and lacks the
 * configuration fields is the shape that reaches it, and it is a real one: it is what every approval
 * written by the previous commit of this branch looks like.
 */
test("a v5 snapshot taken before the configuration fields existed is terminal, not usable", async (t) => {
  // `insideWorkingTree` is the third field, added by amendment (X-1) and refused for the same
  // reason: a snapshot that predates it was never checked against "does this merge write the
  // directory its hooks run from", and a missing field must not be read as the permissive answer.
  //
  // The fourth case is amendment (Y-1) and is NOT a missing field: it is the field in its previous
  // SHAPE, a single string. That snapshot was checked — against one spelling of the hook directory,
  // while the merge writes another — so it is refused for the same reason a missing one is. Without
  // this case the shape check is unreachable and a mutation that accepts the old shape stays green
  // ([[PITFALLS]] #106).
  const downgrades: Array<[string, (hooks: Record<string, unknown>) => void]> = [
    ["configDigest", (hooks) => { delete hooks.configDigest; }],
    ["programs", (hooks) => { delete hooks.programs; }],
    ["insideWorkingTree", (hooks) => { delete hooks.insideWorkingTree; }],
    ["insideWorkingTree as a pre-(Y-1) string", (hooks) => {
      const positions = hooks.insideWorkingTree;
      assert.ok(Array.isArray(positions), "the field is no longer a set, so this downgrade is not one");
      hooks.insideWorkingTree = positions[0] ?? "";
    }],
  ];
  for (const [drop, downgrade] of downgrades) {
    const f = await fixture(t);
    const approval = await raise(f);
    f.registry.close();
    // Current schema throughout: the promotions table stays, the schema version stays, and
    // `promotion` itself stays. Only the two fields that round added are absent, exactly as the
    // commit before it wrote them.
    rewindPreview(f.path, f.task.taskId, (preview) => {
      downgrade((preview.promotion as { hooks: Record<string, unknown> }).hooks);
    });
    assert.equal(schemaVersion(f.path), 6, "the fixture stopped being a current-schema database");

    const reopened = new CandidateRegistry(f.data);
    // Granting is tried FIRST, on a registry that has read nothing yet, so the refusal is produced
    // by the grant path itself rather than inherited from a read that already retired the row.
    await assert.rejects(reopened.grantMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: f.source,
      previewDigest: approval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    }), /PREVIEW_PREDATES_PROMOTION_GATES/u, `dropping ${drop} left the approval grantable`);
    // Terminal and named, so the task's single open-question slot is released rather than held by a
    // row nobody can ever use.
    const listed = await reopened.mergeApprovals({ roomId: "demo", mainPath: f.source });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.state, "invalidated", `dropping ${drop} left the approval usable`);
    const stored = storedApproval(f.path, approval.id);
    assert.equal(stored.state, "invalidated");
    assert.ok((stored.refusal_json ?? "").includes("PREVIEW_PREDATES_PROMOTION_GATES"), stored.refusal_json ?? "");
    // And the slot really is free: the owner can be asked again against a fresh snapshot.
    const second = await raise({ ...f, registry: reopened });
    assert.equal(second.state, "requested");
    reopened.close();
  }
});

/*
 * FINDING P0 (fourth round). The bar's item 3 requires the approval SCREEN to itemise the hooks this
 * promotion would execute and the ignored paths it would silently overwrite; item 10 says an
 * undisclosed one is an unclosed precondition, not a residual risk. Both were recorded as done for
 * four rounds and neither was: `public/room.js` referenced `promotion`, `hooks`, `programs`,
 * `configDigest` and `overwrites` exactly zero times. The hook inventory was at least IN the payload;
 * the overwrite list was not on the approval surface at all, so no amount of rendering could have
 * shown it. This covers the half a browser cannot: that the facts reach the surface.
 *
 * The rendering itself, the scroll gate that now includes it, and every blocker it raises were
 * accepted by driving the real page in a real browser — recorded, with its digest, in
 * docs/VERIFICATION.md ([[PITFALLS]] #83: a regex over source is not a behaviour test).
 */
test("the approval surface carries what would run and what would be silently overwritten", async (t) => {
  const f = await fixture(t, {
    ignore: "secrets.env\n",
    beforeComplete: async ({ candidatePath }) => {
      await writeFile(join(candidatePath, "secrets.env"), "FROM_CANDIDATE=1\n", "utf8");
      await execFileAsync("git", ["add", "-f", "--", "secrets.env"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "track secrets.env"], { cwd: candidatePath });
    },
  });
  const hookPath = await hook(f, "pre-merge-commit", "#!/bin/sh\nexit 0\n");
  const hookSha = createHash("sha256").update(await readFile(hookPath)).digest("hex");
  await execFileAsync("git", ["config", "--local", "merge.custom.driver", "false %A %O %B"], { cwd: f.source });
  // A key git really does execute — under `commit.gpgsign` with `gpg.format=ssh` — that matched
  // nothing in the disclosure expression while its comment claimed to name every such key.
  await execFileAsync("git", ["config", "--local", "gpg.ssh.defaultKeyCommand", "/bin/echo key"], { cwd: f.source });

  const approval = await raise(f);
  // Everything the promotion would execute, on the object the dialog is rendered from.
  const hooks = approval.preview.promotion?.hooks;
  assert.ok(hooks, "the approval carries no record of what the promotion would execute");
  assert.deepEqual(hooks.hooks.map((entry) => [entry.name, entry.sha256]), [["pre-merge-commit", hookSha]]);
  assert.deepEqual(hooks.drivers, ["merge.custom.driver=false %A %O %B"]);
  assert.ok(hooks.programs?.includes("gpg.ssh.defaultkeycommand"),
    `a configuration key git executes was not itemised: ${(hooks.programs ?? []).join(",")}`);
  assert.ok(hooks.programs?.includes("merge.custom.driver"), (hooks.programs ?? []).join(","));
  assert.match(hooks.configDigest ?? "", /^[0-9a-f]{64}$/u);
  // Key names only. One of these keys can carry a secret in its value, and this list is rendered.
  for (const program of hooks.programs ?? []) assert.ok(!program.includes("/bin/echo"), program);

  // Now the owner's local secret appears at a path this merge writes — AFTER the approval, which is
  // exactly when the approval screen is the only place it can still be seen.
  await writeFile(join(f.source, "secrets.env"), "OWNER_LOCAL_SECRET=1\n", "utf8");
  assert.equal(await status(f.source), "", "git itself reports this tree as completely clean");
  const inspected = await f.registry.inspectMergeApproval({
    approvalId: approval.id, roomId: "demo", mainPath: f.source,
  });
  assert.equal(inspected.overwrites.checked, true);
  assert.deepEqual(inspected.overwrites.ignored, ["secrets.env"]);
  assert.deepEqual(inspected.overwrites.untracked, []);
  // And the file still holds the owner's bytes: reading the approval decided nothing.
  assert.equal(await readFile(join(f.source, "secrets.env"), "utf8"), "OWNER_LOCAL_SECRET=1\n");
});

/*
 * FINDING F1/F4 (fifth round), the other direction ([[PITFALLS]] #107: a branch with no coverage
 * looks the same from both sides). Above, the merge is alive and the SHORT phrase is refused. Here
 * nothing is alive, the short phrase is the one that works, and the LONG one is refused — otherwise
 * "refuses the short phrase" could be true simply because the short phrase never works.
 *
 * It also holds the release to bar item 13: `storedState` and `releasedFromExclusiveMarker` used to
 * exist only inside the value the releasing call returned. Every later read collapsed "released" and
 * "still claiming the whole project" back into `{state:"unreadable"}`, so the owner could not tell
 * whether their release had done anything. Every assertion after the release here is made through a
 * DIFFERENT registry instance.
 */
test("an unreadable record whose processes are gone is released with the shorter phrase, and stays released", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const first = new CandidateRegistry(f.data);
  const pgid = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  first.close();
  // Nothing is left alive: the owner process is already dead and the orphaned merge is ended here.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  f.registry.close();

  const db = new DatabaseSync(f.path);
  const promotionId = String((db.prepare(
    "SELECT id FROM candidate_merge_promotions WHERE state='applying'").get() as { id: string }).id);
  db.prepare("UPDATE candidate_merge_promotions SET row_hash=? WHERE id=?").run("0".repeat(64), promotionId);
  db.close();

  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  const listed = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(listed.holdsProjectExclusiveMarker, true);
  assert.equal(listed.storedState, "applying");
  assert.deepEqual(listed.release?.alive, []);
  assert.equal(listed.release?.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);
  assert.equal(listed.releasedFromExclusiveMarker, undefined);

  const args = { promotionId, roomId: "demo", mainPath: f.source, pgid, decidedBy: "local-web" };
  // The longer phrase is for a state this record is not in, and using it is refused rather than
  // treated as "at least as strong".
  await assert.rejects(
    reader.abandonMergeProcessGroup({ ...args, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION }),
    (error: Error & { confirmation?: string }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_ABANDON_CONFIRMATION,
  );
  const before = await treeDigest(f.source);
  const released = await reader.abandonMergeProcessGroup({
    ...args, confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION,
  });
  assert.equal(await treeDigest(f.source), before, "releasing the marker wrote to the repository");
  assert.equal(unreadable(released).storedState, "needs-manual-review");
  assert.equal(unreadable(released).holdsProjectExclusiveMarker, false);
  reader.close();

  // A different instance, a different read, the same two answers — and the release requirement is
  // gone because there is no longer a marker to release.
  const later = new CandidateRegistry(f.data);
  t.after(() => later.close());
  const after = unreadable((await later.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(after.state, "unreadable", "nothing here repairs the row");
  assert.equal(after.storedState, "needs-manual-review");
  assert.equal(after.holdsProjectExclusiveMarker, false);
  assert.equal(after.releasedFromExclusiveMarker?.decidedBy, "local-web");
  assert.match(after.releasedFromExclusiveMarker?.at ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(after.release, undefined);
  // Releasing it twice is refused: the marker is not there to give up a second time.
  await assert.rejects(
    later.abandonMergeProcessGroup({ ...args, confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION }),
    /MAIN_MERGE_PROMOTION_NOT_BLOCKED/u,
  );
  assert.equal(await head(f.source), beforeHead, "no path here may move main");
});

/*
 * FINDING F5 (fifth round). Removing the "only when BOTH waits are in the way" guard from
 * `abandonPromotionEntirely` left all 77 tests green: the existing refusals cover a wrong phrase, a
 * wrong pid and a wrong pgid, and none of them covers a promotion that is in the wrong STATE for
 * this phrase. That guard is the reason the longest phrase cannot be used to skip the narrower,
 * safer confirmation the actual state calls for — the [[PITFALLS]] #107 shape, so both directions
 * are here: merge-only blocked, then owner-only blocked.
 */
test("the release that opens both waits is refused when only one of them is in the way", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  f.registry.close();

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = blocked.observation.mergePgid as number;
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  // Only the merge is in the way: the process that started this died with the `kill -9` above.
  assert.equal(blocked.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  await assert.rejects(reopened.abandonPromotionEntirely({
    promotionId: blocked.id, roomId: "demo", mainPath: f.source,
    pid: process.pid, pgid, confirmation: MERGE_PROMOTION_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }), /MAIN_MERGE_PROMOTION_NOT_DOUBLY_BLOCKED/u);
  // And the narrow release for the state it IS in still works, so the refusal above is not the only
  // thing standing between this record and an exit.
  assert.equal(blocked.pending?.release, MERGE_LIVE_ABANDON_CONFIRMATION);

  // Now the other direction: the merge is over and only the owner process answers "alive". This
  // test process is used as that number, which is exactly what a recycled pid looks like.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  rewritePromotionRow(f.path, () => ({ ownerPid: process.pid }));
  const owned = new CandidateRegistry(f.data);
  t.after(() => owned.close());
  const waiting = readable((await owned.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(waiting.pending?.code, "OWNER_PROCESS_STILL_RUNNING");
  await assert.rejects(owned.abandonPromotionEntirely({
    promotionId: waiting.id, roomId: "demo", mainPath: f.source,
    pid: process.pid, pgid, confirmation: MERGE_PROMOTION_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }), /MAIN_MERGE_PROMOTION_NOT_DOUBLY_BLOCKED/u);
  assert.equal(waiting.pending?.release, MERGE_OWNER_ABANDON_CONFIRMATION);
});

/*
 * FINDING F2 (fifth round). Turning `#overwriteScan`'s catch into a fail-open
 * `{checked:true, ignored:[], untracked:[]}` left all 594 tests green: the only test that named
 * `OVERWRITE_SCAN_*` covered `..._FILE_LIST_TRUNCATED`, and neither the real-failure branch nor the
 * pathspec bound had one. That is not a display concern — the answer travels through
 * `promotionBlockers()` into the gate that decides whether an approval may be raised and whether one
 * may be SPENT, so fail-open there means "the scan broke, therefore no file will be overwritten",
 * and the file it silently overwrites is an ignored one git will not warn about.
 *
 * Both cases here are real failures of the real method: git's own process failing, and a pathspec
 * this product refuses to hand to git. Neither substitutes a return value for the scan.
 */
test("a scan that could not run is a closed gate at preview, named separately from the tree", async (t) => {
  // A pathspec that cannot be passed to git safely. `-dash.txt` is an ordinary, committable file
  // name, and the broker refuses to put it in an argument list rather than hoping `--` holds.
  const dashed = await fixture(t, {
    beforeComplete: async ({ candidatePath }) => {
      await writeFile(join(candidatePath, "-dash.txt"), "candidate\n", "utf8");
      await execFileAsync("git", ["add", "--", "./-dash.txt"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "dashed"], { cwd: candidatePath });
    },
  });
  const preview = await dashed.registry.previewMainMerge({
    taskId: dashed.task.taskId, roomId: "demo", mainPath: dashed.source,
  });
  // The working tree itself is perfectly readable, so this blocker is the ONLY reason — which is
  // what makes it a test of this branch rather than of the one beside it.
  assert.deepEqual(preview.blockers, ["OVERWRITE_SCAN_UNAVAILABLE"]);
  assert.equal(preview.overwrites.checked, false);
  assert.equal(preview.approvable, false);
  // And the owner cannot be ASKED, so there is never an approval to spend.
  await assert.rejects(dashed.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: dashed.task.taskId, roomId: "demo",
    mainPath: dashed.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  }), (error: Error & { blockers?: string[] }) =>
    error.message.startsWith("MAIN_MERGE_PROMOTION_REFUSED")
    && (error.blockers ?? []).includes("OVERWRITE_SCAN_UNAVAILABLE"));

  // The refusal is about this change set, not about the project: a sibling task over the same main
  // is still approvable, so nothing here is a permanent verdict on the repository.
  const sibling = await dashed.registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: dashed.source, task: "sibling",
  });
  await commit(sibling.candidatePath, "plain.txt", "plain\n", "plain work");
  await dashed.registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: sibling.taskId, roomId: "demo",
    mainPath: dashed.source, summary: "ready",
  });
  const recovered = await dashed.registry.previewMainMerge({
    taskId: sibling.taskId, roomId: "demo", mainPath: dashed.source,
  });
  assert.equal(recovered.approvable, true, recovered.blockers.join(","));
});

/*
 * The same gate at the other end: the scan is re-run against LIVE main immediately before the
 * approval is spent, and a failure there must refuse rather than proceed. Reaching that window
 * needs the failure to appear AFTER the approval was granted, so the repository's permissions are
 * removed for the duration of that one scan — the same shape as an external drive dropping out
 * mid-promotion. `untrackedAtPaths` is NOT replaced: the real method runs, spawns a real
 * `git ls-files`, and that process really fails. Only the surrounding environment is arranged.
 */
test("a scan that could not run refuses the promotion at the moment the approval is spent", async (t) => {
  class BreakDuringScan extends GitBroker {
    gitDirectory = "";
    armed = false;
    override async untrackedAtPaths(
      workspace: string, paths: readonly string[],
    ): ReturnType<GitBroker["untrackedAtPaths"]> {
      if (!this.armed) return await super.untrackedAtPaths(workspace, paths);
      await chmod(this.gitDirectory, 0o000);
      try {
        return await super.untrackedAtPaths(workspace, paths);
      } finally {
        await chmod(this.gitDirectory, 0o700);
      }
    }
  }
  const broker = new BreakDuringScan();
  const root = await mkdtemp(join(tmpdir(), "orchestratory-scan-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await commit(source, "README.md", "committed main\n", "initial");
  broker.gitDirectory = join(source, ".git");
  t.after(async () => {
    await chmod(broker.gitDirectory, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const registry = new CandidateRegistry(data, { gitBroker: broker });
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "scan",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
  await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready",
  });
  const f = { root, source, data, path: registry.path, registry, task };
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(source);

  broker.armed = true;
  await assert.rejects(promote(f, approval, token), (error: Error & { blockers?: string[] }) =>
    error.message.startsWith("MAIN_MERGE_PROMOTION_REFUSED")
    && (error.blockers ?? []).includes("OVERWRITE_SCAN_UNAVAILABLE"));
  broker.armed = false;
  await chmod(broker.gitDirectory, 0o700);
  // Nothing was written and nothing was spent: main is where it was, and the same grant still works
  // once the repository can be read again.
  assert.equal(await head(source), beforeHead);
  assert.equal(await status(source), "");
  assert.equal((await promote(f, approval, token)).promotion.state, "applied");
});

/*
 * The scan's other closed gate: a change set with more paths than one bounded pathspec may carry.
 * `OVERWRITE_SCAN_PATHSPEC_TOO_LARGE` had no test either, and it is the branch that decides what
 * happens when a legitimate but very large candidate arrives.
 */
test("a change set with more paths than one bounded pathspec is a closed gate, named", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-pathspec-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await commit(source, "README.md", "committed main\n", "initial");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  // Above the file cap the preview would truncate first, and a truncated preview is a different
  // refusal; this has to be a change set the preview can carry WHOLE.
  const registry = new CandidateRegistry(data, { maxFiles: 2_500 });
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "wide",
  });
  // Gitlinks written straight into the index: 2001 real files would spend one `git cat-file` each on
  // sizes this test never looks at, and the scan counts paths, not bytes.
  const entries = Array.from(
    { length: 2_001 },
    (_, index) => `160000 ${"0".repeat(39)}1 0\tsub/${index}`,
  ).join("\n");
  execFileSync("git", ["update-index", "--index-info"], { cwd: task.candidatePath, input: `${entries}\n` });
  execFileSync("git", [...author, "commit", "-m", "wide"], { cwd: task.candidatePath });
  // A gitlink whose path is missing reads as a deletion, and completion refuses a dirty worktree.
  // An empty directory at each path is what git considers an unmodified, uninitialised submodule.
  for (let index = 0; index < 2_001; index += 1) {
    await mkdir(join(task.candidatePath, "sub", String(index)), { recursive: true });
  }
  await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready",
  });
  const preview = await registry.previewMainMerge({
    taskId: task.taskId, roomId: "demo", mainPath: source,
  });
  assert.equal(preview.preview.filesTruncated, false, "the preview must carry the whole change set here");
  assert.equal(preview.overwrites.checked, false);
  assert.ok(preview.blockers.includes("OVERWRITE_SCAN_PATHSPEC_TOO_LARGE"), preview.blockers.join(","));
  await assert.rejects(registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo",
    mainPath: source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  }), /OVERWRITE_SCAN_PATHSPEC_TOO_LARGE|PREVIEW_/u);
});

/*
 * FINDING F3 (fifth round). Two owner declarations were added to the promotion event with no test
 * looking at what they write, and one of them carried four values — `mainBranch`, `candidateHead`,
 * `recoveryRef`, `mainHeadBefore` — copied straight out of a row whose integrity check had just
 * failed, into the audit chain, under a comment claiming every such field was null.
 *
 * Both are driven through the PRODUCT wiring (`CollaborationService` supplies the chain and the
 * ledger), and both assert the count and the content: an empty chain verifies too.
 */
test("the owner's two release declarations are recorded, attributed, and assert nothing they did not read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-release-audit-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await commit(source, "README.md", "committed main\n", "initial");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  service.ledger.createRoom("demo", source);
  const started = join(root, "hook-entered");
  await writeFile(join(source, ".git", "hooks", "pre-merge-commit"),
    `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`, { encoding: "utf8", mode: 0o700 });

  const task = await service.candidates.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "released",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
  await service.candidates.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready",
  });
  const f = { root, source, data, path: service.candidates.path, registry: service.candidates, task };
  const approval = await raise(f);
  const token = await grant(f, approval);
  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const blocked = readable((await service.candidates.promotions({ roomId: "demo", mainPath: source }))[0]);
  const pgid = blocked.observation.mergePgid as number;
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  // Both numbers alive: the merge really is, and the owner slot is pointed at this live test process.
  rewritePromotionRow(f.path, () => ({ ownerPid: process.pid }));
  const doubly = readable((await service.candidates.promotions({ roomId: "demo", mainPath: source }))[0]);
  assert.equal(doubly.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");
  await service.candidates.abandonPromotionEntirely({
    promotionId: doubly.id, roomId: "demo", mainPath: source, pid: process.pid, pgid,
    confirmation: MERGE_PROMOTION_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });

  const abandoned = service.audit.list({ roomId: "demo" })
    .filter((event) => event.type === "candidate.main-merge-promotion-abandoned");
  assert.equal(service.audit.verify(), true);
  assert.equal(abandoned.length, 1, `expected exactly one record, got ${abandoned.length}`);
  const detail = abandoned[0]?.detail as Record<string, unknown>;
  assert.equal(abandoned[0]?.outcome, "denied");
  assert.equal(detail.decidedBy, "local-web");
  assert.equal(detail.pid, process.pid);
  assert.equal(detail.pgid, pgid);
  assert.equal(detail.whileRunning, true, "the merge really was alive when this was declared");
  assert.equal(detail.mainMutation, false);
  const abandonedLines = service.ledger.listAfter("demo", 0)
    .map((entry) => entry.text).filter((text: string) => text.includes("兩個程序"));
  assert.equal(abandonedLines.length, 1, abandonedLines.join(" | "));
  assert.match(String(abandonedLines[0]), /沒有修改 main，也沒有結束任何程序/u);
  assert.equal(String(abandonedLines[0]).includes(source), false, "the public ledger leaked the project path");

  // --- and the unreadable-row release, whose record must assert nothing it did not read
  const db = new DatabaseSync(f.path);
  const promotionId = String((db.prepare("SELECT id FROM candidate_merge_promotions").get() as { id: string }).id);
  db.prepare("UPDATE candidate_merge_promotions SET state='applying', row_hash=? WHERE id=?")
    .run("0".repeat(64), promotionId);
  db.close();
  const listed = unreadable((await service.candidates.promotions({ roomId: "demo", mainPath: source }))[0]);
  await service.candidates.abandonMergeProcessGroup({
    promotionId, roomId: "demo", mainPath: source,
    pgid: listed.release?.alive.find((entry) => entry.kind === "merge")?.pid ?? Number.NaN,
    confirmation: listed.release?.confirmation ?? "", decidedBy: "local-web",
  });
  const releasedEvents = service.audit.list({ roomId: "demo" })
    .filter((event) => event.type === "candidate.main-merge-unreadable-record-released");
  assert.equal(service.audit.verify(), true);
  assert.equal(releasedEvents.length, 1, `expected exactly one record, got ${releasedEvents.length}`);
  const released = releasedEvents[0]?.detail as Record<string, unknown>;
  // Nothing about the repository is asserted, because nothing about it was read.
  for (const field of ["mainHeadBefore", "mainHeadAfter", "candidateHead", "recoveryRef", "decidedBy"]) {
    if (field === "decidedBy") continue;
    assert.equal(released[field], null, `${field} was asserted from a row whose hash does not verify`);
  }
  assert.equal(released.mainMutation, false);
  assert.equal(released.recordRepaired, false);
  // The row's own copies are still available to look things up with — behind a flag that says where
  // they came from, which is the whole difference between carrying a value and vouching for it.
  assert.equal(released.unverifiedSource, true);
  const unverified = released.unverifiedRowValues as Record<string, unknown>;
  assert.match(String(unverified.candidateHead), /^[0-9a-f]{40}$/u);
  assert.match(String(unverified.mainHeadBefore), /^[0-9a-f]{40}$/u);
  assert.equal(unverified.mainBranch, "main");
  const releasedLines = service.ledger.listAfter("demo", 0)
    .map((entry) => entry.text).filter((text: string) => text.includes("讀不了"));
  assert.equal(releasedLines.length, 1, releasedLines.join(" | "));
  assert.match(String(releasedLines[0]), /仍然讀不了、仍未結案/u);
  assert.equal(service.ledger.verifyChain("demo"), true);
});

/*
 * Bar item 11, the product-side path. `promotions()` and the three releases had no caller anywhere
 * outside this test suite: `grep -rn "promoteMainMerge\|abandonPromotion\|abandonMergeProcessGroup\|
 * promotions(" src/main.ts src/ui src/mcp bin` returned nothing, so the only way an owner could
 * clear a wedged record was to write a Node script against a private SQLite file.
 *
 * This drives the CLI command against a REAL registry and a REAL blocked promotion. Only the
 * allowlist check and the room lookup are left to `main()`.
 */
test("the CLI can see what a promotion is waiting on and release it, without killing anything", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);
  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  f.registry.close();

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const run = async (args: string[]): Promise<string> => await runCandidatePromotionsCommand({
    args, roomId: "demo", mainPath: f.source, registry, decidedBy: "local-cli",
  });
  const listed = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = listed.observation.mergePgid as number;
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  const report = await run([]);
  assert.match(report, new RegExp(`MERGE_SUBPROCESS_STILL_RUNNING \\(pid ${pgid}\\)`, "u"));
  assert.match(report, new RegExp(`ps -o pid,ppid,pgid,stat,lstart,command -g ${pgid}`, "u"));
  assert.match(report, new RegExp(`--pgid ${pgid}`, "u"));
  assert.match(report, /MAY STILL BE WRITING TO MAIN/u);
  // A record that is blocked on a live process is not re-observed at all, so listing leaves this one
  // exactly where it was. That is narrower than "the listing is read-only", which is what this
  // comment used to say and what the CLI header used to print — see the F-3 test below.
  assert.equal(readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]).state, "applying");

  // The phrase and the number are both required through the CLI too.
  await assert.rejects(
    run(["release", listed.id, "--confirm", "STOP WAITING FOR THIS PROCESS GROUP", "--pgid", String(pgid)]),
    /MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING/u,
  );
  await assert.rejects(
    run(["release", listed.id, "--confirm", MERGE_LIVE_ABANDON_CONFIRMATION, "--pgid", String(pgid + 1)]),
    /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
  );

  const before = await treeDigest(f.source);
  const after = await run([
    "release", listed.id, "--confirm", MERGE_LIVE_ABANDON_CONFIRMATION, "--pgid", String(pgid),
  ]);
  assert.match(after, /Released as local-cli\. Nothing was killed and main was not written\./u);
  assert.equal(groupAlive(pgid), true, "the CLI must not kill anything");
  assert.equal(await treeDigest(f.source), before, "the CLI wrote to the repository");
  assert.equal(await head(f.source), beforeHead);
  assert.equal(
    readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]).pending, undefined,
  );
});

/*
 * FINDING F-1 (sixth round). The previous round's fix was only ever measured against a row whose
 * `row_hash` had been zeroed and whose payload was left intact. Real corruption does not pick
 * fields. With `observation_json` destroyed as well, `promotionGroupIdentity()` answered `null`,
 * `mergeGroupState(null)` answered `"none"`, and "none" was read as "no merge is alive": the SHORT
 * phrase was accepted, `--pgid 999999` was accepted, and the project's exclusive marker was handed
 * back while `ps -g` still listed the `git merge`, its hook and its `sleep`. [[PITFALLS]] #85 —
 * "I cannot read this" quietly became "I know, and the news is good".
 *
 * Both shapes are exercised: a payload that is not JSON at all, and a payload that is valid JSON
 * with the group stripped out of it. Then the columns themselves are destroyed, which is the case
 * where the answer is genuinely unavailable — and the requirement there is not "assume the best" but
 * "say so and keep asking for the phrase that admits main may be being written".
 *
 * The precondition is asserted FIRST and re-asserted at each step ([[PITFALLS]] #106): a refusal is
 * only evidence if the merge really is alive while it happens.
 */
test("a promotion row whose payload is destroyed with its hash still names the merge writing main", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);

  const withPgid = new CandidateRegistry(f.data);
  const pgid = readable((await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  withPgid.close();
  f.registry.close();
  assert.ok(typeof pgid === "number" && pgid > 1);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  // The column is the whole point of this round: it holds the number after the payload is gone.
  const columns = new DatabaseSync(f.path);
  const stored = columns.prepare(
    "SELECT merge_pgid, merge_boot_at_sec FROM candidate_merge_promotions WHERE state='applying'",
  ).get() as { merge_pgid: number | null; merge_boot_at_sec: number | null };
  columns.close();
  assert.equal(stored.merge_pgid, pgid, "the merge group was not given a column of its own");
  assert.ok(typeof stored.merge_boot_at_sec === "number");

  // `probeReadable` is `false` in both shapes here and that is not a lost distinction: amendment
  // (O) redefined the field to answer the question it is actually read for — "does an empty `alive`
  // mean nothing is there, or that nothing could be seen" — and while a merge this record names is
  // answering "alive" the honest answer is that nothing has been concluded either way. The
  // distinction between the two payload shapes is still measured, in `recordedGroups` below: the
  // first leaves the column as the only source, the second adds a payload that contradicts it.
  const payloads = [
    // Not JSON at all: the payload answers nothing, so the column is the only source.
    { payload: "this used to be JSON", sources: ["column", "trace"] },
    // Valid JSON, group removed. The column names a group and the payload states there is none:
    // two in-row sources, two answers, and no way to tell which. Amendment (F) — the answer is
    // "unreadable", not "whichever one this code happened to prefer".
    {
      payload: JSON.stringify({
        code: "PROMOTION_STARTED", mainHead: null, observedAt: "1970-01-01T00:00:00.000Z",
      }),
      sources: ["column", "trace"],
    },
  ];
  let promotionId = "";
  for (const { payload, sources } of payloads) {
    promotionId = damagePromotionRow(f.path, { observationJson: payload });
    const reader = new CandidateRegistry(f.data);
    const listed = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    assert.equal(groupAlive(pgid), true, "this assertion is only evidence while the merge is alive");
    // Shown, not merely probed: `ps -g` lists the `git merge` itself, so what follows is a refusal
    // about a write that is demonstrably in flight rather than about an empty process group.
    const listing = await psGroup(pgid);
    assert.match(listing, /git[^\n]*merge/u, `ps -g ${pgid} does not show the merge:\n${listing}`);
    assert.equal(listed.state, "unreadable");
    assert.equal(listed.holdsProjectExclusiveMarker, true);
    // Read from the column, not the payload: the payload no longer says anything.
    assert.deepEqual(listed.release?.alive.map((entry) => [entry.kind, entry.pid]), [["merge", pgid]]);
    assert.equal(listed.release?.probeReadable, false,
      "nothing may be concluded while a number this record names is answering `alive`");
    assert.deepEqual(
      [...new Set((listed.release?.recordedGroups ?? []).map((entry) => entry.source))], sources,
    );
    assert.equal(listed.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
    // Every source that named a number is reported, so a disagreement is shown rather than settled.
    assert.ok((listed.release?.recordedGroups ?? []).some(
      (entry) => entry.source === "column" && entry.pgid === pgid,
    ), JSON.stringify(listed.release?.recordedGroups));
    for (const alive of listed.release?.alive ?? []) {
      assert.ok(alive.inspect.startsWith("ps ") && !/reset|kill|clean|checkout/u.test(alive.inspect), alive.inspect);
    }

    const args = { promotionId, roomId: "demo", mainPath: f.source, pgid, decidedBy: "local-web" };
    // The short phrase says nothing about main being written, and it is refused here by name.
    await assert.rejects(
      reader.abandonMergeProcessGroup({ ...args, confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION }),
      (error: Error & { confirmation?: string; alive?: ReadonlyArray<{ pid: number }> }) =>
        error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
        && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION
        && (error.alive ?? []).some((entry) => entry.pid === pgid),
    );
    // And the number still has to be quoted, which is only possible because it survived.
    await assert.rejects(
      reader.abandonMergeProcessGroup({
        ...args, pgid: 999_999, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
      }),
      /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
    );
    assert.equal(
      unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]).storedState,
      "applying", "a refused release must leave the marker exactly where it was",
    );
    reader.close();
  }

  /*
   * A row that is internally CONSISTENT by hash and inconsistent by content: the payload is rewritten
   * to say no group is recorded, the columns still hold one, and the hash is recomputed so the row
   * passes its own integrity check. That is what a targeted edit looks like, and without the
   * column-versus-payload agreement check the row would read as perfectly fine, report no pending
   * merge, and be settled by the next observation while `ps -g` still lists the merge.
   */
  {
    const db = new DatabaseSync(f.path);
    const row = db.prepare("SELECT * FROM candidate_merge_promotions WHERE state='applying'")
      .get() as unknown as Record<string, string | number | null>;
    const observationJson = JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, observedAt: "1970-01-01T00:00:00.000Z",
    });
    const consistentHash = createHash("sha256").update(JSON.stringify([
      row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
      row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
      row.restore_json, observationJson, row.state, row.owner_pid, row.started_at_ms,
      row.updated_at_ms, row.merge_pgid, row.merge_boot_at_sec,
    ]), "utf8").digest("hex");
    assert.equal(Number(db.prepare(
      "UPDATE candidate_merge_promotions SET observation_json=?,row_hash=? WHERE id=?",
    ).run(observationJson, consistentHash, String(row.id)).changes), 1);
    db.close();
    const strict = new CandidateRegistry(f.data);
    t.after(() => strict.close());
    const disagreeing = (await strict.promotions({ roomId: "demo", mainPath: f.source }))[0];
    assert.equal(groupAlive(pgid), true, "this assertion is only evidence while the merge is alive");
    assert.equal(disagreeing?.state, "unreadable",
      "a row whose column and payload disagree about the merge must not read as fine");
    assert.deepEqual(
      unreadable(disagreeing).release?.alive.map((entry) => [entry.kind, entry.pid]), [["merge", pgid]],
    );
    assert.equal(unreadable(disagreeing).release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
    strict.close();
  }

  /*
   * Now take BOTH columns away as well as the payload — every source that lives in the row. This is
   * the shape the previous round listed as a residual risk it could not probe, and the reason it can
   * be probed now is that one source never lived in the row at all: git's own trace stream, in a
   * file. [[PITFALLS]] #115 asks whether the fallback B lives inside the A it is meant to survive;
   * the two columns did, and this is the source that does not.
   */
  damagePromotionRow(f.path, {
    observationJson: "this used to be JSON", mergePgid: null, mergeBootAtSec: null,
  });
  const traced = new CandidateRegistry(f.data);
  t.after(() => traced.close());
  const fromTrace = unreadable((await traced.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(groupAlive(pgid), true, "this assertion is only evidence while the merge is alive");
  assert.deepEqual(
    fromTrace.release?.alive.map((entry) => [entry.kind, entry.pid]), [["merge", pgid]],
    "with every in-row source destroyed, git's own trace still names the merge",
  );
  assert.deepEqual(
    (fromTrace.release?.recordedGroups ?? []).map((entry) => [entry.source, entry.pgid]),
    [["trace", pgid]],
  );
  assert.equal(fromTrace.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  await assert.rejects(
    traced.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid,
      confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    /MAIN_MERGE_PROMOTION_ROW_UNREADABLE/u,
  );
  traced.close();

  /*
   * And now take the trace away too, which is the case nothing can probe: no source in the row, and
   * no source outside it. The requirement here is not "assume the best" but "say so" — the phrase
   * stays the long one even though `alive` is empty, and `probeReadable` is what tells the two apart
   * (finding F-5: `aliveAtRelease: []` was written while `ps` proved three processes alive, and
   * `unverifiedSource` beside it does not cover that).
   */
  await rm(join(f.data, "promotion-traces", `${promotionId}.jsonl`), { force: true });
  const blind = new CandidateRegistry(f.data);
  t.after(() => blind.close());
  const unseen = unreadable((await blind.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(groupAlive(pgid), true, "this assertion is only evidence while the merge is alive");
  assert.deepEqual(unseen.release?.alive, []);
  assert.deepEqual(unseen.release?.recordedGroups, []);
  assert.equal(unseen.release?.probeReadable, false,
    "an empty list must not be reported as an answered question");
  assert.equal(unseen.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  const blindArgs = { promotionId, roomId: "demo", mainPath: f.source, decidedBy: "local-web" };
  await assert.rejects(
    blind.abandonMergeProcessGroup({
      ...blindArgs, pgid: 0, confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION,
    }),
    (error: Error & { confirmation?: string; probeReadable?: boolean }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION
      && error.probeReadable === false,
  );

  // The way out still exists — no number can be demanded when no number can be read — and taking it
  // kills nothing, writes nothing, and is recorded as the unanswered question it was.
  const before = await treeDigest(f.source);
  const released = unreadable(await blind.abandonMergeProcessGroup({
    ...blindArgs, pgid: 0, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
  }));
  assert.equal(released.storedState, "needs-manual-review");
  assert.equal(released.holdsProjectExclusiveMarker, false);
  assert.equal(groupAlive(pgid), true, "releasing the marker must not kill anything");
  assert.equal(await treeDigest(f.source), before, "releasing the marker wrote to the repository");
  assert.equal(await head(f.source), beforeHead);
  const record = new DatabaseSync(f.path);
  const observation = JSON.parse(String((record.prepare(
    "SELECT observation_json FROM candidate_merge_promotions WHERE id=?",
  ).get(promotionId) as { observation_json: string }).observation_json)) as {
    unreadableRecordReleased?: { aliveAtRelease?: unknown[]; probeReadable?: boolean };
  };
  record.close();
  assert.deepEqual(observation.unreadableRecordReleased?.aliveAtRelease, []);
  assert.equal(observation.unreadableRecordReleased?.probeReadable, false,
    "the record must distinguish `probed and found nothing` from `could not probe`");
});

/*
 * The other direction ([[PITFALLS]] #107). Above, the payload is destroyed and the merge is alive, so
 * the short phrase is refused. Here the payload is destroyed in exactly the same way and the merge is
 * OVER — and the short phrase is the one that works, while the long one is refused. Without this,
 * "the short phrase is refused" could be true simply because the column now blocks everything
 * forever, which is the stale-observable defect this project has already had once ([[PITFALLS]] #102).
 */
test("a destroyed payload does not make a finished merge block the project forever", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const withPgid = new CandidateRegistry(f.data);
  const pgid = readable((await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  withPgid.close();
  f.registry.close();
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  assert.equal(groupAlive(pgid), false, "this test is only meaningful once the merge is over");

  const promotionId = damagePromotionRow(f.path, { observationJson: "this used to be JSON" });
  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  const listed = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // The column still holds the number; probing it is what turns it back into "nothing is running".
  assert.deepEqual(listed.release?.alive, []);
  assert.equal(listed.release?.probeReadable, true);
  assert.equal(listed.release?.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);
  const args = { promotionId, roomId: "demo", mainPath: f.source, pgid, decidedBy: "local-web" };
  await assert.rejects(
    reader.abandonMergeProcessGroup({ ...args, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION }),
    (error: Error & { confirmation?: string }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_ABANDON_CONFIRMATION,
  );
  reader.close();

  /*
   * The third shape, REVERSED by amendment (O) — and the reversal is the ninth round's BLOCKER-2.
   *
   * Until this round this block asserted the opposite: columns holding nothing AND a payload that
   * states, affirmatively, that no group is recorded were treated as an ANSWER, so the short phrase
   * worked. That is class 1 ("the two in-row sources say there is no group") intersected with class
   * 3 ("the two outside sources say nothing"), and the ninth round's three classes were written as
   * mutually exclusive alternatives, each relying on the other to hold — so nothing ever tested the
   * one cell where a single hook can produce both at once, and that cell was fail-open.
   *
   * The reversal is not "demand the long phrase always", which would take the short one out of
   * service and be the shape bar item 11 forbids. The short phrase is still what works in the FIRST
   * half of this same test, where the column names a number and probing it answers "gone". What is
   * no longer evidence is a record saying there is nothing to probe: that is the absence of an
   * answer, and the two are indistinguishable exactly when it matters.
   */
  damagePromotionRow(f.path, {
    observationJson: JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, mergePgid: null, mergeGroup: null,
      observedAt: "1970-01-01T00:00:00.000Z",
    }),
    mergePgid: null,
    mergeBootAtSec: null,
  });
  const groupless = new CandidateRegistry(f.data);
  t.after(() => groupless.close());
  const answered = unreadable((await groupless.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(answered.holdsProjectExclusiveMarker, true);
  assert.deepEqual(answered.release?.alive, []);
  assert.equal(answered.release?.probeReadable, false,
    "a record that says there is nothing to probe has not answered; it has stopped answering");
  assert.equal(answered.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  await assert.rejects(
    groupless.abandonMergeProcessGroup({ ...args, confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION }),
    (error: Error & { confirmation?: string }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
  );
  // …and the way out is still there, with the phrase that says what is being accepted. Bar item 11
  // is about there BEING an exit, not about which sentence it costs.
  const released = unreadable(await groupless.abandonMergeProcessGroup({
    ...args, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
  }));
  assert.equal(released.holdsProjectExclusiveMarker, false);
});

/*
 * FINDING P0 (seventh round), and the reason amendments (E) and (F) exist.
 *
 * Last round moved the merge's process group into its own COLUMNS and made them the preferred
 * source. The corruption model that fix was measured against only ever landed on the payload, so the
 * case where a source is DAMAGED rather than absent was never asked: `durableMergeIdentity()` saw a
 * non-null column and returned it as `readable: true` without ever looking at `observation_json`.
 * `#assertPromotionRow` had ALREADY detected the disagreement and called the row tampered — and that
 * detection was thrown away one function later.
 *
 * Measured on that build, with `ps -g` proving the `git merge`, its hook and its `sleep` all alive
 * and main already half-applied: the short phrase was ACCEPTED, `--pgid 999999` was ACCEPTED, and
 * the project's exclusive marker was handed back. The second task then stopped only because the
 * working tree had gone dirty — the coincidence the previous commit message claimed it no longer
 * relied on.
 *
 * ~~Three landings, one per corruption class in amendment (E).~~ **Corrected after the eighth
 * round.** That sentence was false and the falsehood is the shape [[PITFALLS]] #121 names:
 * `damagePromotionRow()` zeroes `row_hash` on EVERY call, so all three of these landings are at
 * least two-field damage and none of them is the third class ("hashes valid, sources disagree") at
 * all. The three of them were three SQLite columns, one per pattern the seventh round's probe used
 * — the landing spots shrank, the outcomes did not.
 *
 * What these three actually are — and all they ever were — is three ways an UNREADABLE row can still
 * name a live merge. That is worth keeping, and their names already say it. What they are NOT is the
 * corruption model amendment (E) asks for; that model is defined by SOURCE, lives with the round-9
 * tests at the end of this file, and covers the paths that draw a CONCLUSION rather than only the
 * path that releases a marker.
 *
 * Each asserts `groupAlive(pgid)` FIRST and again at every step ([[PITFALLS]] #106): a refusal is
 * only evidence if the merge really is alive while it happens.
 */
interface ContestedLanding {
  label: string;
  damage(stored: { pgid: number; bootAtSec: number }): Parameters<typeof damagePromotionRow>[1];
  /** The other number the record must still report, when the damage introduces one. */
  otherPgid?: number;
}

const CONTESTED_LANDINGS: readonly ContestedLanding[] = [
  {
    label: "its merge_pgid column is changed to a number nothing is using",
    damage: () => ({ mergePgid: 999_999 }),
    otherPgid: 999_999,
  },
  {
    label: "its merge_boot_at_sec column is changed to a different boot",
    damage: () => ({ mergeBootAtSec: 1 }),
  },
  {
    label: "both merge columns are NULL and the payload is valid JSON with no group in it",
    damage: () => ({
      mergePgid: null,
      mergeBootAtSec: null,
      observationJson: JSON.stringify({
        code: "PROMOTION_STARTED", mainHead: null, observedAt: "1970-01-01T00:00:00.000Z",
      }),
    }),
  },
];

for (const landing of CONTESTED_LANDINGS) {
  test(`a live merge is still named when ${landing.label}`, async (t) => {
    const f = await fixture(t);
    const started = join(f.root, "hook-entered");
    await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);

    // A SECOND task over the same main, approved BEFORE anything starts writing, so its refusal
    // cannot come from the first merge having dirtied the tree. That distinction is the point: on
    // the previous build this was the only thing that stopped it.
    const second = await f.registry.start({
      actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
    });
    await commit(second.candidatePath, "second.txt", "second work\n", "second work");
    await f.registry.complete({
      actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
      mainPath: f.source, summary: "also ready",
    });
    const secondPreview = await f.registry.previewMainMerge({
      taskId: second.taskId, roomId: "demo", mainPath: f.source,
    });
    assert.equal(secondPreview.approvable, true, secondPreview.blockers.join(","));
    const secondApproval = await f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
      mainPath: f.source, completionId: secondPreview.completionId,
      previewDigest: secondPreview.previewDigest,
    });
    const secondToken = (await f.registry.grantMainMerge({
      approvalId: secondApproval.id, roomId: "demo", mainPath: f.source,
      previewDigest: secondApproval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    })).approvalToken;

    const approval = await raise(f);
    const token = await grant(f, approval);
    const beforeHead = await head(f.source);
    const child = await promoteInChildAt(f, approval, token);
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
    child.kill("SIGKILL");
    await waitForExit(child);

    const withPgid = new CandidateRegistry(f.data);
    const pgid = readable((await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0])
      .observation.mergePgid as number;
    withPgid.close();
    f.registry.close();
    assert.ok(typeof pgid === "number" && pgid > 1);
    t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

    const columns = new DatabaseSync(f.path);
    const stored = columns.prepare(
      "SELECT merge_pgid, merge_boot_at_sec FROM candidate_merge_promotions WHERE state='applying'",
    ).get() as { merge_pgid: number | null; merge_boot_at_sec: number | null };
    columns.close();
    assert.equal(stored.merge_pgid, pgid);
    assert.equal(typeof stored.merge_boot_at_sec, "number");
    const promotionId = damagePromotionRow(f.path, landing.damage({
      pgid, bootAtSec: Number(stored.merge_boot_at_sec),
    }));

    assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
    const listing = await psGroup(pgid);
    assert.match(listing, /git[^\n]*merge/u, `ps -g ${pgid} does not show the merge:\n${listing}`);
    const beforeTree = await treeDigest(f.source);

    const reader = new CandidateRegistry(f.data);
    t.after(() => reader.close());
    const listed = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    assert.equal(listed.state, "unreadable");
    assert.equal(listed.holdsProjectExclusiveMarker, true);
    // The number `ps -g` shows is the one the record names, not the one a preference order picked.
    assert.deepEqual(
      listed.release?.alive.map((entry) => [entry.kind, entry.pid]), [["merge", pgid]],
      JSON.stringify(listed.release),
    );
    assert.equal(listed.release?.probeReadable, false,
      "sources that disagree must not be reported as an answered question");
    assert.equal(listed.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
    // Both numbers are shown. Reporting only the survivor would hide the disagreement that is the
    // reason this row cannot be concluded about.
    const recorded = (listed.release?.recordedGroups ?? []).map((entry) => entry.pgid);
    assert.ok(recorded.includes(pgid), JSON.stringify(listed.release?.recordedGroups));
    if (landing.otherPgid !== undefined) {
      assert.ok(recorded.includes(landing.otherPgid), JSON.stringify(listed.release?.recordedGroups));
    }

    const args = { promotionId, roomId: "demo", mainPath: f.source, decidedBy: "local-web" };
    // The short phrase says nothing about main being written. It is refused with either number.
    for (const quoted of [999_999, pgid]) {
      await assert.rejects(
        reader.abandonMergeProcessGroup({
          ...args, pgid: quoted, confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION,
        }),
        (error: Error & { confirmation?: string; probeReadable?: boolean }) =>
          error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
          && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION
          && error.probeReadable === false,
      );
    }
    // And the invented number is refused even with the phrase that admits main may be being written.
    await assert.rejects(
      reader.abandonMergeProcessGroup({
        ...args, pgid: 999_999, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
      }),
      /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
    );
    assert.equal(
      unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]).storedState,
      "applying", "a refused release must leave the exclusive marker exactly where it was",
    );

    // The second task is stopped BY NAME. `MAIN_MERGE_APPROVAL_BINDING_CHANGED:mainDirtyFingerprint`
    // here would mean the marker had been handed back and the dirty tree was doing the work.
    await assert.rejects(
      reader.promoteMainMerge({
        approvalId: secondApproval.id, token: secondToken, action: MERGE_APPROVAL_GRANT,
        taskId: second.taskId, roomId: "demo", mainPath: f.source,
      }),
      (error: Error) => error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE",
    );
    assert.equal(groupAlive(pgid), true, "nothing here may kill the merge");
    assert.equal(await treeDigest(f.source), beforeTree, "reading the record wrote to the repository");
    assert.equal(await head(f.source), beforeHead);
  });
}

/*
 * FINDING P1-6 (seventh round). `merge_boot_at_sec` had an assertion that it EXISTS and none that it
 * DOES anything — [[PITFALLS]] #83 in the same shape as the regex-on-source assertions. Two mutations
 * proved it: making `columnMergeIdentity()` always answer `bootAtSec: null` left every test green,
 * and dropping the boot from the write was caught only by `typeof stored.merge_boot_at_sec`.
 *
 * This drives the column pair from behaviour, with git's trace file REMOVED so the columns really are
 * the only source left. Three segments, and they need each other:
 *  1. columns as the product wrote them → they name the merge, so a boot that is never written makes
 *     this segment fail rather than merely making an assertion about a type unavailable;
 *  2. the same row with the boot moved to a previous boot → the SAME live pid must stop counting,
 *     which is the only way a boot that is ignored can be told from a boot that is used;
 *  3. a pgid with the boot NULLed beside it — amendment (E)'s second class, two fields at once —
 *     which is damage rather than an older shape, because every write sets both together.
 */
test("the merge-group columns are the only source, and the boot in them is part of the answer", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const withPgid = new CandidateRegistry(f.data);
  const promotionId = (await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0]?.id ?? "";
  const pgid = readable((await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  withPgid.close();
  f.registry.close();
  assert.ok(typeof pgid === "number" && pgid > 1);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  const columns = new DatabaseSync(f.path);
  const storedBoot = Number((columns.prepare(
    "SELECT merge_boot_at_sec FROM candidate_merge_promotions WHERE state='applying'",
  ).get() as { merge_boot_at_sec: number | null }).merge_boot_at_sec);
  columns.close();
  assert.ok(Number.isSafeInteger(storedBoot));
  // Git's own trace is deleted so that what follows is evidence about the COLUMNS and nothing else.
  await rm(join(f.data, "promotion-traces", `${promotionId}.jsonl`), { force: true });

  const requirementNow = async (): Promise<{
    confirmation: string | undefined;
    alive: Array<[string, number]>;
    probeReadable: boolean | undefined;
  }> => {
    const reader = new CandidateRegistry(f.data);
    try {
      const listed = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
      return {
        confirmation: listed.release?.confirmation,
        alive: (listed.release?.alive ?? []).map((entry) => [entry.kind, entry.pid]),
        probeReadable: listed.release?.probeReadable,
      };
    } finally { reader.close(); }
  };

  // 1. The columns as the product wrote them, and nothing else left to read.
  damagePromotionRow(f.path, { observationJson: "this used to be JSON" });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
  const fromColumns = await requirementNow();
  assert.deepEqual(fromColumns.alive, [["merge", pgid]],
    "with the payload and the trace gone, the columns are what must name the merge");
  assert.equal(fromColumns.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);

  // 3. The same pgid with its boot NULLed. Every write sets the pair together, so half of it is
  //    damage — and a pid with no boot beside it names somebody else after a restart.
  damagePromotionRow(f.path, { mergeBootAtSec: null });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
  const halfPair = await requirementNow();
  assert.deepEqual(halfPair.alive, []);
  assert.equal(halfPair.probeReadable, false,
    "half of a pair that is always written together is damage, not an answer");
  assert.equal(halfPair.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);

  // 2. The same LIVE pid, recorded against a boot this machine is not in. `kill(pgid, 0)` still
  //    succeeds — that is the precondition, and without it this segment would prove nothing
  //    ([[PITFALLS]] #106) — and the record must nonetheless stop counting it.
  damagePromotionRow(f.path, { mergeBootAtSec: storedBoot - 100_000 });
  assert.equal(groupAlive(pgid), true, "the boot must be what rules this pid out, not its absence");
  const previousBoot = await requirementNow();
  assert.deepEqual(previousBoot.alive, [],
    "a pid recorded against another boot is not this boot's merge, however alive the number is");
  assert.equal(previousBoot.probeReadable, true);
  assert.equal(previousBoot.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);

  // The way out matches what was reported, and taking it kills nothing.
  const beforeTree = await treeDigest(f.source);
  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  const released = unreadable(await reader.abandonMergeProcessGroup({
    promotionId, roomId: "demo", mainPath: f.source, pgid: 0,
    confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }));
  assert.equal(released.holdsProjectExclusiveMarker, false);
  assert.equal(groupAlive(pgid), true, "releasing the marker must not kill anything");
  assert.equal(await treeDigest(f.source), beforeTree);
});

/*
 * FINDING P1-7 (seventh round). `durableMergeIdentity()`'s comment named three paths that answer
 * "unreadable", and one of them — a payload that parses to something that is not an object — had no
 * test at all: a mutation removing it left everything green. An array or a bare number in that column
 * is present and unintelligible, which is not the same as a record stating there is no group, and
 * only one of those two may hand out the shorter phrase.
 */
test("a payload that parses to something other than an object answers nothing about the merge", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const withPgid = new CandidateRegistry(f.data);
  const promotionId = (await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0]?.id ?? "";
  const pgid = readable((await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  withPgid.close();
  f.registry.close();
  // The merge is ended and the trace removed, so `alive` is empty for a reason that has nothing to
  // do with the payload. What is being measured is the phrase, and only the payload can move it.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  assert.equal(groupAlive(pgid), false, "this test measures the phrase, not a live process");
  await rm(join(f.data, "promotion-traces", `${promotionId}.jsonl`), { force: true });

  for (const payload of ["[1,2,3]", "42", "\"a string\""]) {
    damagePromotionRow(f.path, { observationJson: payload, mergePgid: null, mergeBootAtSec: null });
    const reader = new CandidateRegistry(f.data);
    const listed = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    assert.deepEqual(listed.release?.alive, []);
    assert.equal(listed.release?.probeReadable, false, `${payload} was treated as an answer`);
    assert.equal(listed.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
      `${payload} is unintelligible, not a record that says no merge ran`);
    await assert.rejects(
      reader.abandonMergeProcessGroup({
        promotionId, roomId: "demo", mainPath: f.source, pgid: 0,
        confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
      }),
      /MAIN_MERGE_PROMOTION_ROW_UNREADABLE/u,
    );
    reader.close();
  }
});

/*
 * Bar item 11, for the columns this round adds. A database written by the previous commit keeps the
 * merge group ONLY inside `observation_json` and hashes its rows without the two new columns. Both
 * halves have to keep working: the row must stay readable (a hash that suddenly fails would report
 * tampering where there was an upgrade — [[PITFALLS]] #100), and the fail-closed answer must still
 * be reached from the one source such a row has.
 */
test("a promotion row written before the merge-group columns existed still opens, and still blocks", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const withPgid = new CandidateRegistry(f.data);
  const pgid = readable((await withPgid.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  withPgid.close();
  f.registry.close();
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

  // Exactly what the previous commit wrote: no columns, and a hash over the sixteen fields it knew.
  const db = new DatabaseSync(f.path);
  const row = db.prepare("SELECT * FROM candidate_merge_promotions WHERE state='applying'")
    .get() as unknown as Record<string, string | number | null>;
  db.exec(`ALTER TABLE candidate_merge_promotions DROP COLUMN merge_pgid;
    ALTER TABLE candidate_merge_promotions DROP COLUMN merge_boot_at_sec;`);
  const legacyHash = createHash("sha256").update(JSON.stringify([
    row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
    row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
    row.restore_json, row.observation_json, row.state, row.owner_pid, row.started_at_ms,
    row.updated_at_ms,
  ]), "utf8").digest("hex");
  db.prepare("UPDATE candidate_merge_promotions SET row_hash=? WHERE id=?")
    .run(legacyHash, String(row.id));
  assert.equal(Number((db.prepare(
    "SELECT count(*) AS n FROM pragma_table_info('candidate_merge_promotions') WHERE name='merge_pgid'",
  ).get() as { n: number }).n), 0, "the columns must really be absent for this to prove anything");
  db.close();

  const upgraded = new CandidateRegistry(f.data);
  t.after(() => upgraded.close());
  // The row is READABLE — the hash it was stored with is still its hash — and it still blocks,
  // because the observation is the one source such a row has and it is still consulted.
  const listed = readable((await upgraded.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(groupAlive(pgid), true, "this assertion is only evidence while the merge is alive");
  assert.equal(listed.state, "applying");
  assert.equal(listed.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  assert.equal(listed.pending?.pid, pgid);

  // The columns were added on open, and now that they exist a write fills them in.
  const after = new DatabaseSync(f.path);
  const present = after.prepare(
    "SELECT name FROM pragma_table_info('candidate_merge_promotions')",
  ).all() as unknown as Array<{ name: string }>;
  after.close();
  assert.ok(present.some((column) => column.name === "merge_pgid"), JSON.stringify(present));
  assert.ok(present.some((column) => column.name === "merge_boot_at_sec"), JSON.stringify(present));

  // And a legacy row whose hash is ALSO gone still reaches the fail-closed answer through the only
  // source it has. This is the branch of the reading that exists solely for such rows.
  const promotionId = damagePromotionRow(f.path, {});
  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  const damaged = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(damaged.id, promotionId);
  assert.deepEqual(damaged.release?.alive.map((entry) => [entry.kind, entry.pid]), [["merge", pgid]]);
  assert.equal(damaged.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
});

/*
 * FINDING P2-11 (seventh round). Adding the two columns without moving the schema version made the
 * UPGRADE direction seamless and left the DOWNGRADE direction with no name: an older build saw
 * "version 5", accepted the database, and then failed inside SQLite with `table
 * candidate_merge_promotions has 19 columns but 17 values were supplied` — its own positional
 * INSERT, from the shape asserted below. The direction was already fail-closed (that write happens
 * before the approval is spent), but a raw SQLite message is not an answer an owner can act on.
 *
 * Both halves are measured. The v5 shape really is the one the older build wrote, the upgrade really
 * does move the version and keep every stored hash, and a version this build does not know really is
 * refused by name at OPEN — which is the check the older build runs against a v6 database.
 */
test("a v5 promotion database upgrades by name, and a newer one is refused before anything is written", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  assert.equal((await promote(f, approval, await grant(f, approval))).promotion.state, "applied");
  f.registry.close();
  assert.equal(schemaVersion(f.path), 6);

  const before = new DatabaseSync(f.path);
  const row = before.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1")
    .get() as unknown as Record<string, string | number | null>;
  const storedHash = String(row.row_hash);
  // Exactly the v5 shape: no merge-group columns, and `user_version` back where the older build
  // left it. The row's stored hash is NOT recomputed, because a genuine v5 row was never tampered
  // with and must not read as if it had been.
  before.exec(`ALTER TABLE candidate_merge_promotions DROP COLUMN merge_pgid;
    ALTER TABLE candidate_merge_promotions DROP COLUMN merge_boot_at_sec;
    PRAGMA user_version=5;`);
  // The seventeen-value positional INSERT the older build used is VALID against this shape. That is
  // what makes the failure it hit against a v6 database a downgrade problem rather than a bug of
  // its own, and it is asserted rather than assumed.
  assert.equal(Number(before.prepare("INSERT INTO candidate_merge_promotions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), randomUUID(), String(row.task_id), String(row.room_id),
      `${String(row.main_path)}-other`, String(row.main_branch), String(row.candidate_head),
      `${String(row.recovery_ref)}-v5`, String(row.main_head_before), null,
      String(row.restore_json), String(row.observation_json), "applied", 1,
      Number(row.started_at_ms), Number(row.updated_at_ms), String(row.row_hash)).changes), 1);
  assert.equal(Number(before.prepare("DELETE FROM candidate_merge_promotions WHERE main_path=?")
    .run(`${String(row.main_path)}-other`).changes), 1);
  before.close();
  assert.equal(schemaVersion(f.path), 5);

  const upgraded = new CandidateRegistry(f.data);
  t.after(() => upgraded.close());
  assert.equal(schemaVersion(f.path), 6, "opening a v5 database must move it to the version it now is");
  assert.deepEqual(upgraded.integrity(), { schemaVersion: 6, quickCheck: "ok", rowsValid: true });
  assert.equal(readable((await upgraded.promotions({ roomId: "demo", mainPath: f.source }))[0]).state, "applied");
  const after = new DatabaseSync(f.path);
  const upgradedRow = after.prepare("SELECT row_hash FROM candidate_merge_promotions LIMIT 1")
    .get() as { row_hash: string };
  const columns = (after.prepare("SELECT name FROM pragma_table_info('candidate_merge_promotions')")
    .all() as unknown as Array<{ name: string }>).map((column) => column.name);
  after.close();
  assert.equal(upgradedRow.row_hash, storedHash, "the upgrade rewrote a stored promotion row");
  assert.ok(columns.includes("merge_pgid") && columns.includes("merge_boot_at_sec"), columns.join(","));
  upgraded.close();

  // The other direction, through the same guard an older build uses: a version this build does not
  // know is refused at open, by name, before anything reads or writes a row.
  const ahead = new DatabaseSync(f.path);
  ahead.exec("PRAGMA user_version=7");
  ahead.close();
  assert.throws(() => new CandidateRegistry(f.data), /CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED/u);
});

/*
 * FINDING F-6 (sixth round). `probe()`'s fourth answer was documented as unreachable through the
 * public interface, on the grounds that `kill(pid, 0)` with a valid positive integer returns only
 * `ESRCH` or `EPERM`. That is true of a valid pid and the record never checked for one: any number
 * at or above 2^31 makes `process.kill` throw `ERR_INVALID_ARG_TYPE`, which is neither, and
 * `promotionPgid` accepted anything up to 2^53. So the branch was reachable all along, from a
 * recorded number alone, with no test on it.
 *
 * The precondition is measured here rather than assumed ([[PITFALLS]] #106): `process.kill` really
 * does refuse this number in a way that is not `ESRCH`.
 */
test("a recorded process group too large to be a pid blocks the answer instead of settling it", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const first = new CandidateRegistry(f.data);
  const recorded = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  first.close();
  process.kill(-recorded, "SIGKILL");
  await waitForGroupExit(recorded);
  f.registry.close();

  const beyondPid = 2 ** 31;
  assert.throws(
    () => process.kill(beyondPid, 0),
    (error: NodeJS.ErrnoException) => error.code !== "ESRCH" && error.code !== "EPERM",
    "this test assumes a number this large is refused as neither present nor absent",
  );
  rewritePromotionRow(f.path, ({ observation }) => ({
    observation: {
      ...observation,
      mergePgid: beyondPid,
      mergeGroup: { ...(observation.mergeGroup as Record<string, unknown>), pgid: beyondPid },
    },
  }));

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // Not "gone": a number nobody can ask about is not evidence the merge finished.
  assert.equal(blocked.state, "applying");
  assert.equal(blocked.pending?.code, "MERGE_PROCESS_GROUP_UNDECIDABLE");
  assert.equal(blocked.pending?.pid, beyondPid);
  // And it is not a dead end: the same release every other blocked wait has still works.
  const released = readable(await reopened.abandonMergeProcessGroup({
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pgid: beyondPid,
    confirmation: MERGE_GROUP_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }));
  assert.equal(released.pending, undefined);
});

/*
 * The same fourth answer, one level up: `processAlive()` returns `null` for a number it cannot ask
 * about, and `owner_pid`'s CHECK constraint has no upper bound at all, so a row can carry one. That
 * branch decides whether an `applying` row keeps waiting on the process that started it, and it had
 * no test in either direction.
 */
test("an owning process id too large to be a pid keeps the record waiting rather than settling it", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const first = new CandidateRegistry(f.data);
  const recorded = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  first.close();
  process.kill(-recorded, "SIGKILL");
  await waitForGroupExit(recorded);
  f.registry.close();

  const beyondPid = 2 ** 31;
  assert.throws(
    () => process.kill(beyondPid, 0),
    (error: NodeJS.ErrnoException) => error.code !== "ESRCH" && error.code !== "EPERM",
    "this test assumes a number this large is refused as neither present nor absent",
  );
  // The merge group is out of the way, so the only thing left to decide is the owner process. The
  // record KEEPS the number rather than being rewritten to say it has none: amendment (O) makes
  // those two different states — a probed number that answers "gone" is evidence, and a record with
  // nothing to probe is the absence of it — and this test is about the owner pid, so it must not
  // silently become a test about the other one.
  rewritePromotionRow(f.path, ({ observation }) => ({
    ownerPid: beyondPid,
    observation,
  }));

  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const blocked = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(blocked.state, "applying");
  assert.equal(blocked.ownerAlive, null, "an undecidable pid must not be reported as a decided one");
  assert.equal(blocked.pending?.code, "OWNER_PROCESS_STILL_RUNNING");
  assert.equal(blocked.pending?.pid, beyondPid);
  const released = await reopened.abandonPromotionOwnerProcess({
    promotionId: blocked.id, roomId: "demo", mainPath: f.source, pid: beyondPid,
    confirmation: MERGE_OWNER_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });
  // Amendment (T): this release answers for the owner process and for nothing else. The merge
  // number the record still holds is one the merge's own hooks can write, so it goes on being named
  // until somebody accounts for it — what must be gone is the OWNER state this test is about.
  assert.notEqual(released.pending?.code, "OWNER_PROCESS_STILL_RUNNING");
  await ownerEndsTheWait(reopened, f);
  assert.equal(readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .pending, undefined);
});

/*
 * FINDING F-4 (sixth round). The previous round left `#liveGates`'s fail-closed `catch` untested and
 * wrote down a reason that was half wrong: a PERSISTENT restore-point failure really does throw
 * earlier, inside `#previewSnapshot`, but `previewMainMerge` reads the restore point for one
 * `mainPath` TWICE, and a failure that arrives only for the second read — a disk blinking out, a
 * permission bit changed for a moment, a deadline hit on a large repository — lands exactly on that
 * catch. Both directions are measured here, so the count is a fact rather than an assumption.
 */
test("a restore point that fails only on the second read is a closed gate, not an open one", async (t) => {
  class FlakyRestorePoint extends GitBroker {
    calls = 0;
    failOn = 0;
    override async restorePoint(
      workspace: string, additionalAttributePaths?: readonly string[],
    ): ReturnType<GitBroker["restorePoint"]> {
      this.calls += 1;
      if (this.calls === this.failOn) throw new Error("GIT_COMMAND_FAILED");
      return await super.restorePoint(workspace, additionalAttributePaths);
    }
  }
  const broker = new FlakyRestorePoint();
  const root = await mkdtemp(join(tmpdir(), "orchestratory-flaky-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await commit(source, "README.md", "committed main\n", "initial");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const registry = new CandidateRegistry(data, { gitBroker: broker });
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "flaky",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
  await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready",
  });

  // How many times one preview reads it, measured rather than assumed.
  broker.calls = 0;
  const clean = await registry.previewMainMerge({ taskId: task.taskId, roomId: "demo", mainPath: source });
  assert.equal(clean.approvable, true, clean.blockers.join(","));
  assert.equal(broker.calls, 2, "the shape of this finding depends on there being two reads");

  // The first read is the one `#previewSnapshot` makes: failing it throws, which is what the
  // previous comment described and is still true.
  broker.calls = 0;
  broker.failOn = 1;
  await assert.rejects(
    registry.previewMainMerge({ taskId: task.taskId, roomId: "demo", mainPath: source }),
    /GIT_COMMAND_FAILED/u,
  );

  // The second read is the one that reaches the catch, and the answer there is a closed gate.
  broker.calls = 0;
  broker.failOn = 2;
  const preview = await registry.previewMainMerge({ taskId: task.taskId, roomId: "demo", mainPath: source });
  broker.failOn = 0;
  assert.equal(broker.calls, 2);
  assert.equal(preview.approvable, false);
  assert.deepEqual(preview.blockers, ["MAIN_WORKING_TREE_UNREADABLE"]);
  assert.equal(preview.hooks.unreadable, true, "an unread hook inventory must not read as `no hooks`");
  assert.deepEqual(preview.hooks.hooks, []);

  // Transient means transient: once the read succeeds again the same snapshot is approvable, so the
  // closed gate has not burned anything ([[PITFALLS]] #85).
  const recovered = await registry.previewMainMerge({ taskId: task.taskId, roomId: "demo", mainPath: source });
  assert.equal(recovered.approvable, true, recovered.blockers.join(","));
  assert.equal(recovered.previewDigest, clean.previewDigest);
});

/*
 * FINDING F-3 (sixth round). `orchestrator candidates promotions` printed `Read-only.`, its help line
 * said `# read-only`, and the residual-risk table called it a read-only listing. It is not: listing
 * re-observes every unsettled record, and converging one moves the authoritative row, appends to the
 * audit chain and appends to the room ledger. Measured against `orphan-refs` as a control — that
 * command changed the row, the audit count and all three SQLite digests not at all.
 *
 * The writing is what bar item 13 asks for; the label was the defect. This is the behaviour that
 * makes the corrected wording true, asserted so a future edit cannot quietly restore the old claim.
 */
test("listing promotions re-observes and updates the record, which is why it is not read-only", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 600\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const first = new CandidateRegistry(f.data);
  const pgid = readable((await first.promotions({ roomId: "demo", mainPath: f.source }))[0])
    .observation.mergePgid as number;
  first.close();
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  f.registry.close();

  const stored = (): { state: string; row_hash: string } => {
    const db = new DatabaseSync(f.path);
    const row = db.prepare("SELECT state,row_hash FROM candidate_merge_promotions LIMIT 1")
      .get() as { state: string; row_hash: string };
    db.close();
    return row;
  };
  const before = stored();
  assert.equal(before.state, "applying");

  const events: string[] = [];
  const reader = new CandidateRegistry(f.data, {
    onMergePromotion: (event) => { events.push(event.phase); },
  });
  t.after(() => reader.close());
  await reader.promotions({ roomId: "demo", mainPath: f.source });
  const after = stored();
  // Amendment (T) split this claim in two, and both halves are asserted rather than one being
  // dropped. The listing still WRITES — it re-observes the repository and stores what it found,
  // which is the whole reason this command is not read-only. What it no longer does is CONVERGE the
  // record on its own: the number it would have converged on came from a row the merge's own hooks
  // can rewrite, so leaving `applying` now waits for the owner.
  assert.notEqual(after.row_hash, before.row_hash, "the listing did not write");
  assert.equal(after.state, before.state, "the listing concluded with nothing having observed it");
  assert.deepEqual(events, [], "a record whose state did not move appended a ledger entry");

  // And once the owner ends the wait, the same listing converges it and says so exactly once.
  await ownerEndsTheWait(reader, f);
  const settledRow = stored();
  assert.notEqual(settledRow.state, before.state, "the listing did not converge the record");
  assert.deepEqual(events.filter((phase) => phase === "re-observed"), ["re-observed"]);

  // A second listing of a record that has not changed writes no further ledger entry, so "it
  // updates" does not become "it appends on every read".
  const seen = [...events];
  await reader.promotions({ roomId: "demo", mainPath: f.source });
  assert.deepEqual(events, seen);
});

/*
 * FINDING P3-13 (seventh round), amendment (H). `orchestrator candidates orphan-refs` tells the owner
 * `# read-only; lists, never deletes`. The only evidence for the first half was a control group the
 * sixth-round reviewer ran by hand, and that evidence lived in a review report rather than in this
 * repository ([[PITFALLS]] #81) — which is how the sibling command came to print `Read-only.` for
 * three rounds while writing to three databases.
 *
 * The measurement is bracketed: open-and-close with nothing in between is the baseline, so what is
 * being compared is the SCAN, not the cost of opening a database. And it is checked for sensitivity
 * first — a byte comparison that cannot see a write it should see would pass for the wrong reason
 * ([[PITFALLS]] #97).
 */
test("`orphan-refs` says read-only, and the bytes of every database are the same afterwards", async (t) => {
  const f = await fixture(t);
  assert.match(helpText(), /orphan-refs <workspace> {3}# read-only; lists, never deletes/u);
  const orphanRef = `refs/orchestratory/checkpoints/${randomUUID()}/${randomUUID()}`;
  await execFileAsync("git", ["update-ref", orphanRef, await head(f.source)], { cwd: f.source });
  f.registry.close();

  const digest = async (): Promise<string> => {
    const names = (await readdir(f.data)).filter((name) => name.includes(".sqlite")).sort();
    const hash = createHash("sha256");
    for (const name of names) {
      hash.update(name).update(await readFile(join(f.data, name)));
    }
    return `${names.join(",")}#${hash.digest("hex")}`;
  };
  /** One open/close bracket. Whatever it does in between is the only thing being measured. */
  const bracket = async (body: (service: CollaborationService) => Promise<void>): Promise<string> => {
    const service = new CollaborationService(f.data);
    try { await body(service); } finally { service.close(); }
    return await digest();
  };

  const baseline = await bracket(async () => { /* the cost of opening and closing, alone */ });
  assert.equal(await bracket(async () => { /* twice, to prove the bracket itself is stable */ }),
    baseline, "opening and closing is not itself byte-stable, so this test cannot measure anything");

  // Sensitivity: a bracket that DOES write must move the digest, or byte-equality proves nothing.
  const wrote = await bracket(async (service) => {
    await service.candidates.start({
      actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "a write",
    });
  });
  assert.notEqual(wrote, baseline, "the byte comparison cannot see a write, so it can see nothing");

  // The claim itself.
  let orphans: Array<{ ref: string; head: string }> = [];
  const scanned = await bracket(async (service) => {
    orphans = [...await service.candidates.orphanRecoveryRefs(f.source)];
  });
  assert.ok(orphans.some((entry) => entry.ref === orphanRef), JSON.stringify(orphans));
  assert.equal(scanned, wrote, "`orphan-refs` wrote to a database while calling itself read-only");
  // And the second half of the same sentence: it lists, it never deletes.
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "--verify", `${orphanRef}^{commit}`], { cwd: f.source }))
      .stdout.trim(),
    await head(f.source),
  );
});

// =============================================================================================
// Round-10 findings. Amendment (O) REPLACES the three-class corruption matrix that stood here.
//
// Four rounds in a row fixed the dimension that had just been broken — field names, then sources,
// then the intersection of sources, then whether a source exists at all — and each fix was correct
// and each was followed by the same defect through the next dimension ([[PITFALLS]] #117, #121).
// The invariant behind all four was never about the shape of the damage:
//
//   A DESTRUCTIVE CONCLUSION MAY NOT BE REACHED FROM THE ABSENCE OF EVIDENCE.
//
// So the model below is not a list of damage shapes. It is every SUBSET of the four sources, each
// one DELETED rather than corrupted, with the assertion that no subset makes any of the four
// measurable loosenings true. Deleting cannot supply an answer, so if the product only ever moves
// on positive evidence, the whole power set is safe by construction — and if it does not, one of
// these sixteen finds it. Amendment (P): the subsets include the ones the ninth round's mutually
// exclusive classes could not express, in particular "everything at once", which is what a single
// repository hook can do in a single promotion.
//
// THE PATHS THAT DECIDE WHETHER A CONCLUSION MAY BE DRAWN ABOUT THIS PROMOTION, in full — eleven,
// not seven. Amendment (S): the ninth round's own list was written by the person who had just
// edited it, so it contained what he had edited.
//
//    1. `promotionPending()`                                          the gate every other path asks
//    2. `#recoveryHint()`                                             hands out `reset --hard`
//    3. `#observeMain()`                                              what the record says it saw
//    4. `#settlePromotion()`                                          the in-process conclusion
//    5. `#resolvePromotion()`                                         the crash-reader's conclusion
//    6. `#publicPromotion()`                                          the `pending` the listing prints
//    7. `#assertNoUnresolvedPromotion()`                              this task's next approval
//    8. `#assertMainNotBusy()` (pending branch)                       every OTHER task in the project
//    9. `#assertMainNotBusy()` (unreadable branch)                    the same, for a damaged row
//   10. `abandonMergeProcessGroup()` / `abandonPromotionOwnerProcess()` / `abandonPromotionEntirely()`
//   11. `#releaseUnreadablePromotion()` and `unreadablePromotionView()`
//   12. `previewMainMerge()`                                         reads main WITHOUT asking 1
//
// and the CLI rendering of 1, 2 and 6, which is where the owner actually reads the answer.
//
// Amendment (S), eleventh round: 12 was missing from the list, and it is the only entry point that
// reads main without going through 1 ([[PITFALLS]] #114, deliberate). It concludes nothing and
// writes nothing, but it fingerprints a working tree a merge may be rewriting, so the digest it
// produces is bound to a torn snapshot — pinned by "a preview taken over a live merge is a torn
// read that no write path will accept" rather than left as an argument about why it is harmless.
// =============================================================================================

/**
 * One source of a merge's identity, and how to DELETE it.
 *
 * Deleting rather than corrupting is the point. A corrupted source can be argued about — is the
 * value wrong, is the field missing, does the hash still cover it — and four rounds of arguing
 * about that produced four fixes and four bypasses. A deleted source makes exactly one claim: it
 * says nothing. If saying nothing can move the product towards a conclusion, the product is wrong,
 * and no amount of comparing what the survivors say can repair it.
 */
interface MergeIdentitySourceCase {
  name: "column" | "payload" | "trace" | "spawn-record";
  /**
   * True when removing this source leaves a row whose integrity check FAILS.
   *
   * The two in-row sources are a projection pair, and `#assertPromotionRow` refuses a row whose
   * column names a group its payload does not — so a column that goes away on its own is damage,
   * not silence, and the record travels the unreadable path.
   *
   * ⛔ This comment used to say the refusal works "in both directions". It does not:
   * `candidate-registry.ts` asks `row.merge_pgid !== null && <payload disagrees>`, which is one
   * direction, and the eighth round already recorded that ([[VERIFICATION]]:420 carries the strike
   * through). It came back here and was used to justify `damagesRow: true` for the column case. The
   * real reason that case damages the row is simpler and does not need the claim: `row_hash` covers
   * the columns, so writing one without recomputing the hash breaks the hash.
   */
  damagesRow: boolean;
  remove(context: { path: string; data: string; promotionId: string }): Promise<void>;
  /**
   * Amendment (T-3). Writing an attacker-chosen value into this source, with `row_hash` recomputed
   * so nothing downstream can tell.
   *
   * Deleting was the tenth round's whole model, and its own comment said why it was safe —
   * "deleting cannot supply an answer". Nobody asked who is allowed to SUPPLY one. The answer, in
   * this phase's own adversary model, is: the merge itself, through any repository hook, because
   * every one of these four sources is a file the owner's uid can write and the row hash that
   * covers two of them is an unkeyed SHA-256 over public columns.
   *
   * `pgid` is a number that has already exited, which is the value that used to manufacture
   * amendment (O)'s third positive fact.
   */
  forge(context: {
    path: string; data: string; promotionId: string; pgid: number; bootAtSec: number;
  }): Promise<void>;
  /** True when forging this source ALONE leaves a row whose integrity check fails. */
  forgeDamagesRow: boolean;
}

const IDENTITY_SOURCES: readonly MergeIdentitySourceCase[] = [
  {
    name: "column",
    damagesRow: true,
    remove: async ({ path }) => {
      damagePromotionRow(path, { mergePgid: null, mergeBootAtSec: null });
    },
    // Forging one half of the pair contradicts the other half, which `#assertPromotionRow` refuses:
    // the row is READABLE (the hash is valid) and then refused for saying two things. The forge of
    // both halves together is the subset `column + payload`, and that one is fully trusted — which
    // is exactly the row the eleventh round's blocker produced.
    forgeDamagesRow: true,
    forge: async ({ path, pgid, bootAtSec }) => {
      forgePromotionRow(path, () => ({ mergePgid: pgid, mergeBootAtSec: bootAtSec }));
    },
  },
  {
    // The p8-race shape, reachable with nothing forged: another process holds the database across
    // the one write that records the group ([[PITFALLS]] #65 calls that an ordinary condition on
    // this machine), `#recordMergePgid` swallows the failure, and git is already running detached.
    // The columns are a projection of this field, so they go with it and the row stays READABLE —
    // which is the path that concluded.
    name: "payload",
    damagesRow: false,
    remove: async ({ path }) => {
      rewritePromotionRow(path, ({ observation }) => {
        const next = { ...observation };
        delete next.mergePgid;
        delete next.mergeGroup;
        return { observation: next };
      });
    },
    forgeDamagesRow: true,
    forge: async ({ path, pgid, bootAtSec }) => {
      forgePromotionRow(path, ({ observation }) => ({
        observation: {
          ...observation,
          mergePgid: pgid,
          mergeGroup: { pgid, bootAtSec, spawnedAt: new Date().toISOString() },
        },
      }));
    },
  },
  {
    // BLOCKER-1's own move, and it needs no database access at all: `$GIT_TRACE2_EVENT` is handed
    // to every hook this merge runs, and this phase trusts those hooks and runs them as the owner
    // with no sandbox. Two lines in a hook empty the file.
    name: "trace",
    damagesRow: false,
    remove: async ({ data, promotionId }) => {
      await rm(join(data, "promotion-traces", `${promotionId}.jsonl`), { force: true });
    },
    forgeDamagesRow: false,
    // The same two lines of hook, writing instead of deleting: trace2 session ids end in the
    // emitting process's pid in hex, so one `start` event names whatever number the writer chooses.
    forge: async ({ data, promotionId, pgid }) => {
      await writeFile(join(data, "promotion-traces", `${promotionId}.jsonl`), `${JSON.stringify({
        event: "start", sid: `1-H0-P${pgid.toString(16)}`, time: new Date().toISOString(),
      })}\n`, { encoding: "utf8", mode: 0o600 });
    },
  },
  {
    // The marker lives in `dirname($GIT_TRACE2_EVENT)`, which the same hook derives from the same
    // environment variable. The claim that it is "never named to anything the merge runs" was
    // measured false; what makes it safe is not where it is but that its absence cannot loosen.
    name: "spawn-record",
    damagesRow: false,
    remove: async ({ data, promotionId }) => {
      await rm(join(data, "promotion-traces", `${promotionId}.spawn-record.json`), { force: true });
    },
    forgeDamagesRow: false,
    forge: async ({ data, promotionId, pgid, bootAtSec }) => {
      await writeFile(join(data, "promotion-traces", `${promotionId}.spawn-record.json`),
        JSON.stringify({ pgid, bootAtSec, at: new Date().toISOString() }),
        { encoding: "utf8", mode: 0o600 });
    },
  },
];

/**
 * The two verbs the subset enumeration runs. Amendment (T-3): the skeleton is unchanged and the
 * ACTION SET is what grew.
 */
const IDENTITY_ACTIONS = [
  {
    verb: "deleted",
    apply: async (
      source: MergeIdentitySourceCase,
      context: { path: string; data: string; promotionId: string; pgid: number; bootAtSec: number },
    ): Promise<void> => source.remove(context),
  },
  {
    verb: "forged",
    apply: async (
      source: MergeIdentitySourceCase,
      context: { path: string; data: string; promotionId: string; pgid: number; bootAtSec: number },
    ): Promise<void> => source.forge(context),
  },
] as const;

/** Every subset of a list, smallest first. Sixteen for four sources, including none and all. */
function subsetsOf<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask += 1) {
    out.push(items.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return out.sort((a, b) => a.length - b.length);
}

/**
 * The four loosenings, measured on whichever path this row now travels.
 *
 * They are the four the standard names, and each is a boolean that starts FALSE while a merge is
 * writing. "No subset of deletions turns any of them true" is the whole of amendment (O), and it is
 * checkable without enumerating a single damage shape.
 */
async function looseness(f: Fixture, promotionId: string): Promise<{
  destructiveOffer: boolean;
  notWaiting: boolean;
  shortPhraseAccepted: boolean;
  markerReleased: boolean;
  report: string;
}> {
  const registry = new CandidateRegistry(f.data);
  try {
    const entry = (await registry.promotions({ roomId: "demo", mainPath: f.source }))[0];
    assert.ok(entry !== undefined, "the promotion row disappeared");
    const report = await runCandidatePromotionsCommand({
      args: [], roomId: "demo", mainPath: f.source, registry, decidedBy: "local-cli",
    });
    const short = async (confirmation: string): Promise<boolean> => {
      try {
        await registry.abandonMergeProcessGroup({
          promotionId, roomId: "demo", mainPath: f.source, pgid: 0, confirmation,
          decidedBy: "local-web",
        });
        return true;
      } catch { return false; }
    };
    const shortPhraseAccepted = await short(MERGE_GROUP_ABANDON_CONFIRMATION)
      || await short(MERGE_UNREADABLE_ABANDON_CONFIRMATION);
    if ("unreadable" in entry) {
      return {
        destructiveOffer: false,
        notWaiting: entry.release?.probeReadable === true,
        shortPhraseAccepted,
        markerReleased: entry.holdsProjectExclusiveMarker === false,
        report,
      };
    }
    return {
      destructiveOffer: entry.observation.recoveryKind === "reset-to-pre-promotion"
        || entry.observation.recovery !== undefined,
      notWaiting: entry.pending === undefined,
      shortPhraseAccepted,
      markerReleased: entry.state !== "applying",
      report,
    };
  } finally { registry.close(); }
}

for (const action of IDENTITY_ACTIONS) {
for (const removed of subsetsOf(IDENTITY_SOURCES)) {
  const label = removed.length === 0
    ? `nothing is ${action.verb}`
    : `${removed.map((source) => source.name).join(" + ")} ${removed.length === 1 ? "is" : "are"} ${action.verb}`;
  test(`no source subset lets a live merge be concluded about: ${label}`, async (t) => {
    const f = await fixture(t);
    const started = join(f.root, "hook-entered");
    await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);

    // A SECOND task over the same main, approved BEFORE anything writes, so its refusal cannot come
    // from the first merge having dirtied the tree.
    const second = await f.registry.start({
      actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
    });
    await commit(second.candidatePath, "second.txt", "second work\n", "second work");
    await f.registry.complete({
      actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
      mainPath: f.source, summary: "also ready",
    });
    const secondPreview = await f.registry.previewMainMerge({
      taskId: second.taskId, roomId: "demo", mainPath: f.source,
    });
    assert.equal(secondPreview.approvable, true, secondPreview.blockers.join(","));
    const secondApproval = await f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
      mainPath: f.source, completionId: secondPreview.completionId,
      previewDigest: secondPreview.previewDigest,
    });
    const secondToken = (await f.registry.grantMainMerge({
      approvalId: secondApproval.id, roomId: "demo", mainPath: f.source,
      previewDigest: secondApproval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    })).approvalToken;

    const approval = await raise(f);
    const token = await grant(f, approval);
    const beforeHead = await head(f.source);
    const child = await promoteInChildAt(f, approval, token);
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
    child.kill("SIGKILL");
    await waitForExit(child);

    const before = new CandidateRegistry(f.data);
    const inFlight = readable((await before.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    const promotionId = inFlight.id;
    const pgid = inFlight.observation.mergePgid as number;
    before.close();
    f.registry.close();
    assert.ok(typeof pgid === "number" && pgid > 1);
    t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

    // All FOUR sources start out naming this merge, so every removal below takes away something
    // that was really there. The marker is written by hand because the product only writes it when
    // the pgid write fails, and this promotion's did not — the baseline has to be the state in
    // which every source answers, or a "subset" would be measuring absences that predate it.
    const marker = join(f.data, "promotion-traces", `${promotionId}.spawn-record.json`);
    await writeFile(marker, JSON.stringify({
      pgid, bootAtSec: Math.round(Date.now() / 1_000 - uptime()), at: new Date().toISOString(),
    }), { encoding: "utf8", mode: 0o600 });
    assert.equal(await exists(join(f.data, "promotion-traces", `${promotionId}.jsonl`)), true,
      "git's trace was never written, so deleting it would prove nothing");

    // The number a forge names is one that has already exited, because that is the value which
    // manufactured amendment (O)'s third positive fact: every source agrees, every probe says gone,
    // and a `git merge` is writing main the whole time.
    const forged = await deadPid();
    const bootAtSec = Math.round(Date.now() / 1_000 - uptime());
    assert.notEqual(forged, pgid, "the forged number must not be the live merge's own");
    for (const source of removed) {
      await action.apply(source, {
        path: f.path, data: f.data, promotionId, pgid: forged, bootAtSec,
      });
    }

    // [[PITFALLS]] #106: none of what follows is evidence unless the merge really is writing.
    assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
    const listing = await psGroup(pgid);
    assert.match(listing, /git[^\n]*merge/u, `ps -g ${pgid} does not show the merge:\n${listing}`);
    const beforeTree = await treeDigest(f.source);

    const measured = await looseness(f, promotionId);
    assert.equal(measured.destructiveOffer, false,
      `a destructive recovery command was offered while the merge was writing:\n${measured.report}`);
    assert.equal(measured.notWaiting, false,
      `the record stopped waiting for a merge that is still writing:\n${measured.report}`);
    assert.equal(measured.shortPhraseAccepted, false,
      "a phrase that says nothing about main being written released a live merge");
    assert.equal(measured.markerReleased, false,
      "the project's exclusive marker was handed back over a live merge");

    // The CLI rendering of the same answer. The sentence this replaced asserted a fact about the
    // owner's machine while `ps -g` listed three live processes (amendment (L)).
    assert.ok(!/is still being waited on/u.test(measured.report), measured.report);
    assert.ok(!/reset --hard/u.test(measured.report),
      `the CLI offered a destructive command:\n${measured.report}`);
    assert.ok(!/pid undefined|pid NaN/u.test(measured.report), measured.report);

    const registry = new CandidateRegistry(f.data);
    t.after(() => registry.close());

    // This task's own next approval. Asked through `requestMainMerge`, because `previewMainMerge`
    // deliberately does NOT pass this gate ([[PITFALLS]] #114).
    const again = await registry.previewMainMerge({
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    });
    await assert.rejects(
      registry.requestMainMerge({
        actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
        mainPath: f.source, completionId: again.completionId, previewDigest: again.previewDigest,
      }),
      /MAIN_MERGE_PROMOTION_UNRESOLVED/u,
    );

    // Every OTHER task in the project, refused BY NAME rather than by a dirty tree. This is the one
    // the ninth round's reviewer could not reach through the per-task gate, and it is the one that
    // would let a second `git merge` start into a repository the first one is still writing.
    await assert.rejects(
      registry.promoteMainMerge({
        approvalId: secondApproval.id, token: secondToken, action: MERGE_APPROVAL_GRANT,
        taskId: second.taskId, roomId: "demo", mainPath: f.source,
      }),
      (error: Error) => error.message === "MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"
        || error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE",
    );

    assert.equal(groupAlive(pgid), true, "nothing here may kill the merge");
    assert.equal(await treeDigest(f.source), beforeTree, "reading the record wrote to the repository");
    assert.equal(await head(f.source), beforeHead);
  });
}
}

/*
 * The other direction, once ([[PITFALLS]] #107). Everything above would also be true of a record
 * that refuses forever, which is the stale-observable defect this project has already had
 * ([[PITFALLS]] #102) and the shape bar item 11 forbids.
 *
 * Two exits, and which one applies is decided by what the record can still NAME. With the row's own
 * sources naming the group, the owner quotes that number and the ordinary phrase. With every source
 * deleted — the maximum a single hook can do in one promotion, which is amendment (P)'s requirement
 * — there is no number to quote, so the exit is the phrase that says so. Amendment (T) moved the
 * first case from "converges by itself" to "converges in one step the owner takes", because the
 * number it converged on came from a row the merge's own hooks were measured rewriting; both exits
 * are REACHABLE, which is what bar item 11 requires.
 */
for (const wipe of [false, true]) {
  test(`a record that cannot be concluded about still has a way out: ${
    wipe ? "every source deleted" : "the row's own sources intact"}`, async (t) => {
    const f = await fixture(t);
    const started = join(f.root, "hook-entered");
    await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
    const approval = await raise(f);
    const token = await grant(f, approval);
    const child = await promoteInChildAt(f, approval, token);
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
    child.kill("SIGKILL");
    await waitForExit(child);
    const before = new CandidateRegistry(f.data);
    const inFlight = readable((await before.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    const promotionId = inFlight.id;
    const pgid = inFlight.observation.mergePgid as number;
    before.close();
    f.registry.close();
    assert.ok(typeof pgid === "number" && pgid > 1);

    if (wipe) {
      for (const source of IDENTITY_SOURCES) {
        if (source.name === "column") continue; // taken with the payload, which is its projection
        await source.remove({ path: f.path, data: f.data, promotionId });
      }
    }
    process.kill(-pgid, "SIGKILL");
    await waitForGroupExit(pgid);
    assert.equal(groupAlive(pgid), false, "this half needs the merge to be over");

    const registry = new CandidateRegistry(f.data);
    t.after(() => registry.close());
    const waiting = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    assert.equal(waiting.state, "applying");
    const beforeTree = await treeDigest(f.source);
    if (!wipe) {
      // The record's own sources still name the group and the group is gone. Amendment (T): that is
      // a hint, not this product's evidence, because the number lives in a row the merge's hooks can
      // rewrite under an unkeyed hash. So the record names the number, says nothing watched it end,
      // and the exit is one step: quote that number with the ordinary phrase.
      assert.equal(waiting.pending?.code, "MERGE_END_NOT_OBSERVED");
      assert.equal(waiting.pending?.pid, pgid);
      assert.equal(waiting.pending?.release, MERGE_GROUP_ABANDON_CONFIRMATION);
      assert.equal(waiting.observation.recovery, undefined);
      const released = await registry.abandonMergeProcessGroup({
        promotionId, roomId: "demo", mainPath: f.source, pgid,
        confirmation: MERGE_GROUP_ABANDON_CONFIRMATION, decidedBy: "local-web",
      });
      assert.ok(!("unreadable" in released));
      assert.equal(await treeDigest(f.source), beforeTree, "a release wrote to the repository");
      const settled = await settledPromotion(registry, f.source, 100);
      assert.equal(settled.state, "needs-manual-review", "the record never converged");
      assert.equal(settled.pending, undefined);
      assert.equal(settled.observation.mergeConclusion, "MERGE_GROUP_DISOWNED_BY_OWNER",
        "the record settled without naming the evidence that let it");
      // A declaration ends the waiting and nothing else: what is offered is a read-only look at the
      // number the owner quoted (amendment (T-2)).
      assert.equal(settled.observation.recoveryKind, "inspect-disowned-merge");
      // And it stays converged. The evidence that allowed it is erased by the very act of recording
      // it — `mergePgid` becomes null — so a second read has to find the conclusion itself.
      const again = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
      assert.equal(again.pending, undefined, "the record re-opened a conclusion it had already made");
      return;
    }
    assert.equal(waiting.pending?.code, "MERGE_IDENTITY_UNACCOUNTED");
    assert.equal(waiting.pending?.pid, undefined, "a state with no number must not invent one");
    assert.equal(waiting.pending?.release, MERGE_UNACCOUNTED_ABANDON_CONFIRMATION);
    const released = await registry.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: 0,
      confirmation: MERGE_UNACCOUNTED_ABANDON_CONFIRMATION, decidedBy: "local-web",
    });
    assert.ok(!("unreadable" in released));
    assert.equal(await treeDigest(f.source), beforeTree, "a release wrote to the repository");
    const settled = await settledPromotion(registry, f.source, 100);
    assert.notEqual(settled.state, "applying");
    assert.equal(settled.pending, undefined);
    assert.equal(settled.observation.mergeAccountAbandoned?.decidedBy, "local-web",
      "the record must attribute this to the owner rather than report it as an observation");
  });
}

/*
 * =============================================================================================
 * Round-11 findings. Amendment (T): in this phase's own adversary model there is no trustworthy
 * owner-writable store, so the four sources above are HINTS and the enumeration above grew a second
 * verb. The three tests here are the specific measurements the eleventh round made.
 * =============================================================================================
 */

test("a hook that rewrites both in-row sources to a dead number, hash and all, still cannot conclude", async (t) => {
  const f = await fixture(t);
  const live = await liveMerge(t, f);
  const dead = await deadPid();
  const bootAtSec = Math.round(Date.now() / 1_000 - uptime());
  assert.notEqual(dead, live.pgid);
  // Exactly what the measured hook did, in the same order: point both in-row sources at a pid that
  // has already exited, recompute `row_hash` so the record passes every check the product has, and
  // empty the trace so nothing outside the row contributes the live number. It needed no privilege
  // this phase does not already grant it — the database is at
  // `dirname(dirname($GIT_TRACE2_EVENT))/candidate-registry.sqlite`, and that variable is handed to
  // every hook a promotion runs.
  forgePromotionRow(f.path, ({ observation }) => ({
    observation: {
      ...observation,
      mergePgid: dead,
      mergeGroup: { pgid: dead, bootAtSec, spawnedAt: new Date().toISOString() },
    },
    mergePgid: dead,
    mergeBootAtSec: bootAtSec,
  }));
  await writeFile(live.tracePath, "", { encoding: "utf8", mode: 0o600 });

  // [[PITFALLS]] #106: none of this is evidence unless the merge really is writing.
  assert.equal(groupAlive(live.pgid), true, "this test is only evidence while the merge is alive");
  assert.match(await psGroup(live.pgid), /git[^\n]*merge/u);

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const listed = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // The whole point of the measurement: this row is NOT damaged. It travels the fully trusted path,
  // so nothing here is caught by the unreadable-row machinery.
  assert.equal(listed.state, "applying", "the project's exclusive marker was handed back");
  assert.notEqual(listed.pending, undefined, "the record stopped waiting for a live merge");
  assert.equal(listed.observation.recovery, undefined,
    `a command was offered for a merge nothing observed: ${listed.observation.recovery}`);
  assert.equal(listed.observation.mergeConclusion, "MERGE_GROUP_PROBED_GONE",
    "the record must name the hint it refused to conclude from");
  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);
  assert.equal(groupAlive(live.pgid), true, "nothing here may kill the merge");
});

test("an approval rewritten to say nothing ever ran cannot end a wait over a live merge", async (t) => {
  const f = await fixture(t);
  const live = await liveMerge(t, f);
  // The row's own numbers go first, which is the ordinary [[PITFALLS]] #65 shape rather than an
  // attack: another process held the database across the one write that records the group. With no
  // number anywhere, amendment (O)'s FIRST positive fact is the only thing left standing.
  for (const source of IDENTITY_SOURCES) {
    if (source.name === "column") continue; // taken with the payload, which is its projection
    await source.remove({ path: f.path, data: f.data, promotionId: live.promotionId });
  }
  // And that fact is a row in the same file, under the same unkeyed hash. The tenth round called
  // this table "the hash-chained database … the merge cannot reach past the chain".
  forgeApprovalNeverSpent(f.path);

  assert.equal(groupAlive(live.pgid), true, "this test is only evidence while the merge is alive");
  assert.match(await psGroup(live.pgid), /git[^\n]*merge/u);
  const measured = await looseness(f, live.promotionId);
  assert.equal(measured.destructiveOffer, false,
    `a recovery command was offered while the merge was writing:\n${measured.report}`);
  assert.equal(measured.notWaiting, false,
    `the record stopped waiting for a merge that is still writing:\n${measured.report}`);
  assert.equal(measured.shortPhraseAccepted, false,
    "a phrase that says nothing about main being written released a live merge");
  assert.equal(measured.markerReleased, false,
    "the project's exclusive marker was handed back over a live merge");
  assert.ok(!/reset --hard/u.test(measured.report), measured.report);
  assert.equal(groupAlive(live.pgid), true, "nothing here may kill the merge");
});

test("an owner ending a wait nothing can account for is handed no destructive command, asked while the merge is alive", async (t) => {
  const f = await fixture(t);
  const live = await liveMerge(t, f);
  // The hostile half of BLOCKER-2 is two lines and forges nothing: the hook empties the file whose
  // path this product put in the hook's own environment. Everything after this is the owner doing
  // precisely what the product printed for them, and nothing else.
  for (const source of IDENTITY_SOURCES) {
    if (source.name === "column") continue;
    await source.remove({ path: f.path, data: f.data, promotionId: live.promotionId });
  }
  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const before = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(before.pending?.code, "MERGE_IDENTITY_UNACCOUNTED");
  assert.equal(before.pending?.release, MERGE_UNACCOUNTED_ABANDON_CONFIRMATION);

  const after = await registry.abandonMergeProcessGroup({
    promotionId: live.promotionId, roomId: "demo", mainPath: f.source, pgid: 0,
    confirmation: MERGE_UNACCOUNTED_ABANDON_CONFIRMATION, decidedBy: "local-cli",
  });
  assert.ok(!("unreadable" in after));
  // The coverage gap this closes, named: every existing test of this exit killed the group and
  // waited for it to be gone BEFORE calling it. Nobody had ever walked it with the merge alive —
  // which is the only state in which the command that follows can race a write to main.
  assert.equal(groupAlive(live.pgid), true, "the merge must still be alive or this proves nothing");
  assert.match(await psGroup(live.pgid), /git[^\n]*merge/u);
  assert.equal(after.observation.mergeConclusion, "MERGE_ACCOUNT_ABANDONED_BY_OWNER");
  assert.notEqual(after.observation.recoveryKind, "reset-to-pre-promotion",
    "an owner declaration licensed a command that rewrites the repository");
  assert.ok(!/reset --hard/u.test(after.observation.recovery ?? ""),
    `a destructive command followed a declaration: ${after.observation.recovery}`);
  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);
  assert.equal(groupAlive(live.pgid), true, "nothing here may kill the merge");
});

test("the rollback the process that watched the merge die may offer is not offered after a restart", async (t) => {
  const f = await fixture(t);
  // ⛔ This test used to reach the destructive offer through a `pre-merge-commit` hook that hangs
  // until the deadline kills it. Amendment (V-3) took that route away on purpose: a promotion that
  // ran a hook can have left a process no `-pgid` probe can find, so its leader's exit no longer
  // authorizes a command that rewrites the repository. The subject here is (T-1) — a stored
  // conclusion read back is not first-hand — so the fixture moves to the case (V-3) leaves alone: a
  // repository with nothing in it that can execute, where a READ-ONLY WORKING TREE makes the merge
  // itself fail. Nothing but `git merge` ever runs, and this process watched its leader close.
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(preview.hooks.hooks, [], "this repository can execute something; (V-3) applies");
  assert.deepEqual(preview.hooks.drivers, []);

  await chmod(f.source, 0o500);
  let failed: Awaited<ReturnType<typeof promote>> | undefined;
  try {
    failed = await promote(f, approval, token);
  } finally {
    await chmod(f.source, 0o755);
  }
  assert.notEqual(failed.promotion.observation.attempt?.exitCode, 0, "the merge did not fail");
  assert.equal(failed.promotion.observation.recoveryKind, "reset-to-pre-promotion");
  assert.equal(failed.promotion.observation.recovery,
    `git -C ${failed.promotion.mainPath} reset --hard ${beforeHead}`);
  assert.equal(failed.promotion.observation.mergeConclusion, "MERGE_LEADER_EXIT_OBSERVED");
  f.registry.close();

  // The same durable row, with the state rewound to `applying` so it is re-observed — the pattern
  // the `gitSpawnObserved` test below uses, and the only way to read a settled row again. Nothing
  // about what was OBSERVED changes; what changes is that the reader is no longer the process that
  // watched. Amendment (T-1): reading a first-hand conclusion back is not having made it, because
  // `leaderClosedFirstHand` comes from the call and has nowhere to be stored.
  const rewound = new DatabaseSync(f.path);
  const row = rewound.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1")
    .get() as unknown as Record<string, string | number | null>;
  const fields = [
    row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
    row.candidate_head, row.recovery_ref, row.main_head_before, null,
    row.restore_json, String(row.observation_json), "applying", 1, row.started_at_ms,
    row.updated_at_ms,
  ];
  rewound.prepare("UPDATE candidate_merge_promotions SET state='applying',main_head_after=NULL,"
    + "owner_pid=1,row_hash=? WHERE id=?").run(
    createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex"), String(row.id),
  );
  rewound.close();

  const restarted = new CandidateRegistry(f.data);
  t.after(() => restarted.close());
  const later = readable((await restarted.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(later.observation.mergeConclusion, "MERGE_LEADER_EXIT_OBSERVED");
  assert.notEqual(later.observation.recoveryKind, "reset-to-pre-promotion",
    "a restart was handed a destructive command for a merge it never watched");
  assert.equal(later.observation.recoveryKind, "search-for-unaccounted-merge");
  assert.ok(!(later.observation.recovery ?? "").includes("reset --hard"));
  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry: restarted, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);
});

test("a hook that rewrites the promotion row mid-merge cannot make this process settle on it", async (t) => {
  const f = await fixture(t);
  // Written because the mutation that removes the `byOwnerDeclaration` argument from the stored
  // conclusion read-back SURVIVED, and [[PITFALLS]] #107 says a survivor is a question. Answering
  // it meant constructing the only state where the two differ: a stored DECLARATION REASON with no
  // declaration FIELD beside it — the two fields are checked before the read-back, and on any row
  // this product wrote they always accompany the reason — reached by the one caller that can set
  // `firstHand`, which is `#settlePromotion`.
  //
  // The construction failed, and how it failed is the answer: `#writePromotion` is a compare-and-set
  // on `row_hash`, so a row rewritten under a settle in flight makes that settle REFUSE rather than
  // conclude. So `firstHand` and a forged stored declaration cannot meet at a `#recoveryHint` call,
  // and every other caller has `firstHand: false` and takes a non-destructive branch either way.
  // That is why the mutation is equivalent — measured, not reasoned from reading the source.
  const forge = join(f.root, "forge-conclusion.mjs");
  await writeFile(forge, [
    'import { DatabaseSync } from "node:sqlite";',
    'import { createHash } from "node:crypto";',
    'import { dirname, join } from "node:path";',
    // One line of path arithmetic against a variable this product exports into every hook.
    'const dataDir = dirname(dirname(process.env.GIT_TRACE2_EVENT));',
    'const db = new DatabaseSync(join(dataDir, "candidate-registry.sqlite"));',
    'const row = db.prepare("SELECT * FROM candidate_merge_promotions").all()[0];',
    'const obs = JSON.parse(row.observation_json);',
    'obs.mergeConclusion = "MERGE_ACCOUNT_ABANDONED_BY_OWNER";',
    'delete obs.mergeAccountAbandoned; delete obs.mergeGroupDisowned;',
    'const observationJson = JSON.stringify(obs);',
    'const base = [row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,',
    '  row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,',
    '  row.restore_json, observationJson, row.state, row.owner_pid, row.started_at_ms, row.updated_at_ms];',
    'const fields = row.merge_pgid === null && row.merge_boot_at_sec === null',
    '  ? base : [...base, row.merge_pgid, row.merge_boot_at_sec];',
    'const hash = createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");',
    'db.prepare("UPDATE candidate_merge_promotions SET observation_json=?,row_hash=? WHERE id=?")',
    '  .run(observationJson, hash, row.id);',
    'db.close();',
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  await hook(f, "pre-merge-commit",
    `#!/bin/sh\n${JSON.stringify(process.execPath)} ${JSON.stringify(forge)} || exit 9\nexit 1\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  await assert.rejects(
    f.registry.promoteMainMerge({
      approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_CONCURRENT_UPDATE/u,
    "a settle wrote its conclusion on top of a row something else had rewritten",
  );
  // The forge really did land — otherwise the refusal above would prove nothing ([[PITFALLS]] #106).
  const listed = readable((await f.registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(listed.observation.mergeConclusion, "MERGE_ACCOUNT_ABANDONED_BY_OWNER");
  assert.equal(listed.observation.mergeAccountAbandoned, undefined,
    "the reason has to stand alone, or the declaration check above the read-back fires first");
  // And whatever the record now says, no destructive command came out of it.
  assert.notEqual(listed.observation.recoveryKind, "reset-to-pre-promotion");
  assert.ok(!(listed.observation.recovery ?? "").includes("reset --hard"),
    `a destructive command followed a forged declaration: ${listed.observation.recovery}`);
  assert.equal(await head(f.source), beforeHead, "nothing here may write to main");
});

test("a preview taken over a live merge is a torn read that no write path will accept", async (t) => {
  const f = await fixture(t);
  const live = await liveMerge(t, f);
  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());

  // `previewMainMerge` is the one entry point that reads main WITHOUT asking whether a promotion is
  // unresolved ([[PITFALLS]] #114, deliberate: an owner has to be able to look). So it runs its
  // whole fingerprint stream over a working tree a `git merge` is rewriting, and the digest it
  // produces is bound to a torn snapshot. That is a cost, not a defect — and this test exists
  // because "harmless" here is a property of the GATES, not a happy accident, and a property
  // nothing asserts is a property that leaves.
  const preview = await registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(groupAlive(live.pgid), true, "the read has to happen over a live merge to be torn");
  assert.match(await psGroup(live.pgid), /git[^\n]*merge/u);
  assert.equal(preview.approvable, false, "a torn snapshot was offered as approvable");
  assert.ok(preview.blockers.length > 0, "refused with no reason named");

  // Every write path that could carry that digest forward, refused BY NAME.
  await assert.rejects(
    registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
      mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
    }),
    /MAIN_MERGE_PROMOTION_UNRESOLVED/u,
  );
  assert.equal(groupAlive(live.pgid), true, "nothing here may kill the merge");
});

/**
 * A promotion left with a live `git merge` inside a hook that never returns, and the ids needed to
 * talk about it. Shared by the mutation-driven tests below, which differ only in what they damage.
 */
async function liveMerge(t: TestContext, f: Fixture): Promise<{
  promotionId: string; pgid: number; tracePath: string;
}> {
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  const reader = new CandidateRegistry(f.data);
  const listed = readable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  reader.close();
  f.registry.close();
  const pgid = listed.observation.mergePgid as number;
  assert.ok(typeof pgid === "number" && pgid > 1);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  return {
    promotionId: listed.id,
    pgid,
    tracePath: join(f.data, "promotion-traces", `${listed.id}.jsonl`),
  };
}

/** What releasing this record requires right now, read fresh through a new registry each time. */
async function releaseRequirement(f: Fixture): Promise<{
  confirmation: string | undefined;
  alive: Array<[string, number]>;
  probeReadable: boolean | undefined;
  recordedGroups: Array<{ source: string; pgid: number; bootAtSec: number | null }>;
}> {
  const reader = new CandidateRegistry(f.data);
  try {
    const listed = unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    return {
      confirmation: listed.release?.confirmation,
      alive: (listed.release?.alive ?? []).map((entry) => [entry.kind, entry.pid]),
      probeReadable: listed.release?.probeReadable,
      recordedGroups: [...(listed.release?.recordedGroups ?? [])],
    };
  } finally { reader.close(); }
}

/**
 * FINDING P1-5 (eighth round), first of five. `traceBootAtSec()` derives which boot a trace-named
 * pid belongs to, and replacing its whole body with `return null` left every test green — a decision
 * with no test in either direction ([[PITFALLS]] #107).
 *
 * Both directions are here. Forwards: the column says one boot, git's trace says this one, the pid
 * is alive, and the record must show BOTH numbers and refuse. Backwards is in "a process group
 * recorded before a reboot…", which now moves git's start instant back and requires the record to
 * settle — a `traceBootAtSec` that always answers `null` cannot rule a pid out there.
 */
test("the boot a trace-named merge belongs to is derived, and a disagreement about it is shown", async (t) => {
  const f = await fixture(t);
  const { pgid } = await liveMerge(t, f);
  // The column's boot moved to another machine-run; the payload destroyed; git's trace untouched.
  damagePromotionRow(f.path, { mergeBootAtSec: 1, observationJson: "this used to be JSON" });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");

  const requirement = await releaseRequirement(f);
  const traced = requirement.recordedGroups.find((entry) => entry.source === "trace");
  assert.ok(traced !== undefined, JSON.stringify(requirement.recordedGroups));
  assert.equal(traced.pgid, pgid);
  assert.ok(typeof traced.bootAtSec === "number",
    "git's trace named a boot of `null`, so nothing could have been ruled in or out by it");
  // Within a minute of now: the trace records when git started, and git started moments ago.
  assert.ok(Math.abs(traced.bootAtSec - Math.round(Date.now() / 1_000 - uptime())) <= 60,
    `the derived boot is not this one: ${traced.bootAtSec}`);
  assert.ok(requirement.recordedGroups.some((entry) => entry.source === "column" && entry.bootAtSec === 1),
    JSON.stringify(requirement.recordedGroups));
  assert.deepEqual(requirement.alive, [["merge", pgid]]);
  assert.equal(requirement.probeReadable, false,
    "two sources disagreeing about which boot a LIVE pid belongs to is not an answered question");
  assert.equal(requirement.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
});

/**
 * FINDING P1-5, second and third. `traceMergeIdentity()` answers `{spawned: true, identity: null}`
 * for a `start` event whose session id it cannot parse, and `durableMergeIdentity()` turns that into
 * "unreadable". Two mutations — returning `NO_TRACE_READING` instead, and dropping the
 * `trace.spawned ?` test — both left every test green, and both turn this record's answer from
 * REFUSED into ACCEPTED.
 *
 * The precondition matters ([[PITFALLS]] #106): the trace really does contain a `start` event, and
 * its sid really does not carry a pid. That is what a future git release changing the format looks
 * like, and it must fail towards "a merge started and nobody can name it".
 */
test("a trace that proves a merge started without naming it is an unanswered question", async (t) => {
  const f = await fixture(t);
  const { promotionId, pgid, tracePath } = await liveMerge(t, f);
  const payload = JSON.stringify({
    code: "PROMOTION_STARTED", mainHead: null, observedAt: "1970-01-01T00:00:00.000Z",
  });
  damagePromotionRow(f.path, { mergePgid: null, mergeBootAtSec: null, observationJson: payload });
  // A `start` event in git's own format except for the one thing this depends on.
  await writeFile(tracePath, `${JSON.stringify({
    event: "start", sid: "20260807T000000.000000Z-Hdeadbeef", time: "2026-08-07T00:00:00.000000Z",
    argv: ["git", "merge"],
  })}\n`, { encoding: "utf8", mode: 0o600 });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");

  const unnamed = await releaseRequirement(f);
  assert.deepEqual(unnamed.alive, [], "the shape of this finding is that no number can be read");
  assert.deepEqual(unnamed.recordedGroups, []);
  assert.equal(unnamed.probeReadable, false,
    "a trace proving a merge started is not evidence that nothing is running");
  assert.equal(unnamed.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  await assert.rejects(
    reader.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: 0,
      confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    (error: Error & { confirmation?: string }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
  );
  reader.close();

  /*
   * The other direction ([[PITFALLS]] #107), rewritten by amendment (O).
   *
   * It used to take the trace away and expect the SHORT phrase, on the reasoning that a record
   * saying "no group", with nothing left to contradict it, has answered. That reasoning is the
   * ninth round's BLOCKER: the thing that would contradict it is a file whose path this product
   * hands to every hook the merge runs, so "nothing contradicts it" is a state the observed merge
   * can produce for itself — and it did, in a probe that changed two lines of a hook.
   *
   * The short phrase still has to work, or it is out of service and bar item 11 is broken. What it
   * takes now is evidence rather than quiet: the merge ends and the COLUMN — inside the row, under
   * its hash, out of the hook's reach — names the number that is now gone.
   */
  await rm(tracePath, { force: true });
  const silenced = await releaseRequirement(f);
  assert.equal(silenced.probeReadable, false,
    "removing the only source that could contradict the record is not an answer from it");
  assert.equal(silenced.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);

  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  const boot = Math.round(Date.now() / 1_000 - uptime());
  damagePromotionRow(f.path, {
    mergePgid: pgid,
    mergeBootAtSec: boot,
    observationJson: JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, mergePgid: pgid,
      mergeGroup: { pgid, bootAtSec: boot, spawnedAt: null },
      observedAt: "1970-01-01T00:00:00.000Z",
    }),
  });
  const answered = await releaseRequirement(f);
  assert.deepEqual(answered.alive, []);
  assert.deepEqual(answered.recordedGroups.map((entry) => entry.source), ["column", "payload"]);
  assert.equal(answered.probeReadable, true,
    "a number the row itself names, probed and gone, is what an answer looks like");
  assert.equal(answered.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);
  const releasing = new CandidateRegistry(f.data);
  t.after(() => releasing.close());
  const beforeTree = await treeDigest(f.source);
  const released = unreadable(await releasing.abandonMergeProcessGroup({
    promotionId, roomId: "demo", mainPath: f.source, pgid: 0,
    confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }));
  assert.equal(released.holdsProjectExclusiveMarker, false);
  assert.equal(await treeDigest(f.source), beforeTree);
});

/**
 * FINDING P1-5, fourth. The release path counts a probe that comes back `unknown` as alive, and
 * removing that left every test green. `unknown` is not "gone": it is a number nobody can ask about,
 * and turning undecidable into "no such process" is [[PITFALLS]] #85 in the one place where being
 * wrong means releasing a project-wide marker over a live write.
 *
 * Both directions, one shape apart: a recorded group that probes `unknown` must block, and one that
 * probes `gone` must not — otherwise "count everything" would pass the first half and retire the
 * short phrase.
 */
test("a recorded group nobody can ask about blocks the release, and one that is gone does not", async (t) => {
  const f = await fixture(t);
  const { promotionId, pgid, tracePath } = await liveMerge(t, f);
  // Outside `pid_t`, which `process.kill` refuses with neither ESRCH nor EPERM. Measured, not
  // assumed ([[PITFALLS]] #106).
  const undecidable = 2 ** 40;
  assert.throws(
    () => process.kill(undecidable, 0),
    (error: NodeJS.ErrnoException) => error.code !== "ESRCH" && error.code !== "EPERM",
  );
  await rm(tracePath, { force: true });
  damagePromotionRow(f.path, {
    mergePgid: undecidable, observationJson: "this used to be JSON",
  });

  const blocked = await releaseRequirement(f);
  assert.deepEqual(blocked.alive, [["merge", undecidable]],
    "a number nobody can ask about was reported as nothing running");
  assert.equal(blocked.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  await assert.rejects(
    reader.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: undecidable,
      confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    /MAIN_MERGE_PROMOTION_ROW_UNREADABLE/u,
  );
  reader.close();

  // The other direction: the same column holding a number that probes GONE. This one must not block,
  // or the branch above would be satisfied by a rule that never lets anything through.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  assert.equal(groupAlive(pgid), false);
  damagePromotionRow(f.path, { mergePgid: pgid, observationJson: "this used to be JSON" });
  const gone = await releaseRequirement(f);
  assert.deepEqual(gone.alive, []);
  assert.equal(gone.probeReadable, true);
  assert.equal(gone.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);
});

/**
 * FINDING P1-5, fifth: the `contested` decision the main agent could not pin down and the reviewer
 * characterised. Replacing it with `false` left every test green.
 *
 * The shape is the one the reviewer named `deny-notrace`: the column names a number nothing is
 * using, the payload states there is no group at all, no source outside the row survives, and the
 * merge is alive. Two in-row sources, two different answers, and the one this code would otherwise
 * have preferred probes dead — so "prefer the column" reads as good news over a live merge.
 */
test("a record whose two in-row sources contradict each other has not answered", async (t) => {
  const f = await fixture(t);
  const { promotionId, pgid, tracePath } = await liveMerge(t, f);
  await rm(tracePath, { force: true });
  damagePromotionRow(f.path, {
    mergePgid: 999_999,
    observationJson: JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, mergePgid: null, mergeGroup: null,
      observedAt: "1970-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
  const listing = await psGroup(pgid);
  assert.match(listing, /git[^\n]*merge/u, `ps -g ${pgid} does not show the merge:\n${listing}`);

  const contested = await releaseRequirement(f);
  assert.equal(contested.probeReadable, false,
    "a column and a payload that disagree were reported as an answered question");
  assert.equal(contested.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  await assert.rejects(
    reader.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: 999_999,
      confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    (error: Error & { confirmation?: string; probeReadable?: boolean }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION
      && error.probeReadable === false,
  );
  reader.close();

  // The other direction: the same two sources AGREEING, on a merge that is over. Not contested, so
  // the short phrase works — which is what stops "call everything contested" from passing above.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  damagePromotionRow(f.path, {
    mergePgid: pgid,
    observationJson: JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, mergePgid: pgid,
      mergeGroup: { pgid, bootAtSec: Math.round(Date.now() / 1_000 - uptime()), spawnedAt: null },
      observedAt: "1970-01-01T00:00:00.000Z",
    }),
  });
  const agreeing = await releaseRequirement(f);
  assert.deepEqual(agreeing.alive, []);
  assert.equal(agreeing.probeReadable, true,
    "two sources that say the same thing are an answer");
  assert.equal(agreeing.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);
});

/**
 * Starts a promotion in a separate OS process whose `#recordMergePgid` write THROWS instead of
 * succeeding — the durable state another process holding the database produces, without needing a
 * second process to hold it.
 */
async function promoteWithFailingPgidWrite(
  f: Fixture, approval: MergeApproval, token: string,
): Promise<ReturnType<typeof spawn>> {
  const module = fileURLToPath(new URL("../src/core/candidate-registry.ts", import.meta.url));
  const script = join(f.root, `promote-nopgid-${randomUUID()}.mjs`);
  await writeFile(script, [
    "const [data, source, approvalId, token, taskId] = process.argv.slice(2);",
    `const { CandidateRegistry } = await import(${JSON.stringify(module)});`,
    "const registry = new CandidateRegistry(data, {",
    "  faultPoint: (name) => { if (name === 'merge-pgid-record') throw new Error('DATABASE_LOCKED'); },",
    "});",
    "process.stdout.write('ready\\n');",
    "await registry.promoteMainMerge({",
    "  approvalId, token, action: 'merge-candidate-into-main', taskId, roomId: 'demo', mainPath: source,",
    "});",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return spawn(process.execPath, [
    script, f.data, f.source, approval.id, token, f.task.taskId,
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

/*
 * FINDING B-2 (eighth round), amendment (N). `#recordMergePgid` was `catch { return row; }` and
 * `runProcess` wrapped the listener in `catch { }` on top of it, so a failed write left a record
 * bit-for-bit identical to a promotion that never spawned git — and the second reads as "nothing is
 * running". The reviewer reached this state with nothing forged at all, by holding the database
 * across that one write.
 *
 * Here the write is made to throw directly, which is the same durable outcome without the timing.
 * What is asserted is that the failure is NAMED, that the number it was carrying survives outside
 * the database, and that a reader is conservative because of it.
 */
test("a merge whose process-group write failed is recorded as such, and still blocks", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);

  const child = await promoteWithFailingPgidWrite(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  f.registry.close();

  // The row really did NOT get the number — the precondition, not an assumption.
  const db = new DatabaseSync(f.path);
  const row = db.prepare("SELECT * FROM candidate_merge_promotions WHERE state='applying'")
    .get() as unknown as Record<string, string | number | null>;
  db.close();
  const promotionId = String(row.id);
  assert.equal(row.merge_pgid, null, "the column was written, so this test proves nothing");
  assert.equal(
    (JSON.parse(String(row.observation_json)) as { mergePgid?: unknown }).mergePgid, undefined,
    "the payload was written, so this test proves nothing",
  );

  // The named trace amendment (N) asks for, outside the database that just refused the write.
  const marker = join(f.data, "promotion-traces", `${promotionId}.spawn-record.json`);
  assert.equal(await exists(marker), true, "the failure left nothing behind at all");
  const recorded = JSON.parse(await readFile(marker, "utf8")) as { pgid: number; bootAtSec: number };
  assert.ok(Number.isSafeInteger(recorded.pgid) && recorded.pgid > 1);
  assert.ok(Number.isSafeInteger(recorded.bootAtSec));
  const pgid = recorded.pgid;
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
  assert.match(await psGroup(pgid), /git[^\n]*merge/u);

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const listed = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(listed.state, "applying");
  assert.equal(listed.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  assert.equal(listed.pending?.pid, pgid, "the number the failed write was carrying was lost");

  // Deleting git's trace as well leaves the marker as the only source, which is the point of it
  // living outside the row AND outside git's control.
  await rm(join(f.data, "promotion-traces", `${promotionId}.jsonl`), { force: true });
  const alone = new CandidateRegistry(f.data);
  t.after(() => alone.close());
  const fromMarker = readable((await alone.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(fromMarker.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING");
  assert.equal(fromMarker.pending?.pid, pgid);
  alone.close();

  // Once the merge is over the record must be able to move — the marker names an incomplete
  // account, not a permanent block ([[PITFALLS]] #102). Amendment (O) changed HOW it moves: nothing
  // inside this row ever held the number, so the only sources that could now say the merge is over
  // are the two the merge's own hooks can write, and a record they can settle is not settled. The
  // wait ends with the owner, in one named phrase, told exactly what to look for.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  const waiting = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(waiting.state, "applying");
  assert.equal(waiting.pending?.code, "MERGE_IDENTITY_UNACCOUNTED");
  assert.equal(waiting.pending?.release, MERGE_UNACCOUNTED_ABANDON_CONFIRMATION);
  await registry.abandonMergeProcessGroup({
    promotionId, roomId: "demo", mainPath: f.source, pgid,
    confirmation: MERGE_UNACCOUNTED_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });
  const settled = await settledPromotion(registry, f.source, 100);
  assert.equal(settled.state, "needs-manual-review");
  assert.equal(settled.observation.mergeIdentityUnrecorded, true,
    "`not recorded` and `nothing to record` are still the same record");
  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry, decidedBy: "local-cli",
  });
  // Attributed rather than asserted (amendment (Q)). The old sentence — "the write that was
  // carrying this merge's process group FAILED" — was a claim about what happened inside this
  // product, derived from a file existing in a directory the merge's own hooks can name. A hook
  // that writes that file made the product print it, and it was not true.
  assert.match(report, /a marker beside this promotion's trace says the write that would have/u);
  assert.ok(!/process group FAILED/u.test(report), report);
});

/*
 * FINDING P2-7 (eighth round), amendment (K). The fifth kill window: `git merge` has been spawned
 * and its process group has NOT reached SQLite yet. It is the only window in which the intent record
 * cannot, by itself, decide how it should be read — and the four windows the bar listed did not
 * include it, because the bar listed windows instead of saying "every step boundary that leaves the
 * intent record incomplete".
 *
 * A real SIGKILL, delivered from inside that window to a real process, exactly as the other crash
 * tests do. Nothing is simulated: the merge is detached, so it survives and keeps writing.
 */
test("a promotion killed between spawning git and recording its group does not settle", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const child = await promoteInChildAt(f, approval, token, "merge-pgid-record");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  await waitForExit(child);
  assert.equal(child.signalCode, "SIGKILL", "the process did not die inside the window under test");
  f.registry.close();

  const db = new DatabaseSync(f.path);
  const row = db.prepare("SELECT * FROM candidate_merge_promotions WHERE state='applying'")
    .get() as unknown as Record<string, string | number | null>;
  db.close();
  const promotionId = String(row.id);
  // The window really is the one named: the record exists, and it holds no group.
  assert.equal(row.merge_pgid, null);
  assert.equal(
    (JSON.parse(String(row.observation_json)) as { mergePgid?: unknown }).mergePgid, undefined,
  );
  // And nothing wrote the marker either — the process was killed, not told the write failed. Git's
  // own trace is the only source left, which is why it has to be one.
  assert.equal(
    await exists(join(f.data, "promotion-traces", `${promotionId}.spawn-record.json`)), false,
  );

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const listed = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  const pgid = listed.pending?.pid as number;
  assert.equal(listed.pending?.code, "MERGE_SUBPROCESS_STILL_RUNNING",
    "a new process concluded about a merge that was still writing");
  assert.ok(typeof pgid === "number" && pgid > 1);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
  assert.match(await psGroup(pgid), /git[^\n]*merge/u, "the named pid is not the merge");
  assert.equal(listed.state, "applying");
  assert.equal(listed.observation.recovery, undefined, "a recovery command was offered mid-write");
  assert.equal(await head(f.source), beforeHead);

  // The other direction: once that merge is gone the record must be able to move. A window that
  // blocks forever is the defect, not the fix.
  //
  // How it moves changed with amendment (O), and this is the honest consequence rather than a
  // weakening. Nothing INSIDE this row ever held the group — that is the whole premise of the test —
  // so once the merge is over the only thing that could say so is git's trace, whose path this
  // product hands to every hook the merge runs. A record that would settle on that is a record a
  // hook can settle. So the wait ends where it should: with the owner, told exactly what to look
  // for, in one named phrase.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  const stillWaiting = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(stillWaiting.state, "applying");
  assert.equal(stillWaiting.pending?.code, "MERGE_IDENTITY_UNACCOUNTED");
  assert.equal(stillWaiting.pending?.pid, undefined, "a state with no number must not invent one");
  assert.equal(stillWaiting.pending?.release, MERGE_UNACCOUNTED_ABANDON_CONFIRMATION);
  // The search it hands over is read-only and names the commit this promotion was authorized for.
  assert.match(stillWaiting.pending?.inspect ?? "", /^ps -eo /u);
  assert.ok(!/reset|kill|clean|checkout/u.test(stillWaiting.pending?.inspect ?? ""));
  // Every other phrase is refused, so the exit cannot be reached by guessing.
  for (const wrong of [MERGE_GROUP_ABANDON_CONFIRMATION, MERGE_LIVE_ABANDON_CONFIRMATION]) {
    await assert.rejects(
      registry.abandonMergeProcessGroup({
        promotionId, roomId: "demo", mainPath: f.source, pgid,
        confirmation: wrong, decidedBy: "local-web",
      }),
      /MERGE_GROUP_ABANDON_CONFIRMATION_MISMATCH/u,
    );
  }
  await registry.abandonMergeProcessGroup({
    promotionId, roomId: "demo", mainPath: f.source, pgid,
    confirmation: MERGE_UNACCOUNTED_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });
  const settled = await settledPromotion(registry, f.source, 100);
  assert.notEqual(settled.state, "applying");
  assert.equal(settled.pending, undefined);
});

/*
 * FINDING B-3 (eighth round). The column-versus-payload agreement check ran in one direction only,
 * and the mirror of it was let through for the sake of rows written before the columns existed.
 *
 * One half of the mirror CAN be made exact and is made here: the two columns are always written
 * together, so half of the pair is damage whichever half is missing, and a row written before they
 * existed carries NULL in BOTH and is untouched by it. The other half — a NULL column beside a
 * payload that names nothing — is indistinguishable from an upgrade at this layer and is refused by
 * the identity reading instead, which is what the three tests above the corruption matrix measure.
 */
test("half of the merge-group column pair is damage in either direction, and both NULL is not", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  assert.equal((await promote(f, approval, await grant(f, approval))).promotion.state, "applied");
  f.registry.close();

  const rehash = (row: Record<string, string | number | null>,
    pgid: number | null, boot: number | null): string => {
    const base = [
      row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
      row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
      row.restore_json, row.observation_json, row.state, row.owner_pid, row.started_at_ms,
      row.updated_at_ms,
    ];
    return createHash("sha256").update(JSON.stringify(
      pgid === null && boot === null ? base : [...base, pgid, boot],
    ), "utf8").digest("hex");
  };
  const write = (pgid: number | null, boot: number | null): void => {
    const db = new DatabaseSync(f.path);
    const row = db.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1")
      .get() as unknown as Record<string, string | number | null>;
    db.prepare(
      "UPDATE candidate_merge_promotions SET merge_pgid=?,merge_boot_at_sec=?,row_hash=? WHERE id=?",
    ).run(pgid, boot, rehash(row, pgid, boot), String(row.id));
    db.close();
  };
  const stateNow = async (): Promise<string> => {
    const reader = new CandidateRegistry(f.data);
    try {
      return (await reader.promotions({ roomId: "demo", mainPath: f.source }))[0]?.state ?? "missing";
    } finally { reader.close(); }
  };

  // A settled promotion carries NULL in both, which is also exactly what a row written before these
  // columns existed carries. It must stay readable, or every upgraded database reads as tampered
  // ([[PITFALLS]] #100).
  write(null, null);
  assert.equal(await stateNow(), "applied");

  // A whole pair, with the payload naming the same group — the shape the product itself writes.
  // Readable, which is what stops "refuse any non-null column" from satisfying the two cases below.
  const boot = 1_700_000_000;
  const restore = (): void => {
    rewritePromotionRow(f.path, ({ observation }) => ({
      observation: {
        ...observation, mergePgid: 4_242, mergeGroup: { pgid: 4_242, bootAtSec: boot, spawnedAt: null },
      },
    }));
  };
  restore();
  assert.equal(await stateNow(), "applied");

  // Half of that pair, each way round. The hash is recomputed to match, so what is being measured is
  // the pair check and not the integrity check.
  write(4_242, null);
  assert.equal(await stateNow(), "unreadable", "a pgid with no boot beside it was accepted");
  restore();
  write(null, boot);
  assert.equal(await stateNow(), "unreadable", "a boot with no pgid beside it was accepted");
});

/*
 * FINDING P1-4 (eighth round), amendment (M). The path git writes its trace to is handed to every
 * hook this promotion runs, in `GIT_TRACE2_EVENT`, and hooks are the unsandboxed trust boundary this
 * phase introduced. Measured on the previous commit: a hook that replaced its own trace with a
 * `start` event naming a DEAD pid got `probeReadable: true`, the SHORT phrase ACCEPTED and the
 * project's exclusive marker handed back, while `ps -g` listed the live `git merge`. Deleting and
 * padding the same file were correctly refused; forging was the one direction that failed open.
 *
 * The rule now: a group named ONLY by a source outside the row is probed — which can only add a
 * reason to refuse — and can never be the thing that makes the record answered. Both directions are
 * measured, because "never answered" would satisfy the first half while retiring the short phrase.
 */
test("a group named only by git's trace cannot turn an unread record into an answered one", async (t) => {
  const f = await fixture(t);
  const { promotionId, pgid, tracePath } = await liveMerge(t, f);
  // Exactly what the reviewer's hook wrote: one `start` event, git's own shape, a dead pid.
  const dead = 0x000f_423f;
  assert.throws(() => process.kill(dead, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  const forged = `${JSON.stringify({
    event: "start", sid: "20260101T000000.000000Z-Hdeadbeef-P000f423f",
    time: "2026-01-01T00:00:00.000000Z", argv: ["git", "merge"],
  })}\n`;
  await writeFile(tracePath, forged, { encoding: "utf8", mode: 0o600 });
  // Both in-row sources destroyed, which is the state the reviewer's probe combined it with.
  damagePromotionRow(f.path, {
    observationJson: "this used to be JSON", mergePgid: null, mergeBootAtSec: null,
  });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
  assert.match(await psGroup(pgid), /git[^\n]*merge/u);

  const forgedRequirement = await releaseRequirement(f);
  assert.deepEqual(forgedRequirement.recordedGroups.map((entry) => [entry.source, entry.pgid]),
    [["trace", dead]], "the shape of this finding is a trace naming a number nothing is using");
  assert.deepEqual(forgedRequirement.alive, [], "the forged number is dead; that is the point");
  assert.equal(forgedRequirement.probeReadable, false,
    "a number a hook could have written was treated as this record's answer");
  assert.equal(forgedRequirement.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  const reader = new CandidateRegistry(f.data);
  t.after(() => reader.close());
  await assert.rejects(
    reader.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: dead,
      confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    /MAIN_MERGE_PROMOTION_ROW_UNREADABLE/u,
  );
  // And the project's marker is still held, so no other task slipped past.
  assert.equal(
    unreadable((await reader.promotions({ roomId: "demo", mainPath: f.source }))[0])
      .holdsProjectExclusiveMarker, true,
  );
  reader.close();

  /*
   * The other direction. Put the row's OWN sources back, naming the same dead number, and the record
   * is answered again — the trace stopped being the only thing saying it. Without this, "the outside
   * source never counts" and "the outside source is ignored entirely" would be the same test.
   */
  const boot = Math.round(Date.now() / 1_000 - uptime());
  // Same number, same boot, in the trace too — so the three of them agree and nothing is contested.
  await writeFile(tracePath, `${JSON.stringify({
    event: "start", sid: "20260101T000000.000000Z-Hdeadbeef-P000f423f",
    time: new Date().toISOString(), argv: ["git", "merge"],
  })}\n`, { encoding: "utf8", mode: 0o600 });
  damagePromotionRow(f.path, {
    mergePgid: dead,
    mergeBootAtSec: boot,
    observationJson: JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, mergePgid: dead,
      mergeGroup: { pgid: dead, bootAtSec: boot, spawnedAt: null },
      observedAt: "1970-01-01T00:00:00.000Z",
    }),
  });
  const inRow = await releaseRequirement(f);
  assert.deepEqual(inRow.alive, []);
  assert.equal(inRow.probeReadable, true,
    "the row's own sources named the group and probed it dead; that is an answer");
  assert.equal(inRow.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);
});

/*
 * The second half of amendment (N): "and let every later read take the conservative path".
 *
 * A row that ALSO fails its integrity check, with the spawn-record marker beside it, must ask for
 * the phrase that says the account is incomplete — even though every number it names probes dead,
 * because the one thing this record knows for certain is that its own account of the merge is
 * missing something.
 *
 * This is the only shape in which that rule is observable: while the merge is alive the list of
 * things that might be running is non-empty and the phrase is the long one anyway. A mutation
 * removing the rule left every other test in this file green ([[PITFALLS]] #107, third case — not a
 * missing precondition and not an equivalent mutation, simply a branch with no test), and this is
 * that test.
 */
test("a record whose group was never written asks for the longer phrase even with nothing alive", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  await hook(f, "pre-merge-commit", `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 900\n`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const child = await promoteWithFailingPgidWrite(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  child.kill("SIGKILL");
  await waitForExit(child);
  f.registry.close();

  const db = new DatabaseSync(f.path);
  const promotionId = String((db.prepare(
    "SELECT id FROM candidate_merge_promotions WHERE state='applying'",
  ).get() as { id: string }).id);
  db.close();
  const marker = join(f.data, "promotion-traces", `${promotionId}.spawn-record.json`);
  const recorded = JSON.parse(await readFile(marker, "utf8")) as { pgid: number };
  const pgid = recorded.pgid;
  // End the merge first, so what follows is about the PHRASE and not about a live process. Nothing
  // re-observes the row in between, so it stays `applying` and keeps its release requirement.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  assert.equal(groupAlive(pgid), false, "this test measures the phrase, not a live process");
  await rm(join(f.data, "promotion-traces", `${promotionId}.jsonl`), { force: true });
  damagePromotionRow(f.path, { observationJson: "this used to be JSON" });

  const incomplete = await releaseRequirement(f);
  assert.deepEqual(incomplete.alive, []);
  assert.deepEqual(incomplete.recordedGroups.map((entry) => [entry.source, entry.pgid]),
    [["spawn-record", pgid]], "the marker is the only source left, and it must be one");
  assert.equal(incomplete.probeReadable, false,
    "a record that knows its own account of the merge is missing has not answered");
  assert.equal(incomplete.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);

  /*
   * The other direction. Put the group back into the row's OWN columns, where it would have gone if
   * the write had not failed, and take the marker away: the record now names a number, the number
   * probes dead, and the short phrase is the one that works. Then put the marker back and watch
   * exactly that answer switch off again. Without both halves, "always ask for the long phrase"
   * would satisfy the assertions above while retiring the short one, which bar item 11 forbids.
   *
   * Amendment (O) changed what the first half has to look like. It used to write a payload STATING
   * that there is no group, which is the ninth round's blocker in miniature: a record asserting that
   * there is nothing to probe is the absence of an answer, not an answer, and it is exactly what a
   * merge that has silenced its own sources leaves behind.
   */
  const boot = Math.round(Date.now() / 1_000 - uptime());
  damagePromotionRow(f.path, {
    mergePgid: pgid,
    mergeBootAtSec: boot,
    observationJson: JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, mergePgid: pgid,
      mergeGroup: { pgid, bootAtSec: boot, spawnedAt: null },
      observedAt: "1970-01-01T00:00:00.000Z",
    }),
  });
  await rm(marker, { force: true });
  const answered = await releaseRequirement(f);
  assert.deepEqual(answered.recordedGroups.map((entry) => entry.source), ["column", "payload"]);
  assert.deepEqual(answered.alive, [], "this half is only about the phrase, not a live process");
  assert.equal(answered.probeReadable, true);
  assert.equal(answered.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);

  await writeFile(marker, JSON.stringify(recorded), { encoding: "utf8", mode: 0o600 });
  const contradicted = await releaseRequirement(f);
  assert.equal(contradicted.probeReadable, false,
    "the marker says this record never got the group; that is not `there was no group`");
  assert.equal(contradicted.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
});

// =============================================================================================
// Amendment (R). "Seven paths are each driven by their own test" was a claim about call sites, and
// the ninth round's reviewer falsified it by reverting six of the seven wirings one line at a time
// and watching 123/123 stay green. A path is only wired if a mutation that unwires it turns
// something red. Each test below exists to be that red, and names the mutation it answers.
// =============================================================================================

/**
 * Mutations OBS and SETTLE. `#observeMain` reads the merge's identity from EVERY source, and
 * `#settlePromotion` hands it the real one rather than a trace-less reading.
 *
 * Reverting either was measured green: in every state the delivered tests reached, the payload
 * happened to hold the same number, so "reads four sources" and "reads one" were indistinguishable.
 * This is the state where they are not — the ONE write that records the group failed, so the two
 * in-row sources hold nothing at all, and the only thing that knows what git was is the marker
 * beside the trace. The merge itself then runs to completion with a background process still in its
 * group, which is the shape that makes the identity observable rather than merely stored.
 */
test("what an observation records about the merge comes from every source, not from the payload", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const lingering = join(f.root, "lingering.pid");
  await hook(f, "pre-merge-commit", `#!/bin/sh
touch ${JSON.stringify(started)}
sleep 900 </dev/null >/dev/null 2>&1 &
echo $! > ${JSON.stringify(lingering)}
exit 0
`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const child = await promoteWithFailingPgidWrite(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await waitForExit(child);
  f.registry.close();

  const db = new DatabaseSync(f.path);
  const row = db.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1")
    .get() as unknown as Record<string, string | number | null>;
  db.close();
  const promotionId = String(row.id);
  const observation = JSON.parse(String(row.observation_json)) as {
    mergePgid?: number | null;
    mergeGroupSurvivors?: { pgid: number };
    mergeIdentityUnrecorded?: boolean;
  };
  // The precondition ([[PITFALLS]] #106): the ONE write that puts the group into the row failed, so
  // at the moment the observation was made neither in-row source held the number, and an
  // observation that names it can only have got it from outside the row. (The column below holds it
  // now BECAUSE the observation recovered it — which is the thing under test.)
  const marker = join(f.data, "promotion-traces", `${promotionId}.spawn-record.json`);
  assert.equal(await exists(marker), true, "the pgid write did not fail, so this test proves nothing");
  assert.equal(observation.mergeIdentityUnrecorded, true,
    "the record does not know its own account was incomplete, so nothing below is about recovery");
  const pgid = (JSON.parse(await readFile(marker, "utf8")) as { pgid: number }).pgid;
  const survivor = Number((await readFile(lingering, "utf8")).trim());
  t.after(() => { try { process.kill(survivor, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(groupAlive(pgid), true, "the background process this test needs is already gone");

  assert.equal(observation.mergePgid, pgid,
    "the record settled without naming the group its own write had lost");
  assert.equal(observation.mergeGroupSurvivors?.pgid, pgid,
    "the leader was gone and the group was not, and the record did not say so");
  // ⛔ This used to assert `applied`. Amendment (V-4): the merge really did succeed and the record
  // still says so — `authorizedMergeCommit` is the first-hand reading of main's HEAD, and it is what
  // `mainMutated` and `#markCandidateMerged` are now taken from. What it no longer does is hand the
  // project's exclusive marker back while a process this merge left is alive, which is a different
  // fact and was measured letting a SECOND promotion write the same main.
  assert.equal(
    (observation as { authorizedMergeCommit?: unknown }).authorizedMergeCommit, true,
    "the merge itself succeeded and must be recorded as such",
  );
  assert.equal(String(row.state), "applying",
    "the exclusive marker was handed back while the merge's own group was still alive");
  assert.equal(
    (observation as { code?: unknown }).code,
    "AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_GROUP_SURVIVORS",
  );
});

/**
 * Mutations OGATE and HINT, and the second half of finding P1-1 that the ninth round measured only
 * half of.
 *
 * A repository hook — trusted by this phase, run as the owner, unsandboxed — derives the marker's
 * path from `$GIT_TRACE2_EVENT`, which this product hands it, and writes a number of its own
 * choosing into it. The ninth round measured the false SENTENCE that produced; this measures the
 * other half, which is what the record then DOES.
 *
 * The direction is fail-closed and that is the point: a hook can make this product refuse to
 * conclude, and it cannot make it conclude. What it costs the owner is one named phrase; what it
 * would have cost them is `git reset --hard` over a tree they were told was quiet.
 */
test("a hook that forges the spawn-record marker cannot make this record conclude, or lie about it", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const chosen = join(f.root, "chosen.pid");
  // Nothing here is privileged: `${GIT_TRACE2_EVENT%.jsonl}.spawn-record.json` is ordinary shell
  // against a variable the product itself exported into this hook's environment.
  await hook(f, "pre-merge-commit", `#!/bin/sh
touch ${JSON.stringify(started)}
sleep 900 </dev/null >/dev/null 2>&1 &
echo $! > ${JSON.stringify(chosen)}
printf '{"pgid":%s,"at":"2026-08-07T00:00:00.000Z"}' "$!" \
  > "\${GIT_TRACE2_EVENT%.jsonl}.spawn-record.json"
exit 1
`);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);
  const result = await promote(f, approval, token);
  const forged = Number((await readFile(chosen, "utf8")).trim());
  t.after(() => { try { process.kill(forged, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(await exists(started), true, "the hook never ran");
  assert.ok(Number.isSafeInteger(forged) && forged > 1);
  assert.equal(pidAlive(forged), true, "the number the hook chose is not alive, so nothing is proved");
  assert.equal(result.mainMutated, false);

  // It did NOT settle, and it named what it could not account for rather than concluding.
  const listed = readable((await f.registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(listed.state, "applying");
  // This process is still the owner, so the record is blocked on both numbers — and the second of
  // them is the one the hook picked. Without amendment (O) the row would have settled `rolled-back`
  // here, which is the state that hands the project's exclusive marker back.
  assert.equal(listed.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");
  assert.equal(listed.pending?.alsoBlockedBy?.pid, forged);
  assert.notEqual(listed.observation.recoveryKind, "reset-to-pre-promotion",
    "a hook chose the number, and the product offered to rewrite the repository over it");
  // Amendment (T) moved this from "a read-only command" to "no command at all". A record that has
  // concluded nothing has no remedy to offer, and the read-only instruction the owner needs is on
  // `pending` — where it is attached to the state that produced it instead of sitting in a field
  // called `recovery`.
  assert.equal(listed.observation.recovery, undefined);
  assert.equal(listed.pending?.inspect.startsWith("ps "), true, listed.pending?.inspect);

  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry: f.registry, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), report);
  // The sentence the ninth round caught: a claim about what happened inside this product, decided
  // by the contents of a repository. What is printed now is attributed and true either way.
  assert.ok(!/process group FAILED/u.test(report), report);
  assert.match(report, /nothing here can verify who wrote that marker/u);

  // And the way out, once the owner has looked. The marker is still there and still says what it
  // says, so no probe will ever account for this merge: the exit has to be the owner's.
  process.kill(forged, "SIGKILL");
  for (let attempt = 0; attempt < 100 && pidAlive(forged); attempt += 1) await delay(100);
  await f.registry.abandonPromotionOwnerProcess({
    promotionId: listed.id, roomId: "demo", mainPath: f.source, pid: process.pid,
    confirmation: MERGE_OWNER_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });
  const stuck = readable((await f.registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(stuck.pending?.code, "MERGE_IDENTITY_UNACCOUNTED",
    "the marker is still there and still says this record never got its group");
  await f.registry.abandonMergeProcessGroup({
    promotionId: listed.id, roomId: "demo", mainPath: f.source, pgid: 0,
    confirmation: MERGE_UNACCOUNTED_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });
  const settled = await settledPromotion(f.registry, f.source, 100);
  assert.notEqual(settled.state, "applying");
  assert.equal(await head(f.source), beforeHead, "nothing here may write to main");
});

/**
 * Mutation RECTRUST. `unreadableReleaseRequirement` asks with `recordTrusted: false`, and flipping
 * it to `true` was measured green because no test anywhere put a `mergeGroupDisowned` into a row
 * whose hash had failed — `grep -n mergeGroupDisowned test/` found none.
 *
 * That is the whole purpose of the flag: a row nobody can read must not be able to drop a live
 * merge out of its own list of things to probe by claiming its owner already disowned it.
 */
test("an unreadable row cannot disown a live merge on its own say-so", async (t) => {
  const f = await fixture(t);
  const { promotionId, pgid } = await liveMerge(t, f);
  const boot = Math.round(Date.now() / 1_000 - uptime());
  damagePromotionRow(f.path, {
    mergePgid: pgid,
    mergeBootAtSec: boot,
    observationJson: JSON.stringify({
      code: "PROMOTION_STARTED", mainHead: null, mergePgid: pgid,
      mergeGroup: { pgid, bootAtSec: boot, spawnedAt: null },
      // The claim the row makes about itself, in a row whose integrity check has failed.
      mergeGroupDisowned: { pgid, at: "2026-08-07T00:00:00.000Z", decidedBy: "local-web", bootAtSec: boot },
      observedAt: "1970-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
  assert.match(await psGroup(pgid), /git[^\n]*merge/u);

  const requirement = await releaseRequirement(f);
  assert.deepEqual(requirement.alive, [["merge", pgid]],
    "an unreadable row dropped a live merge from what gets probed by claiming it was disowned");
  assert.equal(requirement.probeReadable, false);
  assert.equal(requirement.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  // The number has to be quoted, which is only required because the number is still visible.
  await assert.rejects(
    registry.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: 999_999,
      confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
  );
  const released = unreadable(await registry.abandonMergeProcessGroup({
    promotionId, roomId: "demo", mainPath: f.source, pgid,
    confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION, decidedBy: "local-web",
  }));
  assert.equal(released.holdsProjectExclusiveMarker, false);
  assert.equal(groupAlive(pgid), true, "releasing a marker must not kill anything");
});

/**
 * Mutations BUSYUNREAD and RELUNREAD. Both call sites of `unreadableReleaseRequirement` inside the
 * class were passing the row's real outside sources, and replacing either with a trace-less reading
 * was measured green — no test drove an unreadable row whose group is named ONLY from outside it.
 *
 * That row is not exotic: it is what a corruption that reaches `observation_json` leaves behind
 * whenever the pgid write had already been lost, and it is the exact shape the sixth round measured
 * releasing a project-wide marker over a `git merge` that `ps -g` was listing.
 */
test("an unreadable row whose merge only git's trace names still shows it, and still demands it", async (t) => {
  const f = await fixture(t);
  // A second task, approved and granted BEFORE anything writes, so the project-wide gate can be
  // driven by a caller that has proved it holds the token — the only caller shown the pids — and
  // so its refusal cannot come from the first merge having dirtied the tree.
  const second = await f.registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
  });
  await commit(second.candidatePath, "second.txt", "second work\n", "second work");
  await f.registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, summary: "also ready",
  });
  const preview = await f.registry.previewMainMerge({
    taskId: second.taskId, roomId: "demo", mainPath: f.source,
  });
  const approval = await f.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  const token = (await f.registry.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: f.source,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  })).approvalToken;

  const { promotionId, pgid } = await liveMerge(t, f);
  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());

  damagePromotionRow(f.path, {
    observationJson: "this used to be JSON", mergePgid: null, mergeBootAtSec: null,
  });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");

  // PATH 11: the listing's own view of an unreadable row.
  const requirement = await releaseRequirement(f);
  assert.deepEqual(requirement.alive, [["merge", pgid]],
    "the only source that names this merge is outside the row, and it was not read");
  assert.deepEqual(requirement.recordedGroups.map((entry) => entry.source), ["trace"]);

  // PATH 9: every OTHER task in the project. The refusal carries the number, so the owner is told
  // what is in the way rather than only that something is.
  await assert.rejects(
    registry.promoteMainMerge({
      approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
      taskId: second.taskId, roomId: "demo", mainPath: f.source,
    }),
    (error: Error & { alive?: ReadonlyArray<{ pid: number }>; probeReadable?: boolean }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.probeReadable === false
      && (error.alive ?? []).some((entry) => entry.pid === pgid),
  );

  // PATH 11 again, at the door that actually writes: the number must be quoted.
  await assert.rejects(
    registry.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: 999_999,
      confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION, decidedBy: "local-web",
    }),
    /MERGE_GROUP_ABANDON_PGID_MISMATCH/u,
  );
  assert.equal(groupAlive(pgid), true, "nothing here may kill the merge");
});

/**
 * Mutation ENTIRELY. `abandonPromotionEntirely` records whether the owner was abandoning a merge
 * that was RUNNING, and reverting that reading to the payload alone was measured green.
 *
 * `whileRunning` is the owner's trail: it is what the record says they were told they were
 * accepting. A `false` written while `ps -g` lists the merge is a trail that misrepresents the
 * decision, and the payload is exactly the source a failed pgid write leaves empty.
 */
test("the combined release records what the owner was actually shown, from every source", async (t) => {
  const f = await fixture(t);
  const { promotionId, pgid } = await liveMerge(t, f);
  // The owner process alive again (this test process), and the group removed from both in-row
  // sources so that only git's trace names it.
  rewritePromotionRow(f.path, ({ observation }) => {
    const next = { ...observation };
    delete next.mergePgid;
    delete next.mergeGroup;
    return { ownerPid: process.pid, observation: next };
  });
  assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const blocked = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(blocked.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");
  assert.equal(blocked.pending?.alsoBlockedBy?.pid, pgid);

  const released = await registry.abandonPromotionEntirely({
    promotionId, roomId: "demo", mainPath: f.source, pid: process.pid, pgid,
    confirmation: MERGE_PROMOTION_ABANDON_CONFIRMATION, decidedBy: "local-web",
  });
  assert.equal(released.observation.mergeGroupDisowned?.whileRunning, true,
    "the trail says the owner abandoned a merge that was over; `ps -g` says otherwise");
  // …and the record keeps offering only a look at it, never a rewrite, for as long as it lives.
  assert.equal(released.observation.recoveryKind, "inspect-live-merge");
  assert.equal(groupAlive(pgid), true, "nothing here may kill the merge");
});

// =============================================================================================
// Amendment (U), twelfth round. Two measured defects, both INSIDE rules this document already had.
//
// BLOCKER-1 was a semantic mismatch: `firstHand` (now `leaderClosedFirstHand`) is produced with a
// comment that scopes it to the merge LEADER, and `#recoveryHint` consumed it as "the merge is
// over". `process-runner.ts` waits for the whole group only for a child IT terminated
// (`if (terminationReason && processGroupExists()) return;`), so a hook that backgrounds one process
// with its stdio off git's pipes lets `close` fire on time — and the survivor then wrote main.
//
// BLOCKER-2 was a violation of amendment (O) by the amendment that introduced it: the `rolled-back`
// self-evidence test was `observed.state === "rolled-back" && !trace.spawned`, and `!trace.spawned`
// is an ABSENCE being used to reach a TERMINAL state. What supplied that absence was a
// `merge.<name>.driver` — not a hook, run by git BEFORE it writes the working tree, and named in
// THREAT_MODEL F26 through six corrections as owner-executed code inside this trust boundary.
//
// Both directions are measured below ([[PITFALLS]] #107), and every one of these tests asserts the
// merge (or its survivor) is really alive before it measures anything ([[PITFALLS]] #106, #129).
// =============================================================================================

/**
 * A hook that leaves ONE process behind in the merge's own group, with its stdio taken off git's
 * pipes so the leader's `close` still fires on schedule.
 *
 * `</dev/null >/dev/null 2>&1` is the whole trick and it is three characters of shell: the runner
 * resolves when the pipes close and the leader exits, and neither of those waits for anything else
 * in the group.
 */
function survivorHook(started: string, wrote: string, target: string): string {
  return `#!/bin/sh
touch ${JSON.stringify(started)}
( sleep 4; date +%s > ${JSON.stringify(wrote)}; echo "left behind" >> ${JSON.stringify(target)}; sleep 900 ) </dev/null >/dev/null 2>&1 &
exit 1
`;
}

/**
 * The direction [[PITFALLS]] #107 says was missing: SAME process, group still alive.
 *
 * The delivered coverage for a hook that backgrounds something (`a hook that leaves a background
 * process behind …`) SIGKILLs the orchestrator first, so `leaderClosedFirstHand` is false on that
 * path and the gate under test is never reached. This one keeps the orchestrator alive and lets it
 * conclude first-hand, which is the only state in which the eleventh round's `reset --hard` was
 * produced.
 */
test("a merge whose group outlives its leader is not concluded by the process that watched the leader", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const wrote = join(f.root, "survivor-wrote-at");
  await hook(f, "pre-merge-commit", survivorHook(started, wrote, join(f.source, "README.md")));

  // A SECOND task over the same main, approved BEFORE anything is written, so a later refusal cannot
  // come from the first merge having dirtied the tree.
  const second = await f.registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
  });
  await commit(second.candidatePath, "second.txt", "second work\n", "second work");
  await f.registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, summary: "also ready",
  });
  const secondPreview = await f.registry.previewMainMerge({
    taskId: second.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(secondPreview.approvable, true, secondPreview.blockers.join(","));
  const secondApproval = await f.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, completionId: secondPreview.completionId,
    previewDigest: secondPreview.previewDigest,
  });
  const secondToken = (await f.registry.grantMainMerge({
    approvalId: secondApproval.id, roomId: "demo", mainPath: f.source,
    previewDigest: secondApproval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  })).approvalToken;

  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  // IN THIS PROCESS. This is the first-hand path and the one (T-1) still trusts.
  const result = await promote(f, approval, token);
  assert.equal(await exists(started), true, "the hook never ran, so nothing was left behind");
  const survivorGroup = result.promotion.observation.mergeGroupSurvivors?.pgid;
  assert.ok(typeof survivorGroup === "number" && survivorGroup > 1,
    "the record does not name the group its own hook left alive");
  t.after(() => { try { process.kill(-survivorGroup, "SIGKILL"); } catch { /* already gone */ } });

  // [[PITFALLS]] #106/#129: nothing below is evidence unless something really is alive in that group.
  assert.equal(groupAlive(survivorGroup), true, "the survivor is already gone; this proves nothing");
  assert.match(await psGroup(survivorGroup), /sleep/u);

  assert.equal(result.promotion.state, "applying",
    "the exclusive marker was handed back while a process the merge left was still alive");
  assert.equal(result.mainMutated, false);
  assert.equal(result.promotion.observation.mergeConclusion, "MERGE_GROUP_SURVIVORS_STILL_ALIVE");
  assert.equal(result.promotion.observation.recovery, undefined,
    `a command was offered over a live survivor: ${result.promotion.observation.recovery}`);
  assert.equal(result.promotion.observation.recoveryKind, undefined);

  // This process is still the owner, so the record reports BOTH numbers rather than the owner alone
  // — otherwise releasing the owner wait would be the first the owner heard of the survivor.
  const listed = readable((await f.registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(listed.pending?.code, "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING");
  assert.equal(listed.pending?.pid, process.pid);
  assert.equal(listed.pending?.alsoBlockedBy?.pid, survivorGroup);

  // The CLI, which is where the owner actually reads it. P2 of the eleventh round's review: this
  // fact was in the payload and the listing did not print it.
  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry: f.registry, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);
  assert.ok(!/is still being waited on/u.test(report), report);
  assert.match(report, new RegExp(`survivors\\s+this record names pgid ${survivorGroup}`, "u"));
  // Attributed, not asserted: the line says what was asked and what came back ([[PITFALLS]] #86).
  assert.match(report, /its leader did not answer and the group did/u);

  // Every OTHER task in the project, refused BY NAME rather than by a dirty tree.
  await assert.rejects(
    f.registry.promoteMainMerge({
      approvalId: secondApproval.id, token: secondToken, action: MERGE_APPROVAL_GRANT,
      taskId: second.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );

  // And the survivor does what it was always going to do, which is the whole finding.
  for (let attempt = 0; attempt < 300 && !await exists(wrote); attempt += 1) await delay(100);
  assert.equal(await exists(wrote), true, "the survivor never wrote, so this scenario is not the one");
  assert.notEqual(await status(f.source), "",
    "the survivor was expected to have changed main after the leader closed");
  assert.equal(await head(f.source), beforeHead, "nothing here may move main's HEAD");

  // The same record once the owner process is out of the way — the ordinary shape after a restart,
  // and the one where the survivor is the only thing left in the way.
  f.registry.close();
  rewritePromotionRow(f.path, () => ({ ownerPid: 1 }));
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
  const alone = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(alone.state, "applying");
  assert.equal(alone.pending?.code, "MERGE_GROUP_SURVIVOR_STILL_RUNNING");
  assert.equal(alone.pending?.pid, survivorGroup);
  assert.equal(alone.pending?.release, MERGE_LIVE_ABANDON_CONFIRMATION);
  assert.equal(alone.observation.recovery, undefined);

  // The short phrase says nothing about main being written, and this state is exactly about that.
  await assert.rejects(
    reopened.abandonMergeProcessGroup({
      promotionId: alone.id, roomId: "demo", mainPath: f.source, pgid: survivorGroup,
      confirmation: MERGE_GROUP_ABANDON_CONFIRMATION, decidedBy: "local-cli",
    }),
    (error: Error) => /MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING|CONFIRMATION_MISMATCH/u.test(error.message),
  );

  // Bar item 11: there IS a way out, and it costs the owner one phrase and one number they can see.
  const released = await reopened.abandonMergeProcessGroup({
    promotionId: alone.id, roomId: "demo", mainPath: f.source, pgid: survivorGroup,
    confirmation: MERGE_LIVE_ABANDON_CONFIRMATION, decidedBy: "local-cli",
  });
  assert.ok(!("unreadable" in released));
  assert.equal(released.observation.mergeGroupDisowned?.pgid, survivorGroup);
  assert.equal(released.observation.mergeGroupDisowned?.whileRunning, true,
    "the trail says the owner abandoned a merge that was over; `ps -g` says otherwise");
  assert.notEqual(released.observation.recoveryKind, "reset-to-pre-promotion",
    "an owner declaration licensed a rewrite of a repository something is still writing");
  assert.ok(!/reset --hard/u.test(released.observation.recovery ?? ""));
  assert.equal(groupAlive(survivorGroup), true, "nothing here may kill anything");
});

/**
 * The same survivor on the UNREADABLE path, which asks its own question with its own inputs.
 *
 * `unreadableReleaseRequirement()` decides whether the owner is asked for the phrase that mentions
 * main being written, and it built that decision out of `standing.alive` — a list the leader-only
 * probe leaves empty when the leader is gone and the group is not. So a corrupted row with a live
 * survivor asked for the SHORT phrase and reported `probeReadable: true`.
 */
test("an unreadable row whose merge left a live process asks for the phrase that says so", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const wrote = join(f.root, "survivor-wrote-at");
  await hook(f, "pre-merge-commit", survivorHook(started, wrote, join(f.source, "README.md")));
  const approval = await raise(f);
  const token = await grant(f, approval);
  const result = await promote(f, approval, token);
  const survivorGroup = result.promotion.observation.mergeGroupSurvivors?.pgid;
  assert.ok(typeof survivorGroup === "number" && survivorGroup > 1);
  t.after(() => { try { process.kill(-survivorGroup, "SIGKILL"); } catch { /* already gone */ } });
  const promotionId = result.promotion.id;
  f.registry.close();

  // Real corruption does not pick fields: the payload goes with the hash.
  damagePromotionRow(f.path, { observationJson: "not json at all" });
  assert.equal(groupAlive(survivorGroup), true, "the survivor is already gone; this proves nothing");

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const entry = unreadable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(entry.release?.probeReadable, false,
    "a row that cannot be read reported a positive answer about a live process");
  assert.equal(entry.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
  assert.ok((entry.release?.alive ?? []).some((alive) => alive.pid === survivorGroup),
    `the survivor was not listed: ${JSON.stringify(entry.release?.alive)}`);
  // The refusal names the phrase that IS required rather than just saying no, and it names the
  // survivor, so the owner is told what they are being asked about.
  await assert.rejects(
    registry.abandonMergeProcessGroup({
      promotionId, roomId: "demo", mainPath: f.source, pgid: survivorGroup,
      confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, decidedBy: "local-cli",
    }),
    (error: Error & { confirmation?: string; alive?: ReadonlyArray<{ pid: number }> }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION
      && (error.alive ?? []).some((entry) => entry.pid === survivorGroup),
  );
  assert.equal(groupAlive(survivorGroup), true, "nothing here may kill anything");
});

/**
 * A repository whose merge of one path runs a `merge.<name>.driver` this test controls.
 *
 * The driver has to be configured BEFORE the approval, because `configDigest` binds the whole of
 * main's effective config and anything written afterwards is refused as drift (F26). That is not a
 * limitation of the attack: `.git/config` is shared by every linked worktree, so the untrusted
 * candidate worktree can write it at any point before the owner approves — which is the shape F26
 * has recorded through six corrections.
 *
 * The `GIT_TRACE2_EVENT` guard is what lets the same script serve the preview: `merge-tree` runs the
 * driver too (F23) and this product does not give that command a trace, so the preview resolves the
 * file benignly and stays approvable.
 */
async function driverFixture(t: TestContext, body: string): Promise<Fixture & { marker: string }> {
  const f = await fixture(t, {
    initial: { ".gitattributes": "shared.txt merge=held\n", "shared.txt": "base\n" },
    beforeComplete: async ({ source, candidatePath }) => {
      await commit(candidatePath, "shared.txt", "base\ncandidate\n", "candidate edits shared");
      await commit(source, "shared.txt", "main\nbase\n", "main edits shared");
    },
  });
  const marker = join(f.root, "driver-entered");
  const script = join(f.root, "driver.sh");
  const aside = join(f.root, "moved-aside");
  await mkdir(aside);
  // `mv`, never `rm` — this project's deletion rule is two-stage, and nothing here needs the bytes
  // gone. What it needs is for the working tree to read exactly as it did before the promotion
  // started, which is the state the exemption under test called unreachable: git's own
  // `.merge_file_*` scratch files and its index lock are the only things that give the merge away
  // at this point, and they are ordinary files in a directory the driver already runs inside.
  await writeFile(script, `#!/bin/sh
if [ -z "$GIT_TRACE2_EVENT" ]; then cp "$1" "$2"; exit 0; fi
touch ${JSON.stringify(marker)}
${body}mv ${JSON.stringify(f.source)}/.merge_file_* ${JSON.stringify(aside)}/ 2>/dev/null
mv ${JSON.stringify(join(f.source, ".git", "index.lock"))} ${JSON.stringify(aside)}/ 2>/dev/null
sleep 900
`, { encoding: "utf8", mode: 0o700 });
  await execFileAsync("git", ["config", "merge.held.name", "held"], { cwd: f.source });
  await execFileAsync("git", ["config", "merge.held.driver", `${script} %O %A %B`], { cwd: f.source });
  return { ...f, marker };
}

/**
 * BLOCKER-2, measured end to end: the state the residual-risk row said could not be reached.
 *
 * That row licensed `observed.state === "rolled-back" && !trace.spawned` with "no hostile hook can
 * be involved — git runs no hook before it writes the tree". A merge driver is not a hook and git
 * runs it BEFORE the working tree is written: at driver time HEAD is unchanged, the index is
 * unchanged, `git status --porcelain` is empty and there is no `MERGE_HEAD`. So the driver silences
 * every source, kills the orchestrator, and the repository reads bit-for-bit "nothing happened"
 * while a `git merge` sits inside the driver waiting to write it.
 */
test("a merge driver that silences every source cannot make an untouched main a terminal answer", async (t) => {
  const forge = join(await mkdtemp(join(tmpdir(), "orchestratory-driver-")), "forge.mjs");
  t.after(async () => await rm(join(forge, ".."), { recursive: true, force: true }));
  const f = await driverFixture(t, `${JSON.stringify(process.execPath)} ${JSON.stringify(forge)}\n`);
  await writeFile(forge, [
    'import { DatabaseSync } from "node:sqlite";',
    'import { createHash } from "node:crypto";',
    'import { dirname, join } from "node:path";',
    'import { writeFileSync } from "node:fs";',
    // One line of path arithmetic against a variable this product exports into everything git runs.
    'const trace = process.env.GIT_TRACE2_EVENT;',
    'const db = new DatabaseSync(join(dirname(dirname(trace)), "candidate-registry.sqlite"));',
    'const row = db.prepare("SELECT * FROM candidate_merge_promotions").all()[0];',
    'const obs = JSON.parse(row.observation_json);',
    // Both in-row sources made to say, positively, "there is no group" — the answer
    // `payloadMergeIdentity` accepts.
    'obs.mergePgid = null; delete obs.mergeGroup;',
    'const observationJson = JSON.stringify(obs);',
    'const fields = [row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,',
    '  row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,',
    '  row.restore_json, observationJson, row.state, row.owner_pid, row.started_at_ms, row.updated_at_ms];',
    'const hash = createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");',
    'db.prepare("UPDATE candidate_merge_promotions SET merge_pgid=NULL,merge_boot_at_sec=NULL,'
      + 'observation_json=?,row_hash=? WHERE id=?").run(observationJson, hash, row.id);',
    'db.close();',
    'writeFileSync(trace, "");',
    'try { process.kill(row.owner_pid, "SIGKILL"); } catch { /* already gone */ }',
  ].join("\n"), { encoding: "utf8", mode: 0o600 });

  // A SECOND task over the same main, approved BEFORE anything writes.
  const second = await f.registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
  });
  await commit(second.candidatePath, "second.txt", "second work\n", "second work");
  await f.registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, summary: "also ready",
  });
  const secondPreview = await f.registry.previewMainMerge({
    taskId: second.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(secondPreview.approvable, true, secondPreview.blockers.join(","));
  const secondApproval = await f.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, completionId: secondPreview.completionId,
    previewDigest: secondPreview.previewDigest,
  });
  const secondToken = (await f.registry.grantMainMerge({
    approvalId: secondApproval.id, roomId: "demo", mainPath: f.source,
    previewDigest: secondApproval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  })).approvalToken;

  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);
  const child = await promoteInChildAt(f, approval, token);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 600 && !await exists(f.marker); attempt += 1) await delay(100);
  assert.equal(await exists(f.marker), true, "the merge driver never ran; this test is not the one");
  await waitForExit(child);
  assert.equal(child.signalCode, "SIGKILL", "the driver did not kill the orchestrator");
  f.registry.close();

  // The state the residual-risk row said was unreachable, asserted rather than assumed
  // ([[PITFALLS]] #106): main bit-for-bit where it started, and a live `git merge` over it.
  const live = (await execFileAsync("ps", ["-eo", "pid,pgid,command"])).stdout.split("\n")
    .find((line) => line.includes("--no-ff") && line.includes(approval.binding.candidateHead));
  assert.ok(live !== undefined, "the `git merge` is not running, so nothing here is evidence");
  const pgid = Number(live.trim().split(/\s+/)[1]);
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(await status(f.source), "", "main is already dirty, so `rolled-back` was never possible");
  assert.equal(await head(f.source), beforeHead);
  assert.equal(await exists(join(f.source, ".git", "MERGE_HEAD")), false,
    "git wrote MERGE_HEAD before the driver, which would make this finding moot");

  const registry = new CandidateRegistry(f.data);
  t.after(() => registry.close());
  const entry = readable((await registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(entry.state, "applying",
    "an absence moved a record into a terminal state while a merge was about to write main");
  assert.equal(entry.observation.code, "MERGE_UNACCOUNTED_FOR_NOTHING_CONCLUDED");
  assert.equal(entry.pending?.code, "MERGE_IDENTITY_UNACCOUNTED");
  assert.equal(entry.observation.recovery, undefined);

  await assert.rejects(
    registry.promoteMainMerge({
      approvalId: secondApproval.id, token: secondToken, action: MERGE_APPROVAL_GRANT,
      taskId: second.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );
  assert.equal(groupAlive(pgid), true, "nothing here may kill the merge");

  // The reviewer left this open: what the first merge finally writes once the driver returns. It is
  // measured rather than reasoned about — the driver resolved the path by leaving `%A` (main's side)
  // in place, so the merge commits and main ends up carrying the authorized two-parent commit with
  // main's version of the contested file. That is a merge the owner approved landing after the
  // orchestrator died, which is exactly the case the record must not have called `rolled-back`.
  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);
  const afterHead = await head(f.source);
  assert.equal(afterHead, beforeHead,
    `a SIGKILLed merge still moved main's HEAD: ${beforeHead} -> ${afterHead}`);
});

/**
 * The positive criterion that replaced `!trace.spawned`, and the fact that it does not survive.
 *
 * `gitSpawnObserved` is false only when THIS process asked the operating system for a merge process
 * and never received one. It comes from the call stack. Amendment (T)'s cost is restated here as a
 * measurement rather than as prose: the same durable state, read by a new registry, does not settle.
 */
test("only the process that asked for a merge and got none may call an untouched main rolled back", async (t) => {
  class UnspawnableGit extends GitBroker {
    override async mergeIntoHead(): Promise<never> {
      // What `runProcess` does when `spawn` never produces a pid: it rejects, and no `onSpawn` ever
      // fires. Nothing was written, and this process is the only one that can know that.
      throw new Error("PROCESS_SPAWN_FAILED");
    }
  }
  const root = await mkdtemp(join(tmpdir(), "orchestratory-nospawn-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await commit(source, "README.md", "committed main\n", "initial");
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const registry = new CandidateRegistry(data, { gitBroker: new UnspawnableGit() });
  const task = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "nospawn",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
  await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready",
  });
  const preview = await registry.previewMainMerge({ taskId: task.taskId, roomId: "demo", mainPath: source });
  const approval = await registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  const token = (await registry.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: source,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  })).approvalToken;
  const result = await registry.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: task.taskId, roomId: "demo", mainPath: source,
  });
  assert.equal(result.promotion.state, "rolled-back",
    "the one process that could prove no merge exists was not allowed to say so");
  assert.equal(result.mainMutated, false);
  registry.close();

  // The other direction. Nothing about the durable row changed; what changed is that the reader can
  // no longer be the process that watched. It re-observes the same untouched repository and refuses
  // to conclude, which is the stated cost of amendment (T) and (U).
  const rewound = new DatabaseSync(join(data, "candidate-registry.sqlite"));
  const row = rewound.prepare("SELECT * FROM candidate_merge_promotions LIMIT 1")
    .get() as unknown as Record<string, string | number | null>;
  rewound.close();
  const observationJson = String(row.observation_json);
  const fields = [
    row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
    row.candidate_head, row.recovery_ref, row.main_head_before, null,
    row.restore_json, observationJson, "applying", 1, row.started_at_ms, row.updated_at_ms,
  ];
  const hash = createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
  const rewind = new DatabaseSync(join(data, "candidate-registry.sqlite"));
  rewind.prepare("UPDATE candidate_merge_promotions SET state='applying',main_head_after=NULL,"
    + "owner_pid=1,row_hash=? WHERE id=?").run(hash, String(row.id));
  rewind.close();

  const restarted = new CandidateRegistry(data);
  t.after(() => restarted.close());
  const later = readable((await restarted.promotions({ roomId: "demo", mainPath: source }))[0]);
  assert.equal(later.state, "applying",
    "a reader that never watched anything settled an untouched main from an absence");
  assert.equal(later.pending?.code, "MERGE_IDENTITY_UNACCOUNTED");
  assert.equal(later.observation.recovery, undefined);
});

/*
 * The subset enumeration at the OTHER timepoint.
 *
 * All 32 delivered subset tests hold the merge open from a `pre-merge-commit` hook, which git runs
 * AFTER it has written the working tree — so `observed.state` on that path can never be
 * `rolled-back`, and the second branch of `selfEvidencingOutcome` was never on any of their code
 * paths. The framework enumerated the right source subsets at the wrong moment.
 *
 * A `merge.<name>.driver` runs BEFORE the tree is written, which is the moment where "main is
 * bit-for-bit where it started" and "a merge is about to write main" are the same reading. Three
 * subsets rather than sixteen, chosen for what they cover rather than for completeness: the empty
 * one is the baseline that proves the fixture reaches this state at all, `column + payload` is the
 * fully-trusted row the eleventh round's blocker produced, and the full set is amendment (P)'s
 * requirement — the maximum one actor can do in one promotion.
 */
for (const action of IDENTITY_ACTIONS) {
for (const subset of [
  [] as MergeIdentitySourceCase[],
  IDENTITY_SOURCES.filter((source) => source.name === "column" || source.name === "payload"),
  [...IDENTITY_SOURCES],
]) {
  const label = subset.length === 0
    ? `nothing is ${action.verb}`
    : `${subset.map((source) => source.name).join(" + ")} are ${action.verb}`;
  test(`no source subset lets a merge inside its driver be concluded about: ${label}`, async (t) => {
    const f = await driverFixture(t, "");
    const second = await f.registry.start({
      actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
    });
    await commit(second.candidatePath, "second.txt", "second work\n", "second work");
    await f.registry.complete({
      actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
      mainPath: f.source, summary: "also ready",
    });
    const secondPreview = await f.registry.previewMainMerge({
      taskId: second.taskId, roomId: "demo", mainPath: f.source,
    });
    assert.equal(secondPreview.approvable, true, secondPreview.blockers.join(","));
    const secondApproval = await f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
      mainPath: f.source, completionId: secondPreview.completionId,
      previewDigest: secondPreview.previewDigest,
    });
    const secondToken = (await f.registry.grantMainMerge({
      approvalId: secondApproval.id, roomId: "demo", mainPath: f.source,
      previewDigest: secondApproval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    })).approvalToken;

    const approval = await raise(f);
    const token = await grant(f, approval);
    const beforeHead = await head(f.source);
    const child = await promoteInChildAt(f, approval, token);
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    for (let attempt = 0; attempt < 600 && !await exists(f.marker); attempt += 1) await delay(100);
    assert.equal(await exists(f.marker), true, "the merge driver never ran");
    child.kill("SIGKILL");
    await waitForExit(child);

    const before = new CandidateRegistry(f.data);
    const inFlight = readable((await before.promotions({ roomId: "demo", mainPath: f.source }))[0]);
    const promotionId = inFlight.id;
    const pgid = inFlight.observation.mergePgid as number;
    before.close();
    f.registry.close();
    assert.ok(typeof pgid === "number" && pgid > 1);
    t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } });

    const marker = join(f.data, "promotion-traces", `${promotionId}.spawn-record.json`);
    await writeFile(marker, JSON.stringify({
      pgid, bootAtSec: Math.round(Date.now() / 1_000 - uptime()), at: new Date().toISOString(),
    }), { encoding: "utf8", mode: 0o600 });
    const forged = await deadPid();
    const bootAtSec = Math.round(Date.now() / 1_000 - uptime());
    assert.notEqual(forged, pgid);
    for (const source of subset) {
      await action.apply(source, { path: f.path, data: f.data, promotionId, pgid: forged, bootAtSec });
    }

    // [[PITFALLS]] #106, and the precondition that makes this timepoint the one under test: the
    // merge is alive AND the repository still reads exactly as it did before the promotion started.
    assert.equal(groupAlive(pgid), true, "this test is only evidence while the merge is alive");
    assert.match(await psGroup(pgid), /git[^\n]*merge/u);
    assert.equal(await status(f.source), "", "git had already written the tree; this is the hook timepoint");
    assert.equal(await head(f.source), beforeHead);
    const beforeTree = await treeDigest(f.source);

    const measured = await looseness(f, promotionId);
    assert.equal(measured.destructiveOffer, false,
      `a destructive recovery command was offered while a merge was inside its driver:\n${measured.report}`);
    assert.equal(measured.notWaiting, false,
      `the record stopped waiting for a merge inside its driver:\n${measured.report}`);
    assert.equal(measured.shortPhraseAccepted, false,
      "a phrase that says nothing about main being written released a merge inside its driver");
    assert.equal(measured.markerReleased, false,
      "the project's exclusive marker was handed back over a merge inside its driver");
    assert.ok(!/reset --hard/u.test(measured.report), measured.report);

    const registry = new CandidateRegistry(f.data);
    t.after(() => registry.close());
    await assert.rejects(
      registry.promoteMainMerge({
        approvalId: secondApproval.id, token: secondToken, action: MERGE_APPROVAL_GRANT,
        taskId: second.taskId, roomId: "demo", mainPath: f.source,
      }),
      (error: Error) => error.message === "MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"
        || error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE",
    );
    assert.equal(groupAlive(pgid), true, "nothing here may kill the merge");
    assert.equal(await treeDigest(f.source), beforeTree, "reading the record wrote to the repository");
  });
}
}

/*
 * ---------------------------------------------------------------------------------------------
 * Amendments (V-1), (V-2)/(V-3) and (V-4). Thirteenth round.
 * ---------------------------------------------------------------------------------------------
 *
 * Three findings with one root: the path this file calls "first-hand" was not reading first-hand
 * data. It held the child handle, it had been handed the merge's pgid by the spawn callback, and it
 * then went and asked the promotion row — plus git's trace and the spawn-record marker, both of them
 * files whose paths this product puts into every hook's environment — which group to probe.
 *
 * `firstHandDelete` below is the cell [[PITFALLS]] #107 says nobody measured: all 38 subset tests
 * SIGKILL the orchestrator first, so they measure a crashed READER, and the two round-12 first-hand
 * tests delete nothing. "First-hand × sources deleted" had no test at all, which is why twenty
 * mutations could all be red and none of them could see it.
 */

/** A hook that silences both outside sources from inside the merge, then leaves a process behind. */
function silencingSurvivorHook(started: string, wrote: string, target: string): string {
  return `#!/bin/sh
touch ${JSON.stringify(started)}
D=$(dirname "$GIT_TRACE2_EVENT")
for f in "$D"/*.spawn-record.json; do : > "$f"; done
: > "$GIT_TRACE2_EVENT"
( sleep 4; date +%s > ${JSON.stringify(wrote)}; echo "left behind" >> ${JSON.stringify(target)}; sleep 900 ) </dev/null >/dev/null 2>&1 &
exit 1
`;
}

/** A second approved candidate over the same main, raised before anything is written. */
async function secondApprovedTask(f: Fixture): Promise<{ approval: MergeApproval; token: string; taskId: string }> {
  const second = await f.registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: f.source, task: "second",
  });
  await commit(second.candidatePath, "second.txt", "second work\n", "second work");
  await f.registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, summary: "also ready",
  });
  const preview = await f.registry.previewMainMerge({
    taskId: second.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.approvable, true, preview.blockers.join(","));
  const approval = await f.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  const token = (await f.registry.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: f.source,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  })).approvalToken;
  return { approval, token, taskId: second.taskId };
}

/*
 * AMENDMENT (V-1). The first-hand path, with every persisted source of the number removed.
 *
 * Three steps, each of them inside capabilities this phase has already written down as available:
 *  1. the one write that records the merge's group fails — the ordinary SQLite contention of
 *     [[PITFALLS]] #65, produced here with the product's own fault point exactly as
 *     `promoteWithFailingPgidWrite` does;
 *  2. the hook empties `$GIT_TRACE2_EVENT` and every `*.spawn-record.json` beside it — two paths
 *     this product hands the hook itself;
 *  3. the hook leaves an ordinary background process in the merge's own group. No `setsid`.
 *
 * Measured before the fix: `survivors` was empty because nothing PERSISTED named the group, the
 * record went terminal `rolled-back`, `git reset --hard` was offered, a second promotion over the
 * same main was allowed, and the survivor then appended to a tracked file in main.
 */
test("a first-hand settlement probes the group it was handed, not the one storage still names", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const wrote = join(f.root, "survivor-wrote-at");
  await hook(f, "pre-merge-commit", silencingSurvivorHook(started, wrote, join(f.source, "README.md")));
  const other = await secondApprovedTask(f);

  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  // IN THIS PROCESS, with the pgid write throwing. This is the path (T-1) trusts and (V-1) is about.
  const promoter = new CandidateRegistry(f.data, {
    faultPoint: (point) => {
      if (point === "merge-pgid-record") throw new Error("DATABASE_LOCKED");
    },
  });
  t.after(() => promoter.close());
  const result = await promoter.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(await exists(started), true, "the hook never ran, so nothing was silenced");

  // The preconditions, asserted rather than assumed ([[PITFALLS]] #106/#129): the record's own two
  // sources are empty, both outside sources really were emptied, and something really is alive.
  const traces = join(f.data, "promotion-traces");
  // Not "the file is empty": git holds that descriptor and goes on appending its own exit events
  // after the hook has truncated it. What the hook removed is the ONE event this product parses for
  // an identity, and that is what is asserted.
  const traceText = await readFile(join(traces, `${result.promotion.id}.jsonl`), "utf8");
  assert.ok(!traceText.includes('"event":"start"'),
    "git's trace still carries the event this product reads a pgid out of; nothing was silenced");
  assert.equal(
    (await readFile(join(traces, `${result.promotion.id}.spawn-record.json`), "utf8")).length, 0,
    "the spawn-record marker still has content, so the deletion half did not happen",
  );
  assert.equal(result.promotion.observation.mergeIdentityUnrecorded, undefined,
    "the marker still answered, so the deletion half of this test did not happen");
  const survivorGroup = result.promotion.observation.mergeGroupSurvivors?.pgid;
  assert.ok(typeof survivorGroup === "number" && survivorGroup > 1,
    "no source named the group, and the number this process was handed was not used either");
  t.after(() => { try { process.kill(-survivorGroup, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(groupAlive(survivorGroup), true, "the survivor is already gone; this proves nothing");
  assert.match(await psGroup(survivorGroup), /sleep/u);

  assert.equal(result.promotion.state, "applying",
    "the exclusive marker was handed back over a group only this process could still name");
  assert.equal(result.promotion.observation.mergeConclusion, "MERGE_GROUP_SURVIVORS_STILL_ALIVE");
  // The number this process saw is written into the record, so the wait it leaves behind has
  // something for the owner to quote. Nothing persisted could have supplied it: the write that
  // records it threw, and both outside sources were emptied by the hook above.
  assert.equal(result.promotion.observation.mergePgid, survivorGroup,
    "the record cannot name the group this process was handed, so the wait has no number to quote");
  assert.equal(result.promotion.observation.mergeGroup?.pgid, survivorGroup);
  assert.equal(result.mainMutated, false);
  assert.equal(result.promotion.observation.recovery, undefined,
    `a command was offered over a live survivor: ${result.promotion.observation.recovery}`);
  assert.equal(result.promotion.observation.recoveryKind, undefined);

  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry: promoter, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);
  assert.match(report, new RegExp(`survivors\\s+this record names pgid ${survivorGroup}`, "u"));

  await assert.rejects(
    promoter.promoteMainMerge({
      approvalId: other.approval.id, token: other.token, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );

  // And the survivor does what it was always going to do, which is the whole finding.
  for (let attempt = 0; attempt < 300 && !await exists(wrote); attempt += 1) await delay(100);
  assert.equal(await exists(wrote), true, "the survivor never wrote, so this scenario is not the one");
  assert.equal(await head(f.source), beforeHead, "nothing here may move main's HEAD");
});

/*
 * AMENDMENT (V-2)/(V-3), the direction that TIGHTENS.
 *
 * `mergeGroupState` probes the leader and then `-pgid`, and a process the merge starts can leave
 * that group with one line of `perl -e 'use POSIX; setsid; exec @ARGV'`, which ships with macOS.
 * Measured: the leader closed, the group probed EMPTY, the record went terminal `rolled-back` with
 * `git reset --hard` on offer, a second promotion was allowed, and the escaped process then appended
 * to a tracked file in main.
 *
 * Nothing here enumerates escapes — (V-2) is that the enumeration cannot be finished. What is
 * asserted is the substitute question: this promotion ran a hook, so the leader's exit is not enough,
 * and the record waits by name instead of concluding.
 */
test("a promotion that ran repository code is not settled by its leader's exit alone", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const escaped = join(f.root, "escapee-wrote-at");
  const pidFile = join(f.root, "escapee.pgid");
  // The escape, verbatim from the probe. `setsid` puts it in a session of its own, so no `-pgid`
  // probe this product can make will ever find it.
  await hook(f, "pre-merge-commit", `#!/bin/sh
touch ${JSON.stringify(started)}
perl -e 'use POSIX; setsid; exec @ARGV' -- /bin/sh -c ${JSON.stringify(
    `echo $$ > ${pidFile}; sleep 4; date +%s > ${escaped}; `
    + `echo "escaped" >> ${join(f.source, "README.md")}; sleep 900`,
  )} </dev/null >/dev/null 2>&1 &
exit 1
`);
  const other = await secondApprovedTask(f);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const result = await promote(f, approval, token);
  assert.equal(await exists(started), true, "the hook never ran, so nothing escaped");
  t.after(async () => {
    if (!await exists(pidFile)) return;
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  });

  // The precondition that makes this the (V-2) case rather than the (U) one: main really is
  // bit-for-bit back where it started, and the record's own group really did probe empty. Without
  // this the test would be measuring the survivor gate instead ([[PITFALLS]] #129).
  assert.deepEqual(result.promotion.observation.differences, []);
  assert.equal(result.promotion.observation.mergeGroupSurvivors, undefined,
    "the process stayed in the group, so this test is measuring the (U) gate, not the (V-2) one");
  assert.equal(await head(f.source), beforeHead);

  assert.equal(result.promotion.state, "applying",
    "the leader's exit alone settled a promotion that had just run unsandboxed repository code");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recoveryKind, undefined);
  assert.equal(result.promotion.observation.recovery, undefined,
    `a command was offered for a merge whose survivors cannot be enumerated: ${result.promotion.observation.recovery}`);

  // Named waiting plus a read-only command, which is what (V-3) asks for in place of the offer.
  const listed = readable((await f.registry.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.ok(listed.pending !== undefined, "the record concluded nothing and said nothing about it");
  assert.ok(listed.pending.release !== undefined, "a named wait with no way out (bar item 11)");
  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry: f.registry, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);

  await assert.rejects(
    f.registry.promoteMainMerge({
      approvalId: other.approval.id, token: other.token, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );

  // The escapee does what the group probe could not see coming.
  for (let attempt = 0; attempt < 300 && !await exists(escaped); attempt += 1) await delay(100);
  assert.equal(await exists(escaped), true, "nothing escaped, so this scenario is not the one");
  assert.notEqual(await status(f.source), "",
    "the escapee was expected to have changed main after the leader closed");
  assert.equal(await head(f.source), beforeHead, "nothing here may move main's HEAD");

  // Bar item 11 again, end to end: the owner ends every wait the record names and the project is
  // usable afterwards. Two declarations, because this process is both the orchestrator that is still
  // alive and the one that ran the merge — the stated cost of not settling on the leader's exit.
  const ended = await endEveryWait(f.registry, f.source, f.task.taskId);
  assert.notEqual(ended.state, "applying");
  assert.ok(!/reset --hard/u.test(ended.observation.recovery ?? ""),
    "a declaration licensed a rewrite of a repository whose survivors cannot be enumerated");
});

/*
 * AMENDMENT (V-3), the direction that does NOT tighten — and the reason the rule is worth having.
 *
 * A repository with no hooks and no merge drivers is the ordinary case, and there is nothing in it
 * that could have left a process behind: the only program that ran is `git merge` itself, and this
 * process watched its leader close. So the rollback command is still offered, exactly as before.
 * The failure here is a read-only working TREE — no hook, no driver, nothing out of `.git` runs.
 */
test("a promotion that ran no repository code at all is still settled by its leader's exit", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  // The precondition: nothing in this repository can execute during a merge.
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(preview.hooks.hooks, [], "this fixture has hooks, so it is not the control");
  assert.deepEqual(preview.hooks.drivers, []);
  assert.equal(preview.hooks.unreadable, false);

  await chmod(f.source, 0o500);
  let result: Awaited<ReturnType<typeof promote>> | undefined;
  try {
    result = await promote(f, approval, token);
  } finally {
    await chmod(f.source, 0o755);
  }
  assert.equal(result.promotion.observation.attempt?.exitCode !== 0, true,
    "the merge succeeded, so there is no rollback to be offered");
  assert.equal(result.mainMutated, false);
  assert.equal(result.promotion.state, "rolled-back");
  assert.equal(result.promotion.observation.mergeConclusion, "MERGE_LEADER_EXIT_OBSERVED");
  assert.equal(result.promotion.observation.recoveryKind, "reset-to-pre-promotion");
  assert.equal(result.promotion.observation.recovery,
    `git -C ${result.promotion.mainPath} reset --hard ${beforeHead}`);
  assert.equal(await head(f.source), beforeHead);
  assert.equal(await status(f.source), "");
});

/*
 * AMENDMENT (V-4). The one cell round 12 left open on purpose, and the reason given for leaving it.
 *
 * "Blocking `applied` would make `mainMutated: false` a lie" is a false dilemma: `mainMutated` was
 * `promotion.state === "applied"`, one expression, while the fact it is about —
 * `authorizedMergeCommit === true` — is an independent first-hand reading of main's HEAD. Measured
 * before the fix: the record went terminal `applied` with the survivor's pgid printed in the same
 * payload, a SECOND promotion over the same main was allowed and wrote it, and the survivor then
 * appended to a tracked file.
 */
test("a merge that succeeded and left a live process keeps the project's marker, and still says main moved", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const wrote = join(f.root, "survivor-wrote-at");
  // The round-12 survivor hook with one character changed: `exit 0`, so the merge SUCCEEDS.
  await hook(f, "pre-merge-commit",
    survivorHook(started, wrote, join(f.source, "README.md")).replace("exit 1", "exit 0"));
  const other = await secondApprovedTask(f);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const result = await promote(f, approval, token);
  assert.equal(await exists(started), true, "the hook never ran, so nothing was left behind");
  const survivorGroup = result.promotion.observation.mergeGroupSurvivors?.pgid;
  assert.ok(typeof survivorGroup === "number" && survivorGroup > 1,
    "the record does not name the group its own hook left alive");
  t.after(() => { try { process.kill(-survivorGroup, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(groupAlive(survivorGroup), true, "the survivor is already gone; this proves nothing");

  // The write happened and the record says so — from the observation of main's HEAD, not from the
  // state. Both halves are asserted, because the whole finding is that they are two facts.
  assert.equal(result.mainMutated, true, "the merge landed and the caller was told it did not");
  assert.equal(result.promotion.observation.authorizedMergeCommit, true);
  assert.notEqual(await head(f.source), beforeHead);
  assert.equal(result.promotion.state, "applying",
    "the exclusive marker was handed back while a process the merge left was still alive");
  assert.equal(result.promotion.observation.code,
    "AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_GROUP_SURVIVORS");
  assert.ok(!/reset --hard/u.test(result.promotion.observation.recovery ?? ""));

  // The candidate is still terminally merged: that is about main's HEAD, and it is not the marker.
  await assert.rejects(
    f.registry.previewMainMerge({ taskId: f.task.taskId, roomId: "demo", mainPath: f.source }),
    /MAIN_MERGE_CANDIDATE_ALREADY_MERGED/u,
  );
  // And no other task may write this project while that process is alive.
  await assert.rejects(
    f.registry.promoteMainMerge({
      approvalId: other.approval.id, token: other.token, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );
  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry: f.registry, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);
  assert.match(report, new RegExp(`survivors\\s+this record names pgid ${survivorGroup}`, "u"));

  for (let attempt = 0; attempt < 300 && !await exists(wrote); attempt += 1) await delay(100);
  assert.equal(await exists(wrote), true, "the survivor never wrote, so this scenario is not the one");
});

/*
 * ============================================================================================
 * FOURTEENTH ROUND — amendments (W-1), (W-2), (W-3).
 * ============================================================================================
 *
 * (V-3) replaced "prove nothing survived" with "did this promotion run repository code", and said
 * the product already knew the answer because it enumerates hooks for the approval screen. Both
 * halves of that sentence were wrong in a way nothing here measured:
 *
 *  - the enumeration asked the WRONG QUESTION of git (`--list` + `.find`, which takes the first of
 *    several occurrences and does not expand `~` or `%(prefix)/`), so a repository could run a hook
 *    while the approval screen said no hook would run;
 *  - the enumeration is a SNAPSHOT taken before the merge is spawned, so a hook installed in the
 *    window between them ran while the answer stayed `false` — and `hooksExecuted`, in the same
 *    payload, named it.
 */

/** What git itself says the hook directory is, asked exactly as the merge will resolve it. */
async function gitHooksDirectory(workspace: string): Promise<string> {
  const value = (await execFileAsync("git", ["rev-parse", "--git-path", "hooks"], { cwd: workspace }))
    .stdout.trim();
  // The product canonicalises its workspace before joining a relative answer, so this does too;
  // otherwise a `/var` -> `/private/var` symlink shows up as a disagreement that is not one.
  return value.startsWith("/") ? value : join(await realpath(workspace), value);
}

/**
 * AMENDMENT (W-1). The hook directory is git's answer, not this code's reading of git's config.
 *
 * The three spellings are the ones measured to diverge on git 2.50.1, and the assertion is the same
 * for all three: whatever `git rev-parse --git-path hooks` says under the promotion environment is
 * what the inventory is taken from. The duplicate-key case is the one with teeth — `git config
 * --list` prints both lines and git uses the SECOND, so a `.find()` over the listing reports
 * `/dev/null` for a repository that runs the hook in the other directory.
 */
test("the hook inventory comes from git's own resolution of core.hooksPath, not from the listing", async (t) => {
  const broker = new GitBroker();
  const root = await mkdtemp(join(tmpdir(), "orchestratory-hookspath-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "repo");
  const real = join(root, "real-hooks");
  await mkdir(source);
  await mkdir(real);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await commit(source, "README.md", "main\n", "initial");
  await writeFile(join(real, "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o700 });

  const config = join(source, ".git", "config");
  const rewrite = async (body: string): Promise<void> => {
    const kept = (await readFile(config, "utf8")).split("\n")
      .filter((line) => !/hooksPath/iu.test(line)).join("\n");
    await writeFile(config, `${kept}\n[core]\n${body}\n`, "utf8");
  };

  // 1. The duplicate. git uses the last occurrence; the listing prints both, first one first.
  await rewrite(`\thooksPath = /dev/null\n\thooksPath = ${real}`);
  const duplicate = await broker.hookEnvironment(source);
  assert.equal(duplicate.hooksPath, await gitHooksDirectory(source),
    "the reported hook directory is not the one git resolved");
  assert.equal(duplicate.hooksPath, real, "git resolves the LAST occurrence; this took another one");
  assert.deepEqual(duplicate.hooks.map((entry) => entry.name), ["pre-merge-commit"],
    "the repository runs a hook out of this directory and the inventory does not name it");
  assert.equal(duplicate.unreadable, false);

  // 2. `%(prefix)/`, which git expands and a plain string read does not. Asserted against git's own
  // answer rather than against a path this test computes, which is the whole point of (W-1).
  await rewrite("\thooksPath = %(prefix)/orchestratory-probe-hooks");
  const prefixed = await broker.hookEnvironment(source);
  const gitPrefixed = await gitHooksDirectory(source);
  assert.equal(prefixed.hooksPath, gitPrefixed);
  assert.ok(!gitPrefixed.includes("%(prefix)"), "git did not expand it, so this case proves nothing");
  assert.ok(!gitPrefixed.startsWith(source), "git resolved it inside the workspace; not the case");
  assert.deepEqual(prefixed.hooks, [], "nothing is there, and 'nothing there' is an empty inventory");
  assert.equal(prefixed.unreadable, false);

  // 3. Relative, and unset. Both already worked; they are here so a fix cannot break them silently.
  await rewrite("\thooksPath = relative-hooks");
  assert.equal((await broker.hookEnvironment(source)).hooksPath, await gitHooksDirectory(source));
  const kept = (await readFile(config, "utf8")).split("\n")
    .filter((line) => !/hooksPath/iu.test(line)).join("\n");
  await writeFile(config, kept, "utf8");
  const unset = await broker.hookEnvironment(source);
  assert.equal(unset.hooksPath, await gitHooksDirectory(source));
  assert.equal(unset.hooksPath, join(await realpath(source), ".git", "hooks"));
});

/**
 * AMENDMENT (W-1), end to end: the same repository, promoted.
 *
 * Two `core.hooksPath` lines, a hook in the second directory that leaves a process behind, and the
 * question is whether the promotion still treats itself as having run repository code. Before the
 * fix this record went terminal `rolled-back`, offered `git reset --hard`, and let a second
 * promotion write the same main.
 */
test("a promotion whose hooks path git reads differently is still a promotion that ran repository code", async (t) => {
  const f = await fixture(t);
  const real = join(f.root, "real-hooks");
  await mkdir(real);
  const started = join(f.root, "hook-entered");
  await writeFile(join(real, "pre-merge-commit"),
    `#!/bin/sh\ntouch ${JSON.stringify(started)}\nexit 1\n`, { encoding: "utf8", mode: 0o700 });
  const config = join(f.source, ".git", "config");
  await writeFile(config,
    `${await readFile(config, "utf8")}[core]\n\thooksPath = /dev/null\n\thooksPath = ${real}\n`, "utf8");

  const other = await secondApprovedTask(f);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);
  const result = await promote(f, approval, token);

  assert.equal(await exists(started), true, "git ran no hook, so this scenario is not the one");
  assert.equal(result.promotion.state, "applying",
    "a promotion that ran an unsandboxed hook settled itself on the leader's exit");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined,
    `a destructive command was offered: ${result.promotion.observation.recovery}`);
  assert.equal(result.promotion.observation.recoveryKind, undefined);
  assert.equal(await head(f.source), beforeHead);
  await assert.rejects(
    f.registry.promoteMainMerge({
      approvalId: other.approval.id, token: other.token, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );
});

/**
 * AMENDMENT (W-2). The hook arrives AFTER the inventory was read.
 *
 * No race is run here. The window is produced with the product's own fault point, at
 * `approval-consume-write` — which is inside the window the probe exploits, between
 * `#authorizeMainMerge` reading `restore.hooks` and `mergeIntoHead` spawning git. The real attacker
 * does not need the fault point either: the product `mkdir`s `promotion-traces` in the same window
 * and that is visible to any process with the owner's uid.
 *
 * So the BEFORE half is honestly empty and the AFTER half is not, which is exactly the union
 * (W-2) asks for.
 */
test("a hook installed after the inventory was read still makes the leader's exit insufficient", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const hookPath = join(f.source, ".git", "hooks", "pre-merge-commit");
  const other = await secondApprovedTask(f);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(preview.hooks.hooks, [], "the snapshot already sees a hook; the window is not the subject");
  assert.deepEqual(preview.hooks.drivers, []);

  const promoter = new CandidateRegistry(f.data, {
    faultPoint: (point) => {
      if (point !== "approval-consume-write") return;
      writeFileSync(hookPath, `#!/bin/sh\ntouch ${JSON.stringify(started)}\nexit 1\n`, "utf8");
      chmodSync(hookPath, 0o700);
    },
  });
  t.after(() => promoter.close());
  const result = await promoter.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });

  // Preconditions, asserted rather than assumed ([[PITFALLS]] #106/#129): the hook really ran, and
  // git really reported it, so the AFTER half really is the only half that can see it.
  assert.equal(await exists(started), true, "the late hook never ran, so this measures nothing");
  assert.deepEqual(result.promotion.observation.hooksExecuted?.map((entry) => entry.name),
    ["pre-merge-commit"], "git's trace does not name the hook, so the observed half has no input");

  assert.equal(result.promotion.state, "applying",
    "a promotion whose own record names the hook it ran settled itself on the leader's exit");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined,
    `a destructive command was offered beside a named hook run: ${result.promotion.observation.recovery}`);
  assert.equal(result.promotion.observation.recoveryKind, undefined);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);

  const report = await runCandidatePromotionsCommand({
    args: [], roomId: "demo", mainPath: f.source, registry: promoter, decidedBy: "local-cli",
  });
  assert.ok(!/reset --hard/u.test(report), `the CLI offered a destructive command:\n${report}`);
  await assert.rejects(
    promoter.promoteMainMerge({
      approvalId: other.approval.id, token: other.token, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );
});

/**
 * AMENDMENT (W-2), the other direction ([[PITFALLS]] #107).
 *
 * The union has two halves and neither may be weakened by the other being false. Here the BEFORE
 * half is the only one with anything in it: the repository has an executable hook, and the merge
 * fails before git ever runs one, so git's trace names no repository program at all. The record must
 * still refuse to settle on the leader's exit.
 */
test("a promotion whose hook never got to run is judged by the inventory that named it", async (t) => {
  const f = await fixture(t);
  // `post-merge` runs only after a merge commit exists, and this merge will not get that far.
  await hook(f, "post-merge", "#!/bin/sh\nexit 0\n");
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  await chmod(f.source, 0o500);
  let result: Awaited<ReturnType<typeof promote>>;
  try {
    result = await promote(f, approval, token);
  } finally {
    await chmod(f.source, 0o755);
  }

  // The preconditions that make this the BEFORE-only case.
  assert.notEqual(result.promotion.observation.attempt?.exitCode, 0, "the merge succeeded");
  assert.deepEqual(result.promotion.observation.hooksExecuted ?? [], [],
    "a hook ran after all, so both halves are true and this measures nothing");
  assert.equal(result.promotion.state, "applying",
    "the inventory named an executable hook and the leader's exit settled it anyway");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined);
  assert.equal(await head(f.source), beforeHead);
});

/**
 * AMENDMENTS (V-5)/(W-3). The situation `restore.hooks.unreadable` claimed to cover, covered.
 *
 * That disjunct sat inside `untrustedProgramsRan` and could never fire: `restorePoint()` pushes
 * `MAIN_HOOK_DIRECTORY_UNREADABLE` for the same condition and `#authorizeMainMerge` throws on any
 * blocker. It has been removed, so this asserts the gates that do the work instead, both of them
 * refusals rather than tightenings, and both measured rather than reasoned about:
 *
 *  - unreadable BEFORE the owner looks: the preview is not approvable, by name, and no approval can
 *    be raised over it, so a promotion never exists;
 *  - unreadable AFTER the approval: the inventory is part of the binding, so the promotion is
 *    refused as drift and spends nothing — asserted by promoting successfully afterwards with the
 *    SAME token.
 */
test("a hook directory that cannot be listed refuses the promotion by name, before anything runs", async (t) => {
  const f = await fixture(t);
  const hooks = join(f.source, ".git", "hooks");
  const beforeHead = await head(f.source);

  // Unreadable before anything is approved.
  await chmod(hooks, 0o000);
  let restore: Awaited<ReturnType<GitBroker["restorePoint"]>>;
  let preview: Awaited<ReturnType<CandidateRegistry["previewMainMerge"]>>;
  try {
    restore = await new GitBroker().restorePoint(f.source);
    preview = await f.registry.previewMainMerge({
      taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
    });
    await assert.rejects(
      f.registry.requestMainMerge({
        actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
        mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
      }),
      /MAIN_HOOK_DIRECTORY_UNREADABLE|MAIN_MERGE_NOT_APPROVABLE/u,
      "an approval was raised over an inventory nobody could read",
    );
  } finally {
    await chmod(hooks, 0o755);
  }
  assert.equal(restore.hooks.unreadable, true, "the directory was readable, so this proves nothing");
  assert.deepEqual(restore.hooks.hooks, [], "unreadable must never be reported alongside an inventory");
  assert.ok(restore.blockers.includes("MAIN_HOOK_DIRECTORY_UNREADABLE"), restore.blockers.join(","));
  assert.equal(preview.approvable, false);
  assert.ok(preview.blockers.includes("MAIN_HOOK_DIRECTORY_UNREADABLE"), preview.blockers.join(","));

  // Unreadable only after the owner approved: the same condition, one gate over, still a refusal.
  const approval = await raise(f);
  const token = await grant(f, approval);
  await chmod(hooks, 0o000);
  try {
    await assert.rejects(promote(f, approval, token), /MAIN_MERGE_APPROVAL_BINDING_CHANGED/u,
      "an inventory that stopped being readable was allowed to write main");
  } finally {
    await chmod(hooks, 0o755);
  }
  assert.equal(await head(f.source), beforeHead, "the refused promotion moved main");
  assert.equal(await status(f.source), "");

  // Drift invalidates the approval rather than holding it — that is F25, not this amendment — so
  // what is asserted here is that the task is not wedged by the refusal: a fresh approval over the
  // readable repository still promotes ([[PITFALLS]] #85).
  const raised = await raise(f);
  const again = await promote(f, raised, await grant(f, raised));
  assert.equal(again.mainMutated, true);
});

/**
 * AMENDMENT (W-2), the leg that is NOT a hook.
 *
 * F26 recorded, three rounds ago, that git reports a `merge.<name>.driver` with `child_class: "?"`
 * and therefore that such a child never appears in `hooksExecuted`. That is the same family
 * [[PITFALLS]] #108 is about: pinning one member and forgetting its sibling. So the observed half
 * asks about every child git started that was not git itself, and this is the case that
 * distinguishes the two questions — the attributes are committed and harmless, the DRIVER is
 * configured inside the same window the late hook uses, and no hook runs at any point.
 */
test("a merge driver configured after the inventory was read is observed even though it is not a hook", async (t) => {
  const lines = (change: string): string =>
    Array.from({ length: 30 }, (_, index) => (index === 0 ? change : `line ${index}`)).join("\n") + "\n";
  const f = await fixture(t, {
    initial: { ".gitattributes": "*.conf merge=late\n", "shared.conf": lines("line 0") },
    beforeComplete: async ({ source, candidatePath }) => {
      // Both sides edit the same file, far enough apart that the DEFAULT driver merges them cleanly
      // — the approval has to be reachable, and no driver is configured yet.
      await commit(source, "shared.conf", lines("line 0").replace("line 29", "main edit"), "main edit");
      await commit(candidatePath, "shared.conf", lines("candidate edit"), "candidate edit");
    },
  });
  const ran = join(f.root, "driver-ran");
  const driver = join(f.root, "late-driver.sh");
  await writeFile(driver, `#!/bin/sh\ntouch ${JSON.stringify(ran)}\nexit 1\n`,
    { encoding: "utf8", mode: 0o700 });

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.approvable, true, preview.blockers.join(","));
  assert.deepEqual(preview.hooks.drivers, [], "the snapshot already sees the driver; wrong window");
  assert.deepEqual(preview.hooks.hooks, []);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const promoter = new CandidateRegistry(f.data, {
    faultPoint: (point) => {
      if (point !== "approval-consume-write") return;
      execFileSync("git", ["config", "merge.late.name", "late driver"], { cwd: f.source });
      execFileSync("git", ["config", "merge.late.driver", `${driver} %A %O %B`], { cwd: f.source });
    },
  });
  t.after(() => promoter.close());
  const result = await promoter.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });

  // Preconditions ([[PITFALLS]] #106/#129): the driver ran, and NO hook ran, so the hook-shaped
  // question cannot be the one that answered.
  assert.equal(await exists(ran), true, "the late driver never ran, so this measures nothing");
  assert.deepEqual(result.promotion.observation.hooksExecuted ?? [], [],
    "a hook ran, so this is not the not-a-hook case");

  assert.equal(result.promotion.state, "applying",
    "unsandboxed repository code ran and the leader's exit settled the record anyway");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined,
    `a destructive command was offered: ${result.promotion.observation.recovery}`);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);
  assert.equal(await status(f.source), "");
});

/**
 * AMENDMENT (W-1), the sibling key. `core.attributesFile` was read with a plain `--get` and expanded
 * by hand — the same class of guess as `core.hooksPath`, one function over. It now asks git
 * (`config --get --path`), which expands `~`, `%(prefix)/` and `~user/` the way git does, and the
 * three exits are distinguished instead of collapsed into `.catch(() => "")`.
 *
 * ⚠️ Stated rather than implied: this is NOT measured to change an outcome. `git check-attr` — the
 * primary half of the same gate — refuses on its own when the value cannot be expanded, so the old
 * code reached the same refusal by a different road. What this asserts is the refusal itself, so a
 * later edit that makes either half answer "no filter" to a question it could not ask fails here.
 */
test("an attributes file git itself refuses to expand is a closed gate, not an empty one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-attrsfile-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "repo");
  await mkdir(source);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await commit(source, "README.md", "main\n", "initial");
  const broker = new GitBroker();
  assert.deepEqual((await broker.restorePoint(source)).blockers, [],
    "this repository is already refused, so the assertion below would prove nothing");

  // A spelling git parses and then declines to resolve: `~<user>` needs a passwd entry.
  await execFileAsync("git", ["config", "core.attributesFile", "~orchestratory-no-such-user/attrs"],
    { cwd: source });
  // Measured, and reported as measured rather than as the shape that was expected: git refuses this
  // value so early that `git status` itself exits non-zero, so the refusal arrives as a thrown
  // `GIT_COMMAND_FAILED` from `inspect()` before the attributes gate is ever consulted. That is
  // still fail-closed — what must never happen is a restore point that comes back CLEAN — and it is
  // what this asserts, rather than a blocker name that this path does not reach.
  await assert.rejects(broker.restorePoint(source), /GIT_COMMAND_FAILED/u,
    "a value git refuses to expand produced a usable restore point");
});

/**
 * AMENDMENT (W-2), the [[PITFALLS]] #107 cell this round's first mutation run found empty.
 *
 * `W-V3DRIVER` — dropping `restore.hooks.drivers` from the pre-merge snapshot — came back 9/9 GREEN
 * after the union was added, and the reason is real rather than equivalence: every existing driver
 * test has a driver that RUNS, so git's trace names it and the observed half answers on its own. The
 * cell with no test in it is the mirror of the hook one: a driver the inventory named and the merge
 * never reached.
 *
 * So this is that cell. The driver is configured before the approval, the merge fails on a read-only
 * working tree before any content merge happens, and the record must still refuse to settle on the
 * leader's exit — from the snapshot alone.
 */
test("a promotion whose merge driver never got to run is judged by the inventory that named it", async (t) => {
  let ran = "";
  const f = await fixture(t, {
    initial: { ".gitattributes": "*.conf merge=quiet\n", "shared.conf": "base\n" },
    beforeComplete: async ({ source, candidatePath }) => {
      const root = join(source, "..");
      ran = join(root, "driver-ran");
      const driver = join(root, "quiet-driver.sh");
      // Exits 0 wherever it runs, so the PREVIEW's simulated merge stays approvable; the marker is
      // what says whether it ran at all.
      await writeFile(driver, `#!/bin/sh\ntouch ${JSON.stringify(ran)}\nexit 0\n`,
        { encoding: "utf8", mode: 0o700 });
      await execFileAsync("git", ["config", "merge.quiet.name", "quiet driver"], { cwd: source });
      await execFileAsync("git", ["config", "merge.quiet.driver", `${driver} %A %O %B`], { cwd: source });
      // Only ONE side edits the file the attribute points at, so git never needs a content merge and
      // the driver is configured without being invoked. Read-only-working-tree was tried first and
      // measured NOT to work: git still runs the driver and fails afterwards.
      await commit(candidatePath, "shared.conf", "from candidate\n", "candidate edit");
      void source;
    },
  });

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.approvable, true, preview.blockers.join(","));
  assert.equal(preview.hooks.drivers.length, 1, "the snapshot does not name the driver");
  assert.deepEqual(preview.hooks.hooks, [], "a hook would answer instead of the driver; not the cell");
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  // The preview's own simulation may have run it; only what happens from here matters.
  await rm(ran, { force: true });
  await chmod(f.source, 0o500);
  let result: Awaited<ReturnType<typeof promote>>;
  try {
    result = await promote(f, approval, token);
  } finally {
    await chmod(f.source, 0o755);
  }

  // Preconditions ([[PITFALLS]] #106/#129): the merge failed, and NOTHING out of the repository ran,
  // so only the snapshot can be answering.
  assert.notEqual(result.promotion.observation.attempt?.exitCode, 0, "the merge succeeded");
  assert.equal(await exists(ran), false, "the driver ran after all, so the observed half answers");
  assert.deepEqual(result.promotion.observation.hooksExecuted ?? [], []);

  assert.equal(result.promotion.state, "applying",
    "the inventory named a merge driver and the leader's exit settled the promotion anyway");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);
});

/*
 * ============================================================================================
 * AMENDMENT (X-1)/(X-2)/(X-4) — the fifteenth round.
 *
 * (X-1): a hash on the approval screen describes the moment it was taken, and the merge is what
 * changes what it describes. `core.hooksPath = .githooks` is an ordinary plain-git convention that
 * puts the hook directory inside TRACKED CONTENT, so `git merge --no-ff` writes the candidate's
 * version of the hook and then runs it, as the owner, unsandboxed. Binding could not see it: both
 * the digest and the re-verification before the approval is spent happen before the merge.
 *
 * (X-4): a hook can empty git's own trace before it exits, so "the trace names no repository
 * program" is producible by the program it is supposed to name.
 * ============================================================================================
 */

/** A repository whose hooks live in tracked content, the way `core.hooksPath = .githooks` does. */
async function trackedHookFixture(t: TestContext, options: {
  hooksPath: string;
  /** Where the hook lives inside the working tree, or undefined for "main has no hook file yet". */
  hookFile?: string;
  ownerRan: string;
  /** What the candidate does to the working tree. */
  candidate: (candidatePath: string) => Promise<void>;
}): Promise<Fixture> {
  return await fixture(t, {
    beforeInitialCommit: async (source) => {
      await execFileAsync("git", ["config", "core.hooksPath", options.hooksPath], { cwd: source });
      if (options.hookFile === undefined) return;
      await mkdir(join(source, options.hookFile, ".."), { recursive: true });
      await writeFile(join(source, options.hookFile),
        `#!/bin/sh\ntouch ${JSON.stringify(options.ownerRan)}\nexit 0\n`,
        { encoding: "utf8", mode: 0o755 });
    },
    beforeComplete: async ({ candidatePath }) => await options.candidate(candidatePath),
  });
}

/**
 * AMENDMENT (X-1), the blocker itself, in the shape the reviewer measured (`k1 replace`).
 *
 * Main tracks `.githooks/pre-merge-commit` and names it with `core.hooksPath`. The candidate changes
 * only that file's CONTENT — no `chmod`, no `.git/config` write, no race to win: the executable bit
 * comes from main's own index entry. Before this amendment the approval screen itemised one sha256,
 * git executed another, `attacker code ran as owner` was true and the promotion recorded `applied`.
 */
test("a merge that would write the directory git runs its hooks out of is refused, unspent", async (t) => {
  const attacker = join(await mkdtemp(join(tmpdir(), "orchestratory-x1-")), "attacker-ran");
  const ownerRan = join(await mkdtemp(join(tmpdir(), "orchestratory-x1-")), "owner-hook-ran");
  const f = await trackedHookFixture(t, {
    hooksPath: ".githooks",
    hookFile: ".githooks/pre-merge-commit",
    ownerRan,
    candidate: async (candidatePath) => {
      await writeFile(join(candidatePath, ".githooks", "pre-merge-commit"),
        `#!/bin/sh\ntouch ${JSON.stringify(attacker)}\nexit 0\n`, "utf8");
      await execFileAsync("git", ["add", "--", ".githooks/pre-merge-commit"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "swap the hook"], { cwd: candidatePath });
    },
  });
  const beforeHead = await head(f.source);

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  // Precondition ([[PITFALLS]] #106/#129): git really is resolving hooks into tracked content, and
  // the merge really does write that path. Without both, the refusal below proves nothing.
  assert.equal(preview.hooks.hooksPath, join(await realpath(f.source), ".githooks"));
  assert.deepEqual(preview.hooks.hooks.map((entry) => entry.name), ["pre-merge-commit"]);
  assert.ok(preview.preview.files.some((file) => file.path === ".githooks/pre-merge-commit"),
    "this merge does not write the hook directory, so the scenario is not the one");

  assert.equal(preview.approvable, false, "the owner is still being offered this to sign");
  assert.ok(preview.blockers.includes("MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS"),
    `blockers: ${preview.blockers.join(",")}`);
  await assert.rejects(
    f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
      mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
    }),
    /MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS/u,
  );
  assert.equal(await exists(attacker), false, "the candidate's hook ran as the owner");
  assert.equal(await exists(ownerRan), false, "no merge should have happened at all");
  assert.equal(await head(f.source), beforeHead);
});

/**
 * AMENDMENT (X-1), the same refusal when main has no hook file yet (`k1 create`).
 *
 * The inventory is honestly EMPTY at approval time — there is nothing to hash and nothing to drift —
 * and the merge creates the directory and the file. A gate built on comparing hashes has nothing to
 * compare here, which is exactly why the gate is a question about the operation instead.
 */
test("a merge that would create the hook directory git will run from is refused as well", async (t) => {
  const attacker = join(await mkdtemp(join(tmpdir(), "orchestratory-x1c-")), "attacker-ran");
  const f = await trackedHookFixture(t, {
    hooksPath: ".githooks",
    ownerRan: join(tmpdir(), "unused"),
    candidate: async (candidatePath) => {
      await mkdir(join(candidatePath, ".githooks"), { recursive: true });
      await writeFile(join(candidatePath, ".githooks", "pre-merge-commit"),
        `#!/bin/sh\ntouch ${JSON.stringify(attacker)}\nexit 0\n`, { encoding: "utf8", mode: 0o755 });
      await execFileAsync("git", ["add", "-A"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "ship a hook"], { cwd: candidatePath });
    },
  });
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(preview.hooks.hooks, [], "main already has a hook; the empty-inventory case is the subject");
  assert.equal(preview.hooks.unreadable, false, "an unreadable inventory would refuse for another reason");
  assert.equal(preview.approvable, false);
  assert.ok(preview.blockers.includes("MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS"),
    `blockers: ${preview.blockers.join(",")}`);
  assert.equal(await exists(attacker), false);
});

/**
 * AMENDMENT (X-1), the other direction ([[PITFALLS]] #107).
 *
 * A hook directory inside the working tree is not by itself a refusal — if it were, this gate would
 * be "no repository may use the `.githooks` convention", and the owner's own hook would stop running
 * for every promotion. The merge here writes an unrelated file, so the inventory on the screen is
 * still the inventory that runs, and the promotion succeeds with the OWNER's hook executed.
 */
test("a hook directory inside the working tree that this merge does not write is left alone", async (t) => {
  const ownerRan = join(await mkdtemp(join(tmpdir(), "orchestratory-x1ok-")), "owner-hook-ran");
  const f = await trackedHookFixture(t, {
    hooksPath: ".githooks",
    hookFile: ".githooks/pre-merge-commit",
    ownerRan,
    candidate: async (candidatePath) => {
      // A sibling whose NAME starts with the hook directory's. Containment is segment-wise, so this
      // is outside it; a prefix comparison would read it as inside and refuse an ordinary merge.
      await mkdir(join(candidatePath, ".githooks-notes"), { recursive: true });
      await writeFile(join(candidatePath, ".githooks-notes", "note.md"), "notes\n", "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "notes beside the hooks"], { cwd: candidatePath });
    },
  });
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.hooks.hooksPath, join(await realpath(f.source), ".githooks"),
    "the hook directory is not inside the working tree, so this control proves nothing");
  assert.ok(!preview.preview.files.some((file) => file.path.startsWith(".githooks/")));
  assert.ok(preview.preview.files.some((file) => file.path === ".githooks-notes/note.md"),
    "the same-prefix sibling is not in this merge, so that half of the control is not exercised");
  assert.equal(preview.approvable, true, preview.blockers.join(","));

  const approval = await raise(f);
  const token = await grant(f, approval);
  const result = await promote(f, approval, token);
  assert.equal(result.mainMutated, true, "an ordinary `.githooks` repository can no longer be promoted");
  assert.equal(await exists(ownerRan), true, "the owner's own hook did not run");
});

/**
 * AMENDMENT (X-1): a merge that REMOVES the approved hook changes what runs just as much.
 *
 * Rename sources count for the same reason, and are covered by the same expression.
 */
test("a merge that only deletes a file out of the hook directory is refused too", async (t) => {
  const f = await trackedHookFixture(t, {
    hooksPath: ".githooks",
    hookFile: ".githooks/pre-merge-commit",
    ownerRan: join(tmpdir(), "unused"),
    candidate: async (candidatePath) => {
      await execFileAsync("git", ["rm", "-q", "--", ".githooks/pre-merge-commit"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "drop the hook"], { cwd: candidatePath });
    },
  });
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(
    preview.preview.files.filter((file) => file.path.startsWith(".githooks/")).map((file) => file.operation),
    ["delete"], "the merge does not delete out of the hook directory; not the case");
  assert.equal(preview.approvable, false);
  assert.ok(preview.blockers.includes("MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS"),
    `blockers: ${preview.blockers.join(",")}`);
});

/**
 * AMENDMENT (X-1), the degenerate spelling — the P2 item the reviewer named.
 *
 * `core.hooksPath = ""` makes `git rev-parse --git-path hooks` answer `./`, so the product's own
 * `join(workspace, "./")` turns the WORKING TREE ROOT into the hook directory and every path this
 * merge writes is inside it. Two things measured on git 2.50.1 (Apple Git-155) rather than assumed,
 * because the reviewer's note and this measurement disagree and the disagreement is worth recording:
 * with `core.hooksPath = ""` git answers `./` to `--git-path hooks` but `git hook run
 * pre-merge-commit` says `cannot find a hook named pre-merge-commit` and a real merge runs nothing;
 * with `core.hooksPath = .` git DOES try, and fails with `cannot run pre-merge-commit: No such file
 * or directory`. So this refusal is STRICTER than git's own behaviour here, deliberately: the
 * product's reading of git's answer is the degenerate form of the blocker above, and a configuration
 * whose meaning differs between "where are the hooks" and "which hook will you run" is not one to
 * promote through.
 */
test("core.hooksPath set to the empty string makes the working tree root the hook directory", async (t) => {
  const f = await trackedHookFixture(t, {
    hooksPath: "",
    ownerRan: join(tmpdir(), "unused"),
    candidate: async () => { /* only `candidate.txt`, and that is at the root */ },
  });
  const gitAnswer = (await execFileAsync("git", ["rev-parse", "--git-path", "hooks"], { cwd: f.source }))
    .stdout.trim();
  assert.equal(gitAnswer, "./", "git no longer answers `./` here, so this case has changed shape");
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  // `join(workspace, "./")` keeps the trailing separator, which is why the position is computed with
  // `relative()` rather than by comparing these strings.
  assert.equal(preview.hooks.hooksPath, `${await realpath(f.source)}/`);
  assert.equal(preview.approvable, false);
  assert.ok(preview.blockers.includes("MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS"),
    `blockers: ${preview.blockers.join(",")}`);
});

/*
 * ============================================================================================
 * AMENDMENT (Y-1) — the `realpath` arm of the union, which the previous round WROTE DOWN as
 * untested and then left there.
 *
 * `workingTreePosition()`'s comment said the two spellings "are UNIONED"; the code returned on the
 * first one that landed inside and the field was a single string. A merge writes the REALPATH, so a
 * hook directory reached through a symlink was judged at one spelling and rewritten at the other.
 * Both shapes below were measured end to end on this product before the fix: `approvable: true`,
 * `blockers: []`, `insideWorkingTree` naming the symlink, attacker code executed as the owner,
 * `state: applied`, and the sha256 on the approval screen not the sha256 that ran.
 *
 * There is one test per spelling — that is the rule the amendment states, and the reason it states
 * it is that the arm with no fixture was the arm that was exploitable. The mutation that goes with
 * them is "stop after the first spelling", i.e. the code as it was.
 * ============================================================================================
 */

/**
 * (Y-1), shape A: `core.hooksPath` names a TRACKED SYMLINK pointing into tracked content.
 *
 * `.githooks -> tools/hooks` is an ordinary way to share hooks across worktrees. git answers
 * `--git-path hooks` with `.githooks`, and every write the merge makes is spelled `tools/hooks/…`,
 * so the lexical position and the written position never meet.
 */
test("a hook directory reached through a tracked symlink is judged at both spellings", async (t) => {
  const attacker = join(await mkdtemp(join(tmpdir(), "orchestratory-y1a-")), "attacker-ran");
  const f = await fixture(t, {
    beforeInitialCommit: async (source) => {
      await mkdir(join(source, "tools", "hooks"), { recursive: true });
      await writeFile(join(source, "tools", "hooks", "pre-merge-commit"),
        "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
      await symlink("tools/hooks", join(source, ".githooks"));
      await execFileAsync("git", ["config", "core.hooksPath", ".githooks"], { cwd: source });
    },
    beforeComplete: async ({ candidatePath }) => {
      await writeFile(join(candidatePath, "tools", "hooks", "pre-merge-commit"),
        `#!/bin/sh\ntouch ${JSON.stringify(attacker)}\nexit 0\n`, "utf8");
      await execFileAsync("git", ["add", "--", "tools/hooks/pre-merge-commit"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "swap the hook"], { cwd: candidatePath });
    },
  });
  const beforeHead = await head(f.source);
  const real = await realpath(f.source);

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  // Preconditions ([[PITFALLS]] #106/#129), all four, because without them a refusal below could be
  // coming from something else entirely.
  assert.equal(preview.hooks.hooksPath, join(real, ".githooks"),
    "git no longer resolves the hook directory to the symlink, so this is not the case any more");
  assert.deepEqual(preview.hooks.hooks.map((entry) => entry.name), ["pre-merge-commit"],
    "the hook is not reachable through the link; the scenario is not the one");
  assert.ok(preview.preview.files.some((file) => file.path === "tools/hooks/pre-merge-commit"),
    "this merge does not write the hook through its real path, so nothing is being tested");
  assert.ok(!preview.preview.files.some((file) => file.path.startsWith(".githooks/")),
    "the merge writes the LEXICAL spelling too, so the union is not what is being exercised");
  // The union itself, as a value: one directory, two positions, both kept.
  assert.deepEqual([...preview.hooks.insideWorkingTree ?? []].sort(), [".githooks", "tools/hooks"]);

  assert.equal(preview.approvable, false, "the owner is still being offered this to sign");
  assert.ok(preview.blockers.includes("MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS"),
    `blockers: ${preview.blockers.join(",")}`);
  await assert.rejects(
    f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
      mainPath: f.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
    }),
    /MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS/u,
  );
  assert.equal(await exists(attacker), false, "the candidate's hook ran as the owner");
  assert.equal(await head(f.source), beforeHead);
});

/**
 * (Y-1), shape B: no `core.hooksPath` at all — `.git/hooks` is itself a symlink into the tree.
 *
 * `ln -s ../tools/hooks .git/hooks` is the other common way to share hooks, and it needs no
 * configuration, so nothing on the approval screen looks unusual. git answers `.git/hooks`, which
 * amendment (Y-3) records as being INSIDE the working tree (the reason it is ordinarily harmless is
 * that git refuses to track `.git/*`, not that it is outside) — and the realpath is `tools/hooks`,
 * which the merge writes.
 */
test("a .git/hooks symlink into tracked content is judged at both spellings too", async (t) => {
  const attacker = join(await mkdtemp(join(tmpdir(), "orchestratory-y1b-")), "attacker-ran");
  const f = await fixture(t, {
    beforeInitialCommit: async (source) => {
      await mkdir(join(source, "tools", "hooks"), { recursive: true });
      await writeFile(join(source, "tools", "hooks", "pre-merge-commit"),
        "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
      await rm(join(source, ".git", "hooks"), { recursive: true, force: true });
      await symlink("../tools/hooks", join(source, ".git", "hooks"));
    },
    beforeComplete: async ({ candidatePath }) => {
      await writeFile(join(candidatePath, "tools", "hooks", "pre-merge-commit"),
        `#!/bin/sh\ntouch ${JSON.stringify(attacker)}\nexit 0\n`, "utf8");
      await execFileAsync("git", ["add", "--", "tools/hooks/pre-merge-commit"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "swap the hook"], { cwd: candidatePath });
    },
  });
  const beforeHead = await head(f.source);

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.equal(preview.hooks.hooksPath, join(await realpath(f.source), ".git", "hooks"),
    "git no longer answers `.git/hooks` here, so this case has changed shape");
  assert.deepEqual(preview.hooks.hooks.map((entry) => entry.name), ["pre-merge-commit"]);
  assert.ok(preview.preview.files.some((file) => file.path === "tools/hooks/pre-merge-commit"),
    "this merge does not write the hook through its real path, so nothing is being tested");
  assert.deepEqual([...preview.hooks.insideWorkingTree ?? []].sort(),
    [".git/hooks", "tools/hooks"]);

  assert.equal(preview.approvable, false);
  assert.ok(preview.blockers.includes("MERGE_WOULD_INSTALL_THE_HOOKS_IT_RUNS"),
    `blockers: ${preview.blockers.join(",")}`);
  assert.equal(await exists(attacker), false);
  assert.equal(await head(f.source), beforeHead);
});

/**
 * (Y-1), the other direction ([[PITFALLS]] #107): the union must not refuse an ordinary merge.
 *
 * Same symlinked hook directory, same two positions — and a merge that writes NEITHER of them. If
 * keeping both spellings had turned into "any repository that symlinks its hooks is unpromotable",
 * the two tests above would prove nothing about the gate and everything about a blanket refusal.
 */
test("a symlinked hook directory this merge does not write is still promotable", async (t) => {
  const ownerRan = join(await mkdtemp(join(tmpdir(), "orchestratory-y1ok-")), "owner-hook-ran");
  const f = await fixture(t, {
    beforeInitialCommit: async (source) => {
      await mkdir(join(source, "tools", "hooks"), { recursive: true });
      await writeFile(join(source, "tools", "hooks", "pre-merge-commit"),
        `#!/bin/sh\ntouch ${JSON.stringify(ownerRan)}\nexit 0\n`, { encoding: "utf8", mode: 0o755 });
      await symlink("tools/hooks", join(source, ".githooks"));
      await execFileAsync("git", ["config", "core.hooksPath", ".githooks"], { cwd: source });
    },
    beforeComplete: async ({ candidatePath }) => {
      // A sibling of the REAL position whose name starts with it, so segment-wise containment is
      // exercised on the spelling the union added rather than only on the lexical one.
      await mkdir(join(candidatePath, "tools", "hooks-notes"), { recursive: true });
      await writeFile(join(candidatePath, "tools", "hooks-notes", "note.md"), "notes\n", "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "notes beside the hooks"], { cwd: candidatePath });
    },
  });
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual([...preview.hooks.insideWorkingTree ?? []].sort(), [".githooks", "tools/hooks"],
    "the hook directory is not at two positions, so this control proves nothing");
  assert.ok(preview.preview.files.some((file) => file.path === "tools/hooks-notes/note.md"),
    "the same-prefix sibling is not in this merge, so that half of the control is not exercised");
  assert.equal(preview.approvable, true, preview.blockers.join(","));

  const approval = await raise(f);
  const result = await promote(f, approval, await grant(f, approval));
  assert.equal(result.mainMutated, true, "a repository that symlinks its hooks can no longer promote");
  assert.equal(await exists(ownerRan), true, "the owner's own hook did not run");
});

/**
 * AMENDMENT (X-4). A hook that empties git's own trace before it exits.
 *
 * Both halves of `untrustedProgramsRan` answered `false` about a promotion that had just run
 * attacker code: the BEFORE snapshot because the hook was installed after it was read, and the AFTER
 * observation because the hook emptied the trace it would have been read from. The reviewer's `k3`
 * added one line to that — the hook moves ITSELF out of `.git/hooks`, so even the hook-environment
 * comparison finds nothing changed — and got `rolled-back`, `git … reset --hard`, the project's
 * exclusive marker handed back, a SECOND promotion allowed over the same main, and a `setsid`
 * survivor still appending to a tracked file.
 *
 * The positive fact that closes it: this process spawned git and holds the pid, and git writes its
 * own `version`/`start` events before it does anything else. A trace that afterwards has no
 * top-level `start` was emptied from inside the merge.
 *
 * The window is the product's own fault point rather than a race, exactly as the (W-2) test above.
 */
test("a hook that empties git's own trace cannot leave the record settling on the leader's exit", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, "hook-entered");
  const hookPath = join(f.source, ".git", "hooks", "pre-merge-commit");
  const other = await secondApprovedTask(f);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(preview.hooks.hooks, [], "the BEFORE snapshot already sees a hook; not the cell");
  assert.deepEqual(preview.hooks.drivers, []);

  const promoter = new CandidateRegistry(f.data, {
    faultPoint: (point) => {
      if (point !== "approval-consume-write") return;
      // Empties the trace and then removes itself, so neither the observed programs nor the hook
      // environment can answer afterwards — the `k3` shape exactly.
      writeFileSync(hookPath, [
        "#!/bin/sh",
        `touch ${JSON.stringify(started)}`,
        ': > "$GIT_TRACE2_EVENT"',
        // And then runs a git of its own, which writes a FRESH `version`/`start` pair into the same
        // file. That is what makes the sid-shape half of the check load-bearing: a nested session's
        // opening events must not be able to stand in for the leader's ([[PITFALLS]] #107).
        "git --no-pager log -1 --oneline >/dev/null 2>&1",
        `mv "$0" ${JSON.stringify(join(f.root, "removed-hook"))}`,
        "exit 1",
        "",
      ].join("\n"), "utf8");
      chmodSync(hookPath, 0o700);
    },
  });
  t.after(() => promoter.close());
  const result = await promoter.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });

  // Preconditions ([[PITFALLS]] #106/#129): the hook ran, it really did blind BOTH existing halves,
  // and it really did remove itself. Without all three this test would pass on the old code.
  assert.equal(await exists(started), true, "the hook never ran, so this measures nothing");
  assert.deepEqual(result.promotion.observation.hooksExecuted ?? [], [],
    "git's trace still names the hook, so the AFTER half answers and the new one is not on trial");
  assert.equal(await exists(hookPath), false, "the hook is still on disk, so hookEnvironment drifts instead");
  const trace = await readFile(join(f.data, "promotion-traces", `${result.promotion.id}.jsonl`), "utf8");
  const sessions = trace.split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as { event?: unknown; sid?: unknown }; } catch { return {}; } })
    .filter((event) => event.event === "start")
    .map((event) => (typeof event.sid === "string" ? event.sid : ""));
  assert.equal(sessions.some((sid) => !sid.includes("/")), false,
    "the leader's own `start` survived, so nothing was actually erased");
  assert.equal(sessions.some((sid) => sid.includes("/")), true,
    "no nested session wrote a `start`, so the sid-shape half of the check is not exercised");

  assert.equal(result.promotion.state, "applying",
    "a promotion whose trace was emptied from inside it settled on the leader's exit");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined,
    `a destructive command was offered: ${result.promotion.observation.recovery}`);
  assert.equal(result.promotion.observation.recoveryKind, undefined);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);
  await assert.rejects(
    promoter.promoteMainMerge({
      approvalId: other.approval.id, token: other.token, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );
});

/**
 * AMENDMENT (X-4), the other direction ([[PITFALLS]] #107).
 *
 * An intact trace must not tighten anything. A repository with no hooks and no drivers, promoted
 * normally, has to reach `applied` — otherwise the new disjunct would be "every promotion is
 * unaccounted for", which no mutation could distinguish from a working gate.
 */
test("an intact trace leaves an ordinary promotion able to reach a terminal applied", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const result = await promote(f, approval, token);
  assert.equal(result.promotion.state, "applied");
  assert.equal(result.mainMutated, true);
  assert.equal(result.promotion.observation.mergeConclusion, "MERGE_LEADER_EXIT_OBSERVED");
});

/**
 * SEVENTEENTH ROUND. The third disjunct on its own, which is the thing the sixteenth round argued
 * about instead of measuring.
 *
 * Deleting `|| traceTampered` outright (`TRACEGATE`) left the whole suite green. Half of the round's
 * answer to that was measured and correct — the doctoring fixtures really do reach this leg, and
 * blinding two legs at once really does turn three tests red. The other half was not: "redundant, not
 * a hole" needs the leg to be NECESSARY somewhere, and what the all-green cell actually measured is
 * that it could be deleted and nothing would notice. By amendment (R) that is indistinguishable from
 * a gate with no test at all.
 *
 * Why the corpus could not produce the shape: every doctoring fixture works through a hook, and a
 * hook is a child git started, so git appends a `child_exit` for it once it exits. Emptying the trace
 * leaves that exit an orphan and filtering it in place leaves the same orphan, and an orphan is
 * something the SECOND leg counts. As long as the trace is readable at all, the second leg gets there
 * first — which is exactly what the sixteenth round measured and then over-read.
 *
 * The shape that reaches this leg alone is the one `candidate-registry.ts` already documents and
 * never measured: the trace could not be created. `openSync(trace, "wx+")` fails whenever the data
 * directory is not writable or something already occupies the path, `traceFd` is then null, the
 * first-hand source is `{ fd: -1 }`, and it reads as NOTHING — so a hook that ran leaves no orphan
 * for the second leg to count, because there is no trace to count it in. The comment beside that
 * `openSync` states the intended consequence in as many words: "a failure to create it is not a
 * reason to refuse the merge — it is a reason not to claim anything the trace would have said."
 * Nothing asserted that sentence, and the third disjunct is the only thing implementing it.
 *
 * What is at stake if it is deleted is not bookkeeping. Under `TRACEGATE` this same promotion
 * concludes on the leader's exit, hands the project's exclusive marker back and offers the owner a
 * destructive recovery command — over a merge that ran an attacker's hook which nothing observed.
 * That is the `k3` terminal state again, reached through a different door.
 */
test("a promotion whose first-hand trace could not be created cannot settle on the leader's exit", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);
  const entered = join(f.root, "hook-entered");

  // Precondition ([[PITFALLS]] #106/#129): the BEFORE snapshot must see nothing, or the FIRST leg
  // answers and this measures the wrong disjunct.
  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(preview.hooks.hooks, [], "the pre-merge snapshot already sees a hook; not the cell");
  assert.deepEqual(preview.hooks.drivers, []);
  assert.deepEqual(preview.hooks.filters, []);

  // The directory is taken away BEFORE the promotion, so the product's own exclusive create fails.
  // `mkdir` with `recursive` does not reset the mode of a directory that is already there, so the
  // product's own call to it cannot undo this.
  const traces = join(f.data, "promotion-traces");
  await mkdir(traces, { recursive: true, mode: 0o700 });
  await chmod(traces, 0o500);
  t.after(async () => { try { await chmod(traces, 0o700); } catch { /* already gone */ } });

  // An ordinary hook, installed in the product's own fault-point window. It does not doctor anything
  // and does not need to: there is no trace for it to doctor.
  const hookPath = join(f.source, ".git", "hooks", "pre-merge-commit");
  const promoter = new CandidateRegistry(f.data, {
    faultPoint: (point) => {
      if (point !== "approval-consume-write") return;
      writeFileSync(hookPath, [
        "#!/bin/sh", `touch ${JSON.stringify(entered)}`, "exit 1", "",
      ].join("\n"), "utf8");
      chmodSync(hookPath, 0o700);
    },
  });
  t.after(() => promoter.close());
  const result = await promoter.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });

  // The remaining preconditions. Without all three a green here would be measuring something else.
  assert.equal(await exists(entered), true, "the hook never ran, so this measures nothing");
  assert.equal(await exists(join(traces, `${result.promotion.id}.jsonl`)), false,
    "a trace file exists after all, so `{ fd: -1 }` is not the source under test");
  assert.equal(result.promotion.observation.hooksExecuted, undefined,
    "a trace was read back, so the second leg is answering and not the third");

  // And the sentence itself: a hook ran, nothing observed it, and the record will not conclude.
  assert.equal(result.promotion.state, "applying",
    "a promotion with no first-hand trace settled on the leader's exit anyway");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined,
    `a destructive command was offered: ${result.promotion.observation.recovery}`);
  assert.equal(result.promotion.observation.recoveryKind, undefined);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);
});

/*
 * ============================================================================================
 * AMENDMENT (Y-2) — stop enumerating ways a record can be doctored; anchor on facts this process
 * holds in memory.
 *
 * (X-4) closed "the hook EMPTIED the trace". The next attack did not empty it, forge it or truncate
 * it: it FILTERED it, keeping git's genuine `version`/`start` (flat sid, real pid) and dropping the
 * child events. All three disjuncts answered "nothing ran" about a promotion that had just run
 * attacker code, and the terminal state matched `k3`'s exactly — `rolled-back`, `git … reset --hard`,
 * the exclusive marker handed back, a second promotion allowed and written, a `setsid` survivor
 * still appending to main.
 *
 * The answer is not a fourth pattern. It is that the trace was being read BY PATH — a path handed to
 * every hook the merge runs — and compared only against itself. Two first-hand facts were in this
 * process's memory the whole time and neither was passed in: the descriptor this process opened for
 * that file before git existed, and the pid it spawned.
 * ============================================================================================
 */

/** The three shapes of trace doctoring, as hook bodies, so each has its own named fixture. */
const TRACE_DOCTORING = {
  /** (Y-2) `k5-launder`: keep git's real opening events, drop the children, `mv` the copy back. */
  launder: [
    'T="$GIT_TRACE2_EVENT"',
    `grep -E '"event":"(version|start|def_repo|cmd_name|cmd_mode|cmd_path|cmd_ancestry)"' "$T" > "$T.k" 2>/dev/null`,
    'mv "$T.k" "$T"',
  ].join("\n"),
  /** The same filter applied IN PLACE, so the inode is never replaced and the descriptor sees it. */
  launderInPlace: [
    'T="$GIT_TRACE2_EVENT"',
    `grep -E '"event":"(version|start|def_repo|cmd_name|cmd_mode|cmd_path|cmd_ancestry)"' "$T" > "$T.k" 2>/dev/null`,
    'cat "$T.k" > "$T"',
  ].join("\n"),
  /** (Y-2) `k4-forgedstart`: empty it, then write one flat-sid `start` with an invented pid. */
  forge: [
    'T="$GIT_TRACE2_EVENT"',
    ': > "$T"',
    `printf '%s\\n' '{"event":"start","sid":"20260809T000000.000000Z-Hdeadbeef-P0000f4b7","time":"2026-08-09T00:00:00.000000Z","argv":["git","merge"]}' > "$T"`,
  ].join("\n"),
} as const;

/**
 * Installs one of the doctoring bodies as `pre-merge-commit` at the product's own fault point, and
 * promotes. The window is the fault point rather than a race, exactly as the (W-2)/(X-4) tests.
 */
async function promoteUnderDoctoredTrace(
  t: TestContext, f: Fixture, approval: { id: string }, token: string, body: string,
): Promise<{ result: Awaited<ReturnType<CandidateRegistry["promoteMainMerge"]>>; entered: string }> {
  const entered = join(f.root, `hook-entered-${randomUUID()}`);
  const hookPath = join(f.source, ".git", "hooks", "pre-merge-commit");
  const promoter = new CandidateRegistry(f.data, {
    faultPoint: (point) => {
      if (point !== "approval-consume-write") return;
      writeFileSync(hookPath, [
        "#!/bin/sh", `touch ${JSON.stringify(entered)}`, body,
        `mv "$0" ${JSON.stringify(join(f.root, `removed-hook-${randomUUID()}`))}`,
        "exit 1", "",
      ].join("\n"), "utf8");
      chmodSync(hookPath, 0o700);
    },
  });
  t.after(() => promoter.close());
  const result = await promoter.promoteMainMerge({
    approvalId: approval.id, token, action: MERGE_APPROVAL_GRANT,
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  return { result, entered };
}

/** The `start` session ids in a trace read BY PATH, which is what an attacker gets to shape. */
async function pathTraceSessions(f: Fixture, promotionId: string): Promise<string[]> {
  const text = await readFile(join(f.data, "promotion-traces", `${promotionId}.jsonl`), "utf8");
  return text.split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as { event?: unknown; sid?: unknown }; } catch { return {}; } })
    .filter((event) => event.event === "start")
    .map((event) => (typeof event.sid === "string" ? event.sid : ""));
}

/**
 * (Y-2), the measured attack: a laundered trace, `mv`-ed back over the path.
 *
 * The preconditions are the whole point of this test. Read BY PATH the trace is a clean merge that
 * ran nothing — a genuine leader `start` and no child events at all — so every check the previous
 * round shipped answers "nothing ran". The record must still refuse to conclude.
 */
test("a hook that filters git's trace instead of emptying it cannot settle the record either", async (t) => {
  const f = await fixture(t);
  const other = await secondApprovedTask(f);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  assert.deepEqual(preview.hooks.hooks, [], "the BEFORE snapshot already sees a hook; not the cell");
  assert.deepEqual(preview.hooks.drivers, []);

  const { result, entered } = await promoteUnderDoctoredTrace(
    t, f, approval, token, TRACE_DOCTORING.launder);

  // Preconditions ([[PITFALLS]] #106/#129). Each one is a check that used to answer "nothing ran".
  assert.equal(await exists(entered), true, "the hook never ran, so this measures nothing");
  const path = join(f.data, "promotion-traces", `${result.promotion.id}.jsonl`);
  const sessions = await pathTraceSessions(f, result.promotion.id);
  assert.equal(sessions.some((sid) => !sid.includes("/")), true,
    "the leader's genuine `start` did not survive the filter, so this is the (X-4) case again");
  assert.deepEqual(await readExecutedHooks({ path }), [],
    "the trace AT THE PATH still names a child, so the filter did not do its job");

  assert.equal(result.promotion.state, "applying",
    "a promotion whose trace was laundered from inside it settled on the leader's exit");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined,
    `a destructive command was offered: ${result.promotion.observation.recovery}`);
  assert.equal(result.promotion.observation.recoveryKind, undefined);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);
  // And the disclosure is read through the same descriptor, so it names the hook the path forgot.
  assert.deepEqual(
    (result.promotion.observation.hooksExecuted ?? []).map((hook) => hook.name), ["pre-merge-commit"],
    "the descriptor read did not recover what git actually wrote");
  await assert.rejects(
    f.registry.promoteMainMerge({
      approvalId: other.approval.id, token: other.token, action: MERGE_APPROVAL_GRANT,
      taskId: other.taskId, roomId: "demo", mainPath: f.source,
    }),
    /MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY/u,
  );
});

/**
 * (Y-2), the same filter applied IN PLACE, which the descriptor cannot see through.
 *
 * `cat` into the existing file keeps the inode, so the retained descriptor and the path are the same
 * bytes and the first-hand read recovers nothing. What is left is git's own appended `child_exit`
 * for the hook, written after the hook had finished editing — an exit with no start. The parser used
 * to drop exactly that, which is how "no child ran" was produced about a hook that had just run.
 */
test("an exit with no start is still a child that ran", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const { result, entered } = await promoteUnderDoctoredTrace(
    t, f, approval, token, TRACE_DOCTORING.launderInPlace);

  assert.equal(await exists(entered), true, "the hook never ran, so this measures nothing");
  const path = join(f.data, "promotion-traces", `${result.promotion.id}.jsonl`);
  const text = await readFile(path, "utf8");
  const events = text.split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } });
  assert.equal(events.some((event) => event.event === "child_start"), false,
    "a `child_start` survived in place, so the orphan case is not what is being exercised");
  assert.equal(events.some((event) => event.event === "child_exit"), true,
    "git appended no `child_exit` after the hook, so there is no orphan to notice");
  assert.equal(
    events.some((event) => event.event === "start" && typeof event.sid === "string" && !event.sid.includes("/")),
    true, "the leader's genuine `start` did not survive, so this is the (X-4) case again");

  assert.equal(result.promotion.state, "applying");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);
});

/**
 * (Y-2), the forged flat session id — `k4-forgedstart`.
 *
 * The previous round identified the leader by the SHAPE of the session id, which answers "is this a
 * top-level git" and not "is this the git THIS process started". One synthetic `start` with an
 * invented `P<hex>` put the answer back. The reviewer measured that this particular forgery ALSO
 * poisoned the pgid source and was caught by a different gate; the pid comparison is what catches it
 * for the right reason, so the assertion here is on the conclusion, and the precondition below
 * proves the shape check alone would have passed.
 */
test("a forged top-level session id is not the session this process started", async (t) => {
  const f = await fixture(t);
  const approval = await raise(f);
  const token = await grant(f, approval);
  const beforeHead = await head(f.source);

  const { result, entered } = await promoteUnderDoctoredTrace(
    t, f, approval, token, TRACE_DOCTORING.forge);

  assert.equal(await exists(entered), true, "the hook never ran, so this measures nothing");
  const sessions = await pathTraceSessions(f, result.promotion.id);
  assert.deepEqual(sessions, ["20260809T000000.000000Z-Hdeadbeef-P0000f4b7"],
    "the forged `start` is not the only one at the path, so the shape check was not defeated");
  assert.equal(sessions[0]?.includes("/"), false,
    "the forgery is nested, so the sid-shape check would have refused it without any pid");

  assert.equal(result.promotion.state, "applying");
  assert.equal(result.promotion.observation.mergeConclusion,
    "MERGE_UNTRUSTED_PROGRAMS_RAN_LEADER_EXIT_INSUFFICIENT");
  assert.equal(result.promotion.observation.recovery, undefined);
  assert.equal(result.mainMutated, false);
  assert.equal(await head(f.source), beforeHead);
});

/**
 * AMENDMENT (X-1), the MIRROR the reviewer asked to be measured rather than reasoned about:
 * `merge.<name>.driver = ./tools/m.sh`, where the driver SCRIPT is itself tracked content.
 *
 * Two separate measurements came out of this cell, and they point in opposite directions.
 *
 * **1. The promotion itself is NOT the mirror of BLOCKER-1.** git resolves content merges before it
 * updates the working tree, so the script `git merge --no-ff` executes is MAIN's version;
 * `tools/m.sh` only becomes the candidate's afterwards. Measured with pure git 2.50.1 (Apple
 * Git-155): the marker's LAST line is `MAIN DRIVER`, while `tools/m.sh` on disk after the merge is
 * the candidate's. So `hookDirectoryBlockers` does not need a second door for the promotion, and
 * this test exists so that a future git which reorders those two steps turns that red instead of
 * leaving an unwritten assumption true ([[PITFALLS]] #81, #103).
 *
 * **2. ⛔ But the PREVIEW runs the candidate's script, and that is an open finding, not a fixed one.**
 * `#mergePreview` runs `git merge-tree --write-tree` with cwd in the CANDIDATE worktree, and
 * `merge-tree` honours merge drivers (measured directly: one `merge-tree` invocation, one driver
 * execution). The candidate worktree holds the candidate's `tools/m.sh`, so the marker's EARLIER
 * lines are `CANDIDATE DRIVER RAN AS OWNER`. `THREAT_MODEL.md` F23 already records that preview
 * executes repository-configured drivers and names the remedy (`-c merge.<name>.driver=`); what F23
 * does NOT say, and what is measured here, is that the executed FILE can be candidate content —
 * which the ordinary Workspace MCP write path allows, because it is not `.git` and not the hook
 * directory. Measured separately (`m1-preview-driver.mjs`): the first execution happens inside
 * `complete()`, before any preview is requested and with no owner involvement at all.
 *
 * This test asserts the measured reality of BOTH, so neither can be lost quietly. It is deliberately
 * NOT an assertion that the behaviour is acceptable.
 */
test("a merge driver script this merge rewrites runs as main's during promotion and as the candidate's during preview", async (t) => {
  const marker = join(await mkdtemp(join(tmpdir(), "orchestratory-x1drv-")), "which-driver.txt");
  const f = await fixture(t, {
    beforeInitialCommit: async (source) => {
      await mkdir(join(source, "tools"), { recursive: true });
      await writeFile(join(source, "tools", "m.sh"),
        `#!/bin/sh\necho "MAIN DRIVER" >> ${JSON.stringify(marker)}\nexit 0\n`,
        { encoding: "utf8", mode: 0o755 });
      await writeFile(join(source, ".gitattributes"), "*.conf merge=x\n", "utf8");
      await writeFile(join(source, "shared.conf"), "base\n", "utf8");
      await execFileAsync("git", ["config", "merge.x.name", "x"], { cwd: source });
      await execFileAsync("git", ["config", "merge.x.driver", "./tools/m.sh %O %A %B"], { cwd: source });
    },
    beforeComplete: async ({ candidatePath }) => {
      await writeFile(join(candidatePath, "tools", "m.sh"),
        `#!/bin/sh\necho "CANDIDATE DRIVER" >> ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
      await writeFile(join(candidatePath, "shared.conf"), "candidate side\n", "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: candidatePath });
      await execFileAsync("git", [...author, "commit", "-m", "rewrite the driver"], { cwd: candidatePath });
    },
  });
  // Main edits the same attributed file, so git really has to run a content merge for it.
  await commit(f.source, "shared.conf", "main side\n", "main edits the attributed file");

  const preview = await f.registry.previewMainMerge({
    taskId: f.task.taskId, roomId: "demo", mainPath: f.source,
  });
  // Preconditions ([[PITFALLS]] #106/#129): the driver is configured, and this merge really does
  // rewrite the script it points at.
  assert.equal(preview.hooks.drivers.length, 1, `drivers: ${JSON.stringify(preview.hooks.drivers)}`);
  assert.ok(preview.preview.files.some((file) => file.path === "tools/m.sh"),
    "this merge does not rewrite the driver script, so the mirror is not being tested");
  assert.equal(preview.approvable, true, preview.blockers.join(","));
  // ⛔ Finding 2, asserted as the measured reality: the simulation already ran the CANDIDATE's file.
  assert.ok((await readFile(marker, "utf8")).includes("CANDIDATE DRIVER"),
    "the preview no longer executes the candidate's merge driver — if this is now fixed, delete this "
    + "assertion and the residual-risk row that goes with it");

  const approval = await raise(f);
  const token = await grant(f, approval);
  await promote(f, approval, token);

  // Finding 1: whatever the preview did, the PROMOTION ran main's script, because git merges content
  // before it writes the working tree.
  const lines = (await readFile(marker, "utf8")).trim().split("\n");
  assert.equal(lines.at(-1), "MAIN DRIVER",
    "the promotion ran a driver script this merge supplied — `hookDirectoryBlockers` must be "
    + "extended to the driver's own path");
  assert.equal(await readFile(join(f.source, "tools", "m.sh"), "utf8"),
    `#!/bin/sh\necho "CANDIDATE DRIVER" >> ${JSON.stringify(marker)}\nexit 0\n`,
    "the merge did not install the candidate's script after all, so the ordering is untested");
});
