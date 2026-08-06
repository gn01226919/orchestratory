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
  MERGE_LIVE_ABANDON_CONFIRMATION,
  MERGE_OWNER_ABANDON_CONFIRMATION,
  MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS,
  MERGE_PROMOTION_ABANDON_CONFIRMATION,
  MERGE_UNREADABLE_ABANDON_CONFIRMATION,
  MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION,
  type CandidateTask,
  type MergeApproval,
  type MergePromotion,
  type UnreadableMergePromotion,
} from "../src/core/candidate-registry.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";
import { GitBroker, readExecutedHooks } from "../src/core/git-broker.ts";
import { runCandidatePromotionsCommand } from "../src/main.ts";

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
  // A live leader is offered the longer phrase; the short one belongs to a group nobody can decide
  // about, and handing it out here is what let a provably live merge be disowned.
  assert.equal(inFlight.pending?.release, MERGE_LIVE_ABANDON_CONFIRMATION);

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
  const row = db.prepare(
    "SELECT * FROM candidate_merge_promotions WHERE state='applying' LIMIT 1",
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

  assert.equal(await readExecutedHooks(join(root, "does-not-exist.jsonl")), null,
    "a trace that does not exist must not read as 'no hooks ran'");
  await mkdir(join(root, "a-directory.jsonl"));
  assert.equal(await readExecutedHooks(join(root, "a-directory.jsonl")), null);

  // Read, and genuinely empty of hooks: git wrote a trace, no `child_class:"hook"` event is in it.
  const empty = join(root, "empty.jsonl");
  await writeFile(empty, `${JSON.stringify({ event: "version", sid: "s" })}\n`, "utf8");
  assert.deepEqual(await readExecutedHooks(empty), []);

  // And one that did record a hook, so the empty answer above is not simply what this always says.
  const one = join(root, "one.jsonl");
  await writeFile(one, [
    JSON.stringify({ event: "child_start", sid: "s", child_id: 0, child_class: "hook", hook_name: "pre-merge-commit", argv: ["/x/pre-merge-commit"] }),
    JSON.stringify({ event: "child_exit", sid: "s", child_id: 0, code: 3 }),
    "",
  ].join("\n"), "utf8");
  assert.deepEqual(await readExecutedHooks(one),
    [{ name: "pre-merge-commit", path: "/x/pre-merge-commit", exitCode: 3 }]);
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
  assert.equal(released.pending, undefined);
  assert.notEqual(released.state, "applying");
  // The declaration survives re-reading: it is a decision, not a probe result.
  const again = readable((await reopened.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(again.observation.ownerProcessDisowned?.pid, process.pid);
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
  for (const drop of ["configDigest", "programs"] as const) {
    const f = await fixture(t);
    const approval = await raise(f);
    f.registry.close();
    // v5 throughout: the promotions table stays, the schema version stays, and `promotion` itself
    // stays. Only the two fields this round added are absent, exactly as the previous commit wrote.
    rewindPreview(f.path, f.task.taskId, (preview) => {
      const hooks = (preview.promotion as { hooks: Record<string, unknown> }).hooks;
      delete hooks[drop];
    });
    assert.equal(schemaVersion(f.path), 5, "the fixture stopped being a v5 database");

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

  const payloads = [
    // Not JSON at all.
    "this used to be JSON",
    // Valid JSON, group removed. Indistinguishable from a promotion that never spawned git, if the
    // observation is the only place you look.
    JSON.stringify({ code: "PROMOTION_STARTED", mainHead: null, observedAt: "1970-01-01T00:00:00.000Z" }),
  ];
  let promotionId = "";
  for (const payload of payloads) {
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
    assert.equal(listed.release?.probeReadable, true);
    assert.equal(listed.release?.confirmation, MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION);
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
   * Now take the columns away too, which is the case the fix cannot probe: nothing left can name the
   * merge. The requirement is that this is reported as an UNANSWERED question rather than as good
   * news — the phrase stays the long one even though `alive` is empty, and `probeReadable` is what
   * tells the two apart (finding F-5: `aliveAtRelease: []` was written while `ps` proved three
   * processes alive, and `unverifiedSource` beside it does not cover that).
   */
  damagePromotionRow(f.path, {
    observationJson: "this used to be JSON", mergePgid: null, mergeBootAtSec: null,
  });
  const blind = new CandidateRegistry(f.data);
  t.after(() => blind.close());
  const unseen = unreadable((await blind.promotions({ roomId: "demo", mainPath: f.source }))[0]);
  assert.equal(groupAlive(pgid), true, "this assertion is only evidence while the merge is alive");
  assert.deepEqual(unseen.release?.alive, []);
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
   * The third shape, and the one a mutation caught as uncovered ([[PITFALLS]] #107, third case:
   * neither an unmet precondition nor an equivalent mutation, just a branch with no test). Here the
   * columns hold nothing AND the payload parses and states, affirmatively, that no group is
   * recorded — which is what a row written before those columns existed looks like once its merge
   * has been settled, and what any row looks like before git is spawned. That is an ANSWER, so the
   * short phrase is the one that works. Making it demand the long phrase instead would be safe in
   * the trivial sense and would take the short phrase out of service permanently, which is the
   * shape bar item 11 forbids.
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
  assert.equal(answered.release?.probeReadable, true,
    "an observation that says `no group` is an answer, not an unanswered question");
  assert.equal(answered.release?.confirmation, MERGE_UNREADABLE_ABANDON_CONFIRMATION);
  await assert.rejects(
    groupless.abandonMergeProcessGroup({ ...args, confirmation: MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION }),
    (error: Error & { confirmation?: string }) =>
      error.message === "MAIN_MERGE_PROMOTION_ROW_UNREADABLE"
      && error.confirmation === MERGE_UNREADABLE_ABANDON_CONFIRMATION,
  );
  const released = unreadable(await groupless.abandonMergeProcessGroup({
    ...args, confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION,
  }));
  assert.equal(released.holdsProjectExclusiveMarker, false);
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
  // The merge group is out of the way, so the only thing left to decide is the owner process.
  rewritePromotionRow(f.path, ({ observation }) => ({
    ownerPid: beyondPid,
    observation: { ...observation, mergePgid: null, mergeGroup: null },
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
  assert.equal(released.pending, undefined);
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
    override async restorePoint(workspace: string): ReturnType<GitBroker["restorePoint"]> {
      this.calls += 1;
      if (this.calls === this.failOn) throw new Error("GIT_COMMAND_FAILED");
      return await super.restorePoint(workspace);
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
  assert.notEqual(after.state, before.state, "the listing did not converge the record");
  assert.notEqual(after.row_hash, before.row_hash, "the listing did not write");
  assert.deepEqual(events, ["re-observed"]);

  // A second listing of a record that has not changed writes no further ledger entry, so "it
  // updates" does not become "it appends on every read".
  await reader.promotions({ roomId: "demo", mainPath: f.source });
  assert.deepEqual(events, ["re-observed"]);
});
