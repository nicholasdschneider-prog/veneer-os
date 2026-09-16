import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import type { ComposioGmailDraftInput } from '../src/connectors/composio.js';
import { createGmailDraftsRouter } from '../src/routes/gmailDrafts.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const USER: UserRow = {
  id: 1,
  email: 'owner@example.com',
  display_name: 'Sam',
  role: 'owner',
  status: 'active',
  created_at: '',
  last_seen_at: null,
};
const MEMBER: UserRow = {
  ...USER,
  id: 2,
  email: 'member@example.com',
  display_name: 'Member',
  role: 'member',
};

let db: Database.Database;
let server: Server;
let base: string;
let root: string;
let workspace: string;
let createCalls: Array<{ apiKey: string; sessionId: string; input: ComposioGmailDraftInput }>;

function insertGmail(label = 'owner@example.com', userId = USER.id, sharing: 'personal' | 'shared' = 'personal'): void {
  db.prepare(
    `INSERT INTO user_connectors
       (user_id, connector_slug, label, status, sharing, config_json, access_mode, access_version)
     VALUES (?, 'gmail', ?, 'connected', ?, ?, 'full', 2)`,
  ).run(userId, label, sharing, JSON.stringify({
    sessionId: `session-${label}`,
    connectedAccountId: `account-${label}`,
    mcp: { type: 'http', url: 'https://mcp.example.test/gmail' },
  }));
}

async function call(body: unknown, agent = true, userId = USER.id) {
  const response = await fetch(`${base}/api/connectors/gmail/drafts-with-attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(agent ? { 'X-Test-Agent': 'chat-1' } : {}),
      'X-Test-User': String(userId),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-gmail-drafts-'));
  workspace = path.join(root, 'workspaces', 'assistant');
  fs.mkdirSync(workspace, { recursive: true });
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare('INSERT INTO users (id, email, display_name, role) VALUES (?, ?, ?, ?)')
    .run(USER.id, USER.email, USER.display_name, USER.role);
  db.prepare('INSERT INTO users (id, email, display_name, role) VALUES (?, ?, ?, ?)')
    .run(MEMBER.id, MEMBER.email, MEMBER.display_name, MEMBER.role);
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id)
     VALUES ('chat-1', 1, ?, 'grok', 'native-1')`,
  ).run(USER.id);

  const ctx = {
    db,
    config: { dataDir: root, sourceDir: path.join(root, 'source'), composioApiKey: 'test-composio-key' },
    secrets: { getApiKeyOverride: () => null },
    doppler: { get: () => null },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = req.headers['x-test-user'] === String(MEMBER.id) ? MEMBER : USER;
    if (req.headers['x-test-agent']) req.agentConversationId = String(req.headers['x-test-agent']);
    next();
  });
  app.use('/api/connectors/gmail', createGmailDraftsRouter(ctx, {
    createDraft: async (apiKey, sessionId, input) => {
      createCalls.push({ apiKey, sessionId, input });
      return { gmailUrl: 'https://mail.google.com/mail/u/0/#drafts/test' };
    },
  }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM user_connectors').run();
  createCalls = [];
});

describe('agent Gmail draft attachments', () => {
  it('stages a workspace deliverable through the selected managed Gmail session and never sends', async () => {
    insertGmail();
    const file = path.join(workspace, 'report.csv');
    fs.writeFileSync(file, 'name,value\nA,1\n');

    const result = await call({
      to: ['owner@example.com'],
      subject: 'Attachment test',
      body: 'Harmless unsent test.',
      attachments: ['report.csv'],
    });

    expect(result.status).toBe(200);
    expect(result.json.draft).toEqual({
      attached: 1,
      gmailUrl: 'https://mail.google.com/mail/u/0/#drafts/test',
      sent: false,
    });
    expect(createCalls).toEqual([{
      apiKey: 'test-composio-key',
      sessionId: 'session-owner@example.com',
      input: expect.objectContaining({ attachmentPaths: [fs.realpathSync(file)], to: ['owner@example.com'] }),
    }]);
  });

  it('requires an authenticated agent and refuses outside or sensitive files', async () => {
    insertGmail();
    const outside = path.join(root, 'outside.csv');
    fs.writeFileSync(outside, 'outside');
    fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=nope');

    expect((await call({
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: [outside],
    }, false)).status).toBe(403);
    expect((await call({
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: [outside],
    })).json.error).toContain('outside this chat');
    expect((await call({
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: ['.env'],
    })).json.error).toContain('Sensitive files');
    expect(createCalls).toEqual([]);
  });

  it('does not guess when multiple Gmail connections are available', async () => {
    insertGmail('Work');
    insertGmail('Personal');
    fs.writeFileSync(path.join(workspace, 'report.csv'), 'safe');

    const ambiguous = await call({
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: ['report.csv'],
    });
    expect(ambiguous.json.error).toContain('Choose account: Work, Personal');

    const selected = await call({
      account: 'Personal',
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: ['report.csv'],
    });
    expect(selected.status).toBe(200);
    expect(createCalls[0]?.sessionId).toBe('session-Personal');
  });

  it('uses the agent actor personal Gmail in another user’s Team chat, plus shared Gmail', async () => {
    insertGmail('Owner personal');
    insertGmail('Member personal', MEMBER.id);
    insertGmail('Shared inbox', USER.id, 'shared');
    fs.writeFileSync(path.join(workspace, 'report.csv'), 'safe');

    const denied = await call({
      account: 'Owner personal',
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: ['report.csv'],
    }, true, MEMBER.id);
    expect(denied.status).toBe(400);
    expect(denied.json.error).toContain('No writable Gmail connection');

    const personal = await call({
      account: 'Member personal',
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: ['report.csv'],
    }, true, MEMBER.id);
    const shared = await call({
      account: 'Shared inbox',
      to: ['owner@example.com'], subject: 'x', body: 'x', attachments: ['report.csv'],
    }, true, MEMBER.id);

    expect(personal.status).toBe(200);
    expect(shared.status).toBe(200);
    expect(createCalls.map((call) => call.sessionId)).toEqual([
      'session-Member personal',
      'session-Shared inbox',
    ]);
  });
});
