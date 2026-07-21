import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";

export const MAX_RELEASE_ARTIFACT_BYTES = 16 * 1024 * 1024;

function ownerUid() {
  if (typeof process.getuid !== "function") throw new Error("RELEASE_ARTIFACT_POSIX_REQUIRED");
  return process.getuid();
}

function validateArtifactMetadata(metadata, path, expectedSize) {
  if (!metadata.isFile() || metadata.uid !== ownerUid() || metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 || metadata.size !== expectedSize) {
    throw new Error(`UNSAFE_RELEASE_ARTIFACT:${path}`);
  }
}

async function readBoundedRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 ||
        metadata.size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error(`INVALID_RELEASE_ARTIFACT_SOURCE:${path}`);
    }
    const content = await handle.readFile();
    if (content.length !== metadata.size) throw new Error(`RELEASE_ARTIFACT_SOURCE_CHANGED:${path}`);
    return content;
  } finally {
    await handle.close();
  }
}

export async function ensureOwnerOnlyDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== ownerUid() ||
      (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`UNSAFE_RELEASE_OUTPUT_DIRECTORY:${path}`);
  }
}

export async function writeIdempotentArtifact(source, destination, expectedContent) {
  const expected = expectedContent === undefined ?
    await readBoundedRegularFile(source) : Buffer.from(expectedContent, "utf8");
  if (expected.length < 1 || expected.length > MAX_RELEASE_ARTIFACT_BYTES) {
    throw new Error(`INVALID_RELEASE_ARTIFACT_SIZE:${destination}`);
  }

  let handle;
  try {
    handle = await open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await existing.stat();
      validateArtifactMetadata(metadata, destination, expected.length);
      const content = await existing.readFile();
      if (content.length !== expected.length || !content.equals(expected)) {
        throw new Error(`RELEASE_ARTIFACT_COLLISION:${destination}`);
      }
      return;
    } finally {
      await existing.close();
    }
  }

  try {
    await handle.writeFile(expected);
    await handle.sync();
    validateArtifactMetadata(await handle.stat(), destination, expected.length);
  } finally {
    await handle.close();
  }
}
