export interface SupervisorOptions {
  workspace: string;
  branch: string;
  room: string;
  dataDirectory: string;
  statusFile: string;
  pendingFile: string;
  mirrorManifest: string;
  readDeadlineMs: number;
  reportDir: string;
  json?: boolean;
  help?: boolean;
}

export interface SupervisorCheck {
  name: string;
  status: "pass" | "fail";
  detail: string;
  value?: unknown;
}

export interface SupervisorAlert {
  code: string;
  detail: string;
  nextAction: string;
}

export interface SupervisorReport {
  schemaVersion: 2;
  supervisor: string;
  startedAt: string;
  finishedAt: string;
  workspace: string;
  branch: string;
  room: string;
  ok: boolean;
  checks: SupervisorCheck[];
  alerts: SupervisorAlert[];
  policy: {
    mutatingCommands: false;
    providerDispatch: false;
    mergePushPublishDeployDelete: false;
    filesystemReadDeadlineMs: number;
    iCloudReadByLaunchd: false;
    nextStepOnDrift: string;
  };
}

export function parseArgs(argv: string[]): SupervisorOptions;
export function audit(options: SupervisorOptions): Promise<SupervisorReport>;
