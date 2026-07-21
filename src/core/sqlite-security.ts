import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwnerDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    const uid = ownerUid();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      (uid !== undefined && info.uid !== uid)
    ) throw new Error("UNSAFE_SQLITE_DIRECTORY");
  } catch (error) {
    if (error instanceof Error && error.message === "UNSAFE_SQLITE_DIRECTORY") throw error;
    throw new Error("UNSAFE_SQLITE_DIRECTORY");
  }
}

function ownerFile(path: string, errorCode: string, allowMissing: boolean): Stats | undefined {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (allowMissing && missing(error)) return undefined;
    throw new Error(errorCode);
  }
  const uid = ownerUid();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    (uid !== undefined && info.uid !== uid)
  ) throw new Error(errorCode);
  return info;
}

function assertSafeSidecars(path: string): void {
  for (const suffix of SIDECAR_SUFFIXES) {
    ownerFile(`${path}${suffix}`, "UNSAFE_SQLITE_SIDECAR", true);
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Opens one owner-only SQLite database without following an existing link.
 * DatabaseSync cannot accept an fd, so the pathname is verified immediately
 * before and after its constructor and before callers execute any SQL.
 */
export function openOwnerDatabase(path: string): DatabaseSync {
  assertOwnerDirectory(dirname(path));
  assertSafeSidecars(path);
  try {
    const descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error("UNSAFE_SQLITE_FILE");
    }
  }
  const before = ownerFile(path, "UNSAFE_SQLITE_FILE", false)!;
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
  } catch (error) {
    throw error;
  }
  try {
    const after = ownerFile(path, "UNSAFE_SQLITE_FILE", false)!;
    if (!sameIdentity(before, after)) throw new Error("UNSAFE_SQLITE_FILE");
    assertSafeSidecars(path);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Revalidates the main file and any SQLite-created WAL/SHM/journal sidecars. */
export function verifyOwnerDatabaseFiles(path: string): void {
  ownerFile(path, "UNSAFE_SQLITE_FILE", false);
  assertSafeSidecars(path);
}
