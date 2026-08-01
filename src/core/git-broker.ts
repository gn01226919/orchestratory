import { createHash } from "node:crypto";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
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
const CONTENT_FINGERPRINT_TIMEOUT_MS = 30_000;
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
