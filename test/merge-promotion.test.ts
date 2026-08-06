import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
  MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS,
  type CandidateTask,
  type MergeApproval,
  type MergePromotion,
} from "../src/core/candidate-registry.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";
import { GitBroker } from "../src/core/git-broker.ts";

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

/** Whether a whole process group still exists, asked the same way the product asks. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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

function readable(entry: Awaited<ReturnType<CandidateRegistry["promotions"]>>[number] | undefined): MergePromotion {
  assert.ok(entry && !("unreadable" in entry), "the promotion row could not be read");
  return entry as MergePromotion;
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
  assert.equal(promotion.observation.recoveryKind, "reset-to-pre-promotion");
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
  assert.equal(timedOut.promotion.state, "needs-manual-review");
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
  const db = new DatabaseSync(path);
  const candidate = db.prepare("SELECT * FROM candidates WHERE task_id=?")
    .get(taskId) as unknown as Record<string, unknown>;
  const completion = JSON.parse(String(candidate.completion_json)) as {
    preview: Record<string, unknown>; previewDigest: string;
  };
  delete completion.preview.promotion;
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
  delete preview.promotion;
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

  db.exec("DROP TABLE candidate_merge_promotions; PRAGMA user_version=4;");
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
  assert.equal(schemaVersion(f.path), 5);
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
  assert.equal(observed.pending, undefined);
  // The survivors are reported by name rather than silently ignored, with a read-only command.
  assert.equal(observed.observation.mergeGroupSurvivors?.pgid, pgid);
  assert.match(observed.observation.mergeGroupSurvivors?.inspect ?? "", new RegExp(`ps .*-g ${pgid}$`, "u"));

  // The owner clears what the record named; the product does none of it.
  for (const name of ["MERGE_HEAD", "AUTO_MERGE", "MERGE_MSG"]) {
    await rm(join(f.source, ".git", name), { force: true });
  }
  const settled = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(settled.state, "applied", `still ${settled.state}: ${settled.observation.code}`);
  assert.equal(reopened.get(f.task.taskId)?.status, "merged");
  // And the group really was still alive throughout, so this is not a race that resolved itself.
  assert.equal(groupAlive(pgid), true);
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
  assert.equal(inFlight.pending?.release, MERGE_GROUP_ABANDON_CONFIRMATION);

  process.kill(-pgid, "SIGKILL");
  await waitForGroupExit(pgid);

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

  // Rewrite ONLY the recorded boot instant, to a value from a previous boot, and re-hash the row
  // exactly as the store does. Everything else — including the live, still-running merge — is
  // untouched, so any change in the answer can only come from the identity check.
  rewritePromotionRow(f.path, ({ observation }) => ({
    observation: {
      ...observation,
      mergeGroup: { ...(observation.mergeGroup as Record<string, unknown>), bootAtSec: 1_000 },
    },
  }));

  const afterReboot = new CandidateRegistry(f.data);
  t.after(() => afterReboot.close());
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
  const observationJson = JSON.stringify(result.observation ?? observation);
  const rowHash = createHash("sha256").update(JSON.stringify([
    row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
    row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
    row.restore_json, observationJson, row.state, ownerPid, row.started_at_ms,
    row.updated_at_ms,
  ]), "utf8").digest("hex");
  assert.equal(
    Number(db.prepare(
      "UPDATE candidate_merge_promotions SET owner_pid=?,observation_json=?,row_hash=? WHERE id=?",
    ).run(ownerPid, observationJson, rowHash, String(row.id)).changes),
    1,
  );
  db.close();
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
    confirmation: MERGE_GROUP_ABANDON_CONFIRMATION, decidedBy: "local-web",
  };
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
  const released = await reopened.abandonMergeProcessGroup(args);
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
  assert.equal(failureEvents[0]?.outcome, "failed");
  assert.equal(failure.state, "rolled-back");
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

test("a kill inside the approval-consuming write settles as never spent, and the task stays usable", async (t) => {
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
  const settled = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  // An intent row beside an approval that is still `approved` says unambiguously that no Git command
  // ran: the merge cannot start until the approval is spent.
  assert.equal(settled.state, "rolled-back");
  assert.equal(settled.observation.code, "APPROVAL_NEVER_SPENT_NO_GIT_COMMAND_RAN");
  assert.equal(await head(f.source), before.head);
  assert.equal(await treeDigest(f.source), before.tree);

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
  override async restorePoint(workspace: string): ReturnType<GitBroker["restorePoint"]> {
    this.restorePoints += 1;
    return await super.restorePoint(workspace);
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
  const settled = await settledPromotion(reopened, f.source, 50);
  assert.notEqual(settled.state, "applying",
    "a pid belonging to another user was treated as proof our merge was still writing");
  assert.equal(settled.state, "needs-manual-review");
  assert.equal(settled.pending, undefined);
  assert.equal(settled.observation.mergePgid, null);
  assert.ok((settled.observation.differences ?? []).length > 0, "no differences were named");
  // And the foreign process is still exactly where it was: nothing here signals anything.
  assert.throws(() => process.kill(other, 0), (error: NodeJS.ErrnoException) => error.code === "EPERM");
});

/*
 * FINDING 1 (h). The fourth answer `probe()` can give — neither "it is there", nor "it is gone",
 * nor "it is somebody else's" — is the one that must NOT settle: concluding over a group nobody
 * could decide about is publishing a verdict on a repository that may still be being written.
 *
 * On POSIX, `kill(pid, 0)` with a validated positive integer returns only `ESRCH` or `EPERM`, so
 * this branch is unreachable through the public surface. What this test does, therefore, is replace
 * the global `process.kill` for ONE pid — the same function the module calls — so the branch really
 * executes. It proves the classification and the release path, and it does NOT prove anything about
 * a real operating system producing that error; that limit is the reason it is written down here.
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
