import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_VOCABULARY_TERMS,
  readVoiceSettings,
  writeVoiceSettings,
} from '../src/channels/voiceSettings.js';

const databases: Database.Database[] = [];

function db(): Database.Database {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('voice settings', () => {
  it('defaults to the Soniox vocabulary hints', () => {
    expect(readVoiceSettings(db())).toEqual({
      vocabularyTerms: DEFAULT_VOICE_VOCABULARY_TERMS,
    });
  });

  it('persists vocabulary hints', () => {
    const database = db();
    expect(writeVoiceSettings(database, { vocabularyTerms: ['Veneer', 'Acme'] })).toEqual({
      vocabularyTerms: ['Veneer', 'Acme'],
    });
    expect(readVoiceSettings(database)).toEqual({ vocabularyTerms: ['Veneer', 'Acme'] });
  });

  it('falls back safely when the stored value is missing or corrupt', () => {
    const database = db();
    database.prepare("INSERT INTO settings (key, value_json) VALUES ('voice_settings', ?)").run(
      JSON.stringify({}),
    );
    expect(readVoiceSettings(database)).toEqual({
      vocabularyTerms: DEFAULT_VOICE_VOCABULARY_TERMS,
    });
    database.prepare("UPDATE settings SET value_json = 'not-json' WHERE key = 'voice_settings'").run();
    expect(readVoiceSettings(database)).toEqual({
      vocabularyTerms: DEFAULT_VOICE_VOCABULARY_TERMS,
    });
  });
});
