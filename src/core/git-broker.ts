import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import { open, readdir, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { canonicalWorkspace, resolveExistingInside } from "../security/workspace.ts";
import {
  minimalGitEnvironment,
  promotionGitEnvironment,
  resolveExecutable,
  runProcess,
} from "./process-runner.ts";

/**
 * Every executable that a merge in this repository can cause to run, with content hashes.
 *
 * A promotion is the first operation in this product that executes code out of `.git`, and it does
 * so as the owner, unsandboxed. That is a trust boundary, so it is measured rather than assumed:
 * the hook directory can be moved by `core.hooksPath`, and a linked candidate worktree shares the
 * common `.git`, which means an agent with a terminal could write both the config and the hook after
 * the owner looked at the preview. Binding this fingerprint into the approval is what makes that
 * substitution a drift refusal instead of an execution.
 */
export interface HookEnvironment {
  /**
   * The hook directory GIT resolved for this repository, asked of git rather than derived here.
   *
   * Amendment (W-1). This used to be `git config --list` filtered with
   * `.find(entry => entry.key === "core.hookspath")`, and every part of that was a guess at another
   * program's semantics: `--list` prints EVERY occurrence while git's effective value is the LAST
   * one, and git expands `~` and `%(prefix)/` in a path-typed value while a plain string read does
   * not. Measured on git 2.50.1 — a repository whose config names `core.hooksPath` twice ran the
   * hook in the second directory while this field reported the first, so the approval screen said
   * "this promotion will run no repository hook" about a promotion that ran one.
   *
   * `git rev-parse --git-path hooks`, asked under the promotion environment, is git answering the
   * same question git will answer during the merge: last occurrence wins, `~` and `%(prefix)/` are
   * expanded, worktree-scoped config and `include.path` are honoured — all four measured. Empty
   * only when git could not be asked at all, and that case sets `unreadable`.
   */
  hooksPath: string;
  /**
   * Where that directory sits RELATIVE TO THE WORKING TREE, as a git-style path, or `null` when it is
   * not inside it at all. `""` means the hook directory IS the working tree root.
   *
   * Amendment (X-1). Every hash on the approval screen describes the moment it was taken, and the
   * question nobody asked was whether this operation is the thing that changes what it describes.
   * `core.hooksPath = .githooks` is an ordinary plain-git convention and it puts the hook directory
   * inside TRACKED CONTENT: `git merge --no-ff` writes the candidate's version of those files and
   * then runs the hook out of the directory it just rewrote. Measured on git 2.50.1 and on this
   * product — the screen itemised `sha256 f64801cf…`, git executed `af872625…`, the candidate only
   * changed the file's CONTENT (the executable bit came from main's index entry, no `chmod`, no
   * `.git/config` write, no race), and the promotion recorded `applied`.
   *
   * Binding could not see it, and could not have: `previewDigest` and the re-verification before the
   * approval is spent both happen BEFORE the merge, and the merge is what changes the file. So the
   * answer is not another fingerprint, it is this question — asked of git for the directory, and of
   * the merge's own file list for whether it writes there (`hookDirectoryBlockers`).
   *
   * EVERY spelling that lands inside is kept — the lexical one and the `realpath` one are a genuine
   * union, not a first match.
   *
   * Amendment (Y-1). The sentence above this one used to say "UNIONED" while the code returned on
   * the first spelling that landed inside, and the field was a single string. That is not a wording
   * slip: a merge writes the REALPATH, so a hook directory reached through a symlink was judged at
   * one spelling and rewritten at the other. Measured on git 2.50.1 and on this product, twice:
   * `.githooks -> tools/hooks` as tracked content with `core.hooksPath=.githooks`, and the ordinary
   * shared-hooks spelling `ln -s ../tools/hooks .git/hooks` which needs no config at all. Both gave
   * `insideWorkingTree: ".githooks"` / `".git/hooks"`, `blockers: []`, `approvable: true`, attacker
   * code executed as the owner, `state: applied` — the disclosed sha256 was not the sha256 that ran.
   *
   * `null` means git could not be asked at all (and that case sets `unreadable`); `[]` means git
   * answered and the directory is outside this working tree. The two are different answers and are
   * kept different, for the reason `readExecutedHooks` gives about null versus `[]`.
   */
  insideWorkingTree: string[] | null;
  /** Executable hooks present there, name and content hash, sorted. */
  hooks: Array<{ name: string; sha256: string; bytes: number }>;
  /**
   * Configured merge drivers: `merge.<name>.driver` runs a command during a real merge, reported as
   * `key=value`.
   *
   * The KEY goes through `redactConfigSubsection` before it leaves this function, because
   * `merge.<url>.driver` is a valid spelling and a URL may carry a token — measured, not reasoned
   * about: it was rendered verbatim and stored verbatim while the round that fixed `programs`
   * claimed the hazard was closed. The VALUE is shown as configured, because it is the command git
   * would execute and that is the entire point of disclosing it; a secret an owner puts inside a
   * merge driver command is a residual risk this list does not close.
   */
  drivers: string[];
  /** Configured clean/smudge filters, including LFS, `key=value`, key redacted like `drivers`. */
  filters: string[];
  /**
   * Configuration keys present in this repository that `CONFIG_NAMES_A_PROGRAM` recognises as able
   * to name a program git runs, by KEY only. Disclosure, itemised, so the owner is shown what the
   * merge could execute rather than a fingerprint that changed.
   *
   * NOT every such key, and the difference is measured rather than theoretical: this list was
   * written claiming to be every one of them while `gpg.ssh.defaultKeyCommand` — a key git really
   * does execute, under `commit.gpgsign` with `gpg.format=ssh` — matched nothing in it. See the
   * comment on `CONFIG_NAMES_A_PROGRAM`, which says the same thing about the same set; completeness
   * belongs to `configDigest`, not here.
   *
   * Values are deliberately absent: `credential.helper` and friends can carry a shell snippet with a
   * secret in it, and this list is rendered on an approval screen. The values are covered by
   * `configDigest`, which binds them without ever displaying them.
   *
   * The KEY can carry one too, and that was measured rather than reasoned about: git's own
   * documented spelling for a per-URL helper is `credential.<url>.helper`, so
   * `credential.https://x-token:ghp_…@github.com.helper` is a valid key whose middle section is a
   * token — rendered verbatim on the approval screen and written into the stored preview, while the
   * comment above congratulated itself for hiding values. `redactConfigSubsection` replaces such a
   * subsection before the key leaves this function, so neither the screen nor SQLite ever holds it.
   */
  programs: string[];
  /**
   * SHA-256 over the repository's ENTIRE effective configuration under the promotion environment,
   * keys and values.
   *
   * This is the half of the gate that is not a list. `programs` and `PROMOTION_CONFIG_PINS` both
   * enumerate keys that are known today, and an enumeration of another system's behaviour is always
   * behind that system (PITFALLS #103) — measured here as the exact repeat of that pitfall: a
   * promotion bound `core.hooksPath`, `merge.*.driver` and `filter.*` and executed `gpg.program`,
   * because nothing bound it. Hashing the whole listing means a key nobody here has heard of, set
   * after the owner approved, is a binding change and a refusal.
   */
  configDigest: string;
  /**
   * True when the hook inventory could not be established; never reported as "no hooks".
   *
   * Two ways in, and amendment (W-1) added the second: the directory could not be LISTED, or git
   * could not be asked WHERE it is. The second used to be the silent one — a hooks path this code
   * resolved differently from git produced a confident, wrong, empty inventory rather than a
   * refusal. `restorePoint()` turns this into `MAIN_HOOK_DIRECTORY_UNREADABLE`, which refuses the
   * promotion outright; nothing downstream is asked to tighten on it.
   */
  unreadable: boolean;
  fingerprint: string;
}

/**
 * Everything a promotion records before it touches main, so that "put it back" can be VERIFIED
 * rather than assumed. Every field is observed; none is inferred from the fact that a command
 * returned zero.
 *
 * `ignoredFingerprint` covers CONTENT, not only paths. A path-only fingerprint was accepted as a
 * residual risk until a real-git measurement showed what it hides: main's `git status --porcelain`
 * is completely empty, `git merge` silently replaces the contents of an ignored file, exits zero,
 * and still reports a clean working tree afterwards — and the obvious rollback then deletes that
 * file rather than restoring it. Two steps that each look correct, one destroyed local secret.
 */
export interface GitRestorePoint {
  head: string;
  /** The same inspection the rest of the product uses, computed once and shared. */
  inspection: GitInspection;
  /** Ignored paths, so the owner can be shown WHICH files a merge would destroy, not a warning. */
  ignoredPaths: string[];
  /** Empty only when this working tree may receive a merge; see `PROMOTION_BLOCKERS`. */
  blockers: string[];
  clean: boolean;
  untrackedFiles: number;
  ignoredFiles: number;
  worktreeFingerprint: string;
  indexFingerprint: string;
  /** Paths AND content of untracked, non-ignored files. */
  untrackedFingerprint: string;
  /** Paths AND content of ignored files — the ones a merge destroys without saying anything. */
  ignoredFingerprint: string;
  stashDigest: string;
  stashEntries: number;
  reflogEntries: number;
  reflogDigest: string;
  hooks: HookEnvironment;
}

export interface GitInspection {
  root: string;
  clean: boolean;
  changedFiles: number;
  changedLines: number;
  changedBytes: number;
  untrackedFiles: number;
  statusSummary: string;
  fingerprint: string;
}

export const MAX_CHANGED_BYTES = 50 * 1024 * 1024;
const MAX_UNTRACKED_REVIEW_FILE_BYTES = 65_536;
const CONTENT_FINGERPRINT_TIMEOUT_MS = 30_000;
/** A promotion may run owner hooks, which can be slow; it may not run forever. */
export const MERGE_TIMEOUT_MS = 300_000;
/** Bounded pathspec for the overwrite scan; the caller's file list is already bounded below this. */
const MAX_OVERWRITE_PATHSPEC = 2_000;
/** Bounded hook inventory; an oversized one is reported as unreadable, never as "no hooks". */
const MAX_HOOK_FILES = 64;
/** Bounded ignored-path report. The fingerprint always covers every file; this list is the display. */
const MAX_REPORTED_IGNORED_PATHS = 500;
/**
 * Hard ceiling on one streamed inventory. Reaching it fails closed with its own code rather than
 * fingerprinting a prefix: a fingerprint over some of the files is not a fingerprint over the files.
 */
const MAX_INVENTORY_PATHS = 200_000;
const MAX_HOOK_BYTES = 1_048_576;
/**
 * Bounded attributes scan. git consults a `.gitattributes` in EVERY directory it descends into, plus
 * `$GIT_DIR/info/attributes` and `core.attributesFile`, so reading only the root file reports a
 * repository whose `sub/.gitattributes` declares `filter=lfs` as having no filters at all. Exceeding
 * either bound is reported as unreadable, never as "no filters".
 */
const MAX_ATTRIBUTES_FILES = 256;
const MAX_ATTRIBUTES_BYTES = 1_048_576;
/** A `filter=` on any path is a clean/smudge round trip this product cannot promise to roll back. */
const ATTRIBUTES_DECLARE_FILTER = /(?:^|\s)filter=/mu;
/**
 * Path names handed to `git check-attr` so that git itself, rather than this file's idea of where
 * attributes live, answers whether a filter would apply.
 *
 * Enumerating attributes files was measurably incomplete twice over: git expands `~` in
 * `core.attributesFile` while this product joined it under the workspace, and with no
 * `core.attributesFile` at all git still reads `$XDG_CONFIG_HOME/git/attributes` —
 * `GIT_CONFIG_GLOBAL=/dev/null` overrides the global CONFIG file, not the global ATTRIBUTES file.
 * Both were found by asking `git check-attr` in the product's exact environment. Any enumeration can
 * be outrun by the next git release or the next configuration key; asking git cannot.
 *
 * The list is representative rather than exhaustive, and that limit is stated instead of papered
 * over: it is combined with (not replaced by) the repository's own tracked and ignored paths, so an
 * attributes file whose pattern matches nothing in this repository AND none of these names is the
 * one shape neither half sees.
 */
const ATTRIBUTES_PROBE_PATHS: readonly string[] = [
  "probe", "probe.txt", "probe.md", "probe.json", "probe.xml", "probe.csv",
  "probe.bin", "probe.dat", "probe.pack", "probe.lock",
  "probe.png", "probe.jpg", "probe.gif", "probe.svg", "probe.pdf", "probe.psd", "probe.ai",
  "probe.zip", "probe.tar", "probe.gz", "probe.7z", "probe.iso", "probe.dmg",
  "probe.mp3", "probe.mp4", "probe.mov", "probe.wav", "probe.avi",
  "probe.so", "probe.dylib", "probe.dll", "probe.exe", "probe.jar", "probe.class", "probe.o",
  "probe.sh", "probe.ts", "probe.js", "probe.py", "probe.go", "probe.rs", "probe.c", "probe.h",
  ".gitattributes", ".gitignore", "probe/probe.bin", "probe/deep/probe.bin",
];
/** Bounded path list for the `check-attr` probe; the index listing that feeds it is already bounded. */
const MAX_ATTRIBUTES_PROBE_PATHS = 200_000;
/** Values `git check-attr` prints when no filter would run. Anything else is a filter. */
const ATTRIBUTES_NO_FILTER = new Set(["unspecified", "unset"]);
/**
 * Configuration keys whose value names — or switches on — a program git runs. Used for DISCLOSURE
 * only, and explicitly NOT claimed to be all of them.
 *
 * It cannot be all of them: the set is defined by another program's source and grows with its
 * releases, and this project has already been caught twice writing "exhaustive" beside such a list
 * (PITFALLS #103, #104) — and then a third time: the round that added this expression described it
 * on `HookEnvironment.programs` as "every configuration key … whose value can name a program git
 * runs" while `gpg.ssh.defaultKeyCommand` matched nothing here. That key is now listed, which is a
 * repair of one omission and NOT a claim that the next one has been anticipated.
 *
 * What stands behind it is `configDigest`, which hashes the whole listing and
 * therefore covers every key this expression does not match, and `PROMOTION_CONFIG_PINS`, which
 * makes the reachable ones unreachable. This expression only decides what gets ITEMISED to the owner.
 */
const CONFIG_NAMES_A_PROGRAM =
  /^(?:core\.(?:fsmonitor|sshcommand|askpass|editor|pager|alternaterefscommand|gitproxy)|sequence\.editor|gpg\.program|gpg\..+\.(?:program|defaultkeycommand)|commit\.gpgsign|tag\.gpgsign|merge\.verifysignatures|credential\.(?:.+\.)?helper|diff\.external|diff\..+\.(?:command|textconv)|merge\..+\.driver|mergetool\..+\.cmd|difftool\..+\.cmd|filter\..+\.(?:clean|smudge|process)|pager\..+|trailer\..+\.command|uploadpack\.packobjectshook|guitool\..+\.cmd|browser\..+\.cmd|web\.browser)$/u;
/** Bounded itemised config disclosure. The digest always covers every key; this list is the display. */
const MAX_REPORTED_CONFIG_PROGRAMS = 64;

/**
 * Hides the part of a configuration key that is arbitrary owner-supplied text rather than a name git
 * defines, wherever that text is documented to be — or simply looks like — a URL.
 *
 * A git key is `section.subsection.name`, and the subsection is whatever the repository wrote there.
 * For `credential.<url>.*` that is a URL by specification, and a URL may carry userinfo — which is
 * where a token ends up. Measured in a browser against the real approval dialog:
 * `SECRET_IN_PROGRAM_KEY_RENDERED: true`.
 *
 * Only the middle is replaced, so the disclosure still says WHICH mechanism is configured — the
 * owner needs to know a credential helper would run — and the rest of the list is untouched, because
 * `merge.<name>.driver` and `difftool.<name>.cmd` name things the owner chose and wants to read.
 * The second arm catches the same hazard in any other subsection that looks like a URL, so a key
 * this file has not thought of does not become a new way to print a token. Completeness of the gate
 * itself is not affected either way: `configDigest` covers the raw listing, redaction and all.
 */
function redactConfigSubsection(key: string): string {
  const parts = key.split(".");
  if (parts.length < 3) return key;
  const subsection = parts.slice(1, -1).join(".");
  const urlLike = subsection.includes("://") || subsection.includes("@");
  if (parts[0] !== "credential" && !urlLike) return key;
  return `${parts[0]}.<redacted>.${parts[parts.length - 1]}`;
}

/** Bounded read of one promotion's trace file; exceeding it reports "not read", never "no hooks". */
const MAX_HOOK_TRACE_BYTES = 16 * 1024 * 1024;
/** The index mode git gives a submodule (gitlink). `.gitmodules` is documentation; this is the fact. */
const GITLINK_MODE = "160000";
/**
 * Files whose presence in the git directory means a working tree is in the middle of an operation.
 * `AUTO_MERGE` and `MERGE_MSG` are included because they outlive some interruptions that leave no
 * `MERGE_HEAD` at all, and `index.lock` because a promotion must refuse rather than wait for it.
 */
const PROMOTION_STATE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["MERGE_HEAD", "MAIN_MERGE_HEAD_PRESENT"],
  ["AUTO_MERGE", "MAIN_AUTO_MERGE_PRESENT"],
  ["MERGE_MSG", "MAIN_MERGE_MSG_PRESENT"],
  ["REBASE_HEAD", "MAIN_REBASE_IN_PROGRESS"],
  ["CHERRY_PICK_HEAD", "MAIN_CHERRY_PICK_IN_PROGRESS"],
  ["REVERT_HEAD", "MAIN_REVERT_IN_PROGRESS"],
  ["index.lock", "MAIN_INDEX_LOCKED"],
];
const SENSITIVE_UNTRACKED_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/iu;

