import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import { createApiRouter } from '../src/routes/api.js';
import type { ConversationRow } from '../src/db/db.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

// ── Manager.shutdown() kills in-flight turn children ────────────────────────
describe('conversationManager.shutdown', () => {
  it('kills every live turn', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com','Sam','owner')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('conv-1', 1, 1, 'T', 'claude', 'sid-1', 'web')`,
    ).run();

    let killed = 0;
    const adapter: ProviderAdapter = {
      id: 'claude',
      mintSessionId: () => 'sid',
      runTurn(_spec: TurnSpec, onEvent: (e: ConversationEvent) => void) {
        let resolveDone!: () => void;
        const done = new Promise<void>((r) => (resolveDone = r));
        void onEvent;
        return {
          done,
          kill: () => {
            killed += 1;
            resolveDone();
          },
          respondToApproval: () => true,
        };
      },
      readTranscript: async () => [],
    };

    const manager = createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }),
    });
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('conv-1') as ConversationRow;
    manager.postMessage(conv, 'hello');
    expect(manager.isLive('conv-1')).toBe(true);
    manager.shutdown();
    expect(killed).toBe(1);
    // NB: no db.close() here — killing the turn schedules an async completion
    // microtask that touches the DB. In production process.exit(0) runs before
    // it fires; in-test we just let the :memory: db be GC'd.
  });
});

