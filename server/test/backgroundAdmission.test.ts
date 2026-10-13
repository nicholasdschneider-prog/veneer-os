import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createBackgroundAdmission } from '../src/runner/backgroundAdmission.js';

it('defers automatic work on low or unknown disk space and recovers with headroom', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE pending_turns (status TEXT)');
    let free = 9;
    const admit = createBackgroundAdmission(db,4,()=>free * 1024 ** 3);
    expect(admit()).toBe(false);
    free=11; expect(admit()).toBe(false);
    free=12; expect(admit()).toBe(true);
    free=NaN; expect(admit()).toBe(false);
    free=13; expect(admit()).toBe(true);
    expect(createBackgroundAdmission(db,4,()=>{throw new Error('unavailable');})()).toBe(false);
  } finally {db.close();}
});

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

it('admits a human reply past the turn limit but never below the disk floor', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE pending_turns (status TEXT); INSERT INTO pending_turns VALUES ('pending'),('pending')");
    let free = 20;
    const admit = createBackgroundAdmission(db, 2, () => free * 1024 ** 3);
    expect(admit()).toBe(false);
    expect(admit({ ignoreActiveLimit: true })).toBe(true);
    free = 5;
    expect(admit({ ignoreActiveLimit: true })).toBe(false);
  } finally { db.close(); }
});
