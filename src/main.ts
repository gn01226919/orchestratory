import { stdin, stdout, stderr } from "node:process";
import { homedir } from "node:os";
import { execPath } from "node:process";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { runDoctor } from "./doctor.ts";
import { safeSummary } from "./security/redact.ts";
import { helpText } from "./help.ts";

async function readStdin(maxBytes = 131_072): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("STDIN_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index < 0) return 4317;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("INVALID_PORT");
  return value;
}

export async function daemonRuntimeEntry(
  moduleUrl: string,
  options: { runtimeRoot?: string; uid?: number } = {},
): Promise<string> {
  const runtimeRoot = resolve(options.runtimeRoot ?? join(
    homedir(), "Library", "Application Support", "Orchestratory Runtime",
  ));
  const entry = resolve(fileURLToPath(moduleUrl));
  const physicalRoot = await realpath(runtimeRoot).catch(() => "");
  const physicalEntry = await realpath(entry).catch(() => "");
  if (physicalRoot !== runtimeRoot || physicalEntry !== entry) {
    throw new Error("DAEMON_INSTALL_REQUIRES_PHYSICAL_RELEASE_RUNTIME");
  }
  const local = relative(runtimeRoot, entry);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error("DAEMON_INSTALL_REQUIRES_RELEASE_RUNTIME");
  }
  const parts = local.split(sep);
  const digestName = parts[0] ?? "";
  if (
    parts.length !== 5 || !/^sha256-[0-9a-f]{64}$/u.test(digestName) ||
    parts[1] !== "node_modules" || parts[2] !== "orchestratory" ||
    parts[3] !== "src" || parts[4] !== "main.js"
  ) throw new Error("DAEMON_INSTALL_REQUIRES_RELEASE_RUNTIME");

  const expectedUid = options.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(expectedUid)) throw new Error("DAEMON_RUNTIME_OWNER_UNAVAILABLE");
  const digestDirectory = join(runtimeRoot, digestName);
  const packageRoot = join(digestDirectory, "node_modules", "orchestratory");
  const paths = [
    { path: runtimeRoot, directory: true },
    { path: digestDirectory, directory: true },
    { path: join(digestDirectory, "node_modules"), directory: true },
    { path: packageRoot, directory: true },
    { path: join(packageRoot, "src"), directory: true },
    { path: join(packageRoot, "public"), directory: true },
    { path: entry, directory: false },
    { path: join(packageRoot, "public", "room.js"), directory: false },
    { path: join(packageRoot, "public", "room.html"), directory: false },
    { path: join(packageRoot, "runtime-manifest.json"), directory: false, maxBytes: 256 * 1_024 },
    { path: join(digestDirectory, "runtime-install.json"), directory: false, maxBytes: 4_096 },
  ];
  for (const item of paths) {
    const info = await lstat(item.path).catch(() => undefined);
    if (
      !info || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o022) !== 0 ||
      (item.directory ? !info.isDirectory() : !info.isFile())
    ) throw new Error("DAEMON_RUNTIME_PATH_UNSAFE");
    if (!item.directory && item.maxBytes !== undefined && (info.size < 1 || info.size > item.maxBytes)) {
      throw new Error("DAEMON_RUNTIME_MANIFEST_INVALID");
    }
  }
  const source = JSON.parse(await readFile(join(packageRoot, "runtime-manifest.json"), "utf8")) as unknown;
  const installed = JSON.parse(await readFile(join(digestDirectory, "runtime-install.json"), "utf8")) as unknown;
  const validSource = source && typeof source === "object" &&
    (source as { formatVersion?: unknown }).formatVersion === 1 &&
    typeof (source as { sourceCommit?: unknown }).sourceCommit === "string" &&
    /^[0-9a-f]{40}$/u.test((source as { sourceCommit: string }).sourceCommit) &&
    Array.isArray((source as { files?: unknown }).files);
  const validInstall = installed && typeof installed === "object" &&
    (installed as { formatVersion?: unknown }).formatVersion === 1 &&
    (installed as { artifactSha256?: unknown }).artifactSha256 === digestName.slice("sha256-".length) &&
    (installed as { sourceCommit?: unknown }).sourceCommit ===
      (source as { sourceCommit?: unknown }).sourceCommit;
  if (!validSource || !validInstall) throw new Error("DAEMON_RUNTIME_MANIFEST_INVALID");

  type RuntimeFile = { path: string; sha256: string; size: number };
  const declared = (source as { files: RuntimeFile[] }).files;
  if (declared.length < 1 || declared.length > 1_000) throw new Error("DAEMON_RUNTIME_MANIFEST_INVALID");
  const expectedPaths = new Set<string>();
  let totalBytes = 0;
  for (const file of declared) {
    if (
      !file || typeof file.path !== "string" || file.path === "runtime-manifest.json" ||
      file.path.startsWith("/") || file.path.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.size) ||
      file.size < 0 || file.size > 16 * 1024 * 1024 || expectedPaths.has(file.path)
    ) throw new Error("DAEMON_RUNTIME_MANIFEST_INVALID");
    expectedPaths.add(file.path);
    totalBytes += file.size;
    if (totalBytes > 32 * 1024 * 1024) throw new Error("DAEMON_RUNTIME_MANIFEST_INVALID");
    const path = resolve(packageRoot, file.path);
    const localPath = relative(packageRoot, path);
    if (!localPath || localPath === ".." || localPath.startsWith(`..${sep}`)) {
      throw new Error("DAEMON_RUNTIME_MANIFEST_INVALID");
    }
    const info = await lstat(path).catch(() => undefined);
    if (
      !info?.isFile() || info.isSymbolicLink() || info.uid !== expectedUid || info.nlink !== 1 ||
      (info.mode & 0o022) !== 0 || info.size !== file.size
    ) throw new Error("DAEMON_RUNTIME_INVENTORY_MISMATCH");
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== file.sha256) throw new Error("DAEMON_RUNTIME_INVENTORY_MISMATCH");
  }
  const observed: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      const localPath = relative(packageRoot, path).split(sep).join("/");
      if (item.isSymbolicLink()) throw new Error("DAEMON_RUNTIME_PATH_UNSAFE");
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && localPath !== "runtime-manifest.json") observed.push(localPath);
      else if (!item.isFile()) throw new Error("DAEMON_RUNTIME_PATH_UNSAFE");
    }
  };
  await walk(packageRoot);
  if (observed.length !== expectedPaths.size || observed.some((path) => !expectedPaths.has(path))) {
    throw new Error("DAEMON_RUNTIME_INVENTORY_MISMATCH");
  }
  return entry;
}

