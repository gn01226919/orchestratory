import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/core/store.ts";
import { ProviderCallGovernor } from "../src/core/provider-call-governor.ts";
import { RoomLedger } from "../src/core/room-ledger.ts";
import { WriterDelegationStore } from "../src/core/writer-delegation.ts";
import { WorkflowRequestStore } from "../src/core/workflow-request-store.ts";
import { WriterLeaseStore } from "../src/core/writer-lease.ts";
import { CollaborationAuditLog } from "../src/core/collaboration-audit.ts";
import { ManagedRoomAgentStore } from "../src/core/managed-room-agent.ts";
import { RoomInboxStore } from "../src/core/room-inbox.ts";
import { RoomPresenceStore } from "../src/core/room-presence.ts";

interface ClosableStore {
  close(): void;
}

const STORES: ReadonlyArray<{
  name: string;
  filename: string;
  create(dataDirectory: string): ClosableStore;
}> = [
  { name: "local", filename: "orchestratory.sqlite", create: (data) => new LocalStore(data) },
  {
    name: "provider-governor",
    filename: "provider-governor.sqlite",
    create: (data) => new ProviderCallGovernor(data, 10),
  },
  { name: "room-ledger", filename: "rooms.sqlite", create: (data) => new RoomLedger(data) },
  {
    name: "writer-delegation",
    filename: "writer-delegations.sqlite",
    create: (data) => new WriterDelegationStore(data),
  },
  {
    name: "workflow-request",
    filename: "workflow-requests.sqlite",
    create: (data) => new WorkflowRequestStore(data),
  },
  { name: "writer-lease", filename: "writer-leases.sqlite", create: (data) => new WriterLeaseStore(data) },
  {
    name: "collaboration-audit",
    filename: "collaboration-audit.sqlite",
    create: (data) => new CollaborationAuditLog(data),
  },
  {
    name: "managed-agent",
    filename: "managed-room-agents.sqlite",
    create: (data) => new ManagedRoomAgentStore(data),
  },
  { name: "room-inbox", filename: "room-inbox.sqlite", create: (data) => new RoomInboxStore(data) },
  {
    name: "room-presence",
    filename: "room-presence.sqlite",
    create: (data) => new RoomPresenceStore(data),
  },
];

test("every SQLite store rejects unsafe database paths and sidecars", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-sqlite-security-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  for (const fixture of STORES) {
    const symlinkData = join(root, `${fixture.name}-symlink`);
    await mkdir(symlinkData, { mode: 0o700 });
    const symlinkTarget = join(symlinkData, "target.sqlite");
    await writeFile(symlinkTarget, "", { mode: 0o600 });
    await symlink(symlinkTarget, join(symlinkData, fixture.filename));
    assert.throws(() => fixture.create(symlinkData), /UNSAFE_SQLITE_FILE/u);

    const hardlinkData = join(root, `${fixture.name}-hardlink`);
    await mkdir(hardlinkData, { mode: 0o700 });
    const hardlinkTarget = join(hardlinkData, "target.sqlite");
    await writeFile(hardlinkTarget, "", { mode: 0o600 });
    await link(hardlinkTarget, join(hardlinkData, fixture.filename));
    assert.throws(() => fixture.create(hardlinkData), /UNSAFE_SQLITE_FILE/u);

    const permissiveData = join(root, `${fixture.name}-mode`);
    await mkdir(permissiveData, { mode: 0o700 });
    await writeFile(join(permissiveData, fixture.filename), "", { mode: 0o644 });
    assert.throws(() => fixture.create(permissiveData), /UNSAFE_SQLITE_FILE/u);

    const sidecarData = join(root, `${fixture.name}-sidecar`);
    await mkdir(sidecarData, { mode: 0o700 });
    const sidecarTarget = join(sidecarData, "target-wal");
    await writeFile(sidecarTarget, "", { mode: 0o600 });
    await symlink(sidecarTarget, join(sidecarData, `${fixture.filename}-wal`));
    assert.throws(() => fixture.create(sidecarData), /UNSAFE_SQLITE_SIDECAR/u);

    const unsafeDirectory = join(root, `${fixture.name}-directory`);
    await mkdir(unsafeDirectory, { mode: 0o755 });
    assert.throws(() => fixture.create(unsafeDirectory), /UNSAFE_SQLITE_DIRECTORY/u);
    await chmod(unsafeDirectory, 0o700);
  }
});
