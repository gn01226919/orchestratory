import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CandidateRegistry,
  MERGE_APPROVAL_CONFIRMATION,
  MERGE_APPROVAL_GRANT,
  type CandidateTask,
  type MergeApproval,
} from "../src/core/candidate-registry.ts";

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
      assert.equal(result.mainMutated, false);
      assert.equal(result.promotion.state, "rolled-back");
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
    {
      label: "sparse checkout",
      code: "MAIN_SPARSE_CHECKOUT_ENABLED",
      apply: async (f: Fixture) => {
        await execFileAsync("git", ["config", "core.sparseCheckout", "true"], { cwd: f.source });
      },
    },
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
    {
      label: "submodules",
      code: "MAIN_HAS_SUBMODULES",
      apply: async (f: Fixture) => await writeFile(join(f.source, ".gitmodules"), "[submodule \"x\"]\n", "utf8"),
    },
    {
      label: "an LFS or other content filter",
      code: "MAIN_HAS_CONTENT_FILTERS",
      apply: async (f: Fixture) => {
        await execFileAsync("git", ["config", "filter.lfs.clean", "git-lfs clean -- %f"], { cwd: f.source });
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
  assert.equal(result.promotion.state, "rolled-back");
  assert.deepEqual(result.promotion.observation.differences, []);
  assert.equal(await head(f.source), before.head);
  assert.equal(await status(f.source), before.status);
  assert.equal(await readFile(join(f.source, "shared.conf"), "utf8"), "from main\n");

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
  for (const attempt of [
    f.registry.previewMainMerge({ taskId: f.task.taskId, roomId: "demo", mainPath: f.source }),
    f.registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: f.task.taskId, roomId: "demo",
      mainPath: f.source, completionId: approval.binding.completionId,
      previewDigest: approval.binding.previewDigest,
    }),
  ]) {
    await assert.rejects(attempt, /MAIN_MERGE_CANDIDATE_ALREADY_MERGED/u);
  }
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

  const module = fileURLToPath(new URL("../src/core/candidate-registry.ts", import.meta.url));
  const script = join(f.root, "promote-child.mjs");
  await writeFile(script, [
    "const [data, source, approvalId, token, taskId] = process.argv.slice(2);",
    `const { CandidateRegistry } = await import(${JSON.stringify(module)});`,
    "const registry = new CandidateRegistry(data);",
    "process.stdout.write('ready\\n');",
    "await registry.promoteMainMerge({",
    "  approvalId, token, action: 'merge-candidate-into-main', taskId, roomId: 'demo', mainPath: source,",
    "});",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });

  const child = spawn(process.execPath, [script, f.data, f.source, approval.id, token, f.task.taskId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  // Wait for the merge to actually be in progress, observed rather than timed.
  for (let attempt = 0; attempt < 300 && !await exists(started); attempt += 1) await delay(100);
  assert.equal(await exists(started), true, "the hook never ran, so nothing was interrupted");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  // A NEW process, opening the same durable state, with no memory of the attempt.
  const reopened = new CandidateRegistry(f.data);
  t.after(() => reopened.close());
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
  // A copy-and-paste recovery command, built only from what was recorded before the attempt.
  // Built only from what was recorded before the attempt, and against the canonical path the
  // registry bound (macOS reports /var and /private/var for the same directory).
  assert.equal(promotion.observation.recovery, `git -C ${promotion.mainPath} reset --hard ${beforeHead}`);
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
