import type { AddressInfo } from 'node:net';
import http, { type Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { createVeneerBrowserRouter } from '../src/routes/veneerBrowser.js';
import { handleVeneerBrowserMcp } from '../src/veneerBrowser/mcp.js';
import type { VeneerBrowserManager } from '../src/veneerBrowser/manager.js';

vi.mock('../src/runtime/agentTokens.js', () => ({
  resolveAgentTokenContext: () => ({ email: 'owner@example.com', conversationId: 'chat-1' }),
}));

const session = {
  configured: true,
  active: false,
  projectId: 'project-1',
  profileId: 'profile-1',
  profileName: 'Saved login',
  status: 'stopped' as const,
  inUseByAnotherChat: false,
  temporaryClone: false,
  fresh: false,
  canUpdateProfile: false,
  lastUsedAt: null,
  error: null,
};

describe('Veneer Browser routes', () => {
  let server: Server;
  let base: string;
  let db: Database.Database;
  let role: UserRow['role'] = 'owner';
  const veneerBrowserConversationFresh = vi.fn(async () => ({ ...session, active: true, temporaryClone: true, fresh: true }));
  const veneerBrowserConversationUpdateProfile = vi.fn(async () => session);
  const veneerBrowserConversationSaveAs = vi.fn(async () => ({ ...session, profileName: 'Other login' }));
  const veneerBrowserConversationCreate = vi.fn(async () => session);
  const veneerBrowserConversationCaptureGet = vi.fn(async () => ({ active: false }));
  const veneerBrowserConversationCaptureSet = vi.fn(async (_userId: number, _convId: string, active: boolean) => ({ active }));
  const veneerBrowserConversationProfiles = vi.fn(async () => [{
    id: 'profile-1', projectId: 'unfiled-user-1', ownerUserId: 1, name: 'Saved login', active: false,
    status: 'stopped' as const, activeConversationId: null, activeConversationTitle: null,
    activeCloneCount: 0, lastUsedAt: null, createdAt: '2026-01-01 00:00:00',
  }]);
  const profileView = {
    id: 'profile-1', projectId: 'project-1', ownerUserId: 1, name: 'Saved login', active: false,
    status: 'stopped' as const, activeConversationId: null, activeConversationTitle: null,
    activeCloneCount: 0, lastUsedAt: null, createdAt: '2026-01-01 00:00:00',
  };
  const veneerBrowserProfiles = vi.fn(async () => ({
    configured: true,
    profiles: [profileView],
    defaultProfileId: 'profile-1',
    others: [{ ...profileView, id: 'profile-2', ownerUserId: 2, ownerName: 'Teammate' }],
  }));
  const veneerBrowserSetDefault = vi.fn(async () => undefined);
  const veneerBrowserRename = vi.fn(async () => profileView);
  const veneerBrowserDelete = vi.fn(async () => undefined);
  const veneerBrowserStop = vi.fn(async () => profileView);
  const veneerBrowserStatus = vi.fn(async () => profileView);

  beforeAll(async () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        id: 1,
        email: 'owner@example.com',
        display_name: 'Owner',
        role,
        status: 'active',
        created_at: '2026-01-01 00:00:00',
        last_seen_at: null,
      } satisfies UserRow;
      next();
    });
    app.use('/api/veneer-browser', createVeneerBrowserRouter({
      db,
      manager: {
        veneerBrowserConversationFresh,
        veneerBrowserConversationUpdateProfile,
        veneerBrowserConversationSaveAs,
        veneerBrowserConversationCreate,
        veneerBrowserConversationProfiles,
        veneerBrowserProfiles,
        veneerBrowserSetDefault,
        veneerBrowserRename,
        veneerBrowserDelete,
        veneerBrowserStop,
        veneerBrowserStatus,
        veneerBrowserConversationCaptureGet,
        veneerBrowserConversationCaptureSet,
      },
    } as unknown as AppContext));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    role = 'owner';
    db.prepare("DELETE FROM settings WHERE key = 'veneer_browser_settings'").run();
  });

  it('defaults to quality 80 with Auto resolution and restricts workspace changes to administrators', async () => {
    const initial = await fetch(`${base}/api/veneer-browser/settings`);
    expect(await initial.json()).toEqual({ ok: true, settings: { quality: 80, resolution: 'auto' } });

    const invalid = await fetch(`${base}/api/veneer-browser/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quality: 100, resolution: 'auto' }),
    });
    expect(invalid.status).toBe(400);

    const saved = await fetch(`${base}/api/veneer-browser/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quality: 85, resolution: 'retina' }),
    });
    expect(await saved.json()).toEqual({ ok: true, settings: { quality: 85, resolution: 'retina' } });

    role = 'member';
    const refused = await fetch(`${base}/api/veneer-browser/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quality: 70, resolution: 'standard' }),
    });
    expect(refused.status).toBe(403);
    expect((await (await fetch(`${base}/api/veneer-browser/settings`)).json()).settings).toEqual({
      quality: 85,
      resolution: 'retina',
    });
  });

  it('routes the explicit signed-out and update actions', async () => {
    const fresh = await fetch(`${base}/api/veneer-browser/conversations/chat-1/fresh`, { method: 'POST' });
    expect(fresh.status).toBe(200);
    expect(veneerBrowserConversationFresh).toHaveBeenCalledWith(1, 'chat-1');

    const update = await fetch(`${base}/api/veneer-browser/conversations/chat-1/update-profile`, { method: 'POST' });
    expect(update.status).toBe(200);
    expect(veneerBrowserConversationUpdateProfile).toHaveBeenCalledWith(1, 'chat-1');
  });

  it('lists profiles through the authenticated conversation scope', async () => {
    const response = await fetch(`${base}/api/veneer-browser/conversations/chat-1/profiles`);
    expect(response.status).toBe(200);
    expect(veneerBrowserConversationProfiles).toHaveBeenCalledWith(1, 'chat-1');
  });

  it('scopes the project profile routes to the signed-in user and their role', async () => {
    const listed = await fetch(`${base}/api/veneer-browser/projects/project-1/profiles`);
    expect(await listed.json()).toEqual({
      ok: true,
      configured: true,
      profiles: [{ ...profileView }],
      defaultProfileId: 'profile-1',
      others: [{ ...profileView, id: 'profile-2', ownerUserId: 2, ownerName: 'Teammate' }],
    });
    expect(veneerBrowserProfiles).toHaveBeenCalledWith(1, 'owner', 'project-1');

    await fetch(`${base}/api/veneer-browser/projects/project-1/default`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'profile-1' }),
    });
    expect(veneerBrowserSetDefault).toHaveBeenCalledWith(1, 'project-1', 'profile-1');

    await fetch(`${base}/api/veneer-browser/projects/project-1/profiles/profile-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(veneerBrowserRename).toHaveBeenCalledWith(1, 'project-1', 'profile-1', 'Renamed');

    await fetch(`${base}/api/veneer-browser/projects/project-1/profiles/profile-1/stop`, { method: 'POST' });
    expect(veneerBrowserStop).toHaveBeenCalledWith(1, 'project-1', 'profile-1');

    await fetch(`${base}/api/veneer-browser/projects/project-1/profiles/profile-1/status`);
    expect(veneerBrowserStatus).toHaveBeenCalledWith(1, 'project-1', 'profile-1');
  });

  it('passes the caller role to delete so only an account owner can clean up', async () => {
    role = 'member';
    const refusedBody = await fetch(`${base}/api/veneer-browser/projects/project-1/profiles/profile-2`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(refusedBody.status).toBe(400);
    expect(veneerBrowserDelete).not.toHaveBeenCalled();

    await fetch(`${base}/api/veneer-browser/projects/project-1/profiles/profile-2`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(veneerBrowserDelete).toHaveBeenCalledWith(1, 'member', 'project-1', 'profile-2');

    role = 'owner';
    await fetch(`${base}/api/veneer-browser/projects/project-1/profiles/profile-2`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(veneerBrowserDelete).toHaveBeenLastCalledWith(1, 'owner', 'project-1', 'profile-2');
  });

  it('requires a name before it saves an additional profile', async () => {
    const invalid = await fetch(`${base}/api/veneer-browser/conversations/chat-1/save-as`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);
    expect(veneerBrowserConversationSaveAs).not.toHaveBeenCalled();

    const valid = await fetch(`${base}/api/veneer-browser/conversations/chat-1/save-as`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Other login' }),
    });
    expect(valid.status).toBe(201);
    expect(veneerBrowserConversationSaveAs).toHaveBeenCalledWith(1, 'chat-1', 'Other login');
  });

  it('reads and sets Advanced capture for the authenticated chat owner', async () => {
    const read = await fetch(`${base}/api/veneer-browser/conversations/chat-1/capture`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ok: true, capture: { active: false } });
    expect(veneerBrowserConversationCaptureGet).toHaveBeenCalledWith(1, 'chat-1');

    const set = await fetch(`${base}/api/veneer-browser/conversations/chat-1/capture`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ok: true, capture: { active: true } });
    expect(veneerBrowserConversationCaptureSet).toHaveBeenCalledWith(1, 'chat-1', true);

    const off = await fetch(`${base}/api/veneer-browser/conversations/chat-1/capture`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(await off.json()).toEqual({ ok: true, capture: { active: false } });
  });

  it('rejects a malformed Advanced capture body and surfaces a refused grant', async () => {
    for (const body of [{}, { active: 'yes' }, { active: 1 }]) {
      const response = await fetch(`${base}/api/veneer-browser/conversations/chat-1/capture`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(veneerBrowserConversationCaptureSet).not.toHaveBeenCalled();

    veneerBrowserConversationCaptureSet.mockRejectedValueOnce(
      new Error('Open this chat browser before you turn on Advanced capture.'),
    );
    const refused = await fetch(`${base}/api/veneer-browser/conversations/chat-1/capture`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      ok: false,
      error: 'Open this chat browser before you turn on Advanced capture.',
    });
  });

  it('rejects the legacy unnamed permanent-profile action', async () => {
    const response = await fetch(`${base}/api/veneer-browser/conversations/chat-1/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(veneerBrowserConversationCreate).not.toHaveBeenCalled();
  });
});

describe('Veneer Browser MCP endpoint', () => {
  let server: Server;
  let base: string;
  const runCommand = vi.fn(async () => ({ args: ['press', 'Enter'], stdout: 'ok', stderr: '', exitCode: 0 }));
  const conversationSession = vi.fn(async () => ({ ...session, active: true, temporaryClone: true }));
  const captureGrantActive = vi.fn(() => false);
  const fetchUrl = vi.fn(async () => ({ ok: true, final_url: 'https://example.com', fetched_at: '2026-09-10T00:00:00Z', text: 'Ready', tables: [], title: 'Example', truncated: false }));
  const db = { prepare: () => ({ get: () => ({ id: 1 }) }) } as unknown as Database.Database;
  const manager = { runCommand, conversationSession, captureGrantActive, fetchUrl } as unknown as VeneerBrowserManager;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vp-agent-token': 'token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json() as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: body.result.content.map((part) => part.text).join('\n'), isError: body.result.isError === true };
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => { void handleVeneerBrowserMcp(req, res, { db, manager }); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => vi.clearAllMocks());

  it('advertises the typed interaction tools and the escape hatch', async () => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vp-agent-token': 'token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await response.json() as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((tool) => tool.name);
    for (const name of ['navigate', 'click', 'type', 'read', 'screenshot', 'press', 'scroll', 'hover', 'wait', 'find', 'back', 'forward', 'reload', 'tab', 'fill', 'run', 'click_at', 'hover_at', 'scroll_at', 'dialog']) {
      expect(names).toContain(name);
    }
  });

  it('dispatches a typed interaction command to the browser', async () => {
    const result = await call('press', { key: 'Enter' });
    expect(result.isError).toBe(false);
    expect(runCommand).toHaveBeenCalledWith(1, 'chat-1', ['press', 'Enter']);
  });

  it('routes URL reads to the same manager using the authenticated chat', async () => {
    const request = { url: 'https://example.com', wait_for: { text: 'Ready' } };
    const result = await call('fetch_url', request);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).text).toBe('Ready');
    expect(fetchUrl).toHaveBeenCalledWith(1, 'chat-1', request);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('passes a safe raw command through the escape hatch', async () => {
    await call('run', { args: ['get', 'title'] });
    expect(runCommand).toHaveBeenCalledWith(1, 'chat-1', ['get', 'title']);
  });

  it('refuses session-stealing commands before they reach the browser', async () => {
    for (const args of [['eval', 'document.cookie'], ['cookies'], ['storage', 'local'], ['state', 'save', 'auth.json']]) {
      const result = await call('run', { args });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not available in Veneer Browser');
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses network capture by default and names the user-only switch', async () => {
    const result = await call('run', { args: ['network', 'requests'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('blocked by default on the signed-in browser');
    expect(result.text).toContain('Advanced capture');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('allows network capture only while the user grant is active', async () => {
    captureGrantActive.mockReturnValue(true);
    try {
      const allowed = await call('run', { args: ['network', 'requests'] });
      expect(allowed.isError).toBe(false);
      expect(runCommand).toHaveBeenCalledWith(1, 'chat-1', ['network', 'requests']);
      expect(captureGrantActive).toHaveBeenCalledWith('chat-1');

      // The grant widens nothing else, even with capture on.
      runCommand.mockClear();
      for (const args of [['eval', '1'], ['cookies'], ['storage', 'local'], ['batch', 'x'], ['clipboard']]) {
        const blocked = await call('run', { args });
        expect(blocked.isError).toBe(true);
        expect(blocked.text).toContain('not available in Veneer Browser');
      }
      expect(runCommand).not.toHaveBeenCalled();

      const status = await call('status');
      expect(status.text).toContain('Advanced capture: on.');
    } finally {
      captureGrantActive.mockReturnValue(false);
    }
    const off = await call('status');
    expect(off.text).toContain('Advanced capture: off.');
  });

  it('exposes no tool that can grant Advanced capture', async () => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vp-agent-token': 'token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await response.json() as { result: { tools: { name: string; description: string }[] } };
    for (const tool of body.result.tools) {
      expect(tool.name).not.toMatch(/capture|grant|network/i);
    }
    for (const name of ['capture', 'set_capture', 'advanced_capture', 'grant_capture', 'enable_capture']) {
      const result = await call(name, { active: true });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`Unknown Veneer Browser tool: ${name}`);
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses a loopback URL inside raw arguments', async () => {
    const result = await call('run', { args: ['open', 'http://localhost:5173'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('separate virtual machine');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
