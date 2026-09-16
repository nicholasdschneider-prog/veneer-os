import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CODEX_ACCOUNT_ID,
  adoptCodexLogin,
  adoptCodexLogins,
  codexAccountHome,
  createCodexAccountStore,
  ensureCodexAccountHome,
  readCodexIdentity,
  removeCodexAccountFiles,
} from '../src/codex/accounts.js';
import { createCodexConnectManager, type CodexSpawner } from '../src/codex/deviceAuth.js';
import { createCodexAccountUsage, type CodexUsageReader } from '../src/usage/codex.js';
import { createCodexAccountFailover } from '../src/providers/codex/accountFailover.js';
import { createFailoverGuard } from '../src/providers/claude/accountFailover.js';
import type { Homes } from '../src/homes.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-accounts-'));
  dirs.push(dir);
  return dir;
}

function fixture(): { dataDir: string; homes: Homes; primary: string } {
  const root = tmp();
  const homes: Homes = { loginHome: path.join(root, 'login'), serviceHome: path.join(root, 'service') };
  const primary = path.join(homes.serviceHome, '.codex');
  fs.mkdirSync(primary, { recursive: true });
  return { dataDir: path.join(root, 'data'), homes, primary };
}

function authJson(email: string, plan = 'plus'): string {
  const payload = Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })).toString('base64url');
  return JSON.stringify({ tokens: { id_token: `h.${payload}.s`, access_token: 'x' } });
}

describe('codex account store', () => {
  it('adopts a pre-existing primary login without moving it', () => {
    const { dataDir, homes, primary } = fixture();
    fs.writeFileSync(path.join(primary, 'auth.json'), authJson('one@example.com', 'pro'));
    const store = createCodexAccountStore(dataDir, homes);
    expect(store.list()).toEqual([]);
    adoptCodexLogins(store, homes);
    const [account] = store.list();
    expect(account).toMatchObject({
      id: LEGACY_CODEX_ACCOUNT_ID, email: 'one@example.com', planType: 'pro', label: 'one@example.com', active: true, connected: true,
    });
    expect(store.homeFor(LEGACY_CODEX_ACCOUNT_ID)).toBe(primary);
    // Idempotent: a second boot changes nothing.
    adoptCodexLogins(store, homes);
    expect(store.list()).toHaveLength(1);
  });

  it('adds, activates, renames and removes accounts, promoting the next on removal', () => {
    const { dataDir, homes } = fixture();
    const store = createCodexAccountStore(dataDir, homes);
    const a = store.add({ email: 'a@example.com', planType: 'plus' });
    const b = store.add({ email: 'b@example.com', activate: false });
    expect(store.activeAccountId()).toBe(a.id);
    expect(store.setActive(b.id)).toBe(true);
    expect(store.activeAccountId()).toBe(b.id);
    expect(store.setActive('nope')).toBe(false);
    expect(store.rename(a.id, 'Work')).toBe(true);
    expect(store.list().find((x) => x.id === a.id)?.label).toBe('Work');
    // Same email again = a re-login, refreshed in place.
    const again = store.add({ email: 'a@example.com', planType: 'pro' });
    expect(again.id).toBe(a.id);
    expect(store.list()).toHaveLength(2);
    expect(store.list().find((x) => x.id === a.id)).toMatchObject({ label: 'Work', planType: 'pro', active: true });
    expect(store.remove(a.id)).toBe(true);
    expect(store.activeAccountId()).toBe(b.id);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.activeAccountId()).toBeNull();
  });

  it('keeps a user-chosen label but follows the email for generated ones', () => {
    const { dataDir, homes } = fixture();
    const store = createCodexAccountStore(dataDir, homes);
    const a = store.add({});
    expect(store.list()[0]?.label).toBe('Codex account 1');
    store.updateProfile(a.id, { email: 'me@example.com', planType: 'plus' });
    expect(store.list()[0]).toMatchObject({ label: 'me@example.com', planType: 'plus' });
    store.rename(a.id, 'Personal');
    store.updateProfile(a.id, { email: 'other@example.com' });
    expect(store.list()[0]).toMatchObject({ label: 'Personal', email: 'other@example.com' });
  });

  it('a background profile write never undoes a switch made meanwhile', () => {
    const { dataDir, homes } = fixture();
    const web = createCodexAccountStore(dataDir, homes);
    const runner = createCodexAccountStore(dataDir, homes);
    const a = web.add({ email: 'a@example.com' });
    const b = web.add({ email: 'b@example.com', activate: false });
    web.setActive(b.id);
    runner.updateProfile(a.id, { planType: 'pro' });
    expect(web.activeAccountId()).toBe(b.id);
  });

  it('rejects ids that could escape the accounts directory', () => {
    const { homes } = fixture();
    expect(() => codexAccountHome('../etc', homes)).toThrow();
    expect(() => codexAccountHome('.hidden', homes)).toThrow();
    expect(codexAccountHome('abc-123', homes)).toBe(path.join(homes.serviceHome, '.codex-accounts', 'abc-123'));
  });
});

