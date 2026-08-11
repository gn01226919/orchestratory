import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, opendir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stdin, stdout } from "node:process";
import { canonicalWorkspace } from "../security/workspace.ts";
import { safeSummary } from "../security/redact.ts";
import { CollaborationService } from "../core/collaboration-service.ts";
import { GitBroker } from "../core/git-broker.ts";

type WorkspaceMode = "read-only" | "write";
type JsonObject = Record<string, unknown>;
export type WorkspaceAction = "list_files" | "read_file" | "create_directory" | "write_file";

export interface WorkspaceOperation {
  action: WorkspaceAction;
  path?: string;
  outcome: "succeeded" | "failed";
  error?: string;
}

export interface WorkspaceBrokerHooks {
  authorizeRead?: () => void;
  authorizeWrite?: () => void;
  recordOperation?: (operation: WorkspaceOperation) => void | Promise<void>;
}

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_FILE_BYTES = 524_288;
const MAX_LIST_ENTRIES = 10_000;
const MAX_TOOL_CALLS = 128;
const MAX_WRITE_CALLS = 64;
const MAX_DIRECTORY_CALLS = 32;
// Blocks (1) secrets/VCS internals and (2) "write-then-auto-execute" configuration
// whose modification would let a workspace write escalate into later RCE — CI
// workflows, git/husky/claude hooks. Applies to every Writer (Claude and Codex).
//
// ⚠️ This list is HALF of (2) and never was the whole of it. Measured (amendment (X-3)):
// `.husky/pre-merge-commit` → true, while `.githooks/pre-merge-commit`, `githooks/…`, `hooks/…` and
// `tools/hooks/…` were all false — the sibling was pinned and the family was not, for the third time
// ([[PITFALLS]] #103/#108). The family cannot be closed by adding rows, because the name of a hook
// directory is whatever `core.hooksPath` says it is. The other half is `#autoExecutedDirectories`,
// which asks git — and asks it again on every write, because that configuration outlives a broker.
export const WORKSPACE_SENSITIVE_PATH =
  /(?:^|\/)(?:\.git|\.orchestratory|\.husky|\.claude|\.circleci)(?:\/|$)|(?:^|\/)\.github\/workflows(?:\/|$)|(?:^|\/)(?:\.env(?:\.[^/]*)?|\.gitlab-ci\.yml|[^/]+\.(?:pem|key|p12|pfx))$/iu;
const SENSITIVE_PATH = WORKSPACE_SENSITIVE_PATH;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function relativeFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\0")) {
    throw new Error("INVALID_WORKSPACE_FILE_PATH");
  }
  if (isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    throw new Error("WORKSPACE_PATH_ESCAPE_DENIED");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (SENSITIVE_PATH.test(normalized)) throw new Error("SENSITIVE_WORKSPACE_PATH_DENIED");
  return normalized;
}

/**
 * Whether `path` is inside ANY position the auto-executed directory occupies.
 *
 * Segment-wise, so a sibling whose name merely starts with the same characters is not caught, and
 * `""` — the working tree root — catches everything. Amendment (Y-1) makes the first argument a set:
 * one directory can be at two positions at once when it is reached through a symlink.
 */
function autoExecuted(directories: readonly string[], path: string): boolean {
  return directories.some((directory) =>
    directory === "" || path === directory || path.startsWith(`${directory}/`));
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_TOOL_ARGUMENTS");
  }
  return value as JsonObject;
}

export class WorkspaceToolBroker {
  readonly #root: string;
  readonly #mode: WorkspaceMode;
  readonly #hooks: WorkspaceBrokerHooks;
  #toolCalls = 0;
  #writeCalls = 0;
  #directoryCalls = 0;

  private constructor(root: string, mode: WorkspaceMode, hooks: WorkspaceBrokerHooks) {
    this.#root = root;
    this.#mode = mode;
    this.#hooks = hooks;
  }

