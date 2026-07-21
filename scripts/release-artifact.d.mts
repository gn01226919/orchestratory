export const MAX_RELEASE_ARTIFACT_BYTES: number;
export function ensureOwnerOnlyDirectory(path: string): Promise<void>;
export function writeIdempotentArtifact(
  source: string,
  destination: string,
  expectedContent?: string,
): Promise<void>;
