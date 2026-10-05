// Installed-module acceptance only: fresh synthetic DB and in-process provider.
// No live database, provider subscription, credential, portal or purchasing task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from '../server/dist/db/db.js';
import { createBotEventsWebhook } from '../server/dist/botWorkflows/routes.js';
import { recordPurchasePass } from '../server/dist/botWorkflows/purchaseEvents.js';
import { createConversationManager } from '../server/dist/runtime/conversationManager.js';
import { createScheduledTaskScheduler } from '../server/dist/scheduled/scheduler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureId = crypto.randomUUID();
const directory = path.join(root, 'out/build585', fixtureId);
const output = path.join(root, 'docs/reports/build585', `startup-${fixtureId}.json`);
const db = openDb(directory);
const source = crypto.randomUUID(), task = crypto.randomUUID(), project = crypto.randomUUID(), team = crypto.randomUUID();
const owner = 1;
db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@example.test','Synthetic fixture','owner')").run();
db.prepare("INSERT INTO projects(id,slug,name) VALUES(?,'fixture','Synthetic fixture')").run(project);
db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES(?,'Synthetic fixture',1)").run(team);
db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES(?,?,1,'Synthetic fixture')").run(source, team);
db.prepare(`INSERT INTO scheduled_tasks(id,user_id,assistant_id,project_id,name,prompt,schedule_json,timezone,provider,model,enabled,next_run_at) VALUES(?,1,1,?,'Synthetic fixture','Synthetic finite read-only queue pass; no business effects','{"type":"daily","time":"09:00"}','UTC','claude','synthetic-fixture',1,NULL)`).run(task, project);
db.prepare('INSERT INTO purchase_event_bindings VALUES(?,?,?,1,?)').run(source, task, team, project);

