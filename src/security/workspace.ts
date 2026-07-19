import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface WorkspaceInspection {
  root: string;
  externalSymlinks: string[];
  scannedEntries: number;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function canonicalWorkspace(input: string): Promise<string> {
  if (input.includes("\0")) throw new Error("WORKSPACE_CONTAINS_NULL");
  const root = await realpath(resolve(input));
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
  return root;
}

export async function resolveExistingInside(root: string, input: string): Promise<string> {
  if (input.includes("\0")) throw new Error("PATH_CONTAINS_NULL");
  if (isAbsolute(input)) throw new Error("ABSOLUTE_PATH_DENIED");
  const candidate = await realpath(resolve(root, input));
  if (!isInside(root, candidate)) throw new Error("WORKSPACE_ESCAPE_DENIED");
  const info = await lstat(candidate);
  if (!info.isFile() && !info.isDirectory()) throw new Error("SPECIAL_FILE_DENIED");
  return candidate;
}

export async function inspectWorkspaceSymlinks(
  input: string,
  maxEntries = 100_000,
): Promise<WorkspaceInspection> {
  const root = await canonicalWorkspace(input);
  const externalSymlinks: string[] = [];
  let scannedEntries = 0;
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const directory = await opendir(current);
    for await (const entry of directory) {
      scannedEntries += 1;
      if (scannedEntries > maxEntries) throw new Error("WORKSPACE_SCAN_LIMIT_REACHED");
      if (entry.name === ".git") continue;
      const candidate = resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = await realpath(candidate);
          if (!isInside(root, target)) externalSymlinks.push(relative(root, candidate));
        } catch {
          externalSymlinks.push(relative(root, candidate));
        }
      } else if (entry.isDirectory()) {
        queue.push(candidate);
      } else if (!entry.isFile()) {
        throw new Error("SPECIAL_FILE_IN_WORKSPACE");
      }
    }
  }

  return { root, externalSymlinks, scannedEntries };
}
