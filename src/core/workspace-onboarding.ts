import { randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { saveWorkspaceRootPolicies } from "../config.ts";
import type { WorkspaceRootPolicy } from "../types.ts";
import { WorkspacePolicy } from "../security/workspace-policy.ts";

export type WorkspacePreviewCheckStatus = "pass" | "warning" | "blocked";

export interface WorkspacePreviewCheck {
  id: "path" | "scope" | "owner" | "permissions" | "git" | "allowlist";
  label: string;
  status: WorkspacePreviewCheckStatus;
  detail: string;
}

export interface WorkspaceOnboardingPreview {
  id: string;
  requestedPath: string;
  canonicalPath: string;
  label: string;
  confirmation: string;
  expiresAt: string;
  blocked: boolean;
  resolvedSymlink: boolean;
  checks: WorkspacePreviewCheck[];
}

interface StoredPreview extends WorkspaceOnboardingPreview {
  identity: { dev: number; ino: number; mode: number; uid: number; gitDev?: number; gitIno?: number };
  expiresAtMs: number;
}

interface WorkspaceOnboardingOptions {
  dataDirectory: string;
  workspaces: WorkspacePolicy;
  homeDirectory?: string;
  now?: () => number;
  ttlMs?: number;
  maxPending?: number;
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function blocked(checks: WorkspacePreviewCheck[]): boolean {
  return checks.some((check) => check.status === "blocked");
}

async function scopeRisk(canonical: string, homeDirectory: string, dataDirectory: string): Promise<"sensitive" | "external" | undefined> {
  const canonicalHome = await realpath(homeDirectory).catch(() => homeDirectory);
  const canonicalData = await realpath(dataDirectory).catch(() => dataDirectory);
  const sensitiveCandidates = [
    join(canonicalHome, ".ssh"),
    join(canonicalHome, ".gnupg"),
    join(canonicalHome, ".aws"),
    join(canonicalHome, "Library", "Keychains"),
    canonicalData,
  ];
  const sensitiveRoots = await Promise.all(
    sensitiveCandidates.map(async (root) => await realpath(root).catch(() => root)),
  );
  if (
    canonical === "/" || canonical === canonicalHome ||
    sensitiveRoots.some((root) => inside(root, canonical))
  ) return "sensitive";
  if (inside("/Volumes", canonical)) return "external";
  return undefined;
}

export class WorkspaceOnboardingService {
  readonly #dataDirectory: string;
  readonly #workspaces: WorkspacePolicy;
  readonly #homeDirectory: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #previews = new Map<string, StoredPreview>();
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceOnboardingOptions) {
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#workspaces = options.workspaces;
    this.#homeDirectory = resolve(options.homeDirectory ?? homedir());
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maxPending = options.maxPending ?? 8;
    if (this.#ttlMs < 1_000 || this.#ttlMs > 15 * 60_000) throw new Error("INVALID_WORKSPACE_PREVIEW_TTL");
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1 || this.#maxPending > 20) {
      throw new Error("INVALID_WORKSPACE_PREVIEW_LIMIT");
    }
  }

  #cleanup(): void {
    const now = this.#now();
    for (const [id, preview] of this.#previews) {
      if (preview.expiresAtMs < now) this.#previews.delete(id);
    }
  }

  async preview(inputPath: string): Promise<WorkspaceOnboardingPreview> {
    if (
      typeof inputPath !== "string" || inputPath.trim().length < 1 ||
      inputPath.length > 4_096 || inputPath.includes("\0")
    ) throw new Error("INVALID_WORKSPACE_PATH");
    this.#cleanup();
    if (this.#previews.size >= this.#maxPending) throw new Error("WORKSPACE_PREVIEW_LIMIT_REACHED");

    const trimmed = inputPath.trim();
    const expanded = trimmed.replace(/^~(?=\/|$)/u, this.#homeDirectory);
    const requested = resolve(expanded);
    let canonical: string;
    let info;
    try {
      canonical = await realpath(requested);
      info = await stat(canonical);
    } catch {
      throw new Error("WORKSPACE_PATH_NOT_FOUND");
    }
    if (!info.isDirectory()) throw new Error("WORKSPACE_ROOT_NOT_DIRECTORY");

    const label = basename(canonical);
    const checks: WorkspacePreviewCheck[] = [];
    const resolvedSymlink = requested !== canonical;
    checks.push({
      id: "path",
      label: "路徑",
      status: "pass",
      detail: resolvedSymlink ? `已解析符號連結為 ${canonical}` : `Canonical path：${canonical}`,
    });

    const scope = await scopeRisk(canonical, this.#homeDirectory, this.#dataDirectory);
    checks.push({
      id: "scope",
      label: "安全範圍",
      status: scope ? "blocked" : "pass",
      detail: scope === "sensitive"
        ? "拒絕 Home、系統根目錄、憑證目錄或 Orchestratory 私有資料目錄。"
        : scope === "external"
          ? "Web 快速加入預設拒絕外接或網路磁碟；需要時請改用終端的 TTY 批准流程。"
          : "只會授權這個精確資料夾及其子目錄。",
    });

    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const ownerOk = uid === undefined || info.uid === uid;
    checks.push({
      id: "owner",
      label: "擁有者",
      status: ownerOk ? "pass" : "blocked",
      detail: ownerOk ? "資料夾由目前本機使用者擁有。" : "資料夾不屬於目前本機使用者。",
    });

    const worldWritable = (info.mode & 0o002) !== 0;
    checks.push({
      id: "permissions",
      label: "權限",
      status: worldWritable ? "blocked" : (info.mode & 0o020) !== 0 ? "warning" : "pass",
      detail: worldWritable
        ? "資料夾可被所有本機使用者寫入，已拒絕。"
        : (info.mode & 0o020) !== 0
          ? "資料夾允許同群組使用者寫入；加入前請確認這是預期設定。"
          : "未開放給其他本機使用者任意寫入。",
    });

    let gitRoot = false;
    let gitIdentity: { dev: number; ino: number } | undefined;
    try {
      const gitMarker = await lstat(join(canonical, ".git"));
      gitRoot = !gitMarker.isSymbolicLink() && (gitMarker.isDirectory() || gitMarker.isFile());
      if (gitRoot) gitIdentity = { dev: gitMarker.dev, ino: gitMarker.ino };
    } catch { /* missing .git is a blocked non-repository selection */ }
    checks.push({
      id: "git",
      label: "Git 專案",
      status: gitRoot ? "pass" : "blocked",
      detail: gitRoot ? "已確認選到 Git repository 根目錄。" : "請選擇含有 .git 的 repository 根目錄。",
    });

    const alreadyAllowed = this.#workspaces.allowsCanonical(canonical);
    const containsExisting = this.#workspaces.roots().filter((root) => inside(canonical, root.path));
    checks.push({
      id: "allowlist",
      label: "授權範圍",
      status: alreadyAllowed ? "blocked" : containsExisting.length > 0 ? "warning" : "pass",
      detail: alreadyAllowed
        ? "這個資料夾已在現有授權範圍內。"
        : containsExisting.length > 0
          ? `這會涵蓋 ${containsExisting.length} 個既有專案根目錄；請確認你確實要授權較大的父目錄。`
          : "不會重複既有授權。",
    });

    const safeLabel = label.length > 0 && label.length <= 100 && !/[\u0000-\u001F\u007F]/u.test(label);
    if (!safeLabel) {
      checks.push({ id: "path", label: "名稱", status: "blocked", detail: "資料夾名稱不適合顯示或確認。" });
    }
    const id = randomUUID();
    const expiresAtMs = this.#now() + this.#ttlMs;
    const preview: StoredPreview = {
      id,
      requestedPath: trimmed,
      canonicalPath: canonical,
      label: safeLabel ? label : "invalid-project",
      confirmation: `ALLOW ${safeLabel ? label : "invalid-project"}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      blocked: blocked(checks),
      resolvedSymlink,
      checks,
      identity: {
        dev: info.dev,
        ino: info.ino,
        mode: info.mode,
        uid: info.uid,
        ...(gitIdentity ? { gitDev: gitIdentity.dev, gitIno: gitIdentity.ino } : {}),
      },
    };
    this.#previews.set(id, preview);
    return this.#public(preview);
  }

  async confirm(id: string, confirmation: string): Promise<WorkspaceRootPolicy> {
    const execute = this.#writeQueue.then(async () => await this.#confirm(id, confirmation));
    this.#writeQueue = execute.then(() => undefined, () => undefined);
    return await execute;
  }

  async #confirm(id: string, confirmation: string): Promise<WorkspaceRootPolicy> {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("WORKSPACE_PREVIEW_NOT_FOUND");
    const preview = this.#previews.get(id);
    if (!preview) throw new Error("WORKSPACE_PREVIEW_NOT_FOUND");
    this.#previews.delete(id);
    if (preview.expiresAtMs < this.#now()) throw new Error("WORKSPACE_PREVIEW_EXPIRED");
    if (preview.blocked) throw new Error("WORKSPACE_PREVIEW_BLOCKED");
    if (confirmation !== preview.confirmation) throw new Error("WORKSPACE_CONFIRMATION_MISMATCH");

    let canonical: string;
    let info;
    try {
      canonical = await realpath(resolve(preview.requestedPath.replace(/^~(?=\/|$)/u, this.#homeDirectory)));
      info = await stat(canonical);
    } catch {
      throw new Error("WORKSPACE_PREVIEW_PATH_CHANGED");
    }
    let gitMarker;
    try {
      gitMarker = await lstat(join(canonical, ".git"));
    } catch {
      throw new Error("WORKSPACE_PREVIEW_PATH_CHANGED");
    }
    if (
      canonical !== preview.canonicalPath || !info.isDirectory() ||
      info.dev !== preview.identity.dev || info.ino !== preview.identity.ino ||
      info.mode !== preview.identity.mode || info.uid !== preview.identity.uid ||
      gitMarker.isSymbolicLink() || (!gitMarker.isDirectory() && !gitMarker.isFile()) ||
      gitMarker.dev !== preview.identity.gitDev || gitMarker.ino !== preview.identity.gitIno
    ) throw new Error("WORKSPACE_PREVIEW_PATH_CHANGED");
    if (await scopeRisk(canonical, this.#homeDirectory, this.#dataDirectory)) {
      throw new Error("WORKSPACE_PREVIEW_PATH_CHANGED");
    }

    const roots = this.#workspaces.roots();
    if (this.#workspaces.allowsCanonical(canonical)) throw new Error("WORKSPACE_ALREADY_ALLOWED");
    const root: WorkspaceRootPolicy = {
      id: `workspace-${randomUUID()}`,
      label: preview.label,
      path: canonical,
    };
    const saved = await saveWorkspaceRootPolicies([...roots, root], this.#dataDirectory);
    this.#workspaces.replace(saved);
    return { ...root };
  }

  #public(preview: StoredPreview): WorkspaceOnboardingPreview {
    return {
      id: preview.id,
      requestedPath: preview.requestedPath,
      canonicalPath: preview.canonicalPath,
      label: preview.label,
      confirmation: preview.confirmation,
      expiresAt: preview.expiresAt,
      blocked: preview.blocked,
      resolvedSymlink: preview.resolvedSymlink,
      checks: preview.checks.map((check) => ({ ...check })),
    };
  }
}
