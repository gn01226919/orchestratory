export interface SupervisorMirrorOptions {
  statusSource: string;
  pendingSource: string;
  statusMirror: string;
  pendingMirror: string;
  manifest: string;
  readDeadlineMs: number;
  staleAfterSeconds: number;
  json?: boolean;
  help?: boolean;
}

export interface SupervisorMirrorManifest {
  schemaVersion: 1;
  mirroredAt: string;
  staleness: { staleAfterSeconds: number; expiresAt: string };
  files: Record<"status" | "pending", {
    source: string;
    mirror: string;
    digest: string;
    bytes: number;
  }>;
}

export function parseArgs(argv: string[]): SupervisorMirrorOptions;
export function refreshMirrors(options: SupervisorMirrorOptions): Promise<SupervisorMirrorManifest>;
