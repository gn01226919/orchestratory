import type { HardLimits, RetentionPolicy } from "./types.ts";
import {
  loadOrCreateApiModelPolicies,
  loadOrCreateHardLimits,
  loadOrCreateTesterProfiles,
  defaultDataDirectory,
  loadOrCreateWorkspaceRootPolicies,
  loadOrCreateRetentionPolicy,
  loadCodexWriterEnabled,
} from "./config.ts";
import { LocalStore } from "./core/store.ts";
import { RunEvents } from "./core/events.ts";
import { WorkflowService } from "./core/workflow.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { ApprovalService } from "./security/approval.ts";
import { TesterBroker } from "./core/tester-broker.ts";
import { WorkspacePolicy } from "./security/workspace-policy.ts";
import { MaintenanceService } from "./core/maintenance.ts";
import { ProviderCallGovernor } from "./core/provider-call-governor.ts";
import { WorkflowRequestStore } from "./core/workflow-request-store.ts";
import { DirtySnapshotService } from "./core/dirty-snapshot-broker.ts";
import { ApplyBackService } from "./core/apply-back-broker.ts";

export interface AppContext {
  hardLimits: Readonly<HardLimits>;
  providers: ProviderRegistry;
  store: LocalStore;
  events: RunEvents;
  workflows: WorkflowService;
  approvals: ApprovalService;
  testers: TesterBroker;
  workspaces: WorkspacePolicy;
  retention: Readonly<RetentionPolicy>;
  maintenance: MaintenanceService;
  providerCalls: ProviderCallGovernor;
  workflowRequests: WorkflowRequestStore;
  dirtySnapshots: DirtySnapshotService;
  applyBack: ApplyBackService;
  reloadWorkspaces(): Promise<void>;
  close(): void;
}

export async function createAppContext(dataDirectory = defaultDataDirectory()): Promise<AppContext> {
  const hardLimits = await loadOrCreateHardLimits(dataDirectory);
  const apiModels = await loadOrCreateApiModelPolicies(dataDirectory);
  const testerProfiles = await loadOrCreateTesterProfiles(dataDirectory);
  const workspaceRoots = await loadOrCreateWorkspaceRootPolicies(dataDirectory);
  const retention = await loadOrCreateRetentionPolicy(dataDirectory);
  const codexWriterEnabled = await loadCodexWriterEnabled(dataDirectory);
  const providerCalls = new ProviderCallGovernor(dataDirectory, hardLimits.maxProviderCalls);
  let store: LocalStore | undefined;
  let workflowRequests: WorkflowRequestStore | undefined;
  try {
    const providers = new ProviderRegistry(apiModels, { codexWriterEnabled, governor: providerCalls });
    const openedStore = new LocalStore(dataDirectory);
    store = openedStore;
    const openedWorkflowRequests = new WorkflowRequestStore(dataDirectory);
    workflowRequests = openedWorkflowRequests;
    openedStore.recoverInterruptedRuns();
    const events = new RunEvents(openedStore);
    const approvals = new ApprovalService();
    const testers = new TesterBroker(testerProfiles);
    const workspaces = new WorkspacePolicy(workspaceRoots);
    const dirtySnapshots = new DirtySnapshotService({ maxFiles: hardLimits.maxFilesChanged });
    const workflows = new WorkflowService({
      hardLimits: { ...hardLimits },
      providers,
      store: openedStore,
      events,
      approvals,
      testers,
      workspaces,
      providerStopEpoch: () => providerCalls.status().killEpoch,
      dirtySnapshots,
    });
    const applyBack = new ApplyBackService({
      store: openedStore,
      approvals,
      events,
      workspaces,
      maxFiles: hardLimits.maxFilesChanged,
    });
    const maintenance = new MaintenanceService({
      store: openedStore,
      approvals,
      activeRuns: () => workflows.listActive(),
    });
    let closed = false;
    return {
      hardLimits,
      providers,
      store: openedStore,
      events,
      workflows,
      approvals,
      testers,
      workspaces,
      retention,
      maintenance,
      providerCalls,
      workflowRequests: openedWorkflowRequests,
      dirtySnapshots,
      applyBack,
      reloadWorkspaces: async () => {
        try {
          const next = await loadOrCreateWorkspaceRootPolicies(dataDirectory);
          workspaces.replace(next);
        } catch {
          // Fail closed: keep the currently loaded allowlist rather than widening or crashing.
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        providerCalls.close();
        dirtySnapshots.clear();
        applyBack.clear();
        openedWorkflowRequests.close();
        openedStore.close();
      },
    };
  } catch (error) {
    store?.close();
    workflowRequests?.close();
    providerCalls.close();
    throw error;
  }
}