// ── POST /api/admin/restart authorization + wiring ──────────────────────────
let server: Server;
let base: string;
let db: Database.Database;
const requestRestart = vi.fn();
const postMessage = vi.fn(async () => ({
  disposition: 'started' as const,
  queue: { revision: 1, messages: [], failedTurn: null },
}));
const managerBus = new EventEmitter();
let identityEmail = 'owner@example.com';

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com','Sam','owner')").run();
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('m@x.com','M','member')").run();
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('admin@example.com','Admin','consultant')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('conv-owner', 1, 1, 'Owner chat', 'claude', 'sid-o', 'web')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('conv-member', 1, 2, 'Member chat', 'claude', 'sid-m', 'web')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
     VALUES
      ('private-owner', 1, 1, 'private', 'Owner private chat', 'claude', 'sid-private-o', 'web'),
      ('private-member', 1, 2, 'private', 'Member private chat', 'claude', 'sid-private-m', 'web')`,
  ).run();
  db.prepare(
    `INSERT INTO projects (id, slug, name, instructions)
     VALUES ('archive-alpha', 'archive-alpha', 'Alpha Project', ''),
            ('archive-beta', 'archive-beta', 'Beta Project', '')`,
  ).run();
  const insertArchived = db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, visibility, project_id, title, provider, native_session_id, channel, archived,
       created_at, last_active_at)
     VALUES (?, 1, ?, ?, ?, ?, 'claude', ?, 'web', 1, ?, ?)`,
  );
  for (let index = 1; index <= 12; index += 1) {
    const timestamp = `2026-07-${String(index).padStart(2, '0')} 12:00:00`;
    insertArchived.run(
      `archived-alpha-${index}`,
      1,
      'team',
      'archive-alpha',
      `Alpha archived ${index}`,
      `sid-archive-alpha-${index}`,
      timestamp,
      timestamp,
    );
  }
  insertArchived.run(
    'archived-alpha-private-member',
    2,
    'private',
    'archive-alpha',
    'Private member archive',
    'sid-archive-private-member',
    '2026-07-20 12:00:00',
    '2026-07-20 12:00:00',
  );
  insertArchived.run(
    'archived-beta-needle',
    1,
    'team',
    'archive-beta',
    'Needle planning notes',
    'sid-archive-beta-needle',
    '2026-07-18 12:00:00',
    '2026-07-18 12:00:00',
  );
  insertArchived.run(
    'archived-beta-percent',
    1,
    'team',
    'archive-beta',
    'Launch is 100% done',
    'sid-archive-beta-percent',
    '2026-07-17 12:00:00',
    '2026-07-17 12:00:00',
  );
  insertArchived.run(
    'archived-unfiled-needle',
    1,
    'team',
    null,
    'Needle without a project',
    'sid-archive-unfiled-needle',
    '2026-07-19 12:00:00',
    '2026-07-19 12:00:00',
  );

  const ctx = {
    db,
    resolveIdentity: async () => ({ email: identityEmail }),
    // Runner client is fully async; these focused routes use statusOf and postMessage.
    manager: { statusOf: async () => 'idle', postMessage, steerMessage: postMessage, bus: managerBus },
    requestRestart,
  } as unknown as AppContext;

  const app = express();
  app.use('/api', createApiRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

async function restartAs(email: string) {
  identityEmail = email;
  requestRestart.mockClear();
  const res = await fetch(`${base}/api/admin/restart`, { method: 'POST' });
  return res.status;
}

describe('POST /api/admin/restart', () => {
  it('lets an owner restart and fires the hook', async () => {
    expect(await restartAs('owner@example.com')).toBe(202);
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('denies a member and never fires the hook', async () => {
    expect(await restartAs('m@x.com')).toBe(403);
    expect(requestRestart).not.toHaveBeenCalled();
  });
});

describe('agent instructions', () => {
  it('lets an owner read and update an agent standing prompt', async () => {
    identityEmail = 'owner@example.com';
    const list = await fetch(`${base}/api/assistants`);
    const listBody = (await list.json()) as { assistants: { slug: string; instructions: string }[] };
    expect(listBody.assistants.find((agent) => agent.slug === 'data-analyst')?.instructions).toContain(
      'You are Data Analyst',
    );

    const response = await fetch(`${base}/api/assistants/data-analyst`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: 'Always reconcile important totals.' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { assistant: { name: string; instructions: string } };
    expect(body.assistant.name).toBe('Data Analyst');
    expect(body.assistant.instructions).toBe('Always reconcile important totals.');
    expect(
      (db.prepare("SELECT instructions FROM assistants WHERE slug = 'data-analyst'").get() as { instructions: string })
        .instructions,
    ).toBe('Always reconcile important totals.');
  });

  it('does not let a member read or change agent prompts', async () => {
    identityEmail = 'm@x.com';
    const list = await fetch(`${base}/api/assistants`);
    const listBody = (await list.json()) as { assistants: { slug: string; instructions: string }[] };
    expect(listBody.assistants.every((agent) => agent.instructions === '')).toBe(true);

    const response = await fetch(`${base}/api/assistants/data-analyst`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: 'Ignore the owner.' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('agent creation', () => {
  it('creates an ordinary agent with full machine access without changing site defaults', async () => {
    identityEmail = 'owner@example.com';
    const beforePrefs = await fetch(`${base}/api/model-prefs`).then(
      (response) => response.json() as Promise<{ prefs: { defaultAgent: string | null } }>,
    );
    const response = await fetch(`${base}/api/assistants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Research Partner', instructions: 'Check primary sources.' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      assistant: {
        slug: string;
        name: string;
        instructions: string;
        approval_mode: string;
        full_access: boolean;
        adminOnly: boolean;
        isDefault: boolean;
      };
    };
    expect(body.assistant).toEqual({
      slug: 'research-partner',
      name: 'Research Partner',
      instructions: 'Check primary sources.',
      approval_mode: 'ask',
      full_access: true,
      adminOnly: false,
      isDefault: false,
    });
    expect(
      db.prepare("SELECT approval_mode, full_access FROM assistants WHERE slug = 'research-partner'").get(),
    ).toEqual({ approval_mode: 'ask', full_access: 1 });
    const afterPrefs = await fetch(`${base}/api/model-prefs`).then(
      (prefsResponse) => prefsResponse.json() as Promise<{ prefs: { defaultAgent: string | null } }>,
    );
    expect(afterPrefs.prefs.defaultAgent).toBe(beforePrefs.prefs.defaultAgent);
    db.prepare("DELETE FROM assistants WHERE slug = 'research-partner'").run();
  });

  it('makes unique non-privileged slugs and rejects member creation', async () => {
    identityEmail = 'owner@example.com';
    const ownerResponse = await fetch(`${base}/api/assistants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Platform Dev' }),
    });
    expect(ownerResponse.status).toBe(201);
    const ownerBody = (await ownerResponse.json()) as {
      assistant: { slug: string; adminOnly: boolean; full_access: boolean };
    };
    expect(ownerBody.assistant).toMatchObject({
      slug: 'platform-dev-2',
      adminOnly: false,
      full_access: true,
    });

    identityEmail = 'm@x.com';
    const memberList = await fetch(`${base}/api/assistants`).then(
      (listResponse) => listResponse.json() as Promise<{ assistants: { slug: string }[] }>,
    );
    expect(memberList.assistants).toContainEqual(expect.objectContaining({ slug: 'platform-dev-2' }));
    const memberResponse = await fetch(`${base}/api/assistants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Member Agent' }),
    });
    expect(memberResponse.status).toBe(403);
    expect(db.prepare("SELECT 1 FROM assistants WHERE slug = 'member-agent'").get()).toBeUndefined();
    db.prepare("DELETE FROM assistants WHERE slug = 'platform-dev-2'").run();
  });

  it('rejects an empty agent name', async () => {
    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api/assistants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('agent deletion', () => {
  it('retires an unused optional agent and clears its saved defaults', async () => {
    identityEmail = 'owner@example.com';
    const inserted = db
      .prepare("INSERT INTO assistants (slug, name) VALUES ('delete-me', 'Delete Me')")
      .run();
    db.prepare(
      "INSERT INTO projects (id, slug, name, default_assistant_id) VALUES ('delete-project', 'delete-project', 'Delete project', ?)",
    ).run(Number(inserted.lastInsertRowid));

    const prefsResponse = await fetch(`${base}/api/model-prefs`);
    const prefsBody = (await prefsResponse.json()) as {
      prefs: Record<string, unknown> & { agents: Record<string, unknown> };
    };
    const savePrefsResponse = await fetch(`${base}/api/model-prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...prefsBody.prefs,
        defaultAgent: 'delete-me',
        agents: { ...prefsBody.prefs.agents, 'delete-me': { provider: 'claude', model: null, effort: null } },
      }),
    });
    expect(savePrefsResponse.status).toBe(200);

    const response = await fetch(`${base}/api/assistants/delete-me`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: string; prefs: { defaultAgent: string | null; agents: object } };
    expect(body.deleted).toBe('delete-me');
    expect(body.prefs.defaultAgent).toBeNull();
    expect(body.prefs.agents).not.toHaveProperty('delete-me');
    expect(
      (db.prepare("SELECT deleted_at FROM assistants WHERE slug = 'delete-me'").get() as { deleted_at: string | null })
        .deleted_at,
    ).not.toBeNull();
    expect(
      (db.prepare("SELECT default_assistant_id FROM projects WHERE id = 'delete-project'").get() as {
        default_assistant_id: number | null;
      }).default_assistant_id,
    ).toBe(
      (db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number }).id,
    );
    db.prepare("DELETE FROM projects WHERE id = 'delete-project'").run();
  });

  it('keeps chats and reassigns automations when their agent is retired', async () => {
    identityEmail = 'owner@example.com';
    const inserted = db
      .prepare("INSERT INTO assistants (slug, name) VALUES ('busy-agent', 'Busy Agent')")
      .run();
    const assistantId = Number(inserted.lastInsertRowid);
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('busy-agent-chat', ?, 1, 'Busy chat', 'claude', 'busy-sid', 'web')`,
    ).run(assistantId);
    db.prepare(
      `INSERT INTO scheduled_tasks
         (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider)
       VALUES ('busy-agent-task', 1, ?, 'Busy task', 'Do work', '{}', 'America/New_York', 'claude')`,
    ).run(assistantId);

    const response = await fetch(`${base}/api/assistants/busy-agent`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      replacement: { slug: string };
      reassigned: { projects: number; automations: number };
    };
    expect(body.replacement.slug).toBe('assistant');
    expect(body.reassigned.automations).toBe(1);
    expect(db.prepare("SELECT deleted_at FROM assistants WHERE slug = 'busy-agent'").get()).toEqual({
      deleted_at: expect.any(String),
    });
    expect(db.prepare("SELECT assistant_id FROM conversations WHERE id = 'busy-agent-chat'").get()).toEqual({
      assistant_id: assistantId,
    });
    expect(
      db
        .prepare(
          "SELECT a.slug FROM scheduled_tasks t JOIN assistants a ON a.id = t.assistant_id WHERE t.id = 'busy-agent-task'",
        )
        .get(),
    ).toEqual({ slug: 'assistant' });
    db.prepare("DELETE FROM scheduled_tasks WHERE id = 'busy-agent-task'").run();
    db.prepare("DELETE FROM conversations WHERE id = 'busy-agent-chat'").run();
    db.prepare("DELETE FROM assistants WHERE slug = 'busy-agent'").run();
  });

  it('rejects member deletion requests', async () => {
    const inserted = db
      .prepare("INSERT INTO assistants (slug, name) VALUES ('member-delete-agent', 'Member Delete')")
      .run();
    identityEmail = 'm@x.com';
    const memberResponse = await fetch(`${base}/api/assistants/member-delete-agent`, { method: 'DELETE' });
    expect(memberResponse.status).toBe(403);
    expect(db.prepare('SELECT 1 FROM assistants WHERE id = ?').get(Number(inserted.lastInsertRowid))).toBeDefined();
    db.prepare("DELETE FROM assistants WHERE slug = 'member-delete-agent'").run();

  });
});

describe('approval mode API', () => {
  it('returns and updates agent defaults but rejects Platform Dev', async () => {
    identityEmail = 'owner@example.com';
    const list = await fetch(`${base}/api/assistants`);
    const listBody = (await list.json()) as { assistants: { slug: string; approval_mode: string }[] };
    expect(listBody.assistants.find((agent) => agent.slug === 'data-analyst')?.approval_mode).toBe('ask');

    const update = await fetch(`${base}/api/assistants/data-analyst`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_mode: 'auto' }),
    });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { assistant: { approval_mode: string } };
    expect(updateBody.assistant.approval_mode).toBe('auto');

    const platform = await fetch(`${base}/api/assistants/platform-dev`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_mode: 'auto' }),
    });
    expect(platform.status).toBe(400);
  });

  it('returns the effective mode and supports setting and clearing a chat override', async () => {
    identityEmail = 'owner@example.com';
    db.prepare("UPDATE assistants SET approval_mode = 'auto', full_access = 0 WHERE id = 1").run();

    const inherited = await fetch(`${base}/api/conversations/conv-owner`);
    const inheritedBody = (await inherited.json()) as {
      conversation: { approvalMode: string | null; effectiveApprovalMode: string };
    };
    expect(inheritedBody.conversation).toMatchObject({ approvalMode: null, effectiveApprovalMode: 'auto' });

    const overridden = await fetch(`${base}/api/conversations/conv-owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_mode: 'ask' }),
    });
    const overriddenBody = (await overridden.json()) as {
      conversation: { approvalMode: string | null; effectiveApprovalMode: string };
    };
    expect(overriddenBody.conversation).toMatchObject({ approvalMode: 'ask', effectiveApprovalMode: 'ask' });

    const cleared = await fetch(`${base}/api/conversations/conv-owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_mode: null }),
    });
    const clearedBody = (await cleared.json()) as {
      conversation: { approvalMode: string | null; effectiveApprovalMode: string };
    };
    expect(clearedBody.conversation).toMatchObject({ approvalMode: null, effectiveApprovalMode: 'auto' });
  });

  it('reports Full Access as autonomous even when agent and chat modes are Ask', async () => {
    identityEmail = 'owner@example.com';
    db.prepare("UPDATE assistants SET approval_mode = 'ask', full_access = 1 WHERE id = 1").run();
    db.prepare("UPDATE conversations SET approval_mode = 'ask' WHERE id = 'conv-owner'").run();

    const response = await fetch(`${base}/api/conversations/conv-owner`);
    const body = (await response.json()) as {
      conversation: {
        approvalMode: string | null;
        effectiveApprovalMode: string;
        fullAccess: boolean;
      };
    };
    expect(body.conversation).toMatchObject({
      approvalMode: 'ask',
      effectiveApprovalMode: 'auto',
      fullAccess: true,
    });
  });

  it('labels resolved audit rows without a human resolver as auto-approved', async () => {
    identityEmail = 'owner@example.com';
    db.prepare(
      `INSERT INTO approvals
         (conversation_id, request_id, tool_name, request_json, status, resolved_by, resolved_at)
       VALUES ('conv-owner', 'req-auto-api', 'Write', '{}', 'approved', NULL, datetime('now'))`,
    ).run();
    const response = await fetch(`${base}/api/approvals?status=approved`);
    const body = (await response.json()) as {
      approvals: { requestId?: string; statusLabel: string; autoApproved: boolean }[];
    };
    expect(body.approvals[0]).toMatchObject({ statusLabel: 'Auto-approved', autoApproved: true });
  });
});

describe('Full Access API', () => {
  it('defaults every agent to full machine access and updates each agent independently', async () => {
    identityEmail = 'owner@example.com';
    const list = await fetch(`${base}/api/assistants`);
    const listBody = (await list.json()) as {
      assistants: { slug: string; full_access: boolean }[];
    };
    expect(listBody.assistants.find((agent) => agent.slug === 'data-analyst')?.full_access).toBe(true);
    expect(listBody.assistants.find((agent) => agent.slug === 'platform-dev')?.full_access).toBe(true);

    db.prepare("UPDATE assistants SET full_access = 0 WHERE slug = 'data-analyst'").run();
    const update = await fetch(`${base}/api/assistants/data-analyst`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_access: true }),
    });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { assistant: { full_access: boolean } };
    expect(updateBody.assistant.full_access).toBe(true);
    expect(
      (db.prepare("SELECT full_access FROM assistants WHERE slug = 'app-creator'").get() as { full_access: number })
        .full_access,
    ).toBe(1);

    db.prepare("UPDATE assistants SET full_access = 0 WHERE slug = 'data-analyst'").run();
  });
});

// ── GET /api/conversations visibility ───────────────────────────────────────
async function listConversationsAs(email: string): Promise<string[]> {
  identityEmail = email;
  const res = await fetch(`${base}/api/conversations`);
  const body = (await res.json()) as { conversations: { id: string }[] };
  return body.conversations.map((c) => c.id);
}

describe('GET /api/conversations', () => {
  it('shows Team chats and only owned Private chats to the owner', async () => {
    const ids = await listConversationsAs('owner@example.com');
    expect(ids).toContain('conv-owner');
    expect(ids).toContain('conv-member');
    expect(ids).toContain('private-owner');
    expect(ids).not.toContain('private-member');
  });

  it('does not give another administrator the temporary Private-chat view', async () => {
    const ids = await listConversationsAs('admin@example.com');
    expect(ids).not.toContain('private-owner');
    expect(ids).not.toContain('private-member');
  });

  it('shows Team chats and only the caller’s Private chats to a member', async () => {
    const ids = await listConversationsAs('m@x.com');
    expect(ids).toContain('conv-owner');
    expect(ids).toContain('conv-member');
    expect(ids).toContain('private-member');
    expect(ids).not.toContain('private-owner');
  });

  it('returns a Private chat only to its creator', async () => {
    identityEmail = 'm@x.com';
    expect((await fetch(`${base}/api/conversations/private-owner`)).status).toBe(404);
    expect((await fetch(`${base}/api/conversations/private-member`)).status).toBe(200);

    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api/conversations/private-member`);
    expect(response.status).toBe(404);
  });

  it('does not let another owner send to a creator\'s Private chat', async () => {
    identityEmail = 'owner@example.com';
    postMessage.mockClear();
    const response = await fetch(`${base}/api/conversations/private-member/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Private follow-up' }),
    });
    expect(response.status).toBe(404);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('lets another member send a message to a Team chat', async () => {
    identityEmail = 'm@x.com';
    postMessage.mockClear();
    const response = await fetch(`${base}/api/conversations/conv-owner/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Team follow-up' }),
    });
    expect(response.status).toBe(200);
    expect(postMessage).toHaveBeenCalledWith('conv-owner', 'Team follow-up', 2);

    const detail = await fetch(`${base}/api/conversations/conv-owner`);
    const detailBody = (await detail.json()) as {
      conversation: { canSend: boolean; canManage: boolean };
    };
    expect(detailBody.conversation.canSend).toBe(true);
    expect(detailBody.conversation.canManage).toBe(true);
  });

  it('lets another member change settings on a Team chat', async () => {
    identityEmail = 'm@x.com';
    const response = await fetch(`${base}/api/conversations/conv-owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'team-model', effort: 'high', approval_mode: 'auto' }),
    });
    expect(response.status).toBe(200);
    expect(
      db.prepare('SELECT model, effort, approval_mode FROM conversations WHERE id = ?').get('conv-owner'),
    ).toEqual({ model: 'team-model', effort: 'high', approval_mode: 'auto' });
  });

  it('does not let another member send a message to a Private chat', async () => {
    identityEmail = 'm@x.com';
    postMessage.mockClear();
    const response = await fetch(`${base}/api/conversations/private-owner/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Private follow-up' }),
    });
    expect(response.status).toBe(404);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not let another member change settings on a Private chat', async () => {
    identityEmail = 'm@x.com';
    const response = await fetch(`${base}/api/conversations/private-owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    });
    expect(response.status).toBe(404);
  });

  it('lets the creator switch a chat between Team and Private', async () => {
    identityEmail = 'owner@example.com';
    const accessChanged = vi.fn();
    managerBus.on('access', accessChanged);

    const makePrivate = await fetch(`${base}/api/conversations/conv-owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(makePrivate.status).toBe(200);
    await expect(makePrivate.json()).resolves.toMatchObject({
      conversation: { visibility: 'private', canChangeVisibility: true },
    });
    expect(accessChanged).toHaveBeenCalledWith('conv-owner');

    identityEmail = 'm@x.com';
    expect((await fetch(`${base}/api/conversations/conv-owner`)).status).toBe(404);

    identityEmail = 'owner@example.com';
    const shareWithTeam = await fetch(`${base}/api/conversations/conv-owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'team' }),
    });
    expect(shareWithTeam.status).toBe(200);
    await expect(shareWithTeam.json()).resolves.toMatchObject({ conversation: { visibility: 'team' } });

    identityEmail = 'm@x.com';
    expect((await fetch(`${base}/api/conversations/conv-owner`)).status).toBe(200);
    managerBus.off('access', accessChanged);
  });

  it('does not let a Team collaborator change a chat creator\'s visibility', async () => {
    identityEmail = 'm@x.com';
    const response = await fetch(`${base}/api/conversations/conv-owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(response.status).toBe(403);
    expect(db.prepare('SELECT visibility FROM conversations WHERE id = ?').get('conv-owner')).toEqual({
      visibility: 'team',
    });
  });

  it('includes each chat creator in list and detail views', async () => {
    identityEmail = 'owner@example.com';
    const list = await fetch(`${base}/api/conversations`);
    const listBody = (await list.json()) as {
      conversations: { id: string; creator: { id: number; displayName: string } }[];
    };
    expect(listBody.conversations.find((conversation) => conversation.id === 'conv-member')?.creator).toEqual({
      id: 2,
      displayName: 'M',
    });

    const detail = await fetch(`${base}/api/conversations/conv-owner`);
    const detailBody = (await detail.json()) as {
      conversation: {
        creator: { id: number; displayName: string };
        visibility: string;
        canSend: boolean;
        canChangeVisibility: boolean;
      };
    };
    expect(detailBody.conversation.creator).toEqual({ id: 1, displayName: 'Sam' });
    expect(detailBody.conversation.visibility).toBe('team');
    expect(detailBody.conversation.canSend).toBe(true);
    expect(detailBody.conversation.canChangeVisibility).toBe(true);
  });
});

