import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  CandidateRegistry, MERGE_APPROVAL_CONFIRMATION, MERGE_APPROVAL_GRANT,
  type CandidateTask, type MergeApproval, type MergeApprovalBindingCheck,
  type MergeApprovalDriftEvent, type MergeApprovalRefusal, type MergeApprovalSummary,
  type UnreadableMergeApproval,
} from "../src/core/candidate-registry.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";

const execFileAsync = promisify(execFile);
const key = (): string => randomUUID();
const author = ["-c", "user.name=Merge Drift Test", "-c", "user.email=test@example.invalid"];

function readable(entry: MergeApprovalSummary | UnreadableMergeApproval | undefined): MergeApprovalSummary {
  assert.ok(entry, "expected a merge approval summary");
  assert.notEqual(entry.state, "unreadable");
  return entry as MergeApprovalSummary;
}

async function commit(workspace: string, filename: string, contents: string, message: string): Promise<void> {
  await writeFile(join(workspace, filename), contents, "utf8");
  await execFileAsync("git", ["add", "--", filename], { cwd: workspace });
  await execFileAsync("git", [...author, "commit", "-m", message], { cwd: workspace });
}

function candidateRowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    row.task_id, row.candidate_id, row.room_id, row.main_path, row.main_branch,
    row.base_main_head, row.candidate_path, row.candidate_branch, row.task_text,
    row.acceptance_criteria, row.status, row.baseline_json, row.completion_json,
    row.created_at_ms, row.updated_at_ms, row.completed_at_ms,
  ]), "utf8").digest("hex");
}

function tableRows(path: string, table: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path);
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown as Record<string, unknown>[];
  db.close();
  return rows;
}

function storedApproval(path: string, approvalId: string): { state: string; decidedBy: unknown; refusal?: MergeApprovalRefusal } {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT state,decided_by,refusal_json FROM candidate_merge_approvals WHERE id=?")
    .get(approvalId) as { state: string; decided_by: unknown; refusal_json: string | null };
  db.close();
  return {
    state: row.state,
    decidedBy: row.decided_by,
    ...(row.refusal_json === null ? {} : { refusal: JSON.parse(row.refusal_json) as MergeApprovalRefusal }),
  };
}

/** Rewrites the completion's known risks so the recomputed preview digest moves and nothing else does. */
function rewriteCompletionRisks(path: string, taskId: string, risks: string[]): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(taskId) as Record<string, unknown>;
  const completion = JSON.parse(String(row.completion_json)) as { preview: { knownRisks: string[] }; previewDigest: string };
  completion.preview.knownRisks = risks;
  completion.previewDigest = createHash("sha256")
    .update(JSON.stringify(completion.preview), "utf8").digest("hex");
  const completionJson = JSON.stringify(completion);
  row = { ...row, completion_json: completionJson };
  const changes = db.prepare("UPDATE candidates SET completion_json=?,row_hash=? WHERE task_id=?")
    .run(completionJson, candidateRowHash(row), taskId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

function setCandidateStatus(path: string, taskId: string, status: string): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(taskId) as Record<string, unknown>;
  row = { ...row, status };
  const changes = db.prepare("UPDATE candidates SET status=?,row_hash=? WHERE task_id=?")
    .run(status, candidateRowHash(row), taskId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

interface Ready {
  source: string;
  data: string;
  path: string;
  registry: CandidateRegistry;
  task: CandidateTask;
  clock: { now: number };
  drift: MergeApprovalDriftEvent[];
}

/** A completed, clean, recoverable candidate with a registry that records every drift invalidation. */
async function ready(t: TestContext): Promise<Ready> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-merge-drift-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "committed main\n", "utf8");
  await writeFile(join(source, ".gitignore"), "*.cache\n", "utf8");
  await execFileAsync("git", ["add", "README.md", ".gitignore"], { cwd: source });
  await execFileAsync("git", [...author, "commit", "-m", "initial"], { cwd: source });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const clock = { now: Date.UTC(2026, 7, 6, 9, 0, 0) };
  const drift: MergeApprovalDriftEvent[] = [];
  const registry = new CandidateRegistry(data, {
    now: () => clock.now,
    onMergeApprovalInvalidated: (event) => drift.push(event),
  });
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source,
    task: "drift invalidation",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
  await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready for owner review",
    tests: [{ command: "npm test", status: "passed" }],
    knownRisks: ["synthetic"],
  });
  return { source, data, path: registry.path, registry, task, clock, drift };
}

