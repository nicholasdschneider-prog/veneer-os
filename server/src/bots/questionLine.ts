import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { createBotService } from './service.js';

export const lineActionSchema = z.object({
  action: z.enum(['select', 'show', 'back', 'remind', 'clear']),
  decisionId: z.string().min(1).max(200).optional(),
  until: z.number().int().positive().optional(),
  revision: z.number().int().nonnegative(),
}).strict();

export function questionLine(ctx: Pick<AppContext, 'db'>, user: UserRow) {
  const service = createBotService(ctx.db);
  const state = () => ctx.db.prepare('SELECT selected_id, show_evidence, revision FROM question_line_state WHERE user_id=?').get(user.id) as { selected_id: string | null; show_evidence: number; revision: number } | undefined;
  const snapshot = () => {
    const { waiting: all, history } = service.questionLineData({ user });
    const positions = ctx.db.prepare('SELECT decision_id,served_ms,until_ms FROM question_line_positions WHERE user_id=?').all(user.id) as { decision_id: string; served_ms: number; until_ms: number }[];
    const prefs = new Map(positions.map(p => [p.decision_id, p]));
    const now = Date.now();
    const waiting = all.filter(d => d.state === 'needs_input' && !d.dismissed && !d.stale?.resolved && (d.can_answer || d.can_handle));
    const asleep = waiting.filter(d => (prefs.get(d.id)?.until_ms ?? 0) > now);
    const ready = waiting.filter(d => (prefs.get(d.id)?.until_ms ?? 0) <= now);
    const groups = new Map<string, typeof ready>();
    const served = new Map<string, number>();
    const answerOrder=new Map<string,number>();
    const answers=new Map((ctx.db.prepare("SELECT decision_id,created_at,max(rowid) AS ordinal FROM bot_decision_events WHERE kind='answered' GROUP BY decision_id").all() as {decision_id:string;created_at:string;ordinal:number}[]).map(a=>[a.decision_id,a]));
    for (const d of history) {
      const answer=answers.get(d.id);
      const at = Math.max(prefs.get(d.id)?.served_ms ?? 0, answer ? Date.parse(answer.created_at.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(answer.created_at) ? '' : 'Z')) || 0 : 0);
      answerOrder.set(d.conversation_id,Math.max(answerOrder.get(d.conversation_id)??0,answer?.ordinal??0));
      served.set(d.conversation_id, Math.max(served.get(d.conversation_id) ?? 0, at));
    }
    for (const d of ready.sort((a,b) => (prefs.get(a.id)?.served_ms ?? 0) - (prefs.get(b.id)?.served_ms ?? 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
      const group = groups.get(d.conversation_id) ?? []; group.push(d); groups.set(d.conversation_id, group);
    }
    const bots = [...groups.keys()].sort((a,b) => (served.get(a) ?? 0) - (served.get(b) ?? 0) || (answerOrder.get(a)??0)-(answerOrder.get(b)??0) || groups.get(a)![0]!.created_at.localeCompare(groups.get(b)![0]!.created_at) || a.localeCompare(b));
    const decisions: typeof ready = [];
    for (let round = 0; decisions.length < ready.length; round++) for (const bot of bots) { const d = groups.get(bot)![round]; if (d) decisions.push(d); }
    const s = state();
    return { decisions, sleeping: asleep.map(d => ({ ...d, until: prefs.get(d.id)!.until_ms })), selectedId: ready.some(d => d.id === s?.selected_id) ? s!.selected_id : null, showEvidence:!!s?.show_evidence, revision: s?.revision ?? 0 };
  };
  const mutate = (input: unknown) => ctx.db.transaction(() => {
    const a = lineActionSchema.parse(input);
    const current = snapshot();
    if (a.revision !== current.revision) throw new Error('The question line changed. Refresh before trying again.');
    if (a.action !== 'clear' && ![...current.decisions, ...current.sleeping].some(d => d.id === a.decisionId)) throw new Error('Question is no longer available.');
    if (a.action === 'remind' && (!a.until || a.until <= Date.now() || a.until > Date.now() + 30 * 86400000)) throw new Error('Choose a reminder within the next 30 days.');
    if (a.action === 'back' || a.action === 'remind') ctx.db.prepare(`INSERT INTO question_line_positions(user_id,decision_id,served_ms,until_ms) VALUES(?,?,?,?) ON CONFLICT(user_id,decision_id) DO UPDATE SET served_ms=excluded.served_ms,until_ms=excluded.until_ms`).run(user.id, a.decisionId, Date.now(), a.action === 'remind' ? a.until : 0);
    if (a.action === 'select' || a.action === 'show') ctx.db.prepare('UPDATE question_line_positions SET until_ms=0 WHERE user_id=? AND decision_id=?').run(user.id, a.decisionId);
    ctx.db.prepare(`INSERT INTO question_line_state(user_id,selected_id,show_evidence,revision) VALUES(?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET selected_id=excluded.selected_id,show_evidence=excluded.show_evidence,revision=question_line_state.revision+1`).run(user.id, a.action === 'select' || a.action === 'show' ? a.decisionId : null,Number(a.action==='show'));
    return snapshot();
  })();
  return { snapshot, mutate };
}
