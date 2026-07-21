import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { canonicalWorkspace, resolveExistingInside } from "../security/workspace.ts";
import {
  minimalGitEnvironment,
  resolveExecutable,
  runProcess,
} from "./process-runner.ts";

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
const SENSITIVE_UNTRACKED_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/iu;

export class GitBroker {
  async #git(workspace: string, args: string[], outputLimitBytes = 1_048_576): Promise<string> {
    const executable = await resolveExecutable("git");
    const env = minimalGitEnvironment();
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

  async inspect(workspaceInput: string): Promise<GitInspection> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const root = (await this.#git(workspace, ["rev-parse", "--show-toplevel"], 16_384)).trim();
    if ((await canonicalWorkspace(root)) !== workspace) throw new Error("WORKSPACE_MUST_BE_GIT_ROOT");
    const status = await this.#git(workspace, ["status", "--short", "--untracked-files=all"]);
    const numstat = await this.#git(workspace, ["diff", "--no-ext-diff", "--numstat"]);
    const cachedNumstat = await this.#git(workspace, ["diff", "--cached", "--no-ext-diff", "--numstat"]);
    const trackedPaths = [
      ...(await this.#paths(workspace, ["diff", "--name-only", "-z"])),
      ...(await this.#paths(workspace, ["diff", "--cached", "--name-only", "-z"])),
    ];
    const untrackedPaths = await this.#paths(workspace, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const changedPaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();
    let changedLines = 0;
    for (const line of `${numstat}\n${cachedNumstat}`.split("\n")) {
      const [added, removed] = line.split("\t");
      if (/^\d+$/u.test(added ?? "")) changedLines += Number(added);
      if (/^\d+$/u.test(removed ?? "")) changedLines += Number(removed);
    }
    let changedBytes = 0;
    const fingerprintHash = createHash("sha256")
      .update(status)
      .update(numstat)
      .update(cachedNumstat);
    for (const path of changedPaths) {
      fingerprintHash.update(path).update("\0");
      const file = await this.#existingFile(workspace, path);
      if (!file) continue;
      changedBytes += file.size;
      fingerprintHash.update(String(file.size)).update("\0");
      if (changedBytes <= MAX_CHANGED_BYTES) {
        fingerprintHash.update(await readFile(file.absolute));
      }
    }
    const statusLines = status.split("\n").filter(Boolean);
    return {
      root,
      clean: changedPaths.length === 0,
      changedFiles: changedPaths.length,
      changedLines,
      changedBytes,
      untrackedFiles: untrackedPaths.length,
      statusSummary: statusLines.slice(0, 100).join("\n"),
      fingerprint: fingerprintHash.digest("hex"),
    };
  }

  async headSha(workspaceInput: string): Promise<string> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const value = (await this.#git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], 16_384)).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new Error("INVALID_GIT_HEAD");
    return value;
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