async function raise(fixture: Ready): Promise<MergeApproval> {
  const preview = await fixture.registry.previewMainMerge({
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  });
  assert.equal(preview.approvable, true);
  return await fixture.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: fixture.task.taskId, roomId: "demo",
    mainPath: fixture.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
}

async function grant(fixture: Ready, approval: MergeApproval): Promise<string> {
  const granted = await fixture.registry.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  });
  return granted.approvalToken;
}

/** Everything an invalidation is forbidden to disturb, captured byte for byte. */
async function preserved(fixture: Ready): Promise<Record<string, unknown>> {
  return {
    candidates: tableRows(fixture.path, "candidates"),
    checkpoints: tableRows(fixture.path, "candidate_checkpoints"),
    refs: (await execFileAsync(
      "git", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/"], { cwd: fixture.source },
    )).stdout,
    mainHead: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.source })).stdout,
    mainStatus: (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: fixture.source })).stdout,
    mainTree: (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: fixture.source })).stdout,
    candidateHead: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.task.candidatePath })).stdout,
    candidateStatus: (await execFileAsync(
      "git", ["status", "--porcelain=v1"], { cwd: fixture.task.candidatePath },
    )).stdout,
  };
}

type Surface = "candidate-status" | "merge-approval-list" | "merge-approval-inspect";

/** Reads one approval through the named observation surface, exactly as a caller of it would. */
async function observe(fixture: Ready, approvalId: string, surface: Surface): Promise<{
  state: string;
  refusal?: MergeApprovalRefusal;
  bindingCheck?: MergeApprovalBindingCheck;
}> {
  if (surface === "candidate-status") {
    const tasks = await fixture.registry.status({ roomId: "demo", mainPath: fixture.source });
    const entry = readable(tasks[0]?.mergeApprovals.find((item) => item.id === approvalId));
    return {
      state: entry.state,
      ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
      ...(entry.bindingCheck === undefined ? {} : { bindingCheck: entry.bindingCheck }),
    };
  }
  if (surface === "merge-approval-list") {
    const listed = await fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source });
    const entry = listed.find((item) => item.id === approvalId);
    assert.ok(entry, "expected the approval in the listing");
    return {
      state: entry.state,
      ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
      ...(entry.bindingCheck === undefined ? {} : { bindingCheck: entry.bindingCheck }),
    };
  }
  const inspected = await fixture.registry.inspectMergeApproval({
    approvalId, roomId: "demo", mainPath: fixture.source,
  });
  return {
    state: inspected.approval.state,
    ...(inspected.approval.refusal === undefined ? {} : { refusal: inspected.approval.refusal }),
    bindingCheck: inspected.binding,
  };
}

interface DriftCase {
  name: string;
  /** The bound value whose name the refusal must carry. */
  expect: string;
  apply: (fixture: Ready, approval: MergeApproval) => Promise<void>;
}

const DRIFT_CASES: DriftCase[] = [
  {
    name: "main HEAD moved",
    expect: "mainHead",
    apply: async (fixture) => await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves"),
  },
  {
    name: "main switched branch",
    expect: "mainBranch",
    apply: async (fixture) => {
      await execFileAsync("git", ["checkout", "-b", "release"], { cwd: fixture.source });
    },
  },
  {
    name: "main working tree became dirty",
    expect: "mainDirtyFingerprint",
    apply: async (fixture) => await writeFile(join(fixture.source, "README.md"), "owner edited main\n", "utf8"),
  },
  {
    name: "main gained an ignored path",
    expect: "mainIgnoredFingerprint",
    apply: async (fixture) => await writeFile(join(fixture.source, "owner.cache"), "ignored\n", "utf8"),
  },
  {
    name: "candidate HEAD moved",
    expect: "candidateHead",
    apply: async (fixture) => await commit(fixture.task.candidatePath, "late.txt", "late\n", "late work"),
  },
  {
    name: "candidate working tree became dirty",
    expect: "candidateWorktreeClean",
    apply: async (fixture) => await writeFile(join(fixture.task.candidatePath, "README.md"), "edited\n", "utf8"),
  },
  {
    name: "the recovery ref is gone",
    expect: "recoveryRef",
    apply: async (fixture, approval) => {
      await execFileAsync("git", ["update-ref", "-d", approval.binding.recoveryRef], { cwd: fixture.source });
    },
  },
  {
    name: "the preview digest no longer reproduces",
    expect: "previewDigest",
    apply: async (fixture) => {
      rewriteCompletionRisks(fixture.path, fixture.task.taskId, ["a risk the owner never saw"]);
    },
  },
  {
    name: "the candidate left the completed state",
    expect: "candidateStatus",
    apply: async (fixture) => setCandidateStatus(fixture.path, fixture.task.taskId, "merged"),
  },
];

