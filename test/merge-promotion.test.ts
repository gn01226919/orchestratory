import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

function readable(entry: Awaited<ReturnType<CandidateRegistry["promotions"]>>[number] | undefined): {
  state: string;
  mainHeadAfter?: string;
  mainPath: string;
  observation: {
    code: string;
    recovery?: string;
    recoveryKind?: string;
    differences?: string[];
    mergePgid?: number | null;
  };
} {
  assert.ok(entry && !("unreadable" in entry), "the promotion row could not be read");
  return entry as never;
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
