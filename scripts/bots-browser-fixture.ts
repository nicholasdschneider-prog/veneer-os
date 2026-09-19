/** Run with Node 24: node --import tsx scripts/bots-browser-fixture.ts.
 * In-memory database and deterministic adapter only. Never reads production state or credentials.
 */
import express from 'express';
import { attachWebSocket } from '../server/src/channels/webSocket.js';
import Database from 'better-sqlite3';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { migrate } from '../server/src/db/migrate.js';
import {
  createBotService,
  proposalSchema,
  type Actor,
} from '../server/src/bots/service.js';
import { createBotsRouter } from '../server/src/bots/routes.js';
import { createConversationManager } from '../server/src/runtime/conversationManager.js';
import { createConversationWakeupScheduler } from '../server/src/scheduled/wakeups.js';
import type { UserRow } from '../server/src/db/db.js';
import type { AppContext } from '../server/src/context.js';
import type { ProviderAdapter } from '../server/src/providers/types.js';
const db = new Database(':memory:');
db.pragma('foreign_keys=ON');
migrate(
  db,
  fileURLToPath(new URL('../server/src/db/migrations', import.meta.url)),
);
db.prepare(
  "INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@example.test','Alex','owner'),(2,'teammate@example.test','Jordan','member')",
).run();
for (const [id, title] of [
  ['atlas', 'Atlas · Operations'],
  ['robin', 'Robin · Content'],
  ['unregistered', 'Another existing chat'],
])
  db.prepare(
    "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')",
  ).run(id, title, `fixture-${id}`);
const s = createBotService(db);
const user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
const human = { user };
s.register(human, 'atlas', 'Atlas', true);
s.register(human, 'robin', 'Robin', true);
const adapter: ProviderAdapter = {
  id: 'claude',
  mintSessionId: () => '',
  readTranscript: async () => [],
  runTurn(spec, onEvent) {
    if (spec.prompt === 'presence fixture') {
      const done = new Promise<void>(resolve => {
        setTimeout(() => onEvent({ type: 'text_delta', text: 'Hello from the fixture' }), 1200);
        setTimeout(() => onEvent({ type: 'text_final', text: 'Hello from the fixture' }), 4500);
        setTimeout(() => { onEvent({ type: 'turn_done', turnId: spec.turnId }); resolve(); }, 5500);
      });
      return { done, kill: () => {}, respondToApproval: () => true };
    }
    const done = new Promise<void>((resolve) =>
      setTimeout(() => {
        const match = spec.prompt.match(
          /Decision ([\w-]+), proposal version (\d+)/,
        );
        if (match) {
          const id = match[1]!;
          const version = Number(match[2]);
          const actor: Actor = { user, conversationId: spec.conversationId };
          const d = s.read(actor, id);
          if (
            spec.prompt.includes('VeneerBots answer') &&
            JSON.parse(d.answer_json ?? '{}').action === 'approve'
          ) {
            s.result(actor, id, version, `start-${version}`, {
              state: 'running',
              evidence: 'Internal fixture evidence rechecked',
              material_evidence_unchanged: true,
            });
            s.result(actor, id, version, `done-${version}`, {
              state: 'verified_completed',
              evidence: 'Internal draft verified. No external action taken.',
            });
          } else
            s.reply(
              actor,
              id,
              `reply-${spec.turnId}`,
              'The recommendation uses the reviewed internal draft. This discussion does not authorize any external action.',
            );
        }
        onEvent({ type: 'turn_done', turnId: spec.turnId });
        resolve();
      }, 800),
    );
    return { done, kill: () => {}, respondToApproval: () => true };
  },
};
const manager = createConversationManager({
  db,
  adapters: { claude: adapter },
  resolveWorkspace: () => ({
    workspaceDir: '/tmp',
    assistantSlug: 'assistant',
    elevated: false,
    fullAccess: false,
  }),
});
const scheduler = createConversationWakeupScheduler({ db, manager });
const questions = [
  [
    'atlas',
    'Which internal rollout checklist should we use?',
    'Use the shorter checklist with a separate verification step.',
  ],
  [
    'atlas',
    'Who should review the next operations draft?',
    'Ask Jordan to review the internal draft before we publish.',
  ],
  [
    'atlas',
    'Can we close the duplicate internal task?',
    'Keep the original task and close the duplicate after review.',
  ],
  [
    'robin',
    'Which welcome note reads more clearly?',
    'Use version A, with the shorter opening paragraph.',
  ],
  [
    'robin',
    'Should the internal guide include a glossary?',
    'Add a short glossary for the five recurring terms.',
  ],
  [
    'robin',
    'Is the Friday draft ready for review?',
    'Share the internal preview with the assigned reviewer.',
  ],
];
for (const [i, [id, question, recommendation]] of questions.entries())
  s.raise(
    { user, conversationId: id },
    {
      source_key: `fixture-${i}`,
      proposal_key: 'draft',
      proposal: proposalSchema.parse({
        question,
        recommendation,
        consequence: 'Internal review only · No customer or financial action',
        assignee_id: i === 5 ? 2 : 1,
        team: 'Workspace team',
        deadline:
          i === 0 ? new Date(Date.now() + 86400000).toISOString() : null,
        evidence: [
          { label: 'Original task and working notes', conversation_id: id },
        ],
        blocked_action: 'Finalize the internal draft',
        blocks_scope: 'task',
      }),
    },
  );
