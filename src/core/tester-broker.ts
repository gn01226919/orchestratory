import { isAbsolute } from "node:path";
import type { TesterProfile, TestResult } from "../types.ts";
import { redact } from "../security/redact.ts";
import { canonicalWorkspace } from "../security/workspace.ts";
import {
  minimalSubscriptionEnvironment,
  resolveExecutable,
  runProcess,
} from "./process-runner.ts";

export interface TestRunRequest {
  profileId: string;
  workspace: string;
  timeoutMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
}

export interface TesterRunner {
  hasProfile(profileId: string): boolean;
  profiles(): Array<Pick<TesterProfile, "id" | "displayName" | "runtime" | "image">>;
  run(request: TestRunRequest): Promise<TestResult>;
}

export function buildContainerTestArguments(
  profile: Readonly<TesterProfile>,
  workspace: string,
): string[] {
  if (!isAbsolute(workspace) || workspace.includes("\0") || workspace.includes(",")) {
    throw new Error("TESTER_WORKSPACE_PATH_UNSUPPORTED");
  }
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--pids-limit=128",
    "--memory=2048m",
    "--memory-swap=2048m",
    "--cpus=2",
    "--user=65534:65534",
    "--hostname=orchestratory-test",
    "--workdir=/workspace",
    "--env=CI=1",
    "--env=HOME=/home/tester",
    "--env=TMPDIR=/tmp",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=512m",
    "--tmpfs=/home/tester:rw,noexec,nosuid,nodev,size=64m",
    `--mount=type=bind,source=${workspace},target=/workspace,readonly`,
    `--entrypoint=${profile.executable}`,
    profile.image,
    ...profile.args,
  ];
}

export class TesterBroker implements TesterRunner {
  readonly #profiles: ReadonlyMap<string, Readonly<TesterProfile>>;

  constructor(profiles: ReadonlyArray<Readonly<TesterProfile>>) {
    this.#profiles = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  hasProfile(profileId: string): boolean {
    return this.#profiles.has(profileId);
  }

  profiles(): Array<Pick<TesterProfile, "id" | "displayName" | "runtime" | "image">> {
    return [...this.#profiles.values()].map(({ id, displayName, runtime, image }) => ({
      id,
      displayName,
      runtime,
      image,
    }));
  }

  async run(request: TestRunRequest): Promise<TestResult> {
    const profile = this.#profiles.get(request.profileId);
    if (!profile) throw new Error("TESTER_PROFILE_NOT_CONFIGURED");
    if (request.timeoutMs <= 0 || request.outputLimitBytes <= 0) {
      throw new Error("INVALID_TESTER_LIMITS");
    }
    const workspace = await canonicalWorkspace(request.workspace);
    const result = await runProcess({
      executable: await resolveExecutable(profile.runtime),
      args: buildContainerTestArguments(profile, workspace),
      cwd: workspace,
      timeoutMs: request.timeoutMs,
      outputLimitBytes: request.outputLimitBytes,
      env: minimalSubscriptionEnvironment(),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (result.terminationReason) throw new Error(`TESTER_TERMINATED:${result.terminationReason}`);
    return {
      profileId: profile.id,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputBytes: result.outputBytes,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
    };
  }
}
