import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { botTokensSince, effectiveDailyBudget, governorFlags } from './store.js';

const FlagsInput = z.object({
  rotation: z.boolean().optional(),
  precheck: z.boolean().optional(),
  budget: z.boolean().optional(),
  rotation_threshold_tokens: z.number().int().min(50_000).max(900_000).nullable().optional(),
  daily_budget_tokens: z.number().int().positive().nullable().optional(),
}).strict();

/** Owner-only view of the token governor, and the per-bot switches. */
export function createTokenGovernorRouter(ctx: AppContext) {
  const { db } = ctx;
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.user?.role !== 'owner') { res.status(403).json({ error: 'Only the installation owner can view the token governor' }); return; }
    next();
  });

  router.get('/', (_req, res) => {
    const now = new Date();
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const bots = db.prepare(
      `SELECT b.conversation_id AS id, b.name FROM bot_registrations b WHERE b.active = 1 ORDER BY b.name`,
    ).all() as { id: string; name: string }[];
    const byOrigin = db.prepare(
      `SELECT origin, COUNT(*) AS turns, SUM(input_tokens + output_tokens) AS tokens, SUM(COALESCE(cached_input_tokens, 0)) AS cached
       FROM turn_token_usage WHERE bot_id = ? AND finished_at >= ? GROUP BY origin`,
    );
    const events = db.prepare(
      'SELECT kind, COUNT(*) AS n FROM token_governor_events WHERE bot_id = ? AND at >= ? GROUP BY kind',
    );
    res.json({
      since,
      bots: bots.map((bot) => {
        const flags = governorFlags(db, bot.id);
        return {
          ...bot,
          flags: flags ? { rotation: flags.rotation, precheck: flags.precheck, budget: flags.budget, rotationThreshold: flags.rotationThreshold } : null,
          dailyBudget: flags ? effectiveDailyBudget(db, flags, now) : null,
          tokens24h: botTokensSince(db, bot.id, new Date(since)),
          byOrigin: byOrigin.all(bot.id, since),
          events: Object.fromEntries((events.all(bot.id, since) as { kind: string; n: number }[]).map((e) => [e.kind, e.n])),
        };
      }),
    });
  });

  router.put('/bots/:id', (req, res) => {
    // A bot never changes its own governor; only the human owner does.
    if (req.agentConversationId) { res.status(403).json({ error: 'Only the human owner can change token governor switches' }); return; }
    const parsed = FlagsInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') }); return; }
    const id = req.params.id;
    if (!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id = ?').get(id)) { res.status(404).json({ error: 'Not a registered bot' }); return; }
    const p = parsed.data;
    db.prepare(
      `INSERT INTO token_governor_bots (conversation_id, rotation, precheck, budget, rotation_threshold_tokens, daily_budget_tokens)
       VALUES (@id, COALESCE(@rotation, 0), COALESCE(@precheck, 0), COALESCE(@budget, 0), @threshold, @daily)
       ON CONFLICT(conversation_id) DO UPDATE SET
         rotation = COALESCE(@rotation, rotation), precheck = COALESCE(@precheck, precheck), budget = COALESCE(@budget, budget),
         rotation_threshold_tokens = CASE WHEN @hasThreshold THEN @threshold ELSE rotation_threshold_tokens END,
         daily_budget_tokens = CASE WHEN @hasDaily THEN @daily ELSE daily_budget_tokens END,
         updated_at = datetime('now')`,
    ).run({
      id,
      rotation: p.rotation === undefined ? null : Number(p.rotation),
      precheck: p.precheck === undefined ? null : Number(p.precheck),
      budget: p.budget === undefined ? null : Number(p.budget),
      threshold: p.rotation_threshold_tokens ?? null,
      hasThreshold: p.rotation_threshold_tokens === undefined ? 0 : 1,
      daily: p.daily_budget_tokens ?? null,
      hasDaily: p.daily_budget_tokens === undefined ? 0 : 1,
    });
    res.json({ ok: true, flags: governorFlags(db, id) });
  });

  return router;
}