const failed = s.raise(
  { user, conversationId: 'robin' },
  {
    source_key: 'fixture-failed',
    proposal_key: 'draft',
    proposal: proposalSchema.parse({
      question: 'Generate the internal preview',
      recommendation: 'Render the reviewed draft.',
      consequence: 'Internal fixture',
      assignee_id: 1,
      blocked_action: 'Generate preview',
    }),
  },
);
s.answer(human, failed.id, 1, 'answer', {
  action: 'approve',
  text: 'Generate the internal preview only.',
  scope: 'this_case',
});
s.result({ user, conversationId: 'robin' }, failed.id, 1, 'failed', {
  state: 'failed',
  evidence:
    'The internal fixture renderer is unavailable. No work was marked complete.',
});
db.prepare("UPDATE conversation_wakeups SET status='cancelled'").run();
db.prepare(
  "UPDATE bot_decisions SET created_at=datetime('now','-5 hours')",
).run();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = user;
  next();
});
app.use(
  '/api/bots',
  createBotsRouter({
    db,
    manager: {
      statusOf: async (id: string) =>
        id === 'atlas' ? 'working' : manager.statusOf(id),
    },
  } as unknown as AppContext),
);
app.post('/fixture/presence', (_req, res) => {
  const chat = db.prepare("SELECT * FROM conversations WHERE id='robin'").get() as import('../server/src/db/db.js').ConversationRow;
  manager.postMessage(chat, 'presence fixture', 1);
  res.json({ ok: true });
});
app.get('/api/conversations/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id) as import('../server/src/db/db.js').ConversationRow;
  res.json({ conversation: { id: c.id, title: c.title, assistantSlug: 'assistant', assistantName: 'Fixture bot', provider: 'claude', model: null, effort: null, approvalMode: null, effectiveApprovalMode: 'default', fullAccess: false, archived: false, pinOrder: null, creator: { id: 1, displayName: 'Alex' }, visibility: 'team', canSend: true, canManage: true, canChangeVisibility: true, projectId: null, contextTokens: null, automation: null } });
});
app.get('/api/client-logo', (_req, res) => res.status(404).end());
app.get('/api/system/usage', (_req, res) =>
  res.json({
    usage: {
      cpuPercent: 4,
      memoryUsedBytes: 8000000000,
      memoryTotalBytes: 32000000000,
    },
  }),
);
app.use('/api', (_req, res) =>
  res.json({
    providers: { claude: { connected: false }, codex: { connected: false } },
    ok: true, scopes: [], builtins: [], models: [], projects: [], assistants: [], files: [], artifacts: [], settings: {}, prefs: {},
  }),
);
const vite = await createServer({
  root: fileURLToPath(new URL('../web', import.meta.url)),
  server: { middlewareMode: true, hmr: { port: 3298, host: '127.0.0.1' } },
  appType: 'custom',
});
app.use(vite.middlewares);
app.get('/', async (_req, res) =>
  res
    .type('html')
    .send(
      await vite.transformIndexHtml(
        '/',
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>VeneerBots internal fixture</title></head><body><div id="root"></div><script type="module" src="/test/bots-browser.tsx"></script></body></html>`,
      ),
    ),
);
const server = app.listen(3297, '127.0.0.1', () =>
  console.log('Isolated VeneerBots fixture ready on port 3297'),
);
attachWebSocket(server, { db, resolveIdentity: async () => ({ email: user.email }), manager: {
  bus: manager.bus, statusOf: async (id: string) => id === 'atlas' ? 'working' : manager.statusOf(id),
  activityOf: async () => null, snapshot: async (id: string) => manager.snapshot(db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as import('../server/src/db/db.js').ConversationRow),
  queueSnapshot: async () => ({ revision: 0, messages: [], failedTurn: null }), listWakeups: async () => [],
} } as unknown as AppContext);
scheduler.start();
process.on('SIGTERM', () => {
  scheduler.stop();
  manager.shutdown();
  server.close();
  void vite.close();
});
