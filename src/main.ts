import { stdin, stdout, stderr } from "node:process";
import { homedir } from "node:os";
import { execPath } from "node:process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { runDoctor } from "./doctor.ts";
import { safeSummary } from "./security/redact.ts";
import { helpText } from "./help.ts";

async function readStdin(maxBytes = 131_072): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("STDIN_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index < 0) return 4317;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("INVALID_PORT");
  return value;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "hybrid";
  if (command === "--help" || command === "-h" || command === "help") {
    stdout.write(helpText());
    return;
  }
  if (command === "--version" || command === "-v") {
    stdout.write("0.0.1\n");
    return;
  }
  if (command === "doctor") {
    const items = await runDoctor();
    for (const item of items) stdout.write(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}\n`);
    if (items.some((item) => !item.ok)) process.exitCode = 1;
    return;
  }
  if (command === "audit") {
    await import("../scripts/security-scan.mjs");
    await import("../scripts/history-scan.mjs");
    return;
  }

  const [{ createAppContext }, { runTui }, { startWebServer }, { parseWorkflowRequest }] =
    await Promise.all([
      import("./app.ts"),
      import("./ui/tui.ts"),
      import("./ui/web.ts"),
      import("./ui/request.ts"),
    ]);
  const app = await createAppContext();
  let nativePtyActive = false;
  const shutdown = (): void => {
    if (nativePtyActive) return;
    app.providerCalls.stopAll();
    for (const run of app.workflows.listActive()) app.workflows.cancel(run.id);
    if (command === "mcp") stdin.destroy();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    if (command === "mcp") {
      const { runCollabMcpServer } = await import("./mcp/collab-server.ts");
      const actorIndex = args.indexOf("--actor", 1);
      const actor = actorIndex >= 0 ? args[actorIndex + 1] : "mcp-host";
      if (!actor || actor === "you" || actor === "system" || !/^[a-z][a-z0-9-]{0,31}$/u.test(actor)) {
        throw new Error("INVALID_MCP_ACTOR");
      }
      await runCollabMcpServer(app, actor);
      return;
    }
    if (command === "web" || command === "gui") {
      const server = await startWebServer(app, parsePort(args.slice(1)));
      stdout.write(`Orchestratory GUI: ${server.url}\n請在瀏覽器開啟；按 Ctrl+C 關閉。\n`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await server.close();
      return;
    }
    if (command === "hybrid") {
      let server;
      try {
        server = await startWebServer(app, 4317);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("EADDRINUSE")) throw error;
        server = await startWebServer(app, 0);
      }
      try {
        await runTui(app, { guiUrl: server.url });
      } finally {
        await server.close();
      }
      return;
    }
    if (command === "run") {
      if (stdin.isTTY) throw new Error("RUN_REQUIRES_JSON_ON_STDIN");
      const body = JSON.parse(await readStdin()) as unknown;
      const request = parseWorkflowRequest(body, app.providers);
      const started = await app.workflows.start(request);
      stdout.write(`${JSON.stringify({ type: "run", runId: started.runId })}\n`);
      const emitted = new Set<number>();
      const writeEvent = (event: import("./types.ts").RunEvent): void => {
        if (event.id !== undefined && emitted.has(event.id)) return;
        if (event.id !== undefined) emitted.add(event.id);
        stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
      };
      const unsubscribe = app.events.subscribe(started.runId, writeEvent);
      for (const event of app.store.listEvents(started.runId)) writeEvent(event);
      const result = await started.completion;
      unsubscribe();
      stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
      if (result.status !== "completed") process.exitCode = 1;
      return;
    }
    if (command === "config" && args[1] === "show") {
      stdout.write(
        `${JSON.stringify({ hardLimits: app.hardLimits, workspaceRoots: app.workspaces.roots() }, null, 2)}\n`,
      );
      return;
    }
    if (command === "models" && args[1] === "list") {
      const id = args[2] as import("./types.ts").ProviderId | undefined;
      if (!id || !["fake", "codex", "claude", "grok"].includes(id)) {
        throw new Error("MODEL_PROVIDER_REQUIRED");
      }
      const authMode = args.includes("--api") ? "api" : "subscription";
      const models = await app.providers.listModels(id, authMode);
      stdout.write(models.length > 0 ? `${models.join("\n")}\n` : "No models discovered.\n");
      return;
    }
    if (command === "workspaces" && args[1] === "list") {
      const roots = app.workspaces.roots();
      stdout.write(
        roots.length > 0
          ? `${roots.map((root) => `${root.id}\t${root.label}\t${root.path}`).join("\n")}\n`
          : "No allowed workspace roots.\n",
      );
      return;
    }
    if (command === "workspaces" && args[1] === "allow") {
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("WORKSPACE_ALLOW_REQUIRES_TTY");
      const inputPath = args[2];
      if (!inputPath) throw new Error("WORKSPACE_ALLOW_PATH_REQUIRED");
      const canonical = await realpath(resolve(inputPath));
      const labelIndex = args.indexOf("--label", 3);
      const label = labelIndex >= 0 ? args[labelIndex + 1] : basename(canonical);
      if (!label) throw new Error("WORKSPACE_ALLOW_LABEL_REQUIRED");
      stdout.write(`About to allow this directory and all descendants:\n${canonical}\n`);
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question("Type ALLOW to save this owner-only policy: ")) !== "ALLOW") {
          stdout.write("Cancelled without changing the allowlist.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { saveWorkspaceRootPolicies } = await import("./config.ts");
      const roots = await saveWorkspaceRootPolicies(
        [
          ...app.workspaces.roots(),
          { id: `root-${randomUUID()}`, label, path: canonical },
        ],
        app.store.dataDirectory,
      );
      const saved = roots.find((root) => root.path === canonical);
      stdout.write(`Allowed: ${saved?.label ?? label} (${canonical})\n`);
      return;
    }
    if (command === "workspaces" && args[1] === "approve") {
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("WORKSPACE_APPROVE_REQUIRES_TTY");
      const { readFile: readFileAsync, writeFile: writeFileAsync } = await import("node:fs/promises");
      const pendingPath = join(app.store.dataDirectory, "pending-workspace-requests.json");
      let pending: Array<{ path: string; at: string }> = [];
      try {
        pending = JSON.parse(await readFileAsync(pendingPath, "utf8")) as typeof pending;
      } catch { pending = []; }
      if (!Array.isArray(pending) || pending.length === 0) {
        stdout.write("沒有待批准的專案授權申請。\n");
        return;
      }
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      const { saveWorkspaceRootPolicies } = await import("./config.ts");
      try {
        for (const item of pending) {
          let canonical: string;
          try {
            canonical = await realpath(resolve(item.path.replace(/^~(?=\/|$)/u, homedir())));
          } catch {
            stdout.write(`略過（路徑不存在）：${item.path}\n`);
            continue;
          }
          stdout.write(`GUI 申請授權（${item.at}）：\n${canonical}\n`);
          if ((await rl.question("輸入 ALLOW 批准這個資料夾（其他輸入＝拒絕）：")) === "ALLOW") {
            await saveWorkspaceRootPolicies(
              [...app.workspaces.roots(), { id: `root-${randomUUID()}`, label: basename(canonical), path: canonical }],
              app.store.dataDirectory,
            );
            stdout.write(`已授權：${canonical}\n`);
          } else {
            stdout.write("已拒絕。\n");
          }
        }
      } finally {
        rl.close();
      }
      await writeFileAsync(pendingPath, "[]", { encoding: "utf8", mode: 0o600 });
      stdout.write("申請清單已清空。重新整理 GUI 即可看到新專案（伺服器會自動重載授權清單）。\n");
      return;
    }
    if (command === "data" && args[1] === "inventory") {
      const { WorktreeBroker } = await import("./core/worktree-broker.ts");
      const { CollaborationService } = await import("./core/collaboration-service.ts");
      const retainedWorktreeRunIds = await new WorktreeBroker(
        app.store.dataDirectory,
      ).listRunIds();
      const collaboration = new CollaborationService(app.store.dataDirectory);
      try {
        stdout.write(
          `${JSON.stringify({
            ...app.store.inventory(),
            rooms: collaboration.ledger.inventory(),
            roomPresence: collaboration.presence.inventory(),
            roomInbox: collaboration.inbox.inventory(),
            managedRoomAgents: collaboration.managedAgents.inventory(),
            writerLeases: collaboration.writerLeases.inventory(),
            writerDelegations: collaboration.writerDelegations.inventory(),
            collaborationAudit: collaboration.audit.inventory(),
            providerCalls: app.providerCalls.status(),
            workflowRequests: app.workflowRequests.inventory(),
            retention: app.retention,
            retainedWorktreeRunIds,
          }, null, 2)}\n`,
        );
      } finally {
        collaboration.close();
      }
      return;
    }
    if (command === "data" && args[1] === "integrity") {
      const { CollaborationService } = await import("./core/collaboration-service.ts");
      const collaboration = new CollaborationService(app.store.dataDirectory);
      let roomReport, presenceReport, inboxReport, managedReport, writerReport, delegationReport, auditReport;
      try {
        roomReport = collaboration.ledger.integrity();
        presenceReport = collaboration.presence.integrity();
        inboxReport = collaboration.inbox.integrity();
        managedReport = collaboration.managedAgents.integrity();
        writerReport = collaboration.writerLeases.integrity();
        delegationReport = collaboration.writerDelegations.integrity();
        auditReport = collaboration.audit.integrity();
      } finally {
        collaboration.close();
      }
      const report = {
        runStore: app.store.integrity(),
        rooms: roomReport,
        roomPresence: presenceReport,
        roomInbox: inboxReport,
        managedRoomAgents: managedReport,
        writerLeases: writerReport,
        writerDelegations: delegationReport,
        collaborationAudit: auditReport,
        providerGovernor: app.providerCalls.integrity(),
        workflowRequests: app.workflowRequests.integrity(),
      };
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (
        report.runStore.foreignKeyViolations > 0 ||
        !report.runStore.auditChainValid ||
        report.rooms.foreignKeyViolations > 0 ||
        !report.rooms.auditChainValid ||
        report.roomPresence.quickCheck !== "ok" ||
        report.roomPresence.foreignKeyViolations > 0 ||
        !report.roomPresence.stateValid ||
        report.roomInbox.quickCheck !== "ok" ||
        !report.roomInbox.stateValid ||
        report.managedRoomAgents.quickCheck !== "ok" ||
        !report.managedRoomAgents.stateValid ||
        report.writerLeases.quickCheck !== "ok" ||
        !report.writerLeases.rowsValid ||
        report.writerDelegations.quickCheck !== "ok" ||
        !report.writerDelegations.rowsValid ||
        report.collaborationAudit.quickCheck !== "ok" ||
        !report.collaborationAudit.chainValid ||
        !report.providerGovernor.stateValid ||
        !report.workflowRequests.hashesValid
      ) process.exitCode = 1;
      return;
    }
    if (command === "data" && args[1] === "retention" && (args[2] ?? "show") === "show") {
      stdout.write(`${JSON.stringify(app.retention, null, 2)}\n`);
      return;
    }
    if (command === "data" && args[1] === "retention" && args[2] === "set") {
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("RETENTION_SET_REQUIRES_TTY");
      const daysIndex = args.indexOf("--terminal-days", 3);
      const runsIndex = args.indexOf("--max-runs", 3);
      const terminalRunDays = daysIndex >= 0 ? Number(args[daysIndex + 1]) : app.retention.terminalRunDays;
      const maxTerminalRuns = runsIndex >= 0 ? Number(args[runsIndex + 1]) : app.retention.maxTerminalRuns;
      const next = { ...app.retention, terminalRunDays, maxTerminalRuns };
      stdout.write(`${JSON.stringify(next, null, 2)}\n`);
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question("Type RETENTION to save this policy (no data is deleted now): ")) !== "RETENTION") {
          stdout.write("Cancelled without changing retention.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { saveRetentionPolicy } = await import("./config.ts");
      const saved = await saveRetentionPolicy(next, app.store.dataDirectory);
      stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
      return;
    }
    if (command === "data" && args[1] === "purge") {
      const preview = await app.maintenance.previewPurge(app.retention);
      stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      if (!args.includes("--execute") || preview.counts.runs === 0) {
        stdout.write(
          preview.counts.runs === 0
            ? "Nothing is eligible for purge.\n"
            : "Preview only. Re-run with --execute for an interactive, scoped purge.\n",
        );
        return;
      }
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("PURGE_REQUIRES_TTY");
      const expected = `PURGE ${preview.counts.runs} RUNS`;
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question(`Type ${expected} to irreversibly delete only this preview: `)) !== expected) {
          stdout.write("Cancelled without deleting data.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { dataPurgeApprovalScope } = await import("./security/approval.ts");
      const scope = dataPurgeApprovalScope(preview);
      const issued = app.approvals.issue("purge-data", scope, "local-tui");
      stdout.write(
        `${JSON.stringify({ deleted: app.maintenance.purge(preview, issued.token) }, null, 2)}\n`,
      );
      return;
    }
    if (command === "daemon") {
      const sub = args[1] ?? "status";
      const plistPath = join(homedir(), "Library", "LaunchAgents", "com.orchestratory.gui.plist");
      const { writeFile: writeFileAsync, rm: rmAsync, access } = await import("node:fs/promises");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      if (sub === "install") {
        const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
        const nodeDir = execPath.replace(/\/[^/]+$/u, "");
        const fullPath = (process.env.PATH ?? `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`)
          .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.orchestratory.gui</string>
  <key>ProgramArguments</key><array><string>${execPath}</string><string>${entry}</string><string>gui</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${fullPath}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/orchestratory-gui.log</string>
  <key>StandardErrorPath</key><string>/tmp/orchestratory-gui.log</string>
</dict></plist>
`;
        await writeFileAsync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
        try { await run("launchctl", ["unload", plistPath]); } catch { /* not loaded */ }
        await run("launchctl", ["load", "-w", plistPath]);
        stdout.write("GUI 常駐服務已安裝並啟動：登入自動開、當掉自動重啟、關終端機不影響。\n" +
          "http://127.0.0.1:4317 · 移除：orchestrator daemon uninstall\n");
        return;
      }
      if (sub === "uninstall") {
        try { await run("launchctl", ["unload", "-w", plistPath]); } catch { /* not loaded */ }
        await rmAsync(plistPath, { force: true });
        stdout.write("GUI 常駐服務已移除。\n");
        return;
      }
      if (sub === "status") {
        try {
          const result = await run("launchctl", ["list", "com.orchestratory.gui"]);
          stdout.write(`常駐中\n${result.stdout}`);
        } catch {
          stdout.write("未安裝或未執行。安裝：orchestrator daemon install\n");
        }
        return;
      }
      throw new Error("UNKNOWN_DAEMON_COMMAND");
    }
    if (command === "room") {
      const { defaultRoomId } = await import("./core/room-ledger.ts");
      const { CollaborationService } = await import("./core/collaboration-service.ts");
      const { sanitizeTerminal } = await import("./security/redact.ts");
      const collaboration = new CollaborationService(app.store.dataDirectory);
      const { ledger } = collaboration;
      try {
        const sub = args[1] ?? "status";
        const roomFlagIndex = args.indexOf("--room");
        const roomFlag = roomFlagIndex >= 0 ? args[roomFlagIndex + 1] : undefined;
        const resolveRoom = async () => {
          if (roomFlag) {
            const room = ledger.getRoom(roomFlag);
            if (!room) throw new Error("ROOM_NOT_FOUND");
            return room;
          }
          const { canonicalWorkspace } = await import("./security/workspace.ts");
          const room = ledger.roomForWorkspace(await canonicalWorkspace(process.cwd()));
          if (!room) throw new Error("ROOM_NOT_FOUND_FOR_CWD");
          return room;
        };
        const printRoom = (room: import("./core/room-ledger.ts").RoomInfo): void => {
          stdout.write(
            `room ${room.id} · 收錄 ${room.recording} · ${room.messages} 則 · ${(room.bytes / 1024).toFixed(1)} KiB\n` +
              `workspace ${room.workspace}\n`,
          );
        };
        const line = (message: import("./core/room-ledger.ts").RoomMessage): string =>
          `#${message.seq} ${message.at.slice(11, 19)} ${message.author.padEnd(7, " ")} ${sanitizeTerminal(message.text)}`;
        if (sub === "init") {
          const workspace = await app.workspaces.assertAllowed(process.cwd());
          const id = roomFlag ?? defaultRoomId(workspace);
          printRoom(ledger.createRoom(id, workspace));
          stdout.write("此專案的對話將入帳；orchestrator room pause 可隨時暫停。\n");
          return;
        }
        if (sub === "list") {
          for (const room of ledger.listRooms()) printRoom(room);
          return;
        }
        if (sub === "status") {
          const room = await resolveRoom();
          printRoom(room);
          stdout.write(`hash chain ${ledger.verifyChain(room.id) ? "valid" : "INVALID"}\n`);
          return;
        }
        if (sub === "writers") {
          const room = await resolveRoom();
          const view = collaboration.roomView(room.id, room.workspace);
          const active = view.writerLeases.filter((lease) => lease.state === "active");
          if (active.length === 0) stdout.write("目前沒有 active Writer Lease。\n");
          for (const lease of active) {
            stdout.write(
              `Writer ${sanitizeTerminal(lease.writer.displayName)} · task ${sanitizeTerminal(lease.taskId)} · ` +
              `epoch ${lease.epoch} · ${lease.companionId ? `via ${sanitizeTerminal(lease.companionId)}` : "native"}\n` +
              `  worktree ${sanitizeTerminal(lease.worktree)}\n`,
            );
            for (const child of view.writerDelegations.filter((item) =>
              item.parentLeaseId === lease.id && item.state === "active")) {
              stdout.write(
                `  └─ ${sanitizeTerminal(child.displayName)} · ${child.access} · ` +
                `executed_by ${sanitizeTerminal(child.executedBy)}\n`,
              );
            }
          }
          return;
        }
        if (sub === "audit") {
          const room = await resolveRoom();
          const limitIndex = args.indexOf("--limit");
          const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 50;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("AUDIT_RANGE_INVALID");
          const events = collaboration.audit.list({ roomId: room.id, limit });
          stdout.write(`HMAC audit chain ${collaboration.audit.verify() ? "valid" : "INVALID"}\n`);
          for (const event of events) {
            const who = event.onBehalfOf && event.executedBy
              ? `${sanitizeTerminal(event.onBehalfOf)} via ${sanitizeTerminal(event.executedBy)}`
              : sanitizeTerminal(event.actor);
            stdout.write(
              `#${event.seq} ${new Date(event.atMs).toISOString()} ${sanitizeTerminal(event.type)} ` +
              `· ${who}${event.leaseEpoch ? ` · epoch ${event.leaseEpoch}` : ""} · ${event.outcome}` +
              `${event.path ? ` · ${sanitizeTerminal(event.path)}` : ""}\n`,
            );
          }
          return;
        }
        if (sub === "pause" || sub === "resume" || sub === "off") {
          const state = sub === "pause" ? "paused" : sub === "resume" ? "on" : "off";
          printRoom(ledger.setRecording((await resolveRoom()).id, state));
          return;
        }
        if (sub === "presence-hook") {
          const providerIndex = args.indexOf("--provider");
          const provider = providerIndex >= 0 ? args[providerIndex + 1] : undefined;
          if (provider !== "codex" && provider !== "claude" && provider !== "grok") {
            throw new Error("INVALID_PRESENCE_PROVIDER");
          }
          try {
            const payload = JSON.parse(await readStdin()) as Record<string, unknown>;
            const { normalizePresenceHookPayload } = await import("./core/room-hooks.ts");
            const normalized = normalizePresenceHookPayload(payload);
            if (!normalized) return;
            const workspace = await app.workspaces.rootFor(normalized.cwd);
            collaboration.recordHook({
              provider,
              workspace,
              hostPid: process.ppid,
              sessionId: normalized.sessionId,
              event: normalized.event,
              ...(normalized.turnId ? { turnId: normalized.turnId } : {}),
              ...(normalized.text ? { text: normalized.text } : {}),
              ...(normalized.model ? { model: normalized.model } : {}),
            });
          } catch {
            // A logging hook must never interrupt or alter the host agent session.
          }
          return;
        }
        if (sub === "hooks") {
          const providerIndex = args.indexOf("--provider");
          const provider = providerIndex >= 0 ? args[providerIndex + 1] : "claude";
          if (provider !== "codex" && provider !== "claude" && provider !== "grok") {
            throw new Error("INVALID_PRESENCE_PROVIDER");
          }
          const { installRoomHooks, roomHooksPreview } = await import("./core/room-hooks.ts");
          if (!args.includes("--install")) {
            stdout.write(
              `以下 ${provider} hooks 只會替「已在 GUI 點加入」的 MCP 終端入帳；未加入時內容不保存：\n\n` +
              JSON.stringify(roomHooksPreview(provider), null, 2) +
              `\n\n預覽而已，尚未修改任何設定。\n由你本人執行安裝：orchestrator room hooks --provider ${provider} --install\n`,
            );
            return;
          }
          const installed = await installRoomHooks(provider);
          if (!installed.changed) {
            stdout.write("room hooks 已安裝過，未做任何變更。\n");
            return;
          }
          stdout.write(
            `room hooks 已安裝：${installed.path}${installed.backupPath ? `（原設定備份：${installed.backupPath}）` : ""}\n` +
            `新開的 ${provider} session 起生效；只有在 GUI 明確加入的 MCP 終端會入帳。` +
            (installed.trustReviewRequired ? "\nCodex 會要求你在 /hooks 畫面審核這組新命令。" : "") + "\n",
          );
          return;
        }
        if (sub === "log-hook") {
          // Legacy hooks could not prove explicit GUI membership. Fail closed so an
          // old user config never records a terminal that was not joined.
          if (!stdin.isTTY) await readStdin().catch(() => "");
          return;
        }
        if (sub === "log") {
          const authorIndex = args.indexOf("--author");
          const textIndex = args.indexOf("--text");
          const author = authorIndex >= 0 ? args[authorIndex + 1] : undefined;
          if (!author) throw new Error("ROOM_LOG_AUTHOR_REQUIRED");
          const text = textIndex >= 0 ? args[textIndex + 1] : stdin.isTTY ? undefined : await readStdin();
          if (!text || text.trim().length < 1) throw new Error("ROOM_LOG_TEXT_REQUIRED");
          const message = ledger.append((await resolveRoom()).id, author, text);
          stdout.write(`#${message.seq}\n`);
          return;
        }
        if (sub === "join") {
          throw new Error(
            "ROOM_JOIN_REQUIRES_MCP_TOOL: ask the current agent to call room_join_request directly; " +
            "do not run a shell command. Native PTY capture moved to: orchestrator room pty codex|grok",
          );
        }
        if (sub === "pty") {
          if (!stdin.isTTY || !stdout.isTTY) throw new Error("ROOM_PTY_REQUIRES_TTY");
          const { parseRoomPtyCliArgs, runRoomPty } = await import("./core/room-pty.ts");
          const selected = parseRoomPtyCliArgs(args);
          const { loadNativeRoomPtyEnabled } = await import("./config.ts");
          if (!(await loadNativeRoomPtyEnabled(app.store.dataDirectory))) {
            throw new Error("ROOM_PTY_OWNER_OPT_IN_REQUIRED");
          }
          const room = await resolveRoom();
          const workspace = await app.workspaces.assertAllowed(process.cwd());
          if (workspace !== room.workspace) throw new Error("ROOM_WORKSPACE_MISMATCH");
          if (room.recording !== "on") throw new Error("ROOM_RECORDING_NOT_ON");
          ledger.appendSystem(
            room.id,
            `▶ ${selected}-terminal joined via bounded local PTY; raw capture remains RAM-only.`,
          );
          nativePtyActive = true;
          try {
            const result = await runRoomPty(selected, workspace);
            if (result.transcript) ledger.append(room.id, result.author, result.transcript);
            ledger.appendSystem(
              room.id,
              `■ ${result.author} exited (${result.exitCode}${result.signal ? `, ${result.signal}` : ""}; ${Math.ceil(result.durationMs / 1_000)}s).`,
            );
            if (result.exitCode !== 0) process.exitCode = result.exitCode;
          } catch (error) {
            ledger.appendSystem(
              room.id,
              `■ ${selected}-terminal failed: ${safeSummary(error instanceof Error ? error.message : "UNKNOWN_ERROR", 300)}`,
            );
            throw error;
          } finally {
            nativePtyActive = false;
          }
          return;
        }
        if (sub === "tail") {
          const room = await resolveRoom();
          let cursor = Math.max(0, room.messages - 30);
          const print = () => {
            for (const message of ledger.listAfter(room.id, cursor)) {
              stdout.write(`${line(message)}\n`);
              cursor = Math.max(cursor, message.seq);
            }
          };
          print();
          if (!args.includes("--follow")) return;
          stdout.write("…following（Ctrl+C 離開）\n");
          await new Promise<void>((resolve) => {
            const timer = setInterval(print, 1_000);
            const stop = (): void => {
              clearInterval(timer);
              resolve();
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
          });
          return;
        }
        if (sub === "export") {
          const room = await resolveRoom();
          stdout.write(`# Room ${room.id}\n\n`);
          let cursor = 0;
          while (true) {
            const batch = ledger.listAfter(room.id, cursor);
            if (batch.length === 0) break;
            for (const message of batch) {
              stdout.write(`**#${message.seq} · ${message.author} · ${message.at}**\n\n${message.text}\n\n---\n\n`);
              cursor = message.seq;
            }
          }
          return;
        }
        throw new Error("UNKNOWN_ROOM_COMMAND");
      } finally {
        collaboration.close();
      }
    }
    if (command === "worktrees" && args[1] === "list") {
      const { WorktreeBroker } = await import("./core/worktree-broker.ts");
      const ids = await new WorktreeBroker(app.store.dataDirectory).listRunIds();
      stdout.write(ids.length > 0 ? `${ids.join("\n")}\n` : "No retained worktrees.\n");
      return;
    }
    if (command === "worktrees" && args[1] === "cleanup") {
      const runId = args[2] ?? "";
      const preview = await app.maintenance.previewWorktreeCleanup(runId);
      stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      if (!args.includes("--execute")) {
        stdout.write("Preview only. The branch is retained. Re-run with --execute for interactive removal.\n");
        return;
      }
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("WORKTREE_CLEANUP_REQUIRES_TTY");
      const expected = `REMOVE WORKTREE ${runId}`;
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if ((await rl.question(`Type ${expected} to remove only this clean worktree: `)) !== expected) {
          stdout.write("Cancelled without removing the worktree.\n");
          return;
        }
      } finally {
        rl.close();
      }
      const { worktreeCleanupApprovalScope } = await import("./security/approval.ts");
      const scope = worktreeCleanupApprovalScope(preview);
      const issued = app.approvals.issue("cleanup-worktree", scope, "local-tui");
      await app.maintenance.cleanupWorktree(preview, issued.token);
      stdout.write("Clean worktree removed. Its Git branch was retained.\n");
      return;
    }
    if (command !== "tui") throw new Error("UNKNOWN_COMMAND");
    await runTui(app);
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    if (app.workflows.listActive().length === 0) app.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    stderr.write(`Error: ${safeSummary(error instanceof Error ? error.message : "UNKNOWN_ERROR", 500)}\n`);
    process.exitCode = 1;
  });
}
