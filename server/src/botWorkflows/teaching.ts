import { narrationText } from './teachingAudio.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  canManageConversation,
  canTrainBusinessBot,
} from '../conversations/access.js';
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { BotError } from '../bots/service.js';
import { routineChat } from './routines.js';
import { sanitizeMemoryText } from '../memory/capture.js';
import { createSkillStore } from '../skills/store.js';
export interface Teaching {
  id: string;
  conversation_id: string;
  user_id: number;
  name: string;
  outcome: string;
  state: string;
  started_at: string;
  expires_at: string;
  steps_json: string;
  draft: string;
  skill_name: string | null;
  test_requested_at: string | null;
}
export function teachingSession(ctx: AppContext, user: UserRow, id: string) {
  const t = ctx.db
    .prepare('SELECT * FROM bot_teaching_sessions WHERE id=? AND user_id=?')
    .get(id, user.id) as Teaching | undefined;
  if (!t) throw new BotError(404, 'Teaching session not found');
  const active = ctx.db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(user.id) as UserRow | undefined;
  if (!active) throw new BotError(403, 'Training access revoked');
  const c = routineChat(ctx.db, active, t.conversation_id);
  if (!canManageConversation(active,c,ctx.db) && !canTrainBusinessBot(active,c,ctx.db)) throw new BotError(403,'Training access required');
  return t;
}
export function recording(
  ctx: AppContext,
  conversationId: string,
  userId: number,
) {
  return ctx.db
    .prepare(
      "SELECT * FROM bot_teaching_sessions WHERE conversation_id=? AND user_id=? AND state='recording' AND expires_at>?",
    )
    .get(conversationId, userId, new Date().toISOString()) as
    Teaching | undefined;
}
export function recordTeachingStep(
  ctx: AppContext,
  conversationId: string,
  userId: number,
  input: unknown,
) {
  const t = recording(ctx, conversationId, userId);
  if (!t) return;
  const user = ctx.db
    .prepare("SELECT * FROM users WHERE id=? AND status='active'")
    .get(userId) as UserRow | undefined;
  if (!user) return;
  try {
    routineChat(ctx.db, user, conversationId);
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  const raw = input as Record<string, unknown>;
  if (raw.sensitive === true) return; // Password forms, credential pages and uninspectable frames fail closed.
  if (
    typeof raw.action !== 'string' ||
    !['click', 'input', 'navigate', 'key', 'scroll'].includes(raw.action)
  )
    return;
  const step = {
    action: raw.action,
    target: sanitizeMemoryText(String(raw.target ?? '')).slice(0, 180),
    url: safeTeachingUrl(String(raw.url ?? '')),
  };
  if (!step.url) return;
  const steps = JSON.parse(t.steps_json) as (typeof step)[];
  if (steps.length >= 300) return;
  const last = steps.at(-1);
  if (last && last.action===step.action && last.target===step.target && last.url===step.url) return;
  steps.push({ ...step, offset_ms: Math.max(0,Date.now()-Date.parse(t.started_at)) } as typeof step);
  ctx.db
    .prepare(
      "UPDATE bot_teaching_sessions SET steps_json=? WHERE id=? AND state='recording'",
    )
    .run(JSON.stringify(steps), t.id);
}
export function safeTeachingUrl(value: string) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return (
      u.origin +
      u.pathname
        .split('/')
        .map((p) => (p.length > 40 ? '[parameter]' : p))
        .join('/')
    );
  } catch {
    return '';
  }
}
export function teachingDraft(t: Teaching) {
  const steps = JSON.parse(t.steps_json) as {
    action: string;
    target: string;
    url: string;
    offset_ms?: number;
  }[];
  return `# ${t.name}\n\n## When to use\n${t.outcome}\n\n## Inputs and access\nUse the current authorized browser session. Replace example-specific inputs with values supplied for this task. Typed values and login steps were not recorded.\n\n## Demonstrated path\n${steps.map((s, i) => `${i + 1}. ${s.offset_ms === undefined ? '' : `[${(s.offset_ms / 1000).toFixed(1)}s] `}${s.action === 'input' ? 'Enter the task-specific input in' : s.action === 'click' ? 'Select' : s.action} ${s.target || 'the demonstrated control'} on ${s.url}.`).join('\n') || 'No actions were captured. Add the workflow steps before saving.'}\n\n## Decision rules\nConfirm the current task scope and required inputs. Stop when the page or expected state differs. Follow existing approval requirements for external actions.\n\n## Validate the result\nCheck the result against the original request and cite the current source. Test on a second example before creating a routine.\n\n## Output\nReturn the verified result, source links, and any unresolved exceptions.\n`;
}
export function startTeaching(
  ctx: AppContext,
  user: UserRow,
  conversation: string,
  name: string,
  outcome: string,
) {
  const c = routineChat(ctx.db, user, conversation);
  if (user.status !== 'active' || (!canManageConversation(user,c,ctx.db) && !canTrainBusinessBot(user,c,ctx.db))) throw new BotError(403,'Training access required');
  if (!c.project_id)
    throw new BotError(400, 'Put this bot in a project before teaching');
  ctx.db
    .prepare(
      "UPDATE bot_teaching_sessions SET state='draft' WHERE conversation_id=? AND state IN ('recording','paused') AND expires_at<=?",
    )
    .run(c.id, new Date().toISOString());
  if (
    ctx.db
      .prepare(
        "SELECT 1 FROM bot_teaching_sessions WHERE conversation_id=? AND state IN ('recording','paused')",
      )
      .get(c.id)
  )
    throw new BotError(409, 'A demonstration is already running');
  const id = crypto.randomUUID(),
    now = new Date();
  ctx.db
    .prepare(
      "INSERT INTO bot_teaching_sessions(id,conversation_id,user_id,name,outcome,state,started_at,expires_at) VALUES(?,?,?,?,?,'recording',?,?)",
    )
    .run(
      id,
      c.id,
      user.id,
      name,
      outcome,
      now.toISOString(),
      new Date(now.getTime() + 600000).toISOString(),
    );
  return teachingSession(ctx, user, id);
}
export function finishTeaching(ctx: AppContext, user: UserRow, id: string) {
  const t = teachingSession(ctx, user, id);
  if (!['recording', 'paused', 'draft'].includes(t.state))
    throw new BotError(409, 'Session already finished');
  const draft = teachingDraft(t) + narrationText(ctx,t.id);
  ctx.db
    .prepare(
      "UPDATE bot_teaching_sessions SET state='draft',draft=? WHERE id=?",
    )
    .run(draft, id);
  return { ...t, state: 'draft', draft };
}
export function saveTeaching(
  ctx: AppContext,
  user: UserRow,
  id: string,
  skillName: string,
  draft: string,
) {
  const t = teachingSession(ctx, user, id);
  if (t.state !== 'draft')
    throw new BotError(409, 'Stop and review the demonstration first');
  if (ctx.db.prepare('SELECT 1 FROM bot_teaching_audio WHERE session_id=? AND transcript IS NULL').get(id)) throw new BotError(409,'Transcribe, enter a transcript, or remove unavailable narration before saving');
  const narration = narrationText(ctx,id);
  if ((narration && !draft.includes(narration.trim())) || (!narration && draft.includes('## Narration (demonstration evidence)')))  throw new BotError(409,'Update the draft from the current narration before saving');
  const c = routineChat(ctx.db, user, t.conversation_id);
  if (
    !canManageConversation(user, c, ctx.db) &&
    !canTrainBusinessBot(user, c, ctx.db)
  )
    throw new BotError(403, 'Project training access required');
  if (!c.project_id) throw new BotError(400, 'Project required');
  if (user.role === 'member') {
    const project = ctx.db
      .prepare('SELECT slug,root_dir FROM projects WHERE id=?')
      .get(c.project_id) as { slug: string; root_dir: string | null };
    const rootPath =
      project.root_dir ??
      path.join(ctx.config.dataDir, 'workspaces', 'projects', project.slug);
    const root = fs.existsSync(rootPath)
      ? fs.realpathSync(rootPath)
      : path.resolve(rootPath);
    for (const folder of [
      '.agents',
      '.agents/skills',
      '.claude',
      '.claude/skills',
      '.grok',
      '.grok/skills',
    ]) {
      const target = path.join(root, folder);
      if (!fs.existsSync(target)) continue;
      const relative = path.relative(root, fs.realpathSync(target));
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new BotError(403, 'Training paths must stay inside the project');
    }
  }
  const result = createSkillStore({ config: ctx.config, db: ctx.db }).create(
    `project:${c.project_id}`,
    skillName,
    t.outcome,
    sanitizeMemoryText(draft),
  );
  ctx.db
    .prepare(
      "UPDATE bot_teaching_sessions SET state='saved',draft=?,skill_name=? WHERE id=?",
    )
    .run(sanitizeMemoryText(draft), skillName, id);
  return result;
}
/** Runs in the browser through its existing manager ticket. Never reads an input value. */
export function teachingProbe(action: string, x?: number, y?: number) {
  return `(()=>{const action=${JSON.stringify(action)};const e=${Number.isFinite(x) && Number.isFinite(y) ? `document.elementFromPoint(${Number(x)},${Number(y)})` : 'document.activeElement'};
 const sensitive=!!document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"]')||/login|signin|sign-in|oauth|authorize|verify|two-factor|mfa|secret|credential/i.test(location.pathname)||!e||e.tagName==='IFRAME';
 if(sensitive)return {sensitive:true};const el=e.closest('button,a,input,select,textarea,[role="button"]')||e;
 const type=el.tagName.toLowerCase();const label=el.getAttribute('aria-label')||el.getAttribute('placeholder')||(type==='button'?(el.textContent||'').slice(0,120):'');
 return {action,target:type+(label?' '+label:''),url:location.origin+location.pathname};})()`;
}
