import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { BotError, createBotService, type Actor, type Decision } from '../bots/service.js';
import { readDecisionImage } from '../bots/decisionImages.js';
import { readDecisionEvidence, readEvidenceBytes, retainEvidenceBytes } from '../bots/decisionEvidence.js';
import { createCsTicketService, presentMessage, type CsTicketMessageRow } from '../csTickets/service.js';
import { attachmentPath } from '../csTickets/poll.js';
import { createTaskService } from '../tasks/service.js';
import { jamesAuth } from '../jamesLink/routes.js';
import { idempotency } from '../jamesLink/idempotency.js';
import { buildCard, ownerId, verifyFileToken, BROCK_KEYS, type BrockRelay, type FileClaims } from './relay.js';
import { redactDopplerError, setDopplerSecret } from '../secrets/doppler.js';

/** Writes one secret to the connected Doppler config (main/prd) and refreshes the in-memory snapshot. */
export type DopplerWriter = (pairs: { name: string; value: string }[]) => Promise<void>;
export function contextDopplerWriter(ctx: AppContext): DopplerWriter {
  return async (pairs) => {
    const token = ctx.dopplerTokens.get().agentToken;
    if (!token) throw new BotError(409, 'Doppler is not connected');
    for (const p of pairs) await setDopplerSecret(token, p.name, p.value);
    await ctx.doppler.refresh();
  };
}

export interface AttachmentMirror { fetchAttachment(reference: string): Promise<{ type: string; bytes: Buffer } | { error: string; status: number }> }

const AnswerBody = z.object({
  card_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
  answer_text: z.string().trim().min(1).max(2000),
  answered_via: z.literal('grokbot_brock'),
}).strict();
const WebhookConfigBody = z.object({
  url: z.string().trim().max(500).url().refine((u) => new URL(u).protocol === 'https:', 'url must be https'),
  secret: z.string().regex(/^[\x21-\x7e]{24,200}$/, 'secret must be 24-200 printable characters'),
}).strict();
const TestCardBody = z.object({ with_attachments: z.boolean().optional() }).strict();

// A 1x1 PNG and a one-page PDF: the dummy attachments on a test card.
const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZEAAAAAASUVORK5CYII=', 'base64');
const TEST_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

/**
 * /api/james/brock: the Brock relay's James-API surface. Mounted ahead of the
 * James router. File links are public and authenticated only by their signed,
 * expiring token; everything else needs the James bearer key.
 */
