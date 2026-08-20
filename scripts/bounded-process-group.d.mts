export interface BoundedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  killGraceMs?: number;
}

export interface BoundedProcessResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null | string;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
  stderr: string;
}

export function runBoundedProcessGroup(
  file: string,
  args: string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult>;
