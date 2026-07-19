import { WorkspaceToolBroker, WORKSPACE_SENSITIVE_PATH } from "../mcp/workspace-server.ts";
import { safeSummary } from "../security/redact.ts";
import {
  minimalGitEnvironment,
  resolveExecutable,
  runProcess,
} from "./process-runner.ts";

const MAX_TREE_ENTRIES = 400;
const MAX_TREE_BYTES = 16_384;
const MAX_READ_PATHS = 8;
const MAX_READ_FILE_CHARS = 16_384;
const MAX_READ_TOTAL_BYTES = 49_152;

export interface SessionContext {
  fileTree(): Promise<string>;
  readFiles(paths: string[]): Promise<string>;
}

/**
 * Read-only, bounded project context for the conversation session.
 *
 * File listing uses Git so ignored trees (node_modules, build output) stay
 * out of the prompt; file reads reuse the Workspace MCP broker so the exact
 * same escape/symlink/hardlink/sensitive-path/binary/size denials apply.
 */
export class SessionContextBroker implements SessionContext {
  readonly #workspace: string;

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  async fileTree(): Promise<string> {
    let stdout: string;
    try {
      const executable = await resolveExecutable("git");
      const result = await runProcess({
        executable,
        args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd: this.#workspace,
        timeoutMs: 15_000,
        outputLimitBytes: 1_048_576,
        env: minimalGitEnvironment(),
      });
      if (result.exitCode !== 0 || result.terminationReason) return "";
      stdout = result.stdout;
    } catch {
      return "";
    }
    const paths = stdout
      .split("\0")
      .filter(Boolean)
      .filter((path) => !path.includes("�") && !WORKSPACE_SENSITIVE_PATH.test(path))
      .sort();
    const listed: string[] = [];
    let bytes = 0;
    for (const path of paths) {
      bytes += Buffer.byteLength(path) + 1;
      if (listed.length >= MAX_TREE_ENTRIES || bytes > MAX_TREE_BYTES) break;
      listed.push(path);
    }
    if (listed.length === 0) return "";
    const omitted = paths.length - listed.length;
    return omitted > 0
      ? `${listed.join("\n")}\n… (${omitted} more files omitted)`
      : listed.join("\n");
  }

  async readFiles(paths: string[]): Promise<string> {
    const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
      .slice(0, MAX_READ_PATHS);
    if (unique.length === 0) return "No valid file paths were requested.";
    const broker = await WorkspaceToolBroker.create(this.#workspace, "read-only");
    const sections: string[] = [];
    let bytes = 0;
    for (const path of unique) {
      let section: string;
      try {
        const raw = await broker.call("read_file", { path });
        const parsed = JSON.parse(raw) as { path: string; content: string };
        section = `File: ${parsed.path}\n${safeSummary(parsed.content, MAX_READ_FILE_CHARS)}`;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "READ_FAILED";
        section = `File: ${safeSummary(path, 500)}\nREAD_DENIED: ${safeSummary(reason, 200)}`;
      }
      bytes += Buffer.byteLength(section);
      if (bytes > MAX_READ_TOTAL_BYTES) {
        sections.push("(remaining files omitted: bounded read budget reached)");
        break;
      }
      sections.push(section);
    }
    return sections.join("\n\n---\n\n");
  }
}
