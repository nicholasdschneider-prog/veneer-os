import { createTeamService } from './teams.js';
import express from 'express';
import { isUnread, markSeen } from '../conversations/unread.js';
import { canViewConversation } from '../conversations/access.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConversationRow, UserRow } from '../db/db.js';
import { BotError, createBotService, proposalInputSchema } from './service.js';
const key = z.string().min(1).max(200);
const mutation = z.object({
  expected_version: z.number().int().positive(),
  request_key: key,
});
export function createBotsRouter(ctx: AppContext) {
  const router = express.Router();
  const s = createBotService(ctx.db);
  const teams = createTeamService(ctx.db);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const run =
    (fn: (req: express.Request, res: express.Response) => unknown) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((e) => {
          if (e instanceof BotError)
            res.status(e.status).json({ error: e.message });
          else if (e instanceof z.ZodError)
            res.status(400).json({
              error: e.issues
                .map((x) => `${x.path.join('.')}: ${x.message}`)
                .join('; '),
            });
          else next(e);
        });
    };
  const actor = (req: express.Request) => ({
    user: req.user!,
    conversationId: req.agentConversationId,
  });
  const changed = (teamId: string) => {
    for (const c of ctx.db.prepare('SELECT id FROM conversations WHERE business_team_id=?').all(teamId) as { id: string }[]) ctx.manager.bus?.emit('access', c.id);
  };
  router.get('/teams', run((req, res) => res.json({ teams: teams.list(actor(req)) })));
  router.post('/teams/manage', run((req, res) => {
    const result = teams.manage(actor(req), req.body);
    changed(result.id);
    if (req.body.action === 'employee') {
      for (const c of ctx.db.prepare('SELECT id FROM conversations').all() as { id: string }[]) ctx.manager.bus?.emit('access', c.id);
    }
    if (req.body.action === 'remove_bot') ctx.manager.bus?.emit('access', req.body.conversation_id);
    res.json({ team: result });
  }));
  router.post('/teams/enroll', run((req, res) => {
    const result = teams.bulk(actor(req), req.body);
    if (req.body.mode === 'apply') changed(req.body.team_id);
    res.json(result);
  }));
  router.get(
    '/',
    run(async (req, res) => {
      const a = actor(req);
      const selected = typeof req.query.business === 'string' ? req.query.business : null;
      const inTeam = (id: string) => !selected || s.chat(a, id).business_team_id === selected;
      const decisions = s.list(a, String(req.query.filter ?? 'all')).filter(d => inTeam(d.conversation_id));
      const allDecisions = s.list(a);
      const bots = [];
      for (const r of ctx.db
        .prepare('SELECT * FROM bot_registrations WHERE active=1 ORDER BY name')
        .all() as { conversation_id: string; name: string }[]) {
        let c: ConversationRow;
        try {
          c = s.chat(a, r.conversation_id);
        } catch {
          continue;
        }
        if (!inTeam(c.id)) continue;
        const membership = ctx.db.prepare('SELECT role,subteam,reports_to FROM business_bot_members WHERE conversation_id=?').get(c.id) as { role: string; subteam: string; reports_to: string | null } | undefined;
        const status = await ctx.manager.statusOf(c.id);
        const own = allDecisions.filter((d) => d.conversation_id === c.id);
        const whole = own.some(
          (d) =>
            d.proposal.blocks_scope === 'workload' && d.state === 'needs_input',
        );
        const waiting = own.some(
          (d) =>
            d.parked &&
            d.proposal.blocks_scope === 'workload' &&
            d.state === 'blocked',
        );
        bots.push({
          ...r,
          project_id: c.project_id,
          business_team_id: c.business_team_id,
          membership,
          title: c.title,
          updated_at: c.last_active_at,
          unread: isUnread(ctx.db, a.user.id, c.id),
          pinned: Boolean((ctx.db.prepare('SELECT bot_pinned FROM conversation_last_seen WHERE user_id=? AND conversation_id=?').get(a.user.id, c.id) as { bot_pinned: number } | undefined)?.bot_pinned),
          provider: c.provider,
          archived: Boolean(c.archived),
          can_manage: !c.business_team_id && !a.conversationId && c.user_id === a.user.id,
          questions: own.filter((d) => d.state === 'needs_input').length,
          state:
            status === 'working'
              ? 'working'
              : status === 'failed'
                ? 'failed'
                : whole || status === 'needs_you'
                  ? 'needs input'
                  : waiting
                    ? 'waiting on external'
                    : 'available',
        });
      }
      bots.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.updated_at.localeCompare(x.updated_at) || x.name.localeCompare(y.name) || x.conversation_id.localeCompare(y.conversation_id));
      const ownerChat = a.conversationId ? s.chat(a, a.conversationId) : null;
      const approvers = ownerChat
        ? (
            ctx.db
              .prepare("SELECT * FROM users WHERE status='active'")
              .all() as UserRow[]
          )
            .filter((user) => canViewConversation(user, ownerChat, ctx.db))
            .map((user) => ({ id: user.id, name: user.display_name }))
        : [];
      res.json({ bots, decisions, approvers, teams: teams.list(a) });
    }),
  );
  router.patch('/preferences/:id', run((req, res) => {
    if (req.agentConversationId) throw new BotError(403, 'Only a user can change bot preferences');
    const c = s.chat(actor(req), req.params.id!);
    const patch = z.object({ pinned: z.boolean().optional(), unread: z.boolean().optional() }).strict().parse(req.body);
    ctx.db.transaction(() => {
      if (patch.pinned !== undefined) {
        ctx.db.prepare(`INSERT INTO conversation_last_seen (user_id, conversation_id, bot_pinned)
          VALUES (?, ?, ?) ON CONFLICT(user_id, conversation_id) DO UPDATE SET bot_pinned=excluded.bot_pinned`)
          .run(req.user!.id, c.id, Number(patch.pinned));
      }
      if (patch.unread === false) markSeen(ctx.db, req.user!.id, c.id);
      if (patch.unread === true) {
        ctx.db.prepare(`INSERT INTO conversation_last_seen (user_id, conversation_id, unread)
          VALUES (?, ?, 1) ON CONFLICT(user_id, conversation_id) DO UPDATE SET unread=1`)
          .run(req.user!.id, c.id);
      }
    })();
    res.json({ ok: true });
  }));
  router.get(
    '/candidates',
    run((req, res) => {
      if (req.agentConversationId)
        throw new BotError(403, 'Human registration only');
      res.json({
        conversations: ctx.db
          .prepare(
            'SELECT id,title FROM conversations WHERE user_id=? AND archived=0 ORDER BY last_active_at DESC',
          )
          .all(req.user!.id),
        users: ctx.db
          .prepare("SELECT id,display_name FROM users WHERE status='active'")
          .all() as Pick<UserRow, 'id' | 'display_name'>[],
      });
    }),
  );
  router.put(
    '/registrations/:id',
    run((req, res) => {
      const p = z
        .object({
          name: z.string().trim().min(1).max(100),
          active: z.boolean(),
        })
        .strict()
        .parse(req.body);
      s.register(actor(req), req.params.id!, p.name, p.active);
      res.json({ ok: true });
    }),
  );
  router.post(
    '/decisions',
    run((req, res) => {
      const p = z
        .object({
          source_key: key,
          proposal_key: key,
          proposal: proposalInputSchema,
        })
        .strict()
        .parse(req.body);
      res.json({ decision: s.raise(actor(req), p) });
    }),
  );
  router.get(
    '/decisions/:id',
    run((req, res) => {
      const a = actor(req);
      res.json({
        decision: s.view(a, s.read(a, req.params.id!)),
        ...s.thread(a, req.params.id!),
      });
    }),
  );
  router.post(
    '/decisions/:id/proposal',
    run((req, res) => {
      const p = mutation
        .extend({ proposal: proposalInputSchema })
        .strict()
        .parse(req.body);
      res.json({
        decision: s.revise(
          actor(req),
          req.params.id!,
          p.expected_version,
          p.request_key,
          p.proposal,
        ),
      });
    }),
  );
  router.post('/decisions/:id/handling', run((req, res) => {
    const p = mutation.extend({ action: z.enum(['claim', 'release']), expected_handling_revision: z.number().int().nonnegative() }).strict().parse(req.body);
    res.json({ decision: s.handle(actor(req), req.params.id!, p.expected_version, p.request_key, p.action, p.expected_handling_revision) });
  }));
  router.post(
    '/decisions/:id/answer',
    run((req, res) => {
      const p = mutation
        .extend({
          expected_handling_revision: z.number().int().nonnegative().optional(),
          action: z.enum(['approve', 'reject', 'defer', 'withdraw']),
          text: z.string().trim().min(1).max(12000),
          scope: z.enum(['this_case', 'standing_rule']),
        })
        .strict()
        .parse(req.body);
      res.json({
        decision: s.answer(
          actor(req),
          req.params.id!,
          p.expected_version,
          p.request_key,
          { action: p.action, text: p.text, scope: p.scope },
          p.expected_handling_revision,
        ),
      });
    }),
  );
  router.post(
    '/decisions/:id/thread',
    run((req, res) => {
      const p = z
        .object({ request_key: key, text: z.string().trim().min(1).max(12000), expected_version: z.number().int().positive().optional() })
        .strict()
        .parse(req.body);
      res.json({
        decision: s.reply(actor(req), req.params.id!, p.request_key, p.text, p.expected_version),
      });
    }),
  );
  router.post('/decisions/:id/discussion-decision', run((req, res) => {
    const p = z.object({ message_id: key, expected_version: z.number().int().positive(), action: z.enum(['approve', 'reject', 'defer', 'withdraw']) }).strict().parse(req.body);
    res.json({ decision: s.recordDiscussionDecision(actor(req), req.params.id!, p.message_id, p.expected_version, p.action) });
  }));
  router.post(
    '/decisions/:id/result',
    run((req, res) => {
      const p = mutation
        .extend({
          state: z.enum(['running', 'verified_completed', 'blocked', 'failed']),
          evidence: z.string().trim().min(1).max(12000),
          material_evidence_unchanged: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      res.json({
        decision: s.result(
          actor(req),
          req.params.id!,
          p.expected_version,
          p.request_key,
          {
            state: p.state,
            evidence: p.evidence,
            ...(p.material_evidence_unchanged !== undefined
              ? { material_evidence_unchanged: p.material_evidence_unchanged }
              : {}),
          },
        ),
      });
    }),
  );
  router.post(
    '/decisions/:id/park',
    run((req, res) => {
      const p = mutation
        .extend({
          released_leases: z.array(key).max(100),
          evidence: z.string().trim().min(1).max(12000),
        })
        .strict()
        .parse(req.body);
      res.json({
        decision: s.park(
          actor(req),
          req.params.id!,
          p.expected_version,
          p.request_key,
          { released_leases: p.released_leases, evidence: p.evidence },
        ),
      });
    }),
  );
  router.post(
    '/decisions/:id/dismiss',
    run((req, res) => {
      const p = z
        .object({ expected_version: z.number().int().positive() })
        .strict()
        .parse(req.body);
      s.dismiss(actor(req), req.params.id!, p.expected_version);
      res.json({ ok: true });
    }),
  );
  return router;
}