/**
 * Where one promotion's trace is read from — and the difference is a security property, not plumbing.
 *
 * Amendment (Y-2). A promotion's trace lives at a path that is handed to every hook the merge runs
 * (`GIT_TRACE2_EVENT`), so anything reached BY PATH is a record the observed thing can replace. A
 * `fd` is a descriptor THIS process opened before the merge was spawned and has held in memory ever
 * since: `rename(2)` over the path does not move it, so the bytes git wrote are still the bytes read.
 * Measured on git 2.50.1 — a `pre-merge-commit` hook that filtered the file and `mv`-ed the copy
 * back left the path holding a laundered trace with no children at all, while the retained
 * descriptor still named `.git/hooks/pre-merge-commit` in a `child_start`.
 *
 * A `path` source is the fallback for readers that did not run the merge (a crash reader has no
 * descriptor and never will). It is not first-hand and its callers may only use it to TIGHTEN.
 */
export type PromotionTraceSource = { readonly fd: number } | { readonly path: string };

/** The whole trace as text, or null when it could not be read or is over the size limit. */
async function readTraceText(source: PromotionTraceSource): Promise<string | null> {
  if ("path" in source) {
    try {
      const info = await stat(source.path);
      if (!info.isFile() || info.size > MAX_HOOK_TRACE_BYTES) return null;
      return await readFile(source.path, "utf8");
    } catch { return null; }
  }
  try {
    const info = fstatSync(source.fd);
    if (!info.isFile() || info.size > MAX_HOOK_TRACE_BYTES) return null;
    // From offset 0 explicitly: this descriptor is shared with nothing, but reading it positionally
    // keeps it re-readable, and both callers below read it in the same settlement.
    const buffer = Buffer.allocUnsafe(info.size);
    const read = readSync(source.fd, buffer, 0, info.size, 0);
    return buffer.toString("utf8", 0, read);
  } catch { return null; }
}