/**
 * Renders the orphan recovery-ref report `orchestrator candidates orphan-refs` prints.
 *
 * Pure and read-only on purpose. A recovery ref is the only thing standing between an owner and a
 * candidate that cannot be rebuilt, so this command exists to make accumulated refs VISIBLE and
 * deliberately offers no way to remove one: deleting refs from the owner's canonical repository is a
 * destructive Git action, and the project's deletion rule routes those through a staged,
 * human-confirmed path rather than a CLI flag.
 *
 * Nothing outside the ref namespace is echoed. Ref names and object ids are the only repository
 * content that reaches the output; the workspace path is the canonicalised one the caller supplied
 * and had allowlisted, and no candidate row's stored paths, task text or actor names are read.
 */
export function describeOrphanRecoveryRefs(input: {
  mainPath: string;
  orphans: ReadonlyArray<{ ref: string; head: string }>;
  /** The scan's own upper bound; reaching it means "there may be more", never "there are this many". */
  limit: number;
  /** Status of the candidate task named by a ref, when one is still on record. */
  taskStatus: (taskId: string) => string | undefined;
}): string {
  const namespace = "refs/orchestratory/checkpoints";
  const lines: string[] = [];
  if (input.orphans.length === 0) {
    return `No orphan recovery refs under ${namespace} in ${input.mainPath}.\n`;
  }
  const truncated = input.orphans.length >= input.limit;
  lines.push(
    `Orphan recovery refs under ${namespace} in ${input.mainPath}: ${input.orphans.length}`
      + (truncated ? ` (scan limit ${input.limit} reached — more may exist)` : ""),
  );
  lines.push("An orphan is a checkpoint ref with no owning checkpoint row in the candidate ledger,");
  lines.push("so nothing in the product will ever consume or update it again.");
  lines.push("Listed only. Removing a recovery ref is a destructive Git action and is not offered here.");
  for (const orphan of input.orphans) {
    const parts = orphan.ref.split("/");
    const taskId = parts[parts.length - 2] ?? "";
    const checkpointId = parts[parts.length - 1] ?? "";
    const status = input.taskStatus(taskId);
    lines.push("");
    lines.push(orphan.ref);
    lines.push(`  commit      ${orphan.head}`);
    lines.push(`  task        ${taskId} (${status === undefined ? "no candidate row on record" : `candidate status: ${status}`})`);
    lines.push(`  checkpoint  ${checkpointId} (no checkpoint row on record)`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The three release actions and the listing, as the CLI sees them.
 *
 * The listing is NOT read-only: it re-observes every unsettled record and updates it. That is the
 * convergence bar item 13 requires, and calling it "read-only" here was the same untrue adjective
 * the command's own header used to print ([[PITFALLS]] #116).
 *
 * Narrower than `CandidateRegistry` on purpose: this command may observe promotions and stop a
 * record from waiting, and it must not be able to reach `promoteMainMerge` — writing to main stays
 * deliberately unexposed on the product side, and a port that cannot name it cannot be talked into
 * calling it.
 */
export interface PromotionReleasePort {
  promotions(input: { roomId: string; mainPath: string }): Promise<ReadonlyArray<
    import("./core/candidate-registry.ts").MergePromotion
    | import("./core/candidate-registry.ts").UnreadableMergePromotion
  >>;
  abandonMergeProcessGroup(input: {
    promotionId: string; roomId: string; mainPath: string; pgid: number;
    confirmation: string; decidedBy: string;
  }): Promise<unknown>;
  abandonPromotionOwnerProcess(input: {
    promotionId: string; roomId: string; mainPath: string; pid: number;
    confirmation: string; decidedBy: string;
  }): Promise<unknown>;
  abandonPromotionEntirely(input: {
    promotionId: string; roomId: string; mainPath: string; pid: number; pgid: number;
    confirmation: string; decidedBy: string;
  }): Promise<unknown>;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name.slice(2).toUpperCase()}_VALUE_REQUIRED`);
  return value;
}

/**
 * A pid supplied on the command line, or `NaN` when the flag was not given at all.
 *
 * `NaN` rather than a placeholder integer because "not supplied" has to be distinguishable from
 * every real number: the registry refuses any release whose pid does not match the one on the
 * record, and a missing flag must land on that refusal rather than on a number that could
 * accidentally be right.
 */
function optionalPid(args: readonly string[], name: string): number {
  const raw = flagValue(args, name);
  if (raw === undefined) return Number.NaN;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("CANDIDATE_PROMOTION_PID_INVALID");
  return value;
}

/**
 * Renders what each promotion in this project is waiting on, and what would release it.
 *
 * This function is pure. The CALL that produced its input is not, and saying otherwise was a
 * measured falsehood: `registry.promotions()` re-observes every unsettled record, which is how a
 * promotion converges after a crash, and converging one WRITES — the authoritative row moves from
 * `applying` to a settled state, the audit chain gains an entry and the room ledger gains a line.
 * The review that found this measured it against `orphan-refs` as a control: that command left the
 * row, the audit count and all three SQLite digests untouched, and this one changed every one of
 * them. The half re-measured here is the writing itself, in `test/merge-promotion.test.ts`. The
 * writing is bar item 13 working as specified; the word "read-only" on top of it was the defect.
 *
 * Everything printed is re-derived on that read — the pids, the phrase and the inspect commands are
 * statements about processes alive at that moment, not stored verdicts — so the report is safe to be
 * wrong about the future and useless as a cached answer.
 *
 * No repository content is echoed: ids, states, pids and read-only `ps` commands only. Nothing here
 * writes to main, and the commands it prints cannot either.
 */
export function describePromotions(input: {
  mainPath: string;
  promotions: ReadonlyArray<
    import("./core/candidate-registry.ts").MergePromotion
    | import("./core/candidate-registry.ts").UnreadableMergePromotion
  >;
}): string {
  if (input.promotions.length === 0) {
    return `No promotion records for ${input.mainPath}.\n`;
  }
  const lines = [`Promotion records for ${input.mainPath}: ${input.promotions.length}`];
  lines.push("Listing re-observes each unsettled record and updates it; nothing here writes to main.");
  lines.push("Releasing a record stops it waiting; it never kills a process either.");
  for (const promotion of input.promotions) {
    lines.push("");
    lines.push(promotion.id);
    lines.push(`  task        ${promotion.taskId}`);
    if (promotion.state === "unreadable") {
      // An unreadable row is reported as unreadable and never repaired, but the two facts an owner
      // needs are still derivable from columns a failed hash does not make unreadable.
      lines.push("  state       unreadable (this row's integrity check fails; nothing here repairs it)");
      lines.push(`  stored      ${promotion.storedState ?? "unknown"}`);
      lines.push(`  exclusive   ${promotion.holdsProjectExclusiveMarker
        ? "held — every other task in this project is refused while it is"
        : "not held"}`);
      if (promotion.releasedFromExclusiveMarker) {
        lines.push(`  released    ${promotion.releasedFromExclusiveMarker.at}`
          + ` by ${promotion.releasedFromExclusiveMarker.decidedBy}`);
      }
      if (promotion.release) {
        // An empty list has two very different meanings, and the owner is the one deciding whether
        // to release a marker over a merge that may be writing. Printing nothing for the second one
        // would show them the same screen for "nothing is running" and "nobody could find out".
        if (promotion.release.probeReadable === false) {
          lines.push("  alive       UNKNOWN — this record's merge group could not be read at all;"
            + " that is not the same as nothing running");
        }
        // Every number the record names, including the ones that probed dead. When two sources
        // disagree the owner is shown BOTH, because "this code preferred the column" is not a fact
        // about their machine — it was the preference that released a marker over a live merge.
        for (const recorded of promotion.release.recordedGroups ?? []) {
          lines.push(`  recorded    ${recorded.source} says pgid ${recorded.pgid}`
            + ` (boot ${recorded.bootAtSec === null ? "not recorded" : recorded.bootAtSec})`);
        }
        if ((promotion.release.recordedGroups ?? []).length > 1) {
          lines.push("  recorded    the sources above do not agree; none of them can be ruled out");
        }
        for (const alive of promotion.release.alive) {
          lines.push(`  alive       ${alive.kind} pid ${alive.pid}`);
          lines.push(`              ${alive.inspect}`);
        }
        lines.push(`  release     --confirm ${JSON.stringify(promotion.release.confirmation)}`
          + (promotion.release.alive.some((entry) => entry.kind === "merge")
            ? ` --pgid ${promotion.release.alive.find((entry) => entry.kind === "merge")?.pid}`
            : ""));
      }
      continue;
    }
    lines.push(`  state       ${promotion.state}`);
    lines.push(`  main HEAD   ${promotion.mainHeadBefore.slice(0, 12)} before`
      + `, ${promotion.mainHeadAfter ? `${promotion.mainHeadAfter.slice(0, 12)} now` : "not read"}`);
    const pending = promotion.pending;
    if (pending === undefined) {
      // A statement about the RECORD, not about the repository. The previous wording — "this record
      // is not blocked on any process" — was a factual assertion about the owner's machine, and it
      // was measured false: `ps -g` listed the `git merge`, its hook and its `sleep` while this line
      // was printed, because the record had lost the number (amendment (L), [[PITFALLS]] #86).
      // Nothing here can promise what is running; it can only say what this record still names.
      lines.push("  waiting     no process this record names is still being waited on");
    } else if (pending.code === "MERGE_IDENTITY_UNACCOUNTED") {
      // Amendment (O). The one reason that names no pid, printed as the state it is rather than as
      // `pid undefined`. What replaces the number is the read-only SEARCH the record hands over —
      // every merge this product starts carries the candidate head on its command line — and the
      // phrase that ends the wait once the owner has looked.
      lines.push(`  waiting     ${pending.code} (no source names a process for this merge)`);
      lines.push(`              ${pending.inspect}`);
      lines.push(`  release     --confirm ${JSON.stringify(pending.release)}`);
    } else {
      lines.push(`  waiting     ${pending.code} (pid ${pending.pid})`);
      lines.push(`              ${pending.inspect}`);
      for (const also of pending.alsoBlockedBy === undefined ? [] : [pending.alsoBlockedBy]) {
        lines.push(`  and on      pid ${also.pid}`);
        lines.push(`              ${also.inspect}`);
      }
      lines.push(`  release     --confirm ${JSON.stringify(pending.release)}`
        + (pending.code === "OWNER_PROCESS_STILL_RUNNING" ? ` --pid ${pending.pid}`
          : pending.alsoBlockedBy === undefined ? ` --pgid ${pending.pid}`
            : ` --pid ${pending.pid} --pgid ${pending.alsoBlockedBy.pid}`));
    }
    if (promotion.observation.mergeIdentityUnrecorded === true) {
      // Attributed, not asserted. The previous wording — "the write that was carrying this merge's
      // process group FAILED" — was a statement about what happened on the owner's machine, derived
      // from the EXISTENCE of a file in a directory the merge's own hooks can name: `GIT_TRACE2_EVENT`
      // is handed to every hook, and the marker sits beside it. A hook writing that file made this
      // product print a sentence about its own internals that was simply untrue (amendment (Q),
      // [[PITFALLS]] #120). What is true either way is that something claimed it, and that this
      // record therefore cannot account for its merge on its own.
      lines.push("  recorded    a marker beside this promotion's trace says the write that would have"
        + " carried its process group did not happen; nothing here can verify who wrote that marker");
    }
    for (const difference of promotion.observation.differences ?? []) {
      lines.push(`  differs     ${difference}`);
    }
    if (promotion.observation.recovery !== undefined) {
      lines.push(`  recovery    (${promotion.observation.recoveryKind ?? "unnamed"}) ${promotion.observation.recovery}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * `orchestrator candidates promotions <workspace> [release …]`.
 *
 * Bar item 11 requires that any state occupying a task's one open question have a product-side path
 * to release it, and until now the three releases and the listing had no CLI, HTTP, MCP or GUI
 * caller at all: the only way to reach them was for the owner to write a Node script against a
 * private SQLite file. A script the owner has to write is not a product-side path.
 *
 * Listing and releasing are separate verbs, and the release verb needs both the exact numbers the
 * record reports and the exact phrase, which is the same evidence-of-reading the registry demands
 * of every other caller. The workspace goes through the allowlist before this is reached, exactly as
 * `orphan-refs` does.
 */
export async function runCandidatePromotionsCommand(input: {
  args: readonly string[];
  roomId: string;
  mainPath: string;
  registry: PromotionReleasePort;
  decidedBy: string;
}): Promise<string> {
  const { args, roomId, mainPath, registry } = input;
  if (args.length === 0) {
    return describePromotions({
      mainPath, promotions: await registry.promotions({ roomId, mainPath }),
    });
  }
  if (args[0] !== "release") throw new Error("CANDIDATE_PROMOTIONS_UNKNOWN_SUBCOMMAND");
  const promotionId = args[1];
  if (!promotionId || promotionId.startsWith("--")) throw new Error("CANDIDATE_PROMOTION_ID_REQUIRED");
  const confirmation = flagValue(args, "--confirm");
  if (confirmation === undefined) throw new Error("CANDIDATE_PROMOTION_RELEASE_CONFIRMATION_REQUIRED");
  const pid = optionalPid(args, "--pid");
  const pgid = optionalPid(args, "--pgid");
  const common = { promotionId, roomId, mainPath, confirmation, decidedBy: input.decidedBy };
  // Which release is meant is decided by which numbers the owner quoted, and those are exactly what
  // the listing prints for that record. A number the record does not report is refused by the
  // registry rather than corrected here.
  if (Number.isSafeInteger(pid) && Number.isSafeInteger(pgid)) {
    await registry.abandonPromotionEntirely({ ...common, pid, pgid });
  } else if (Number.isSafeInteger(pid)) {
    await registry.abandonPromotionOwnerProcess({ ...common, pid });
  } else {
    // Including the case where neither was given: that reaches the unreadable-row release, which is
    // the one state with no number on the record to quote. A readable row refuses it by name.
    await registry.abandonMergeProcessGroup({ ...common, pgid });
  }
  return `${describePromotions({
    mainPath, promotions: await registry.promotions({ roomId, mainPath }),
  })}Released as ${input.decidedBy}. Nothing was killed and main was not written.\n`;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "hybrid";
  if (command === "--help" || command === "-h" || command === "help") {
    stdout.write(helpText());
    return;
  }
  if (command === "--version" || command === "-v") {
    stdout.write("0.1.0\n");
    return;
  }
  if (command === "doctor") {
    const items = await runDoctor();
    for (const item of items) stdout.write(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}\n`);
    if (items.some((item) => !item.ok)) process.exitCode = 1;
    return;
  }
  if (command === "audit") {
    const [{ runSecurityScan }, { runHistoryScan }] = await Promise.all([
      import("../scripts/security-scan.mjs"),
      import("../scripts/history-scan.mjs"),
    ]);
    const localPassed = await runSecurityScan();
    const historyPassed = await runHistoryScan();
    if (!localPassed || !historyPassed) throw new Error("SECURITY_AUDIT_FAILED");
    return;
  }

  const [{ createAppContext }, { runTui }, { startWebServer }, { parseWorkflowRequest }] =
    await Promise.all([
      import("./app.ts"),
      import("./ui/tui.ts"),
      import("./ui/web.ts"),
      import("./ui/request.ts"),
    ]);
  const app = await createAppContext();
  let nativePtyActive = false;
  const shutdown = (): void => {
    if (nativePtyActive) return;
    app.providerCalls.stopAll();
    for (const run of app.workflows.listActive()) app.workflows.cancel(run.id);
    if (command === "mcp") stdin.destroy();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    if (command === "mcp") {
      const { runCollabMcpServer } = await import("./mcp/collab-server.ts");
      const actorIndex = args.indexOf("--actor", 1);
      const actor = actorIndex >= 0 ? args[actorIndex + 1] : "mcp-host";
      if (!actor || actor === "you" || actor === "system" || !/^[a-z][a-z0-9-]{0,31}$/u.test(actor)) {
        throw new Error("INVALID_MCP_ACTOR");
      }
      await runCollabMcpServer(app, actor);
      return;
    }
    if (command === "web" || command === "gui") {
      const server = await startWebServer(app, parsePort(args.slice(1)));
      stdout.write(`Orchestratory GUI: ${server.url}\n請在瀏覽器開啟；按 Ctrl+C 關閉。\n`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await server.close();
      return;
    }
    if (command === "hybrid") {
      let server;
      try {
        server = await startWebServer(app, 4317);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("EADDRINUSE")) throw error;
        server = await startWebServer(app, 0);
      }
      try {
        await runTui(app, { guiUrl: server.url });
      } finally {
        await server.close();
      }
      return;
    }
    if (command === "run") {
      if (stdin.isTTY) throw new Error("RUN_REQUIRES_JSON_ON_STDIN");
      const body = JSON.parse(await readStdin()) as unknown;
      const request = parseWorkflowRequest(body, app.providers);
      const started = await app.workflows.start(request);
      stdout.write(`${JSON.stringify({ type: "run", runId: started.runId })}\n`);
      const emitted = new Set<number>();
      const writeEvent = (event: import("./types.ts").RunEvent): void => {
        if (event.id !== undefined && emitted.has(event.id)) return;
        if (event.id !== undefined) emitted.add(event.id);
        stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
      };
      const unsubscribe = app.events.subscribe(started.runId, writeEvent);
      for (const event of app.store.listEvents(started.runId)) writeEvent(event);
      const result = await started.completion;
      unsubscribe();
      stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
      if (result.status !== "completed") process.exitCode = 1;
      return;
    }
    if (command === "config" && args[1] === "show") {
      stdout.write(
        `${JSON.stringify({ hardLimits: app.hardLimits, workspaceRoots: app.workspaces.roots() }, null, 2)}\n`,
      );
      return;
    }
    if (command === "models" && args[1] === "list") {
      const id = args[2] as import("./types.ts").ProviderId | undefined;
      if (!id || !["fake", "codex", "claude", "grok"].includes(id)) {
        throw new Error("MODEL_PROVIDER_REQUIRED");
      }
      const authMode = args.includes("--api") ? "api" : "subscription";
      const models = await app.providers.listModels(id, authMode);
      stdout.write(models.length > 0 ? `${models.join("\n")}\n` : "No models discovered.\n");
      return;
    }
    if (command === "workspaces" && args[1] === "list") {
      const roots = app.workspaces.roots();
      stdout.write(
        roots.length > 0
          ? `${roots.map((root) => `${root.id}\t${root.label}\t${root.path}`).join("\n")}\n`
          : "No allowed workspace roots.\n",
      );
      return;
    }
    if (command === "workspaces" && args[1] === "allow") {
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("WORKSPACE_ALLOW_REQUIRES_TTY");
      const inputPath = args[2];
      if (!inputPath) throw new Error("WORKSPACE_ALLOW_PATH_REQUIRED");
      const canonical = await realpath(resolve(inputPath));
      const labelIndex = args.indexOf("--label", 3);
      const label = labelIndex >= 0 ? args[labelIndex + 1] : basename(canonical);
      if (!label) throw new Error("WORKSPACE_ALLOW_LABEL_REQUIRED");
      stdout.write(`About to allow this directory and all descendants:\n${canonical}\n`);
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question("Type ALLOW to save this owner-only policy: ")) !== "ALLOW") {
          stdout.write("Cancelled without changing the allowlist.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { saveWorkspaceRootPolicies } = await import("./config.ts");
      const roots = await saveWorkspaceRootPolicies(
        [
          ...app.workspaces.roots(),
          { id: `root-${randomUUID()}`, label, path: canonical },
        ],
        app.store.dataDirectory,
      );
      const saved = roots.find((root) => root.path === canonical);
      stdout.write(`Allowed: ${saved?.label ?? label} (${canonical})\n`);
      return;
    }
    if (command === "workspaces" && args[1] === "approve") {
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("WORKSPACE_APPROVE_REQUIRES_TTY");
      const { readFile: readFileAsync, writeFile: writeFileAsync } = await import("node:fs/promises");
      const pendingPath = join(app.store.dataDirectory, "pending-workspace-requests.json");
      let pending: Array<{ path: string; at: string }> = [];
      try {
        pending = JSON.parse(await readFileAsync(pendingPath, "utf8")) as typeof pending;
      } catch { pending = []; }
      if (!Array.isArray(pending) || pending.length === 0) {
        stdout.write("沒有待批准的專案授權申請。\n");
        return;
      }
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      const { saveWorkspaceRootPolicies } = await import("./config.ts");
      try {
        for (const item of pending) {
          let canonical: string;
          try {
            canonical = await realpath(resolve(item.path.replace(/^~(?=\/|$)/u, homedir())));
          } catch {
            stdout.write(`略過（路徑不存在）：${item.path}\n`);
            continue;
          }
          stdout.write(`GUI 申請授權（${item.at}）：\n${canonical}\n`);
          if ((await rl.question("輸入 ALLOW 批准這個資料夾（其他輸入＝拒絕）：")) === "ALLOW") {
            await saveWorkspaceRootPolicies(
              [...app.workspaces.roots(), { id: `root-${randomUUID()}`, label: basename(canonical), path: canonical }],
              app.store.dataDirectory,
            );
            stdout.write(`已授權：${canonical}\n`);
          } else {
            stdout.write("已拒絕。\n");
          }
        }
      } finally {
        rl.close();
      }
      await writeFileAsync(pendingPath, "[]", { encoding: "utf8", mode: 0o600 });
      stdout.write("申請清單已清空。重新整理 GUI 即可看到新專案（伺服器會自動重載授權清單）。\n");
      return;
    }
    if (command === "candidates" && args[1] === "orphan-refs") {
      const requested = args[2];
      if (!requested) throw new Error("CANDIDATE_ORPHAN_REFS_PATH_REQUIRED");
      // The allowlist decides, not the caller: an empty allowlist fails closed and a path outside it
      // is refused, so this read can never be pointed at an arbitrary repository on the machine.
      const mainPath = await app.workspaces.assertAllowed(requested);
      const [{ CollaborationService }, { MAX_ORPHAN_RECOVERY_REFS }] = await Promise.all([
        import("./core/collaboration-service.ts"),
        import("./core/candidate-registry.ts"),
      ]);
      const collaboration = new CollaborationService(app.store.dataDirectory);
      try {
        const orphans = await collaboration.candidates.orphanRecoveryRefs(mainPath);
        stdout.write(describeOrphanRecoveryRefs({
          mainPath,
          orphans,
          limit: MAX_ORPHAN_RECOVERY_REFS,
          // A ref name is repository content, so the id inside it is untrusted input to the lookup.
          // A malformed one is simply not a task this ledger knows, never a reason to fail the report.
          taskStatus: (taskId) => {
            try { return collaboration.candidates.get(taskId)?.status; } catch { return undefined; }
          },
        }));
      } finally {
        collaboration.close();
      }
      return;
    }
    if (command === "candidates" && args[1] === "promotions") {
      const requested = args[2];
      if (!requested) throw new Error("CANDIDATE_PROMOTIONS_PATH_REQUIRED");
      // Same protection as `orphan-refs`: the allowlist decides which repository may be named, an
      // empty allowlist fails closed, and nothing here can be pointed at an arbitrary directory.
      const mainPath = await app.workspaces.assertAllowed(requested);
      const { CollaborationService } = await import("./core/collaboration-service.ts");
      const collaboration = new CollaborationService(app.store.dataDirectory);
      try {
        const room = collaboration.ledger.roomForWorkspace(mainPath);
        if (room === undefined) throw new Error("ROOM_NOT_FOUND_FOR_WORKSPACE");
        stdout.write(await runCandidatePromotionsCommand({
          args: args.slice(3),
          roomId: room.id,
          mainPath,
          registry: collaboration.candidates,
          // Attributed to the terminal the owner typed it in, never to the product.
          decidedBy: "local-cli",
        }));
      } finally {
        collaboration.close();
      }
      return;
    }
    if (command === "data" && args[1] === "inventory") {
      const { WorktreeBroker } = await import("./core/worktree-broker.ts");
      const { CollaborationService } = await import("./core/collaboration-service.ts");
      const retainedWorktreeRunIds = await new WorktreeBroker(
        app.store.dataDirectory,
      ).listRunIds();
      const collaboration = new CollaborationService(app.store.dataDirectory);
      try {
        stdout.write(
          `${JSON.stringify({
            ...app.store.inventory(),
            rooms: collaboration.ledger.inventory(),
            roomPresence: collaboration.presence.inventory(),
            roomInbox: collaboration.inbox.inventory(),
            managedRoomAgents: collaboration.managedAgents.inventory(),
            writerLeases: collaboration.writerLeases.inventory(),
            writerDelegations: collaboration.writerDelegations.inventory(),
            collaborationAudit: collaboration.audit.inventory(),
            candidates: collaboration.candidates.inventory(),
            providerCalls: app.providerCalls.status(),
            workflowRequests: app.workflowRequests.inventory(),
            retention: app.retention,
            retainedWorktreeRunIds,
          }, null, 2)}\n`,
        );
      } finally {
        collaboration.close();
      }
      return;
    }
    if (command === "data" && args[1] === "integrity") {
      const { CollaborationService } = await import("./core/collaboration-service.ts");
      const collaboration = new CollaborationService(app.store.dataDirectory);
      let roomReport, presenceReport, inboxReport, managedReport, writerReport, delegationReport, auditReport, candidateReport;
      try {
        roomReport = collaboration.ledger.integrity();
        presenceReport = collaboration.presence.integrity();
        inboxReport = collaboration.inbox.integrity();
        managedReport = collaboration.managedAgents.integrity();
        writerReport = collaboration.writerLeases.integrity();
        delegationReport = collaboration.writerDelegations.integrity();
        auditReport = collaboration.audit.integrity();
        candidateReport = collaboration.candidates.integrity();
      } finally {
        collaboration.close();
      }
      const report = {
        runStore: app.store.integrity(),
        rooms: roomReport,
        roomPresence: presenceReport,
        roomInbox: inboxReport,
        managedRoomAgents: managedReport,
        writerLeases: writerReport,
        writerDelegations: delegationReport,
        collaborationAudit: auditReport,
        candidates: candidateReport,
        providerGovernor: app.providerCalls.integrity(),
        workflowRequests: app.workflowRequests.integrity(),
      };
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (
        report.runStore.foreignKeyViolations > 0 ||
        !report.runStore.auditChainValid ||
        report.rooms.foreignKeyViolations > 0 ||
        !report.rooms.auditChainValid ||
        report.roomPresence.quickCheck !== "ok" ||
        report.roomPresence.foreignKeyViolations > 0 ||
        !report.roomPresence.stateValid ||
        report.roomInbox.quickCheck !== "ok" ||
        !report.roomInbox.stateValid ||
        report.managedRoomAgents.quickCheck !== "ok" ||
        !report.managedRoomAgents.stateValid ||
        report.writerLeases.quickCheck !== "ok" ||
        !report.writerLeases.rowsValid ||
        report.writerDelegations.quickCheck !== "ok" ||
        !report.writerDelegations.rowsValid ||
        report.collaborationAudit.quickCheck !== "ok" ||
        !report.collaborationAudit.chainValid ||
        report.candidates.quickCheck !== "ok" ||
        !report.candidates.rowsValid ||
        !report.providerGovernor.stateValid ||
        !report.workflowRequests.hashesValid
      ) process.exitCode = 1;
      return;
    }
    if (command === "data" && args[1] === "retention" && (args[2] ?? "show") === "show") {
      stdout.write(`${JSON.stringify(app.retention, null, 2)}\n`);
      return;
    }
    if (command === "data" && args[1] === "retention" && args[2] === "set") {
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("RETENTION_SET_REQUIRES_TTY");
      const daysIndex = args.indexOf("--terminal-days", 3);
      const runsIndex = args.indexOf("--max-runs", 3);
      const terminalRunDays = daysIndex >= 0 ? Number(args[daysIndex + 1]) : app.retention.terminalRunDays;
      const maxTerminalRuns = runsIndex >= 0 ? Number(args[runsIndex + 1]) : app.retention.maxTerminalRuns;
      const next = { ...app.retention, terminalRunDays, maxTerminalRuns };
      stdout.write(`${JSON.stringify(next, null, 2)}\n`);
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question("Type RETENTION to save this policy (no data is deleted now): ")) !== "RETENTION") {
          stdout.write("Cancelled without changing retention.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { saveRetentionPolicy } = await import("./config.ts");
      const saved = await saveRetentionPolicy(next, app.store.dataDirectory);
      stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
      return;
    }
    if (command === "data" && args[1] === "purge") {
      const preview = await app.maintenance.previewPurge(app.retention);
      stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      if (!args.includes("--execute") || preview.counts.runs === 0) {
        stdout.write(
          preview.counts.runs === 0
            ? "Nothing is eligible for purge.\n"
            : "Preview only. Re-run with --execute for an interactive, scoped purge.\n",
        );
        return;
      }
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("PURGE_REQUIRES_TTY");
      const expected = `PURGE ${preview.counts.runs} RUNS`;
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question(`Type ${expected} to irreversibly delete only this preview: `)) !== expected) {
          stdout.write("Cancelled without deleting data.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { dataPurgeApprovalScope } = await import("./security/approval.ts");
      const scope = dataPurgeApprovalScope(preview);
      const issued = app.approvals.issue("purge-data", scope, "local-tui");
      stdout.write(
        `${JSON.stringify({ deleted: app.maintenance.purge(preview, issued.token) }, null, 2)}\n`,
      );
      return;
    }
    if (command === "daemon") {
      const sub = args[1] ?? "status";
      const plistPath = join(homedir(), "Library", "LaunchAgents", "com.orchestratory.gui.plist");
      const { writeFile: writeFileAsync, rm: rmAsync, access } = await import("node:fs/promises");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      if (sub === "install") {
        const entry = await daemonRuntimeEntry(import.meta.url);
        const nodeDir = execPath.replace(/\/[^/]+$/u, "");
        const fullPath = (process.env.PATH ?? `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`)
          .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.orchestratory.gui</string>
  <key>ProgramArguments</key><array><string>${execPath}</string><string>${entry}</string><string>gui</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${fullPath}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/orchestratory-gui.log</string>
  <key>StandardErrorPath</key><string>/tmp/orchestratory-gui.log</string>
</dict></plist>
`;
        await writeFileAsync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
        try { await run("launchctl", ["unload", plistPath]); } catch { /* not loaded */ }
        await run("launchctl", ["load", "-w", plistPath]);
        stdout.write("GUI 常駐服務已安裝並啟動：登入自動開、當掉自動重啟、關終端機不影響。\n" +
          "http://127.0.0.1:4317 · 移除：orchestrator daemon uninstall\n");
        return;
      }
      if (sub === "uninstall") {
        try { await run("launchctl", ["unload", "-w", plistPath]); } catch { /* not loaded */ }
        await rmAsync(plistPath, { force: true });
        stdout.write("GUI 常駐服務已移除。\n");
        return;
      }
      if (sub === "status") {
        try {
          const result = await run("launchctl", ["list", "com.orchestratory.gui"]);
          stdout.write(`常駐中\n${result.stdout}`);
        } catch {
          stdout.write("未安裝或未執行。安裝：orchestrator daemon install\n");
        }
        return;
      }
      throw new Error("UNKNOWN_DAEMON_COMMAND");
    }
    if (command === "room") {
      const { defaultRoomId } = await import("./core/room-ledger.ts");
      const { CollaborationService } = await import("./core/collaboration-service.ts");
      const { sanitizeTerminal } = await import("./security/redact.ts");
      const collaboration = new CollaborationService(app.store.dataDirectory);
      const { ledger } = collaboration;
      try {
        const sub = args[1] ?? "status";
        const roomFlagIndex = args.indexOf("--room");
        const roomFlag = roomFlagIndex >= 0 ? args[roomFlagIndex + 1] : undefined;
        const resolveRoom = async () => {
          if (roomFlag) {
            const room = ledger.getRoom(roomFlag);
            if (!room) throw new Error("ROOM_NOT_FOUND");
            return room;
          }
          const { canonicalWorkspace } = await import("./security/workspace.ts");
          const room = ledger.roomForWorkspace(await canonicalWorkspace(process.cwd()));
          if (!room) throw new Error("ROOM_NOT_FOUND_FOR_CWD");
          return room;
        };
        const printRoom = (room: import("./core/room-ledger.ts").RoomInfo): void => {
          stdout.write(
            `room ${room.id} · 收錄 ${room.recording} · ${room.messages} 則 · ${(room.bytes / 1024).toFixed(1)} KiB\n` +
              `workspace ${room.workspace}\n`,
          );
        };
        const line = (message: import("./core/room-ledger.ts").RoomMessage): string =>
          `#${message.seq} ${message.at.slice(11, 19)} ${message.author.padEnd(7, " ")} ${sanitizeTerminal(message.text)}`;
        if (sub === "init") {
          const workspace = await app.workspaces.assertAllowed(process.cwd());
          const id = roomFlag ?? defaultRoomId(workspace);
          printRoom(ledger.createRoom(id, workspace));
          stdout.write("此專案的對話將入帳；orchestrator room pause 可隨時暫停。\n");
          return;
        }
        if (sub === "list") {
          for (const room of ledger.listRooms()) printRoom(room);
          return;
        }
        if (sub === "status") {
          const room = await resolveRoom();
          printRoom(room);
          stdout.write(`hash chain ${ledger.verifyChain(room.id) ? "valid" : "INVALID"}\n`);
          return;
        }
        if (sub === "writers") {
          const room = await resolveRoom();
          const view = collaboration.roomView(room.id, room.workspace);
          const active = view.writerLeases.filter((lease) => lease.state === "active");
          if (active.length === 0) stdout.write("目前沒有 active Writer Lease。\n");
          for (const lease of active) {
            stdout.write(
              `Writer ${sanitizeTerminal(lease.writer.displayName)} · task ${sanitizeTerminal(lease.taskId)} · ` +
              `epoch ${lease.epoch} · ${lease.companionId ? `via ${sanitizeTerminal(lease.companionId)}` : "native"}\n` +
              `  worktree ${sanitizeTerminal(lease.worktree)}\n`,
            );
            for (const child of view.writerDelegations.filter((item) =>
              item.parentLeaseId === lease.id && item.state === "active")) {
              stdout.write(
                `  └─ ${sanitizeTerminal(child.displayName)} · ${child.access} · ` +
                `executed_by ${sanitizeTerminal(child.executedBy)}\n`,
              );
            }
          }
          return;
        }
        if (sub === "audit") {
          const room = await resolveRoom();
          const limitIndex = args.indexOf("--limit");
          const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 50;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("AUDIT_RANGE_INVALID");
          const events = collaboration.audit.list({ roomId: room.id, limit });
          stdout.write(`HMAC audit chain ${collaboration.audit.verify() ? "valid" : "INVALID"}\n`);
          for (const event of events) {
            const who = event.onBehalfOf && event.executedBy
              ? `${sanitizeTerminal(event.onBehalfOf)} via ${sanitizeTerminal(event.executedBy)}`
              : sanitizeTerminal(event.actor);
            stdout.write(
              `#${event.seq} ${new Date(event.atMs).toISOString()} ${sanitizeTerminal(event.type)} ` +
              `· ${who}${event.leaseEpoch ? ` · epoch ${event.leaseEpoch}` : ""} · ${event.outcome}` +
              `${event.path ? ` · ${sanitizeTerminal(event.path)}` : ""}\n`,
            );
          }
          return;
        }
        if (sub === "pause" || sub === "resume" || sub === "off") {
          const state = sub === "pause" ? "paused" : sub === "resume" ? "on" : "off";
          printRoom(ledger.setRecording((await resolveRoom()).id, state));
          return;
        }
        if (sub === "presence-hook") {
          const providerIndex = args.indexOf("--provider");
          const provider = providerIndex >= 0 ? args[providerIndex + 1] : undefined;
          if (provider !== "codex" && provider !== "claude" && provider !== "grok") {
            throw new Error("INVALID_PRESENCE_PROVIDER");
          }
          try {
            const payload = JSON.parse(await readStdin()) as Record<string, unknown>;
            const { normalizePresenceHookPayload } = await import("./core/room-hooks.ts");
            const normalized = normalizePresenceHookPayload(payload);
            if (!normalized) return;
            const workspace = await app.workspaces.rootFor(normalized.cwd);
            collaboration.recordHook({
              provider,
              workspace,
              hostPid: process.ppid,
              sessionId: normalized.sessionId,
              event: normalized.event,
              ...(normalized.turnId ? { turnId: normalized.turnId } : {}),
              ...(normalized.text ? { text: normalized.text } : {}),
              ...(normalized.model ? { model: normalized.model } : {}),
            });
          } catch {
            // A logging hook must never interrupt or alter the host agent session.
          }
          return;
        }
        if (sub === "hooks") {
          const providerIndex = args.indexOf("--provider");
          const provider = providerIndex >= 0 ? args[providerIndex + 1] : "claude";
          if (provider !== "codex" && provider !== "claude" && provider !== "grok") {
            throw new Error("INVALID_PRESENCE_PROVIDER");
          }
          const { installRoomHooks, roomHooksPreview } = await import("./core/room-hooks.ts");
          if (!args.includes("--install")) {
            stdout.write(
              `以下 ${provider} hooks 只會替「已在 GUI 點加入」的 MCP 終端入帳；未加入時內容不保存：\n\n` +
              JSON.stringify(roomHooksPreview(provider), null, 2) +
              `\n\n預覽而已，尚未修改任何設定。\n由你本人執行安裝：orchestrator room hooks --provider ${provider} --install\n`,
            );
            return;
          }
          const installed = await installRoomHooks(provider);
          if (!installed.changed) {
            stdout.write("room hooks 已安裝過，未做任何變更。\n");
            return;
          }
          stdout.write(
            `room hooks 已安裝：${installed.path}${installed.backupPath ? `（原設定備份：${installed.backupPath}）` : ""}\n` +
            `新開的 ${provider} session 起生效；只有在 GUI 明確加入的 MCP 終端會入帳。` +
            (installed.trustReviewRequired ? "\nCodex 會要求你在 /hooks 畫面審核這組新命令。" : "") + "\n",
          );
          return;
        }
        if (sub === "log-hook") {
          // Legacy hooks could not prove explicit GUI membership. Fail closed so an
          // old user config never records a terminal that was not joined.
          if (!stdin.isTTY) await readStdin().catch(() => "");
          return;
        }
        if (sub === "log") {
          const authorIndex = args.indexOf("--author");
          const textIndex = args.indexOf("--text");
          const author = authorIndex >= 0 ? args[authorIndex + 1] : undefined;
          if (!author) throw new Error("ROOM_LOG_AUTHOR_REQUIRED");
          const text = textIndex >= 0 ? args[textIndex + 1] : stdin.isTTY ? undefined : await readStdin();
          if (!text || text.trim().length < 1) throw new Error("ROOM_LOG_TEXT_REQUIRED");
          const message = ledger.append((await resolveRoom()).id, author, text);
          stdout.write(`#${message.seq}\n`);
          return;
        }
        if (sub === "join") {
          throw new Error(
            "ROOM_JOIN_REQUIRES_MCP_TOOL: ask the current agent to call room_join_request directly; " +
            "do not run a shell command. Native PTY capture moved to: orchestrator room pty codex|grok",
          );
        }
        if (sub === "pty") {
          if (!stdin.isTTY || !stdout.isTTY) throw new Error("ROOM_PTY_REQUIRES_TTY");
          const { parseRoomPtyCliArgs, runRoomPty } = await import("./core/room-pty.ts");
          const selected = parseRoomPtyCliArgs(args);
          const { loadNativeRoomPtyEnabled } = await import("./config.ts");
          if (!(await loadNativeRoomPtyEnabled(app.store.dataDirectory))) {
            throw new Error("ROOM_PTY_OWNER_OPT_IN_REQUIRED");
          }
          const room = await resolveRoom();
          const workspace = await app.workspaces.assertAllowed(process.cwd());
          if (workspace !== room.workspace) throw new Error("ROOM_WORKSPACE_MISMATCH");
          if (room.recording !== "on") throw new Error("ROOM_RECORDING_NOT_ON");
          ledger.appendSystem(
            room.id,
            `▶ ${selected}-terminal joined via bounded local PTY; raw capture remains RAM-only.`,
          );
          nativePtyActive = true;
          try {
            const result = await runRoomPty(selected, workspace);
            if (result.transcript) ledger.append(room.id, result.author, result.transcript);
            ledger.appendSystem(
              room.id,
              `■ ${result.author} exited (${result.exitCode}${result.signal ? `, ${result.signal}` : ""}; ${Math.ceil(result.durationMs / 1_000)}s).`,
            );
            if (result.exitCode !== 0) process.exitCode = result.exitCode;
          } catch (error) {
            ledger.appendSystem(
              room.id,
              `■ ${selected}-terminal failed: ${safeSummary(error instanceof Error ? error.message : "UNKNOWN_ERROR", 300)}`,
            );
            throw error;
          } finally {
            nativePtyActive = false;
          }
          return;
        }
        if (sub === "tail") {
          const room = await resolveRoom();
          let cursor = Math.max(0, room.messages - 30);
          const print = () => {
            for (const message of ledger.listAfter(room.id, cursor)) {
              stdout.write(`${line(message)}\n`);
              cursor = Math.max(cursor, message.seq);
            }
          };
          print();
          if (!args.includes("--follow")) return;
          stdout.write("…following（Ctrl+C 離開）\n");
          await new Promise<void>((resolve) => {
            const timer = setInterval(print, 1_000);
            const stop = (): void => {
              clearInterval(timer);
              resolve();
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
          });
          return;
        }
        if (sub === "export") {
          const room = await resolveRoom();
          stdout.write(`# Room ${room.id}\n\n`);
          let cursor = 0;
          while (true) {
            const batch = ledger.listAfter(room.id, cursor);
            if (batch.length === 0) break;
            for (const message of batch) {
              stdout.write(`**#${message.seq} · ${message.author} · ${message.at}**\n\n${message.text}\n\n---\n\n`);
              cursor = message.seq;
            }
          }
          return;
        }
        throw new Error("UNKNOWN_ROOM_COMMAND");
      } finally {
        collaboration.close();
      }
    }
    if (command === "worktrees" && args[1] === "list") {
      const { WorktreeBroker } = await import("./core/worktree-broker.ts");
      const ids = await new WorktreeBroker(app.store.dataDirectory).listRunIds();
      stdout.write(ids.length > 0 ? `${ids.join("\n")}\n` : "No retained worktrees.\n");
      return;
    }
    if (command === "worktrees" && args[1] === "cleanup") {
      const runId = args[2] ?? "";
      const preview = await app.maintenance.previewWorktreeCleanup(runId);
      stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      if (!args.includes("--execute")) {
        stdout.write("Preview only. The branch is retained. Re-run with --execute for interactive removal.\n");
        return;
      }
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("WORKTREE_CLEANUP_REQUIRES_TTY");
      const expected = `REMOVE WORKTREE ${runId}`;
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question(`Type ${expected} to remove only this clean worktree: `)) !== expected) {
          stdout.write("Cancelled without removing the worktree.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { worktreeCleanupApprovalScope } = await import("./security/approval.ts");
      const scope = worktreeCleanupApprovalScope(preview);
      const issued = app.approvals.issue("cleanup-worktree", scope, "local-tui");
      await app.maintenance.cleanupWorktree(preview, issued.token);
      stdout.write("Clean worktree removed. Its Git branch was retained.\n");
      return;
    }
    if (command !== "tui") throw new Error("UNKNOWN_COMMAND");
    await runTui(app);
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    if (app.workflows.listActive().length === 0) app.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    stderr.write(`Error: ${safeSummary(error instanceof Error ? error.message : "UNKNOWN_ERROR", 500)}\n`);
    process.exitCode = 1;
  });
}
