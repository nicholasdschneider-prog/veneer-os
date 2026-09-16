import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetHomesCache } from '../src/homes.js';

let tmpHome: string;
let activityFile: string;
let originalHome: string | undefined;
let originalServiceHome: string | undefined;
let mod: typeof import('../src/desktopActivity.js');

beforeAll(async () => {
  originalHome = process.env.HOME;
  originalServiceHome = process.env.VP_SERVICE_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-desktop-activity-home-'));
  process.env.HOME = tmpHome;
  process.env.VP_SERVICE_HOME = tmpHome;
  resetHomesCache();
  activityFile = path.join(tmpHome, '.veneer-desktop', 'agent-activity.json');
  mod = await import('../src/desktopActivity.js');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalServiceHome === undefined) delete process.env.VP_SERVICE_HOME;
  else process.env.VP_SERVICE_HOME = originalServiceHome;
  resetHomesCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpHome, '.veneer-desktop'), { recursive: true, force: true });
});

describe('desktop agent activity', () => {
  it('reads null when no activity file exists', () => {
    expect(mod.readActivity()).toBeNull();
  });

  it('round-trips a heartbeat and preserves the conversationId', () => {
    mod.writeActivity('conv-123');
    const activity = mod.readActivity();
    expect(activity?.conversationId).toBe('conv-123');
    expect(typeof activity?.lastAt).toBe('string');
    expect(Number.isNaN(Date.parse(activity!.lastAt))).toBe(false);
    expect(fs.existsSync(activityFile)).toBe(true);
  });

  it('treats a corrupt activity file as no activity', () => {
    fs.mkdirSync(path.dirname(activityFile), { recursive: true });
    fs.writeFileSync(activityFile, '{ not json');
    expect(mod.readActivity()).toBeNull();
  });

  it('treats a well-formed but incomplete activity file as no activity', () => {
    fs.mkdirSync(path.dirname(activityFile), { recursive: true });
    fs.writeFileSync(activityFile, JSON.stringify({ lastAt: '2026-07-27T00:00:00.000Z' }));
    expect(mod.readActivity()).toBeNull();
  });
});