// Negative first, and one bound value at a time. Bar items 1 and 2: the approval is GRANTED before
// the drift, because the exact gap Phase 5-4 closes is a granted approval that kept reading
// `approved` on every surface after the snapshot it was bound to had already moved.
for (const surface of ["candidate-status", "merge-approval-list", "merge-approval-inspect"] as const) {
  test(`drift invalidates a granted approval when observed through ${surface}, and names what moved`, async (t) => {
    for (const drifted of DRIFT_CASES) {
      await t.test(drifted.name, async (child) => {
        const fixture = await ready(child);
        const approval = await raise(fixture);
        await grant(fixture, approval);
        assert.equal(storedApproval(fixture.path, approval.id).state, "approved");
        await drifted.apply(fixture, approval);

        const observed = await observe(fixture, approval.id, surface);
        assert.equal(observed.state, "invalidated");
        assert.equal(observed.refusal?.code, "MAIN_MERGE_APPROVAL_BINDING_CHANGED");
        assert.ok(observed.refusal?.changed.includes(drifted.expect),
          `expected ${drifted.expect} in ${JSON.stringify(observed.refusal?.changed)}`);
        assert.equal(observed.bindingCheck?.checked, true);
        assert.equal(observed.bindingCheck?.valid, false);
        assert.ok(observed.bindingCheck?.changed.includes(drifted.expect));

        // Bar item 3: durable, not merely reported. The refusal names both the moved values and the
        // surface that noticed, and `decided_by` still records that the owner HAD granted it.
        const stored = storedApproval(fixture.path, approval.id);
        assert.equal(stored.state, "invalidated");
        assert.equal(stored.decidedBy, "local-web");
        assert.ok(stored.refusal?.changed.includes(drifted.expect));
        assert.equal(stored.refusal?.reason, `drift-detected-on:${surface}`);
        assert.deepEqual(fixture.drift.map((event) => event.observedOn), [surface]);
        assert.equal(fixture.drift[0]?.wasGranted, true);
        assert.equal(fixture.drift[0]?.previousState, "approved");

        // And the token is gone, so an invalidated approval carries no usable secret.
        const db = new DatabaseSync(fixture.path);
        const token = db.prepare("SELECT token_hash FROM candidate_merge_approvals WHERE id=?")
          .get(approval.id) as { token_hash: string | null };
        db.close();
        assert.equal(token.token_hash, null);

        // Every other surface agrees, without needing to detect anything itself.
        for (const other of ["candidate-status", "merge-approval-list", "merge-approval-inspect"] as const) {
          if (other === surface) continue;
          const echoed = await observe(fixture, approval.id, other);
          assert.equal(echoed.state, "invalidated");
          assert.ok(echoed.refusal?.changed.includes(drifted.expect));
        }
        // Exactly one invalidation happened, however many surfaces looked at it.
        assert.equal(fixture.drift.length, 1);
      });
    }
  });
}

test("an unanswered request drifts and is invalidated the same way a granted one is", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves");
  const observed = await observe(fixture, approval.id, "candidate-status");
  assert.equal(observed.state, "invalidated");
  assert.deepEqual(observed.refusal?.changed, ["mainHead"]);
  // The record still separates the two: nobody had granted this one.
  assert.equal(storedApproval(fixture.path, approval.id).decidedBy, null);
  assert.equal(fixture.drift[0]?.wasGranted, false);
  assert.equal(fixture.drift[0]?.previousState, "requested");
});

