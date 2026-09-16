import type Database from 'better-sqlite3';

export interface ChatAutoArchiveSettings {
  enabled: boolean;
  inactivityDays: number;
}

export const DEFAULT_CHAT_AUTO_ARCHIVE_SETTINGS: ChatAutoArchiveSettings = {
  enabled: true,
  inactivityDays: 30,
};

const MIN_INACTIVITY_DAYS = 1;
const MAX_INACTIVITY_DAYS = 3650;

export function chatAutoArchiveSettingKey(userId: number | string): string {
  return `chat_auto_archive:${String(userId)}`;
}

function normalizedSettings(value: unknown): ChatAutoArchiveSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_CHAT_AUTO_ARCHIVE_SETTINGS;
  }
  const candidate = value as Partial<ChatAutoArchiveSettings>;
  const inactivityDays =
    typeof candidate.inactivityDays === 'number' &&
    Number.isInteger(candidate.inactivityDays) &&
    candidate.inactivityDays >= MIN_INACTIVITY_DAYS &&
    candidate.inactivityDays <= MAX_INACTIVITY_DAYS
      ? candidate.inactivityDays
      : DEFAULT_CHAT_AUTO_ARCHIVE_SETTINGS.inactivityDays;
  return {
    enabled:
      typeof candidate.enabled === 'boolean'
        ? candidate.enabled
        : DEFAULT_CHAT_AUTO_ARCHIVE_SETTINGS.enabled,
    inactivityDays,
  };
}

export function readChatAutoArchiveSettings(
  db: Database.Database,
  userId: number | string,
): ChatAutoArchiveSettings {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(chatAutoArchiveSettingKey(userId)) as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_CHAT_AUTO_ARCHIVE_SETTINGS };
  try {
    return normalizedSettings(JSON.parse(row.value_json));
  } catch {
    return { ...DEFAULT_CHAT_AUTO_ARCHIVE_SETTINGS };
  }
}

export function writeChatAutoArchiveSettings(
  db: Database.Database,
  userId: number | string,
  settings: ChatAutoArchiveSettings,
): ChatAutoArchiveSettings {
  const normalized = normalizedSettings(settings);
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(chatAutoArchiveSettingKey(userId), JSON.stringify(normalized));
  return normalized;
}

/**
 * Archive stale, unpinned web/email chats for one user and keep linked todos in
 * sync with manual archiving. The caller owns interrupting any returned chats.
 */
export function autoArchiveInactiveConversations(
  db: Database.Database,
  userId: number | string,
  settings = readChatAutoArchiveSettings(db, userId),
): string[] {
  if (!settings.enabled) return [];
  const cutoffModifier = `-${settings.inactivityDays} days`;
  const rows = db
    .prepare(
      `SELECT id
         FROM conversations
        WHERE user_id = ?
          AND archived = 0
          AND pin_order IS NULL
          AND channel <> 'automation'
          AND COALESCE(last_user_activity_at, last_active_at, created_at) < datetime('now', ?)`,
    )
    .all(userId, cutoffModifier) as { id: string }[];
  if (rows.length === 0) return [];

  const archiveConversation = db.prepare(
    'UPDATE conversations SET archived = 1 WHERE id = ? AND archived = 0 AND pin_order IS NULL',
  );
  const finishTodo = db.prepare(
    `UPDATE todos SET state = 'done', updated_at = datetime('now')
      WHERE conversation_id = ? AND state = 'active'`,
  );
  return db.transaction((candidates: { id: string }[]) => {
    const archived: string[] = [];
    for (const candidate of candidates) {
      const result = archiveConversation.run(candidate.id);
      if (result.changes === 0) continue;
      finishTodo.run(candidate.id);
      archived.push(candidate.id);
    }
    return archived;
  })(rows);
}
