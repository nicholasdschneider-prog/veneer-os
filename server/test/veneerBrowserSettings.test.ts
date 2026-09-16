import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VENEER_BROWSER_SETTINGS,
  VENEER_BROWSER_SETTINGS_KEY,
  readVeneerBrowserSettings,
  writeVeneerBrowserSettings,
} from '../src/veneerBrowser/settings.js';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  return db;
}

describe('Veneer Browser settings', () => {
  it('defaults missing, malformed, and out-of-range values to quality 80 and Auto resolution', () => {
    const db = database();
    expect(readVeneerBrowserSettings(db)).toEqual(DEFAULT_VENEER_BROWSER_SETTINGS);
    db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(VENEER_BROWSER_SETTINGS_KEY, 'not-json');
    expect(readVeneerBrowserSettings(db)).toEqual({ quality: 80, resolution: 'auto' });
    db.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run('{"quality":100}', VENEER_BROWSER_SETTINGS_KEY);
    expect(readVeneerBrowserSettings(db)).toEqual({ quality: 80, resolution: 'auto' });
    db.close();
  });

  it('adds Auto to legacy quality-only settings and persists both controls', () => {
    const db = database();
    db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(VENEER_BROWSER_SETTINGS_KEY, '{"quality":85}');
    expect(readVeneerBrowserSettings(db)).toEqual({ quality: 85, resolution: 'auto' });
    expect(writeVeneerBrowserSettings(db, { quality: 85, resolution: 'retina' })).toEqual({
      quality: 85,
      resolution: 'retina',
    });
    expect(readVeneerBrowserSettings(db)).toEqual({ quality: 85, resolution: 'retina' });
    db.close();
  });
});
