import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRow, ConversationRow } from '../db/db.js';
import { routineChat, type Routine } from './routines.js';
import { BotError } from '../bots/service.js';
import { canManageConversation } from '../conversations/access.js';
import { ensureConversationInstructionSnapshot } from '../instructions/context.js';
import { canUserAccessModel } from '../routes/modelAccess.js';
import { createSkillStore } from '../skills/store.js';
import { sanitizeMemoryText } from '../memory/capture.js';

export const TemplateConfig = z
  .object({
    description: z.string().max(20000),
    provider: z.enum(['claude', 'codex', 'grok', 'openrouter']),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    project_id: z.string().nullable(),
    skills: z.array(z.string().max(100)).max(100),
    routines: z
      .array(
        z.object({
          name: z.string(),
          instructions: z.string(),
          kind: z.enum(['schedule', 'ticket.created', 'customer.replied']),
          source: z.string(),
          schedule_json: z.string().nullable(),
          timezone: z.string(),
        }),
      )
      .max(100),
  })
  .strict();
export interface Template {
  id: string;
  team_id: string | null;
  created_by: number;
  source_conversation_id: string | null;
  name: string;
  config_json: string;
}
export function templateVisible(ctx: AppContext, user: UserRow, t: Template) {
  if (!t.team_id) return t.created_by === user.id;
  return Boolean(
    ctx.db
      .prepare(
        `SELECT 1 FROM business_teams t WHERE t.id=? AND (t.owner_id=? OR EXISTS(SELECT 1 FROM business_team_members m WHERE m.team_id=t.id AND m.user_id=?))`,
      )
      .get(t.team_id, user.id, user.id),
  );
}
export function templateDraft(ctx: AppContext, user: UserRow, id: string) {
  const c = routineChat(ctx.db, user, id, true);
  const a = ctx.db
    .prepare('SELECT instructions FROM assistants WHERE id=?')
    .get(c.assistant_id) as { instructions: string };
  const routines = ctx.db
    .prepare(
      'SELECT name,instructions,kind,source,schedule_json,timezone FROM bot_routines WHERE conversation_id=?',
    )
    .all(id) as Routine[];
  const skills = createSkillStore({ config: ctx.config, db: ctx.db })
    .list(user.role)
    .scopes.filter(
      (s) => s.scope === 'global' || s.scope === `project:${c.project_id}`,
    )
    .flatMap((s) => s.skills.filter((k) => k.enabled).map((k) => k.name));
  return {
    description: sanitizeMemoryText(a.instructions),
    provider: c.provider,
    model: c.model,
    effort: c.effort,
    project_id: c.project_id,
    skills,
    routines,
  };
}
export function saveTemplate(
  ctx: AppContext,
  user: UserRow,
  source: string,
  name: string,
  config: unknown,
) {
  const c = routineChat(ctx.db, user, source, true),
    p = TemplateConfig.parse(config),
    id = crypto.randomUUID();
  // Template author chooses reviewed instructions; no transcript or credential metadata is serialized.
  if (p.project_id !== c.project_id)
    throw new BotError(
      400,
      'Templates keep the source project; create a new bot to change projects',
    );
  if (!canUserAccessModel(user.email, p.provider, p.model))
    throw new BotError(403, 'Model unavailable');
  p.description = sanitizeMemoryText(p.description);
  p.routines = p.routines.map((r) => ({
    ...r,
    instructions: sanitizeMemoryText(r.instructions),
  }));
  ctx.db
    .prepare(
      'INSERT INTO bot_templates(id,source_conversation_id,team_id,created_by,name,config_json) VALUES(?,?,?,?,?,?)',
    )
    .run(
      id,
      c.id,
      c.business_team_id ?? null,
      user.id,
      name,
      JSON.stringify(p),
    );
  return id;
}
export function instantiateTemplate(
  ctx: AppContext,
  user: UserRow,
  t: Template,
  name: string,
  scope: string,
) {
  if (!templateVisible(ctx, user, t))
    throw new BotError(404, 'Template unavailable');
  if (
    t.team_id &&
    !ctx.db
      .prepare(
        `SELECT 1 FROM business_teams t WHERE t.id=? AND (t.owner_id=? OR EXISTS(SELECT 1 FROM business_team_members m WHERE m.team_id=t.id AND m.user_id=? AND m.role='manager'))`,
      )
      .get(t.team_id, user.id, user.id)
  )
    throw new BotError(403, 'Business manager access required');
  if (user.role === 'member' && !t.team_id)
    throw new BotError(403, 'Manager access required');
  const p = TemplateConfig.parse(JSON.parse(t.config_json));
  if (t.source_conversation_id) {
    const source = ctx.db
      .prepare('SELECT * FROM conversations WHERE id=?')
      .get(t.source_conversation_id) as ConversationRow | undefined;
    if (!source || !canManageConversation(user, source, ctx.db))
      throw new BotError(403, 'Source bot access changed');
  }
  if (!canUserAccessModel(user.email, p.provider, p.model))
    throw new BotError(403, 'Model unavailable');
  const id = crypto.randomUUID();
  ctx.db.transaction(() => {
    const assistant = ctx.db
      .prepare(
        `INSERT INTO assistants(slug,name,instructions,default_provider,default_model) VALUES(?,?,?,?,?)`,
      )
      .run(
        `bot-${id}`,
        name,
        `${p.description}\n\nAssigned scope: ${scope}\nSkills to use when available: ${p.skills.join(', ') || 'Review the project skill library.'}\nCheck required account access before work. No permissions or approvals transfer from the template.`,
        p.provider,
        p.model,
      );
    ctx.db
      .prepare(
        `INSERT INTO conversations(id,assistant_id,user_id,visibility,project_id,title,title_auto,provider,model,effort,approval_mode,native_session_id,channel,business_team_id) VALUES(?,?,?,'private',?,?,0,?,?,?,'ask',?,'web',?)`,
      )
      .run(
        id,
        assistant.lastInsertRowid,
        user.id,
        p.project_id,
        name,
        p.provider,
        p.model,
        p.effort,
        crypto.randomUUID(),
        t.team_id,
      );
    ctx.db
      .prepare(
        'INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,?)',
      )
      .run(id, name, user.id);
    if (t.team_id) {
      ctx.db
        .prepare("UPDATE conversations SET visibility='team' WHERE id=?")
        .run(id);
      ctx.db
        .prepare(
          "INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES(?,?,'bot')",
        )
        .run(id, t.team_id);
    }
    for (const r of p.routines)
      ctx.db
        .prepare(
          'INSERT INTO bot_routines(id,conversation_id,created_by,name,instructions,kind,source,schedule_json,timezone,enabled) VALUES(?,?,?,?,?,?,?,?,?,0)',
        )
        .run(
          crypto.randomUUID(),
          id,
          user.id,
          r.name,
          r.instructions,
          r.kind,
          r.source,
          r.schedule_json,
          r.timezone,
        );
    ensureConversationInstructionSnapshot(ctx.db, id);
  })();
  return id;
}
