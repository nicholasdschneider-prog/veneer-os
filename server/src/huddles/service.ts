import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ConversationRow, ConversationWakeupRow, UserRow } from '../db/db.js';
import {
  canManageConversation,
  canSendToConversation,
  canViewConversation,
} from '../conversations/access.js';

/**
 * Huddles: focused group threads where three to six persistent bots coordinate
 * one outcome. A huddle is a message board, not a conversation: every member
 * keeps running in its own chat with its own identity, permissions and tools,
 * and joining grants nothing. Delivery to a bot is a durable wake of its own
 * chat (conversation_wakeups), so nothing is lost across restarts; the runner
 * reconciles cursors and re-wakes bots that still have undelivered messages.
 */

export type Actor = { user: UserRow; conversationId?: string };

export class HuddleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MIN_BOT_MEMBERS = 3;
export const MIN_HUMAN_CREATED_MEMBERS = 2;
export const MAX_MEMBERS = 6;
/** One wake per member per huddle at most this often; later posts coalesce. */
export const WAKE_SPACING_MS = 30_000;
/** Posting limits that stop reply storms before they burn every turn. */
export const BOT_POSTS_PER_10_MIN = 10;
export const BOT_POSTS_PER_HOUR = 30;
export const HUDDLE_POSTS_PER_HOUR = 150;
const WAKE_KEY_PREFIX = 'huddle:';

export interface HuddleRow {
  id: string;
  scope_key: string;
  business_team_id: string | null;
  goal: string;
  why: string;
  dedupe_key: string;
  status: 'open' | 'closed';
  status_note: string;
  lead_conversation_id: string;
  owner_conversation_id: string | null;
  created_by_user_id: number;
  created_by_conversation_id: string | null;
  request_key: string | null;
  last_seq: number;
  closed_at: string | null;
  closed_by: string | null;
  close_verification: string | null;
  reopened_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface HuddleMemberRow {
  huddle_id: string;
  conversation_id: string;
  role: 'lead' | 'member';
  invited_by: string;
  joined_at: string;
  left_at: string | null;
  delivered_seq: number;
  read_seq: number;
  wake_seq: number;
  pending_wakeup_id: string | null;
  last_wake_at: string | null;
}
export interface HuddleMessageRow {
  id: string;
  huddle_id: string;
  seq: number;
  kind: 'message' | 'handoff' | 'status' | 'system';
  author_conversation_id: string | null;
  author_user_id: number | null;
  author_name: string;
  body: string;
  targets_json: string;
  recipients_json: string;
  action_id: string | null;
  request_key: string | null;
  created_at: string;
}
export interface HuddleActionRow {
  id: string;
  huddle_id: string;
  title: string;
  owner_conversation_id: string | null;
  status: 'open' | 'done' | 'blocked' | 'cancelled';
  depends_on_json: string;
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface HuddleParticipant {
  conversation_id: string;
  name: string;
  title: string | null;
  archived: boolean;
}
export interface HuddleMemberView extends HuddleParticipant {
  role: 'lead' | 'member';
  joined_at: string;
  left_at: string | null;
  unread: number;
  pending_wake: boolean;
  last_wake_at: string | null;
}
export interface HuddleMessageView {
  id: string;
  seq: number;
  kind: HuddleMessageRow['kind'];
  author: { conversation_id: string | null; user_id: number | null; name: string };
  body: string;
  targets: string[];
  recipients: string[];
  action_id: string | null;
  created_at: string;
}
export interface HuddleActionView {
  id: string;
  title: string;
  owner: HuddleParticipant | null;
  status: HuddleActionRow['status'];
  depends_on: string[];
  blocked_by: string[];
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export interface HuddleSummary {
  id: string;
  goal: string;
  why: string;
  status: 'open' | 'closed';
  status_note: string;
  business_team_id: string | null;
  lead: HuddleParticipant;
  owner: HuddleParticipant | null;
  member_count: number;
  open_action_count: number;
  last_seq: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  reopened_at: string | null;
  /** For a bot actor: messages addressed to it that it has not read. */
  my_unread: number;
  my_role: 'lead' | 'member' | 'left' | 'observer';
}
export interface HuddleView extends HuddleSummary {
  members: HuddleMemberView[];
  actions: HuddleActionView[];
  messages: HuddleMessageView[];
  close_verification: string | null;
  closed_by: string | null;
  can_post: boolean;
  can_manage: boolean;
  my_conversation_id: string | null;
}

const idList = z.array(z.string().min(1).max(200)).max(MAX_MEMBERS);
export const openSchema = z.object({
  goal: z.string().trim().min(8).max(300),
  why: z.string().trim().min(8).max(600),
  members: idList.default([]),
  lead: z.string().min(1).max(200).optional(),
  dedupe_key: z.string().trim().min(1).max(160).optional(),
  request_key: z.string().trim().min(1).max(200).optional(),
});
export const postSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  targets: idList.default([]),
  kind: z.enum(['message', 'handoff', 'status']).default('message'),
  request_key: z.string().trim().min(1).max(200).optional(),
});
export const actionSchema = z.object({
  title: z.string().trim().min(2).max(300),
  owner: z.string().min(1).max(200).nullable().optional(),
  depends_on: z.array(z.string().min(1).max(200)).max(20).default([]),
  note: z.string().trim().max(2000).default(''),
});
export const actionPatchSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  owner: z.string().min(1).max(200).nullable().optional(),
  status: z.enum(['open', 'done', 'blocked', 'cancelled']).optional(),
  depends_on: z.array(z.string().min(1).max(200)).max(20).optional(),
  note: z.string().trim().max(2000).optional(),
});
export const patchSchema = z.object({
  lead: z.string().min(1).max(200).optional(),
  owner: z.string().min(1).max(200).nullable().optional(),
  status_note: z.string().trim().max(600).optional(),
  goal: z.string().trim().min(8).max(300).optional(),
  leave: z.boolean().optional(),
});

export function dedupeKeyFor(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 120);
}

function parseIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function createHuddleService(
  db: Database.Database,
  { now = () => new Date(), log = console }: { now?: () => Date; log?: Pick<Console, 'info' | 'warn' | 'error'> } = {},
) {
  const iso = () => now().toISOString();
  const conversation = (id: string) =>
    db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow | undefined;
  const huddleById = db.prepare('SELECT * FROM huddles WHERE id=?');
  const memberRow = db.prepare('SELECT * FROM huddle_members WHERE huddle_id=? AND conversation_id=?');
  const membersOf = db.prepare('SELECT * FROM huddle_members WHERE huddle_id=? ORDER BY joined_at, conversation_id');
  const actionsOf = db.prepare('SELECT * FROM huddle_actions WHERE huddle_id=? ORDER BY created_at, id');
  const registration = db.prepare('SELECT name, active FROM bot_registrations WHERE conversation_id=?');

  function botName(conversationId: string): string {
    const r = registration.get(conversationId) as { name: string } | undefined;
    if (r?.name) return r.name;
    return conversation(conversationId)?.title?.trim() || 'Bot';
  }
  function participant(conversationId: string): HuddleParticipant {
    const c = conversation(conversationId);
    return { conversation_id: conversationId, name: botName(conversationId), title: c?.title ?? null, archived: Boolean(c?.archived) };
  }
  function actorName(actor: Actor): string {
    return actor.conversationId ? botName(actor.conversationId) : actor.user.display_name;
  }
  function huddle(id: string): HuddleRow {
    const h = huddleById.get(id) as HuddleRow | undefined;
    if (!h) throw new HuddleError(404, 'Huddle not found');
    return h;
  }
  function activeMembers(h: HuddleRow): HuddleMemberRow[] {
    return (membersOf.all(h.id) as HuddleMemberRow[]).filter((m) => !m.left_at);
  }

  // ── Access ────────────────────────────────────────────────────────────────
  /** Humans see a huddle when they can view its lead bot; bots only when they are or were members. */
  function visible(actor: Actor, h: HuddleRow): boolean {
    if (actor.conversationId) return Boolean(memberRow.get(h.id, actor.conversationId));
    const lead = conversation(h.lead_conversation_id);
    return Boolean(lead && canViewConversation(actor.user, lead, db));
  }
  function readable(actor: Actor, id: string): HuddleRow {
    const h = huddle(id);
    if (!visible(actor, h)) throw new HuddleError(404, 'Huddle not found');
    return h;
  }
  function humanCanPost(actor: Actor, h: HuddleRow): boolean {
    const lead = conversation(h.lead_conversation_id);
    return Boolean(lead && canSendToConversation(actor.user, lead, db));
  }
  function humanCanManage(actor: Actor, h: HuddleRow): boolean {
    const lead = conversation(h.lead_conversation_id);
    return Boolean(lead && canManageConversation(actor.user, lead, db));
  }
  /** Active member bot, or a human allowed to send to the lead bot. */
  function poster(actor: Actor, id: string): HuddleRow {
    const h = readable(actor, id);
    if (actor.conversationId) {
      const m = memberRow.get(h.id, actor.conversationId) as HuddleMemberRow | undefined;
      if (!m || m.left_at) throw new HuddleError(403, 'You are no longer a member of this huddle');
    } else if (!humanCanPost(actor, h)) throw new HuddleError(403, 'You cannot post in this huddle');
    return h;
  }
  /** The lead bot, or a human who manages the lead bot. */
  function manager(actor: Actor, id: string): HuddleRow {
    const h = readable(actor, id);
    if (actor.conversationId) {
      if (actor.conversationId !== h.lead_conversation_id)
        throw new HuddleError(403, 'Only the huddle lead may do this; ask the lead in the huddle');
    } else if (!humanCanManage(actor, h)) throw new HuddleError(403, 'You cannot manage this huddle');
    return h;
  }
  function open(h: HuddleRow) {
    if (h.status !== 'open') throw new HuddleError(409, 'This huddle is closed. Reopen it with a reason before posting.');
  }
  /** A bot that may join: registered, active, unarchived, and inside the huddle's business. */
  function invitable(actor: Actor, h: Pick<HuddleRow, 'business_team_id'>, conversationId: string): ConversationRow {
    const c = conversation(conversationId);
    const reg = registration.get(conversationId) as { name: string; active: number } | undefined;
    if (!c || !reg?.active) throw new HuddleError(400, `${conversationId} is not an active registered bot`);
    if (c.archived) throw new HuddleError(409, `${reg.name} is archived; restore its chat before inviting it`);
    if (h.business_team_id && c.business_team_id && c.business_team_id !== h.business_team_id)
      throw new HuddleError(403, `${reg.name} belongs to another business`);
    if (!actor.conversationId && !canViewConversation(actor.user, c, db))
      throw new HuddleError(404, `Bot ${conversationId} not found`);
    return c;
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  function unreadFor(h: HuddleRow, m: HuddleMemberRow, since = m.read_seq): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM huddle_messages
           WHERE huddle_id=? AND seq>? AND EXISTS (SELECT 1 FROM json_each(recipients_json) WHERE value=?)`,
        )
        .get(h.id, since, m.conversation_id) as { n: number }
    ).n;
  }
  function summary(actor: Actor, h: HuddleRow): HuddleSummary {
    const members = membersOf.all(h.id) as HuddleMemberRow[];
    const mine = actor.conversationId ? members.find((m) => m.conversation_id === actor.conversationId) : undefined;
    const last = db.prepare('SELECT created_at FROM huddle_messages WHERE huddle_id=? ORDER BY seq DESC LIMIT 1').get(h.id) as
      | { created_at: string }
      | undefined;
    return {
      id: h.id,
      goal: h.goal,
      why: h.why,
      status: h.status,
      status_note: h.status_note,
      business_team_id: h.business_team_id,
      lead: participant(h.lead_conversation_id),
      owner: h.owner_conversation_id ? participant(h.owner_conversation_id) : null,
      member_count: members.filter((m) => !m.left_at).length,
      open_action_count: (actionsOf.all(h.id) as HuddleActionRow[]).filter((a) => a.status === 'open' || a.status === 'blocked').length,
      last_seq: h.last_seq,
      last_message_at: last?.created_at ?? null,
      created_at: h.created_at,
      updated_at: h.updated_at,
      closed_at: h.closed_at,
      reopened_at: h.reopened_at,
      my_unread: mine ? unreadFor(h, mine) : 0,
      my_role: mine ? (mine.left_at ? 'left' : mine.role) : 'observer',
    };
  }
  function messageView(r: HuddleMessageRow): HuddleMessageView {
    return {
      id: r.id,
      seq: r.seq,
      kind: r.kind,
      author: { conversation_id: r.author_conversation_id, user_id: r.author_user_id, name: r.author_name },
      body: r.body,
      targets: parseIds(r.targets_json),
      recipients: parseIds(r.recipients_json),
      action_id: r.action_id,
      created_at: r.created_at,
    };
  }
  function actionViews(h: HuddleRow): HuddleActionView[] {
    const rows = actionsOf.all(h.id) as HuddleActionRow[];
    const byId = new Map(rows.map((a) => [a.id, a]));
    return rows.map((a) => {
      const deps = parseIds(a.depends_on_json);
      return {
        id: a.id,
        title: a.title,
        owner: a.owner_conversation_id ? participant(a.owner_conversation_id) : null,
        status: a.status,
        depends_on: deps,
        blocked_by: deps.filter((d) => byId.get(d)?.status !== 'done' && byId.get(d)?.status !== 'cancelled'),
        note: a.note,
        created_by: a.created_by,
        created_at: a.created_at,
        updated_at: a.updated_at,
        completed_at: a.completed_at,
      };
    });
  }
  function view(actor: Actor, h: HuddleRow, afterSeq = 0, limit = 200): HuddleView {
    const members = (membersOf.all(h.id) as HuddleMemberRow[]).map<HuddleMemberView>((m) => ({
      ...participant(m.conversation_id),
      role: m.role,
      joined_at: m.joined_at,
      left_at: m.left_at,
      unread: m.left_at ? 0 : unreadFor(h, m),
      pending_wake: Boolean(m.pending_wakeup_id),
      last_wake_at: m.last_wake_at,
    }));
    const messages = (
      db
        .prepare('SELECT * FROM huddle_messages WHERE huddle_id=? AND seq>? ORDER BY seq DESC LIMIT ?')
        .all(h.id, afterSeq, limit) as HuddleMessageRow[]
    )
      .reverse()
      .map(messageView);
    const active = actor.conversationId
      ? Boolean((memberRow.get(h.id, actor.conversationId) as HuddleMemberRow | undefined)?.left_at === null)
      : false;
    return {
      ...summary(actor, h),
      members,
      actions: actionViews(h),
      messages,
      close_verification: h.close_verification,
      closed_by: h.closed_by,
      can_post: actor.conversationId ? active && h.status === 'open' : humanCanPost(actor, h),
      can_manage: actor.conversationId ? actor.conversationId === h.lead_conversation_id : humanCanManage(actor, h),
      my_conversation_id: actor.conversationId ?? null,
    };
  }

  // ── Delivery (durable wakes) ──────────────────────────────────────────────
  /** Fold a delivered/cancelled wake back into the member's cursors. */
  function syncMember(m: HuddleMemberRow): HuddleMemberRow {
    if (!m.pending_wakeup_id) return m;
    const w = db.prepare('SELECT status FROM conversation_wakeups WHERE id=?').get(m.pending_wakeup_id) as
      | { status: ConversationWakeupRow['status'] }
      | undefined;
    if (!w || w.status === 'pending') return m;
    const delivered = w.status === 'delivered' ? Math.max(m.delivered_seq, m.wake_seq) : m.delivered_seq;
    db.prepare('UPDATE huddle_members SET delivered_seq=?, pending_wakeup_id=NULL WHERE huddle_id=? AND conversation_id=?').run(
      delivered,
      m.huddle_id,
      m.conversation_id,
    );
    return { ...m, delivered_seq: delivered, pending_wakeup_id: null };
  }
  function wakeReason(h: HuddleRow, m: HuddleMemberRow, pending: HuddleMessageRow[]): string {
    const me = m.conversation_id;
    const role = m.role === 'lead' ? 'the lead accountable for the outcome' : 'a member';
    const owner = h.owner_conversation_id ? botName(h.owner_conversation_id) : 'unassigned';
    const lines = pending.slice(-8).map((r) => {
      const targets = parseIds(r.targets_json);
      const addressed = targets.includes(me) ? ' → you' : targets.length ? ` → ${targets.map(botName).join(', ')}` : '';
      const body = r.body.length > 700 ? `${r.body.slice(0, 700)}…` : r.body;
      return `[#${r.seq} ${r.kind}] ${r.author_name}${addressed}: ${body}`;
    });
    const skipped = pending.length > 8 ? `(${pending.length - 8} earlier messages omitted; read_huddle shows them.)\n` : '';
    const mine = (actionsOf.all(h.id) as HuddleActionRow[]).filter((a) => a.owner_conversation_id === me && (a.status === 'open' || a.status === 'blocked'));
    const actions = mine.length ? `Actions you own: ${mine.map((a) => `${a.title} [${a.id}, ${a.status}]`).join('; ')}.\n` : '';
    return (
      `Huddle "${h.goal}" (huddle_id ${h.id}) has ${pending.length} new message${pending.length === 1 ? '' : 's'} for you. ` +
      `You are ${role}. Current owner: ${owner}. Status: ${h.status_note || 'no status note yet'}.\n` +
      `${skipped}${lines.join('\n')}\n${actions}` +
      `Call read_huddle(huddle_id) for the full thread, then do your part with your own tools and permissions; joining a huddle grants none. ` +
      `Post results with post_huddle_message; hand work to one teammate with kind=handoff and a single mention; mark actions with update_huddle_action. ` +
      `Reply only when you add something new: never post just to acknowledge, and never relay huddle traffic with send_message.`
    );
  }
  /** Schedule (or refresh) the single pending wake for a member, spaced at least WAKE_SPACING_MS apart. */
  function wakeMember(h: HuddleRow, raw: HuddleMemberRow): void {
    if (h.status !== 'open' || raw.left_at) return;
    const m = syncMember(raw);
    const pending = db
      .prepare(
        `SELECT * FROM huddle_messages WHERE huddle_id=? AND seq>? AND author_conversation_id IS NOT ?
         AND EXISTS (SELECT 1 FROM json_each(recipients_json) WHERE value=?) ORDER BY seq`,
      )
      .all(h.id, m.delivered_seq, m.conversation_id, m.conversation_id) as HuddleMessageRow[];
    if (!pending.length) return;
    const conv = conversation(m.conversation_id);
    if (!conv || conv.archived) return; // The wake scheduler would cancel it anyway; the UI shows the member as archived.
    const reason = wakeReason(h, m, pending);
    const key = `${WAKE_KEY_PREFIX}${h.id}`;
    const lastSeq = pending[pending.length - 1]!.seq;
    const existing = db
      .prepare("SELECT * FROM conversation_wakeups WHERE conversation_id=? AND wake_key=? AND status='pending'")
      .get(m.conversation_id, key) as ConversationWakeupRow | undefined;
    if (existing) {
      db.prepare('UPDATE conversation_wakeups SET reason=? WHERE id=?').run(reason, existing.id);
      db.prepare('UPDATE huddle_members SET wake_seq=?, pending_wakeup_id=? WHERE huddle_id=? AND conversation_id=?').run(
        lastSeq,
        existing.id,
        h.id,
        m.conversation_id,
      );
      return;
    }
    const earliest = now().getTime() + 1_000;
    const spaced = m.last_wake_at ? new Date(m.last_wake_at).getTime() + WAKE_SPACING_MS : 0;
    const scheduledFor = new Date(Math.max(earliest, spaced));
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for) VALUES(?,?,?,?,?,?)',
    ).run(id, m.conversation_id, conv.user_id, key, reason, scheduledFor.toISOString());
    db.prepare(
      'UPDATE huddle_members SET wake_seq=?, pending_wakeup_id=?, last_wake_at=? WHERE huddle_id=? AND conversation_id=?',
    ).run(lastSeq, id, scheduledFor.toISOString(), h.id, m.conversation_id);
    log.info(`[huddle] wake ${id} huddle=${h.id} bot=${m.conversation_id} through=#${lastSeq} at=${scheduledFor.toISOString()}`);
  }
  function wakeRecipients(h: HuddleRow, recipients: string[]): void {
    for (const id of new Set(recipients)) {
      const m = memberRow.get(h.id, id) as HuddleMemberRow | undefined;
      if (m) wakeMember(h, m);
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  function touch(h: HuddleRow) {
    db.prepare('UPDATE huddles SET updated_at=? WHERE id=?').run(iso(), h.id);
  }
  function appendMessage(
    h: HuddleRow,
    input: {
      kind: HuddleMessageRow['kind'];
      author: { conversation_id: string | null; user_id: number | null; name: string };
      body: string;
      targets: string[];
      recipients: string[];
      action_id?: string | null;
      request_key?: string | null;
    },
  ): HuddleMessageRow {
    const seq = h.last_seq + 1;
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO huddle_messages(id,huddle_id,seq,kind,author_conversation_id,author_user_id,author_name,body,targets_json,recipients_json,action_id,request_key,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      h.id,
      seq,
      input.kind,
      input.author.conversation_id,
      input.author.user_id,
      input.author.name,
      input.body,
      JSON.stringify(input.targets),
      JSON.stringify([...new Set(input.recipients)]),
      input.action_id ?? null,
      input.request_key ?? null,
      iso(),
    );
    db.prepare('UPDATE huddles SET last_seq=?, updated_at=? WHERE id=?').run(seq, iso(), h.id);
    h.last_seq = seq;
    // The author has seen everything up to its own message.
    if (input.author.conversation_id)
      db.prepare('UPDATE huddle_members SET read_seq=MAX(read_seq,?), delivered_seq=MAX(delivered_seq,?) WHERE huddle_id=? AND conversation_id=?').run(
        seq,
        seq,
        h.id,
        input.author.conversation_id,
      );
    const row = db.prepare('SELECT * FROM huddle_messages WHERE id=?').get(id) as HuddleMessageRow;
    wakeRecipients(h, input.recipients);
    return row;
  }
  function system(h: HuddleRow, body: string, recipients: string[], actionId?: string | null): HuddleMessageRow {
    return appendMessage(h, {
      kind: 'system',
      author: { conversation_id: null, user_id: null, name: 'Veneer' },
      body,
      targets: [],
      recipients,
      action_id: actionId ?? null,
    });
  }
  /** Untargeted traffic goes to whoever holds the ball, never to everyone, so a reply cannot fan out into a storm. */
  function routeUntargeted(h: HuddleRow, authorConversationId: string | null): string[] {
    const active = activeMembers(h).map((m) => m.conversation_id);
    const others = active.filter((id) => id !== authorConversationId);
    if (h.owner_conversation_id && h.owner_conversation_id !== authorConversationId && active.includes(h.owner_conversation_id))
      return [h.owner_conversation_id];
    if (h.lead_conversation_id !== authorConversationId) return [h.lead_conversation_id];
    // The lead (or the owner speaking as lead) with nobody specific in mind briefs the whole team.
    return others;
  }
  function rateLimit(h: HuddleRow, actor: Actor) {
    if (!actor.conversationId) return;
    const count = (windowMs: number) =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM huddle_messages WHERE huddle_id=? AND author_conversation_id=? AND created_at>?')
          .get(h.id, actor.conversationId, new Date(now().getTime() - windowMs).toISOString()) as { n: number }
      ).n;
    if (count(10 * 60_000) >= BOT_POSTS_PER_10_MIN || count(60 * 60_000) >= BOT_POSTS_PER_HOUR)
      throw new HuddleError(
        429,
        `Posting limit reached for this huddle (${BOT_POSTS_PER_10_MIN} per 10 minutes, ${BOT_POSTS_PER_HOUR} per hour). Stop replying; the next wake will bring any new messages.`,
      );
    const total = (
      db
        .prepare('SELECT COUNT(*) AS n FROM huddle_messages WHERE huddle_id=? AND created_at>?')
        .get(h.id, new Date(now().getTime() - 60 * 60_000).toISOString()) as { n: number }
    ).n;
    if (total >= HUDDLE_POSTS_PER_HOUR)
      throw new HuddleError(429, 'This huddle is too busy (hourly limit reached). Pause and let the lead consolidate before posting again.');
  }

  function post(actor: Actor, id: string, raw: unknown): { message: HuddleMessageView; duplicate: boolean } {
    const input = postSchema.parse(raw);
    return db.transaction(() => {
      const h = poster(actor, id);
      open(h);
      if (actor.conversationId && input.request_key) {
        const dup = db
          .prepare('SELECT * FROM huddle_messages WHERE huddle_id=? AND author_conversation_id=? AND request_key=?')
          .get(h.id, actor.conversationId, input.request_key) as HuddleMessageRow | undefined;
        if (dup) return { message: messageView(dup), duplicate: true };
      }
      rateLimit(h, actor);
      const active = new Set(activeMembers(h).map((m) => m.conversation_id));
      const targets = [...new Set(input.targets)].filter((t) => t !== actor.conversationId);
      for (const t of targets) if (!active.has(t)) throw new HuddleError(400, `${botName(t)} (${t}) is not an active member; invite them first`);
      let recipients = targets.length ? targets : routeUntargeted(h, actor.conversationId ?? null);
      let body = input.text;
      if (input.kind === 'handoff') {
        if (targets.length !== 1) throw new HuddleError(400, 'A handoff names exactly one teammate in targets');
        const to = targets[0]!;
        db.prepare('UPDATE huddles SET owner_conversation_id=?, updated_at=? WHERE id=?').run(to, iso(), h.id);
        h.owner_conversation_id = to;
        // The lead stays accountable, so it sees every handoff it did not make.
        if (h.lead_conversation_id !== actor.conversationId && h.lead_conversation_id !== to) recipients = [to, h.lead_conversation_id];
      } else if (input.kind === 'status') {
        db.prepare('UPDATE huddles SET status_note=?, updated_at=? WHERE id=?').run(input.text.slice(0, 600), iso(), h.id);
        h.status_note = input.text.slice(0, 600);
        // Status is informational: only the lead (and anyone named) is woken.
        recipients = targets.length ? targets : h.lead_conversation_id !== actor.conversationId ? [h.lead_conversation_id] : [];
        body = input.text;
      }
      const row = appendMessage(h, {
        kind: input.kind,
        author: { conversation_id: actor.conversationId ?? null, user_id: actor.conversationId ? null : actor.user.id, name: actorName(actor) },
        body,
        targets,
        recipients,
        request_key: actor.conversationId ? (input.request_key ?? null) : null,
      });
      return { message: messageView(row), duplicate: false };
    })();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  function addMember(h: HuddleRow, conversationId: string, role: 'lead' | 'member', invitedBy: string): boolean {
    const existing = memberRow.get(h.id, conversationId) as HuddleMemberRow | undefined;
    if (existing && !existing.left_at) return false;
    if (existing) {
      db.prepare('UPDATE huddle_members SET left_at=NULL, role=?, invited_by=?, joined_at=? WHERE huddle_id=? AND conversation_id=?').run(
        role,
        invitedBy,
        iso(),
        h.id,
        conversationId,
      );
      return true;
    }
    db.prepare(
      'INSERT INTO huddle_members(huddle_id,conversation_id,role,invited_by,joined_at,delivered_seq,read_seq) VALUES(?,?,?,?,?,?,?)',
    ).run(h.id, conversationId, role, invitedBy, iso(), 0, 0);
    return true;
  }

  function openHuddle(actor: Actor, raw: unknown): { huddle: HuddleView; created: boolean; reused: boolean } {
    const input = openSchema.parse(raw);
    return db.transaction(() => {
      const creatorConv = actor.conversationId ? conversation(actor.conversationId) : undefined;
      if (actor.conversationId) {
        const reg = registration.get(actor.conversationId) as { active: number } | undefined;
        if (!creatorConv || !reg?.active) throw new HuddleError(403, 'Only a registered, active bot can open a huddle from a chat');
      }
      const leadId = actor.conversationId ?? input.lead ?? input.members[0];
      if (!leadId) throw new HuddleError(400, 'Name a lead bot or at least one member');
      const roster = [...new Set([leadId, ...input.members])];
      const min = actor.conversationId ? MIN_BOT_MEMBERS : MIN_HUMAN_CREATED_MEMBERS;
      if (roster.length < min)
        throw new HuddleError(
          400,
          actor.conversationId
            ? `A huddle needs at least ${MIN_BOT_MEMBERS} bots sharing sustained work on one outcome. A request to one other bot stays a direct send_message.`
            : `A huddle needs at least ${MIN_HUMAN_CREATED_MEMBERS} bots`,
        );
      if (roster.length > MAX_MEMBERS) throw new HuddleError(400, `A huddle holds at most ${MAX_MEMBERS} bots`);
      const scopeTeam = creatorConv?.business_team_id ?? conversation(leadId)?.business_team_id ?? null;
      const scope = { business_team_id: scopeTeam };
      for (const id of roster) invitable(actor, scope, id);
      const dedupe = input.dedupe_key ? dedupeKeyFor(input.dedupe_key) : dedupeKeyFor(input.goal);
      if (!dedupe) throw new HuddleError(400, 'Goal needs some words');
      const scopeKey = scopeTeam ?? 'unscoped';
      const byRequest =
        actor.conversationId && input.request_key
          ? (db
              .prepare('SELECT * FROM huddles WHERE created_by_conversation_id=? AND request_key=?')
              .get(actor.conversationId, input.request_key) as HuddleRow | undefined)
          : undefined;
      const existing =
        byRequest ??
        (db.prepare("SELECT * FROM huddles WHERE scope_key=? AND dedupe_key=? AND status='open'").get(scopeKey, dedupe) as HuddleRow | undefined);
      if (existing) {
        // Reuse instead of duplicating: the caller and any missing teammates join the open thread.
        const joined: string[] = [];
        for (const id of roster) {
          if (activeMembers(existing).some((m) => m.conversation_id === id)) continue;
          if (activeMembers(existing).length >= MAX_MEMBERS) break;
          invitable(actor, existing, id);
          if (addMember(existing, id, 'member', actorName(actor))) joined.push(id);
        }
        if (joined.length) {
          const note = `${actorName(actor)} joined the existing huddle for this goal with ${joined.map(botName).join(', ')}.`;
          system(existing, note, joined.filter((j) => j !== actor.conversationId).concat(existing.lead_conversation_id !== actor.conversationId ? [existing.lead_conversation_id] : []));
        }
        return { huddle: view(actor, huddle(existing.id)), created: false, reused: true };
      }
      const id = crypto.randomUUID();
      const at = iso();
      db.prepare(
        `INSERT INTO huddles(id,scope_key,business_team_id,goal,why,dedupe_key,status,status_note,lead_conversation_id,owner_conversation_id,created_by_user_id,created_by_conversation_id,request_key,last_seq,created_at,updated_at)
         VALUES(?,?,?,?,?,?,'open','',?,?,?,?,?,0,?,?)`,
      ).run(id, scopeKey, scopeTeam, input.goal, input.why, dedupe, leadId, leadId, actor.user.id, actor.conversationId ?? null, actor.conversationId ? (input.request_key ?? null) : null, at, at);
      const h = huddle(id);
      for (const member of roster) addMember(h, member, member === leadId ? 'lead' : 'member', actorName(actor));
      const others = roster.filter((r) => r !== actor.conversationId);
      system(
        h,
        `${actorName(actor)} opened this huddle. Goal: ${input.goal}\nWhy a huddle: ${input.why}\nLead: ${botName(leadId)}. Members: ${roster.map(botName).join(', ')}.`,
        others,
      );
      log.info(`[huddle] opened ${id} lead=${leadId} members=${roster.length}`);
      return { huddle: view(actor, huddle(id)), created: true, reused: false };
    })();
  }

  function invite(actor: Actor, id: string, conversationIds: string[]): HuddleView {
    return db.transaction(() => {
      const h = poster(actor, id);
      open(h);
      const ids = [...new Set(conversationIds)];
      if (!ids.length) throw new HuddleError(400, 'Name at least one bot to invite');
      const joined: string[] = [];
      for (const cid of ids) {
        if (activeMembers(h).some((m) => m.conversation_id === cid)) continue;
        if (activeMembers(h).length >= MAX_MEMBERS) throw new HuddleError(409, `A huddle holds at most ${MAX_MEMBERS} bots`);
        invitable(actor, h, cid);
        if (addMember(h, cid, 'member', actorName(actor))) joined.push(cid);
      }
      if (joined.length)
        system(
          h,
          `${actorName(actor)} invited ${joined.map(botName).join(', ')}. Goal: ${h.goal}${h.status_note ? `\nCurrent status: ${h.status_note}` : ''}`,
          joined,
        );
      return view(actor, huddle(id));
    })();
  }

  function removeMember(actor: Actor, id: string, conversationId: string): HuddleView {
    return db.transaction(() => {
      const self = actor.conversationId === conversationId;
      const h = self ? poster(actor, id) : manager(actor, id);
      if (conversationId === h.lead_conversation_id) throw new HuddleError(409, 'Transfer the lead before removing it');
      const m = memberRow.get(h.id, conversationId) as HuddleMemberRow | undefined;
      if (!m || m.left_at) throw new HuddleError(404, 'Not an active member');
      db.prepare('UPDATE huddle_members SET left_at=?, pending_wakeup_id=NULL WHERE huddle_id=? AND conversation_id=?').run(iso(), h.id, conversationId);
      db.prepare("UPDATE conversation_wakeups SET status='cancelled', cancelled_at=datetime('now') WHERE conversation_id=? AND wake_key=? AND status='pending'").run(
        conversationId,
        `${WAKE_KEY_PREFIX}${h.id}`,
      );
      if (h.owner_conversation_id === conversationId) {
        db.prepare('UPDATE huddles SET owner_conversation_id=? WHERE id=?').run(h.lead_conversation_id, h.id);
        h.owner_conversation_id = h.lead_conversation_id;
      }
      system(h, self ? `${botName(conversationId)} left the huddle.` : `${actorName(actor)} removed ${botName(conversationId)}.`, self && h.lead_conversation_id !== conversationId ? [h.lead_conversation_id] : []);
      return view(actor, huddle(id));
    })();
  }

  function patch(actor: Actor, id: string, raw: unknown): HuddleView {
    const input = patchSchema.parse(raw);
    return db.transaction(() => {
      if (input.leave) {
        if (!actor.conversationId) throw new HuddleError(400, 'Only a bot member can leave');
        return removeMember(actor, id, actor.conversationId);
      }
      const needsManager = input.lead !== undefined || input.goal !== undefined;
      const h = needsManager ? manager(actor, id) : poster(actor, id);
      open(h);
      const active = new Set(activeMembers(h).map((m) => m.conversation_id));
      const notes: string[] = [];
      const recipients: string[] = [];
      if (input.lead !== undefined && input.lead !== h.lead_conversation_id) {
        if (!active.has(input.lead)) throw new HuddleError(400, 'The new lead must be an active member');
        db.prepare("UPDATE huddle_members SET role='member' WHERE huddle_id=? AND conversation_id=?").run(h.id, h.lead_conversation_id);
        db.prepare("UPDATE huddle_members SET role='lead' WHERE huddle_id=? AND conversation_id=?").run(h.id, input.lead);
        db.prepare('UPDATE huddles SET lead_conversation_id=? WHERE id=?').run(input.lead, h.id);
        notes.push(`Lead is now ${botName(input.lead)} (was ${botName(h.lead_conversation_id)}).`);
        recipients.push(input.lead);
        h.lead_conversation_id = input.lead;
      }
      if (input.owner !== undefined && input.owner !== h.owner_conversation_id) {
        if (input.owner && !active.has(input.owner)) throw new HuddleError(400, 'The owner must be an active member');
        db.prepare('UPDATE huddles SET owner_conversation_id=? WHERE id=?').run(input.owner, h.id);
        notes.push(input.owner ? `${botName(input.owner)} now owns the next step.` : 'Nobody owns the next step right now.');
        if (input.owner) recipients.push(input.owner);
        h.owner_conversation_id = input.owner;
      }
      if (input.status_note !== undefined && input.status_note !== h.status_note) {
        db.prepare('UPDATE huddles SET status_note=? WHERE id=?').run(input.status_note, h.id);
        notes.push(`Status: ${input.status_note || '(cleared)'}`);
      }
      if (input.goal !== undefined && input.goal !== h.goal) {
        db.prepare('UPDATE huddles SET goal=? WHERE id=?').run(input.goal, h.id);
        notes.push(`Goal is now: ${input.goal}`);
      }
      if (notes.length) {
        touch(h);
        system(h, `${actorName(actor)}: ${notes.join(' ')}`, recipients.filter((r) => r !== actor.conversationId));
      }
      return view(actor, huddle(id));
    })();
  }

  // ── Actions (ownership and dependent resumption) ──────────────────────────
  function action(h: HuddleRow, actionId: string): HuddleActionRow {
    const a = db.prepare('SELECT * FROM huddle_actions WHERE id=? AND huddle_id=?').get(actionId, h.id) as HuddleActionRow | undefined;
    if (!a) throw new HuddleError(404, 'Action not found in this huddle');
    return a;
  }
  function unmetDeps(h: HuddleRow, deps: string[]): string[] {
    return deps.filter((d) => {
      const a = db.prepare('SELECT status FROM huddle_actions WHERE id=? AND huddle_id=?').get(d, h.id) as { status: string } | undefined;
      return a && a.status !== 'done' && a.status !== 'cancelled';
    });
  }
  function validateDeps(h: HuddleRow, self: string | null, deps: string[]) {
    for (const d of deps) {
      if (d === self) throw new HuddleError(400, 'An action cannot depend on itself');
      action(h, d);
    }
  }
  function addAction(actor: Actor, id: string, raw: unknown): HuddleView {
    const input = actionSchema.parse(raw);
    return db.transaction(() => {
      const h = poster(actor, id);
      open(h);
      const active = new Set(activeMembers(h).map((m) => m.conversation_id));
      if (input.owner && !active.has(input.owner)) throw new HuddleError(400, 'The owner must be an active member');
      validateDeps(h, null, input.depends_on);
      const aid = crypto.randomUUID();
      const at = iso();
      db.prepare(
        'INSERT INTO huddle_actions(id,huddle_id,title,owner_conversation_id,status,depends_on_json,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(aid, h.id, input.title, input.owner ?? null, 'open', JSON.stringify(input.depends_on), input.note, actorName(actor), at, at);
      const blocked = unmetDeps(h, input.depends_on);
      const owner = input.owner ? botName(input.owner) : 'nobody yet';
      const wake = input.owner && input.owner !== actor.conversationId && !blocked.length ? [input.owner] : [];
      system(
        h,
        `${actorName(actor)} added action "${input.title}" [${aid}] owned by ${owner}${blocked.length ? ` (waits on ${blocked.length} other action${blocked.length === 1 ? '' : 's'})` : ''}${input.note ? `. ${input.note}` : ''}`,
        wake,
        aid,
      );
      return view(actor, huddle(id));
    })();
  }
  function updateAction(actor: Actor, id: string, actionId: string, raw: unknown): HuddleView {
    const input = actionPatchSchema.parse(raw);
    return db.transaction(() => {
      const h = poster(actor, id);
      open(h);
      const a = action(h, actionId);
      const active = new Set(activeMembers(h).map((m) => m.conversation_id));
      if (input.owner && !active.has(input.owner)) throw new HuddleError(400, 'The owner must be an active member');
      if (input.depends_on) validateDeps(h, a.id, input.depends_on);
      if (input.status === 'done' && actor.conversationId && a.owner_conversation_id && a.owner_conversation_id !== actor.conversationId && actor.conversationId !== h.lead_conversation_id)
        throw new HuddleError(403, 'Only the owner or the lead can mark an action done');
      const at = iso();
      const next = {
        title: input.title ?? a.title,
        owner: input.owner === undefined ? a.owner_conversation_id : input.owner,
        status: input.status ?? a.status,
        deps: input.depends_on ?? parseIds(a.depends_on_json),
        note: input.note ?? a.note,
      };
      db.prepare(
        'UPDATE huddle_actions SET title=?, owner_conversation_id=?, status=?, depends_on_json=?, note=?, updated_at=?, completed_at=? WHERE id=?',
      ).run(next.title, next.owner, next.status, JSON.stringify(next.deps), next.note, at, next.status === 'done' ? (a.completed_at ?? at) : null, a.id);
      const notes: string[] = [];
      const recipients: string[] = [];
      if (next.status !== a.status) notes.push(`"${next.title}" is ${next.status}${next.note && next.note !== a.note ? `: ${next.note}` : ''}`);
      else if (next.note !== a.note) notes.push(`"${next.title}": ${next.note}`);
      if (next.owner !== a.owner_conversation_id) {
        notes.push(next.owner ? `${botName(next.owner)} now owns "${next.title}"` : `"${next.title}" has no owner`);
        if (next.owner && next.owner !== actor.conversationId && !unmetDeps(h, next.deps).length) recipients.push(next.owner);
      }
      if (notes.length) system(h, `${actorName(actor)}: ${notes.join('. ')}.`, recipients, a.id);
      // Finishing an action releases whatever waited on it, and wakes each owner once.
      if ((next.status === 'done' || next.status === 'cancelled') && a.status !== 'done' && a.status !== 'cancelled') {
        const dependents = (actionsOf.all(h.id) as HuddleActionRow[]).filter(
          (d) => d.status === 'open' && parseIds(d.depends_on_json).includes(a.id) && !unmetDeps(h, parseIds(d.depends_on_json)).length,
        );
        for (const d of dependents) {
          const owner = d.owner_conversation_id;
          system(
            h,
            `Unblocked: "${d.title}" [${d.id}] can start now${owner ? `; ${botName(owner)} owns it` : '; it has no owner yet'}.`,
            owner && owner !== actor.conversationId ? [owner] : owner ? [] : [h.lead_conversation_id].filter((l) => l !== actor.conversationId),
            d.id,
          );
        }
      }
      return view(actor, huddle(id));
    })();
  }

  function close(actor: Actor, id: string, verification: string): HuddleView {
    const text = z.string().trim().min(10).max(4000).parse(verification);
    return db.transaction(() => {
      const h = manager(actor, id);
      open(h);
      const unfinished = (actionsOf.all(h.id) as HuddleActionRow[]).filter((a) => a.status === 'open' || a.status === 'blocked');
      if (unfinished.length && actor.conversationId)
        throw new HuddleError(409, `Finish or cancel these actions before closing: ${unfinished.map((a) => `${a.title} [${a.id}]`).join('; ')}`);
      for (const a of unfinished)
        db.prepare("UPDATE huddle_actions SET status='cancelled', updated_at=? WHERE id=?").run(iso(), a.id);
      const at = iso();
      db.prepare('UPDATE huddles SET status=?, closed_at=?, closed_by=?, close_verification=?, updated_at=? WHERE id=?').run('closed', at, actorName(actor), text, at, h.id);
      // Nothing is woken on close: members with stale context get a clear 409 if they post again.
      for (const m of activeMembers(h)) {
        db.prepare("UPDATE conversation_wakeups SET status='cancelled', cancelled_at=datetime('now') WHERE conversation_id=? AND wake_key=? AND status='pending'").run(m.conversation_id, `${WAKE_KEY_PREFIX}${h.id}`);
        db.prepare('UPDATE huddle_members SET pending_wakeup_id=NULL WHERE huddle_id=? AND conversation_id=?').run(h.id, m.conversation_id);
      }
      const closed = huddle(id);
      appendMessage(closed, {
        kind: 'system',
        author: { conversation_id: null, user_id: null, name: 'Veneer' },
        body: `${actorName(actor)} closed the huddle as complete. Verification: ${text}${unfinished.length ? ` (${unfinished.length} unfinished action${unfinished.length === 1 ? '' : 's'} cancelled)` : ''}`,
        targets: [],
        recipients: [],
      });
      return view(actor, huddle(id));
    })();
  }
  function reopen(actor: Actor, id: string, reason: string): HuddleView {
    const text = z.string().trim().min(5).max(2000).parse(reason);
    return db.transaction(() => {
      const h = readable(actor, id);
      if (h.status === 'open') throw new HuddleError(409, 'This huddle is already open');
      if (actor.conversationId) {
        const m = memberRow.get(h.id, actor.conversationId) as HuddleMemberRow | undefined;
        if (!m) throw new HuddleError(403, 'Only a member can reopen this huddle');
      } else if (!humanCanPost(actor, h)) throw new HuddleError(403, 'You cannot reopen this huddle');
      const at = iso();
      db.prepare('UPDATE huddles SET status=?, reopened_at=?, closed_at=NULL, closed_by=NULL, close_verification=NULL, updated_at=? WHERE id=?').run('open', at, at, h.id);
      // A member who left and reopens rejoins; the lead is always active again.
      if (actor.conversationId) addMember(h, actor.conversationId, actor.conversationId === h.lead_conversation_id ? 'lead' : 'member', actorName(actor));
      addMember(h, h.lead_conversation_id, 'lead', actorName(actor));
      const reopened = huddle(id);
      system(reopened, `${actorName(actor)} reopened the huddle. Reason: ${text}`, [reopened.lead_conversation_id].filter((l) => l !== actor.conversationId));
      return view(actor, huddle(id));
    })();
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  function get(actor: Actor, id: string, afterSeq = 0): HuddleView {
    const h = readable(actor, id);
    return view(actor, h, afterSeq);
  }
  /** A bot reading the thread acknowledges everything it has been shown. */
  function read(actor: Actor, id: string, afterSeq = 0): HuddleView {
    const h = readable(actor, id);
    if (actor.conversationId) {
      const m = memberRow.get(h.id, actor.conversationId) as HuddleMemberRow | undefined;
      if (m) {
        syncMember(m);
        db.prepare('UPDATE huddle_members SET read_seq=?, delivered_seq=? WHERE huddle_id=? AND conversation_id=?').run(h.last_seq, h.last_seq, h.id, actor.conversationId);
      }
    }
    return view(actor, huddle(id), afterSeq);
  }
  function list(actor: Actor, status: 'open' | 'closed' | 'all' = 'open', business?: string | null): HuddleSummary[] {
    const rows = db.prepare('SELECT * FROM huddles ORDER BY (status=\'open\') DESC, updated_at DESC LIMIT 500').all() as HuddleRow[];
    return rows
      .filter((h) => (status === 'all' || h.status === status) && (!business || h.business_team_id === business) && visible(actor, h))
      .map((h) => summary(actor, h));
  }
  function candidates(actor: Actor, id?: string): HuddleParticipant[] {
    const h = id ? readable(actor, id) : null;
    const scope = { business_team_id: h?.business_team_id ?? (actor.conversationId ? (conversation(actor.conversationId)?.business_team_id ?? null) : null) };
    const out: HuddleParticipant[] = [];
    for (const r of db.prepare('SELECT conversation_id FROM bot_registrations WHERE active=1 ORDER BY name').all() as { conversation_id: string }[]) {
      try {
        invitable(actor, scope, r.conversation_id);
      } catch {
        continue;
      }
      if (h && activeMembers(h).some((m) => m.conversation_id === r.conversation_id)) continue;
      out.push(participant(r.conversation_id));
    }
    return out;
  }

  // ── Recovery ──────────────────────────────────────────────────────────────
  /**
   * Runner tick: fold delivered wakes into cursors and re-wake any member that
   * still has undelivered messages (a wake cancelled by an archive/restore, a
   * crash between insert and schedule, a bot whose earlier wake never fired).
   */
  function reconcile(): number {
    let scheduled = 0;
    const rows = db
      .prepare(
        `SELECT m.* FROM huddle_members m JOIN huddles h ON h.id=m.huddle_id
         WHERE h.status='open' AND m.left_at IS NULL AND m.delivered_seq < h.last_seq`,
      )
      .all() as HuddleMemberRow[];
    for (const m of rows) {
      try {
        const h = huddle(m.huddle_id);
        const before = syncMember(m);
        const had = before.pending_wakeup_id;
        wakeMember(h, before);
        const after = memberRow.get(m.huddle_id, m.conversation_id) as HuddleMemberRow;
        if (after.pending_wakeup_id && after.pending_wakeup_id !== had) scheduled++;
      } catch (err) {
        log.warn(`[huddle] reconcile failed huddle=${m.huddle_id} bot=${m.conversation_id}: ${(err as Error).message}`);
      }
    }
    return scheduled;
  }

  return {
    open: openHuddle,
    list,
    get,
    read,
    post,
    invite,
    removeMember,
    patch,
    addAction,
    updateAction,
    close,
    reopen,
    candidates,
    reconcile,
    botName,
  };
}

export type HuddleService = ReturnType<typeof createHuddleService>;

/** Runner-side loop that keeps huddle delivery honest across restarts. */
export function createHuddleReconciler({
  service,
  tickMs = 5_000,
  log = console,
}: {
  service: Pick<HuddleService, 'reconcile'>;
  tickMs?: number;
  log?: Pick<Console, 'warn'>;
}) {
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    try {
      service.reconcile();
    } catch (err) {
      log.warn(`[huddle] reconcile tick failed: ${(err as Error).message}`);
    }
  };
  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
