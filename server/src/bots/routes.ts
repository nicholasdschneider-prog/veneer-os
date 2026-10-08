import { customDirections, customDirectionInput, customDirectionReview, customDirectionRead, customDirectionFence, customDirectionRenew, customDirectionResult } from './customDirection.js';
import {exactRefundRoutes} from './exactRefundRoutes.js';
import { requestOutboundCall } from './outboundCalls.js';
import { proposalDiagnostics } from './proposalDiagnostics.js';
import {contactVerificationRoutes} from './contactVerificationRoutes.js';
import {caseCustodyRoutes} from './caseCustodyRoutes.js';
import { mergeAuthorizationRoutes, mergeIO } from './mergeAuthorizationRoutes.js';
import { mergeAuthorization, type MergeIO } from './mergeAuthorization.js';
import {composedSmsCorrectionV2} from './composedSmsCorrectionV2.js';
import {correctionPreflight} from './correctionPreflight.js';
import {composedSmsCorrection} from './composedSmsCorrection.js';
import {composedSmsScope,composeScopeReviewSchema} from './composedSmsScope.js';
import {composeEvidenceReader} from './composedSmsEvidenceReader.js';
import {composeVerifierIO} from './composedSmsVerifierRoutes.js';
import {composedSmsVerifier} from './composedSmsVerifier.js';
import {composedSmsService,composedInspectionSchema,deriveComposedSchema} from './composedSms.js';
import {composedSmsReader} from './composedSmsReader.js';
import { createInstructionObligations, obligationInspectionSchema, obligationRecordSchema } from './instructionObligations.js';
import { createDecisionHandoffRouter } from './decisionHandoffRoutes.js';
import { bindDecisionImages, readDecisionImage } from './decisionImages.js';
import { bindDecisionEvidence, bindHumanEvidence, composioGmailFetchers, readDecisionEvidence, type EvidenceFetchers } from './decisionEvidence.js';
import {createOrganizationService,latestBotPreview} from './organization.js';
import { createTeamService } from './teams.js';
import { createChiefOfStaffService } from './chiefOfStaff.js';
import express from 'express';
import { isUnread, markSeen } from '../conversations/unread.js';
import { canViewConversation } from '../conversations/access.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConversationRow, UserRow } from '../db/db.js';
import { BotError, createBotService, proposalInputSchema, validateDecisionChoices, validateDecisionEvidence } from './service.js';
const key = z.string().min(1).max(200);
const mutation = z.object({
  expected_version: z.number().int().positive(),
  request_key: key,
});
export function createBotsRouter(ctx: AppContext, deps: { evidenceFetchers?: EvidenceFetchers; mergeIO?: MergeIO } = {}) {
  const evidenceFetchers = deps.evidenceFetchers ?? composioGmailFetchers();
  const router = express.Router();
  router.post('/outbound-calls', (req,res)=> {
    void requestOutboundCall(ctx,req.user!,req.agentConversationId,req.body).then(result=>res.json(result)).catch(()=>res.status(409).json({error:'Call request refused. Check original Archer scope, owner phone policy, calling hours and prior reservations; do not retry an unknown call.'}));
  });
  const s = createBotService(ctx.db);
  const teams = createTeamService(ctx.db);
  const chiefOfStaff = createChiefOfStaffService(ctx.db);
  const organization=createOrganizationService(ctx.db);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(createDecisionHandoffRouter(ctx));
  router.use(caseCustodyRoutes(ctx));
  router.use(mergeAuthorizationRoutes(ctx, deps.mergeIO));
  const merges = mergeAuthorization(ctx.db, deps.mergeIO ?? mergeIO(ctx));
  router.use(contactVerificationRoutes(ctx));
  router.use(exactRefundRoutes(ctx));
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
          else if (e instanceof z.ZodError) {
            const proposalError = e.issues.some(x => x.path[0] === 'proposal')
              ? proposalDiagnostics(req.body?.proposal) : null;
            res.status(400).json({
              error: [...(proposalError ? [proposalError] : []), ...e.issues
                .filter(x => x.path[0] !== 'proposal')
                .map(x => `${x.path.join('.')}: ${x.message}`)].join('; '),
            });
          }
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
  router.get('/organization',run((req,res)=>{if(req.agentConversationId)throw new BotError(403,'Personal organization requires a human session');res.json(organization.get(req.user!,z.string().max(200).parse(req.query.business??'')));}));
  router.post('/organization',run((req,res)=>{if(req.agentConversationId)throw new BotError(403,'Personal organization requires a human session');res.json(organization.save(req.user!,z.string().max(200).parse(req.query.business??''),req.body));}));
  router.get('/teams', run((req, res) => res.json({ teams: teams.list(actor(req)) })));
  router.post('/teams/manage', run((req, res) => {
    const result = teams.manage(actor(req), req.body);
    changed(result.id);
    if (req.body.action === 'focus' || req.body.action === 'employee' || (req.body.action === 'member' && req.body.email !== undefined)) {
      for (const c of ctx.db.prepare('SELECT id FROM conversations').all() as { id: string }[]) ctx.manager.bus?.emit('access', c.id);
    }
    if (req.body.action === 'remove_bot') ctx.manager.bus?.emit('access', req.body.conversation_id);
    res.json({ team: result });
  }));
  router.get('/chief-of-staff', run((req, res) => res.json(chiefOfStaff.status(actor(req)))));
  router.post('/chief-of-staff', run((req, res) => {
    const result = chiefOfStaff.designate(actor(req), req.body);
    ctx.manager.bus?.emit('access', result.conversation_id);
    res.json(result);
  }));
  router.get('/open-questions', run((req, res) => res.json(s.openQuestions(actor(req)))));
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
      // One chat's own questions, for the conversation page's poller: the full
      // list is over a megabyte and was being fetched every few seconds.
      const conversation = typeof req.query.conversation === 'string' && req.query.conversation ? req.query.conversation : null;
      const allDecisions = s.list(a, 'all', conversation ?? undefined);
      const decisions = s.filterList(a, allDecisions, String(req.query.filter ?? 'all')).filter(d => inTeam(d.conversation_id));
      if (conversation) {
        res.json({ bots: [], decisions, approvers: [], teams: teams.list(a) });
        return;
      }
      const bots = [];
      const visible: { registration: { conversation_id: string; name: string }; conversation: ConversationRow }[] = [];
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
        visible.push({ registration: r, conversation: c });
      }
      // Resolve existing read-only RPCs together, instead of serially delaying
      // every bot behind the preceding request. No runner restart/API change.
      const statuses = await Promise.all(visible.map(({ conversation }) => ctx.manager.statusOf(conversation.id)));
      for (const [index, { registration: r, conversation: c }] of visible.entries()) {
        const membership = ctx.db.prepare('SELECT role,subteam,reports_to FROM business_bot_members WHERE conversation_id=?').get(c.id) as { role: string; subteam: string; reports_to: string | null } | undefined;
        const status = statuses[index];
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
          last_reply: latestBotPreview(ctx.db,c.id),
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
    run(async (req, res) => {
      const p = z
        .object({
          source_key: key,
          proposal_key: key,
          proposal: proposalInputSchema,
        })
        .strict()
        .parse(req.body);
      if (!req.agentConversationId) throw new BotError(403, 'A bot conversation is required');
      validateDecisionChoices(p.proposal.choices);
      validateDecisionEvidence(p.proposal);
      // A merge question is bound to one registered intent revision and direction; its approve answer IS the intentHash.
      const binding = p.proposal.merge_intent ? merges.prepareBinding(p.proposal.merge_intent, req.agentConversationId, p.proposal.choices) : null;
      p.proposal = await bindDecisionImages(ctx, actor(req), req.agentConversationId, p.proposal);
      p.proposal = await bindDecisionEvidence(ctx, actor(req), req.agentConversationId, p.proposal, evidenceFetchers);
      const raised = ctx.db.transaction(() => {
        const d = s.raise(actor(req), p);
        if (binding && !ctx.db.prepare('SELECT 1 FROM merge_intent_bindings WHERE decision_id=? AND decision_version=?').get(d.id, d.version)) merges.recordBinding(d.id, d.version, binding);
        return d;
      })();
      res.json({ decision: raised });
    }),
  );
  router.get('/decisions/:id/evidence/:version/:index', run((req, res) => {
    const version = z.coerce.number().int().positive().parse(req.params.version);
    const index = z.coerce.number().int().min(0).max(63).parse(req.params.index);
    const found = readDecisionEvidence(ctx, actor(req), req.params.id!, version, index);
    res.set('Content-Type', found.type).set('X-Content-Type-Options', 'nosniff')
      .set('Cache-Control', 'private, no-store').set('Content-Security-Policy', "default-src 'none'; sandbox")
      .set('Content-Disposition', `inline; filename="${found.item.label.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'evidence'}"`)
      .send(found.bytes);
  }));
  /** A human attaches a composer upload to a question (kept as an event on this version, visible to the bot). */
  router.post('/decisions/:id/evidence', run((req, res) => {
    if (req.agentConversationId) throw new BotError(403, 'Bots attach evidence through the proposal');
    const p = mutation.extend({ path: z.string().min(1).max(4096), label: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    const item = bindHumanEvidence(ctx, { path: p.path, label: p.label });
    res.json({ decision: s.addHumanEvidence(actor(req), req.params.id!, p.expected_version, p.request_key, item) });
  }));
  router.get('/decisions/:id/images/:version/:index', run(async (req, res) => {
    const version = z.coerce.number().int().positive().parse(req.params.version);
    const index = z.coerce.number().int().min(0).max(11).parse(req.params.index);
    const image = await readDecisionImage(ctx, actor(req), req.params.id!, version, index);
    res.set('Content-Type', image.type).set('X-Content-Type-Options', 'nosniff')
      .set('Cache-Control', 'private, no-store').set('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(image.bytes);
  }));
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
    run(async (req, res) => {
      const p = mutation
        .extend({ proposal: proposalInputSchema })
        .strict()
        .parse(req.body);
      const current = s.read(actor(req), req.params.id!);
      // A revised proposal is a fresh question: bots must re-supply researched choices.
      if (req.agentConversationId) { validateDecisionChoices(p.proposal.choices); validateDecisionEvidence(p.proposal); }
      const binding = p.proposal.merge_intent ? merges.prepareBinding(p.proposal.merge_intent, current.conversation_id, p.proposal.choices, current.id) : null;
      p.proposal = await bindDecisionImages(ctx, actor(req), current.conversation_id, p.proposal);
      p.proposal = await bindDecisionEvidence(ctx, actor(req), current.conversation_id, p.proposal, evidenceFetchers);
      res.json({
        decision: ctx.db.transaction(() => {
          const d = s.revise(
            actor(req),
            req.params.id!,
            p.expected_version,
            p.request_key,
            p.proposal,
          );
          if (binding && !ctx.db.prepare('SELECT 1 FROM merge_intent_bindings WHERE decision_id=? AND decision_version=?').get(d.id, d.version)) merges.recordBinding(d.id, d.version, binding);
          return d;
        })(),
      });
    }),
  );
  router.post('/decisions/:id/reply', run((req,res)=>{
    const p=mutation.extend({body:z.string().min(1).max(12000),expected_handling_revision:z.number().int().nonnegative().optional()}).strict().parse(req.body);
    res.json({decision:s.editReply(actor(req),req.params.id!,p.expected_version,p.request_key,p.body,p.expected_handling_revision)});
  }));
  router.post('/decisions/:id/handling', run((req, res) => {
    const p = mutation.extend({ action: z.enum(['claim', 'release']), expected_handling_revision: z.number().int().nonnegative() }).strict().parse(req.body);
    res.json({ decision: s.handle(actor(req), req.params.id!, p.expected_version, p.request_key, p.action, p.expected_handling_revision) });
  }));
  router.post('/decisions/:id/choice', run((req, res) => {
    const p = mutation.extend({
      choice_id: z.string().min(1).max(64), note: z.string().trim().max(12000).default(''),
      scope: z.enum(['this_case', 'standing_rule']),
      expected_handling_revision: z.number().int().nonnegative().optional(),
    }).strict().parse(req.body);
    res.json({ decision: s.choose(actor(req), req.params.id!, p.expected_version, p.request_key,
      p.choice_id, p.note, p.scope, p.expected_handling_revision) });
  }));
  router.post('/decisions/:id/custom', run((req, res) => {
    const p = mutation.extend({
      text: z.string().trim().min(1).max(2000),
      expected_handling_revision: z.number().int().nonnegative().optional(),
      // Files the human attached with the typed answer; each becomes a retained evidence event first.
      evidence: z.array(z.object({ path: z.string().min(1).max(4096), label: z.string().trim().min(1).max(200) }).strict()).max(12).optional(),
    }).strict().parse(req.body);
    const a = actor(req);
    for (const [i, upload] of (p.evidence ?? []).entries()) s.addHumanEvidence(a, req.params.id!, p.expected_version, `${p.request_key}:evidence:${i}`, bindHumanEvidence(ctx, upload));
    res.json({ decision: s.answerCustom(a, req.params.id!, p.expected_version, p.request_key, p.text, p.expected_handling_revision) });
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
  const composed=composedSmsService(ctx.db,composedSmsReader(ctx));
  const correctionsV2=composedSmsCorrectionV2(ctx.db,composedSmsReader(ctx));
  router.post('/composed-sms/corrections-v2/inspect',run(async(req,res)=>res.json(await correctionsV2.inspect(actor(req),req.body))));
  router.post('/composed-sms/corrections-v2/derive',run(async(req,res)=>res.json(await correctionsV2.derive(actor(req),req.body))));
  router.post('/composed-sms/corrections-v2/reconcile',run((req,res)=>res.json(correctionsV2.reconcile(actor(req),req.body))));
  const corrections=composedSmsCorrection(ctx.db,composedSmsReader(ctx));
  const preflight=correctionPreflight(ctx.db);
  router.post('/composed-sms/correction-preflight/inspect',run((req,res)=>res.json(preflight.inspect(actor(req),req.body))));
  router.post('/composed-sms/correction-preflight/review',run((req,res)=>res.json(preflight.review(actor(req),req.body))));
  router.post('/composed-sms/corrections/reconcile',run((req,res)=>res.json(corrections.reconcile(actor(req),req.body))));
  router.post('/composed-sms/corrections/inspect',run(async(req,res)=>res.json(await corrections.inspect(actor(req),req.body))));
  router.post('/composed-sms/corrections/derive',run(async(req,res)=>res.json(await corrections.derive(actor(req),req.body))));
  const scopeReview=composedSmsScope(ctx.db,composeVerifierIO(ctx).registration,composeEvidenceReader(ctx).scope,id=>composed.serviceCurrent(id));
  router.post('/composed-sms/:id/scope/inspect',run(async(req,res)=>{z.object({}).strict().parse(req.body);res.json(await scopeReview.inspect(actor(req),z.string().uuid().parse(req.params.id)));}));
  router.post('/composed-sms/:id/scope/record',run(async(req,res)=>res.json(await scopeReview.record(actor(req),composeScopeReviewSchema.parse({...req.body,authority_id:req.params.id})))));
  router.post('/composed-sms/scope/:id/revoke',run((req,res)=>{const p=z.object({reason:z.string().min(1).max(2000)}).strict().parse(req.body);res.json(scopeReview.revoke(actor(req),z.string().uuid().parse(req.params.id),p.reason));}));
  router.post('/composed-sms/inspect',run(async(req,res)=>res.json(await composed.inspect(actor(req),composedInspectionSchema.parse(req.body)))));
  router.post('/composed-sms/derive',run(async(req,res)=>res.json(await composed.derive(actor(req),deriveComposedSchema.parse(req.body)))));
  router.get('/composed-sms/:id',run((req,res)=>res.json(composed.reconcile(actor(req),req.params.id!))));
  router.post('/composed-sms/:id/accept',run(async(req,res)=>{const p=z.object({request_key:key,payload_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);res.json(await composed.accept(actor(req),req.params.id!,p.request_key,p.payload_hash));}));
  router.post('/composed-sms/:id/claim',run(async(req,res)=>{const p=z.object({request_key:key,send_check:z.unknown()}).strict().parse(req.body);res.json(await composed.claim(actor(req),req.params.id!,p.request_key,p.send_check));}));
  router.post('/composed-sms/:id/delivery',run(async(req,res)=>{const p=z.object({request_key:key,claim_key:key}).strict().parse(req.body);const target=composed.receiptTarget(actor(req),req.params.id!,p.claim_key);res.json(await composedSmsVerifier(ctx.db,composeVerifierIO(ctx)).receipt(target.registration_id,target.action_id));}));
  router.post('/composed-sms/:id/revoke',run((req,res)=>{const p=z.object({request_key:key,reason:z.string().min(1).max(2000)}).strict().parse(req.body);res.json(composed.revoke(actor(req),req.params.id!,p.request_key,p.reason));}));
  const directions=customDirections(ctx.db);
  router.post('/custom-directions/inspect',run((req,res)=>res.json(directions.inspect(actor(req),customDirectionInput.parse(req.body)))));
  router.post('/custom-directions/reviews',run((req,res)=>res.json(directions.record(actor(req),customDirectionReview.parse(req.body)))));
  router.post('/custom-directions/read',run((req,res)=>res.json(directions.read(actor(req),customDirectionRead.parse(req.body)))));
  router.post('/custom-directions/renew',run((req,res)=>res.json(directions.renew(actor(req),customDirectionRenew.parse(req.body)))));
  router.post('/custom-directions/result',run((req,res)=>res.json(directions.result(actor(req),customDirectionResult.parse(req.body)))));
  router.post('/custom-directions/fences',run((req,res)=>res.json(directions.fence(actor(req),customDirectionFence.parse(req.body)))));
  const obligations=createInstructionObligations(ctx.db);
  router.post('/instruction-obligations/inspect', run((req,res)=>res.json(obligations.inspect(actor(req),obligationInspectionSchema.parse(req.body)))));
  router.post('/instruction-obligations', run((req,res)=>res.json(obligations.record(actor(req),obligationRecordSchema.parse(req.body)))));
  router.post('/instruction-obligations/:id/revoke', run((req,res)=>{
    const p=z.object({reason:z.string().trim().min(1).max(600),request_key:key}).strict().parse(req.body);
    res.json(obligations.revoke(actor(req),req.params.id!,p.reason,p.request_key));
  }));
  router.get('/decisions/:id/conversational-source', run((req,res)=>{
    const p=z.object({expected_version:z.coerce.number().int().positive(),source_kind:z.enum(['result_reply','direct_message']),source_id:key.optional()}).strict().parse(req.query);
    res.json(s.inspectConversationalDecision(actor(req),req.params.id!,p.expected_version,p.source_kind,p.source_id));
  }));
  router.post('/decisions/:id/conversational-decision', run((req,res)=>{
    const p=z.object({expected_version:z.number().int().positive(),source_kind:z.enum(['result_reply','direct_message']),source_id:key,inspection_hash:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['approve','reject','defer','withdraw']),reviewed_full_context:z.literal(true)}).strict().parse(req.body);
    res.json({decision:s.recordConversationalDecision(actor(req),req.params.id!,p.expected_version,p.source_kind,p.source_id,p.inspection_hash,p.action,p.reviewed_full_context)});
  }));
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
    '/decisions/:id/withdraw',
    run((req, res) => {
      const p = mutation
        .extend({
          reason: z.string().trim().min(1).max(600),
          evidence: z.string().trim().min(1).max(12000),
        })
        .strict()
        .parse(req.body);
      res.json({
        decision: s.withdraw(
          actor(req),
          req.params.id!,
          p.expected_version,
          p.request_key,
          { reason: p.reason, evidence: p.evidence },
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
