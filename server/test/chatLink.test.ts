import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';
import { conversationShareUrl } from '../src/conversations/shareUrl.js';
import { callChatLinkTool, CHAT_LINK_TOOL } from '../src/mcp/chatLinkTool.js';
import { chatShareUrl } from '../../web/src/lib/chatDeletion.js';

describe('chat link agent tool', () => {
  it('describes current-chat discovery and the existing access requirement', () => {
    expect(CHAT_LINK_TOOL.name).toBe('get_chat_link');
    expect(CHAT_LINK_TOOL.description).toContain('Copy Link');
    expect(CHAT_LINK_TOOL.description).toContain('recipient must already have permission');
  });
  it.each([undefined, 'current', 'self', 'this', 'specific-chat'])('resolves %s through the authorized read route', async (conversationId) => {
    const callApi = vi.fn(async () => ({ ok: true, url: 'https://crew.veneer.app/#/chat/x' }));
    const result = await callChatLinkTool({ name: 'get_chat_link', args: { conversationId }, sourceConversationId: 'calling-chat', callApi });
    expect(callApi).toHaveBeenCalledWith(`/api/conversations/${conversationId === 'specific-chat' ? conversationId : 'calling-chat'}/link`);
    expect(JSON.parse(result!.content[0]!.text).url).toBe('https://crew.veneer.app/#/chat/x');
  });
  it('rejects remote addresses and cannot manufacture links after an access refusal', async () => {
    const callApi = vi.fn(async () => { throw new Error('Conversation not found'); });
    const options = { name: 'get_chat_link', sourceConversationId: '', callApi };
    expect((await callChatLinkTool({ ...options, args: {} }))?.isError).toBe(true);
    expect((await callChatLinkTool({ ...options, args: { conversationId: 'acme:chat' } }))?.isError).toBe(true);
    expect(callApi).not.toHaveBeenCalled();
    await expect(callChatLinkTool({ ...options, args: { conversationId: 'private' } })).rejects.toThrow('Conversation not found');
  });
});

describe('canonical chat links', () => {
  it.each(['https://veneer.example/', 'https://crew.veneer.app/', 'https://lps.veneer.app/prefix/'])('matches the actual Copy Link helper at %s', (origin) => {
    for (const project of [null, 'project-id']) {
      expect(conversationShareUrl(origin, 'chat-id', project)).toBe(chatShareUrl(new URL(origin), 'chat-id', project));
    }
  });
  it.each([null, '', 'file:///etc/passwd', 'http://localhost', 'http://127.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://example.com/?token=abc', 'https://example.com/#/wrong'])('refuses an unsafe or missing public origin %s', (origin) => {
    expect(() => conversationShareUrl(origin, 'chat')).toThrow();
  });
});

describe('chat link route', () => {
  let server: Server;
  let base: string;
  let db: Database.Database;
  const config = { appPublicOrigin: 'https://crew.veneer.app' as string | null };
  beforeAll(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations'));
    db.exec(`INSERT INTO users (id,email,display_name,role) VALUES (1,'owner@example.com','Owner','owner'),(2,'other@example.com','Other','member');
      INSERT INTO projects (id,slug,name) VALUES ('project-id','example','Example');
      INSERT INTO conversations (id,assistant_id,user_id,visibility,title,provider,native_session_id,project_id,archived) VALUES
      ('own',1,1,'private','Own chat','claude','own',NULL,0),
      ('project-chat',1,1,'private','Project chat','codex','project-chat','project-id',0),
      ('private-other',1,2,'private','Private','claude','private',NULL,0),
      ('team',1,2,'team','Team','codex','team',NULL,0),
      ('archived',1,1,'private','Archived','codex','archived',NULL,1);`);
    const app = express();
    app.use('/api', createApiRouter({ db, config, manager: {}, resolveIdentity: async (req: Request) => req.headers['x-no-auth'] ? null : { email: 'owner@example.com', agentConversationId: 'own' } } as unknown as AppContext));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => { config.appPublicOrigin = 'https://crew.veneer.app'; });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const get = (id: string, headers = {}) => fetch(`${base}/api/conversations/${id}/link`, { headers });
  it('returns project and unfiled URLs without marking the chat as read', async () => {
    const before = db.prepare('SELECT last_user_activity_at FROM conversations WHERE id=?').get('own');
    expect(await (await get('own')).json()).toMatchObject({ ok: true, url: 'https://crew.veneer.app/#/chat/own', projectId: null });
    expect(await (await get('project-chat')).json()).toMatchObject({ ok: true, url: 'https://crew.veneer.app/#/chat/project-chat?project=project-id' });
    expect(db.prepare('SELECT last_user_activity_at FROM conversations WHERE id=?').get('own')).toEqual(before);
  });
  it('enforces existing private/team access and permits archived chats', async () => {
    expect((await get('own', { 'x-no-auth': '1' })).status).toBe(403);
    expect((await get('private-other')).status).toBe(404);
    expect((await get('deleted')).status).toBe(404);
    expect((await get('team')).status).toBe(200);
    expect((await get('archived')).status).toBe(200);
  });
  it('ignores spoofed request origins and fails clearly if public configuration is absent', async () => {
    const response = await get('own', { 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'http' });
    expect((await response.json()).url).toBe('https://crew.veneer.app/#/chat/own');
    config.appPublicOrigin = null;
    expect((await get('own')).status).toBe(503);
  });
});