describe('GET /api/archived-conversations', () => {
  it('groups visible chats by project and caps each preview at ten', async () => {
    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api/archived-conversations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      groups: Array<{
        projectId: string | null;
        projectName: string;
        totalCount: number;
        pageSize: number;
        conversations: { id: string }[];
      }>;
    };
    const alpha = body.groups.find((group) => group.projectId === 'archive-alpha');
    expect(alpha).toMatchObject({ projectName: 'Alpha Project', totalCount: 12, pageSize: 10 });
    expect(alpha?.conversations).toHaveLength(10);
    expect(alpha?.conversations[0]?.id).toBe('archived-alpha-12');
    expect(body.groups.find((group) => group.projectId === null)).toMatchObject({
      projectName: 'Unfiled',
      totalCount: 1,
    });
  });

  it('paginates one project and clamps pages past the end', async () => {
    identityEmail = 'owner@example.com';
    const response = await fetch(
      `${base}/api/archived-conversations?project=archive-alpha&page=99&pageSize=5`,
    );
    const body = (await response.json()) as {
      group: { totalCount: number; page: number; pageSize: number; totalPages: number; conversations: unknown[] };
    };
    expect(body.group).toMatchObject({ totalCount: 12, page: 3, pageSize: 5, totalPages: 3 });
    expect(body.group.conversations).toHaveLength(2);
  });

  it('searches titles inside project groups and treats wildcard characters literally', async () => {
    identityEmail = 'owner@example.com';
    const matches = await fetch(`${base}/api/archived-conversations?query=needle`).then(
      (response) => response.json() as Promise<{ groups: Array<{ projectId: string | null; totalCount: number }> }>,
    );
    expect(matches.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'archive-beta', totalCount: 1 }),
      expect.objectContaining({ projectId: null, totalCount: 1 }),
    ]));
    expect(matches.groups).toHaveLength(2);

    const literalPercent = await fetch(`${base}/api/archived-conversations?query=%25`).then(
      (response) => response.json() as Promise<{ groups: Array<{ projectId: string | null; totalCount: number }> }>,
    );
    expect(literalPercent.groups).toEqual([
      expect.objectContaining({ projectId: 'archive-beta', totalCount: 1 }),
    ]);
  });

  it('includes a private archived chat only for its creator', async () => {
    identityEmail = 'm@x.com';
    const response = await fetch(`${base}/api/archived-conversations?project=archive-alpha`);
    const body = (await response.json()) as { group: { totalCount: number } };
    expect(body.group.totalCount).toBe(13);

    identityEmail = 'owner@example.com';
  });
});
