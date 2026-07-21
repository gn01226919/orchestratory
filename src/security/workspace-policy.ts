import { isAbsolute, relative, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { WorkspaceRootPolicy } from "../types.ts";
import { canonicalWorkspace } from "./workspace.ts";

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export class WorkspacePolicy {
  #roots: ReadonlyArray<Readonly<WorkspaceRootPolicy>>;

  constructor(roots: ReadonlyArray<Readonly<WorkspaceRootPolicy>>) {
    this.#roots = Object.freeze(roots.map((root) => Object.freeze({ ...root })));
  }

  /** Replace the allowlist in place (e.g. after an owner-approved change on disk). */
  replace(roots: ReadonlyArray<Readonly<WorkspaceRootPolicy>>): void {
    this.#roots = Object.freeze(roots.map((root) => Object.freeze({ ...root })));
  }

  static fromPaths(paths: readonly string[]): WorkspacePolicy {
    return new WorkspacePolicy(
      paths.map((path, index) => {
        const canonical = realpathSync(path);
        if (!statSync(canonical).isDirectory()) throw new Error("WORKSPACE_ROOT_NOT_DIRECTORY");
        return { id: `test-root-${index}`, label: `Test root ${index}`, path: canonical };
      }),
    );
  }

  roots(): WorkspaceRootPolicy[] {
    return this.#roots.map((root) => ({ ...root }));
  }

  allowsCanonical(candidate: string): boolean {
    return this.#roots.some((root) => inside(root.path, candidate));
  }

  async assertAllowed(input: string): Promise<string> {
    const candidate = await canonicalWorkspace(input);
    if (this.#roots.length === 0) throw new Error("WORKSPACE_ALLOWLIST_EMPTY");
    if (!this.allowsCanonical(candidate)) throw new Error("WORKSPACE_NOT_ALLOWLISTED");
    return candidate;
  }

  /** Resolve an allowed path to its most-specific configured workspace root. */
  async rootFor(input: string): Promise<string> {
    const candidate = await this.assertAllowed(input);
    const matching = this.#roots
      .filter((root) => inside(root.path, candidate))
      .sort((left, right) => right.path.length - left.path.length);
    if (!matching[0]) throw new Error("WORKSPACE_NOT_ALLOWLISTED");
    return matching[0].path;
  }
}
