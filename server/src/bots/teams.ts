import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ConversationRow } from '../db/db.js';
import { BotError, type Actor } from './service.js';

const id = z.string().min(1).max(200);
export const enrollmentSchema = z
  .object({
    conversation_id: id,
    name: z.string().trim().min(1).max(120),
    role: z.enum(['coordinator', 'lead', 'bot']),
    subteam: z.string().trim().max(120).default(''),
    reports_to: id.nullable().default(null),
  })
  .strict();
export const bulkSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preview'),
      team_id: id,
      request_key: id,
      bots: z.array(enrollmentSchema).min(1).max(100),
    })
    .strict(),
  z.object({ mode: z.literal('apply'), team_id: id, preview_id: id }).strict(),
]);
const manageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('shopify'), team_id: id, shopify_store: z.string().regex(/^[a-z0-9-]+$/).max(100).nullable() }).strict(),
  z.object({ action: z.literal('employee'), team_id: id, user_id: z.number().int().positive(), email: z.string().email(), conversation_ids: z.array(id).min(1).max(100), activate: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('create'), name: z.string().trim().min(1).max(120) }).strict(),
  z
    .object({
      action: z.literal('member'),
      team_id: id,
      user_id: z.number().int().positive(),
      role: z.enum(['viewer', 'member', 'manager']).nullable(),
      // Supplying the verified email explicitly promotes a restricted employee
      // to the normal business workspace. Ordinary membership edits do not.
      email: z.string().trim().email().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delegate'),
      team_id: id,
      conversation_id: id,
      allowed_ids: z.array(id).max(100),
    })
    .strict(),
  z.object({ action: z.literal('remove_bot'), team_id: id, conversation_id: id }).strict(),
]);
type Team = { id: string; name: string; owner_id: number; revision: number };
type Enrollment = z.infer<typeof enrollmentSchema>;
export function createTeamService(db: Database.Database) {
  const chat = (value: string) =>
    db.prepare('SELECT * FROM conversations WHERE id=?').get(value) as ConversationRow | undefined;
  const team = (value: string) => {
    const result = db.prepare('SELECT * FROM business_teams WHERE id=?').get(value) as
      Team | undefined;
    if (!result) throw new BotError(404, 'Business not found');
    return result;
  };
  function admin(actor: Actor, t?: Team) {
    if (t && t.owner_id !== actor.user.id)
      throw new BotError(403, 'Only the business owner can manage access');
    if (actor.conversationId) {
      const c = chat(actor.conversationId);
      const a =
        c &&
        (db.prepare('SELECT slug FROM assistants WHERE id=?').get(c.assistant_id) as
          { slug: string } | undefined);
      // Platform Dev is already an owner-authorized administrative agent. Record its native identity,
      // never impersonate a browser session. Operational agents require explicit delegation below.
      if (actor.user.role !== 'owner' || c?.user_id !== actor.user.id || a?.slug !== 'platform-dev')
        throw new BotError(403, 'Human owner or authenticated owner Platform Dev required');
    }
  }
  function audit(actor: Actor, teamId: string, action: string, payload: unknown) {
    db.prepare(
      'INSERT INTO business_audit(team_id,actor_id,actor_chat,action,payload_json) VALUES(?,?,?,?,?)',
    ).run(teamId, actor.user.id, actor.conversationId ?? null, action, JSON.stringify(payload));
  }
  function visible(actor: Actor, t: Team) {
    const source = actor.conversationId ? chat(actor.conversationId) : null;
    if (source?.business_team_id && source.business_team_id !== t.id) return false;
    return (
      t.owner_id === actor.user.id ||
      Boolean(
        db
          .prepare('SELECT 1 FROM business_team_members WHERE team_id=? AND user_id=?')
          .get(t.id, actor.user.id),
      )
    );
  }
  function authority(actor: Actor, t: Team, bots: Enrollment[]) {
    if (t.owner_id !== actor.user.id)
      throw new BotError(403, 'Enrollment requires the business owner scope');
    if (!actor.conversationId) return null;
    const source = chat(actor.conversationId);
    const d = db
      .prepare(
        'SELECT * FROM business_delegations WHERE team_id=? AND conversation_id=? AND active=1',
      )
      .get(t.id, actor.conversationId) as
      { allowed_ids_json: string; revision: number } | undefined;
    if (
      !source ||
      source.user_id !== t.owner_id ||
      source.archived ||
      (source.business_team_id && source.business_team_id !== t.id) ||
      !d
    )
      throw new BotError(403, 'No active enrollment delegation for this native bot');
    const allowed = new Set<string>(JSON.parse(d.allowed_ids_json));
    if (bots.some((b) => !allowed.has(b.conversation_id)))
      throw new BotError(403, 'Chat is outside the delegated allowlist');
    return d.revision;
  }
  function inspect(actor: Actor, t: Team, bots: Enrollment[]) {
    const delegation = authority(actor, t, bots);
    if (new Set(bots.map((b) => b.conversation_id)).size !== bots.length)
      throw new BotError(409, 'Duplicate chat in enrollment');
    const rows = bots.map((b) => {
      const c = chat(b.conversation_id);
      if (!c || c.user_id !== t.owner_id) throw new BotError(403, 'Foreign or missing chat');
      const a = db.prepare('SELECT slug FROM assistants WHERE id=?').get(c.assistant_id) as {
        slug: string;
      };
      if (c.archived || c.channel !== 'web' || a.slug === 'platform-dev')
        throw new BotError(409, 'Only active operational native chats may enroll');
      // A chat an agent created inside this business inherits its business id
      // before enrollment (routes/api.ts handoff/child creation), so a same-team
      // id alone is not membership. Membership rows and other businesses still are.
      if (
        (c.business_team_id && c.business_team_id !== t.id) ||
        db.prepare('SELECT 1 FROM business_bot_members WHERE conversation_id=?').get(c.id)
      )
        throw new BotError(409, 'Chat already belongs to a business');
      return {
        id: c.id,
        owner: c.user_id,
        title: c.title,
        project: c.project_id,
        provider: c.provider,
        model: c.model,
        effort: c.effort,
        native_session_id: c.native_session_id,
        visibility: c.visibility,
        assistant_id: c.assistant_id,
        registration:
          db
            .prepare('SELECT name,active FROM bot_registrations WHERE conversation_id=?')
            .get(c.id) ?? null,
      };
    });
    const existing = db
      .prepare('SELECT conversation_id,role,subteam FROM business_bot_members WHERE team_id=?')
      .all(t.id) as Enrollment[];
    const all = [...existing, ...bots];
    if (all.filter((b) => b.role === 'coordinator').length !== 1)
      throw new BotError(409, 'A business must have exactly one coordinator');
    for (const b of bots) {
      if (b.role === 'coordinator' && (b.reports_to || b.subteam))
        throw new BotError(400, 'Coordinator is outside reporting subteams');
      if (b.role === 'lead' && !b.subteam) throw new BotError(400, 'Lead requires a subteam');
      if (b.role === 'bot' && b.subteam && !b.reports_to)
        throw new BotError(400, 'Subteam bots require their lead');
      if (
        b.role === 'lead' &&
        all.filter((p) => p.role === 'lead' && p.subteam === b.subteam).length > 1
      )
        throw new BotError(409, 'Subteam already has a lead');
      if (b.reports_to) {
        const parent = all.find((p) => p.conversation_id === b.reports_to);
        if (
          !parent ||
          parent.role !== 'lead' ||
          !b.subteam ||
          parent.subteam !== b.subteam ||
          b.role !== 'bot'
        )
          throw new BotError(400, 'Reporting parent must be a lead in the same subteam');
      }
    }
    return {
      rows,
      fingerprint: crypto
        .createHash('sha256')
        .update(JSON.stringify({ revision: t.revision, delegation, bots, rows }))
        .digest('hex'),
    };
  }
  return {
    list(actor: Actor) {
      return (db.prepare('SELECT * FROM business_teams ORDER BY name').all() as Team[])
        .filter((t) => visible(actor, t))
        .map((t) => ({
          ...t,
          can_manage: t.owner_id === actor.user.id && !actor.conversationId,
          members:
            t.owner_id === actor.user.id && !actor.conversationId
              ? db
                  .prepare(
                    'SELECT bm.user_id,bm.role,u.display_name,EXISTS(SELECT 1 FROM employee_workspaces ew WHERE ew.user_id=u.id) AS restricted FROM business_team_members bm JOIN users u ON u.id=bm.user_id WHERE bm.team_id=?',
                  )
                  .all(t.id)
              : [],
        }));
    },
    manage(actor: Actor, raw: Record<string, unknown>) {
      const input = manageSchema.parse(raw) as Record<string, unknown>;
      const action = z.enum(['create', 'member', 'employee', 'delegate', 'remove_bot', 'shopify']).parse(input.action);
      return db.transaction(() => {
        if (action === 'create') {
          admin(actor);
          if (actor.user.role !== 'owner')
            throw new BotError(403, 'Owner role required to create a business');
          const name = z.string().trim().min(1).max(120).parse(input.name);
          const existing = db
            .prepare('SELECT * FROM business_teams WHERE owner_id=? AND name=?')
            .get(actor.user.id, name) as Team | undefined;
          if (existing) return existing;
          const teamId = crypto.randomUUID();
          db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,?)').run(
            teamId,
            name,
            actor.user.id,
          );
          audit(actor, teamId, 'created', { name });
          return team(teamId);
        }
        const t = team(id.parse(input.team_id));
        admin(actor, t);
        if (action === 'shopify') {
          db.prepare('UPDATE business_teams SET shopify_store=? WHERE id=?').run(input.shopify_store, t.id);
        } else if (action === 'employee') {
          const userId = z.number().int().positive().parse(input.user_id);
          const email = z.string().email().parse(input.email).toLowerCase();
          const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId) as { email: string; role: string; status: string } | undefined;
          if (!target || target.email !== email || target.role !== 'member' || userId === t.owner_id || target.status === 'disabled')
            throw new BotError(400, 'Choose the correct pending or active member account');
          const ids = z.array(id).min(1).max(100).parse(input.conversation_ids);
          for (const chatId of ids) {
            const c = chat(chatId);
            if (!c || c.business_team_id !== t.id || c.user_id !== t.owner_id || c.visibility !== 'team' || c.archived ||
              !db.prepare('SELECT 1 FROM business_bot_members bm JOIN bot_registrations br ON br.conversation_id=bm.conversation_id WHERE bm.conversation_id=? AND bm.team_id=? AND br.active=1').get(chatId, t.id))
              throw new BotError(400, 'Employee access requires active, shared bots in this business');
          }
          db.prepare('INSERT OR IGNORE INTO employee_workspaces(user_id) VALUES(?)').run(userId);
          db.prepare('DELETE FROM employee_bot_access WHERE user_id=? AND conversation_id IN (SELECT id FROM conversations WHERE business_team_id=?)').run(userId, t.id);
          for (const chatId of ids) {
            db.prepare('INSERT OR IGNORE INTO employee_bot_access VALUES(?,?)').run(userId, chatId);
            db.prepare('INSERT OR IGNORE INTO shared_bot_queues VALUES(?)').run(chatId);
          }
          db.prepare("INSERT INTO business_team_members VALUES(?,?,'member') ON CONFLICT(team_id,user_id) DO UPDATE SET role='member'").run(t.id, userId);
          if (input.activate === true) db.prepare("UPDATE users SET status='active' WHERE id=?").run(userId);
        } else if (action === 'member') {
          const userId = z.number().int().positive().parse(input.user_id);
          const role = z.enum(['viewer', 'member', 'manager']).nullable().parse(input.role);
          const target = db.prepare("SELECT email,role FROM users WHERE id=? AND status='active'").get(userId) as { email: string; role: string } | undefined;
          if (!target)
            throw new BotError(400, 'Active user required');
          if (input.email !== undefined) {
            const email = z.string().trim().email().parse(input.email).toLowerCase();
            if (target.email !== email || target.role !== 'member' || !['member', 'manager'].includes(role ?? ''))
              throw new BotError(400, 'Full workspace access requires the verified member email and member or manager role');
            if (!db.prepare('SELECT 1 FROM business_team_members WHERE team_id=? AND user_id=?').get(t.id, userId))
              throw new BotError(400, 'Full workspace access requires existing membership in this business');
            // The employee restriction is account-wide. A business owner must
            // not clear a restriction for someone belonging to another owner.
            if (db.prepare('SELECT 1 FROM business_team_members m JOIN business_teams t ON t.id=m.team_id WHERE m.user_id=? AND t.owner_id<>?').get(userId, actor.user.id))
              throw new BotError(403, 'Another business owner must review account-wide workspace access');
            db.prepare('DELETE FROM employee_bot_access WHERE user_id=?').run(userId);
            db.prepare('DELETE FROM employee_workspaces WHERE user_id=?').run(userId);
          }
          if (role)
            db.prepare(
              'INSERT INTO business_team_members(team_id,user_id,role) VALUES(?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role',
            ).run(t.id, userId, role);
          else {
            db.prepare('DELETE FROM employee_bot_access WHERE user_id=? AND conversation_id IN (SELECT id FROM conversations WHERE business_team_id=?)').run(userId, t.id);
            db.prepare('DELETE FROM business_team_members WHERE team_id=? AND user_id=?').run(
              t.id,
              userId,
            );
          }
        } else if (action === 'delegate') {
          const chatId = id.parse(input.conversation_id);
          const c = chat(chatId);
          const allowed = z.array(id).max(100).parse(input.allowed_ids);
          if (!c || c.user_id !== t.owner_id || (c.business_team_id && c.business_team_id !== t.id))
            throw new BotError(403, 'Delegate must be an owned native chat in this business');
          if (
            new Set(allowed).size !== allowed.length ||
            allowed.some((value) => {
              const target = chat(value);
              return (
                !target ||
                target.user_id !== t.owner_id ||
                (target.business_team_id && target.business_team_id !== t.id)
              );
            })
          )
            throw new BotError(403, 'Invalid delegated allowlist');
          db.prepare(
            'INSERT INTO business_delegations(team_id,conversation_id,allowed_ids_json,active) VALUES(?,?,?,?) ON CONFLICT(team_id,conversation_id) DO UPDATE SET allowed_ids_json=excluded.allowed_ids_json,active=excluded.active,revision=revision+1',
          ).run(t.id, chatId, JSON.stringify(allowed), Number(allowed.length > 0));
        } else {
          const chatId = id.parse(input.conversation_id);
          if (
            !db
              .prepare('SELECT 1 FROM business_bot_members WHERE team_id=? AND conversation_id=?')
              .get(t.id, chatId)
          )
            throw new BotError(404, 'Membership not found');
          if (db.prepare('SELECT 1 FROM business_bot_members WHERE reports_to=?').get(chatId))
            throw new BotError(409, 'Remove reporting members before their lead');
          const prior = db
            .prepare(
              'SELECT prior_registration_json,role FROM business_bot_members WHERE conversation_id=?',
            )
            .get(chatId) as { prior_registration_json: string | null; role: string };
          if (
            prior.role === 'coordinator' &&
            (
              db
                .prepare('SELECT COUNT(*) AS n FROM business_bot_members WHERE team_id=?')
                .get(t.id) as { n: number }
            ).n > 1
          )
            throw new BotError(409, 'Remove other members before the coordinator');
          db.prepare('DELETE FROM employee_bot_access WHERE conversation_id=?').run(chatId);
          db.prepare('DELETE FROM shared_bot_queues WHERE conversation_id=?').run(chatId);
          db.prepare('DELETE FROM business_bot_members WHERE team_id=? AND conversation_id=?').run(
            t.id,
            chatId,
          );
          db.prepare('UPDATE conversations SET business_team_id=NULL WHERE id=?').run(chatId);
          if (prior.prior_registration_json) {
            const old = JSON.parse(prior.prior_registration_json);
            db.prepare('UPDATE bot_registrations SET active=?,name=? WHERE conversation_id=?').run(
              old.active,
              old.name,
              chatId,
            );
          } else
            db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(chatId);
          db.prepare(
            'UPDATE business_delegations SET active=0,revision=revision+1 WHERE team_id=? AND conversation_id=?',
          ).run(t.id, chatId);
        }
        db.prepare('UPDATE business_teams SET revision=revision+1 WHERE id=?').run(t.id);
        audit(actor, t.id, action, input);
        return team(t.id);
      })();
    },
    bulk(actor: Actor, raw: unknown) {
      const input = bulkSchema.parse(raw);
      return db.transaction(() => {
        const t = team(input.team_id);
        if (input.mode === 'preview') {
          const previous = db
            .prepare(
              'SELECT * FROM business_previews WHERE actor_id=? AND actor_chat=? AND request_key=?',
            )
            .get(actor.user.id, actor.conversationId ?? '', input.request_key) as
            { id: string; payload_json: string; team_id: string } | undefined;
          authority(actor, t, input.bots);
          if (previous) {
            if (previous.payload_json !== JSON.stringify(input.bots) || previous.team_id !== t.id)
              throw new BotError(409, 'Request key was used for a different enrollment');
            return { preview_id: previous.id, team_id: t.id, bots: input.bots };
          }
          const inspected = inspect(actor, t, input.bots);
          const previewId = crypto.randomUUID();
          db.prepare(
            'INSERT INTO business_previews(id,team_id,actor_id,actor_chat,request_key,payload_json,fingerprint) VALUES(?,?,?,?,?,?,?)',
          ).run(
            previewId,
            t.id,
            actor.user.id,
            actor.conversationId ?? '',
            input.request_key,
            JSON.stringify(input.bots),
            inspected.fingerprint,
          );
          audit(actor, t.id, 'preview', { preview_id: previewId, bots: input.bots });
          return {
            preview_id: previewId,
            team_id: t.id,
            bots: input.bots,
            verified: inspected.rows,
          };
        }
        const p = db
          .prepare(
            'SELECT * FROM business_previews WHERE id=? AND team_id=? AND actor_id=? AND actor_chat=?',
          )
          .get(input.preview_id, t.id, actor.user.id, actor.conversationId ?? '') as
          { payload_json: string; fingerprint: string; receipt_json: string | null } | undefined;
        if (!p) throw new BotError(404, 'Preview not found for this actor');
        const bots = JSON.parse(p.payload_json) as Enrollment[];
        authority(actor, t, bots);
        if (p.receipt_json) return JSON.parse(p.receipt_json);
        if (inspect(actor, t, bots).fingerprint !== p.fingerprint)
          throw new BotError(409, 'Enrollment changed; create a fresh preview');
        for (const b of bots) {
          const prior = db
            .prepare('SELECT name,active FROM bot_registrations WHERE conversation_id=?')
            .get(b.conversation_id);
          db.prepare(
            'INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,?) ON CONFLICT(conversation_id) DO UPDATE SET name=excluded.name,active=1',
          ).run(b.conversation_id, b.name, actor.user.id);
          db.prepare(
            'INSERT INTO business_bot_members(conversation_id,team_id,role,subteam,reports_to,prior_registration_json) VALUES(?,?,?,?,?,?)',
          ).run(
            b.conversation_id,
            t.id,
            b.role,
            b.subteam,
            b.reports_to,
            prior ? JSON.stringify(prior) : null,
          );
          db.prepare(
            'UPDATE conversations SET business_team_id=? WHERE id=? AND business_team_id IS NULL',
          ).run(t.id, b.conversation_id);
        }
        const receipt = { team_id: t.id, preview_id: input.preview_id, enrolled: bots };
        db.prepare(
          "UPDATE business_previews SET applied_at=datetime('now'),receipt_json=? WHERE id=? AND receipt_json IS NULL",
        ).run(JSON.stringify(receipt), input.preview_id);
        db.prepare('UPDATE business_teams SET revision=revision+1 WHERE id=?').run(t.id);
        audit(actor, t.id, 'enrolled', receipt);
        return receipt;
      })();
    },
  };
}