// Bar item 4. The drift is applied first and the world is measured AFTERWARDS, so what is compared
// is exactly what the invalidation itself did — which must be nothing.
test("an invalidation destroys nothing and the owner can be asked again immediately", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  await grant(fixture, approval);
  await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves");
  const before = await preserved(fixture);

  const observed = await observe(fixture, approval.id, "candidate-status");
  assert.equal(observed.state, "invalidated");
  assert.deepEqual(await preserved(fixture), before);

  // The recovery ref still resolves to the exact candidate head the approval named.
  assert.equal(
    (await execFileAsync(
      "git", ["rev-parse", "--verify", `${approval.binding.recoveryRef}^{commit}`], { cwd: fixture.source },
    )).stdout.trim(),
    approval.binding.candidateHead,
  );

  // Asked again, against a freshly computed snapshot, with no waiting for the old approval to lapse.
  const fresh = await raise(fixture);
  assert.equal(fresh.state, "requested");
  assert.notEqual(fresh.id, approval.id);
  assert.notEqual(fresh.binding.previewDigest, approval.binding.previewDigest);
  assert.equal(fresh.binding.mainHead,
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.source })).stdout.trim());
});

test("asking again is itself an observation, so a drifted approval never holds the open slot", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  await grant(fixture, approval);
  await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves");
  // Nothing has observed the approval yet: the very next call is the re-ask, and it must not be
  // refused with ALREADY_PENDING by a decision that has already stopped applying.
  const fresh = await raise(fixture);
  assert.equal(fresh.state, "requested");
  assert.equal(storedApproval(fixture.path, approval.id).state, "invalidated");
  assert.deepEqual(fixture.drift.map((event) => event.observedOn), ["merge-request"]);
});

// Bar item 5. Empirically found in the Phase 5-3 review: four changes that a naive "anything moved"
// check would kill an approval for, and none of them changes what the owner was shown.
test("changes that do not touch a bound value never invalidate", async (t) => {
  const fixture = await ready(t);
  // The ignored file has to exist before the request, so its PATH is inside the bound fingerprint
  // and only its CONTENT moves afterwards.
  await writeFile(join(fixture.source, "editor.cache"), "state before\n", "utf8");
  const approval = await raise(fixture);
  const token = await grant(fixture, approval);

  const stillValid = async (label: string): Promise<void> => {
    for (const surface of ["candidate-status", "merge-approval-list", "merge-approval-inspect"] as const) {
      const observed = await observe(fixture, approval.id, surface);
      assert.equal(observed.state, "approved", `${label} invalidated the approval on ${surface}`);
      assert.deepEqual(observed.bindingCheck, { checked: true, valid: true, changed: [] }, label);
    }
    assert.deepEqual(fixture.drift, [], label);
  };
  await stillValid("baseline");

  // 1. An ignored file's CONTENT changes. The fingerprint covers ignored paths, not their bytes.
  await writeFile(join(fixture.source, "editor.cache"), "state after, quite different\n", "utf8");
  await stillValid("ignored file content");

  // 2. A merge driver is defined with nothing in .gitattributes binding it. It lives in .git/config,
  //    which is not in the working tree, and an unreferenced driver changes no merge result.
  await execFileAsync("git", ["config", "--local", "merge.orchestratory-test.driver", "true %O %A %B"], {
    cwd: fixture.source,
  });
  await execFileAsync("git", ["config", "--local", "merge.orchestratory-test.name", "unreferenced"], {
    cwd: fixture.source,
  });
  await stillValid("unreferenced merge driver");

  // 3. An unrelated branch and tag. Neither is the branch this approval bound, and neither is its
  //    recovery ref.
  await execFileAsync("git", ["branch", "unrelated-work"], { cwd: fixture.source });
  await execFileAsync("git", ["tag", "unrelated-tag"], { cwd: fixture.source });
  await stillValid("unrelated branch and tag");

  // 4. An index refresh after an mtime-only touch. The content is identical, so a fingerprint that
  //    is content-based must not move.
  const touched = new Date(Date.now() + 2_000);
  await utimes(join(fixture.source, "README.md"), touched, touched);
  await execFileAsync("git", ["update-index", "--refresh"], { cwd: fixture.source });
  await stillValid("index refresh");

  // Still the owner's decision after all four, and still usable for the one thing it authorizes —
  // which is the real proof that none of them quietly degraded it.
  const consumed = await fixture.registry.consumeMainMerge({
    approvalId: approval.id,
    token,
    action: MERGE_APPROVAL_GRANT,
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  });
  assert.equal(consumed.binding.previewDigest, approval.binding.previewDigest);
});

