import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow, QuestionRow } from '../src/db/db.js';
import { createApiRouter } from '../src/routes/api.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { dopplerSecretStdin, downloadDopplerSecrets, setDopplerSecret } from '../src/secrets/doppler.js';
import { runProjectDopplerCli } from '../src/secrets/projectDopplerCli.js';

// The access policy stays real (it decides main_full vs client_project); only
// the process-spawning and network calls are stubbed.
vi.mock('../src/secrets/projectDopplerCli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/secrets/projectDopplerCli.js')>()),
  runProjectDopplerCli: vi.fn(),
}));
vi.mock('../src/secrets/doppler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/secrets/doppler.js')>()),
  downloadDopplerSecrets: vi.fn(),
  setDopplerSecret: vi.fn(),
}));

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const VALUE = 'sk_live_51NeverLeakThisValue';
const runCli = vi.mocked(runProjectDopplerCli);
const download = vi.mocked(downloadDopplerSecrets);
const setSecret = vi.mocked(setDopplerSecret);

let server: Server;
let base: string;
let db: Database.Database;
let identityEmail = 'owner@example.com';
let appPublicOrigin = 'https://veneer.example';
let manager: ReturnType<typeof createConversationManager>;
let events: ConversationEvent[] = [];

const adapter: ProviderAdapter = {
  id: 'codex',
  mintSessionId: () => 'sid-1',
  runTurn: () => ({
    done: Promise.resolve(),
    kill: () => {},
    respondToApproval: () => true,
    respondToQuestion: () => true,
  }),
  readTranscript: async () => [],
};

