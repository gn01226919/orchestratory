import { homedir } from "node:os";

const ANSI_CSI = /\u001B\[[0-?]*[ -\/]*[@-~]/gu;
const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const AUTH_HEADER = /\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/giu;
const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s,"'}]+/giu;
const PROVIDER_KEYS = /\b(?:sk|xai|ant|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/gu;
const CODEX_RESUME_SESSION = /\bcodex\s+resume\s+[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;

export function sanitizeTerminal(value: string): string {
  return value
    .replace(ANSI_OSC, "[CONTROL_REMOVED]")
    .replace(ANSI_CSI, "")
    .replace(DISALLOWED_CONTROLS, "�");
}

export function redact(value: string): string {
  const home = homedir();
  let output = sanitizeTerminal(value)
    .replace(PRIVATE_KEY, "[PRIVATE_KEY_REDACTED]")
    .replace(AUTH_HEADER, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(PROVIDER_KEYS, "[PROVIDER_SECRET_REDACTED]")
    .replace(CODEX_RESUME_SESSION, "codex resume [SESSION_ID_REDACTED]")
    .replace(EMAIL, "[EMAIL_REDACTED]");
  if (home.length > 1) output = output.split(home).join("~");
  return output;
}

export function safeSummary(value: string, maxLength = 4_000): string {
  const cleaned = redact(value).trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}…[TRUNCATED]`;
}
