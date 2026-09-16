import type Database from 'better-sqlite3';
import type { ConversationEvent } from '../runtime/events.js';
import type { ConversationMemoryMessage } from './supermemory.js';

const PRIVATE_BLOCK = /<private\b[^>]*>[\s\S]*?(?:<\/private>|$)/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const TOKEN_LIKE = /\b(?:sk-(?:or-v1-)?|gh[pousr]_|xox[baprs]-|shpat_)[A-Za-z0-9_-]{12,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[A-Z0-9]{16}\b/g;
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const LABELED_SECRET = /(\b(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|password|passwd|passcode|security[_ -]?code|one[- ]time[_ -]?code|private[_ -]?key|secret[_ -]?key|client[_ -]?secret|secret)\b\s*[:=]\s*)(["']?)([^\s"'`,;]{4,})\2/gi;
const HIGH_ENTROPY_VALUE = /\b(?=[A-Za-z0-9_+/=-]{32,}\b)(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]+\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_PAYMENT_NUMBER = /\b(?:\d[ -]*?){13,19}\b/g;
const LABELED_FINANCIAL_ID = /(\b(?:bank|checking|savings|account|card|routing|aba|iban|swift|wallet)(?:\s+(?:number|no\.?|ending(?:\s+in)?|last\s+four))?\s*(?:[:#=]|is|of)?\s*)\d[\d -]{2,}\b/gi;

function isCredentialReference(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{3,}$/.test(value) ||
    /^arn:aws(?:-[a-z]+)?:secretsmanager:/i.test(value) ||
    /^(?:<[^>]+>|\$\{[A-Z][A-Z0-9_]*\})$/.test(value);
}

export function memoryCaptureSettingKey(userId: number | string): string {
  // Deliberately versioned away from the legacy whole-transcript capture key.
  // Keeping that old key false prevents a pre-ship runner from repopulating a
  // freshly reset Supermemory while the Luna curator defaults on after ship.
  return `memory_curator_enabled:${String(userId)}`;
}

export function isMemoryCaptureEnabled(db: Database.Database, userId: number | string): boolean {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(memoryCaptureSettingKey(userId)) as
    | { value_json: string }
    | undefined;
  if (!row) return true;
  try {
    return JSON.parse(row.value_json) !== false;
  } catch {
    return true;
  }
}

export function setMemoryCaptureEnabled(db: Database.Database, userId: number | string, enabled: boolean): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(memoryCaptureSettingKey(userId), JSON.stringify(enabled));
}

/** Remove explicit private blocks and common credential shapes before external extraction. */
export function sanitizeMemoryText(value: string): string {
  return value
    .replace(PRIVATE_BLOCK, '[private content omitted]')
    .replace(PRIVATE_KEY_BLOCK, '[credential omitted]')
    .replace(TOKEN_LIKE, '[credential omitted]')
    .replace(AWS_ACCESS_KEY, '[credential omitted]')
    .replace(BEARER_TOKEN, '$1[credential omitted]')
    .replace(LABELED_SECRET, (match, label: string, _quote: string, secretValue: string) =>
      isCredentialReference(secretValue) ? match : `${label}[credential omitted]`)
    .replace(HIGH_ENTROPY_VALUE, (candidate) =>
      isCredentialReference(candidate) ? candidate : '[credential omitted]')
    .replace(SSN, '[sensitive identifier omitted]')
    .replace(LONG_PAYMENT_NUMBER, '[financial identifier omitted]')
    .replace(LABELED_FINANCIAL_ID, '$1[financial identifier omitted]')
    .trim();
}

/** User-visible text only: no system instructions, reasoning, or tool input/output. */
export function memoryMessagesFromEvents(events: ConversationEvent[]): ConversationMemoryMessage[] {
  const messages: ConversationMemoryMessage[] = [];
  for (const event of events) {
    const raw = event.type === 'turn_started' ? event.text : event.type === 'text_final' ? event.markdown : null;
    if (raw === null) continue;
    const content = sanitizeMemoryText(raw);
    if (!content) continue;
    messages.push({ role: event.type === 'turn_started' ? 'user' : 'assistant', content });
  }
  return messages;
}
