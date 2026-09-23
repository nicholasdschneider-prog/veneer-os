import Database from 'better-sqlite3';
import express from 'express';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { migrate } from '../src/db/migrate.js';
import {
  communicationService,
  communicationWakeAllowed,
  communicationWakeCancelled,
  draftPayload,
} from '../src/bots/communication.js';
import {
  createBotService,
  proposalSchema,
  type Actor,
} from '../src/bots/service.js';
import { createCommunicationRouter } from '../src/bots/communicationRoutes.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';
import type { AppContext } from '../src/context.js';
import type { UserRow, ConversationWakeupRow } from '../src/db/db.js';

describe('reviewable bot communication', () => {
  let db: Database.Database,
    s: ReturnType<typeof communicationService>,
    bots: ReturnType<typeof createBotService>,
    human: Actor,
    bot: Actor,
    other: Actor,
    server: Server | undefined;
  const payload = draftPayload.parse({
    channel: 'sms',
    account: 'OrderOps support',
    recipients: ['+15555550123'],
    body: 'Your replacement is ready for review.',
    customer: 'Fixture Customer',
    ticket: 'fixture-ticket',
  });
  const proposal = proposalSchema.parse({
    question: 'Approve replacement?',
    recommendation: 'Review the replacement.',
    consequence: 'No refund authorized.',
    assignee_id: 1,
    blocked_action: 'Replacement approval only.',
  });
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(
      db,
      fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    );
    for (const i of [1, 2])
      db.prepare(
        "INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'owner')",
      ).run(i, `fixture${i}@example.test`, `Person ${i}`);
    for (const i of [1, 2])
      db.prepare(
        "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,?,?,'claude',?,'private')",
      ).run(`c${i}`, i, `Chat ${i}`, `native-${i}`);
    human = {
      user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow,
    };
    other = {
      user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow,
    };
    bot = { ...human, conversationId: 'c1' };
    s = communicationService(db);
    bots = createBotService(db);
    bots.register(human, 'c1', 'Fixture', true);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    db.close();
  });
  it('limits central CS presentation and rejection to explicitly opted-in lane; never mutates drafts',()=>{
    const business='5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86';
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES(?,'Fixture CS',1)").run(business);
    db.prepare("UPDATE conversations SET business_team_id=? WHERE id='c1'").run(business);
    db.prepare("INSERT INTO shared_bot_queues(conversation_id) VALUES('c1')").run();
    db.prepare("INSERT INTO nonexclusive_bot_queues(conversation_id,business_id) VALUES('c1',?)").run(business);
    const d=s.saveDraft(bot,'c1','cs',payload);
    expect(s.list(human,'c1').drafts[0]?.cs_lifecycle).toMatchObject({state:'blocked',execute:false});
    expect(()=>s.mutateDraft(human,d.id,d.version,'send')).toThrow('central');
    expect(s.readDraft(bot,d.id)).toMatchObject({state:'draft',authorized_by:null,claim_key:null});
    expect(()=>s.list(other,'c1')).toThrow();
    db.prepare("DELETE FROM nonexclusive_bot_queues WHERE conversation_id='c1'").run();
    expect(s.list(human,'c1').drafts[0]?.cs_lifecycle).toBeNull();
    expect(s.mutateDraft(human,d.id,d.version,'send').state).toBe('queued');
  });
  it('saves edits then queues one exact message, keeping business approval separate', () => {
    const d = bots.raise(bot, {
      source_key: 'case',
      proposal_key: 'replacement',
      proposal,
    });
    const draft = s.saveDraft(bot, 'c1', 'draft1', payload, d.id, d.version);
    expect(s.saveDraft(bot, 'c1', 'draft1', payload, d.id, d.version).id).toBe(
      draft.id,
    );
    expect(() =>
      s.saveDraft(
        bot,
        'c1',
        'draft1',
        { ...payload, body: 'changed' },
        d.id,
        d.version,
      ),
    ).toThrow('different draft');
    const edited = s.mutateDraft(human, draft.id, 1, 'save', {
      ...payload,
      body: 'Please confirm your preferred option.',
    });
    expect(() => s.mutateDraft(human, draft.id, 1, 'send')).toThrow('changed');
    s.mutateDraft(human, draft.id, edited.version, 'send');
    expect(bots.read(human, d.id).state).toBe('needs_input');
    expect(() =>
      s.mutateDraft(human, draft.id, edited.version, 'send'),
    ).toThrow();
    expect(
      db.prepare('SELECT count(*) AS n FROM conversation_wakeups').get(),
    ).toEqual({ n: 1 });
    const claim = s.claim(bot, draft.id, 'claim1');
    expect(claim.execute).toBe(true);
    expect(claim.payload.body).toBe('Please confirm your preferred option.');
    expect(s.claim(bot, draft.id, 'claim1').execute).toBe(false);
    expect(() => s.claim(bot, draft.id, 'different')).toThrow(
      'already claimed',
    );
    s.receipt(
      bot,
      draft.id,
      'claim1',
      'uncertain',
      'Source request timed out; reconciliation required.',
    );
    expect(() => s.claim(bot, draft.id, 'claim2')).toThrow();
    expect(
      s.receipt(bot, draft.id, 'claim1', 'sent', 'Provider receipt fixture-123')
        .state,
    ).toBe('sent');
    expect(
      s.receipt(bot, draft.id, 'claim1', 'sent', 'Provider receipt fixture-123')
        .state,
    ).toBe('sent');
    expect(() => s.receipt(bot, draft.id, 'claim1', 'failed', 'Other')).toThrow(
      'closed',
    );
  });
  it('rejects stale proposal drafts and audio, including changes after send authorization', () => {
    const d = bots.raise(bot, {
      source_key: 'case',
      proposal_key: 'replacement',
      proposal,
    });
    const draft = s.saveDraft(bot, 'c1', 'draft', payload, d.id, d.version);
    const b = s.saveBriefing(
      bot,
      'c1',
      'brief',
      'The customer needs a replacement. Please review the proposed next step.',
      d.id,
      d.version,
    );
    s.mutateDraft(human, draft.id, 1, 'send');
    bots.revise(bot, d.id, d.version, 'revise', {
      ...proposal,
      consequence: 'New evidence requires review.',
    });
    expect(() => s.claim(bot, draft.id, 'claim')).toThrow('proposal changed');
    expect(() => s.briefing(human, b.id)).toThrow('proposal changed');
    expect(s.list(human, 'c1').briefings).toHaveLength(0);
    expect(s.list(human, 'c1').drafts[0]!.stale).toBe(true);
  });
  it('enforces owning bot, human send authority and revoked access', () => {
    const d = s.saveDraft(bot, 'c1', 'draft', payload);
    expect(() => s.readDraft(other, d.id)).toThrow();
    expect(() => s.mutateDraft(bot, d.id, 1, 'send')).toThrow('human');
    s.mutateDraft(human, d.id, 1, 'send');
    expect(() =>
      s.claim({ ...human, conversationId: 'c2' }, d.id, 'x'),
    ).toThrow();
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    expect(() => s.claim(bot, d.id, 'x')).toThrow();
  });
  it('discards without waking and returns for revision without send permission', () => {
    const a = s.saveDraft(bot, 'c1', 'a', payload),
      b = s.saveDraft(bot, 'c1', 'b', payload);
    s.mutateDraft(human, a.id, 1, 'discard');
    expect(
      db.prepare('SELECT count(*) AS n FROM conversation_wakeups').get(),
    ).toEqual({ n: 0 });
    s.mutateDraft(human, b.id, 1, 'revise');
    expect(() => s.claim(bot, b.id, 'x')).toThrow();
  });
  async function api(markdown = 'Fixture result') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = human.user;
      next();
    });
    app.use(
      '/api',
      createCommunicationRouter({
        db,
        manager: {
          snapshot: async () => [
            {
              type: 'text_final',
              turnId: 'turn',
              at: '2026-09-23T01:00:00Z',
              markdown,
            },
          ],
        },
        doppler: { get: () => 'fixture-key' },
      } as unknown as AppContext),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.on('listening', r));
    const address = server.address() as { port: number };
    return async (path: string, body?: unknown, headers?: Record<string, string>) => {
      const r = await fetch(
        `http://127.0.0.1:${address.port}/api${path}`,
        body
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : { headers },
      );
      return { status: r.status, data: r.headers.get('content-type')?.includes('application/json') ? await r.json() : await r.text() };
    };
  }
  it('reads only real authorized messages, caches sections and rechecks access on playback', async () => {
    const call = await api('Long message. '.repeat(500));
    const original = globalThis.fetch;
    const speech = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).startsWith('https://api.openai.com/')) return original(url, init);
      const body = JSON.parse(String(init?.body));
      expect(body.input.length).toBeLessThanOrEqual(2800);
      return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } });
    });
    vi.stubGlobal('fetch', speech);
    const anchor = { turn: 'turn', at: '2026-09-23T01:00:00Z' };
    expect((await call('/chats/c2/listen', anchor)).status).toBe(404);
    expect((await call('/chats/c1/listen', { ...anchor, turn: 'invented' })).status).toBe(404);
    expect((await call('/chats/c1/listen', { ...anchor, text: 'Injected' })).status).toBe(400);
    const first = await call('/chats/c1/listen', anchor);
    expect(first.status).toBe(200);
    expect(first.data.parts).toBeGreaterThan(1);
    expect((await call('/chats/c1/listen', anchor)).data.id).toBe(first.data.id);
    const path = `/message-audio/${first.data.id}/0`;
    expect((await call(path)).status).toBe(404);
    const [a, b] = await Promise.all([call(path, {}), call(path, {})]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect((await call(path)).status).toBe(200);
    const range = await call(path, undefined, { Range: 'bytes=1-2' });
    expect(range.status).toBe(206);
    expect(range.data).toBe('D3');
    expect((await call(path, undefined, { Range: 'bytes=100-200' })).status).toBe(416);
    await call(path, {});
    expect(speech.mock.calls.filter(([url]) => String(url).startsWith('https://api.openai.com/'))).toHaveLength(1);
    expect((await call(`/message-audio/${first.data.id}/999`, {})).status).toBe(400);
    // Read-only archived messages still support listening.
    db.prepare('UPDATE conversations SET archived=1 WHERE id=?').run('c1');
    expect((await call('/chats/c1/listen', anchor)).status).toBe(200);
    human = other;
    expect((await call(path)).status).toBe(404);
    expect((await call(path, {})).status).toBe(404);
    expect(employeeRouteAllowed('POST', '/bot-communication/chats/c1/listen')).toBe(true);
    expect(employeeRouteAllowed('GET', `/bot-communication${path}`)).toBe(true);
    expect(employeeRouteAllowed('POST', `/bot-communication${path}`)).toBe(true);
  });
  it('anchors threads to real messages, persists replies/reactions and tracks unread without granting approval', async () => {
    const call = await api();
    expect(
      (await call('/chats/c1/threads', { turn: 'fake', at: 'fake' })).status,
    ).toBe(404);
    const t = (
      await call('/chats/c1/threads', {
        turn: 'turn',
        at: '2026-09-23T01:00:00Z',
      })
    ).data;
    const reply = { request_key: 'r', text: 'Please explain the exception.' };
    await call(`/threads/${t.id}/replies`, reply);
    await call(`/threads/${t.id}/replies`, reply);
    expect((await call(`/threads/${t.id}`)).data.messages).toHaveLength(1);
    expect(
      (await call(`/threads/${t.id}/replies`, { ...reply, text: 'different' }))
        .status,
    ).toBe(409);
    await call(`/threads/${t.id}/reactions`, { emoji: '👍', active: true });
    await call(`/threads/${t.id}/reactions`, { emoji: '👍', active: true });
    expect((await call(`/threads/${t.id}`)).data.reactions[0].count).toBe(1);
    expect((await call('/chats/c1/threads')).data.threads[0].reactions).toEqual([{emoji:'👍',count:1,mine:1}]);
    expect(db.prepare('SELECT count(*) AS n FROM bot_decisions').get()).toEqual(
      { n: 0 },
    );
    expect(
      db.prepare('SELECT count(*) AS n FROM conversation_wakeups').get(),
    ).toEqual({ n: 1 });
    db.prepare(
      'INSERT INTO bot_message_replies(id,thread_id,actor_id,actor_conversation_id,text,request_key) VALUES(?,?,1,?,?,?)',
    ).run('botreply', t.id, 'c1', 'Explanation', 'b');
    // Same account bots still count as unread for the human.
    expect((await call('/chats/c1/threads')).data.threads[0].count).toBe(2);
    expect((await call('/chats/c1/threads')).data.threads[0].unread).toBe(1);
    const latest = (await call(`/threads/${t.id}`)).data.messages.at(-1).seq;
    await call(`/threads/${t.id}/seen`, { seq: latest });
    expect((await call('/chats/c1/threads')).data.threads[0].unread).toBe(0);
    expect(
      employeeRouteAllowed('GET', '/bot-communication/threads/' + t.id),
    ).toBe(true);
    expect(
      employeeRouteAllowed('POST', '/bot-communication/drafts/x/claim'),
    ).toBe(false);
  });
  it('serves saved audio only while authorized and on the current version', async () => {
    const call = await api();
    const d = bots.raise(bot, {
      source_key: 'case',
      proposal_key: 'replacement',
      proposal,
    });
    const b = s.saveBriefing(
      bot,
      'c1',
      'brief',
      'The customer needs a replacement. Please review the proposed next step.',
      d.id,
      1,
    );
    db.prepare('UPDATE bot_voice_briefings SET audio=? WHERE id=?').run(
      Buffer.from('fixture audio'),
      b.id,
    );
    expect((await call(`/briefings/${b.id}/audio`, {})).status).toBe(200);
    bots.revise(bot, d.id, 1, 'revision', {
      ...proposal,
      recommendation: 'Investigate first.',
    });
    expect((await call(`/briefings/${b.id}/audio`, {})).status).toBe(409);
  });
  it('coalesces speech generation, retains the transcript and caches audio across requests', async () => {
    const call = await api();
    const d = bots.raise(bot, {
      source_key: 'case',
      proposal_key: 'replacement',
      proposal,
    });
    const original = globalThis.fetch;
    const provider = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (!String(url).startsWith('https://api.openai.com/'))
          return original(url, init);
        if (String(url).endsWith('chat/completions'))
          return Response.json({
            choices: [
              {
                message: {
                  content:
                    'The customer needs help. Review the replacement proposal. No refund is authorized. Please decide whether to approve the next step.',
                },
              },
            ],
          });
        return new Response(new Uint8Array([73, 68, 51]), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      },
    );
    vi.stubGlobal('fetch', provider);
    const [a, b] = await Promise.all([
      call(`/decisions/${d.id}/briefing`, { expected_version: 1 }),
      call(`/decisions/${d.id}/briefing`, { expected_version: 1 }),
    ]);
    expect(a.status).toBe(200);
    expect(a.data.id).toBe(b.data.id);
    await Promise.all([
      call(`/briefings/${a.data.id}/audio`, {}),
      call(`/briefings/${a.data.id}/audio`, {}),
    ]);
    await call(`/briefings/${a.data.id}/audio`, {});
    expect(
      provider.mock.calls.filter(([url]) =>
        String(url).startsWith('https://api.openai.com/'),
      ),
    ).toHaveLength(2);
    expect(
      (
        db
          .prepare('SELECT audio FROM bot_voice_briefings WHERE id=?')
          .get(a.data.id) as { audio: Buffer }
      ).audio.length,
    ).toBe(3);
  });
  it('does not cache audio when the proposal changes during generation', async () => {
    const call = await api();
    const d = bots.raise(bot, {
      source_key: 'case',
      proposal_key: 'replacement',
      proposal,
    });
    const b = s.saveBriefing(
      bot,
      'c1',
      'b',
      'Please review this replacement. No refund is authorized.',
      d.id,
      1,
    );
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (!String(url).startsWith('https://api.openai.com/'))
          return original(url, init);
        bots.revise(bot, d.id, 1, 'change', {
          ...proposal,
          consequence: 'New evidence, do not proceed.',
        });
        return new Response(new Uint8Array([73, 68, 51]));
      },
    );
    expect((await call(`/briefings/${b.id}/audio`, {})).status).toBe(409);
    expect(
      db.prepare('SELECT audio FROM bot_voice_briefings WHERE id=?').get(b.id),
    ).toEqual({ audio: null });
  });
  it('dispatches employee-authorized messages through the permanent bot and cancels revoked authorization', () => {
    db.prepare(
      "UPDATE conversations SET visibility='team' WHERE id='c1'",
    ).run();
    const d = s.saveDraft(bot, 'c1', 'employee-draft', payload);
    s.mutateDraft(other, d.id, 1, 'send');
    const wake = db
      .prepare('SELECT * FROM conversation_wakeups')
      .get() as ConversationWakeupRow;
    expect(wake.actor_user_id).toBe(1);
    expect(communicationWakeAllowed(db, wake)).toBe(true);
    db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();
    expect(communicationWakeAllowed(db, wake)).toBe(false);
    communicationWakeCancelled(db, wake);
    expect(s.readDraft(human, d.id).state).toBe('failed');
    expect(() => s.claim(bot, d.id, 'claim')).toThrow();
  });
});