async function get(
  url: string,
): Promise<{ status: number; text: string; json: Record<string, any> }> {
  const response = await fetch(`${base}${url}`);
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

async function post(
  url: string,
  body: unknown,
): Promise<{ status: number; text: string; json: Record<string, any> }> {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

function requestSecret(conversationId = 'conv-1', body: Record<string, unknown> = {}) {
  return post(`/api/conversations/${conversationId}/request-secret`, {
    name: 'stripe_api_key',
    purpose: 'Stripe live key so I can create the invoice.',
    ...body,
  });
}

function revealSecret(conversationId = 'conv-1', body: Record<string, unknown> = {}) {
  return post(`/api/conversations/${conversationId}/reveal-secret`, { name: 'stripe_api_key', ...body });
}

function questionRow(): QuestionRow {
  return db.prepare('SELECT * FROM questions ORDER BY rowid DESC LIMIT 1').get() as QuestionRow;
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO users (email, display_name, role) VALUES
      ('owner@example.com', 'Owner', 'owner'),
      ('member@example.com', 'Member', 'member'),
      ('consultant@example.com', 'Consultant', 'consultant')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel, visibility)
     VALUES ('conv-1', 1, 1, 'Test', 'codex', 'sid-1', 'web', 'private')`,
  ).run();
  // A chat the member genuinely owns, so the role gate is what refuses them
  // rather than the chat-ownership 404.
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel, visibility)
     VALUES ('conv-member', 1, 2, 'Member chat', 'codex', 'sid-2', 'web', 'private')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel, visibility)
     VALUES ('conv-consultant', 1, 3, 'Consultant chat', 'codex', 'sid-3', 'web', 'private')`,
  ).run();
  db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
    'doppler_connection',
    JSON.stringify({
      project: 'client-one',
      config: 'prd',
      connectedAt: '2026-07-28T12:00:00.000Z',
      runtimeConfigured: true,
      agentConfigured: true,
    }),
  );

  manager = createConversationManager({
    db,
    adapters: { codex: adapter },
    resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }),
    approvalTimeoutMs: 60_000,
    log: { warn() {}, error() {} },
  });
  manager.bus.on('event', (_id: string, event: ConversationEvent) => events.push(event));

  const ctx = {
    config: {
      get appPublicOrigin() {
        return appPublicOrigin;
      },
    },
    db,
    resolveIdentity: async () => ({ email: identityEmail }),
    manager,
    projectDopplerCli: { binDir: '/tmp/project-cli', configDir: '/tmp/.doppler', userHome: '/tmp' },
    dopplerTokens: { get: () => ({ agentToken: 'dp.st.agent-must-not-leak', runtimeToken: 'dp.st.runtime' }) },
    doppler: { status: () => ({}), refresh: vi.fn(async () => ({})) },
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

beforeEach(() => {
  identityEmail = 'owner@example.com';
  appPublicOrigin = 'https://veneer.example';
  events = [];
  db.prepare('DELETE FROM questions').run();
  runCli.mockReset();
  download.mockReset();
  setSecret.mockReset();
  runCli.mockResolvedValue({ stdout: '[]', stderr: '', code: 0 });
  download.mockResolvedValue(new Map());
});

describe('agent secret requests', () => {
  it('creates a secret prompt for an explicit project and config on the main instance', async () => {
    runCli.mockResolvedValue({ stdout: JSON.stringify(['STRIPE_API_KEY', 'OTHER']), stderr: '', code: 0 });
    const response = await requestSecret('conv-1', { project: 'veneer', config: 'prd' });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: true, name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd' });

    expect(runCli.mock.calls[0]![1]).toEqual([
      'secrets', '--only-names', '--project', 'veneer', '--config', 'prd', '--json',
    ]);
    expect(JSON.parse(questionRow().questions_json)).toEqual([{
      id: 'q1',
      question: 'Stripe live key so I can create the invoice.',
      options: [],
      multi: false,
      allowOther: true,
      kind: 'secret',
      secret: { name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd', exists: true },
    }]);
  });

  it('requires a project and config on the main instance and validates the secret name', async () => {
    expect((await requestSecret('conv-1', { project: 'veneer' })).status).toBe(400);
    expect((await requestSecret('conv-1', { name: 'not a name', project: 'v', config: 'p' })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM questions').get()).toEqual({ n: 0 });
  });

  it('writes the value on stdin, resolves the question, and never echoes it', async () => {
    await requestSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;
    runCli.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    events = [];

    const response = await post(`/api/questions/${requestId}/save-secret`, { value: `${VALUE}\n` });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: true });

    const [bin, args, , , input] = runCli.mock.calls.at(-1)!;
    expect(bin).toBe(path.join('/tmp/project-cli', 'doppler'));
    expect(args).toEqual([
      'secrets', 'set', 'STRIPE_API_KEY', '--project', 'veneer', '--config', 'prd', '--silent',
    ]);
    expect(args.join(' ')).not.toContain(VALUE);
    // The single trailing newline is stripped before the CLI's own is added.
    expect(input).toBe(dopplerSecretStdin(VALUE));

    const row = questionRow();
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answers_json)).toEqual({ q1: ['saved'] });
    for (const text of [response.text, JSON.stringify(row), JSON.stringify(events)]) {
      expect(text).not.toContain(VALUE);
    }
  });

  it('keeps the question pending and redacts the value when the write fails', async () => {
    await requestSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;
    runCli.mockResolvedValue({ stdout: '', stderr: `invalid value ${VALUE} for STRIPE_API_KEY`, code: 1 });

    const response = await post(`/api/questions/${requestId}/save-secret`, { value: VALUE });
    expect(response.status).toBe(400);
    expect(response.text).not.toContain(VALUE);
    expect(response.json.error).toContain('[redacted]');
    expect(questionRow().status).toBe('pending');
  });

  it('rejects an oversize value, a foreign question, and a plain choice question', async () => {
    await requestSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;

    const oversize = await post(`/api/questions/${requestId}/save-secret`, { value: 'x'.repeat(65_537) });
    expect(oversize.status).toBe(400);
    expect(runCli.mock.calls.filter((call) => call[1][1] === 'set')).toHaveLength(0);

    identityEmail = 'member@example.com';
    const foreign = await post(`/api/questions/${requestId}/save-secret`, { value: VALUE });
    expect(foreign.status).toBe(404);
    expect(await requestSecret('conv-1', { project: 'veneer', config: 'prd' })).toMatchObject({ status: 404 });
    identityEmail = 'owner@example.com';
    expect(questionRow().status).toBe('pending');

    const choiceId = manager.askQuestion('conv-1', 'Which one?', [{ label: 'A', value: 'a' }], false, false);
    const choice = await post(`/api/questions/${choiceId}/save-secret`, { value: VALUE });
    expect(choice.status).toBe(409);
    expect(choice.json.error).toBe('This question does not accept a secret.');

    const missing = await post('/api/questions/does-not-exist/save-secret', { value: VALUE });
    expect(missing.status).toBe(404);
  });
});