test("a binding check that cannot be completed does not invalidate the owner's decision", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  await grant(fixture, approval);
  // The candidate row stops verifying between observations. That is not evidence that anything the
  // owner approved has moved, and burning the decision on it would be the 5-2 "transient failure
  // destroys durable work" pattern all over again.
  const db = new DatabaseSync(fixture.path);
  db.prepare("UPDATE candidates SET row_hash=? WHERE task_id=?").run("0".repeat(64), fixture.task.taskId);
  db.close();

  const listed = await fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source });
  assert.equal(listed[0]?.state, "approved");
  assert.deepEqual(listed[0]?.bindingCheck, {
    checked: false, valid: false, changed: [], unavailable: "CANDIDATE_ROW_TAMPERED",
  });
  assert.equal(storedApproval(fixture.path, approval.id).state, "approved");
  assert.deepEqual(fixture.drift, []);
  // The reported code is a bare error code, never a message that could carry a path.
  assert.match(String(listed[0]?.bindingCheck?.unavailable), /^[A-Z][A-Z0-9_]{2,63}$/u);
});

test("an unreadable approval row is reported as unreadable and never compared against live state", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  await grant(fixture, approval);
  const db = new DatabaseSync(fixture.path);
  db.prepare("UPDATE candidate_merge_approvals SET main_head=? WHERE id=?").run("f".repeat(40), approval.id);
  db.close();
  await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves");

  // `candidate_status` degrades per row rather than failing for the whole Room, but a row that fails
  // its own hash describes nothing live, so it is neither drift-checked nor invalidated on that basis.
  const tasks = await fixture.registry.status({ roomId: "demo", mainPath: fixture.source });
  assert.deepEqual(tasks[0]?.mergeApprovals, [{ id: approval.id, taskId: fixture.task.taskId, state: "unreadable", unreadable: true }]);
  assert.deepEqual(fixture.drift, []);
  assert.equal(storedApproval(fixture.path, approval.id).state, "approved");
  // The listing that the approval dialog is opened from refuses outright instead of showing it.
  await assert.rejects(
    fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source }),
    /MAIN_MERGE_APPROVAL_ROW_TAMPERED/u,
  );
});

test("concurrent observations of the same drift record it exactly once", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  await grant(fixture, approval);
  await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves");

  const [status, listed, inspected] = await Promise.all([
    fixture.registry.status({ roomId: "demo", mainPath: fixture.source }),
    fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source }),
    fixture.registry.inspectMergeApproval({ approvalId: approval.id, roomId: "demo", mainPath: fixture.source }),
  ]);
  // Every observer reports the invalidation, including the ones that lost the compare-and-set.
  assert.equal(readable(status[0]?.mergeApprovals[0]).state, "invalidated");
  assert.equal(listed[0]?.state, "invalidated");
  assert.equal(inspected.approval.state, "invalidated");
  assert.equal(inspected.binding.valid, false);
  // But it happened once, so the audit chain and the room ledger see one event, not three.
  assert.equal(fixture.drift.length, 1);
  assert.deepEqual(fixture.drift[0]?.changed, ["mainHead"]);
});

test("an expired approval is not reported as drifted, and a terminal one is not re-checked", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  await grant(fixture, approval);
  await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves");
  fixture.clock.now += 6 * 60_000;
  const lapsed = await observe(fixture, approval.id, "candidate-status");
  assert.equal(lapsed.state, "approved");
  // Absent rather than `valid: false`: nothing was compared, and a field that is only present when
  // a comparison ran cannot be misread as "checked and fine" — the expiry is reported on its own terms.
  assert.equal(lapsed.bindingCheck, undefined);
  assert.deepEqual(fixture.drift, []);

  // Rejected is terminal, and terminal rows are never compared against live state again.
  const other = await ready(t);
  const rejected = await raise(other);
  await other.registry.rejectMainMerge({
    approvalId: rejected.id, roomId: "demo", mainPath: other.source, decidedBy: "local-web",
  });
  await commit(other.source, "main-side.txt", "main moved on\n", "main moves");
  const observed = await observe(other, rejected.id, "merge-approval-list");
  assert.equal(observed.state, "rejected");
  assert.deepEqual(observed.bindingCheck, undefined);
  assert.deepEqual(other.drift, []);
});

