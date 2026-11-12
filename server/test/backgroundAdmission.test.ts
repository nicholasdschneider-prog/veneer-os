import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createBackgroundAdmission } from '../src/runner/backgroundAdmission.js';
import { activeDiskFloor, diskFloorLine, writeDiskFloorStatus, type DiskFloorStatus } from '../src/runner/diskFloorStatus.js';

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

it('publishes and logs disk floor transitions, including the latch between 10 and 12 GiB', () => {
  const db = new Database(':memory:');
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  try {
    db.exec('CREATE TABLE pending_turns (status TEXT)');
    let free = 20;
    let clock = Date.parse('2026-11-12T15:00:00Z');
    const reports: DiskFloorStatus[] = [];
    const admit = createBackgroundAdmission(db, 4, () => free * 1024 ** 3, (s) => reports.push(s), () => clock);
    expect(admit({ ignoreActiveLimit: true })).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ diskBlocked: false, resumeAtBytes: 12 * 1024 ** 3 });
    expect(info).not.toHaveBeenCalled(); // healthy start is not news

    clock += 1_000; free = 9.5;
    expect(admit({ ignoreActiveLimit: true })).toBe(false); // the build path now logs too
    expect(info).toHaveBeenLastCalledWith(expect.stringContaining('disk floor: holding new automatic work; free=9.5 GiB, resumes at 12.0 GiB'));
    expect(reports.at(-1)).toMatchObject({ diskBlocked: true, sinceAt: '2026-11-12T15:00:01.000Z' });

    clock += 1_000; free = 10.8; // latched: still held, no new log, no extra write within a minute
    const calls = info.mock.calls.length;
    expect(admit({ ignoreActiveLimit: true })).toBe(false);
    expect(info.mock.calls.length).toBe(calls);
    expect(reports).toHaveLength(2);
    expect(admit.diskStatus()).toMatchObject({ diskBlocked: true, freeBytes: 10.8 * 1024 ** 3, sinceAt: '2026-11-12T15:00:01.000Z' });

    clock += 60_000; // coarse refresh keeps the published row fresh
    admit({ ignoreActiveLimit: true });
    expect(reports).toHaveLength(3);
    expect(reports.at(-1)!.sinceAt).toBe('2026-11-12T15:00:01.000Z');

    clock += 1_000; free = 12.5;
    expect(admit()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('disk floor cleared; free=12.5 GiB'));
    expect(reports.at(-1)).toMatchObject({ diskBlocked: false });
  } finally { info.mockRestore(); db.close(); }
});

it('reads only a fresh blocked disk floor and words it for people and bots', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
    const now = Date.parse('2026-11-12T15:30:00Z');
    expect(activeDiskFloor(db, now)).toBeNull();
    const status: DiskFloorStatus = { diskBlocked: true, freeBytes: 10.8 * 1024 ** 3, sinceAt: '2026-11-12T15:15:00Z', resumeAtBytes: 12 * 1024 ** 3, updatedAt: '2026-11-12T15:29:00Z' };
    writeDiskFloorStatus(db, status);
    expect(diskFloorLine(activeDiskFloor(db, now)!)).toBe('Paused: disk low (10.8 GiB free, needs 12.0). Builds and bot wake-ups resume automatically once space is freed.');
    expect(activeDiskFloor(db, now + 10 * 60_000)).toBeNull(); // runner stopped reporting
    writeDiskFloorStatus(db, { ...status, diskBlocked: false });
    expect(activeDiskFloor(db, now)).toBeNull();
  } finally { db.close(); }
});
