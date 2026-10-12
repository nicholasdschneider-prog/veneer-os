import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createBackgroundAdmission } from '../src/runner/backgroundAdmission.js';

it('counts active work across providers, ignores failures, and reopens capacity after completion', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE pending_turns (status TEXT)');
    const admit = createBackgroundAdmission(db, 2);
    expect(admit()).toBe(true);
    db.exec("INSERT INTO pending_turns VALUES ('pending'), ('failed')");
    expect(admit()).toBe(true);
    db.exec("INSERT INTO pending_turns VALUES ('pending')");
    expect(admit()).toBe(false);
    db.exec("DELETE FROM pending_turns WHERE rowid=1");
    expect(admit()).toBe(true);
    expect(() => createBackgroundAdmission(db, NaN)).toThrow();
  } finally { db.close(); }
});