  /**
   * Every position git auto-executes out of, relative to this root: `[]` when git placed that
   * directory outside this tree, or `undefined` when git could not be asked at all.
   *
   * Amendment (X-3). Asked of git rather than matched against names, because the name is
   * configurable and the behaviour is not. `undefined` is the fail-closed value for a write broker:
   * a broker that cannot say where the auto-executed directory is cannot say a write is outside it,
   * so it refuses rather than falling back to the regular expression that was measured missing four
   * spellings of the same directory.
   *
   * Amendment (Y-1) makes it a SET — a hook directory reached through a symlink occupies two
   * positions and a write to either installs a program git runs.
   */
  static async #autoExecutedDirectories(root: string): Promise<string[] | undefined> {
    try {
      return await new GitBroker().hookDirectoryPositions(root);
    } catch {
      return undefined;
    }
  }

  static async create(root: string, mode: WorkspaceMode, hooks: WorkspaceBrokerHooks = {}): Promise<WorkspaceToolBroker> {
    if (mode !== "read-only" && mode !== "write") throw new Error("INVALID_WORKSPACE_BROKER_MODE");
    if (mode === "write" && !hooks.authorizeWrite) throw new Error("WORKSPACE_WRITE_AUTHORIZER_REQUIRED");
    const canonical = await canonicalWorkspace(root);
    // A Writer's workspace is always a task-bound git worktree in this product, so "git could not
    // answer" is an anomaly rather than a supported shape, and the anomaly costs a refusal instead of
    // an unguarded write surface. Read-only brokers are unaffected: nothing they do can install a
    // program anywhere.
    if (mode === "write" && await WorkspaceToolBroker.#autoExecutedDirectories(canonical) === undefined) {
      throw new Error("WORKSPACE_HOOK_DIRECTORY_UNRESOLVED");
    }
    return new WorkspaceToolBroker(canonical, mode, hooks);
  }

  /**
   * Refuses a path git or the toolchain would execute on its own.
   *
   * Segment-wise, so a sibling directory whose name merely starts with the same characters is not
   * caught. `""` — the working tree root, which is what `--git-path hooks` resolves to when
   * `core.hooksPath` is empty — catches everything, which is the fail-closed reading of an answer
   * whose meaning is ambiguous; see `hookDirectoryBlockers` for what git was measured doing there.
   *
   * ## Why this asks git again on every write, instead of once at `create()`
   *
   * The question is "where does git run programs from RIGHT NOW", and the answer is `core.hooksPath`,
   * which lives in a config file that outlives any one broker. Measured (`w2-stale`): a broker built
   * before the repository was reconfigured went on answering with the old directory and admitted a
   * write a broker built one moment later refused. A cached answer to a mutable question is not the
   * answer to the question — it is the answer to an older one ([[PITFALLS]] #103, the same shape as
   * parsing another program's configuration instead of asking it).
   *
   * An unanswerable question refuses for a WRITE broker, exactly as it does at `create()`: not being
   * able to say where the auto-executed directory is means not being able to say this write is
   * outside it. For a read-only broker it refuses nothing, which is the pre-existing behaviour and
   * the honest one — nothing a read-only broker does can install a program, and a workspace whose
   * git is momentarily unreachable would otherwise stop being readable at all.
   */
  async #assertNotAutoExecuted(path: string): Promise<void> {
    const directories = await WorkspaceToolBroker.#autoExecutedDirectories(this.#root);
    if (directories === undefined) {
      if (this.#mode === "write") throw new Error("WORKSPACE_HOOK_DIRECTORY_UNRESOLVED");
      return;
    }
    if (autoExecuted(directories, path)) throw new Error("SENSITIVE_WORKSPACE_PATH_DENIED");
  }

  tools(): JsonObject[] {
    const tools: JsonObject[] = [
      {
        name: "list_files",
        description: "List bounded regular files inside the authorized workspace. Sensitive paths are omitted.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      {
        name: "read_file",
        description: "Read one bounded UTF-8 text file inside the authorized workspace.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
          required: ["path"],
        },
      },
    ];
    if (this.#mode === "write") {
      tools.push({
        name: "create_directory",
        description: "Create one new directory inside an existing authorized parent. Recursive creation and deletion are not supported.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
          required: ["path"],
        },
      });
      tools.push({
        name: "write_file",
        description: "Atomically create or replace one bounded UTF-8 text file. Pass the SHA-256 returned by read_file, or null only for a new path. Deletion is not supported.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            content: { type: "string", maxLength: MAX_FILE_BYTES },
            expectedSha256: {
              anyOf: [
                { type: "string", pattern: "^[a-f0-9]{64}$" },
                { type: "null" },
              ],
            },
          },
          required: ["path", "content", "expectedSha256"],
        },
      });
    }
    return tools;
  }

  async call(name: string, input: unknown): Promise<string> {
    this.#toolCalls += 1;
    if (this.#toolCalls > MAX_TOOL_CALLS) throw new Error("WORKSPACE_TOOL_CALL_LIMIT_REACHED");
    if (name !== "list_files" && name !== "read_file" && name !== "create_directory" && name !== "write_file") {
      throw new Error("UNKNOWN_WORKSPACE_TOOL");
    }
    const action = name as WorkspaceAction;
    const object = asObject(input);
    const path = typeof object.path === "string" ? object.path : undefined;
    try {
      let result: string;
      if (action === "list_files") {
        this.#hooks.authorizeRead?.();
        result = await this.#listFiles(object);
      } else if (action === "read_file") {
        this.#hooks.authorizeRead?.();
        result = await this.#readFile(object);
      }
      else if (action === "create_directory") {
        this.#authorizeWrite();
        this.#directoryCalls += 1;
        if (this.#directoryCalls > MAX_DIRECTORY_CALLS) throw new Error("WORKSPACE_DIRECTORY_CALL_LIMIT_REACHED");
        result = await this.#createDirectory(object);
      } else {
        this.#authorizeWrite();
        this.#writeCalls += 1;
        if (this.#writeCalls > MAX_WRITE_CALLS) throw new Error("WORKSPACE_WRITE_CALL_LIMIT_REACHED");
        result = await this.#writeFile(object);
      }
      await this.#hooks.recordOperation?.({ action, ...(path ? { path } : {}), outcome: "succeeded" });
      return result;
    } catch (error) {
      try {
        await this.#hooks.recordOperation?.({
          action, ...(path ? { path } : {}), outcome: "failed",
          error: safeSummary(error instanceof Error ? error.message : "WORKSPACE_OPERATION_FAILED", 160),
        });
      } catch { /* preserve the operation error */ }
      throw error;
    }
  }

  async #listFiles(input: JsonObject): Promise<string> {
    if (Object.keys(input).length > 0) throw new Error("UNKNOWN_LIST_FILES_ARGUMENT");
    const paths: string[] = [];
    // Resolved once per listing rather than once per broker (amendment (Y-1)/P2-1) and rather than
    // once per entry: a listing is one point in time, so one answer is the right granularity. An
    // unanswerable question omits nothing here — this is a read-only enumeration and hiding files
    // from it cannot stop a program being installed, while refusing would break `list_files` on a
    // workspace whose git is momentarily unreachable.
    const autoExecutedDirectories =
      await WorkspaceToolBroker.#autoExecutedDirectories(this.#root) ?? [];
    const queue = [this.#root];
    while (queue.length > 0) {
      const directory = queue.shift();
      if (!directory) break;
      this.#hooks.authorizeRead?.();
      const handle = await opendir(directory);
      for await (const entry of handle) {
        const absolute = resolve(directory, entry.name);
        const path = relative(this.#root, absolute).split(sep).join("/");
        if (SENSITIVE_PATH.test(path)) continue;
        if (autoExecuted(autoExecutedDirectories, path)) continue;
        if (entry.isSymbolicLink()) throw new Error("WORKSPACE_SYMLINK_DENIED");
        if (entry.isDirectory()) queue.push(absolute);
        else if (entry.isFile()) paths.push(path);
        else throw new Error("SPECIAL_WORKSPACE_FILE_DENIED");
        if (paths.length + queue.length > MAX_LIST_ENTRIES) {
          throw new Error("WORKSPACE_LIST_LIMIT_REACHED");
        }
      }
    }
    return paths.sort().join("\n");
  }

  async #readFile(input: JsonObject): Promise<string> {
    if (Object.keys(input).some((key) => key !== "path")) throw new Error("UNKNOWN_READ_FILE_ARGUMENT");
    const path = relativeFilePath(input.path);
    await this.#assertNotAutoExecuted(path);
    const candidate = await realpath(resolve(this.#root, path));
    if (!inside(this.#root, candidate)) throw new Error("WORKSPACE_PATH_ESCAPE_DENIED");
    const info = await lstat(candidate);
    if (!info.isFile()) throw new Error("WORKSPACE_FILE_NOT_REGULAR");
    if (info.nlink > 1) throw new Error("WORKSPACE_HARDLINK_DENIED");
    if (info.size > MAX_FILE_BYTES) throw new Error("WORKSPACE_FILE_TOO_LARGE");
    this.#hooks.authorizeRead?.();
    const content = await readFile(candidate);
    if (content.includes(0)) throw new Error("WORKSPACE_BINARY_FILE_DENIED");
    let text: string;
    try {
      text = UTF8_DECODER.decode(content);
    } catch {
      throw new Error("WORKSPACE_INVALID_UTF8_DENIED");
    }
    return JSON.stringify({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      content: text,
    });
  }

  async #createDirectory(input: JsonObject): Promise<string> {
    if (Object.keys(input).some((key) => key !== "path")) {
      throw new Error("UNKNOWN_CREATE_DIRECTORY_ARGUMENT");
    }
    const path = relativeFilePath(input.path);
    await this.#assertNotAutoExecuted(path);
    const candidate = resolve(this.#root, path);
    if (!inside(this.#root, candidate) || candidate === this.#root) {
      throw new Error("WORKSPACE_PATH_ESCAPE_DENIED");
    }
    const parent = await realpath(dirname(candidate));
    if (!inside(this.#root, parent)) throw new Error("WORKSPACE_PARENT_ESCAPE_DENIED");
    this.#authorizeWrite();
    await mkdir(candidate, { mode: 0o700, recursive: false });
    const canonical = await realpath(candidate);
    if (!inside(this.#root, canonical)) throw new Error("WORKSPACE_PATH_ESCAPE_DENIED");
    await chmod(canonical, 0o700);
    return `CREATED ${path}`;
  }

  async #writeFile(input: JsonObject): Promise<string> {
    if (Object.keys(input).some((key) => key !== "path" && key !== "content" && key !== "expectedSha256")) {
      throw new Error("UNKNOWN_WRITE_FILE_ARGUMENT");
    }
    const path = relativeFilePath(input.path);
    await this.#assertNotAutoExecuted(path);
    if (typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_FILE_BYTES) {
      throw new Error("WORKSPACE_WRITE_CONTENT_TOO_LARGE");
    }
    if (input.content.includes("\0")) throw new Error("WORKSPACE_BINARY_WRITE_DENIED");
    const candidate = resolve(this.#root, path);
    if (!inside(this.#root, candidate)) throw new Error("WORKSPACE_PATH_ESCAPE_DENIED");
    const parent = await realpath(dirname(candidate));
    if (!inside(this.#root, parent)) throw new Error("WORKSPACE_PARENT_ESCAPE_DENIED");
    let mode = 0o600;
    let previousHash: string | undefined;
    try {
      const existing = await lstat(candidate);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("WORKSPACE_WRITE_TARGET_DENIED");
      if (existing.nlink > 1) throw new Error("WORKSPACE_HARDLINK_DENIED");
      mode = existing.mode & 0o777;
      previousHash = createHash("sha256").update(await readFile(candidate)).digest("hex");
      if (input.expectedSha256 !== previousHash) throw new Error("WORKSPACE_WRITE_STALE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (input.expectedSha256 !== null) throw new Error("WORKSPACE_CREATE_EXPECTED_HASH_MUST_BE_NULL");
    }
    const temporary = resolve(parent, `.orchestratory-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, input.content, { encoding: "utf8", mode, flag: "wx" });
      await chmod(temporary, mode);
      try {
        const current = await lstat(candidate);
        if (!current.isFile() || current.nlink > 1 || previousHash === undefined) {
          throw new Error("WORKSPACE_WRITE_STALE");
        }
        const currentHash = createHash("sha256").update(await readFile(candidate)).digest("hex");
        if (currentHash !== previousHash) throw new Error("WORKSPACE_WRITE_STALE");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || previousHash !== undefined) throw error;
      }
      this.#authorizeWrite();
      if (previousHash === undefined) {
        await link(temporary, candidate);
        await rm(temporary);
      } else {
        await rename(temporary, candidate);
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return `WROTE ${path} (${Buffer.byteLength(input.content)} bytes)`;
  }

  #authorizeWrite(): void {
    if (this.#mode !== "write") throw new Error("WORKSPACE_WRITE_TOOL_DENIED");
    if (!this.#hooks.authorizeWrite) throw new Error("WORKSPACE_WRITE_AUTHORIZER_REQUIRED");
    this.#hooks.authorizeWrite();
  }
}

function response(id: unknown, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: unknown, error: unknown): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: safeSummary(error instanceof Error ? error.message : "MCP_ERROR", 200) },
  };
}

function send(value: JsonObject): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(broker: WorkspaceToolBroker, message: unknown): Promise<void> {
  const request = asObject(message);
  const id = request.id;
  const method = request.method;
  if (typeof method !== "string") throw new Error("INVALID_MCP_METHOD");
  if (method.startsWith("notifications/")) return;
  try {
    if (method === "initialize") {
      const params = typeof request.params === "object" && request.params !== null
        ? request.params as JsonObject
        : {};
      send(response(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "orchestratory-workspace", version: "0.1.0" },
      }));
      return;
    }
    if (method === "ping") {
      send(response(id, {}));
      return;
    }
    if (method === "tools/list") {
      send(response(id, { tools: broker.tools() }));
      return;
    }
    if (method === "tools/call") {
      const params = asObject(request.params);
      if (typeof params.name !== "string") throw new Error("INVALID_TOOL_NAME");
      const text = await broker.call(params.name, params.arguments ?? {});
      send(response(id, { content: [{ type: "text", text }], isError: false }));
      return;
    }
    throw new Error("UNKNOWN_MCP_METHOD");
  } catch (error) {
    send(errorResponse(id, error));
  }
}

export async function runWorkspaceMcpServer(args = process.argv.slice(2)): Promise<void> {
  const workspaceIndex = args.indexOf("--workspace");
  const modeIndex = args.indexOf("--mode");
  const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
  if (!workspace || (mode !== "read-only" && mode !== "write")) {
    throw new Error("WORKSPACE_MCP_CONFIGURATION_INVALID");
  }
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const delegationId = value("--delegation");
  const legacyWorkflowRun = value("--legacy-workflow-run");
  const dataDirectory = value("--data-directory");
  const roomId = value("--room");
  const taskId = value("--task");
  const sourceWorkspace = value("--source-workspace");
  const executedBy = value("--executed-by");
  const epochText = value("--epoch");
  const capabilityToken = process.env.ORCHESTRATORY_WORKSPACE_CAPABILITY;
  let service: CollaborationService | undefined;
  let hooks: WorkspaceBrokerHooks = {};
  if (mode === "write" && legacyWorkflowRun && !dataDirectory) {
    const legacyCapability = process.env.ORCHESTRATORY_LEGACY_WORKFLOW_CAPABILITY;
    if (!/^[0-9a-f-]{36}$/u.test(legacyWorkflowRun) || !/^[0-9a-f-]{36}$/u.test(legacyCapability ?? "")) {
      throw new Error("WORKSPACE_MCP_LEGACY_CAPABILITY_INVALID");
    }
    const authorizeLegacy = (): void => {
      if (process.env.ORCHESTRATORY_LEGACY_WORKFLOW_CAPABILITY !== legacyCapability) {
        throw new Error("WORKSPACE_MCP_LEGACY_CAPABILITY_REVOKED");
      }
    };
    hooks = { authorizeRead: authorizeLegacy, authorizeWrite: authorizeLegacy };
  } else if (mode === "write" || delegationId) {
    if (!dataDirectory || !roomId || !taskId || !sourceWorkspace || !executedBy) {
      throw new Error("WORKSPACE_MCP_WRITER_CONTEXT_REQUIRED");
    }
    service = new CollaborationService(dataDirectory);
    const target = await canonicalWorkspace(workspace);
    if (delegationId) {
      const read = (): ReturnType<CollaborationService["assertDelegatedRead"]> => service!.assertDelegatedRead({
        delegationId, taskId, roomId, workspace: sourceWorkspace, executedBy,
      });
      const initial = read();
      if (target !== initial.workspace) throw new Error("WORKSPACE_MCP_DELEGATION_TARGET_MISMATCH");
      const write = (): void => {
        if (!capabilityToken) throw new Error("WORKSPACE_MCP_CAPABILITY_REQUIRED");
        service!.assertDelegatedWrite({
          delegationId, taskId, roomId, workspace: sourceWorkspace,
          capabilityToken, executedBy,
        });
      };
      if (mode === "write") write();
      hooks = {
        authorizeRead: () => { read(); },
        ...(mode === "write" ? { authorizeWrite: write } : {}),
        recordOperation: (operation) => service!.recordWorkspaceOperation({
          taskId, roomId, workspace: sourceWorkspace, actor: initial.displayName,
          onBehalfOf: initial.onBehalfOf, executedBy: initial.executedBy,
          leaseEpoch: initial.parentEpoch, action: operation.action,
          ...(operation.path ? { path: operation.path } : {}), outcome: operation.outcome,
          ...(operation.error ? { detail: { error: operation.error, delegationId } } : { detail: { delegationId } }),
        }),
      };
    } else {
      if (mode !== "write" || !capabilityToken || !epochText) throw new Error("WORKSPACE_MCP_CAPABILITY_REQUIRED");
      const epoch = Number(epochText);
      const authorize = (): ReturnType<CollaborationService["assertWriterWrite"]> => service!.assertWriterWrite({
        taskId, roomId, workspace: sourceWorkspace, epoch, capabilityToken, executedBy,
      });
      const initial = authorize();
      if (target !== initial.worktree) throw new Error("WORKSPACE_MCP_WRITER_TARGET_MISMATCH");
      hooks = {
        authorizeRead: () => { authorize(); },
        authorizeWrite: () => { authorize(); },
        recordOperation: (operation) => service!.recordWorkspaceOperation({
          taskId, roomId, workspace: sourceWorkspace, actor: initial.writer.displayName,
          onBehalfOf: initial.onBehalfOf, executedBy: initial.executedBy,
          leaseEpoch: initial.epoch, action: operation.action,
          ...(operation.path ? { path: operation.path } : {}), outcome: operation.outcome,
          ...(operation.error ? { detail: { error: operation.error } } : {}),
        }),
      };
    }
  }
  const broker = await WorkspaceToolBroker.create(workspace, mode, hooks);
  try {
    let buffer = "";
    for await (const chunk of stdin) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw new Error("MCP_REQUEST_TOO_LARGE");
        await handle(broker, JSON.parse(line) as unknown);
      }
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) throw new Error("MCP_REQUEST_TOO_LARGE");
    }
    if (buffer.trim().length > 0) throw new Error("MCP_TRUNCATED_REQUEST");
  } finally {
    service?.close();
  }
}
