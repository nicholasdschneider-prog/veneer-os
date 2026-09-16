import type Database from 'better-sqlite3';

export type ChatListIconMode = 'provider' | 'creator';

export interface ChatAppearanceSettings {
  listIcon: ChatListIconMode;
}

export const DEFAULT_CHAT_APPEARANCE_SETTINGS: ChatAppearanceSettings = {
  listIcon: 'provider',
};

// No user suffix: one choice governs every account on this installation.
export const CHAT_APPEARANCE_SETTING_KEY = 'chat_appearance';

function normalizedSettings(value: unknown): ChatAppearanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_CHAT_APPEARANCE_SETTINGS };
  }
  const listIcon = (value as Partial<ChatAppearanceSettings>).listIcon;
  return {
    listIcon: listIcon === 'creator' ? 'creator' : 'provider',
  };
}

export function readChatAppearanceSettings(db: Database.Database): ChatAppearanceSettings {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(CHAT_APPEARANCE_SETTING_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_CHAT_APPEARANCE_SETTINGS };
  try {
    return normalizedSettings(JSON.parse(row.value_json));
  } catch {
    return { ...DEFAULT_CHAT_APPEARANCE_SETTINGS };
  }
}

export function writeChatAppearanceSettings(
  db: Database.Database,
  settings: ChatAppearanceSettings,
): ChatAppearanceSettings {
  const normalized = normalizedSettings(settings);
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(CHAT_APPEARANCE_SETTING_KEY, JSON.stringify(normalized));
  return normalized;
}