describe('codex account homes', () => {
  it('shares everything but the credential with the primary profile', () => {
    const { dataDir, homes, primary } = fixture();
    fs.writeFileSync(path.join(primary, 'auth.json'), authJson('one@example.com'));
    fs.writeFileSync(path.join(primary, 'config.toml'), 'model = "x"\n');
    fs.mkdirSync(path.join(primary, 'sessions', '2026'), { recursive: true });
    fs.writeFileSync(path.join(primary, 'state_5.sqlite'), '');
    fs.writeFileSync(path.join(primary, 'state_5.sqlite-wal'), '');
    const store = createCodexAccountStore(dataDir, homes);
    const b = store.add({ email: 'b@example.com' });
    const home = ensureCodexAccountHome(store.homeFor(b.id), homes);
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false);
    expect(fs.lstatSync(path.join(home, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(home, 'sessions'))).toBe(path.join(primary, 'sessions'));
    expect(fs.existsSync(path.join(home, 'sessions', '2026'))).toBe(true);
    expect(fs.lstatSync(path.join(home, 'state_5.sqlite')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, 'state_5.sqlite-wal'))).toBe(false);
    // A new entry in the primary profile is linked in on the next call.
    fs.mkdirSync(path.join(primary, 'skills'));
    ensureCodexAccountHome(home, homes);
    expect(fs.lstatSync(path.join(home, 'skills')).isSymbolicLink()).toBe(true);
    // The primary home itself is left untouched.
    expect(ensureCodexAccountHome(primary, homes)).toBe(primary);
    expect(fs.lstatSync(path.join(primary, 'config.toml')).isSymbolicLink()).toBe(false);
  });

  it('adopts a staged sign-in into a new account, or into the account with that email', () => {
    const { dataDir, homes, primary } = fixture();
    fs.writeFileSync(path.join(primary, 'auth.json'), authJson('one@example.com'));
    const store = createCodexAccountStore(dataDir, homes);
    adoptCodexLogins(store, homes);

    const staging = path.join(homes.serviceHome, '.codex-accounts', 'pending-1');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'auth.json'), authJson('two@example.com', 'pro'));
    const two = adoptCodexLogin(store, staging, homes);
    expect(two).toMatchObject({ email: 'two@example.com', planType: 'pro', active: true, connected: true });
    expect(fs.existsSync(staging)).toBe(false);
    expect(readCodexIdentity(store.homeFor(two.id))).toEqual({ email: 'two@example.com', plan: 'pro' });
    expect(store.list().map((a) => a.id)).toEqual([LEGACY_CODEX_ACCOUNT_ID, two.id]);

    // Re-signing into the primary account refreshes its credential in place.
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'auth.json'), authJson('one@example.com', 'pro'));
    const one = adoptCodexLogin(store, staging, homes);
    expect(one.id).toBe(LEGACY_CODEX_ACCOUNT_ID);
    expect(readCodexIdentity(primary)?.plan).toBe('pro');
    expect(store.list()).toHaveLength(2);

    // Removing: a sibling home goes entirely; the primary keeps its history.
    removeCodexAccountFiles(store, two.id, homes);
    expect(fs.existsSync(store.homeFor(two.id))).toBe(false);
    fs.mkdirSync(path.join(primary, 'sessions'), { recursive: true });
    removeCodexAccountFiles(store, LEGACY_CODEX_ACCOUNT_ID, homes);
    expect(fs.existsSync(path.join(primary, 'auth.json'))).toBe(false);
    expect(fs.existsSync(path.join(primary, 'sessions'))).toBe(true);
  });

  it('refuses to adopt a staging home with no credential', () => {
    const { dataDir, homes } = fixture();
    const store = createCodexAccountStore(dataDir, homes);
    const staging = path.join(homes.serviceHome, '.codex-accounts', 'pending-x');
    fs.mkdirSync(staging, { recursive: true });
    expect(() => adoptCodexLogin(store, staging, homes)).toThrow(/without writing a credential/);
  });
});