// Bar item 3, at the layer that actually has an audit chain and a public room ledger.
test("a drift invalidation is written to the audit chain and the room ledger, and a never-granted approval is not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-merge-drift-service-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "committed main\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", [...author, "commit", "-m", "initial"], { cwd: source });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const service = new CollaborationService(data);
  t.after(() => service.close());
  service.ledger.createRoom("demo", source);

  const withApproval = await service.candidates.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "audited drift",
  });
  await commit(withApproval.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  await service.candidates.complete({
    actor: "codex1", clientRequestId: key(), taskId: withApproval.taskId, roomId: "demo",
    mainPath: source, summary: "ready",
  });
  // A second candidate that is never asked about at all: the "no approval ever happened" control.
  const neverAsked = await service.candidates.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source, task: "never asked",
  });
  await commit(neverAsked.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  await service.candidates.complete({
    actor: "codex1", clientRequestId: key(), taskId: neverAsked.taskId, roomId: "demo",
    mainPath: source, summary: "ready",
  });

  const preview = await service.candidates.previewMainMerge({
    taskId: withApproval.taskId, roomId: "demo", mainPath: source,
  });
  const approval = await service.candidates.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: withApproval.taskId, roomId: "demo",
    mainPath: source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  await service.grantMainMerge({
    roomId: "demo", workspace: source, approvalId: approval.id,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  });
  await commit(source, "main-side.txt", "main moved on\n", "main moves");

  const before = service.audit.list({ roomId: "demo" }).length;
  const listed = await service.listMergeApprovals({ roomId: "demo", workspace: source });
  assert.equal(listed.find((entry) => entry.id === approval.id)?.state, "invalidated");

  const invalidations = service.audit.list({ roomId: "demo" })
    .filter((event) => event.type === "candidate.merge-approval-invalidated");
  assert.equal(invalidations.length, 1);
  const detail = invalidations[0]?.detail as Record<string, unknown>;
  assert.equal(invalidations[0]?.outcome, "denied");
  assert.equal(invalidations[0]?.taskId, withApproval.taskId);
  assert.equal(detail.reason, "MAIN_MERGE_APPROVAL_BINDING_CHANGED");
  assert.deepEqual(detail.changed, ["mainHead"]);
  assert.equal(detail.observedOn, "merge-approval-list");
  assert.equal(detail.ownerHadGranted, true);
  assert.equal(detail.previousState, "approved");
  assert.equal(detail.mainMutation, false);
  assert.equal(detail.recoveryRefRetained, true);
  assert.equal(service.audit.verify(), true);
  assert.ok(service.audit.list({ roomId: "demo" }).length > before);

  // The room ledger is public, so it names the moved field and nothing else — no path, no id, no token.
  const line = service.ledger.getByIdempotencyKey(`candidate:merge-approval:${approval.id}:invalidated`);
  assert.ok(line, "expected a room ledger line for the invalidation");
  assert.match(line.text, /mainHead/u);
  assert.equal(line.text.includes(source), false);
  assert.equal(line.text.includes(approval.id), false);
  assert.equal(service.ledger.verifyChain("demo"), true);

  // The control: the candidate nobody ever asked about has no approval and no such record, so a
  // drift invalidation can never be mistaken for an approval that was never granted.
  const untouched = await service.candidates.status({ roomId: "demo", mainPath: source, taskId: neverAsked.taskId });
  assert.deepEqual(untouched[0]?.mergeApprovals, []);
  assert.equal(
    service.audit.list({ roomId: "demo" })
      .filter((event) => event.type === "candidate.merge-approval-invalidated"
        && event.taskId === neverAsked.taskId).length,
    0,
  );

  // Observing again does not append a second record; the invalidation happened once.
  await service.listMergeApprovals({ roomId: "demo", workspace: source });
  await service.candidates.status({ roomId: "demo", mainPath: source });
  assert.equal(
    service.audit.list({ roomId: "demo" })
      .filter((event) => event.type === "candidate.merge-approval-invalidated").length,
    1,
  );
});
