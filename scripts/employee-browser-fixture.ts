// Isolated UI verification only: in-memory DB, no credentials, provider calls or customer actions.
import express from 'express';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { migrate } from '../server/src/db/migrate.js';
import { createApiRouter } from '../server/src/routes/api.js';
import { createTeamService } from '../server/src/bots/teams.js';
import { createBotService, proposalSchema } from '../server/src/bots/service.js';
import type { UserRow } from '../server/src/db/db.js';
import type { AppContext } from '../server/src/context.js';
const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
migrate(db, fileURLToPath(new URL('../server/src/db/migrations', import.meta.url)));
db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Nicholas','owner'),(2,'ali@fixture.test','Ali','member')").run();
const human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
const bots = createBotService(db), teams = createTeamService(db);
for (const name of ['Henry', 'Grant', 'Nora', 'Miles', 'Tess', 'Owen', 'Avery', 'Development']) {
  const id = name.toLowerCase();
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'codex',?,'team')").run(id, `${name} · ${id === 'grant' ? 'Customer Service Lead' : 'Fixture'}`, `fixture-${id}`);
  bots.register(human, id, name, true);
}
const team = teams.manage(human, { action: 'create', name: 'ERVP fixture' });
const p = teams.bulk(human, { mode: 'preview', team_id: team.id, request_key: 'enroll', bots: [
  { conversation_id: 'henry', name: 'Henry', role: 'coordinator' },
  { conversation_id: 'grant', name: 'Grant', role: 'lead', subteam: 'Customer Service' },
  ...['Nora','Miles','Tess','Owen','Avery'].map(name => ({ conversation_id: name.toLowerCase(), name, role: 'bot', subteam: 'Customer Service', reports_to: 'grant' })),
] });
teams.bulk(human, { mode: 'apply', team_id: team.id, preview_id: p.preview_id });
teams.manage(human, { action: 'employee', team_id: team.id, user_id: 2, email: 'ali@fixture.test', conversation_ids: ['grant','nora','miles','tess','owen','avery'], activate: true });
const ids: Record<string,string> = {};
for (const id of ['grant', 'nora', 'development']) ids[id] = bots.raise({ ...human, conversationId: id }, { source_key: id, proposal_key: 'case', proposal: proposalSchema.parse({ question: id === 'development' ? 'Private development question' : `Confirm the ${id} case details?`, recommendation: 'Use the customer information supplied in this case.', consequence: 'Internal fixture only · No customer action', assignee_id: 1, blocked_action: 'Prepare the response', evidence: [{ label: 'Case context', conversation_id: id }] }) }).id;
const app = express();
const ctx = { db, resolveIdentity: async (req: { headers: Record<string, unknown> }) => ({ email: req.headers['x-fixture-user'] === 'owner' ? 'owner@fixture.test' : 'ali@fixture.test' }), manager: {
  bus: new EventEmitter(), statusOf: async () => 'idle', snapshot: async () => [ { type: 'turn_started', turnId: 'fixture-turn', role: 'user', text: 'Please review this customer case.', at: new Date().toISOString(), via: 'web' }, { type: 'text_final', turnId: 'fixture-turn', markdown: 'The case is ready for your review.', at: new Date().toISOString() } ],
  postMessage: async () => ({ ok: true }),
} } as unknown as AppContext;
app.get('/fixture/ids', (_req, res) => res.json(ids));
app.use('/api', createApiRouter(ctx));
const vite = await createServer({ root: fileURLToPath(new URL('../web', import.meta.url)), server: { middlewareMode: true, hmr: { port: 3296, host: '127.0.0.1' } }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/', async (_req, res) => res.type('html').send(await vite.transformIndexHtml('/', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Employee workspace fixture</title></head><body><div id="root"></div><script type="module" src="/test/employee-browser.tsx"></script></body></html>')));
const server = app.listen(3295, '127.0.0.1', () => console.log('Isolated employee fixture ready on port 3295'));
process.on('SIGTERM', () => { server.close(); void vite.close(); db.close(); });