describe('Doppler secret role gate', () => {
  const target = { name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd' };

  beforeEach(() => {
    identityEmail = 'member@example.com';
  });

  it('refuses request_secret and reveal_secret in a member\u2019s own chat', async () => {
    const asked = await requestSecret('conv-member', { project: 'veneer', config: 'prd' });
    expect(asked.status).toBe(403);
    expect(asked.json.error).toBe('Administrator access required');
    const reveal = await revealSecret('conv-member', { project: 'veneer', config: 'prd' });
    expect(reveal.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM questions').get()).toEqual({ n: 0 });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('refuses a member saving a secret from a card in their own chat', async () => {
    const requestId = manager.askQuestion('conv-member', 'Need the key.', [], false, true, target);
    const response = await post(`/api/questions/${requestId}/save-secret`, { value: VALUE });
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(VALUE);
    // Nothing was written to Doppler.
    expect(runCli.mock.calls.filter((call) => call[1][1] === 'set')).toHaveLength(0);
    expect(questionRow().status).toBe('pending');
  });

  it('refuses a member revealing a secret value from a card in their own chat', async () => {
    runCli.mockResolvedValue({ stdout: VALUE, stderr: '', code: 0 });
    const requestId = manager.askQuestion(
      'conv-member', 'Show STRIPE_API_KEY?', [], false, true, target, 'reveal',
    );
    const response = await get(`/api/questions/${requestId}/reveal-secret-value`);
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(VALUE);
    expect(questionRow().status).toBe('pending');
  });

  it('keeps the legacy consultant admin role at full access', async () => {
    identityEmail = 'consultant@example.com';
    runCli.mockResolvedValue({ stdout: JSON.stringify(['STRIPE_API_KEY']), stderr: '', code: 0 });
    const asked = await requestSecret('conv-consultant', { project: 'veneer', config: 'prd' });
    expect(asked.status).toBe(200);
  });
});

describe('agent secret reveals', () => {
  it('creates a reveal prompt that carries the target but never a value', async () => {
    runCli.mockResolvedValue({ stdout: JSON.stringify(['STRIPE_API_KEY']), stderr: '', code: 0 });
    const response = await revealSecret('conv-1', { project: 'veneer', config: 'prd' });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: true, name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd' });

    const prompts = JSON.parse(questionRow().questions_json);
    expect(prompts).toEqual([{
      id: 'q1',
      question: 'Show STRIPE_API_KEY on your screen?',
      options: [],
      multi: false,
      allowOther: true,
      kind: 'reveal',
      secret: { name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd', exists: true },
    }]);
    // The stored prompt has no value field of any kind.
    expect(JSON.stringify(prompts)).not.toContain('value');
  });

  it('returns the value to the chat owner, answers "shown", and keeps it out of events', async () => {
    await revealSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;
    runCli.mockResolvedValue({ stdout: `${VALUE}\n`, stderr: '', code: 0 });
    events = [];

    const response = await get(`/api/questions/${requestId}/reveal-secret-value`);
    expect(response.status).toBe(200);
    expect(response.json.value).toBe(VALUE);

    const args = runCli.mock.calls.at(-1)![1];
    expect(args).toEqual([
      'secrets', 'get', 'STRIPE_API_KEY', '--project', 'veneer', '--config', 'prd', '--plain',
    ]);

    const row = questionRow();
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answers_json)).toEqual({ q1: ['shown'] });
    for (const text of [JSON.stringify(row), JSON.stringify(events)]) {
      expect(text).not.toContain(VALUE);
    }
  });

  it('lets an already-shown request be revealed again after a reload', async () => {
    await revealSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;
    runCli.mockResolvedValue({ stdout: VALUE, stderr: '', code: 0 });

    expect((await get(`/api/questions/${requestId}/reveal-secret-value`)).status).toBe(200);
    const second = await get(`/api/questions/${requestId}/reveal-secret-value`);
    expect(second.status).toBe(200);
    expect(second.json.value).toBe(VALUE);
  });

  it('404s a secret that is not in the target config', async () => {
    await revealSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;
    runCli.mockResolvedValue({ stdout: '', stderr: 'Unable to find secret', code: 1 });

    const response = await get(`/api/questions/${requestId}/reveal-secret-value`);
    expect(response.status).toBe(404);
    expect(response.json.error).toContain('STRIPE_API_KEY was not found in veneer / prd');
    expect(questionRow().status).toBe('pending');
  });

  it('records a dismissal without ever reading Doppler', async () => {
    await revealSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;
    runCli.mockReset();

    const response = await post(`/api/questions/${requestId}/dismiss-reveal`, {});
    expect(response.status).toBe(200);
    expect(runCli).not.toHaveBeenCalled();
    const row = questionRow();
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answers_json)).toEqual({ q1: ['dismissed'] });

    // A dismissed request cannot be revealed afterwards.
    expect((await get(`/api/questions/${requestId}/reveal-secret-value`)).status).toBe(409);
  });

  it('hides the value and the question from a user who does not own the chat', async () => {
    await revealSecret('conv-1', { project: 'veneer', config: 'prd' });
    const requestId = questionRow().request_id;
    runCli.mockResolvedValue({ stdout: VALUE, stderr: '', code: 0 });

    identityEmail = 'member@example.com';
    const foreignGet = await get(`/api/questions/${requestId}/reveal-secret-value`);
    expect(foreignGet.status).toBe(404);
    expect(foreignGet.text).not.toContain(VALUE);
    expect((await post(`/api/questions/${requestId}/dismiss-reveal`, {})).status).toBe(404);
    expect((await revealSecret('conv-1', { project: 'veneer', config: 'prd' })).status).toBe(404);

    identityEmail = 'owner@example.com';
    expect(questionRow().status).toBe('pending');
  });

  it('refuses to reveal a plain choice or a request_secret question', async () => {
    const choiceId = manager.askQuestion('conv-1', 'Which one?', [{ label: 'A', value: 'a' }], false, false);
    const choice = await get(`/api/questions/${choiceId}/reveal-secret-value`);
    expect(choice.status).toBe(409);
    expect(choice.json.error).toBe('This question is not a secret reveal.');

    await requestSecret('conv-1', { project: 'veneer', config: 'prd' });
    const secretId = questionRow().request_id;
    expect((await get(`/api/questions/${secretId}/reveal-secret-value`)).status).toBe(409);

    expect((await get('/api/questions/does-not-exist/reveal-secret-value')).status).toBe(404);
  });
});
