import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectedConnectorRowsForConversation } from '../src/connectors/access.js';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { createConnectorsRouter } from '../src/routes/connectors.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const USERS: Record<string, UserRow> = {
  owner: {
    id: 1,
    email: 'owner@example.com',
    display_name: 'Owner',
    role: 'owner',
    status: 'active',
    created_at: '',
    last_seen_at: null,
  },
  member: {
    id: 2,
    email: 'member@example.com',
    display_name: 'Member',
    role: 'member',
    status: 'active',
    created_at: '',
    last_seen_at: null,
  },
};

let db: Database.Database;
let server: Server;
let base: string;
const NETSUITE_SETTINGS = {
  accountId: '1234567',
  clientId: 'client-id',
  certId: 'certificate-id',
  privateKey: 'private-key',
};

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const ctx = {
    db,
    config: {},
  } as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[String(req.headers['x-test-user'] ?? 'member')];
    next();
  });
  app.use('/api/connectors', createConnectorsRouter(ctx, {
    testNetSuiteConnection: async () => ({
      ok: true,
      status: 'connected',
      error: null,
      timeoutStage: null,
      timings: { tokenMs: 1, queryMs: 1, totalMs: 2 },
    }),
  }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

beforeEach(() => {
  db.prepare('DELETE FROM user_connectors').run();
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM users').run();
  for (const user of Object.values(USERS)) {
    db.prepare('INSERT INTO users (id, email, display_name, role, status) VALUES (?, ?, ?, ?, ?)').run(
      user.id,
      user.email,
      user.display_name,
      user.role,
      user.status,
    );
  }
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('p1', 'alpha', 'Alpha')").run();
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('p2', 'beta', 'Beta')").run();
});

async function call(method: string, url: string, user: keyof typeof USERS, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('connector access routes', () => {
  it('creates a shared connector for multiple projects and limits management to admins', async () => {
    const created = await call('POST', '/api/connectors/netsuite/install', 'owner', {
      settings: NETSUITE_SETTINGS,
      sharing: 'shared',
      scopeMode: 'projects',
      projectIds: ['p1', 'p2'],
    });
    expect(created.status).toBe(200);

    const listed = await call('GET', '/api/connectors', 'member');
    const netsuite = (listed.json.connectors as Record<string, any>[]).find((item) => item.slug === 'netsuite');
    expect(netsuite.installs[0]).toMatchObject({
      sharing: 'shared',
      scopeMode: 'projects',
      ownedByMe: false,
      canManage: false,
    });
    expect(netsuite.installs[0].projects.map((project: { id: string }) => project.id)).toEqual(['p1', 'p2']);

    const id = netsuite.installs[0].id as number;
    expect(
      (await call('PATCH', `/api/connectors/install/${id}`, 'member', {
        sharing: 'shared',
        scopeMode: 'projects',
        projectIds: ['p1'],
      })).status,
    ).toBe(403);
    expect(
      (await call('PATCH', `/api/connectors/install/${id}`, 'owner', {
        sharing: 'shared',
        scopeMode: 'projects',
        projectIds: ['p2'],
      })).status,
    ).toBe(200);
  });

  it('creates a connector for everybody in all projects', async () => {
    const created = await call('POST', '/api/connectors/netsuite/install', 'owner', {
      settings: NETSUITE_SETTINGS,
      sharing: 'shared',
      scopeMode: 'all',
      projectIds: [],
    });
    expect(created.status).toBe(200);

    const listed = await call('GET', '/api/connectors', 'member');
    const netsuite = (listed.json.connectors as Record<string, any>[]).find((item) => item.slug === 'netsuite');
    expect(netsuite.installs[0]).toMatchObject({
      sharing: 'shared',
      scopeMode: 'all',
      projects: [],
      ownedByMe: false,
      canManage: false,
    });
  });

  it('prevents a member from creating a shared connector', async () => {
    const result = await call('POST', '/api/connectors/netsuite/install', 'member', {
      settings: NETSUITE_SETTINGS,
      sharing: 'shared',
      scopeMode: 'projects',
      projectIds: ['p1'],
    });
    expect(result.status).toBe(403);
  });

});

describe('connector runtime access', () => {
  function insertConnector(
    userId: number,
    label: string,
    sharing: 'personal' | 'shared',
    scopeMode: 'all' | 'projects',
    projectIds: string[],
  ): number {
    const info = db.prepare(
      `INSERT INTO user_connectors
         (user_id, connector_slug, label, status, config_json, sharing, scope_mode)
       VALUES (?, 'netsuite', ?, 'connected', '{}', ?, ?)`,
    ).run(userId, label, sharing, scopeMode);
    const id = Number(info.lastInsertRowid);
    for (const projectId of projectIds) {
      db.prepare('INSERT INTO user_connector_projects (connector_id, project_id) VALUES (?, ?)').run(id, projectId);
    }
    return id;
  }

  it('intersects ownership, sharing, and project assignment', () => {
    insertConnector(1, 'Everywhere', 'personal', 'all', []);
    insertConnector(1, 'Alpha personal', 'personal', 'projects', ['p1']);
    insertConnector(2, 'Member personal', 'personal', 'all', []);
    insertConnector(1, 'Everybody everywhere', 'shared', 'all', []);
    insertConnector(1, 'Everybody in Alpha', 'shared', 'projects', ['p1']);

    const insertConversation = db.prepare(
      `INSERT INTO conversations
         (id, assistant_id, user_id, project_id, provider, native_session_id)
       VALUES (?, 1, ?, ?, 'claude', ?)`,
    );
    insertConversation.run('owner-none', 1, null, 'n1');
    insertConversation.run('owner-alpha', 1, 'p1', 'n2');
    insertConversation.run('owner-beta', 1, 'p2', 'n3');
    insertConversation.run('member-alpha', 2, 'p1', 'n4');
    insertConversation.run('member-beta', 2, 'p2', 'n5');
    insertConversation.run('member-none', 2, null, 'n6');
    db.prepare("UPDATE conversations SET visibility = 'private' WHERE id = 'owner-beta'").run();

    const labels = (conversationId: string, actorUserId: number) =>
      connectedConnectorRowsForConversation(db, conversationId, actorUserId).map((row) => row.label);
    expect(labels('owner-none', 1)).toEqual(['Everywhere', 'Everybody everywhere']);
    expect(labels('owner-alpha', 1)).toEqual([
      'Everywhere',
      'Alpha personal',
      'Everybody everywhere',
      'Everybody in Alpha',
    ]);
    // A collaborator in the owner's Team chat gets their own personal account,
    // never the creator's, plus shared accounts allowed in this project.
    expect(labels('owner-alpha', 2)).toEqual([
      'Member personal',
      'Everybody everywhere',
      'Everybody in Alpha',
    ]);
    expect(labels('member-alpha', 2)).toEqual([
      'Member personal',
      'Everybody everywhere',
      'Everybody in Alpha',
    ]);
    expect(labels('member-beta', 2)).toEqual(['Member personal', 'Everybody everywhere']);
    expect(labels('member-none', 2)).toEqual(['Member personal', 'Everybody everywhere']);
    // Connector selection does not weaken chat visibility. If a turn is
    // already authorized, Private and Team chats use the same actor rule.
    expect(labels('owner-beta', 1)).toEqual(['Everywhere', 'Everybody everywhere']);
    expect(labels('owner-beta', 2)).toEqual(['Member personal', 'Everybody everywhere']);
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = 2").run();
    expect(labels('owner-alpha', 2)).toEqual([]);
  });
});
