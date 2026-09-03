import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redact, safeSummary } from "../security/redact.ts";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";

export type RoomRecording = "on" | "paused" | "off";
export type RoomMessageKind = "chat" | "system";

export interface RoomInfo {
  id: string;
  workspace: string;
  createdAt: string;
  recording: RoomRecording;
  messages: number;
  bytes: number;
}

export interface RoomMessage {
  roomId: string;
  seq: number;
  at: string;
  author: string;
  kind: RoomMessageKind;
  text: string;
  hash: string;
}

export interface RoomInventory {
  database: string;
  schemaVersion: number;
  databaseBytes: number;
  rooms: number;
  messages: number;
  contentBytes: number;
  recording: Record<RoomRecording, number>;
}

export interface RoomIntegrity {
  schemaVersion: number;
  quickCheck: "ok";
  foreignKeyViolations: number;
  rooms: number;
  auditChainValid: boolean;
}

const ROOM_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const AUTHOR_PATTERN = /^(?:[a-z][a-z0-9-]{0,31}|(?:codex|claude|grok)（[\p{L}\p{N}._ -]{1,24}）)$/u;
const MAX_MESSAGE_CHARS = 16_384;
const MAX_ROOM_MESSAGES = 5_000;
const MAX_ROOM_BYTES = 8 * 1_048_576;
const MAX_RANGE_MESSAGES = 100;
const MAX_SEARCH_RESULTS = 20;
const MAX_QUERY_CHARS = 200;
const ROOM_SCHEMA_VERSION = 2;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,160}$/u;

function messageHash(input: {
  roomId: string;
  seq: number;
  at: string;
  author: string;
  kind: string;
  text: string;
  previousHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.roomId,
        input.seq,
        input.at,
        input.author,
        input.kind,
        input.text,
        input.previousHash,
      ]),
      "utf8",
    )
    .digest("hex");
}

function validRoomId(id: unknown): string {
  if (typeof id !== "string" || !ROOM_ID_PATTERN.test(id)) throw new Error("INVALID_ROOM_ID");
  return id;
}

function validAuthor(author: unknown): string {
  if (typeof author !== "string" || author === "system" || !AUTHOR_PATTERN.test(author)) {
    throw new Error("INVALID_ROOM_AUTHOR");
  }
  return author;
}

export function defaultRoomId(workspace: string): string {
  const slug = basename(workspace)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  const suffix = createHash("sha256").update(workspace, "utf8").digest("hex").slice(0, 8);
  return /^[a-z]/u.test(slug) ? `${slug}-${suffix}` : `room-${slug || "default"}-${suffix}`;
}

/**
 * Append-only, numbered, tamper-evident shared conversation ledger.
 * Content is redacted before it is persisted; nothing here is a secrets channel.
 * Stored in its own owner-only SQLite file so the run store's schema and audit
 * chain stay untouched.
 */
