import type Database from 'better-sqlite3';

export interface VoiceSettings {
  vocabularyTerms: string[];
}

const VOICE_SETTINGS_KEY = 'voice_settings';
export const MAX_VOICE_VOCABULARY_TERMS = 50;
export const MAX_VOICE_VOCABULARY_TERM_LENGTH = 20;
export const DEFAULT_VOICE_VOCABULARY_TERMS = [
  'Veneer',
  'Veneer Pro',
  'sub-agent',
  'sub-agents',
  'Codex',
  'Claude',
  'OpenRouter',
  'Cloudflare',
  'Doppler',
  'MCP',
  'Soniox',
  'WebSocket',
  'monorepo',
];
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  vocabularyTerms: [...DEFAULT_VOICE_VOCABULARY_TERMS],
};

function defaultVoiceSettings(): VoiceSettings {
  return {
    vocabularyTerms: [...DEFAULT_VOICE_VOCABULARY_TERMS],
  };
}

function normalizeVocabularyTerms(value: unknown, fallback: readonly string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const valueTerm of value) {
    if (typeof valueTerm !== 'string') continue;
    const term = valueTerm.trim();
    if (!term || term.length > MAX_VOICE_VOCABULARY_TERM_LENGTH || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length === MAX_VOICE_VOCABULARY_TERMS) break;
  }
  return terms;
}

export function readVoiceSettings(db: Database.Database): VoiceSettings {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(VOICE_SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return defaultVoiceSettings();
  try {
    const parsed = JSON.parse(row.value_json) as { vocabularyTerms?: unknown };
    return {
      vocabularyTerms: normalizeVocabularyTerms(parsed.vocabularyTerms, DEFAULT_VOICE_VOCABULARY_TERMS),
    };
  } catch {
    return defaultVoiceSettings();
  }
}

export function writeVoiceSettings(db: Database.Database, settings: VoiceSettings): VoiceSettings {
  const normalized: VoiceSettings = {
    vocabularyTerms: normalizeVocabularyTerms(settings.vocabularyTerms),
  };
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(VOICE_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}