/** One hook git actually ran during a promotion, as reported by git's own trace stream. */
export interface ObservedHookRun {
  /** The hook name git reports, e.g. `pre-merge-commit`. */
  name: string;
  /** The command line git executed, first argument only, so it names the file that ran. */
  path: string;
  /** The hook's exit status, or null when the trace recorded a start with no matching exit. */
  exitCode: number | null;
}

/**
 * The hooks a single `git merge` executed, and what each of them returned, read back from git.
 *
 * `runProcess` only ever sees the merge's own exit code, so without this the record could say no
 * more than "the merge failed" — and "hooks: ok" written from a flag is exactly the constant-shaped
 * assertion PITFALLS #86 is about. `GIT_TRACE2_EVENT` makes git report every child it starts, with
 * `child_class: "hook"`, the hook name and, in a later event with the same `child_id`, the exit
 * code. Those are observations, not intentions: a hook that did not run does not appear.
 *
 * Returns null when the trace could not be read at all. Null and `[]` mean different things — "not
 * observed" and "observed that none ran" — and collapsing them is how a record starts lying.
 */
export async function readExecutedHooks(
  source: PromotionTraceSource,
): Promise<ObservedHookRun[] | null> {
  const children = await readTraceChildren(source);
  return children === null
    ? null
    : children.filter((child) => child.childClass === "hook")
      .map(({ name, path, exitCode }) => ({ name, path, exitCode }));
}

/** One child process git started during a promotion, with the two fields that say whose code it is. */
interface ObservedChild extends ObservedHookRun {
  /** git's own classification: `"hook"` for a hook, `"?"` for everything it does not name. */
  childClass: string;
  /** True when git handed a command LINE to a shell — how `merge.<name>.driver` is started. */
  shell: boolean;
}

/**
 * Every child in one promotion's trace, in observation order, or null when it could not be read.
 *
 * A `child_exit` with no `child_start` is a child TOO. Amendment (Y-2): this used to build its
 * result from `child_start` alone, so an exit whose start was gone was dropped on the floor — and
 * that is exactly the residue a trace-laundering hook leaves, because the exit is written after the
 * hook has already finished editing the file. Measured on git 2.50.1: a hook that rewrote the trace
 * in place, keeping git's genuine opening events and deleting every child event, produced a file
 * whose only remaining evidence was one orphan `child_exit` — and this function reported that as
 * "no child ran". An observed exit is an observation; discarding it is how a record starts lying
 * ([[PITFALLS]] #140, the answer was in hand and nobody took it).
 *
 * An orphan is reported with the fields the trace does not have left blank, which puts it on the
 * fail-closed side of every consumer: `childClass` is not `"hook"` so it is not claimed to be one,
 * and an empty `path` is not `git`, so `readExecutedRepositoryPrograms` counts it as untrusted.
 */
async function readTraceChildren(
  source: PromotionTraceSource,
): Promise<ObservedChild[] | null> {
  const contents = await readTraceText(source);
  if (contents === null) return null;
  const observed = new Map<string, ObservedChild>();
  const order: string[] = [];
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const sid = typeof event.sid === "string" ? event.sid : "";
    const childId = typeof event.child_id === "number" ? String(event.child_id) : undefined;
    if (childId === undefined) continue;
    const id = `${sid}#${childId}`;
    if (event.event === "child_start") {
      const argv = Array.isArray(event.argv) ? event.argv : [];
      const previous = observed.get(id);
      const run: ObservedChild = {
        name: typeof event.hook_name === "string" ? event.hook_name : "",
        path: typeof argv[0] === "string" ? argv[0] : "",
        // An exit seen before its start is still this child's exit code.
        exitCode: previous?.exitCode ?? null,
        childClass: typeof event.child_class === "string" ? event.child_class : "",
        shell: event.use_shell === true,
      };
      if (previous === undefined) order.push(id);
      observed.set(id, run);
      continue;
    }
    if (event.event === "child_exit") {
      const previous = observed.get(id);
      const exitCode = typeof event.code === "number" ? event.code : null;
      if (previous === undefined) {
        order.push(id);
        observed.set(id, { name: "", path: "", exitCode, childClass: "", shell: false });
        continue;
      }
      if (exitCode !== null) previous.exitCode = exitCode;
    }
  }
  return order.map((id) => observed.get(id)).filter((run): run is ObservedChild => run !== undefined);
}

/**
 * Whether git STARTED a program during this promotion that was not git itself — the observed half of
 * "did this promotion execute code this repository named".
 *
 * Amendment (W-2). The other half, `restore.hooks`, is a snapshot taken before the merge is spawned,
 * and the gap between the two is wide enough to walk through: the product's own `mkdir` of
 * `promotion-traces` is a publicly visible starting gun, and a process with the owner's uid sharing
 * main's common `.git` can drop in a hook after the inventory has been read. A promotion that ran
 * such a hook was settled by its leader's exit and handed `git reset --hard`, in the same payload
 * whose `hooksExecuted` named the hook by file name.
 *
 * Three legs, all measured on git 2.50.1 rather than reasoned about, and each of them only ever
 * ADDS a reason to tighten:
 *
 *  - `child_class: "hook"` — how git reports a hook.
 *  - `use_shell: true` — how git reports a `merge.<name>.driver`, whose `child_class` is `"?"`. The
 *    round that documented that difference in F26 also recorded that such a child does NOT appear in
 *    `hooksExecuted`, which is exactly why a second question is asked here.
 *  - an `argv[0]` that is not `git` — everything else. An ordinary merge starts `git stash create`
 *    and `git maintenance run`, both with `argv[0] === "git"`, so this leg is quiet on the
 *    repositories (V-3) is meant to leave alone, and a child git starts under some future name is
 *    counted as untrusted rather than skipped.
 *
 * This is NOT claimed to enumerate the ways a repository can get code executed during a merge; it is
 * claimed to report children git said it started. Returns null when the trace could not be read at
 * all — null is "not observed", and the caller may not read it as "nothing ran".
 *
 * Two named limits, so the claim is the narrow one rather than the comfortable one:
 *  - the trace parser reads `child_start`/`child_exit` and NOTHING ELSE, so git's `exec` event — the
 *    one it writes when it replaces itself rather than forking, as an alias does — is not looked at
 *    here or anywhere in this file;
 *  - the third leg is `basename(argv[0]) !== "git"`, which is a statement about a file NAME.
 * Neither is a measured bypass; both are the shape of what this cannot see, written down so the
 * residual-risk row can say it (amendment (X-4), the P2 half).
 */
export async function readExecutedRepositoryPrograms(
  source: PromotionTraceSource,
): Promise<ObservedHookRun[] | null> {
  const children = await readTraceChildren(source);
  if (children === null) return null;
  return children
    .filter((child) => child.childClass === "hook" || child.shell || basename(child.path) !== "git")
    .map(({ name, path, exitCode }) => ({ name, path, exitCode }));
}

/**
 * EVERY position `directory` occupies relative to `workspace`, git-style. `[]` means no spelling of
 * it lands inside the working tree.
 *
 * `""` is a real answer and means "this IS the working tree root" — the degenerate spelling of
 * amendment (X-1)'s blocker. Measured on git 2.50.1: `core.hooksPath = ""` makes
 * `git rev-parse --git-path hooks` answer `./`, so joining it onto the workspace makes the root of
 * the working tree the hook directory. Reporting nothing for it would be a different answer from the
 * one git just gave. What git then DOES with that directory is a separate measurement and is written
 * down where it is acted on (`hookDirectoryBlockers`); this function only reports position.
 *
 * ## Why this returns a set (amendment (Y-1))
 *
 * A path has two spellings that matter here — the one git named and the one `realpath` resolves it
 * to — and a merge writes the SECOND while a name-based judgement reads the FIRST. The previous
 * shape returned the first spelling that landed inside and its own comment called that a union; the
 * consequence was that `.githooks -> tools/hooks` was judged at `.githooks`, the merge wrote
 * `tools/hooks/pre-merge-commit`, and the gate saw no overlap. Measured end to end on this product:
 * `approvable: true`, `blockers: []`, attacker code executed as the owner, `state: applied`.
 *
 * So both are kept, deduplicated, and the caller must refuse if ANY of them is written. Extra
 * positions can only add a refusal, which is the direction this whole gate is allowed to move in.
 */