export class RoomLedger {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, "rooms.sqlite");
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;");
      verifyOwnerDatabaseFiles(this.path);
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("ROOM_LEDGER_CORRUPT");
      const versionRow = this.#db.prepare("PRAGMA user_version").get() as { user_version?: number };
      const version = Number(versionRow.user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0 || version > ROOM_SCHEMA_VERSION) {
        throw new Error("ROOM_LEDGER_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.exec(`
            CREATE TABLE IF NOT EXISTS rooms (
              id TEXT PRIMARY KEY,
              workspace TEXT NOT NULL,
              created_at TEXT NOT NULL,
              recording TEXT NOT NULL DEFAULT 'on'
                CHECK (recording IN ('on', 'paused', 'off'))
            );
            CREATE TABLE IF NOT EXISTS room_messages (
              room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
              seq INTEGER NOT NULL,
              at TEXT NOT NULL,
              author TEXT NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('chat', 'system')),
              text TEXT NOT NULL,
              hash TEXT NOT NULL,
              PRIMARY KEY (room_id, seq)
            );
            CREATE TABLE IF NOT EXISTS room_message_idempotency (
              idempotency_key TEXT PRIMARY KEY,
              room_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              payload_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (room_id, seq) REFERENCES room_messages(room_id, seq) ON DELETE CASCADE
            );
            PRAGMA user_version = 2;
          `);
          this.#db.exec("COMMIT");
        } catch (error) {
          this.#db.exec("ROLLBACK");
          throw error;
        }
      } else if (version === 1) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.exec(`
            CREATE TABLE room_message_idempotency (
              idempotency_key TEXT PRIMARY KEY,
              room_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              payload_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (room_id, seq) REFERENCES room_messages(room_id, seq) ON DELETE CASCADE
            );
            PRAGMA user_version = 2;
          `);
          this.#db.exec("COMMIT");
        } catch (error) {
          this.#db.exec("ROLLBACK");
          throw error;
        }
      }
      const foreignKeyViolations = this.#db.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyViolations.length > 0) throw new Error("ROOM_LEDGER_FOREIGN_KEY_VIOLATION");
      const roomRows = this.#db.prepare("SELECT id FROM rooms ORDER BY id").all() as Array<{ id: string }>;
      for (const row of roomRows) {
        validRoomId(row.id);
        if (!this.verifyChain(row.id)) throw new Error("ROOM_LEDGER_AUDIT_CHAIN_INVALID");
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  createRoom(id: string, workspace: string): RoomInfo {
    validRoomId(id);
    if (typeof workspace !== "string" || workspace.length < 1 || workspace.length > 4_096) {
      throw new Error("INVALID_ROOM_WORKSPACE");
    }
    const existing = this.getRoom(id);
    if (existing) throw new Error("ROOM_ALREADY_EXISTS");
    this.#db
      .prepare("INSERT INTO rooms (id, workspace, created_at, recording) VALUES (?, ?, ?, 'on')")
      .run(id, workspace, new Date().toISOString());
    this.appendSystem(id, "收錄開始（room init）");
    return this.getRoom(id)!;
  }

  getRoom(id: string): RoomInfo | undefined {
    validRoomId(id);
    const row = this.#db
      .prepare("SELECT id, workspace, created_at, recording FROM rooms WHERE id = ?")
      .get(id) as
      | { id: string; workspace: string; created_at: string; recording: RoomRecording }
      | undefined;
    if (!row) return undefined;
    const stats = this.#db
      .prepare(
        "SELECT COUNT(*) AS messages, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM room_messages WHERE room_id = ?",
      )
      .get(id) as { messages: number; bytes: number };
    return {
      id: row.id,
      workspace: row.workspace,
      createdAt: row.created_at,
      recording: row.recording,
      messages: Number(stats.messages),
      bytes: Number(stats.bytes),
    };
  }

  inventory(): RoomInventory {
    const schema = this.#db.prepare("PRAGMA user_version").get() as { user_version?: number };
    const totals = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM rooms) AS rooms,
        (SELECT COUNT(*) FROM room_messages) AS messages,
        (SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM room_messages) AS content_bytes,
        (SELECT COUNT(*) FROM rooms WHERE recording = 'on') AS recording_on,
        (SELECT COUNT(*) FROM rooms WHERE recording = 'paused') AS recording_paused,
        (SELECT COUNT(*) FROM rooms WHERE recording = 'off') AS recording_off
    `).get() as Record<string, unknown>;
    return {
      database: this.path,
      schemaVersion: Number(schema.user_version),
      databaseBytes: statSync(this.path).size,
      rooms: Number(totals.rooms),
      messages: Number(totals.messages),
      contentBytes: Number(totals.content_bytes),
      recording: {
        on: Number(totals.recording_on),
        paused: Number(totals.recording_paused),
        off: Number(totals.recording_off),
      },
    };
  }

  integrity(): RoomIntegrity {
    const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
    if (quick.quick_check !== "ok") throw new Error("ROOM_LEDGER_CORRUPT");
    const schema = this.#db.prepare("PRAGMA user_version").get() as { user_version?: number };
    const roomRows = this.#db.prepare("SELECT id FROM rooms ORDER BY id").all() as Array<{ id: string }>;
    return {
      schemaVersion: Number(schema.user_version),
      quickCheck: "ok",
      foreignKeyViolations: this.#db.prepare("PRAGMA foreign_key_check").all().length,
      rooms: roomRows.length,
      auditChainValid: roomRows.every((row) => this.verifyChain(row.id)),
    };
  }

  roomForWorkspace(workspace: string): RoomInfo | undefined {
    const row = this.#db
      .prepare("SELECT id FROM rooms WHERE workspace = ? ORDER BY created_at LIMIT 1")
      .get(workspace) as { id: string } | undefined;
    return row ? this.getRoom(row.id) : undefined;
  }

  authorStats(id: string): Array<{ author: string; messages: number; chars: number }> {
    if (!this.getRoom(id)) throw new Error("ROOM_NOT_FOUND");
    const rows = this.#db
      .prepare(
        "SELECT author, COUNT(*) AS messages, SUM(LENGTH(text)) AS chars FROM room_messages WHERE room_id = ? AND kind = 'chat' GROUP BY author ORDER BY messages DESC",
      )
      .all(id) as Array<{ author: string; messages: number; chars: number }>;
    return rows.map((row) => ({ author: row.author, messages: Number(row.messages), chars: Number(row.chars) }));
  }

  listRooms(): RoomInfo[] {
    const rows = this.#db.prepare("SELECT id FROM rooms ORDER BY created_at").all() as Array<{
      id: string;
    }>;
    return rows.map((row) => this.getRoom(row.id)!).filter(Boolean);
  }

  setRecording(id: string, recording: RoomRecording): RoomInfo {
    const room = this.getRoom(id);
    if (!room) throw new Error("ROOM_NOT_FOUND");
    if (!["on", "paused", "off"].includes(recording)) throw new Error("INVALID_ROOM_RECORDING");
    if (room.recording !== recording) {
      this.#db.prepare("UPDATE rooms SET recording = ? WHERE id = ?").run(recording, id);
      const label = recording === "on" ? "▶ 收錄恢復" : recording === "paused" ? "⏸ 收錄暫停" : "■ 收錄關閉";
      this.appendSystem(id, label);
    }
    return this.getRoom(id)!;
  }

  append(roomId: string, author: string, text: string): RoomMessage {
    return this.#append(roomId, validAuthor(author), text, "chat");
  }

  appendIdempotent(roomId: string, author: string, text: string, idempotencyKey: string): RoomMessage {
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new Error("INVALID_ROOM_IDEMPOTENCY_KEY");
    }
    return this.#append(roomId, validAuthor(author), text, "chat", idempotencyKey);
  }

  getByIdempotencyKey(idempotencyKey: string): RoomMessage | undefined {
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new Error("INVALID_ROOM_IDEMPOTENCY_KEY");
    }
    const row = this.#db
      .prepare(`SELECT m.room_id, m.seq, m.at, m.author, m.kind, m.text, m.hash
        FROM room_message_idempotency i
        JOIN room_messages m ON m.room_id = i.room_id AND m.seq = i.seq
        WHERE i.idempotency_key = ?`)
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? this.#row(row) : undefined;
  }

  /*
   * Whether any message was recorded under a key starting with this prefix.
   *
   * Narrow on purpose: it answers "has this happened at all", not "give me the rows". Added because
   * the alternative in use was to write a SECOND ledger line as a marker, keyed differently, which
   * produced two identical lines the first time -- and for a divider whose whole job is to show a
   * reader where one line of work ended, two of them is worse than none.
   *
   * Expressed as a half-open range rather than LIKE, for two measured reasons. `EXPLAIN QUERY PLAN`
   * reports SCAN for the LIKE form and SEARCH ... (key>? AND key<?) for this one: SQLite disables
   * its LIKE optimization whenever an ESCAPE clause is present, so the earlier version walked the
   * whole primary-key index while a comment above it claimed the opposite. And LIKE is ASCII
   * case-insensitive by default, which made a method named "prefix" quietly answer true for a key
   * differing only in case -- confirmed by inserting an upper-case row and matching it with a
   * lower-case prefix. Today's keys are all lower-case so nothing mis-matched, but
   * IDEMPOTENCY_KEY_PATTERN admits A-Z, so that was a trap left for the next caller rather than a
   * property of the data. A range comparison is BINARY, which is the collation the key is stored
   * and compared under everywhere else.
   *
   * The upper bound increments the last character. The reason first written here was wrong -- it said
   * no legal key can fall between a character and its successor, which is false twice over: `-` is
   * followed by `.` and `9` by `:`, and both of those are in the alphabet. The bound is exact anyway,
   * and for a reason that has nothing to do with the alphabet: under byte comparison the strings
   * greater than or equal to P and less than P-with-its-last-byte-incremented are exactly the strings
   * beginning with P. Verified rather than argued -- every key of length 1 to 3 over the boundary
   * characters was matched against 1110 prefixes and agreed with `startsWith` in every case.
   *
   * It also removes the escaping question entirely: with no wildcards there is nothing for `%` or `_`
   * to mean.
   */
  hasIdempotencyKeyPrefix(prefix: string): boolean {
    if (typeof prefix !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(prefix)) {
      throw new Error("INVALID_ROOM_IDEMPOTENCY_KEY");
    }
    const last = prefix.charCodeAt(prefix.length - 1);
    /* The pattern already guarantees this, so it can only fail if the pattern is widened later --
       at which point the upper bound below would silently start excluding legal keys. */
    if (!Number.isInteger(last) || last >= 0x7f) throw new Error("INVALID_ROOM_IDEMPOTENCY_KEY");
    const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
    const row = this.#db
      .prepare(
        `SELECT 1 AS found FROM room_message_idempotency
         WHERE idempotency_key >= ? AND idempotency_key < ? LIMIT 1`,
      )
      .get(prefix, upperBound) as { found: number } | undefined;
    return Boolean(row);
  }

  /*
   * Whether this author wrote anything after `afterSeq`.
   *
   * Narrow on purpose, and specifically NOT `listAfter(...).some(...)`. `listAfter` takes the FIRST
   * `MAX_RANGE_MESSAGES` after the sequence and clamps any larger limit down to it, so in a room
   * with several live seats another seat writing that many messages between a mark and this seat's
   * own line pushes that line out of the window -- and the caller, asking "did I write", gets told
   * no. That is a wrong answer, not a truncated one.
   *
   * The primary key is (room_id, seq), so the range is an index seek and the author is a filter
   * over exactly the rows after the mark. No limit is involved, which is why none can be exceeded.
   */
  hasAuthorMessageAfter(roomId: string, afterSeq: number, author: string): boolean {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("INVALID_ROOM_SEQ");
    if (typeof author !== "string" || author.length === 0) throw new Error("INVALID_ROOM_AUTHOR");
    const row = this.#db
      .prepare(
        "SELECT 1 AS found FROM room_messages WHERE room_id = ? AND seq > ? AND author = ? LIMIT 1",
      )
      .get(roomId, afterSeq, author) as { found: number } | undefined;
    return Boolean(row);
  }

  appendSystem(roomId: string, text: string): RoomMessage {
    return this.#append(roomId, "system", text, "system");
  }

  appendSystemIdempotent(roomId: string, text: string, idempotencyKey: string): RoomMessage {
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new Error("INVALID_ROOM_IDEMPOTENCY_KEY");
    }
    return this.#append(roomId, "system", text, "system", idempotencyKey);
  }

  #append(
    roomId: string,
    author: string,
    text: string,
    kind: RoomMessageKind,
    idempotencyKey?: string,
  ): RoomMessage {
    if (typeof text !== "string" || text.trim().length < 1) throw new Error("INVALID_ROOM_MESSAGE");
    if (text.includes("\0")) throw new Error("ROOM_BINARY_MESSAGE_DENIED");
    const cleaned = safeSummary(redact(text), MAX_MESSAGE_CHARS);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify([roomId, author, kind, cleaned]), "utf8")
      .digest("hex");
    const at = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const room = this.getRoom(roomId);
      if (!room) throw new Error("ROOM_NOT_FOUND");
      if (kind === "chat") {
        if (room.recording === "paused") throw new Error("ROOM_RECORDING_PAUSED");
        if (room.recording === "off") throw new Error("ROOM_RECORDING_OFF");
      }
      if (room.messages >= MAX_ROOM_MESSAGES || room.bytes >= MAX_ROOM_BYTES) {
        throw new Error("ROOM_LEDGER_FULL");
      }
      if (idempotencyKey) {
        const existing = this.#db
          .prepare("SELECT room_id, seq, payload_hash FROM room_message_idempotency WHERE idempotency_key = ?")
          .get(idempotencyKey) as { room_id: string; seq: number; payload_hash: string } | undefined;
        if (existing) {
          if (existing.room_id !== roomId || existing.payload_hash !== payloadHash) {
            throw new Error("ROOM_IDEMPOTENCY_CONFLICT");
          }
          const row = this.#db
            .prepare("SELECT room_id, seq, at, author, kind, text, hash FROM room_messages WHERE room_id = ? AND seq = ?")
            .get(roomId, existing.seq) as Record<string, unknown> | undefined;
          if (!row) throw new Error("ROOM_IDEMPOTENCY_TARGET_MISSING");
          this.#db.exec("COMMIT");
          return this.#row(row);
        }
      }
      const last = this.#db
        .prepare("SELECT seq, hash FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1")
        .get(roomId) as { seq: number; hash: string } | undefined;
      const seq = (last?.seq ?? 0) + 1;
      const hash = messageHash({
        roomId,
        seq,
        at,
        author,
        kind,
        text: cleaned,
        previousHash: last?.hash ?? "genesis",
      });
      this.#db
        .prepare(
          "INSERT INTO room_messages (room_id, seq, at, author, kind, text, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(roomId, seq, at, author, kind, cleaned, hash);
      if (idempotencyKey) {
        this.#db
          .prepare("INSERT INTO room_message_idempotency (idempotency_key, room_id, seq, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(idempotencyKey, roomId, seq, payloadHash, at);
      }
      this.#db.exec("COMMIT");
      return { roomId, seq, at, author, kind, text: cleaned, hash };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listAfter(roomId: string, afterSeq: number, limit = MAX_RANGE_MESSAGES): RoomMessage[] {
    if (!this.getRoom(roomId)) throw new Error("ROOM_NOT_FOUND");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("INVALID_ROOM_SEQ");
    const bounded = Math.max(1, Math.min(limit, MAX_RANGE_MESSAGES));
    return (this.#db
      .prepare(
        "SELECT room_id, seq, at, author, kind, text, hash FROM room_messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(roomId, afterSeq, bounded) as Array<Record<string, unknown>>).map(this.#row);
  }

  getRange(roomId: string, fromSeq: number, toSeq: number): RoomMessage[] {
    if (!this.getRoom(roomId)) throw new Error("ROOM_NOT_FOUND");
    if (
      !Number.isSafeInteger(fromSeq) ||
      !Number.isSafeInteger(toSeq) ||
      fromSeq < 1 ||
      toSeq < fromSeq ||
      toSeq - fromSeq + 1 > MAX_RANGE_MESSAGES
    ) {
      throw new Error("INVALID_ROOM_RANGE");
    }
    return (this.#db
      .prepare(
        "SELECT room_id, seq, at, author, kind, text, hash FROM room_messages WHERE room_id = ? AND seq BETWEEN ? AND ? ORDER BY seq",
      )
      .all(roomId, fromSeq, toSeq) as Array<Record<string, unknown>>).map(this.#row);
  }

  search(roomId: string, query: string): RoomMessage[] {
    if (!this.getRoom(roomId)) throw new Error("ROOM_NOT_FOUND");
    if (typeof query !== "string" || query.trim().length < 1 || query.length > MAX_QUERY_CHARS) {
      throw new Error("INVALID_ROOM_QUERY");
    }
    if (query.includes("\0")) throw new Error("INVALID_ROOM_QUERY");
    const escaped = query.replace(/[\\%_]/gu, (char) => `\\${char}`);
    return (this.#db
      .prepare(
        "SELECT room_id, seq, at, author, kind, text, hash FROM room_messages WHERE room_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?",
      )
      .all(roomId, `%${escaped}%`, MAX_SEARCH_RESULTS) as Array<Record<string, unknown>>)
      .map(this.#row)
      .reverse();
  }

  verifyChain(roomId: string): boolean {
    if (!this.getRoom(roomId)) throw new Error("ROOM_NOT_FOUND");
    const rows = (this.#db
      .prepare(
        "SELECT room_id, seq, at, author, kind, text, hash FROM room_messages WHERE room_id = ? ORDER BY seq",
      )
      .all(roomId) as Array<Record<string, unknown>>).map(this.#row);
    let previousHash = "genesis";
    for (const [index, row] of rows.entries()) {
      if (row.seq !== index + 1) return false;
      const expected = messageHash({
        roomId: row.roomId,
        seq: row.seq,
        at: row.at,
        author: row.author,
        kind: row.kind,
        text: row.text,
        previousHash,
      });
      if (expected !== row.hash) return false;
      previousHash = row.hash;
    }
    return true;
  }

  readonly #row = (row: Record<string, unknown>): RoomMessage => ({
    roomId: String(row.room_id),
    seq: Number(row.seq),
    at: String(row.at),
    author: String(row.author),
    kind: row.kind === "system" ? "system" : "chat",
    text: String(row.text),
    hash: String(row.hash),
  });
}
