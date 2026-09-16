import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { normalizeAgentBrowserArgs } from '../src/mcp/agentBrowser.js';
import { VeneerBrowserManager } from '../src/veneerBrowser/manager.js';
import { clearSecretFields, rememberSecretField } from '../src/veneerBrowser/secretFill.js';
import { answerDialog, assertVeneerRunArgs, commandFor, hasDialogInJson, rejectLoopbackUrl } from '../src/veneerBrowser/mcp.js';
import { pointerCommands, pointerSummary } from '../src/veneerBrowser/pointer.js';
import { VeneerBrowserRemoteError, type VeneerBrowserRemote } from '../src/veneerBrowser/remoteClient.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

describe('Veneer Browser manager', () => {
  let db: Database.Database;
  let dataDir: string;
  let remote: VeneerBrowserRemote & Record<string, ReturnType<typeof vi.fn>>;
  let manager: VeneerBrowserManager;
  let runBrowser: ReturnType<typeof vi.fn>;
  let closeBrowserSession: ReturnType<typeof vi.fn>;
  let readUrl: ReturnType<typeof vi.fn>;
  let running: Set<string>;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-veneer-browser-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'u@example.com', 'User', 'owner')").run();
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'other@example.com', 'Other', 'owner')").run();
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (3, 'member@example.com', 'Member', 'member')").run();
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'alpha', 'Alpha')").run();
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-2', 'beta', 'Beta')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id) VALUES ('conv-1', 1, 1, 'project-1', 'claude', 'native-1')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id) VALUES ('conv-2', 1, 1, 'project-1', 'claude', 'native-2')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id) VALUES ('conv-3', 1, 1, 'project-1', 'claude', 'native-5')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id) VALUES ('conv-other-project', 1, 1, 'project-2', 'claude', 'native-3')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id) VALUES ('conv-other-user', 1, 2, 'project-1', 'claude', 'native-4')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id) VALUES ('conv-member', 1, 3, 'project-1', 'claude', 'native-6')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('conv-unfiled-1', 1, 1, 'claude', 'native-u1')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('conv-unfiled-2', 1, 1, 'claude', 'native-u2')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('conv-unfiled-other', 1, 2, 'claude', 'native-u3')").run();
    running = new Set<string>();
    remote = {
      configured: vi.fn(() => true),
      clientScope: vi.fn(() => 'client-a'),
      create: vi.fn(async () => undefined),
      createTemporary: vi.fn(async () => undefined),
      clone: vi.fn(async () => ({ sourceGeneration: 1 })),
      promote: vi.fn(async (_projectId: string, _profileId: string, _cloneId: string, expected: number) => ({
        generation: expected + 1,
      })),
      saveTemporary: vi.fn(async () => ({ generation: 1 })),
      rename: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      start: vi.fn(async (_projectId: string, profileId: string) => {
        running.add(profileId);
        return { active: true, status: 'running', runtimeId: `runtime-${profileId}` };
      }),
      stop: vi.fn(async (_projectId: string, profileId: string) => { running.delete(profileId); }),
      status: vi.fn(async (_projectId: string, profileId: string) => ({
        active: running.has(profileId),
        status: running.has(profileId) ? 'running' : 'stopped',
        runtimeId: running.has(profileId) ? `runtime-${profileId}` : undefined,
      })),
      // A current manager opens and starts a working copy in one round trip.
      open: vi.fn(async (_projectId: string, _sourceProfileId: string, cloneProfileId: string) => {
        running.add(cloneProfileId);
        return {
          cloneProfileId,
          adopted: false,
          sourceGeneration: 1,
          runtimeId: `runtime-${cloneProfileId}`,
          cdpUrl: 'wss://browser.example.test/cdp/opened-ticket/ws',
          viewerUrl: 'https://browser.example.test/cdp/opened-ticket',
          expiresAt: '2099-01-01T00:00:00Z',
        };
      }),
      ticket: vi.fn(async () => ({
        cdpUrl: 'wss://browser.example.test/cdp/short-lived-ticket/ws',
        viewerUrl: 'https://browser.example.test/cdp/short-lived-ticket',
        expiresAt: '2099-01-01T00:00:00Z',
      })),
      viewerConnection: vi.fn(async () => ({
        cdpUrl: 'wss://browser.example.test/cdp/short-lived-ticket/ws',
        viewerUrl: 'https://browser.example.test/cdp/short-lived-ticket',
        expiresAt: '2099-01-01T00:00:00Z',
        caFile: null,
      })),
      cdpCaFile: vi.fn(() => null),
      downloads: vi.fn(async () => [{ name: 'report.txt', size: 5, data: Buffer.from('hello').toString('base64') }]),
    } as never;
    runBrowser = vi.fn(async () => ({ args: ['snapshot', '-i'], stdout: 'page snapshot', stderr: '', exitCode: 0 }));
    closeBrowserSession = vi.fn(async () => undefined);
    readUrl = vi.fn(async () => ({ ok: true, final_url: 'https://example.com/', fetched_at: new Date().toISOString(), title: 'Example', text: 'Ready', tables: [], truncated: false }));
    manager = new VeneerBrowserManager({
      db,
      dataDir,
      remote,
      runBrowser: runBrowser as never,
      closeBrowserSession: closeBrowserSession as never,
      readUrl: readUrl as never,
    });
  });

  afterEach(() => {
    manager.shutdown();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads URLs in the selected working copy and serializes with interactive commands', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Personal');
    manager.selectForConversation(1, 'conv-1', profile.id);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    readUrl.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return { ok: true }; });
    const reading = manager.fetchUrl(1, 'conv-1', { url: 'https://example.com/' });
    await started;
    const command = manager.runCommand(1, 'conv-1', ['get', 'title']);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runBrowser).not.toHaveBeenCalled();
    expect((await manager.conversationSession(1, 'conv-1')).profileId).toBe(profile.id);
    finish();
    await reading;
    await command;
    expect(runBrowser).toHaveBeenCalledTimes(1);
    expect(readUrl.mock.calls[0]?.[1]).toMatchObject({ cdpUrl: 'wss://browser.example.test/cdp/short-lived-ticket/ws' });
    await expect(manager.fetchUrl(2, 'conv-1', { url: 'https://example.com/' })).rejects.toThrow('one of your chats');
    const invalid = await manager.fetchUrl(1, 'conv-1', { url: 'file:///etc/passwd' });
    expect(invalid.error?.code).toBe('invalid_request');
    expect(readUrl).toHaveBeenCalledTimes(1);
  });

  it('derives client and project scope and denies a cross-project profile id', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Sam Personal');
    expect(remote.create).toHaveBeenCalledWith('project-1', profile.id, 'Sam Personal');
    expect(() => manager.selectForConversation(1, 'conv-other-project', profile.id)).toThrow('not found in this project');
    expect(manager.listProfiles(1, 'owner', 'project-2').profiles).toEqual([]);
  });

  it('does not expose another authenticated client scope from the same database', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Client A');
    manager.selectForConversation(1, 'conv-1', profile.id);
    const other = new VeneerBrowserManager({ db, dataDir, remote: { ...remote, clientScope: () => 'client-b' } });
    expect(other.listProfiles(1, 'owner', 'project-1').profiles).toEqual([]);
    expect(await other.conversationSession(1, 'conv-1')).toMatchObject({ profileId: null, active: false });
    other.shutdown();
  });

  it('uses the project default automatically and always runs isolated working copies', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Sam Personal');
    await manager.openConversation(1, 'conv-1');
    await manager.openConversation(1, 'conv-2');

    const copies = db.prepare(
      'SELECT conversation_id, source_profile_id, clone_profile_id, mode FROM veneer_browser_clone_sessions ORDER BY conversation_id',
    ).all() as Array<{ conversation_id: string; source_profile_id: string; clone_profile_id: string; mode: string }>;
    expect(copies).toHaveLength(2);
    expect(copies.every((copy) => copy.source_profile_id === profile.id && copy.mode === 'profile')).toBe(true);
    expect(new Set(copies.map((copy) => copy.clone_profile_id)).size).toBe(2);
    expect(remote.open).toHaveBeenCalledTimes(2);
    expect(remote.start).not.toHaveBeenCalledWith('project-1', profile.id);
    const listed = manager.listProfiles(1, 'owner', 'project-1').profiles[0]!;
    expect(['conv-1', 'conv-2']).toContain(listed.activeConversationId);
    expect(listed.activeCloneCount).toBe(2);
    expect(await manager.conversationSession(1, 'conv-1')).toMatchObject({
      profileId: profile.id, active: true, temporaryClone: true, fresh: false, canUpdateProfile: true,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_profiles').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_conversation_profiles').get()).toEqual({ n: 2 });
  });

  it('reuses one per-user default across unfiled chats and isolates their working copies', async () => {
    const created = await manager.createForConversation(1, 'conv-unfiled-1', 'Sam Personal');
    expect(created).toMatchObject({ projectId: 'unfiled-user-1', profileName: 'Sam Personal' });
    const profile = db.prepare(
      'SELECT id, project_id FROM veneer_browser_profiles WHERE name = ?',
    ).get('Sam Personal') as { id: string; project_id: string };
    expect(profile.project_id).toBe('unfiled-user-1');
    expect(remote.create).toHaveBeenCalledWith('unfiled-user-1', profile.id, 'Sam Personal');
    expect(db.prepare('SELECT project_id, default_profile_id FROM veneer_browser_project_settings').get())
      .toEqual({ project_id: 'unfiled-user-1', default_profile_id: profile.id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'unfiled-user-1'").get()).toEqual({ n: 0 });

    await manager.openConversation(1, 'conv-unfiled-1');
    await manager.openConversation(1, 'conv-unfiled-2');
    const copies = db.prepare(
      `SELECT conversation_id, project_id, source_profile_id, clone_profile_id
       FROM veneer_browser_clone_sessions WHERE project_id = ? ORDER BY conversation_id`,
    ).all('unfiled-user-1') as Array<{
      conversation_id: string; project_id: string; source_profile_id: string; clone_profile_id: string;
    }>;
    expect(copies).toHaveLength(2);
    expect(copies.every((copy) => copy.source_profile_id === profile.id)).toBe(true);
    expect(new Set(copies.map((copy) => copy.clone_profile_id)).size).toBe(2);
    expect(manager.listProfilesForConversation(1, 'conv-unfiled-2')).toMatchObject([
      { id: profile.id, projectId: 'unfiled-user-1', name: 'Sam Personal' },
    ]);
    await manager.runCommand(1, 'conv-unfiled-2', ['snapshot', '-i']);
    expect(runBrowser).toHaveBeenLastCalledWith(['snapshot', '-i'], expect.objectContaining({
      workspaceDir: path.join(dataDir, 'workspaces', 'assistant'),
    }));
    expect(() => manager.selectForConversation(2, 'conv-unfiled-other', profile.id))
      .toThrow('not found in this project');
  });

  it('still removes saved browser records when a real project is deleted', async () => {
    const profile = await manager.createProfile(1, 'project-2', 'Project login');
    db.prepare("DELETE FROM projects WHERE id = 'project-2'").run();
    expect(db.prepare('SELECT id FROM veneer_browser_profiles WHERE id = ?').get(profile.id)).toBeUndefined();
    expect(db.prepare("SELECT * FROM veneer_browser_project_settings WHERE project_id = 'project-2'").get())
      .toBeUndefined();
  });

  it('opens a temporary signed-out copy without creating a permanent profile', async () => {
    const session = await manager.openConversation(1, 'conv-1');
    expect(session).toMatchObject({ active: true, profileId: null, temporaryClone: true, fresh: true });
    expect(remote.createTemporary).toHaveBeenCalledOnce();
    expect(remote.create).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_profiles').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT mode, source_profile_id FROM veneer_browser_clone_sessions').get())
      .toEqual({ mode: 'fresh', source_profile_id: null });
  });

  it('opens a signed-out copy only when it is explicitly selected', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Saved login');
    const session = await manager.openFreshConversation(1, 'conv-1');
    expect(session).toMatchObject({ active: true, profileId: null, fresh: true, canUpdateProfile: false });
    expect(remote.createTemporary).toHaveBeenCalledOnce();
    expect(remote.clone).not.toHaveBeenCalled();
    expect(manager.defaultProfileId(1, 'project-1')).toBe(profile.id);
  });

  it('does not discard an existing working copy when fresh is requested', async () => {
    await manager.createProfile(1, 'project-1', 'Saved login');
    await manager.openConversation(1, 'conv-1');
    const before = db.prepare('SELECT clone_profile_id FROM veneer_browser_clone_sessions').get();
    await expect(manager.openFreshConversation(1, 'conv-1')).rejects.toThrow('Stop or save');
    expect(db.prepare('SELECT clone_profile_id FROM veneer_browser_clone_sessions').get()).toEqual(before);
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it('deletes the working copy on normal stop and keeps the saved base', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Persistent');
    await manager.openConversation(1, 'conv-1');
    const copy = db.prepare('SELECT clone_profile_id FROM veneer_browser_clone_sessions').get() as { clone_profile_id: string };
    await manager.stopConversation(1, 'conv-1');
    expect(remote.stop).toHaveBeenCalledWith('project-1', copy.clone_profile_id);
    expect(closeBrowserSession).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      remoteSessionId: copy.clone_profile_id,
    }));
    expect(remote.delete).toHaveBeenCalledWith('project-1', copy.clone_profile_id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_clone_sessions').get()).toEqual({ n: 0 });
    expect(await manager.conversationSession(1, 'conv-1')).toMatchObject({ profileId: profile.id, active: false });
  });

  it('does not let a viewer reconnect recreate a discarded working copy', async () => {
    await manager.createProfile(1, 'project-1', 'Persistent');
    await expect(manager.viewerTicketForConversation(1, 'conv-1')).rejects.toThrow('Open this chat browser');
    expect(remote.clone).not.toHaveBeenCalled();

    await manager.openConversation(1, 'conv-1');
    await expect(manager.viewerTicketForConversation(1, 'conv-1')).resolves
      .toEqual({ ticket: 'https://browser.example.test/cdp/short-lived-ticket', caFile: null });
    expect(remote.viewerConnection).toHaveBeenLastCalledWith('project-1', expect.any(String));
    await manager.stopConversation(1, 'conv-1');
    remote.clone.mockClear();

    await expect(manager.viewerTicketForConversation(1, 'conv-1')).rejects.toThrow('Open this chat browser');
    expect(remote.clone).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_clone_sessions').get()).toEqual({ n: 0 });
  });

  it('updates a saved profile only through the explicit generation-checked action', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Saved login');
    await manager.openConversation(1, 'conv-1');
    const copy = db.prepare(
      'SELECT clone_profile_id, source_generation FROM veneer_browser_clone_sessions WHERE conversation_id = ?',
    ).get('conv-1') as { clone_profile_id: string; source_generation: number };

    const session = await manager.updateConversationProfile(1, 'conv-1');
    expect(remote.promote).toHaveBeenCalledWith('project-1', profile.id, copy.clone_profile_id, 1);
    expect(remote.delete).toHaveBeenCalledWith('project-1', copy.clone_profile_id);
    expect(db.prepare('SELECT generation FROM veneer_browser_profiles WHERE id = ?').get(profile.id)).toEqual({ generation: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_clone_sessions').get()).toEqual({ n: 0 });
    expect(session).toMatchObject({ profileId: profile.id, active: false, temporaryClone: false });
  });

  it('keeps an old working copy when a newer profile generation wins', async () => {
    await manager.createProfile(1, 'project-1', 'Saved login');
    await manager.openConversation(1, 'conv-1');
    remote.promote.mockRejectedValueOnce(new VeneerBrowserRemoteError(409));

    await expect(manager.updateConversationProfile(1, 'conv-1')).rejects.toThrow('changed after this working copy started');
    expect(db.prepare('SELECT status, last_error FROM veneer_browser_clone_sessions').get()).toMatchObject({
      status: 'error',
      last_error: expect.stringContaining('Save it as a new profile'),
    });
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it('saves a temporary signed-out copy as a new profile only after an explicit action', async () => {
    await manager.openConversation(1, 'conv-1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_profiles').get()).toEqual({ n: 0 });
    const session = await manager.saveConversationAsProfile(1, 'conv-1', 'Work Gmail');
    const saved = db.prepare('SELECT id, name, generation FROM veneer_browser_profiles').get() as {
      id: string; name: string; generation: number;
    };
    expect(remote.saveTemporary).toHaveBeenCalledWith('project-1', expect.any(String), saved.id, 'Work Gmail');
    expect(saved).toMatchObject({ name: 'Work Gmail', generation: 1 });
    expect(manager.defaultProfileId(1, 'project-1')).toBe(saved.id);
    expect(session).toMatchObject({ profileId: saved.id, active: false, temporaryClone: false });
  });

  it('keeps the default valid after its saved profile is deleted', async () => {
    const first = await manager.createProfile(1, 'project-1', 'First');
    const second = await manager.createProfile(1, 'project-1', 'Second');
    expect(manager.defaultProfileId(1, 'project-1')).toBe(first.id);
    await manager.deleteProfile(1, 'owner', 'project-1', first.id);
    expect(manager.defaultProfileId(1, 'project-1')).toBe(second.id);
  });


  it('keeps each user\u2019s saved profiles private inside a shared project', async () => {
    const mine = await manager.createProfile(1, 'project-1', 'Mine');
    const theirs = await manager.createProfile(2, 'project-1', 'Theirs');

    expect(manager.listProfiles(1, 'owner', 'project-1').profiles)
      .toMatchObject([{ id: mine.id, ownerUserId: 1 }]);
    expect(manager.listProfiles(2, 'member', 'project-1').profiles)
      .toMatchObject([{ id: theirs.id, ownerUserId: 2 }]);
    expect(manager.listProfilesForConversation(2, 'conv-other-user')).toMatchObject([{ id: theirs.id }]);
    expect(() => manager.selectForConversation(2, 'conv-other-user', mine.id))
      .toThrow('not found in this project');
    await expect(manager.renameProfile(2, 'project-1', mine.id, 'Renamed'))
      .rejects.toThrow('not found in this project');
    expect(() => manager.setDefaultProfile(2, 'project-1', mine.id)).toThrow('not found in this project');
    await expect(manager.stopProfile(2, 'project-1', mine.id)).rejects.toThrow('not found in this project');
    await expect(manager.refreshProfile(2, 'project-1', mine.id)).rejects.toThrow('not found in this project');
  });

  it('gives each user their own default in the same project', async () => {
    const mine = await manager.createProfile(1, 'project-1', 'Mine');
    const theirs = await manager.createProfile(2, 'project-1', 'Theirs');
    expect(manager.defaultProfileId(1, 'project-1')).toBe(mine.id);
    expect(manager.defaultProfileId(2, 'project-1')).toBe(theirs.id);

    const second = await manager.createProfile(1, 'project-1', 'My second');
    manager.setDefaultProfile(1, 'project-1', second.id);
    expect(manager.defaultProfileId(1, 'project-1')).toBe(second.id);
    expect(manager.defaultProfileId(2, 'project-1')).toBe(theirs.id);

    await manager.openConversation(2, 'conv-other-user');
    expect(db.prepare('SELECT source_profile_id FROM veneer_browser_clone_sessions WHERE conversation_id = ?')
      .get('conv-other-user')).toEqual({ source_profile_id: theirs.id });
  });

  it('lets an account owner list and delete a teammate\u2019s profile but never use it', async () => {
    const mine = await manager.createProfile(1, 'project-1', 'Mine');
    const theirs = await manager.createProfile(2, 'project-1', 'Theirs');

    const asOwner = manager.listProfiles(1, 'owner', 'project-1');
    expect(asOwner.profiles).toMatchObject([{ id: mine.id }]);
    expect(asOwner.others).toMatchObject([{ id: theirs.id, ownerUserId: 2, ownerName: 'Other' }]);
    expect(manager.listProfiles(3, 'member', 'project-1')).toMatchObject({ profiles: [], others: [] });

    // Cleanup is the only owner power here: attaching, renaming, and choosing
    // someone else's profile as a default all stay refused.
    expect(() => manager.selectForConversation(1, 'conv-1', theirs.id)).toThrow('not found in this project');
    await expect(manager.renameProfile(1, 'project-1', theirs.id, 'Seized'))
      .rejects.toThrow('not found in this project');
    expect(() => manager.setDefaultProfile(1, 'project-1', theirs.id)).toThrow('not found in this project');

    await expect(manager.deleteProfile(3, 'member', 'project-1', theirs.id))
      .rejects.toThrow('not found in this project');
    await manager.deleteProfile(1, 'owner', 'project-1', theirs.id);
    expect(remote.delete).toHaveBeenCalledWith('project-1', theirs.id);
    expect(db.prepare('SELECT id FROM veneer_browser_profiles ORDER BY id').all()).toEqual([{ id: mine.id }]);
  });

  it('replaces a deleted profile\u2019s default for its owner, not for the actor', async () => {
    const mine = await manager.createProfile(1, 'project-1', 'Mine');
    const theirFirst = await manager.createProfile(2, 'project-1', 'Their first');
    const theirSecond = await manager.createProfile(2, 'project-1', 'Their second');
    expect(manager.defaultProfileId(2, 'project-1')).toBe(theirFirst.id);

    await manager.deleteProfile(1, 'owner', 'project-1', theirFirst.id);
    expect(manager.defaultProfileId(2, 'project-1')).toBe(theirSecond.id);
    expect(manager.defaultProfileId(1, 'project-1')).toBe(mine.id);
  });

  it('gives every parallel chat its own working copy of one saved base', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Team login');
    await Promise.all([
      manager.openConversation(1, 'conv-1'),
      manager.openConversation(1, 'conv-2'),
      manager.openConversation(1, 'conv-3'),
    ]);
    const copies = db.prepare('SELECT source_profile_id, clone_profile_id FROM veneer_browser_clone_sessions').all() as
      Array<{ source_profile_id: string; clone_profile_id: string }>;
    expect(copies).toHaveLength(3);
    expect(copies.every((copy) => copy.source_profile_id === profile.id)).toBe(true);
    expect(new Set(copies.map((copy) => copy.clone_profile_id)).size).toBe(3);
  });

  it('keeps temporary data when stop fails', async () => {
    await manager.createProfile(1, 'project-1', 'Protected copy');
    await manager.openConversation(1, 'conv-1');
    remote.stop.mockRejectedValueOnce(new Error('stop failed'));
    await expect(manager.stopConversation(1, 'conv-1')).rejects.toThrow('kept its data');
    expect(closeBrowserSession).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status, last_error FROM veneer_browser_clone_sessions').get())
      .toEqual({ status: 'error', last_error: 'The temporary browser did not stop.' });
  });

  it('removes a local copy record after the remote stale cleaner deletes it', async () => {
    await manager.createProfile(1, 'project-1', 'Stale copy');
    await manager.openConversation(1, 'conv-1');
    const copy = db.prepare('SELECT clone_profile_id FROM veneer_browser_clone_sessions').get() as { clone_profile_id: string };
    running.delete(copy.clone_profile_id);
    remote.status.mockImplementation(async (_projectId: string, profileId: string) => {
      if (profileId === copy.clone_profile_id) throw new VeneerBrowserRemoteError(404);
      return { active: false, status: 'stopped' };
    });
    await manager.reconcile();
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_clone_sessions').get()).toEqual({ n: 0 });
  });

  it('retains the saved profile when its chat is deleted', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Keep me');
    await manager.openConversation(1, 'conv-1');
    await manager.stopConversation(1, 'conv-1');
    db.prepare("DELETE FROM conversations WHERE id = 'conv-1'").run();
    expect(db.prepare('SELECT id FROM veneer_browser_profiles WHERE id = ?').get(profile.id)).toEqual({ id: profile.id });
  });

  it('denies another user and keeps the derived client, project, and chat scope', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Scoped');
    expect(() => manager.selectForConversation(2, 'conv-1', profile.id)).toThrow('requires one of your chats');
    expect(() => manager.selectForConversation(1, 'conv-other-project', profile.id)).toThrow('not found in this project');
    manager.selectForConversation(1, 'conv-1', profile.id);
    expect(db.prepare(
      'SELECT conversation_id, client_scope, project_id, profile_id FROM veneer_browser_conversation_profiles WHERE conversation_id = ?',
    ).get('conv-1')).toEqual({
      conversation_id: 'conv-1', client_scope: 'client-a', project_id: 'project-1', profile_id: profile.id,
    });
  });

  it('records a safe error after a working-copy start failure and lets the same chat retry', async () => {
    await manager.createProfile(1, 'project-1', 'Retry');
    // An older manager has no open route, so this exercises the legacy sequence.
    remote.open.mockRejectedValue(new VeneerBrowserRemoteError(404));
    remote.start.mockRejectedValueOnce(new Error('remote included a secret value'));
    await expect(manager.openConversation(1, 'conv-1')).rejects.toThrow('kept for a safe retry');
    expect(db.prepare('SELECT status, last_error FROM veneer_browser_clone_sessions').get())
      .toEqual({ status: 'error', last_error: 'The temporary browser runtime did not start.' });
    expect(JSON.stringify(db.prepare('SELECT * FROM veneer_browser_clone_sessions').all())).not.toContain('secret value');
    await manager.openConversation(1, 'conv-1');
    expect(await manager.conversationSession(1, 'conv-1')).toMatchObject({ active: true, error: null });
  });

  it('uses a short-lived ticket without storing it or browser output', async () => {
    const runBrowser = vi.fn(async () => ({ args: [], stdout: 'private page text', stderr: '', exitCode: 0 }));
    manager.shutdown();
    manager = new VeneerBrowserManager({
      db,
      dataDir,
      remote,
      runBrowser: runBrowser as never,
      closeBrowserSession: closeBrowserSession as never,
    });
    await manager.runCommand(1, 'conv-1', ['snapshot', '-i']);
    expect(remote.ticket).toHaveBeenLastCalledWith('project-1', expect.any(String), 'agent');
    expect(runBrowser).toHaveBeenCalledWith(['snapshot', '-i'], expect.objectContaining({
      remoteCdpUrl: 'wss://browser.example.test/cdp/short-lived-ticket/ws',
    }));
    const stored = JSON.stringify({
      copies: db.prepare('SELECT * FROM veneer_browser_clone_sessions').all(),
      audit: db.prepare('SELECT * FROM veneer_browser_audit').all(),
    });
    expect(stored).not.toContain('short-lived-ticket');
    expect(stored).not.toContain('private page text');
    expect(stored).not.toContain('https://browser.example.test');
    expect(db.prepare("SELECT action, metadata_json FROM veneer_browser_audit WHERE action = 'command.executed'").get())
      .toEqual({ action: 'command.executed', metadata_json: '{"command":"snapshot","success":true}' });
  });

  const grants = (): number => (db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_capture_grants').get() as { n: number }).n;
  const captureAudit = (): string[] => (db.prepare(
    "SELECT action FROM veneer_browser_audit WHERE action LIKE 'capture.%' ORDER BY id",
  ).all() as { action: string }[]).map((row) => row.action);
  const cloneId = (conversationId: string): string => (db.prepare(
    'SELECT clone_profile_id FROM veneer_browser_clone_sessions WHERE conversation_id = ?',
  ).get(conversationId) as { clone_profile_id: string }).clone_profile_id;

  it('grants Advanced capture only for an open working copy and only to the chat owner', async () => {
    await manager.createProfile(1, 'project-1', 'Capture base');
    expect(manager.captureGrantActive('conv-1')).toBe(false);
    expect(() => manager.setCaptureGrant(1, 'conv-1', true)).toThrow('Open this chat browser');
    expect(grants()).toBe(0);

    await manager.openConversation(1, 'conv-1');
    expect(manager.setCaptureGrant(1, 'conv-1', true)).toEqual({ active: true });
    expect(manager.captureGrantActive('conv-1')).toBe(true);
    expect(manager.conversationCapture(1, 'conv-1')).toEqual({ active: true });
    expect(db.prepare('SELECT conversation_id, client_scope, clone_profile_id, granted_by FROM veneer_browser_capture_grants').get())
      .toEqual({
        conversation_id: 'conv-1',
        client_scope: 'client-a',
        clone_profile_id: cloneId('conv-1'),
        granted_by: 1,
      });
    expect(captureAudit()).toEqual(['capture.granted']);

    expect(() => manager.setCaptureGrant(2, 'conv-1', true)).toThrow('requires one of your chats');
    expect(() => manager.conversationCapture(2, 'conv-1')).toThrow('requires one of your chats');
    // A grant belongs to one chat, never to the profile or to a sibling chat.
    expect(manager.captureGrantActive('conv-2')).toBe(false);
  });

  // Advanced capture records request bodies. A password that has landed in a
  // form but has not been submitted yet is exactly the body it would record, so
  // the grant has to wait for the page to move on.
  it('refuses Advanced capture while a secret is still sitting in the page', async () => {
    await manager.createProfile(1, 'project-1', 'Capture base');
    await manager.openConversation(1, 'conv-1');
    rememberSecretField('conv-1', '@e3');
    try {
      expect(() => manager.setCaptureGrant(1, 'conv-1', true))
        .toThrow('A secret was just filled into this page; navigate away before enabling Advanced capture.');
      expect(grants()).toBe(0);
      expect(manager.captureGrantActive('conv-1')).toBe(false);

      // Turning capture OFF is never blocked; only enabling it is.
      expect(manager.setCaptureGrant(1, 'conv-1', false)).toEqual({ active: false });

      // A sibling chat with no live secret is unaffected.
      await manager.openConversation(1, 'conv-2');
      expect(manager.setCaptureGrant(1, 'conv-2', true)).toEqual({ active: true });
    } finally {
      clearSecretFields('conv-1');
      clearSecretFields('conv-2');
    }

    // Navigating retires the field, which is what makes the grant legal again.
    expect(manager.setCaptureGrant(1, 'conv-1', true)).toEqual({ active: true });
  });

  it('never lets a capture grant reach a different working copy', async () => {
    await manager.createProfile(1, 'project-1', 'Capture base');
    await manager.openConversation(1, 'conv-1');
    manager.setCaptureGrant(1, 'conv-1', true);
    // Same chat, same row, but the copy it was granted for is gone.
    db.prepare('UPDATE veneer_browser_capture_grants SET clone_profile_id = ?').run('some-other-copy');
    expect(manager.captureGrantActive('conv-1')).toBe(false);

    const other = new VeneerBrowserManager({ db, dataDir, remote: { ...remote, clientScope: () => 'client-b' } });
    expect(other.captureGrantActive('conv-1')).toBe(false);
    other.shutdown();
  });

  it('revokes a capture grant on request, with or without a live copy', async () => {
    await manager.createProfile(1, 'project-1', 'Capture base');
    await manager.openConversation(1, 'conv-1');
    manager.setCaptureGrant(1, 'conv-1', true);
    expect(manager.setCaptureGrant(1, 'conv-1', false)).toEqual({ active: false });
    expect(grants()).toBe(0);
    expect(captureAudit()).toEqual(['capture.granted', 'capture.revoked']);
    expect(manager.setCaptureGrant(1, 'conv-2', false)).toEqual({ active: false });
  });

  it('drops a capture grant when the working copy is discarded and never revives it', async () => {
    await manager.createProfile(1, 'project-1', 'Capture base');
    await manager.openConversation(1, 'conv-1');
    manager.setCaptureGrant(1, 'conv-1', true);

    await manager.stopConversation(1, 'conv-1');
    expect(manager.captureGrantActive('conv-1')).toBe(false);
    expect(grants()).toBe(0);
    expect(captureAudit()).toEqual(['capture.granted', 'capture.expired']);

    // A brand new working copy starts locked again.
    await manager.openConversation(1, 'conv-1');
    expect(manager.captureGrantActive('conv-1')).toBe(false);
    expect(grants()).toBe(0);
  });

  it('drops a capture grant when the copy is promoted, saved, or vanishes remotely', async () => {
    await manager.createProfile(1, 'project-1', 'Capture base');
    await manager.openConversation(1, 'conv-1');
    manager.setCaptureGrant(1, 'conv-1', true);
    await manager.updateConversationProfile(1, 'conv-1');
    expect(manager.captureGrantActive('conv-1')).toBe(false);
    expect(grants()).toBe(0);

    await manager.openFreshConversation(1, 'conv-2');
    manager.setCaptureGrant(1, 'conv-2', true);
    await manager.saveConversationAsProfile(1, 'conv-2', 'Saved capture');
    expect(manager.captureGrantActive('conv-2')).toBe(false);
    expect(grants()).toBe(0);

    await manager.openConversation(1, 'conv-3');
    manager.setCaptureGrant(1, 'conv-3', true);
    const stale = cloneId('conv-3');
    remote.status.mockImplementation(async (_projectId: string, profileId: string) => {
      if (profileId === stale) throw new VeneerBrowserRemoteError(404);
      return { active: false, status: 'stopped' };
    });
    await manager.reconcile();
    expect(db.prepare('SELECT COUNT(*) AS n FROM veneer_browser_clone_sessions').get()).toEqual({ n: 0 });
    expect(manager.captureGrantActive('conv-3')).toBe(false);
    expect(grants()).toBe(0);
    expect(captureAudit().filter((action) => action === 'capture.expired')).toHaveLength(3);
  });

  it('records the working copy the manager adopted, not the one it was offered', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Warm base');
    remote.open.mockImplementationOnce(async () => {
      running.add('warm-copy-7');
      return {
        cloneProfileId: 'warm-copy-7',
        adopted: true,
        sourceGeneration: 4,
        runtimeId: 'runtime-warm-copy-7',
        cdpUrl: 'wss://browser.example.test/cdp/warm-ticket/ws',
        viewerUrl: 'https://browser.example.test/cdp/warm-ticket',
        expiresAt: '2099-01-01T00:00:00Z',
      };
    });

    const session = await manager.openConversation(1, 'conv-1');
    expect(session).toMatchObject({ active: true, profileId: profile.id, temporaryClone: true });
    expect(remote.open).toHaveBeenCalledWith('project-1', profile.id, expect.any(String), 'agent');
    expect(remote.clone).not.toHaveBeenCalled();
    expect(remote.start).not.toHaveBeenCalled();
    expect(db.prepare(
      'SELECT clone_profile_id, source_generation, status, remote_runtime_id FROM veneer_browser_clone_sessions',
    ).get()).toMatchObject({
      clone_profile_id: 'warm-copy-7',
      source_generation: 4,
      status: 'active',
      remote_runtime_id: 'runtime-warm-copy-7',
    });
    expect(db.prepare('SELECT generation FROM veneer_browser_profiles WHERE id = ?').get(profile.id))
      .toEqual({ generation: 4 });

    // What came back is already an agent ticket, so the first command adds nothing.
    await manager.runCommand(1, 'conv-1', ['snapshot', '-i']);
    expect(remote.ticket).not.toHaveBeenCalled();
    expect(runBrowser).toHaveBeenLastCalledWith(['snapshot', '-i'], expect.objectContaining({
      remoteCdpUrl: 'wss://browser.example.test/cdp/warm-ticket/ws',
      remoteSessionId: 'warm-copy-7',
    }));
  });

  it('drops the address from an open that came over the LAN and mints a usable one', async () => {
    await manager.createProfile(1, 'project-1', 'LAN base');
    // agent-browser trusts only its own certificate roots, so a LAN address in
    // an open reply is unusable however well this side trusts it.
    remote.cdpCaFile.mockImplementation((url: string) => (url.includes('browser.lan.test') ? '/etc/lan-ca.pem' : null));
    remote.open.mockImplementationOnce(async (_projectId: string, _sourceProfileId: string, cloneProfileId: string) => {
      running.add(cloneProfileId);
      return {
        cloneProfileId,
        adopted: false,
        sourceGeneration: 1,
        runtimeId: `runtime-${cloneProfileId}`,
        cdpUrl: 'wss://browser.lan.test:8443/cdp/lan-ticket/ws',
        viewerUrl: 'https://browser.lan.test:8443/cdp/lan-ticket',
        expiresAt: '2099-01-01T00:00:00Z',
      };
    });

    await manager.openConversation(1, 'conv-1');
    await manager.runCommand(1, 'conv-1', ['snapshot', '-i']);
    expect(remote.ticket).toHaveBeenCalledOnce();
    expect(runBrowser).toHaveBeenLastCalledWith(['snapshot', '-i'], expect.objectContaining({
      remoteCdpUrl: 'wss://browser.example.test/cdp/short-lived-ticket/ws',
    }));
    expect(runBrowser.mock.lastCall?.[1]).not.toHaveProperty('cdpCaFile');
  });

  it('falls back to the older clone-then-start sequence when the manager has no open route', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Legacy base');
    remote.open.mockRejectedValue(new VeneerBrowserRemoteError(404));

    const session = await manager.openConversation(1, 'conv-1');
    expect(session).toMatchObject({ active: true, profileId: profile.id, temporaryClone: true });
    expect(remote.clone).toHaveBeenCalledOnce();
    expect(remote.start).toHaveBeenCalledOnce();
    await manager.runCommand(1, 'conv-1', ['snapshot', '-i']);
    expect(remote.ticket).toHaveBeenLastCalledWith('project-1', cloneId('conv-1'), 'agent');
    expect(runBrowser).toHaveBeenLastCalledWith(['snapshot', '-i'], expect.objectContaining({
      remoteCdpUrl: 'wss://browser.example.test/cdp/short-lived-ticket/ws',
    }));
  });

  it('keeps a hot chat off the remote for repeat commands and reuses its agent ticket', async () => {
    await manager.openConversation(1, 'conv-1');
    remote.start.mockClear();
    remote.status.mockClear();

    await manager.runCommand(1, 'conv-1', ['snapshot', '-i']);
    expect(remote.start).toHaveBeenCalledOnce();
    expect(remote.ticket).toHaveBeenCalledOnce();

    await manager.runCommand(1, 'conv-1', ['get', 'url']);
    expect(remote.start).toHaveBeenCalledOnce();
    expect(remote.status).not.toHaveBeenCalled();
    expect(remote.ticket).toHaveBeenCalledOnce();
    expect(runBrowser).toHaveBeenCalledTimes(2);
    // Skipping the round trip never skips the record of what ran.
    expect(db.prepare("SELECT COUNT(*) AS n FROM veneer_browser_audit WHERE action = 'command.executed'").get())
      .toEqual({ n: 2 });
    expect(db.prepare('SELECT status, last_used_at FROM veneer_browser_clone_sessions').get())
      .toMatchObject({ status: 'active', last_used_at: expect.any(String) });
  });

  it('retries a lost connection once through a cold start and audits only the final attempt', async () => {
    await manager.createProfile(1, 'project-1', 'Retry base');
    await manager.openConversation(1, 'conv-1');
    remote.status.mockClear();
    runBrowser.mockResolvedValueOnce({
      args: ['snapshot', '-i'],
      stdout: '',
      stderr: 'WebSocket connection closed before the response was received',
      exitCode: 1,
    });

    const result = await manager.runCommand(1, 'conv-1', ['snapshot', '-i']);
    expect(result.exitCode).toBe(0);
    expect(runBrowser).toHaveBeenCalledTimes(2);
    expect(closeBrowserSession).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      remoteSessionId: cloneId('conv-1'),
    }));
    // The retry re-checks the copy against the manager and takes a fresh address.
    expect(remote.status).toHaveBeenCalledWith('project-1', cloneId('conv-1'));
    expect(remote.ticket).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT action, metadata_json FROM veneer_browser_audit WHERE action = 'command.executed'").all())
      .toEqual([{ action: 'command.executed', metadata_json: '{"command":"snapshot","success":true}' }]);
  });

  it('never replays a page-level failure while the working copy is still alive', async () => {
    await manager.createProfile(1, 'project-1', 'Live copy');
    await manager.openConversation(1, 'conv-1');
    remote.status.mockClear();
    runBrowser.mockResolvedValueOnce({
      args: ['click', '@e5'],
      stdout: '',
      stderr: 'Element @e5 is no longer in the page snapshot.',
      exitCode: 1,
    });

    const result = await manager.runCommand(1, 'conv-1', ['click', '@e5']);
    // The click may already have had its effect, so its answer stands as it is.
    expect(result).toMatchObject({ exitCode: 1, stderr: 'Element @e5 is no longer in the page snapshot.' });
    expect(runBrowser).toHaveBeenCalledOnce();
    // The copy was still checked against the manager before that was decided.
    expect(remote.status).toHaveBeenCalledWith('project-1', cloneId('conv-1'));
    expect(db.prepare("SELECT metadata_json FROM veneer_browser_audit WHERE action = 'command.executed'").all())
      .toEqual([{ metadata_json: '{"command":"click","success":false}' }]);
    expect(db.prepare('SELECT status, last_error FROM veneer_browser_clone_sessions').get())
      .toMatchObject({ status: 'active', last_error: 'Browser command failed.' });
  });

  it('retries a page-level failure when the runtime behind it actually died', async () => {
    await manager.createProfile(1, 'project-1', 'Dead copy');
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockResolvedValueOnce({
      args: ['click', '@e5'],
      stdout: '',
      stderr: 'Element @e5 is no longer in the page snapshot.',
      exitCode: 1,
    });
    running.delete(cloneId('conv-1'));

    const result = await manager.runCommand(1, 'conv-1', ['click', '@e5']);
    expect(result.exitCode).toBe(0);
    expect(runBrowser).toHaveBeenCalledTimes(2);
    expect(remote.start).toHaveBeenCalled();
  });

  it('keeps one control address for the daemon instead of rotating tickets', async () => {
    await manager.createProfile(1, 'project-1', 'Sticky address');
    await manager.openConversation(1, 'conv-1');

    // Far beyond the old three-use budget: the daemon holds one connection per
    // address, so more commands on the same address spend nothing — and a
    // rotated address would make the daemon re-dial, dropping its selected tab
    // and every @ref mid-task.
    for (let command = 0; command < 8; command += 1) await manager.runCommand(1, 'conv-1', ['get', 'url']);
    expect(remote.ticket).not.toHaveBeenCalled();
    expect(runBrowser).toHaveBeenLastCalledWith(['get', 'url'], expect.objectContaining({
      remoteCdpUrl: 'wss://browser.example.test/cdp/opened-ticket/ws',
    }));

    // Expiry and age gate only a NEW connection; an address the daemon already
    // connected with outlives both.
    const cache = (manager as unknown as {
      runtimeCache: Map<string, { ticket?: { issuedAt: number; expiresAt: string } }>;
    }).runtimeCache;
    const held = cache.get('conv-1')!.ticket!;
    held.issuedAt = Date.now() - 10 * 60_000;
    held.expiresAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await manager.runCommand(1, 'conv-1', ['get', 'url']);
    expect(remote.ticket).not.toHaveBeenCalled();
  });

  it('replaces a held ticket that expired before it ever carried a command', async () => {
    await manager.createProfile(1, 'project-1', 'Stale first ticket');
    await manager.openConversation(1, 'conv-1');

    // The address from open never carried a command, so the daemon has no
    // connection on it and the first command must not dial a dead address.
    const cache = (manager as unknown as {
      runtimeCache: Map<string, { ticket?: { useCount: number; expiresAt: string } }>;
    }).runtimeCache;
    const held = cache.get('conv-1')!.ticket!;
    expect(held.useCount).toBe(0);
    held.expiresAt = new Date(Date.now() - 1).toISOString();

    await manager.runCommand(1, 'conv-1', ['get', 'url']);
    expect(remote.ticket).toHaveBeenCalledOnce();
    expect(runBrowser).toHaveBeenLastCalledWith(['get', 'url'], expect.objectContaining({
      remoteCdpUrl: 'wss://browser.example.test/cdp/short-lived-ticket/ws',
    }));
  });

  it('forgets the cached runtime of a chat that went quiet', async () => {
    vi.useFakeTimers();
    try {
      const quiet = new VeneerBrowserManager({
        db,
        dataDir,
        remote,
        runBrowser: runBrowser as never,
        closeBrowserSession: closeBrowserSession as never,
      });
      // Read directly: the cache is a round-trip saver with no visible effect
      // after ten minutes anyway, so only the memory it holds can be observed.
      const cache = (quiet as unknown as { runtimeCache: Map<string, unknown> }).runtimeCache;
      await quiet.openConversation(1, 'conv-1');
      await quiet.runCommand(1, 'conv-1', ['get', 'url']);
      expect(cache.size).toBe(1);

      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(cache.size).toBe(0);
      quiet.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never replays a thrown command while the working copy is still alive', async () => {
    await manager.createProfile(1, 'project-1', 'Timed out');
    await manager.openConversation(1, 'conv-1');
    // A command killed on this side's own timeout or output cap says nothing
    // about the copy: it may have navigated the page before it was cut off.
    runBrowser.mockRejectedValue(new Error('agent-browser timed out after 60000ms.'));

    await expect(manager.runCommand(1, 'conv-1', ['click', '@e5'])).rejects.toThrow('timed out');
    expect(runBrowser).toHaveBeenCalledOnce();
    expect(remote.status).toHaveBeenCalledWith('project-1', cloneId('conv-1'));
    expect(db.prepare("SELECT COUNT(*) AS n FROM veneer_browser_audit WHERE action = 'command.executed'").get())
      .toEqual({ n: 0 });
  });

  it('retries a thrown command when the runtime behind it is gone, then reports a second failure', async () => {
    await manager.createProfile(1, 'project-1', 'Retry base');
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockRejectedValue(new Error('CDP WebSocket connect failed.'));
    running.delete(cloneId('conv-1'));

    await expect(manager.runCommand(1, 'conv-1', ['snapshot', '-i'])).rejects.toThrow('connect failed');
    expect(runBrowser).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM veneer_browser_audit WHERE action = 'command.executed'").get())
      .toEqual({ n: 0 });
  });

  it('reads transport evidence from stderr only, never from what the page said', async () => {
    await manager.createProfile(1, 'project-1', 'Page text');
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockResolvedValueOnce({
      args: ['click', '@e5'],
      stdout: 'Your 401(k) balance — WebSocket status: connected — ETIMEDOUT is not a word on this page.',
      stderr: 'Element @e5 is no longer in the page snapshot.',
      exitCode: 1,
    });

    const result = await manager.runCommand(1, 'conv-1', ['click', '@e5']);
    // The click may already have submitted something, so its answer stands.
    expect(result).toMatchObject({ exitCode: 1 });
    expect(runBrowser).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT metadata_json FROM veneer_browser_audit WHERE action = 'command.executed'").all())
      .toEqual([{ metadata_json: '{"command":"click","success":false}' }]);
  });

  it('hands agent-browser the pinned certificate only for a LAN control address', async () => {
    await manager.openConversation(1, 'conv-1');
    remote.cdpCaFile.mockReturnValue('/etc/veneer-pro/browser-lan-ca.pem');
    await manager.runCommand(1, 'conv-1', ['snapshot', '-i']);
    expect(runBrowser).toHaveBeenLastCalledWith(['snapshot', '-i'], expect.objectContaining({
      cdpCaFile: '/etc/veneer-pro/browser-lan-ca.pem',
    }));

    remote.cdpCaFile.mockReturnValue(null);
    await manager.runCommand(1, 'conv-1', ['get', 'url']);
    expect(runBrowser.mock.lastCall?.[1]).not.toHaveProperty('cdpCaFile');
  });

  it('runs a pointer sequence inside one queue slot, ahead of the next chat command', async () => {
    await manager.openConversation(1, 'conv-1');
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runBrowser.mockImplementation(async (args: string[]) => {
      order.push(args.join(' '));
      if (args[0] === 'mouse' && args[1] === 'move') await gate;
      return { args, stdout: '', stderr: '', exitCode: 0 };
    });

    const sequence = manager.runCommands(1, 'conv-1', [
      ['mouse', 'move', '10', '20'], ['mouse', 'down', 'left'], ['mouse', 'up', 'left'],
    ]);
    const other = manager.runCommand(1, 'conv-1', ['get', 'url']);
    release();
    const result = await sequence;
    await other;

    // Nothing may land between the button going down and coming back up.
    expect(order).toEqual(['mouse move 10 20', 'mouse down left', 'mouse up left', 'get url']);
    expect(result.failure).toBeNull();
    expect(result.steps.map((step) => step.command)).toEqual([
      ['mouse', 'move', '10', '20'], ['mouse', 'down', 'left'], ['mouse', 'up', 'left'],
    ]);
    expect(db.prepare("SELECT metadata_json FROM veneer_browser_audit WHERE action = 'command.executed'").all())
      .toEqual([
        { metadata_json: '{"command":"mouse move","success":true}' },
        { metadata_json: '{"command":"mouse down","success":true}' },
        { metadata_json: '{"command":"mouse up","success":true}' },
        { metadata_json: '{"command":"get","success":true}' },
      ]);
  });

  it('aborts a pointer sequence at its first failure and never replays a later member', async () => {
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockImplementation(async (args: string[]) => (
      args[1] === 'down'
        ? { args, stdout: '', stderr: 'CDP WebSocket connect failed', exitCode: 1 }
        : { args, stdout: '', stderr: '', exitCode: 0 }
    ));
    // The copy really is gone, which is exactly what makes a first command retry
    // — a later member must still refuse to press the button twice.
    running.delete(cloneId('conv-1'));

    const result = await manager.runCommands(1, 'conv-1', [
      ['mouse', 'move', '5', '6'], ['mouse', 'down', 'left'], ['mouse', 'up', 'left'],
    ]);

    expect(result.failure).toMatchObject({ index: 1, command: ['mouse', 'down', 'left'] });
    expect(result.failure?.output).toContain('CDP WebSocket connect failed');
    expect(result.released).toBe(false);
    expect(runBrowser.mock.calls.map((call) => (call[0] as string[]).join(' ')))
      .toEqual(['mouse move 5 6', 'mouse down left']);
  });

  it('retries only the first member of a sequence when the copy behind it was gone', async () => {
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockResolvedValueOnce({
      args: ['mouse', 'move', '5', '6'],
      stdout: '',
      stderr: 'CDP WebSocket connect failed',
      exitCode: 1,
    });
    running.delete(cloneId('conv-1'));

    const result = await manager.runCommands(1, 'conv-1', [['mouse', 'move', '5', '6'], ['mouse', 'down', 'left']]);
    expect(result.failure).toBeNull();
    expect(runBrowser.mock.calls.map((call) => (call[0] as string[]).join(' ')))
      .toEqual(['mouse move 5 6', 'mouse move 5 6', 'mouse down left']);
  });

  it('reports a second failure of the first member as the real answer and still runs no down or up', async () => {
    await manager.openConversation(1, 'conv-1');
    // The first attempt finds the copy gone (lost-copy path); the cold retry
    // on the freshly reopened copy fails too — this time for real.
    runBrowser
      .mockResolvedValueOnce({ args: ['mouse', 'move', '5', '6'], stdout: '', stderr: 'CDP WebSocket connect failed', exitCode: 1 })
      .mockRejectedValueOnce(new Error('agent-browser timed out after 5000ms.'));
    running.delete(cloneId('conv-1'));

    const result = await manager.runCommands(1, 'conv-1', [
      ['mouse', 'move', '5', '6'], ['mouse', 'down', 'left'], ['mouse', 'up', 'left'],
    ]);

    expect(result.failure).toMatchObject({ index: 0 });
    expect(result.failure?.output).toContain('timed out');
    expect(result.released).toBe(false);
    expect(result.steps).toEqual([]);
    // Exactly the cold-start retry of member 0 — no down, no up, no third try.
    expect(runBrowser.mock.calls.map((call) => (call[0] as string[]).join(' ')))
      .toEqual(['mouse move 5 6', 'mouse move 5 6']);
    // Matches the pre-refactor single-command behavior: a thrown retry leaves
    // no audit trail at all, the same as the old runCommand's uncaught retry.
    expect(db.prepare("SELECT COUNT(*) AS n FROM veneer_browser_audit WHERE action = 'command.executed'").get())
      .toEqual({ n: 0 });
  });

  it('releases a pressed button when a later member of the sequence fails', async () => {
    await manager.openConversation(1, 'conv-1');
    let moves = 0;
    runBrowser.mockImplementation(async (args: string[]) => {
      if (args[1] === 'move') {
        moves += 1;
        if (moves === 2) return { args, stdout: '', stderr: 'The page is not responding.', exitCode: 1 };
      }
      return { args, stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await manager.runCommands(1, 'conv-1', [
      ['mouse', 'move', '1', '2'], ['mouse', 'down', 'right'], ['mouse', 'move', '80', '90'], ['mouse', 'up', 'right'],
    ]);

    expect(result.failure).toMatchObject({ index: 2 });
    expect(result.released).toBe(true);
    // The drag's own `mouse up` never ran, so the compensating one is the release.
    expect(runBrowser.mock.calls.map((call) => (call[0] as string[]).join(' ')))
      .toEqual(['mouse move 1 2', 'mouse down right', 'mouse move 80 90', 'mouse up right']);
    // The compensating release is a real, separately audited command.
    expect(db.prepare("SELECT metadata_json FROM veneer_browser_audit WHERE action = 'command.executed'").all())
      .toEqual([
        { metadata_json: '{"command":"mouse move","success":true}' },
        { metadata_json: '{"command":"mouse down","success":true}' },
        { metadata_json: '{"command":"mouse move","success":false}' },
        { metadata_json: '{"command":"mouse up","success":true}' },
      ]);
  });

  it('releases a pressed button when the click\'s own mouse up is what fails', async () => {
    // click_at's real plan is only three members: move, down, up. Navigation
    // triggered by the down (a link, a submit) can make the up itself fail —
    // there is no fourth member for the failure to land on ahead of the up.
    await manager.openConversation(1, 'conv-1');
    let ups = 0;
    runBrowser.mockImplementation(async (args: string[]) => {
      if (args[1] === 'up') {
        ups += 1;
        if (ups === 1) return { args, stdout: '', stderr: 'Target closed.', exitCode: 1 };
      }
      return { args, stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await manager.runCommands(1, 'conv-1', [
      ['mouse', 'move', '1', '2'], ['mouse', 'down', 'left'], ['mouse', 'up', 'left'],
    ]);

    expect(result.failure).toMatchObject({ index: 2 });
    // A held button must be released even when the failing member IS the up
    // itself — the agent's own answer still reports the original failure.
    expect(result.released).toBe(true);
    expect(runBrowser.mock.calls.map((call) => (call[0] as string[]).join(' ')))
      .toEqual(['mouse move 1 2', 'mouse down left', 'mouse up left', 'mouse up left']);
  });

  it('leaves nothing to release when the sequence never pressed a button', async () => {
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockImplementation(async (args: string[]) => (
      args[1] === 'move'
        ? { args, stdout: '', stderr: 'no page', exitCode: 1 }
        : { args, stdout: '', stderr: '', exitCode: 0 }
    ));

    const result = await manager.runCommands(1, 'conv-1', [
      ['mouse', 'move', '1', '2'], ['mouse', 'down', 'left'], ['mouse', 'up', 'left'],
    ]);
    expect(result.failure).toMatchObject({ index: 0 });
    expect(result.released).toBe(false);
    expect(runBrowser.mock.calls.some((call) => (call[0] as string[])[1] === 'up')).toBe(false);
  });

  it('never attempts a release for hover_at or scroll_at, which never press a button', async () => {
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockResolvedValueOnce({ args: [], stdout: '', stderr: 'no page', exitCode: 1 });

    // hover_at's whole plan.
    const hover = await manager.runCommands(1, 'conv-1', [['mouse', 'move', '1', '2']]);
    expect(hover.failure).toMatchObject({ index: 0 });
    expect(hover.released).toBe(false);

    runBrowser.mockResolvedValueOnce({ args: [], stdout: '', stderr: '', exitCode: 0 });
    runBrowser.mockResolvedValueOnce({ args: [], stdout: '', stderr: 'no page', exitCode: 1 });
    // scroll_at's whole plan: move succeeds, wheel fails.
    const scroll = await manager.runCommands(1, 'conv-1', [['mouse', 'move', '1', '2'], ['mouse', 'wheel', '400']]);
    expect(scroll.failure).toMatchObject({ index: 1 });
    expect(scroll.released).toBe(false);
    expect(runBrowser.mock.calls.some((call) => (call[0] as string[])[1] === 'up')).toBe(false);
  });

  it('probes on the address this chat already holds and never mints one to ask', async () => {
    await manager.createProfile(1, 'project-1', 'Probe base');
    await manager.openConversation(1, 'conv-1');
    remote.ticket.mockClear();
    runBrowser.mockResolvedValueOnce({
      args: ['dialog', 'status', '--json'],
      stdout: '{"success":true,"data":{"hasDialog":true},"error":null}',
      stderr: '',
      exitCode: 0,
    });

    const probed = await manager.probeCommand(1, 'conv-1', ['dialog', 'status', '--json']);
    expect(probed).toContain('"hasDialog":true');
    expect(remote.ticket).not.toHaveBeenCalled();
    expect(runBrowser).toHaveBeenLastCalledWith(['dialog', 'status', '--json'], expect.objectContaining({
      timeoutMs: 5_000,
      remoteCdpUrl: 'wss://browser.example.test/cdp/opened-ticket/ws',
    }));
    // A side question leaves no trace on the record of what the agent ran.
    expect(db.prepare("SELECT COUNT(*) AS n FROM veneer_browser_audit WHERE action = 'command.executed'").get())
      .toEqual({ n: 0 });
  });

  it('can still probe after the timeout that dropped this chat\'s cached runtime', async () => {
    await manager.createProfile(1, 'project-1', 'Timeout base');
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockRejectedValueOnce(new Error('agent-browser timed out after 45000ms.'));

    await expect(manager.runCommand(1, 'conv-1', ['click', '@e1'])).rejects.toThrow(/timed out/);
    // The failed command threw the runtime cache away on purpose; a probe is
    // exactly what wants to ask why, so it must still have an address.
    remote.ticket.mockClear();
    runBrowser.mockResolvedValueOnce({
      args: ['dialog', 'status', '--json'],
      stdout: '{"success":true,"data":{"hasDialog":true},"error":null}',
      stderr: '',
      exitCode: 0,
    });
    expect(await manager.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).toContain('hasDialog');
    expect(remote.ticket).not.toHaveBeenCalled();
    // And it reopened nothing to get there.
    expect(remote.open).toHaveBeenCalledOnce();
    expect(remote.start).not.toHaveBeenCalled();
  });

  it('never starts or reopens a working copy just to probe, and swallows probe failures', async () => {
    await manager.createProfile(1, 'project-1', 'Probe base');
    expect(await manager.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).toBeNull();
    expect(runBrowser).not.toHaveBeenCalled();
    expect(remote.start).not.toHaveBeenCalled();
    expect(remote.ticket).not.toHaveBeenCalled();

    await manager.openConversation(1, 'conv-1');
    runBrowser.mockRejectedValueOnce(new Error('agent-browser timed out after 5000ms.'));
    expect(await manager.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).toBeNull();
    runBrowser.mockResolvedValueOnce({ args: [], stdout: 'noise', stderr: '', exitCode: 1 });
    expect(await manager.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).toBeNull();
    // A failed probe never marks the copy as broken.
    expect(db.prepare('SELECT status, last_error FROM veneer_browser_clone_sessions').get())
      .toMatchObject({ status: 'active', last_error: null });
    expect(await manager.probeCommand(1, 'conv-other-user', ['dialog', 'status', '--json'])).toBeNull();
  });

  it('never asks the address of a working copy this chat has since replaced', async () => {
    await manager.createProfile(1, 'project-1', 'Replaced base');
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockRejectedValueOnce(new Error('agent-browser timed out after 5000ms.'));
    await expect(manager.runCommand(1, 'conv-1', ['click', '@e1'])).rejects.toThrow(/timed out/);
    // Sanity: the address from that failed command works for a probe right now.
    runBrowser.mockResolvedValueOnce({ args: [], stdout: '{"data":{"hasDialog":true}}', stderr: '', exitCode: 0 });
    expect(await manager.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).not.toBeNull();

    // The same chat discards that copy and opens a fresh one whose open reply
    // is a LAN address: unusable directly, so the manager does not cache it as
    // an agent ticket immediately, and no command has run on it yet either —
    // exactly the gap probeAddresses' clone_profile_id pin exists to cover.
    await manager.stopConversation(1, 'conv-1');
    remote.cdpCaFile.mockImplementation((url: string) => (url.includes('replacement-lan') ? '/etc/lan-ca.pem' : null));
    remote.open.mockImplementationOnce(async (_projectId: string, _sourceProfileId: string, cloneProfileId: string) => {
      running.add(cloneProfileId);
      return {
        cloneProfileId,
        adopted: false,
        sourceGeneration: 1,
        runtimeId: `runtime-${cloneProfileId}`,
        cdpUrl: 'wss://browser.lan.test:8443/cdp/replacement-lan/ws',
        viewerUrl: 'https://browser.lan.test:8443/cdp/replacement-lan',
        expiresAt: '2099-01-01T00:00:00Z',
      };
    });
    await manager.openConversation(1, 'conv-1');
    runBrowser.mockClear();

    // The pinned address still belongs to the copy that is gone; it must not
    // be reused against the new one, even though this chat's row is active again.
    expect(await manager.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).toBeNull();
    expect(runBrowser).not.toHaveBeenCalled();
  });

  it('ages a probe address out on the same idle cutoff as the runtime cache', async () => {
    vi.useFakeTimers();
    try {
      const quiet = new VeneerBrowserManager({
        db, dataDir, remote, runBrowser: runBrowser as never, closeBrowserSession: closeBrowserSession as never,
      });
      await quiet.createProfile(1, 'project-1', 'Aging base');
      await quiet.openConversation(1, 'conv-1');
      runBrowser.mockRejectedValueOnce(new Error('agent-browser timed out after 5000ms.'));
      await expect(quiet.runCommand(1, 'conv-1', ['click', '@e1'])).rejects.toThrow(/timed out/);
      runBrowser.mockResolvedValueOnce({ args: [], stdout: '{"data":{"hasDialog":true}}', stderr: '', exitCode: 0 });
      expect(await quiet.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).not.toBeNull();

      const addresses = (quiet as unknown as { probeAddresses: Map<string, unknown> }).probeAddresses;
      expect(addresses.size).toBe(1);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(addresses.size).toBe(0);

      runBrowser.mockClear();
      expect(await quiet.probeCommand(1, 'conv-1', ['dialog', 'status', '--json'])).toBeNull();
      expect(runBrowser).not.toHaveBeenCalled();
      quiet.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves bounded downloads into the current project workspace', async () => {
    const profile = await manager.createProfile(1, 'project-1', 'Downloads');
    const files = await manager.downloads(1, 'conv-1');
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(files[0]!, 'utf8')).toBe('hello');
    expect(files[0]).toContain(`${path.sep}.veneer-browser${path.sep}downloads${path.sep}${profile.id}`);
  });
});

describe('Veneer Browser tool commands', () => {
  it('keeps the original five page commands unchanged', () => {
    expect(commandFor('navigate', { url: 'https://example.com' })).toEqual(['open', 'https://example.com']);
    expect(commandFor('click', { target: '@e1' })).toEqual(['click', '@e1']);
    expect(commandFor('type', { target: '@e1', text: 'hello' })).toEqual(['type', '@e1', 'hello']);
    expect(commandFor('read', {})).toEqual(['snapshot', '-i']);
    expect(commandFor('screenshot', {})).toEqual(['screenshot']);
    expect(commandFor('screenshot', { full: true })).toEqual(['screenshot', '--full']);
  });

  it('maps the typed interaction commands to real agent-browser verbs', () => {
    expect(commandFor('fill', { target: '@e2', text: 'hello' })).toEqual(['fill', '@e2', 'hello']);
    expect(commandFor('press', { key: 'Enter' })).toEqual(['press', 'Enter']);
    expect(commandFor('hover', { target: '@e3' })).toEqual(['hover', '@e3']);
    expect(commandFor('back', {})).toEqual(['back']);
    expect(commandFor('forward', {})).toEqual(['forward']);
    expect(commandFor('reload', {})).toEqual(['reload']);
  });

  it('scrolls by direction or brings an element into view', () => {
    expect(commandFor('scroll', {})).toEqual(['scroll', 'down']);
    expect(commandFor('scroll', { direction: 'up', pixels: 500 })).toEqual(['scroll', 'up', '500']);
    expect(commandFor('scroll', { into_view: '@e4' })).toEqual(['scrollintoview', '@e4']);
  });

  it('waits on one condition at a time and refuses an empty wait', () => {
    expect(commandFor('wait', { target: '@e1' })).toEqual(['wait', '@e1']);
    expect(commandFor('wait', { text: 'Success' })).toEqual(['wait', '--text', 'Success']);
    expect(commandFor('wait', { url: '**/dashboard' })).toEqual(['wait', '--url', '**/dashboard']);
    expect(commandFor('wait', { load: 'networkidle' })).toEqual(['wait', '--load', 'networkidle']);
    expect(commandFor('wait', { ms: 1500 })).toEqual(['wait', '1500']);
    expect(() => commandFor('wait', {})).toThrow(/one of target/);
  });

  it('builds semantic find commands including the nth index form', () => {
    expect(commandFor('find', { locator: 'text', value: 'Sign in' })).toEqual(['find', 'text', 'Sign in', 'click']);
    expect(commandFor('find', { locator: 'role', value: 'button', action: 'click', name: 'Submit', exact: true }))
      .toEqual(['find', 'role', 'button', 'click', '--name', 'Submit', '--exact']);
    expect(commandFor('find', { locator: 'label', value: 'Email', action: 'fill', text: 'a@b.test' }))
      .toEqual(['find', 'label', 'Email', 'fill', 'a@b.test']);
    expect(commandFor('find', { locator: 'nth', index: 2, value: '.card', action: 'hover' }))
      .toEqual(['find', 'nth', '2', '.card', 'hover']);
    expect(() => commandFor('find', { locator: 'text' })).toThrow(/value/);
  });

  it('manages tabs by stable id or label', () => {
    expect(commandFor('tab', {})).toEqual(['tab', 'list']);
    expect(commandFor('tab', { action: 'new', url: 'https://example.com', label: 'docs' }))
      .toEqual(['tab', 'new', '--label', 'docs', 'https://example.com']);
    expect(commandFor('tab', { action: 'switch', tab: 't2' })).toEqual(['tab', 't2']);
    expect(commandFor('tab', { action: 'close', tab: 'docs' })).toEqual(['tab', 'close', 'docs']);
    expect(commandFor('tab', { action: 'close' })).toEqual(['tab', 'close']);
    expect(() => commandFor('tab', { action: 'switch' })).toThrow(/tab id/);
  });

  it('answers a blocking dialog and keeps text to the one action that uses it', () => {
    expect(commandFor('dialog', { action: 'status' })).toEqual(['dialog', 'status']);
    expect(commandFor('dialog', { action: 'accept' })).toEqual(['dialog', 'accept']);
    expect(commandFor('dialog', { action: 'dismiss' })).toEqual(['dialog', 'dismiss']);
    expect(commandFor('dialog', { action: 'accept', text: 'Ada' })).toEqual(['dialog', 'accept', 'Ada']);
    expect(commandFor('dialog', { action: 'accept', text: '' })).toEqual(['dialog', 'accept']);
    expect(() => commandFor('dialog', { action: 'dismiss', text: 'Ada' })).toThrow(/only used with accept/);
    expect(() => commandFor('dialog', { action: 'status', text: 'Ada' })).toThrow(/only used with accept/);
    expect(() => commandFor('dialog', {})).toThrow(/accept, dismiss, or status/);
    expect(() => commandFor('dialog', { action: 'close' })).toThrow(/accept, dismiss, or status/);
  });

  it('refuses prompt text the CLI would read as an option', () => {
    expect(() => commandFor('dialog', { action: 'accept', text: '--json' })).toThrow(/cannot start with/);
    expect(() => commandFor('dialog', { action: 'accept', text: '-x' })).toThrow(/cannot start with/);
    expect(commandFor('dialog', { action: 'accept', text: 'a-b' })).toEqual(['dialog', 'accept', 'a-b']);
  });

  it('returns null for a command it does not know', () => {
    expect(commandFor('teleport', {})).toBeNull();
  });
});

describe('Veneer Browser trapped dialog resolution', () => {
  const ok = (stdout = 'ok') => ({ stdout, stderr: '', exitCode: 0 });
  const fail = (stderr: string) => ({ stdout: '', stderr, exitCode: 1 });
  const status = (hasDialog: boolean) => JSON.stringify({ success: true, data: { hasDialog }, error: null });
  const tabList = (tabs: Array<Record<string, unknown>>) => JSON.stringify({ success: true, data: { tabs } });
  const NO_DIALOG = 'Error: No dialog is showing';
  const FROZEN = 'Error: tab is not responding and did not recover after activation';

  function scripted(handlers: Array<[string[], () => { stdout: string; stderr: string; exitCode: number }]>) {
    return vi.fn(async (args: string[]) => {
      const match = handlers.find(([shape]) => shape.length === args.length && shape.every((part, index) => part === args[index]));
      if (!match) return ok('unhandled');
      return match[1]();
    });
  }

  it('asks the daemon what it knows before attempting an answer, and stops accept if it knows nothing', async () => {
    const run = scripted([[['dialog', 'status', '--json'], () => ok(status(false))]]);
    const outcome = await answerDialog(run, 'accept', ['dialog', 'accept']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('No dialog is open on the selected tab');
    // No retry hint: a retry would take this same path again.
    expect(outcome.text).not.toMatch(/retry/i);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('sweeps for a frozen tab on dismiss even when status reports no dialog, and closes what it finds', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
      ]))],
      [['tab', 't2'], () => fail(FROZEN)],
      [['tab', 'close', 't2'], () => ok('Closed tab t2.')],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('No dialog was open on the selected tab, but tab t2 (https://example.test/checkout) was frozen');
    expect(run).toHaveBeenCalledWith(['tab', 'close', 't2']);
    // Nothing was ever fired at a daemon that had no dialog to answer.
    expect(run).not.toHaveBeenCalledWith(['dialog', 'dismiss']);
  });

  it('says so harmlessly when a cold dismiss sweep finds no frozen tab either', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/docs', active: false },
      ]))],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('no other tab was frozen by one');
    expect(outcome.text).not.toMatch(/retry/i);
    expect(run).not.toHaveBeenCalledWith(['dialog', 'dismiss']);
    // The healthy probe moved the selection, so it is put back.
    expect(run).toHaveBeenLastCalledWith(['tab', 't1']);
  });

  it('treats the daemon blocking warning as a known dialog even when the status payload is unreadable', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => fail('A JavaScript confirm dialog is blocking the page: "Sure?"')],
      [['dialog', 'dismiss'], () => ok('Dismissed the dialog.')],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(run).toHaveBeenCalledWith(['dialog', 'dismiss']);
  });

  it('passes an ordinary failure straight back without hunting for a frozen tab', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(true))],
      [['dialog', 'accept'], () => fail('Error: the session restarted')],
    ]);
    const outcome = await answerDialog(run, 'accept', ['dialog', 'accept']);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('the session restarted');
    expect(run).not.toHaveBeenCalledWith(['tab', 'list', '--json']);
  });

  it('stops probing at the first frozen tab and never probes more than six candidates', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ tabId: `t${index + 1}`, url: `https://example.test/${index + 1}`, active: index === 0 }));
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(true))],
      [['dialog', 'accept'], () => fail(NO_DIALOG)],
      [['tab', 'list', '--json'], () => ok(tabList(many))],
      [['tab', 't9'], () => fail(FROZEN)],
    ]);
    const outcome = await answerDialog(run, 'accept', ['dialog', 'accept']);
    // t2..t7 only: six probes, and t9 — the real frozen tab — is past the cap.
    expect(run).toHaveBeenCalledWith(['tab', 't7']);
    expect(run).not.toHaveBeenCalledWith(['tab', 't8']);
    expect(run).not.toHaveBeenCalledWith(['tab', 't9']);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('No frozen tab was identified');
    // Selection moved during the sweep, so it is put back.
    expect(run).toHaveBeenLastCalledWith(['tab', 't1']);
  });

  it('closes the frozen tab for dismiss and verifies afterwards', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(true))],
      [['dialog', 'dismiss'], () => fail(NO_DIALOG)],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
      ]))],
      [['tab', 't2'], () => fail(FROZEN)],
      [['tab', 'close', 't2'], () => ok('Closed tab t2.')],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('closing tab t2 (https://example.test/checkout)');
    expect(outcome.text).toContain('unsaved state are gone');
    expect(run).toHaveBeenCalledWith(['tab', 'close', 't2']);
    expect(run).toHaveBeenLastCalledWith(['dialog', 'status', '--json']);
  });

  it('refuses to close a tab for accept, because accepting from outside is impossible', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(true))],
      [['dialog', 'accept', 'Ada'], () => fail(NO_DIALOG)],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
      ]))],
      [['tab', 't2'], () => fail(FROZEN)],
    ]);
    const outcome = await answerDialog(run, 'accept', ['dialog', 'accept', 'Ada']);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('trapped on tab t2 (https://example.test/checkout)');
    expect(outcome.text).toContain('dialog dismiss');
    expect(run).not.toHaveBeenCalledWith(['tab', 'close', 't2']);
  });

  it('leaves the selection where probing left it (and says so) once a stuck tab is found, rather than restoring it', async () => {
    // t2 probes clean (selection moves there) before t3 is found stuck. This
    // pins current behavior: unlike the not-found cold sweep, a found-stuck
    // outcome does not switch back to the original active tab — it discloses
    // the move via the note instead, since the agent is about to act on the
    // stuck tab (e.g. dismiss it) rather than resume ordinary browsing.
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(true))],
      [['dialog', 'accept'], () => fail(NO_DIALOG)],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/clean', active: false },
        { tabId: 't3', url: 'https://example.test/checkout', active: false },
      ]))],
      [['tab', 't2'], () => ok()],
      [['tab', 't3'], () => fail(FROZEN)],
    ]);
    const outcome = await answerDialog(run, 'accept', ['dialog', 'accept']);
    expect(outcome.text).toContain('Checking tabs changed the selected tab');
    expect(run).not.toHaveBeenCalledWith(['tab', 't1']);
  });

  it('degrades a success:false or malformed tab list to the harmless cold-sweep message instead of throwing', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(JSON.stringify({ success: false, error: 'daemon busy' }))],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('no other tab was frozen by one');
  });

  it('does not crash or issue a tab switch with an undefined id when no tab is marked active', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: false },
        { tabId: 't2', url: 'https://example.test/docs', active: false },
      ]))],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('no other tab was frozen by one');
    for (const call of run.mock.calls) {
      expect(call[0]).not.toContain(undefined);
    }
  });

  it('finds a stuck tab that is the very first candidate probed', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
        { tabId: 't3', url: 'https://example.test/other', active: false },
      ]))],
      [['tab', 't2'], () => fail(FROZEN)],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(run).not.toHaveBeenCalledWith(['tab', 't3']);
    expect(outcome.text).toContain('tab t2 (https://example.test/checkout)');
  });

  it('finds a stuck tab at the last candidate the probe cap allows (the 6th)', async () => {
    const seven = Array.from({ length: 7 }, (_, index) => ({ tabId: `t${index + 1}`, url: `https://example.test/${index + 1}`, active: index === 0 }));
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList(seven))],
      [['tab', 't2'], () => ok()],
      [['tab', 't3'], () => ok()],
      [['tab', 't4'], () => ok()],
      [['tab', 't5'], () => ok()],
      [['tab', 't6'], () => ok()],
      [['tab', 't7'], () => fail(FROZEN)],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(run).toHaveBeenCalledWith(['tab', 't7']);
    expect(outcome.text).toContain('tab t7 (https://example.test/7)');
  });

  it('stops at the first of two frozen tabs and closes only that one', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
        { tabId: 't3', url: 'https://example.test/also-stuck', active: false },
      ]))],
      [['tab', 't2'], () => fail(FROZEN)],
      [['tab', 'close', 't2'], () => ok('Closed tab t2.')],
      [['tab', 't3'], () => fail(FROZEN)],
      [['tab', 'close', 't3'], () => ok('Closed tab t3.')],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('tab t2');
    expect(outcome.text).not.toContain('tab t3');
    expect(run).not.toHaveBeenCalledWith(['tab', 't3']);
    expect(run).toHaveBeenCalledWith(['tab', 'close', 't2']);
    expect(run).not.toHaveBeenCalledWith(['tab', 'close', 't3']);
  });

  it('does not treat a probe failure with a different error as stuck, and keeps sweeping', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/flaky', active: false },
        { tabId: 't3', url: 'https://example.test/checkout', active: false },
      ]))],
      [['tab', 't2'], () => fail('Error: the session restarted')],
      [['tab', 't3'], () => fail(FROZEN)],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.text).toContain('tab t3 (https://example.test/checkout)');
  });

  it('reports no frozen tab found when every probe fails with a non-frozen error', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/flaky', active: false },
      ]))],
      [['tab', 't2'], () => fail('Error: the session restarted')],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('no other tab was frozen by one');
    expect(run).not.toHaveBeenCalledWith(['tab', 'close', 't2']);
  });

  it('surfaces a close failure honestly instead of claiming the frozen tab was closed', async () => {
    const run = scripted([
      [['dialog', 'status', '--json'], () => ok(status(false))],
      [['tab', 'list', '--json'], () => ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
      ]))],
      [['tab', 't2'], () => fail(FROZEN)],
      [['tab', 'close', 't2'], () => fail('Error: close timed out')],
    ]);
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('closing that tab failed');
    expect(outcome.text).toContain('close timed out');
    expect(outcome.text).not.toContain('was closed');
    expect(outcome.text).not.toContain('unsaved state are gone');
  });

  it('does not flip a successful close into an error when the best-effort verify fails', async () => {
    // The pre-check and the trailing verify are both `dialog status --json`, so
    // this mock answers by call order: pre-check reports no dialog (triggering
    // the cold sweep), and the trailing verify throws outright.
    let statusCalls = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'dialog status --json') {
        statusCalls += 1;
        if (statusCalls === 1) return ok(status(false));
        throw new Error('daemon connection dropped');
      }
      if (args.join(' ') === 'tab list --json') return ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
      ]));
      if (args.join(' ') === 'tab t2') return fail(FROZEN);
      if (args.join(' ') === 'tab close t2') return ok('Closed tab t2.');
      return ok('unhandled');
    });
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('was closed');
    expect(outcome.text).not.toMatch(/still reported/);
  });

  it('reads the lingering-dialog verify from stdout alone, so stray stderr noise cannot hide it', async () => {
    // The verify call's stdout is valid JSON on its own; stderr carries unrelated
    // noise (a deprecation warning, say). Joining the two before parsing would
    // break the JSON and silently swallow a real "still lingering" hint.
    let statusCalls = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'dialog status --json') {
        statusCalls += 1;
        // First call is the pre-check (cold sweep trigger); second is the
        // trailing verify after the close, where the noise is added.
        return statusCalls === 1
          ? ok(status(false))
          : { stdout: status(true), stderr: '[warn] deprecated flag', exitCode: 0 };
      }
      if (args.join(' ') === 'tab list --json') return ok(tabList([
        { tabId: 't1', url: 'https://example.test/home', active: true },
        { tabId: 't2', url: 'https://example.test/checkout', active: false },
      ]));
      if (args.join(' ') === 'tab t2') return fail(FROZEN);
      if (args.join(' ') === 'tab close t2') return ok('Closed tab t2.');
      return ok('unhandled');
    });
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('was closed');
    expect(outcome.text).toContain('A dialog is still reported on the selected tab.');
  });

  // Probing the frozen tab is what makes the broker restart its session, and the
  // restart voids every tN the first list handed out — so the id used to close
  // has to come from a list taken after the probe, matched by URL.
  const EXPIRED = 'Error: tab handle expired. List tabs again before switching or closing one.';
  const HOME = { tabId: 't1', url: 'https://example.test/home', active: true };
  const CHECKOUT = { tabId: 't2', url: 'https://example.test/checkout', active: false };

  /**
   * Answers by call order, so the same `tab list --json` argv can return the
   * pre-restart list first and renumbered ones afterwards.
   */
  function relisting(lists: Array<Array<Record<string, unknown>>>, closes: Record<string, () => { stdout: string; stderr: string; exitCode: number }>, cold = false) {
    let listed = 0;
    return vi.fn(async (args: string[]) => {
      const argv = args.join(' ');
      if (argv === 'dialog status --json') return ok(status(!cold));
      if (argv === 'dialog dismiss') return fail(NO_DIALOG);
      if (argv === 'tab list --json') {
        listed += 1;
        return ok(tabList(lists[Math.min(listed, lists.length) - 1] ?? []));
      }
      if (argv === 'tab t2') return fail(FROZEN);
      if (args[0] === 'tab' && args[1] === 'close') {
        const handler = closes[args[2] ?? ''];
        return handler ? handler() : fail(`Error: unexpected close of ${args[2]}`);
      }
      return ok('unhandled');
    });
  }

  const closeCalls = (run: { mock: { calls: unknown[][] } }): string[][] => (
    run.mock.calls.map((call) => call[0] as string[]).filter((args) => args[0] === 'tab' && args[1] === 'close')
  );

  it('closes the frozen tab by the id a fresh list gives it, not the one the expired handle had', async () => {
    const run = relisting(
      [[HOME, CHECKOUT], [{ ...HOME, tabId: 't4' }, { ...CHECKOUT, tabId: 't7' }]],
      { t7: () => ok('Closed tab t7.') },
    );
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('unsaved state are gone');
    expect(closeCalls(run)).toEqual([['tab', 'close', 't7']]);
    expect(run).not.toHaveBeenCalledWith(['tab', 'close', 't2']);
  });

  it('retries a close exactly once when the handle expired between the list and the close', async () => {
    const run = relisting(
      [[HOME, CHECKOUT], [{ ...HOME, tabId: 't4' }, { ...CHECKOUT, tabId: 't7' }], [{ ...HOME, tabId: 't4' }, { ...CHECKOUT, tabId: 't9' }]],
      { t7: () => fail(EXPIRED), t9: () => ok('Closed tab t9.') },
    );
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('unsaved state are gone');
    expect(closeCalls(run)).toEqual([['tab', 'close', 't7'], ['tab', 'close', 't9']]);
  });

  it('gives up honestly after a second expired close rather than looping', async () => {
    const run = relisting(
      [[HOME, CHECKOUT], [{ ...HOME, tabId: 't4' }, { ...CHECKOUT, tabId: 't7' }], [{ ...HOME, tabId: 't4' }, { ...CHECKOUT, tabId: 't9' }]],
      { t7: () => fail(EXPIRED), t9: () => fail(EXPIRED) },
    );
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('closing that tab failed');
    expect(outcome.text).toContain('tab handle expired');
    expect(outcome.text).not.toContain('was closed');
    expect(outcome.text).not.toContain('unsaved state are gone');
    expect(closeCalls(run)).toHaveLength(2);
  });

  it('refuses to close anything when the frozen tab URL is gone from the fresh list', async () => {
    const run = relisting(
      [[HOME, CHECKOUT], [{ ...HOME, tabId: 't4' }]],
      {},
    );
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('closing that tab failed');
    expect(outcome.text).toContain('no tab at https://example.test/checkout');
    expect(outcome.text).not.toContain('unsaved state are gone');
    expect(closeCalls(run)).toEqual([]);
  });

  it('refuses to guess when two tabs in the fresh list share the frozen tab URL', async () => {
    const run = relisting(
      [[HOME, CHECKOUT], [{ ...HOME, tabId: 't4' }, { ...CHECKOUT, tabId: 't7' }, { ...CHECKOUT, tabId: 't8' }]],
      {},
    );
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('2 tabs now share https://example.test/checkout');
    expect(outcome.text).not.toContain('unsaved state are gone');
    expect(closeCalls(run)).toEqual([]);
  });

  it('re-resolves the id on the cold sweep path too, where no answer was ever attempted', async () => {
    const run = relisting(
      [[HOME, CHECKOUT], [{ ...HOME, tabId: 't4' }, { ...CHECKOUT, tabId: 't7' }]],
      { t7: () => ok('Closed tab t7.') },
      true,
    );
    const outcome = await answerDialog(run, 'dismiss', ['dialog', 'dismiss']);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('No dialog was open on the selected tab, but tab t2 (https://example.test/checkout) was frozen');
    expect(run).not.toHaveBeenCalledWith(['dialog', 'dismiss']);
    expect(closeCalls(run)).toEqual([['tab', 'close', 't7']]);
  });
});