async function workingTreePositions(workspace: string, directory: string): Promise<string[]> {
  const spellings = [directory];
  try {
    const real = await realpath(directory);
    if (real !== directory) spellings.push(real);
  } catch { /* a directory that does not exist yet is judged by the name git gave */ }
  const positions: string[] = [];
  for (const spelling of spellings) {
    const path = relative(workspace, spelling);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) continue;
    const position = path.split(sep).join("/");
    if (!positions.includes(position)) positions.push(position);
  }
  return positions;
}

/**
 * Whether git's own session-opening events for the MERGE LEADER are present in this promotion's
 * trace — the tamper check amendment (X-4) turned on.
 *
 * Every git process writes `version` and `start` to `GIT_TRACE2_EVENT` before it does anything else,
 * long before any hook can run (measured on git 2.50.1). This product spawns the merge itself and
 * holds the pid, so when it knows a git process started, that process HAS written those two events.
 * A trace that afterwards does not contain them was emptied by something running inside the merge —
 * measured: a `pre-merge-commit` hook that runs `: > "$GIT_TRACE2_EVENT"` leaves a 1 154-byte trace
 * whose first surviving event is the hook's own `child_exit`.
 *
 * The leader is identified by the SHAPE of the session id, not by matching a value: git gives a
 * child git process an sid of `<parent-sid>/<own-sid>`, so the top-level session is the one with no
 * `/` in it (measured: one merge whose hook ran `git log` produced three distinct nested ids beside
 * the one flat id, and every nested one carried its own `version`/`start` pair). Without that,
 * any git the repository chose to run after emptying the file would supply a fresh `start` and put
 * the answer back.
 *
 * ## Why the pid is a parameter (amendment (Y-2))
 *
 * Session SHAPE alone answers "is this a top-level git", not "is this THE git this process started".
 * The product spawns the merge and is handed the pid; nothing was comparing that number against the
 * one in the trace, so a forged flat session id put the answer back — measured (`k4-forgedstart`):
 * a hook writing one synthetic `start` with an invented `P<hex>` made `untrustedProgramsRan` false.
 * That was the whole of [[PITFALLS]] #140 again: the answer was already in this process's memory and
 * no one had passed it in.
 *
 * `leaderPid` is that number, read from the spawn callback and never persisted anywhere, so no file
 * can supply it and no later reader can be talked into this branch. Measured on git 2.50.1: a
 * session id ends `-P<pid-in-hex>` and the pid is the one `child.pid` reported, zero-padded.
 * `null` — no pid in hand — answers `false`, which tightens.
 *
 * Returns TRUE only on positive evidence. A missing, unreadable, oversized or unparsable trace all
 * answer `false`, and the single caller may only use `false` to TIGHTEN — absence never loosens
 * anything (amendment (O)).
 */
export async function readLeaderSessionOpened(
  source: PromotionTraceSource, leaderPid: number | null,
): Promise<boolean> {
  if (leaderPid === null || !Number.isInteger(leaderPid) || leaderPid <= 0) return false;
  const contents = await readTraceText(source);
  if (contents === null) return false;
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.event !== "start") continue;
    const sid = typeof event.sid === "string" ? event.sid : "";
    if (sid.length === 0 || sid.includes("/")) continue;
    const match = TRACE_SESSION_PID.exec(sid);
    if (match !== null && Number.parseInt(match[1] as string, 16) === leaderPid) return true;
  }
  return false;
}

/**
 * Trace2 session ids end in the emitting git process's own pid, in hex: `<time>-H<host>-P<pid>`.
 *
 * Kept beside the one caller that compares it against a FIRST-HAND number. `candidate-registry.ts`
 * has its own copy for the crash-reader path, where there is no first-hand number to compare with
 * and the parsed value may only ever tighten.
 */
const TRACE_SESSION_PID = /-P([0-9a-fA-F]{1,12})$/u;

/**
 * The promotion environment with its command-line config entries removed, so that `git config
 * --list` answers what the REPOSITORY declares rather than echoing this product's own pins back.
 *
 * `GIT_CONFIG_COUNT=0` is what turns them off; the individual keys are deleted as well so nothing
 * downstream can read a leftover pair and believe it is in effect.
 */
function repositoryConfigEnvironment(promotionEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...promotionEnv, GIT_CONFIG_COUNT: "0" };
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete environment[key];
  }
  return environment;
}