export function createBrockRouter(ctx: AppContext, relay: BrockRelay, getSecret: (name: string) => string | null, mirror: AttachmentMirror, writeDoppler: DopplerWriter = contextDopplerWriter(ctx)) {
  const db = ctx.db;
  const router = express.Router();
  const bots = createBotService(db);
  const csTickets = createCsTicketService(db);
  const tasks = createTaskService(db);
  const owner = (): Actor => {
    const id = ownerId(db);
    const user = id === null ? undefined : db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined;
    if (!user) throw new BotError(503, 'No owner account');
    return { user };
  };
  const notFound = (res: Response) => res.status(404).json({ ok: false, error: 'not_found' });

  const fileFailures: number[] = [];
  router.get('/files/:token', async (req, res) => {
    const now = Date.now();
    while (fileFailures.length && fileFailures[0]! < now - 60_000) fileFailures.shift();
    if (fileFailures.length >= 30) { res.status(429).json({ ok: false, error: 'too_many_failed_attempts' }); return; }
    const fail = () => { fileFailures.push(now); notFound(res); };
    const s = relay.settings();
    const claims = s ? verifyFileToken(s.secret, req.params.token ?? '', now) : null;
    if (!s || !claims || !relay.fileAllowed(claims)) { fail(); return; }
    try {
      const found = await readFile(claims);
      if (!found) { fail(); return; }
      res.set({
        'Content-Type': found.type,
        'Content-Length': String(found.bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer',
        'Content-Disposition': `inline; filename="${found.name.replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 100) || 'file'}"`,
      });
      res.end(found.bytes);
    } catch { fail(); }
  });

  async function readFile(c: FileClaims): Promise<{ type: string; bytes: Buffer; name: string } | null> {
    const actor = owner();
    if (c.k === 'img' && typeof c.i === 'number') {
      const found = await readDecisionImage(ctx, actor, c.d, c.v, c.i);
      const d = db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=?').get(c.d) as { proposal_json: string };
      return { type: found.type, bytes: found.bytes, name: (JSON.parse(d.proposal_json) as { images?: { label: string }[] }).images?.[c.i]?.label ?? 'image' };
    }
    if (c.k === 'ev' && typeof c.i === 'number') {
      const found = readDecisionEvidence(ctx, actor, c.d, c.v, c.i);
      return { type: found.type, bytes: found.bytes, name: found.item.label };
    }
    if (c.k === 'blob' && c.h) {
      const d = db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=? AND version=?').get(c.d, c.v) as { proposal_json: string } | undefined;
      const a = d && (JSON.parse(d.proposal_json) as { message_delivery?: { payload: { attachments?: { name: string; sha256?: string }[] } } }).message_delivery?.payload.attachments?.find((x) => x.sha256 === c.h);
      const found = a ? readEvidenceBytes(ctx, c.h) : null;
      return found && a ? { ...found, name: a.name } : null;
    }
    if (c.k === 'tm' && c.m && typeof c.i === 'number') {
      const d = db.prepare('SELECT * FROM bot_decisions WHERE id=? AND version=?').get(c.d, c.v) as (Decision & { cs_ticket_id: string | null; task_id: string | null }) | undefined;
      if (!d) return null;
      const ticket = d.cs_ticket_id ? csTickets.read(d.cs_ticket_id) : d.task_id ? csTickets.ticketForTask(d.task_id) : undefined;
      const m = ticket ? db.prepare("SELECT * FROM cs_ticket_messages WHERE id=? AND ticket_id=? AND direction<>'note'").get(c.m, ticket.id) as CsTicketMessageRow | undefined : undefined;
      const a = m ? presentMessage(m).attachments[c.i] : undefined;
      if (!a?.reference || !attachmentPath(a.reference)) return null;
      const got = await mirror.fetchAttachment(a.reference);
      return 'error' in got ? null : { ...got, name: a.name };
    }
    return null;
  }

  router.use(express.json({ limit: '64kb' }));
  router.use(jamesAuth(getSecret));
  router.use(idempotency(db));

  /**
   * Write-only: James sets Brock's webhook URL and secret without the secret
   * passing through a chat. The secret is never echoed, logged or returned;
   * the idempotency record keeps only a SHA-256 of the request and this
   * response. Works in every mode and never changes BROCK_RELAY_MODE.
   */
  router.post('/webhook-config', async (req, res) => {
    if (!req.get('idempotency-key')?.trim()) { res.status(400).json({ ok: false, error: 'idempotency_key_required' }); return; }
    const parsed = WebhookConfigBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ ok: false, error: 'invalid_body', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }); return; }
    const { url, secret } = parsed.data;
    try {
      await writeDoppler([{ name: BROCK_KEYS.url, value: url }, { name: BROCK_KEYS.secret, value: secret }]);
    } catch (err) {
      const message = (err instanceof BotError ? err.message : redactDopplerError(err)).split(secret).join('[REDACTED]');
      console.warn('[brock-relay] webhook-config write failed');
      res.status(err instanceof BotError ? err.status : 502).json({ ok: false, error: 'doppler_write_failed', detail: message });
      return;
    }
    console.warn(`[brock-relay] webhook config updated (secret length ${secret.length})`);
    res.json({ ok: true, url, secret_length: secret.length, secret_sha256_prefix: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12) });
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!relay.settings()) { res.status(404).json({ ok: false, error: 'brock_relay_off' }); return; }
    next();
  });

  const cardState = (id: string) => {
    const d = db.prepare('SELECT id,version,state,stale_json,answer_json,updated_at FROM bot_decisions WHERE id=?').get(id) as Pick<Decision, 'id' | 'version' | 'state' | 'stale_json' | 'answer_json' | 'updated_at'> | undefined;
    const row = relay.card(id);
    const answer = d?.answer_json ? JSON.parse(d.answer_json) as { action?: string; text?: string } : null;
    return { card_id: id, version: d?.version ?? null, state: d ? (d.stale_json && d.state === 'needs_input' ? 'stale' : d.state) : 'missing',
      relay_status: row?.status ?? null, resolution: row?.resolution ?? null, answered_via: row?.answered_via ?? null,
      answer: answer ? { action: answer.action ?? null, text: answer.text ?? null } : null };
  };

  router.get('/cards', (_req, res) => {
    res.json({ ok: true, cards: relay.activeCards().map((r) => ({ card_id: r.decision_id, version: r.version, test: Boolean(r.test), raised_at: r.raised_at })) });
  });
  /** The current card with freshly signed file links (how Brock refreshes expired links). */
  router.get('/cards/:id', (req, res) => {
    const s = relay.settings()!;
    const row = relay.card(req.params.id!);
    const d = row ? db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(row.decision_id) as Decision | undefined : undefined;
    if (!row || !d) { res.status(404).json({ ok: false, error: 'card_not_found' }); return; }
    res.json({ ok: true, status: row.status, state: cardState(d.id), card: row.status === 'active' && row.version === d.version ? buildCard(db, d, s, Date.now()) : null });
  });

  router.post('/answer', (req, res) => {
    const key = req.get('idempotency-key')?.trim();
    if (!key) { res.status(400).json({ ok: false, error: 'idempotency_key_required' }); return; }
    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ ok: false, error: 'invalid_body', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }); return; }
    const p = parsed.data;
    const row = relay.card(p.card_id);
    const d = row ? db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(p.card_id) as Decision | undefined : undefined;
    if (!row || !d) { res.status(404).json({ ok: false, error: 'card_not_found' }); return; }
    const conflict = (error: string) => res.status(409).json({ ok: false, error, card: cardState(d.id) });
    if (d.state !== 'needs_input') { conflict('already_resolved'); return; }
    if (d.version !== p.expected_version) { conflict('version_mismatch'); return; }
    if (d.stale_json) { conflict('stale'); return; }
    if (row.status !== 'active' || row.version !== d.version) { conflict('not_relayed'); return; }
    const actor = owner();
    const requestKey = `brock:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    try {
      try {
        bots.answerCustom(actor, d.id, p.expected_version, requestKey, p.answer_text, d.handling_revision);
      } catch (err) {
        // An exclusive shared queue needs a claim first, exactly as the web card does.
        if (!(err instanceof BotError && err.status === 409 && /Claim this question/.test(err.message))) throw err;
        bots.handle(actor, d.id, p.expected_version, `${requestKey}:claim`, 'claim', d.handling_revision);
        const claimed = db.prepare('SELECT handling_revision FROM bot_decisions WHERE id=?').get(d.id) as { handling_revision: number };
        bots.answerCustom(actor, d.id, p.expected_version, requestKey, p.answer_text, claimed.handling_revision);
      }
    } catch (err) {
      if (err instanceof BotError && err.status === 409) { conflict(/already|answer/i.test(err.message) ? 'already_resolved' : 'conflict'); return; }
      if (err instanceof BotError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
      throw err;
    }
    relay.markAnsweredVia(d.id, 'grokbot_brock');
    csTickets.decisionAnswered(d.id);
    tasks.decisionAnswered(d.id);
    const after = db.prepare('SELECT updated_at FROM bot_decisions WHERE id=?').get(d.id) as { updated_at: string };
    res.json({ ok: true, card: { card_id: d.id, version: d.version, state: 'decided', answered_via: 'grokbot_brock', answered_at: new Date(`${after.updated_at.replace(' ', 'T')}Z`).toISOString(), answer_text: p.answer_text } });
  });

  /** A dummy card in the test bot chat: no customer, ticket or order. For end-to-end checks only. */
  router.post('/test-card', (req, res) => {
    const s = relay.settings()!;
    const parsed = TestCardBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ ok: false, error: 'invalid_body' }); return; }
    if (!s.testChatId || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(s.testChatId)) {
      res.status(409).json({ ok: false, error: 'test_chat_not_registered' }); return;
    }
    const actor = { ...owner(), conversationId: s.testChatId };
    const now = new Date().toISOString();
    const evidence = parsed.data.with_attachments === false ? [] : [
      { kind: 'image' as const, label: 'Test photo.png', source: { system: 'chat_file' as const, conversation_id: s.testChatId, path: '/brock-relay-test/test-photo.png' }, sha256: retainEvidenceBytes(ctx, TEST_PNG, 'image/png'), retained: true, captured_at: now, added_by: 'bot' as const },
      { kind: 'document' as const, label: 'Test document.pdf', source: { system: 'chat_file' as const, conversation_id: s.testChatId, path: '/brock-relay-test/test-document.pdf' }, sha256: retainEvidenceBytes(ctx, TEST_PDF, 'application/pdf'), retained: true, captured_at: now, added_by: 'bot' as const },
      { kind: 'record' as const, label: 'Test record', source: { system: 'shopify' as const, order_id: 'test-order' }, text: 'TEST ONLY. No real order, ticket or customer is involved.' },
    ];
    const decision = bots.raise(actor, {
      source_key: 'brock-relay-test',
      proposal_key: crypto.randomUUID(),
      proposal: {
        question: 'TEST: Brock relay check. No customer is involved. Which test answer do you pick?',
        recommendation: 'Pick option A. This is a dummy card for the Brock relay end-to-end test.',
        consequence: 'Nothing happens: no customer, ticket, order or money is involved.',
        blocked_action: 'Nothing (relay test only).',
        assignee_id: actor.user.id,
        team: '',
        deadline: null,
        evidence: [],
        blocks_scope: 'task',
        review_summary: { action_title: 'Brock relay test card', background: ['Dummy card created through POST /api/james/brock/test-card.'] },
        choices: [
          { id: 'a', label: 'Test answer A', description: 'The recommended dummy answer', action: 'approve', answer: 'A', recommended: true },
          { id: 'b', label: 'Test answer B', description: 'The other dummy answer', action: 'reject', answer: 'B' },
        ],
        ...(evidence.length ? { evidence_items: evidence } : {}),
      },
    });
    res.status(201).json({ ok: true, card_id: decision.id, version: decision.version, note: 'Relayed to Brock within about 5 seconds.' });
  });

  router.use((_req, res) => { res.status(404).json({ ok: false, error: 'not_found' }); });
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BotError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
    console.warn('[brock-relay] route failed:', err.message);
    res.status(500).json({ ok: false, error: 'internal_error' });
  });
  return router;
}
