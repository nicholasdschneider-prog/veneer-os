import type Database from 'better-sqlite3';

export const CLAUDE_OUTPUT_STYLES = ['Default', 'Concise'] as const;
export type ClaudeOutputStyle = (typeof CLAUDE_OUTPUT_STYLES)[number];

export interface ClaudePreferences {
  outputStyle: ClaudeOutputStyle;
}

const CLAUDE_PREFERENCES_KEY = 'claude_preferences';
export const DEFAULT_CLAUDE_PREFERENCES: ClaudePreferences = { outputStyle: 'Default' };

function normalizeOutputStyle(value: unknown): ClaudeOutputStyle {
  return CLAUDE_OUTPUT_STYLES.includes(value as ClaudeOutputStyle)
    ? (value as ClaudeOutputStyle)
    : DEFAULT_CLAUDE_PREFERENCES.outputStyle;
}

export function readClaudePreferences(db: Database.Database): ClaudePreferences {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(CLAUDE_PREFERENCES_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_CLAUDE_PREFERENCES };
  try {
    const parsed = JSON.parse(row.value_json) as { outputStyle?: unknown };
    return { outputStyle: normalizeOutputStyle(parsed.outputStyle) };
  } catch {
    return { ...DEFAULT_CLAUDE_PREFERENCES };
  }
}

export function writeClaudePreferences(
  db: Database.Database,
  preferences: ClaudePreferences,
): ClaudePreferences {
  const normalized = { outputStyle: normalizeOutputStyle(preferences.outputStyle) };
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(CLAUDE_PREFERENCES_KEY, JSON.stringify(normalized));
  return normalized;
}