describe('hasDialogInJson', () => {
  it('is true only for a definite boolean yes inside the payload envelope', () => {
    expect(hasDialogInJson(JSON.stringify({ success: true, data: { hasDialog: true } }))).toBe(true);
    expect(hasDialogInJson(JSON.stringify({ success: true, data: { hasDialog: false } }))).toBe(false);
    expect(hasDialogInJson(JSON.stringify({ success: true, data: { hasDialog: 'true' } }))).toBe(false);
    expect(hasDialogInJson(JSON.stringify({ hasDialog: true }))).toBe(false);
    expect(hasDialogInJson(JSON.stringify([{ hasDialog: true }]))).toBe(false);
    expect(hasDialogInJson(`${JSON.stringify({ data: { hasDialog: true } })}\n[warn] tab detached`)).toBe(false);
    expect(hasDialogInJson('not json')).toBe(false);
    expect(hasDialogInJson('')).toBe(false);
    expect(hasDialogInJson(null)).toBe(false);
  });
});

describe('Veneer Browser coordinate pointer tools', () => {
  it('spells a click out as move, down, and up on one button', () => {
    expect(pointerCommands('click_at', { x: 120, y: 340 })).toEqual([
      ['mouse', 'move', '120', '340'],
      ['mouse', 'down', 'left'],
      ['mouse', 'up', 'left'],
    ]);
    expect(pointerCommands('click_at', { x: 1, y: 2, button: 'right' })).toEqual([
      ['mouse', 'move', '1', '2'],
      ['mouse', 'down', 'right'],
      ['mouse', 'up', 'right'],
    ]);
    expect(pointerCommands('hover_at', { x: 5, y: 6 })).toEqual([['mouse', 'move', '5', '6']]);
    expect(pointerCommands('scroll_at', { x: 5, y: 6, dy: 400 }))
      .toEqual([['mouse', 'move', '5', '6'], ['mouse', 'wheel', '400']]);
    expect(pointerCommands('scroll_at', { x: 5, y: 6, dy: -400, dx: 30 }))
      .toEqual([['mouse', 'move', '5', '6'], ['mouse', 'wheel', '-400', '30']]);
  });

  it('truncates toward zero and never emits a fractional or negative-zero pixel', () => {
    expect(pointerCommands('click_at', { x: 10.9, y: 0.4 })?.[0]).toEqual(['mouse', 'move', '10', '0']);
    expect(pointerCommands('scroll_at', { x: 0, y: 0, dy: -0.5 })?.[1]).toEqual(['mouse', 'wheel', '0']);
    expect(pointerCommands('scroll_at', { x: 0, y: 0, dy: -12.9 })?.[1]).toEqual(['mouse', 'wheel', '-12']);
  });

  it('rejects anything that is not a finite number', () => {
    for (const bad of ['120', null, undefined, true, Number.NaN, Infinity, -Infinity, {}, []]) {
      expect(() => pointerCommands('click_at', { x: bad, y: 10 })).toThrow(/x must be a finite number/);
      expect(() => pointerCommands('hover_at', { x: 10, y: bad })).toThrow(/y must be a finite number/);
    }
    expect(() => pointerCommands('scroll_at', { x: 1, y: 1 })).toThrow(/dy must be a finite number/);
    expect(() => pointerCommands('scroll_at', { x: 1, y: 1, dy: 10, dx: 'left' })).toThrow(/dx must be a finite number/);
  });

  it('keeps coordinates and deltas inside sane bounds', () => {
    expect(() => pointerCommands('click_at', { x: -1, y: 10 })).toThrow(/x must be between 0 and 20000/);
    expect(() => pointerCommands('click_at', { x: 20001, y: 10 })).toThrow(/x must be between 0 and 20000/);
    expect(() => pointerCommands('hover_at', { x: 10, y: 99999 })).toThrow(/y must be between 0 and 20000/);
    expect(() => pointerCommands('scroll_at', { x: 1, y: 1, dy: -20001 })).toThrow(/dy must be between -20000 and 20000/);
    expect(pointerCommands('scroll_at', { x: 1, y: 1, dy: -20000 })?.[1]).toEqual(['mouse', 'wheel', '-20000']);
  });

  it('accepts only the three real mouse buttons', () => {
    expect(pointerCommands('click_at', { x: 1, y: 1, button: 'MIDDLE' })?.[1]).toEqual(['mouse', 'down', 'middle']);
    expect(pointerCommands('click_at', { x: 1, y: 1, button: '' })?.[1]).toEqual(['mouse', 'down', 'left']);
    for (const bad of ['back', 'left;rm -rf /', 4, '--json']) {
      expect(() => pointerCommands('click_at', { x: 1, y: 1, button: bad })).toThrow(/left, right, or middle/);
    }
  });

  it('is null for every tool that is not a coordinate pointer tool', () => {
    for (const name of ['click', 'hover', 'scroll', 'read', 'run', 'dialog', 'mouse', '']) {
      expect(pointerCommands(name, { x: 1, y: 1, dy: 1 })).toBeNull();
    }
  });

  it('summarises what actually ran', () => {
    expect(pointerSummary('click_at', pointerCommands('click_at', { x: 12, y: 34 })!)).toBe('Clicked at (12, 34).');
    expect(pointerSummary('click_at', pointerCommands('click_at', { x: 12, y: 34, button: 'right' })!))
      .toBe('Clicked at (12, 34) with the right button.');
    expect(pointerSummary('hover_at', pointerCommands('hover_at', { x: 1, y: 2 })!))
      .toBe('Moved the pointer to (1, 2).');
    expect(pointerSummary('scroll_at', pointerCommands('scroll_at', { x: 1, y: 2, dy: 300 })!))
      .toBe('Scrolled at (1, 2) by 300 vertically.');
    expect(pointerSummary('scroll_at', pointerCommands('scroll_at', { x: 1, y: 2, dy: 300, dx: 40 })!))
      .toBe('Scrolled at (1, 2) by 300 vertically and 40 horizontally.');
  });
});

