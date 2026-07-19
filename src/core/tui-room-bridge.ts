import type { SessionDecision } from "./session.ts";
import { defaultRoomId, type RoomInfo, type RoomLedger, type RoomMessage } from "./room-ledger.ts";

/**
 * Select the exact Room used by a natural-language TUI session.
 *
 * A workspace with no Room gets one deterministic Room. Multiple Rooms require
 * an explicit selection so the TUI never silently writes to the oldest ledger.
 */
export function selectTuiRoom(
  ledger: RoomLedger,
  workspace: string,
  preferredRoomId?: string,
): RoomInfo {
  const rooms = ledger.listRooms().filter((room) => room.workspace === workspace);
  if (preferredRoomId) {
    const selected = rooms.find((room) => room.id === preferredRoomId);
    if (!selected) throw new Error("TUI_ROOM_WORKSPACE_MISMATCH");
    return selected;
  }
  if (rooms.length === 1) return rooms[0]!;
  if (rooms.length > 1) throw new Error("TUI_ROOM_SELECTION_REQUIRED");
  return ledger.createRoom(defaultRoomId(workspace), workspace);
}

/** Persist validated provider replies under their actual provider identity. */
export function recordTuiDecision(
  ledger: RoomLedger,
  roomId: string,
  decision: SessionDecision,
): RoomMessage[] {
  if (decision.kind === "message") {
    return [ledger.append(roomId, decision.source, decision.message)];
  }
  if (decision.kind === "compare") {
    return decision.answers.map((answer) => ledger.append(roomId, answer.provider, answer.message));
  }
  return [ledger.appendSystem(roomId, `TUI router 建議建立 coding team：${decision.input}`)];
}