export class GitBroker {
  async #git(
    workspace: string, args: string[], outputLimitBytes = 1_048_576,
    env: NodeJS.ProcessEnv = minimalGitEnvironment(),
  ): Promise<string> {
    const executable = await resolveExecutable("git");
    const result = await runProcess({
      executable,
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes,
      env,
    });
    if (result.exitCode !== 0 || result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
    return result.stdout;
  }

  async #paths(workspace: string, args: string[]): Promise<string[]> {
    const output = await this.#git(workspace, args);
    const paths = output.split("\0").filter(Boolean);
    if (paths.some((path) => path.includes("\uFFFD") || path.includes("\0"))) {
      throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
    }
    return paths;
  }

  async #streamStdout(workspace: string, args: string[], consume: (chunk: Buffer) => void): Promise<void> {
    const executable = await resolveExecutable("git");
    const result = await runProcess({
      executable,
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 262_144,
      env: minimalGitEnvironment(),
      stdoutConsumer: consume,
    });
    if (result.exitCode !== 0 || result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
  }

  async #statusInventory(workspace: string, fingerprint: ReturnType<typeof createHash>): Promise<{
    changedPaths: string[];
    untrackedPaths: string[];
    summary: string;
  }> {
    const decoder = new StringDecoder("utf8");
    const changedPaths: string[] = [];
    const untrackedPaths: string[] = [];
    const summary: string[] = [];
    let pending = "";
    let expectingRenameSource = false;
    const token = (value: string): void => {
      if (value.includes("\uFFFD")) throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
      if (expectingRenameSource) {
        if (!value) throw new Error("INVALID_GIT_STATUS_STREAM");
        expectingRenameSource = false;
        return;
      }
      if (value.length < 4 || value[2] !== " ") throw new Error("INVALID_GIT_STATUS_STREAM");
      const code = value.slice(0, 2);
      const path = value.slice(3);
      if (!path) throw new Error("INVALID_GIT_STATUS_STREAM");
      if (code === "!!") return;
      changedPaths.push(path);
      if (code === "??") untrackedPaths.push(path);
      if (summary.length < 100) summary.push(`${code} ${JSON.stringify(path)}`);
      expectingRenameSource = code.includes("R") || code.includes("C");
    };
    const consume = (chunk: Buffer): void => {
      fingerprint.update(chunk);
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        token(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
      }
    };
    await this.#streamStdout(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], consume);
    pending += decoder.end();
    if (pending.length > 0 || expectingRenameSource) throw new Error("INVALID_GIT_STATUS_STREAM");
    return { changedPaths, untrackedPaths, summary: summary.join("\n") };
  }

  async #numstatLines(
    workspace: string,
    args: string[],
    fingerprint: ReturnType<typeof createHash>,
  ): Promise<number> {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let lines = 0;
    const token = (value: string): void => {
      if (value.includes("\uFFFD")) throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
      const firstTab = value.indexOf("\t");
      const secondTab = firstTab < 0 ? -1 : value.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) return;
      const added = value.slice(0, firstTab);
      const removed = value.slice(firstTab + 1, secondTab);
      if (/^\d+$/u.test(added)) lines += Number(added);
      if (/^\d+$/u.test(removed)) lines += Number(removed);
    };
    const consume = (chunk: Buffer): void => {
      fingerprint.update(chunk);
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        token(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
      }
    };
    await this.#streamStdout(workspace, [...args, "-z"], consume);
    pending += decoder.end();
    if (pending.length > 0) throw new Error("INVALID_GIT_NUMSTAT_STREAM");
    return lines;
  }

  async #existingFile(workspace: string, path: string): Promise<{ absolute: string; size: number } | undefined> {
    try {
      const absolute = await resolveExistingInside(workspace, path);
      const info = await stat(absolute);
      if (info.isFile() && info.nlink > 1) throw new Error("HARDLINK_CHANGED_FILE_DENIED");
      return info.isFile() ? { absolute, size: info.size } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #contentFingerprint(
    workspace: string,
    path: string,
    deadlineMs: number,
  ): Promise<{ size: number; digest: string } | undefined> {
    let handle: FileHandle | undefined;
    try {
      const absolute = await resolveExistingInside(workspace, path);
      handle = await open(absolute, "r");
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return undefined;
      if (before.nlink > 1) throw new Error("HARDLINK_CHANGED_FILE_DENIED");
      const content = createHash("sha256");
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) throw new Error("GIT_CONTENT_FINGERPRINT_TIMEOUT");
      const stream = handle.createReadStream({ autoClose: false });
      const timeout = setTimeout(() => {
        stream.destroy(new Error("GIT_CONTENT_FINGERPRINT_TIMEOUT"));
      }, remainingMs);
      timeout.unref();
      try {
        for await (const chunk of stream) content.update(chunk);
      } finally {
        clearTimeout(timeout);
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      ) throw new Error("GIT_FILE_CHANGED_DURING_INSPECTION");
      const size = Number(before.size);
      if (!Number.isSafeInteger(size)) throw new Error("GIT_FILE_SIZE_UNSUPPORTED");
      return { size, digest: content.digest("hex") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async inspect(workspaceInput: string): Promise<GitInspection> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const root = (await this.#git(workspace, ["rev-parse", "--show-toplevel"], 16_384)).trim();
    if ((await canonicalWorkspace(root)) !== workspace) throw new Error("WORKSPACE_MUST_BE_GIT_ROOT");
    const fingerprintHash = createHash("sha256").update("orchestratory.git-inspection.v2\0status\0");
    const status = await this.#statusInventory(workspace, fingerprintHash);
    fingerprintHash.update("\0numstat\0");
    let changedLines = await this.#numstatLines(
      workspace, ["diff", "--no-ext-diff", "--numstat"], fingerprintHash,
    );
    fingerprintHash.update("\0cached-numstat\0");
    changedLines += await this.#numstatLines(
      workspace, ["diff", "--cached", "--no-ext-diff", "--numstat"], fingerprintHash,
    );
    const untrackedPaths = status.untrackedPaths;
    const changedPaths = [...new Set(status.changedPaths)].sort();
    const contentFingerprintDeadline = Date.now() + CONTENT_FINGERPRINT_TIMEOUT_MS;
    let changedBytes = 0;
    fingerprintHash.update("\0content\0");
    for (const path of changedPaths) {
      fingerprintHash.update(path).update("\0");
      const file = await this.#contentFingerprint(workspace, path, contentFingerprintDeadline);
      if (!file) continue;
      changedBytes += file.size;
      fingerprintHash.update(String(file.size)).update("\0").update(file.digest).update("\0");
    }
    return {
      root,
      clean: changedPaths.length === 0,
      changedFiles: changedPaths.length,
      changedLines,
      changedBytes,
      untrackedFiles: untrackedPaths.length,
      statusSummary: status.summary,
      fingerprint: fingerprintHash.digest("hex"),
    };
  }

  async headSha(workspaceInput: string): Promise<string> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const value = (await this.#git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], 16_384)).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new Error("INVALID_GIT_HEAD");
    return value;
  }

  /** Resolves a path inside this working tree's git directory, honouring linked worktrees. */
  async #gitPath(workspace: string, name: string, env?: NodeJS.ProcessEnv): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name)) throw new Error("INVALID_GIT_PATH_NAME");
    // `--git-path hooks` honours `core.hooksPath`, so which environment asks matters: asked under
    // the read-only environment it answers `/dev/null`, which is this product's own guard rather
    // than the repository's configuration, and would report every repository as having no hooks.
    const value = (await this.#git(workspace, ["rev-parse", "--git-path", name], 16_384, env)).trim();
    if (!value) throw new Error("GIT_COMMAND_FAILED");
    return isAbsolute(value) ? value : join(workspace, value);
  }

  async #present(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /**
   * Paths and CONTENT of a set of files, as one fingerprint. Used for the untracked and ignored
   * inventories, where the path alone says nothing about what a merge is about to destroy.
   *
   * It shares the same wall-clock deadline as every other content hash in this class, and a deadline
   * that runs out throws rather than returning a shorter answer: a fingerprint over some of the
   * files is not a fingerprint over the files.
   */
  async #pathContentFingerprint(
    workspace: string, args: string[], deadlineMs: number, label: string,
  ): Promise<{ files: number; fingerprint: string; paths: string[] }> {
    // Streamed, not captured. The captured form has a 1 MiB ceiling, and a repository with tens of
    // thousands of ignored files exceeds it — which would turn a safety gate into a hard failure on
    // exactly the large repositories it matters most for (the shape PITFALLS #43 already recorded).
    const paths: string[] = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    await this.#streamStdout(workspace, args, (chunk) => {
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        const path = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!path) continue;
        if (path.includes("�")) throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
        if (paths.length >= MAX_INVENTORY_PATHS) throw new Error("GIT_INVENTORY_TOO_LARGE");
        paths.push(path);
      }
    });
    pending += decoder.end();
    if (pending.length > 0) throw new Error("INVALID_GIT_PATH_STREAM");
    paths.sort();
    const hash = createHash("sha256").update(label).update("\0");
    for (const path of paths) {
      hash.update(path, "utf8").update("\0");
      const file = await this.#contentFingerprint(workspace, path, deadlineMs);
      // An entry git listed but that is not a readable regular file right now is recorded as such,
      // never skipped: skipping would make an appearing or disappearing file invisible.
      if (!file) {
        hash.update("absent").update("\0");
        continue;
      }
      hash.update(String(file.size)).update("\0").update(file.digest).update("\0");
    }
    return { files: paths.length, fingerprint: hash.digest("hex"), paths };
  }

  /**
   * Every hook, merge driver and filter this repository would run, with content hashes.
   *
   * Failure to list the directory sets `unreadable` rather than producing an empty list, because
   * "there are no hooks" and "I could not look" lead to opposite decisions.
   */
  async hookEnvironment(workspaceInput: string): Promise<HookEnvironment> {
    const workspace = await canonicalWorkspace(workspaceInput);
    // Measured under the environment the PROMOTION will use, not the read-only one. Every other Git
    // command in this product pins `core.hooksPath=/dev/null` so that inspecting a repository never
    // runs its code — read that way, this function would faithfully report the product's own guard
    // instead of the owner's configuration, and conclude there are no hooks. What has to be reported
    // here is what will actually execute.
    const promotionEnv = promotionGitEnvironment();
    // …but with the product's own pins removed for the LISTING. `GIT_CONFIG_KEY_n` entries show up
    // in `git config --list` like any other, so reading it under the promotion environment reports
    // this product's constants back to itself: `commit.gpgsign` would be disclosed on every approval
    // screen as if the repository had set it, and a repository that really does set it would be
    // indistinguishable from one that does not. What is bound and disclosed here is what the
    // REPOSITORY declares; what the pins do about it is a fixed, documented product behaviour.
    const config = await this.#git(
      workspace, ["config", "--list", "-z"], 1_048_576, repositoryConfigEnvironment(promotionEnv),
    );
    const entries = config.split("\0").filter(Boolean).map((entry) => {
      const boundary = entry.indexOf("\n");
      return boundary < 0 ? { key: entry, value: "" } : { key: entry.slice(0, boundary), value: entry.slice(boundary + 1) };
    });
    // The key half goes through the same redaction as `programs`, and for the same measured reason:
    // `merge.<url>.driver` and `filter.<url>.clean` are valid keys whose subsection is owner-supplied
    // text, so a token written there was rendered verbatim on the approval screen and stored verbatim
    // in `preview_json`. The previous round redacted `programs` and left these two lists — the same
    // hazard in the same function, one branch over ([[PITFALLS]] #108).
    //
    // The VALUE is deliberately not redacted: for these two lists the value IS the command git would
    // run, and hiding it would remove the only thing that makes the disclosure worth reading. That
    // asymmetry is a residual risk and is written down as one, not as a claim that nothing leaks.
    //
    // ## Why these three lists still read the listing, after amendment (W-1)
    //
    // (W-1) says: when a key is being read by parsing another program's configuration, either ask
    // that program or say why not. Enumerated, per key family rather than left to be assumed:
    //
    //  - `merge.*.driver` and `filter.*.clean|smudge|process` — both consumers treat a NON-EMPTY
    //    list as a reason to tighten (`untrustedProgramsRan`) or to refuse outright
    //    (`MAIN_HAS_CONTENT_FILTERS`). `--list` prints every occurrence, so what this produces is a
    //    SUPERSET of what git would use: extra entries can only add refusals, never remove one.
    //    Neither value is path-typed, so the `~`/`%(prefix)/` expansion that broke `core.hooksPath`
    //    has no analogue here. Measured that `--list` sees worktree-scoped config
    //    (`extensions.worktreeConfig`) and keys pulled in through `include.path`, so those two
    //    scopes are not a gap in the superset either.
    //  - `programs` — disclosure only, and `CONFIG_NAMES_A_PROGRAM` is documented as NOT the whole
    //    set. A superset of occurrences is again the harmless direction for a list whose only job is
    //    to be shown.
    //
    // The keys that are read for their MEANING rather than their presence do ask git, each in the
    // one way git answers it: `core.hooksPath` via `rev-parse --git-path hooks` (just below),
    // `core.attributesFile` via `config --get --path` (`#attributesFiles`), `core.sparseCheckout`
    // via `config --type=bool --get` (`#sparseCheckoutBlockers`), and whether any filter applies at
    // all via `check-attr` (`#attributesFilterDeclared`). `configDigest` parses nothing.
    const configured = (test: RegExp): string[] =>
      entries.filter((entry) => test.test(entry.key))
        .map((entry) => `${redactConfigSubsection(entry.key)}=${entry.value}`).sort();
    // Amendment (W-1): git is asked where its hooks are, in the environment the merge will use.
    // Deriving it from the listing was wrong in two independent ways at once (duplicate keys, `~`),
    // and the general lesson is that "which occurrence wins" and "what expands" are git's semantics,
    // not this file's. `#gitPath` throws when git could not answer, and an unanswered question is
    // recorded as an unreadable inventory rather than as an empty one.
    let directory: string | null = null;
    try {
      directory = await this.#gitPath(workspace, "hooks", promotionEnv);
    } catch { directory = null; }
    const hooksPath = directory ?? "";
    const insideWorkingTree = directory === null ? null : await workingTreePositions(workspace, directory);
    // git treats a hooks path it cannot read as "no hooks" and proceeds. So does this, but it says
    // so: `/dev/null` and a deleted directory are both "nothing will run", and both are reported as
    // an explicit empty inventory rather than as an unreadable one.
    const absent = directory === null
      || await stat(directory).then((info) => !info.isDirectory()).catch(() => true);
    const hooks: HookEnvironment["hooks"] = [];
    let unreadable = directory === null;
    if (!absent && directory !== null) try {
      const names = (await readdir(directory)).filter((name) => !name.endsWith(".sample")).sort();
      if (names.length > MAX_HOOK_FILES) throw new Error("TOO_MANY_HOOKS");
      for (const name of names) {
        const info = await stat(join(directory, name)).catch(() => undefined);
        // Only files git could actually execute are reported; a non-executable file in the hook
        // directory cannot run, and reporting it would bury the ones that can.
        if (!info?.isFile() || (info.mode & 0o111) === 0) continue;
        if (info.size > MAX_HOOK_BYTES) throw new Error("HOOK_TOO_LARGE");
        hooks.push({
          name,
          bytes: info.size,
          sha256: createHash("sha256").update(await readFile(join(directory, name))).digest("hex"),
        });
      }
    } catch {
      unreadable = true;
    }
    const drivers = configured(/^merge\..+\.driver$/u);
    const filters = [...configured(/^filter\..+\.(?:clean|smudge|process)$/u)];
    const matched = entries
      .filter((entry) => CONFIG_NAMES_A_PROGRAM.test(entry.key))
      // Redacted before anything else touches it, so no later step can be the one that leaks it.
      .map((entry) => redactConfigSubsection(entry.key))
      .sort()
      .filter((key, index, all) => all.indexOf(key) === index);
    // Bounded, because this goes into a stored record with a length limit and `pager.*` alone can be
    // written thousands of times. Truncating the DISPLAY is safe in a way truncating a fingerprint
    // would not be: `configDigest` is computed over the whole listing either way.
    const programs = matched.length > MAX_REPORTED_CONFIG_PROGRAMS
      ? [...matched.slice(0, MAX_REPORTED_CONFIG_PROGRAMS), `…${matched.length - MAX_REPORTED_CONFIG_PROGRAMS} more`]
      : matched;
    // Over the raw listing, not over the parsed entries: it includes every key this file does not
    // know about, in git's own order, values and all.
    const configDigest = createHash("sha256").update(config, "utf8").digest("hex");
    return {
      hooksPath,
      insideWorkingTree,
      hooks,
      drivers,
      filters,
      programs,
      configDigest,
      unreadable,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(
          [hooksPath, insideWorkingTree, hooks, drivers, filters, programs, configDigest, unreadable],
        ), "utf8")
        .digest("hex"),
    };
  }

  /**
   * EVERY position git would run this working tree's hooks from, RELATIVE to the working tree; `[]`
   * when no spelling of that directory is inside it. Throws when git could not be asked at all.
   *
   * Amendment (Y-1): a set rather than one answer, for the reason `workingTreePositions` gives — a
   * hook directory reached through a symlink occupies two positions and a write to either one of
   * them installs a program git runs on its own.
   *
   * Amendment (X-3). The narrow question, for callers that need the location and not the inventory:
   * "is this path one git or the toolchain AUTO-EXECUTES". A regular expression over file names
   * cannot answer it — measured, and measured as the same pitfall for the third time
   * ([[PITFALLS]] #103/#108): `WORKSPACE_SENSITIVE_PATH` matched `.husky/pre-merge-commit` and let
   * `.githooks/`, `githooks/`, `hooks/` and `tools/hooks/` through, while its own comment said it
   * blocked "git/husky/claude hooks". Git is the only thing that knows, so git is asked, in the
   * environment a promotion would use — `minimalGitEnvironment` pins `core.hooksPath=/dev/null` and
   * would answer with this product's own guard instead of the repository's configuration.
   *
   * A THROW is a real answer here and callers are expected to treat it as one: not knowing where the
   * auto-executed directory is means not being able to say a write is outside it.
   */
  async hookDirectoryPositions(workspaceInput: string): Promise<string[]> {
    const workspace = await canonicalWorkspace(workspaceInput);
    return workingTreePositions(
      workspace, await this.#gitPath(workspace, "hooks", promotionGitEnvironment()),
    );
  }

  /**
   * Attributes files this repository is KNOWN to consult, as absolute paths. Deliberately not
   * claimed to be every one of them — see `#attributesBlockers`, which is where the completeness
   * of the gate actually comes from.
   *
   * Measured, not assumed: `git ls-files -- '*.gitattributes'` really does match nested files (the
   * default pathspec glob crosses `/`), and a root-only read reports `sub/deep/.gitattributes
   * filter=lfs` as no filter at all. Ignored copies are included because an ignored file is invisible
   * to `git status` and therefore invisible to the emptiness gate; untracked non-ignored ones are
   * already refused by `MAIN_STATUS_NOT_EMPTY` before this matters.
   *
   * `core.attributesFile` is read from the repository's own config, which is writable by any linked
   * worktree sharing this common `.git` — the same surface the hook binding exists for. Its
   * expansion is git's, asked of git; see `#configuredPath` for what that replaced and why.
   */
  async #attributesFiles(workspace: string, ignoredPaths: readonly string[]): Promise<string[]> {
    const found = new Set<string>();
    for (const path of await this.#paths(workspace, ["ls-files", "-z", "--", "*.gitattributes"])) {
      found.add(join(workspace, path));
    }
    for (const path of ignoredPaths) {
      if (path === ".gitattributes" || path.endsWith("/.gitattributes")) found.add(join(workspace, path));
    }
    // `--git-path info` answers the git directory's `info/`, honouring linked worktrees.
    found.add(join(await this.#gitPath(workspace, "info"), "attributes"));
    const configured = await this.#configuredPath(workspace, "core.attributesFile");
    if (configured !== null) {
      found.add(isAbsolute(configured) ? configured : join(workspace, configured));
    }
    return [...found].sort();
  }

  /**
   * One path-typed configuration value, expanded by git, or `null` when git says it is not set.
   *
   * Amendment (W-1), applied to the sibling of the key that broke: `core.attributesFile` was read
   * with a plain `--get` and expanded by hand. The hand-written expansion covered `~` — because a
   * previous round was caught by exactly that — and did not cover `%(prefix)/`, which git also
   * expands in a path-typed value (measured: `%(prefix)/attrs` reads back as a path under git's own
   * exec prefix). `--path` is git doing all of it, including the `~user/` lookup this process
   * cannot do.
   *
   * The three exits are distinguished rather than collapsed, which is the half the previous code got
   * wrong in a different way: it ended in `.catch(() => "")`, so a value git REFUSED to expand
   * turned the enumeration half of the filter gate silently empty. Exit 1 is git answering that the
   * key is unset; anything else throws, and `#attributesBlockers` turns that into
   * `MAIN_ATTRIBUTES_UNREADABLE`.
   */
  async #configuredPath(workspace: string, key: string): Promise<string | null> {
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["config", "--get", "--path", "--", key],
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 8_192,
      env: minimalGitEnvironment(),
    });
    if (result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw new Error("GIT_COMMAND_FAILED");
    const value = result.stdout.trim();
    return value === "" ? null : value;
  }

  /**
   * Asks git itself whether a filter would apply to any of a bounded set of path names.
   *
   * This is the half of the gate that does not depend on knowing where attributes live. It runs
   * under `promotionGitEnvironment()` — the exact environment the merge will run under — because the
   * answer depends on it: `GIT_CONFIG_GLOBAL=/dev/null` suppresses the global config file but NOT
   * `$XDG_CONFIG_HOME/git/attributes`, which git reads whenever `core.attributesFile` is unset.
   *
   * A non-zero exit, a termination or a malformed stream throws, and the caller turns that into a
   * refusal. "I could not ask" is never "no filter".
   */
  async #attributesFilterDeclared(workspace: string, paths: readonly string[]): Promise<boolean> {
    const unique = [...new Set(paths)]
      .filter((path) => path.length > 0 && !path.includes("\0") && !path.startsWith("-"));
    if (unique.length === 0) return false;
    if (unique.length > MAX_ATTRIBUTES_PROBE_PATHS) throw new Error("GIT_ATTRIBUTES_PROBE_TOO_LARGE");
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let fields: string[] = [];
    let declared = false;
    let answers = 0;
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["check-attr", "-z", "--stdin", "filter"],
      cwd: workspace,
      stdin: `${unique.join("\0")}\0`,
      timeoutMs: 30_000,
      outputLimitBytes: 262_144,
      env: promotionGitEnvironment(),
      stdoutConsumer: (chunk) => {
        pending += decoder.write(chunk);
        for (;;) {
          const boundary = pending.indexOf("\0");
          if (boundary < 0) return;
          fields.push(pending.slice(0, boundary));
          pending = pending.slice(boundary + 1);
          if (fields.length < 3) continue;
          answers += 1;
          if (!ATTRIBUTES_NO_FILTER.has(fields[2] ?? "")) declared = true;
          fields = [];
        }
      },
    });
    if (result.exitCode !== 0 || result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
    pending += decoder.end();
    if (pending.length > 0 || fields.length > 0) throw new Error("INVALID_GIT_CHECK_ATTR_STREAM");
    // git answers once per path. Fewer answers than questions means the stream was cut short, which
    // would otherwise read as "none of the missing ones had a filter".
    if (answers !== unique.length) throw new Error("INVALID_GIT_CHECK_ATTR_STREAM");
    return declared;
  }

  /**
   * Whether a `filter=` would apply anywhere in this repository, or an explicit refusal when that
   * cannot be decided. Unread is never "no filter": this gate is the only thing standing between a
   * promotion and a clean/smudge round trip whose rollback this product cannot promise.
   *
   * Two independent halves, because each covers what the other cannot. Reading the attributes files
   * catches a pattern that matches no path present today — a rule for `*.psd` in a repository with
   * no `.psd` yet. Asking `git check-attr` catches attributes files this code does not know how to
   * find, which is not hypothetical: `core.attributesFile` spelled `~/attrs` and the XDG global
   * attributes file were both invisible to the enumeration and both visible to git.
   */
  async #attributesBlockers(
    workspace: string, ignoredPaths: readonly string[], trackedPaths: readonly string[],
  ): Promise<string[]> {
    try {
      if (await this.#attributesFilterDeclared(
        workspace, [...ATTRIBUTES_PROBE_PATHS, ...trackedPaths, ...ignoredPaths],
      )) return ["MAIN_ATTRIBUTES_DECLARE_FILTER"];
    } catch {
      return ["MAIN_ATTRIBUTES_UNREADABLE"];
    }
    let files: string[];
    try {
      files = await this.#attributesFiles(workspace, ignoredPaths);
    } catch {
      return ["MAIN_ATTRIBUTES_UNREADABLE"];
    }
    if (files.length > MAX_ATTRIBUTES_FILES) return ["MAIN_ATTRIBUTES_UNREADABLE"];
    for (const path of files) {
      let contents: string;
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        if (info.size > MAX_ATTRIBUTES_BYTES) return ["MAIN_ATTRIBUTES_UNREADABLE"];
        contents = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return ["MAIN_ATTRIBUTES_UNREADABLE"];
      }
      if (ATTRIBUTES_DECLARE_FILTER.test(contents)) return ["MAIN_ATTRIBUTES_DECLARE_FILTER"];
    }
    return [];
  }

  /**
   * Whether sparse checkout is on, asked in the one way that cannot be fooled by spelling.
   *
   * `core.sparseCheckout=1`, `=yes` and `=on` all mean true to git and all fail a `=== "true"`
   * comparison — measured. `--type=bool` normalises them; a value git itself rejects exits non-zero
   * and is treated as a closed gate rather than as "not enabled".
   */
  async #sparseCheckoutBlockers(workspace: string): Promise<string[]> {
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["config", "--type=bool", "--get", "core.sparseCheckout"],
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 4_096,
      env: minimalGitEnvironment(),
    });
    if (result.terminationReason) return ["MAIN_SPARSE_CHECKOUT_UNREADABLE"];
    // Exit 1 is git answering, successfully, that the key is not set at all.
    if (result.exitCode === 1) return [];
    if (result.exitCode !== 0) return ["MAIN_SPARSE_CHECKOUT_UNREADABLE"];
    return result.stdout.trim() === "true" ? ["MAIN_SPARSE_CHECKOUT_ENABLED"] : [];
  }

  /**
   * Everything about a working tree that a promotion must be able to put back exactly as it found it,
   * plus every reason it may not receive a merge at all.
   *
   * "Clean" is defined here and nowhere else, because the obvious definition is measurably wrong:
   * `git update-index --skip-worktree` leaves `git status --porcelain` completely empty while a real
   * merge aborts with exit 2, and does so identically on every retry — a state in which "recover the
   * environment and it succeeds" can never become true. So the gate is a list of named conditions,
   * each of which is a refusal before anything is spent.
   */
  async restorePoint(workspaceInput: string): Promise<GitRestorePoint> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const inspection = await this.inspect(workspace);
    const deadline = Date.now() + CONTENT_FINGERPRINT_TIMEOUT_MS;
    const [head, stash, reflog, indexFlags, indexStage] = await Promise.all([
      this.headSha(workspace),
      this.#git(workspace, ["stash", "list", "--format=%H"], 262_144),
      this.#git(workspace, ["reflog", "show", "--format=%H %gs", "HEAD"], 1_048_576),
      this.#git(workspace, ["ls-files", "-v"], 8_388_608),
      this.#git(workspace, ["ls-files", "--stage", "-z"], 4_194_304),
    ]);
    const untracked = await this.#pathContentFingerprint(
      workspace, ["ls-files", "--others", "--exclude-standard", "-z"], deadline, "untracked",
    );
    const ignored = await this.#pathContentFingerprint(
      workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], deadline, "ignored",
    );
    const hooks = await this.hookEnvironment(workspace);
    const blockers: string[] = [];
    // Equivalent to `git status --porcelain` being non-empty, derived from the streamed inspection
    // rather than from a second captured command: on a repository with tens of thousands of
    // untracked files the captured form blows its output ceiling and turns a gate into an outage.
    if (!inspection.clean || inspection.untrackedFiles > 0) blockers.push("MAIN_STATUS_NOT_EMPTY");
    // `ls-files -v` marks skip-worktree with `S` and assume-unchanged with a lowercase tag. Both make
    // `status` lie about the working tree, and both make a real merge fail the same way every time.
    if (indexFlags.split("\n").some((line) => /^(?:S|[a-z]) /u.test(line))) {
      blockers.push("MAIN_INDEX_HAS_SKIPPED_ENTRIES");
    }
    for (const [name, code] of PROMOTION_STATE_FILES) {
      if (await this.#present(await this.#gitPath(workspace, name))) blockers.push(code);
    }
    blockers.push(...await this.#sparseCheckoutBlockers(workspace));
    // A submodule is a `160000` entry in the INDEX. `.gitmodules` is a tracked description of one and
    // can be absent while the gitlink is present — measured with `update-index --cacheinfo 160000`,
    // which produces exactly that shape and passed a `.gitmodules`-only gate. Both are refused.
    if (indexStage.split("\0").some((entry) => entry.startsWith(`${GITLINK_MODE} `))) {
      blockers.push("MAIN_HAS_SUBMODULES");
    } else if (await this.#present(join(workspace, ".gitmodules"))) blockers.push("MAIN_HAS_SUBMODULES");
    if (hooks.filters.length > 0) blockers.push("MAIN_HAS_CONTENT_FILTERS");
    if (hooks.unreadable) blockers.push("MAIN_HOOK_DIRECTORY_UNREADABLE");
    // The same index listing the gitlink gate reads, reused for the paths git is asked about: every
    // tracked path, so a filter declared for something this repository actually contains is found
    // whatever spelling put it there.
    const trackedPaths = indexStage.split("\0").filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf("\t") + 1))
      .filter((path) => path.length > 0);
    blockers.push(...await this.#attributesBlockers(workspace, ignored.paths, trackedPaths));
    const reflogEntries = reflog.split("\n").filter(Boolean);
    return {
      head,
      inspection,
      ignoredPaths: ignored.paths.slice(0, MAX_REPORTED_IGNORED_PATHS),
      blockers,
      clean: blockers.length === 0,
      untrackedFiles: untracked.files,
      ignoredFiles: ignored.files,
      worktreeFingerprint: inspection.fingerprint,
      // The index itself — mode, object id, stage and path for every entry. Deliberately NOT
      // `git write-tree`, which would be a write: it can create objects and take `index.lock`, and
      // this fingerprint has to be readable during a strictly read-only crash reconciliation. The
      // same listing is what the gitlink gate above reads, so both see one index, read once.
      indexFingerprint: createHash("sha256").update(indexStage, "utf8").digest("hex"),
      untrackedFingerprint: untracked.fingerprint,
      ignoredFingerprint: ignored.fingerprint,
      stashDigest: createHash("sha256").update(stash, "utf8").digest("hex"),
      stashEntries: stash.split("\n").filter(Boolean).length,
      reflogEntries: reflogEntries.length,
      // The whole log, not a count: an append-only log that grew by one is intact, while one whose
      // older entries were rewritten has lost the recovery path even if the count happens to match.
      reflogDigest: createHash("sha256").update(reflogEntries.join("\n"), "utf8").digest("hex"),
      hooks,
    };
  }

  /**
   * Names every aspect in which main now differs from a recorded restore point.
   *
   * This is what a crashed promotion reports instead of acting. It runs no writing Git command at
   * all: after a `kill -9` during a hook the index and working tree can be fully rewritten while
   * HEAD has not moved and no `MERGE_HEAD` exists, which is bit-for-bit indistinguishable from work
   * the owner staged themselves — so the only safe response is to say exactly what moved and let the
   * owner decide.
   */
  async differencesFrom(workspaceInput: string, point: GitRestorePoint): Promise<string[]> {
    const now = await this.restorePoint(workspaceInput);
    const differences: string[] = [];
    const compare = (label: string, before: unknown, after: unknown): void => {
      if (before !== after) differences.push(label);
    };
    compare("HEAD", point.head, now.head);
    compare("index", point.indexFingerprint, now.indexFingerprint);
    compare("trackedWorkingTree", point.worktreeFingerprint, now.worktreeFingerprint);
    compare("untrackedFiles", point.untrackedFingerprint, now.untrackedFingerprint);
    compare("ignoredFiles", point.ignoredFingerprint, now.ignoredFingerprint);
    compare("stash", point.stashDigest, now.stashDigest);
    compare("hookEnvironment", point.hooks.fingerprint, now.hooks.fingerprint);
    if (!await this.reflogPreserves(workspaceInput, point.reflogEntries, point.reflogDigest)) {
      differences.push("reflog");
    }
    for (const [name, code] of PROMOTION_STATE_FILES) {
      if (await this.#present(await this.#gitPath(await canonicalWorkspace(workspaceInput), name))) {
        differences.push(`leftover:${code}`);
      }
    }
    return differences;
  }

  /**
   * Whether every reflog entry recorded before an attempt is still present, unmodified, in order.
   *
   * A reflog is append-only, so an attempt that was undone still leaves its own entries behind and
   * exact equality is unachievable — measured, not assumed: an aborted merge adds exactly one HEAD
   * entry. What CAN be required is that nothing was removed or rewritten, which is what makes the
   * pre-promotion commit still reachable and therefore what the owner's recovery path depends on.
   * `git reflog show` prints newest first, so the recorded entries are the tail. The format is the
   * commit and the reflog SUBJECT, deliberately not the selector: `HEAD@{0}` renumbers every time an
   * entry is appended, so a selector-based digest reports an intact log as rewritten.
   */
  async reflogPreserves(workspaceInput: string, entries: number, digest: string): Promise<boolean> {
    if (!Number.isSafeInteger(entries) || entries < 0) throw new Error("INVALID_REFLOG_BASELINE");
    const workspace = await canonicalWorkspace(workspaceInput);
    const current = (await this.#git(workspace, ["reflog", "show", "--format=%H %gs", "HEAD"], 1_048_576))
      .split("\n").filter(Boolean);
    if (current.length < entries) return false;
    const tail = current.slice(current.length - entries);
    return createHash("sha256").update(tail.join("\n"), "utf8").digest("hex") === digest;
  }

  /** Whether this working tree is sitting in the middle of a merge git could not finish. */
  async mergeInProgress(workspaceInput: string): Promise<boolean> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 16_384,
      env: minimalGitEnvironment(),
    });
    if (result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error("GIT_COMMAND_FAILED");
  }

  /** The parent commits of one commit, used to prove a merge commit is the one that was authorized. */
  async commitParents(workspaceInput: string, commit: string): Promise<string[]> {
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("INVALID_GIT_HEAD");
    const workspace = await canonicalWorkspace(workspaceInput);
    const value = await this.#git(workspace, ["rev-list", "--parents", "-n", "1", commit], 16_384);
    const parts = value.trim().split(" ");
    if (parts.length < 1 || parts.some((part) => !/^[0-9a-f]{40,64}$/u.test(part))) {
      throw new Error("GIT_COMMAND_FAILED");
    }
    return parts.slice(1);
  }

  /**
   * Paths that already exist in this working tree without being tracked, restricted to a bounded
   * pathspec. Ignored and merely-untracked are reported separately because git treats them
   * differently and only one of them is silent: a merge REFUSES to clobber an untracked file, and
   * SILENTLY overwrites an ignored one.
   */
  async untrackedAtPaths(workspaceInput: string, paths: readonly string[]): Promise<{
    ignored: string[];
    untracked: string[];
  }> {
    if (paths.length === 0) return { ignored: [], untracked: [] };
    if (paths.length > MAX_OVERWRITE_PATHSPEC) throw new Error("OVERWRITE_PATHSPEC_TOO_LARGE");
    if (paths.some((path) => path.length === 0 || path.includes("\0") || path.startsWith("-"))) {
      throw new Error("INVALID_GIT_PATHSPEC");
    }
    const workspace = await canonicalWorkspace(workspaceInput);
    const scan = async (extra: string[]): Promise<string[]> => {
      const output = await this.#paths(workspace, [
        "ls-files", "--others", "--exclude-standard", "-z", ...extra, "--", ...paths,
      ]);
      return [...new Set(output)].sort();
    };
    return { ignored: await scan(["--ignored"]), untracked: await scan([]) };
  }

  /**
   * The one command in this product that writes to canonical main.
   *
   * `--no-ff` always, so the promotion is a single revertable commit with the pre-promotion head as
   * its first parent even when a fast-forward was possible; `--no-edit` so no editor is ever spawned;
   * and repository hooks deliberately enabled (see `promotionGitEnvironment`). Output is discarded
   * rather than returned: it is untrusted repository text, and the caller decides what happened by
   * observing the repository afterwards, never by reading git's prose.
   */
  async mergeIntoHead(
    workspaceInput: string, commit: string, timeoutMs = MERGE_TIMEOUT_MS,
    onSpawn?: (processGroupId: number) => void,
    /**
     * Absolute path git writes its trace event stream to, so the hooks it runs and their exit codes
     * can be READ back afterwards. It must be outside the repository: a file written inside main
     * would itself become an untracked file and change the very fingerprints this promotion compares.
     */
    traceEventFile?: string,
  ): Promise<{
    exitCode: number;
    timedOut: boolean;
    /** True when `onSpawn` threw, i.e. this merge ran with its process group recorded nowhere. */
    spawnRecordFailed: boolean;
  }> {
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("INVALID_GIT_HEAD");
    const workspace = await canonicalWorkspace(workspaceInput);
    if (traceEventFile !== undefined && !isAbsolute(traceEventFile)) {
      throw new Error("INVALID_GIT_TRACE_PATH");
    }
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["merge", "--no-ff", "--no-edit", commit],
      cwd: workspace,
      timeoutMs,
      outputLimitBytes: 262_144,
      env: {
        ...promotionGitEnvironment(),
        ...(traceEventFile === undefined ? {} : { GIT_TRACE2_EVENT: traceEventFile }),
      },
      ...(onSpawn === undefined ? {} : { onSpawn }),
    });
    return {
      exitCode: result.exitCode,
      timedOut: result.terminationReason === "timeout",
      spawnRecordFailed: result.spawnRecordFailed === true,
    };
  }

  /** Undoes a merge git left in progress. Hooks stay disabled: aborting is not the owner's merge. */
  async abortMerge(workspaceInput: string): Promise<boolean> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["merge", "--abort"],
      cwd: workspace,
      timeoutMs: 120_000,
      outputLimitBytes: 65_536,
      env: minimalGitEnvironment(),
    });
    return result.exitCode === 0 && !result.terminationReason;
  }

  async #untrackedContext(workspace: string, outputLimitBytes: number): Promise<string> {
    const paths = await this.#paths(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const sections: string[] = [];
    let bytes = 0;
    for (const path of paths) {
      if (SENSITIVE_UNTRACKED_PATH.test(path)) throw new Error("SENSITIVE_UNTRACKED_PATH_DENIED");
      const file = await this.#existingFile(workspace, path);
      if (!file) continue;
      if (file.size > MAX_UNTRACKED_REVIEW_FILE_BYTES) {
        throw new Error("UNTRACKED_REVIEW_FILE_TOO_LARGE");
      }
      const content = await readFile(file.absolute);
      const section = content.includes(0)
        ? `Untracked binary file: ${path} (${file.size} bytes; content omitted)`
        : `Untracked text file: ${path}\n${content.toString("utf8")}`;
      bytes += Buffer.byteLength(section);
      if (bytes > outputLimitBytes) throw new Error("UNTRACKED_REVIEW_CONTEXT_TOO_LARGE");
      sections.push(section);
    }
    return sections.length > 0 ? sections.join("\n\n---\n\n") : "no untracked files";
  }

  async reviewContext(workspaceInput: string, outputLimitBytes = 524_288): Promise<string> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const inspection = await this.inspect(workspace);
    const diff = await this.#git(
      workspace,
      ["diff", "HEAD", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"],
      Math.max(65_536, Math.floor(outputLimitBytes * 0.7)),
    );
    const untracked = await this.#untrackedContext(
      workspace,
      Math.max(32_768, Math.floor(outputLimitBytes * 0.3)),
    );
    return [
      "Git status (untrusted repository data):",
      inspection.statusSummary || "clean",
      "Tracked diff (untrusted repository data):",
      diff || "no tracked diff",
      "Bounded untracked file context (untrusted repository data):",
      untracked,
    ].join("\n\n");
  }
}