const BANNER =
  'Follow these steps to sign in with ChatGPT using device code authorization:\n' +
  '1. Open this link in your browser and sign in to your account\n' +
  '   https://auth.openai.com/codex/device\n' +
  '2. Enter this one-time code (expires in 15 minutes)\n' +
  '   NUUJ-ZH546\n';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  kill(signal?: string): boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    if (child.exitCode === null) child.exitCode = -1;
    return true;
  };
  return child;
}

describe('codex connect manager — staged sign-in', () => {
  it('runs the login in the staging home and adopts it on the poll that sees success', async () => {
    const child = fakeChild();
    const seen: { args: string[]; codexHome?: string }[] = [];
    const spawnFn: CodexSpawner = (_bin, args, options) => {
      seen.push({ args, codexHome: options?.codexHome });
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(BANNER)));
      return child as unknown as ChildProcess;
    };
    const onSuccess = vi.fn(() => ({
      id: 'new', label: 'two@example.com', email: 'two@example.com', planType: 'plus', connectedAt: 'now', active: true, connected: true,
    }));
    const onDiscard = vi.fn();
    const manager = createCodexConnectManager({
      codexBin: 'codex', spawnFn, onSuccess, onDiscard,
      statusFn: async () => ({ connected: false, method: null, installed: true, detail: 'Not logged in.' }),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const started = await manager.start({ codexHome: '/tmp/staging-1' });
    expect(started.codexHome).toBe('/tmp/staging-1');
    expect(seen[0]).toEqual({ args: ['login', '--device-auth'], codexHome: '/tmp/staging-1' });
    expect(await manager.poll(started.attemptId)).toMatchObject({ state: 'pending' });
    child.exitCode = 0;
    child.emit('close', 0);
    const done = await manager.poll(started.attemptId);
    expect(done).toMatchObject({ state: 'success', account: { id: 'new' } });
    expect(onSuccess).toHaveBeenCalledWith('/tmp/staging-1');
    expect(onDiscard).not.toHaveBeenCalled();
    // A late poll for the same attempt gets the same answer, not a status guess.
    expect(await manager.poll(started.attemptId)).toMatchObject({ state: 'success', account: { id: 'new' } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('discards the staging home on cancel, never a connected account', async () => {
    const child = fakeChild();
    const spawnFn: CodexSpawner = () => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(BANNER)));
      return child as unknown as ChildProcess;
    };
    const onSuccess = vi.fn();
    const onDiscard = vi.fn();
    const manager = createCodexConnectManager({
      codexBin: 'codex', spawnFn, onSuccess, onDiscard,
      statusFn: async () => ({ connected: true, method: 'chatgpt', installed: true, detail: 'Logged in' }),
    });
    const started = await manager.start({ codexHome: '/tmp/staging-2' });
    expect(manager.cancel(started.attemptId)).toEqual({ cancelled: true });
    expect(onDiscard).toHaveBeenCalledWith('/tmp/staging-2');
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('codex usage across accounts', () => {
  function usageFor(percent: number | null, connected = true) {
    return {
      connected, planType: connected ? 'plus' : null,
      windows: percent == null ? [] : [{ id: 'secondary', label: 'Weekly', usedPercent: percent, resetsAt: null, windowMinutes: 10080, status: null }],
      capturedAt: connected ? '2026-09-16T00:00:00.000Z' : null, source: connected ? 'live' : null, error: null,
    };
  }

  it('reports one block per account with the active one on top level, and reaps removed readers', async () => {
    const { dataDir, homes } = fixture();
    const store = createCodexAccountStore(dataDir, homes);
    const a = store.add({ email: 'a@example.com' });
    const b = store.add({ email: 'b@example.com', activate: false });
    const readers = new Map<string, CodexUsageReader & { shutdown: ReturnType<typeof vi.fn> }>();
    const usage = createCodexAccountUsage({
      codexBin: 'unused', accounts: store,
      readerFor: (id) => {
        const reader = { read: async () => usageFor(id === a.id ? 80 : 20), shutdown: vi.fn() };
        readers.set(id, reader);
        return reader;
      },
    });
    const first = await usage.read();
    expect(first).toMatchObject({ connected: true, windows: [{ usedPercent: 80 }] });
    expect(first.accounts?.map((x) => [x.accountId, x.active, x.windows[0]?.usedPercent])).toEqual([[a.id, true, 80], [b.id, false, 20]]);
    store.setActive(b.id);
    expect((await usage.read()).windows[0]?.usedPercent).toBe(20);
    store.remove(a.id);
    await usage.read();
    expect(readers.get(a.id)?.shutdown).toHaveBeenCalled();
    usage.shutdown();
    expect(readers.get(b.id)?.shutdown).toHaveBeenCalled();
  });

  it('reads as disconnected with no accounts', async () => {
    const { dataDir, homes } = fixture();
    const usage = createCodexAccountUsage({ codexBin: 'unused', accounts: createCodexAccountStore(dataDir, homes) });
    expect(await usage.read()).toMatchObject({ connected: false, windows: [] });
  });
});

describe('codex account failover', () => {
  it('switches to the account with the most headroom and asks the chat to continue', async () => {
    const { dataDir, homes } = fixture();
    const store = createCodexAccountStore(dataDir, homes);
    for (const id of ['a', 'b', 'c']) {
      fs.mkdirSync(store.homeFor(id === 'a' ? LEGACY_CODEX_ACCOUNT_ID : id), { recursive: true });
    }
    const a = store.add({ id: LEGACY_CODEX_ACCOUNT_ID, email: 'a@example.com', label: 'A' });
    const b = store.add({ id: 'b', email: 'b@example.com', label: 'B', activate: false });
    const c = store.add({ id: 'c', email: 'c@example.com', label: 'C', activate: false });
    for (const id of [a.id, b.id, c.id]) fs.writeFileSync(path.join(store.homeFor(id), 'auth.json'), authJson(`${id}@example.com`));
    const block = (accountId: string, usedPercent: number, active: boolean) => ({
      accountId, label: accountId.toUpperCase(), accountEmail: null, planType: 'plus', active,
      windows: [{ id: 'secondary', label: 'Weekly', usedPercent, resetsAt: null, windowMinutes: 10080, status: null }],
      capturedAt: null, source: 'live', limitReset: null,
    });
    const usage = {
      read: async () => ({
        connected: true, planType: 'plus', windows: [], capturedAt: null, source: null, error: null,
        accounts: [block(a.id, 100, true), block(b.id, 95, false), block(c.id, 40, false)],
      }),
    };
    const events: unknown[] = [];
    const wakeups: string[] = [];
    const bus = new EventEmitter();
    bus.on('event', (_conv, e) => events.push(e));
    const db = {
      prepare: () => ({ get: (id: string) => ({ id, project_id: null }) }),
    } as never;
    const failover = createCodexAccountFailover({
      db, accounts: store, usage,
      manager: { bus, deliverWakeup: (_conv, message, key) => { wakeups.push(`${key}:${message}`); } } as never,
      guard: createFailoverGuard(),
    });
    await failover.handleUsageLimit({ conversationId: 'conv1', accountId: a.id, text: "You've hit your usage limit.", at: new Date() });
    expect(store.activeAccountId()).toBe(c.id);
    expect(events).toEqual([{ type: 'notice', message: 'Usage limit hit on A. Switched to C, continuing.' }]);
    expect(wakeups[0]).toMatch(/^codex-failover:conv1:\d+:Continue where you left off/);
    // The same chat limiting again inside the cooldown does not bounce between accounts.
    await failover.handleUsageLimit({ conversationId: 'conv1', accountId: c.id, text: 'usage limit', at: new Date() });
    expect(store.activeAccountId()).toBe(c.id);
  });
});