describe('Veneer Browser escape hatch', () => {
  it('passes safe raw commands through', () => {
    expect(commandFor('run', { args: ['get', 'title'] })).toEqual(['get', 'title']);
    expect(assertVeneerRunArgs(['is', 'visible', '@e1'])).toEqual(['is', 'visible', '@e1']);
    expect(assertVeneerRunArgs(['select', '@e1', 'option-a'])).toEqual(['select', '@e1', 'option-a']);
    expect(assertVeneerRunArgs(['wait', '--load', 'networkidle'])).toEqual(['wait', '--load', 'networkidle']);
  });

  it('blocks session, storage, scripting, and capture commands', () => {
    for (const command of ['eval', 'cookies', 'storage', 'state', 'auth', 'clipboard', 'batch', 'addinitscript']) {
      expect(() => assertVeneerRunArgs([command, 'anything'])).toThrow(/not available in Veneer Browser/);
    }
    expect(() => assertVeneerRunArgs(['EVAL', 'document.cookie'])).toThrow(/not available in Veneer Browser/);
    expect(() => assertVeneerRunArgs(['network', 'requests'])).toThrow(/blocked by default/);
    expect(() => assertVeneerRunArgs(['network', 'har', 'start'])).toThrow(/blocked by default/);
  });

  it('points at the user-only Advanced capture switch when it refuses network capture', () => {
    expect(() => assertVeneerRunArgs(['network', 'requests'])).toThrow(/Advanced capture/);
    expect(() => assertVeneerRunArgs(['NETWORK'], { captureGranted: false }))
      .toThrow(/ask the user to enable "Advanced capture" for this chat in the browser panel/);
  });

  it('lets an Advanced capture grant through for network only', () => {
    expect(assertVeneerRunArgs(['network', 'requests'], { captureGranted: true })).toEqual(['network', 'requests']);
    expect(commandFor('run', { args: ['network', 'requests'] }, { captureGranted: true }))
      .toEqual(['network', 'requests']);
    // Everything else in the block list stays blocked with a grant in hand.
    for (const command of ['eval', 'evaluate', 'js', 'addinitscript', 'removeinitscript', 'cookies', 'storage', 'state', 'auth', 'clipboard', 'batch']) {
      expect(() => assertVeneerRunArgs([command, 'anything'], { captureGranted: true }))
        .toThrow(/not available in Veneer Browser/);
    }
    expect(() => assertVeneerRunArgs(['wait', '--fn', 'window.ready'], { captureGranted: true })).toThrow(/wait --fn/);
  });

  it('still blocks network har through the normalize layer when capture is granted', () => {
    expect(assertVeneerRunArgs(['network', 'har', 'start'], { captureGranted: true }))
      .toEqual(['network', 'har', 'start']);
    expect(() => normalizeAgentBrowserArgs(['network', 'har', 'start'], {
      conversationId: 'conv-1',
      workspaceDir: os.tmpdir(),
    })).toThrow(/network har is disabled/);
  });

  it('blocks the commands the normalize layer already blocks', () => {
    for (const command of ['chat', 'connect', 'dashboard', 'download', 'install', 'inspect', 'profiles', 'profiler', 'record', 'session', 'skills', 'stream', 'trace', 'upgrade', 'upload']) {
      expect(() => assertVeneerRunArgs([command])).toThrow(/not available in Veneer Browser/);
    }
  });

  it('blocks JavaScript smuggled through wait and options placed before the command', () => {
    expect(() => assertVeneerRunArgs(['wait', '--fn', 'window.ready'])).toThrow(/wait --fn/);
    expect(() => assertVeneerRunArgs(['wait', '-f', 'window.ready'])).toThrow(/wait --fn/);
    expect(() => assertVeneerRunArgs(['--json', 'eval', '1'])).toThrow(/must be an agent-browser command/);
  });

  it('rejects malformed argument arrays', () => {
    expect(() => assertVeneerRunArgs([])).toThrow(/non-empty array/);
    expect(() => assertVeneerRunArgs('get title')).toThrow(/non-empty array/);
    expect(() => assertVeneerRunArgs(['get', 42])).toThrow(/non-empty string/);
  });

  it('rejects loopback URLs in typed commands and anywhere in raw args', () => {
    expect(() => rejectLoopbackUrl('navigate', { url: 'http://localhost:3000' })).toThrow(/separate virtual machine/);
    expect(() => rejectLoopbackUrl('tab', { url: 'http://127.0.0.1:8080/x' })).toThrow(/separate virtual machine/);
    expect(() => rejectLoopbackUrl('run', { args: ['tab', 'new', 'http://127.0.0.1:5173'] })).toThrow(/separate virtual machine/);
    expect(() => rejectLoopbackUrl('run', { args: ['open', 'https://example.com'] })).not.toThrow();
    expect(() => rejectLoopbackUrl('navigate', { url: 'https://example.com' })).not.toThrow();
  });
});