let invocation, finish, acknowledgment;
let invocations = 0;
const adapter = {
  id: 'claude', mintSessionId: () => crypto.randomUUID(), readTranscript: async () => [],
  runTurn(spec, onEvent) {
    invocations++;
    // Capture actual native manager invocation, never fabricate a start event.
    invocation = {conversation_id: spec.conversationId, turn_id: spec.turnId, native_session_id: spec.nativeSessionId, cwd: spec.cwd, model: spec.model, prompt: spec.prompt};
    let resolve;
    const done = new Promise(r => { resolve = r; });
    finish = () => {
      // Exact fixture worker identity from this real invocation and its owner.
      // This acknowledgment is its final task action; then the provider ends.
      acknowledgment = recordPurchasePass(db, spec.conversationId, owner, {outcome: 'clear', cursor: null});
      onEvent({type: 'turn_done', turnId: spec.turnId, outcome: 'completed'});
      resolve();
    };
    return {done, kill: () => resolve(), respondToApproval: () => true};
  },
};
const manager = createConversationManager({db, adapters: {claude: adapter}, resolveWorkspace: () => ({workspaceDir: directory, assistantSlug: 'synthetic-fixture', elevated: false, fullAccess: false})});
const scheduler = createScheduledTaskScheduler({db, manager});
const key = crypto.randomBytes(32); // Ephemeral synthetic key, never retained.
const app = express();
app.use('/webhooks/bot-events', createBotEventsWebhook({db, secrets: {getApiKeyOverride: id => id === `bot-event-source-${source}` ? key : null}}));
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const payload = {schema_version: 'lippert.purchase_candidate/v1', type: 'order.purchase_candidate', id: crypto.randomUUID(), task_id: task, order_id: crypto.randomUUID(), order_revision: 'a'.repeat(64), occurred_at: new Date().toISOString()};
const pathname = '/webhooks/bot-events/' + source;
const getPath = pathname + '/purchase-events/' + payload.id;
const headers = bytes => {
  const stamp = String(Math.floor(Date.now()/1000));
  return {'content-type': 'application/json', 'x-veneer-timestamp': stamp, 'x-veneer-signature': crypto.createHmac('sha256', key).update(stamp + bytes).digest('hex')};
};
const read = async () => {
  const response = await fetch(base + getPath, {headers: headers('.GET.' + getPath)});
  assert.equal(response.status, 200);
  return response.json();
};
const waitFor = async condition => {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('Synthetic native startup/completion timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};
try {
  const body = JSON.stringify(payload);
  const post = await fetch(base + pathname, {method: 'POST', headers: headers('.' + body), body});
  assert.equal(post.status, 200);
  const intake = await post.json();
  const pending = await read();
  assert.deepEqual(pending.receipt, intake.accepted);
  assert.equal(pending.delivery.worker_started, false);
  assert.equal(db.prepare('SELECT count(*) n FROM purchase_worker_starts').get().n, 0);
  scheduler.tick(); // Actual scheduler dispatch into actual native manager.
  await waitFor(() => invocations === 1);
  const started = await read(); // Provider is still blocked, cannot complete yet.
  const run = db.prepare('SELECT * FROM scheduled_task_runs WHERE scheduled_task_id=?').get(task);
  const batch = db.prepare('SELECT * FROM purchase_event_batches WHERE run_id=?').get(run.id);
  const start = db.prepare('SELECT * FROM purchase_worker_starts WHERE run_id=?').get(run.id);
  const pendingTurn = db.prepare('SELECT * FROM pending_turns WHERE conversation_id=?').get(run.conversation_id);
  assert.equal(run.status, 'running');
  assert.equal(batch.id, started.delivery.batch_id);
  assert.equal(batch.run_id, run.id);
  assert.equal(start.run_id, run.id);
  assert.equal(start.conversation_id, invocation.conversation_id);
  assert.equal(start.turn_id, invocation.turn_id);
  assert.equal(pendingTurn.conversation_id, invocation.conversation_id);
  assert.equal(pendingTurn.actor_user_id, owner);
  assert.equal(pendingTurn.status, 'pending');
  assert.equal(started.delivery.run_id, run.id);
  assert.equal(started.delivery.conversation_id, invocation.conversation_id);
  assert.equal(started.delivery.turn_id, invocation.turn_id);
  assert.equal(started.delivery.worker_started_at, start.started_at);
  assert.equal(started.delivery.worker_started, true);
  assert.deepEqual(started.receipt, intake.accepted);
  assert.ok(invocation.prompt.includes(payload.id) && invocation.prompt.includes(payload.order_id));
  assert.ok(invocation.prompt.includes('grounded per-order cost/address/decision exceptions'));
  assert.throws(() => recordPurchasePass(db, invocation.conversation_id, owner + 1, {outcome: 'clear'}));
  assert.throws(() => db.prepare('UPDATE purchase_event_receipts SET payload_hash=?').run('synthetic-tamper'));
  const invalid = await fetch(base + getPath, {headers: {'x-veneer-timestamp': String(Math.floor(Date.now()/1000)), 'x-veneer-signature': '0'.repeat(64)}});
  assert.equal(invalid.status, 401);
  finish(); // Exact-worker final clear acknowledgment then synthetic completion.
  await waitFor(() => db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(run.id).status === 'completed');
  const completed = await read();
  const pass = db.prepare('SELECT * FROM purchase_worker_passes WHERE run_id=?').get(run.id);
  assert.equal(pass.conversation_id, invocation.conversation_id);
  assert.equal(pass.outcome, 'clear');
  assert.equal(pass.cursor, null);
  assert.equal(completed.delivery.run_status, 'completed');
  assert.deepEqual(completed.receipt, intake.accepted);
  for (const response of [pending, started, completed]) {
    assert.equal(response.receipt.purchase_authority, false);
    assert.equal(response.delivery.purchase_authority, false);
  }
  assert.equal(acknowledgment.purchase_authority, false);
  scheduler.tick();
  assert.equal(invocations, 1);
  const files = ['db/db.js','botWorkflows/routes.js','botWorkflows/purchaseEvents.js','scheduled/scheduler.js','runtime/conversationManager.js'];
  const evidence = {at: new Date().toISOString(), fixture_id: fixtureId, fixture_directory: directory, identity: {source, task, project, team, owner}, installed_modules: files.map(file => ({file: 'server/dist/' + file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'server/dist', file))).digest('hex')})), post_status: post.status, invalid_signature_status: invalid.status, intake, pending, started, completed, run_before_completion: run, batch, persisted_start: start, pending_turn_association: {conversation_id: pendingTurn.conversation_id, actor_user_id: pendingTurn.actor_user_id, status: pendingTurn.status}, invocation, provider_invocations: invocations, acknowledgment, persisted_pass: pass, manually_emitted_start: false, preinserted_start: false, live_database_opened: false, live_task_run: false, real_provider_invoked: false, public_auth_verified: false, original_worker_adoption_verified: false, source_activation_performed: false};
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({evidence: output, fixture_directory: directory, worker_started: true, run_id: run.id, conversation_id: start.conversation_id, turn_id: start.turn_id, completed: true}));
} finally {
  scheduler.stop(); manager.shutdown();
  await new Promise(r => setImmediate(r));
  await new Promise(r => server.close(r));
  db.close(); key.fill(0);
}
