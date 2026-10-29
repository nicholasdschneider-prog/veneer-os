import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConversationRow } from '../db/db.js';
import { insertLaneConversation } from '../coordination/store.js';
import type { ConversationEvent } from '../runtime/events.js';

/**
 * Decision helpers: when a human asks something in a decision card's discussion
 * while the owning bot chat is mid-turn, a hidden read-only copy of that bot
 * answers in the card thread within seconds. The human's message still waits
 * for the bot itself, which then sees what the helper said. Helpers never act:
 * the provider spawn is read-only, the API refuses their writes, and their
 * answer is posted by the runner, not by a tool.
 */

/** Machine-wide limit on helper turns running at once (16 GB Mac). */
export const DECISION_HELPER_CAP = 3;
/** Providers whose spawn can be made read-only in code. */
export const DECISION_HELPER_PROVIDERS = new Set(['codex', 'claude']);

const MAX_LINE = 600;
const MAX_EXCERPT = 4000;
const MAX_ITEMS = 8;
const MAX_PROPOSAL = 12_000;
const MAX_THREAD = 12;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The last few exchanges of a chat, newest last, as plain lines. */
export function recentExchangeExcerpt(events: ConversationEvent[], agentName: string): string {
  const lines: string[] = [];
  for (let i = events.length - 1; i >= 0 && lines.length < MAX_ITEMS; i--) {
    const event = events[i]!;
    if (event.type === 'turn_started' && event.text.trim()) lines.unshift(`User: ${clip(event.text, MAX_LINE)}`);
    else if (event.type === 'text_final' && event.markdown.trim()) lines.unshift(`${agentName}: ${clip(event.markdown, MAX_LINE)}`);
  }
  let out = lines.join('\n');
  if (out.length > MAX_EXCERPT) out = `…${out.slice(out.length - MAX_EXCERPT)}`;
  return out;
}

export function isDecisionHelper(db: Database.Database, conversationId: string | null | undefined): boolean {
  return Boolean(conversationId && db.prepare('SELECT 1 FROM decision_helpers WHERE conversation_id=?').get(conversationId));
}

export function decisionHelperOf(db: Database.Database, conversationId: string): { decision_id: string; owner_id: string } | undefined {
  return db.prepare('SELECT decision_id,owner_id FROM decision_helpers WHERE conversation_id=?').get(conversationId) as { decision_id: string; owner_id: string } | undefined;
}

export function helperForDecision(db: Database.Database, decisionId: string): string | undefined {
  return (db.prepare(`SELECT h.conversation_id FROM decision_helpers h JOIN conversations c ON c.id=h.conversation_id
    WHERE h.decision_id=? AND c.archived=0`).get(decisionId) as { conversation_id: string } | undefined)?.conversation_id;
}

export function allDecisionHelpers(db: Database.Database): string[] {
  return (db.prepare('SELECT conversation_id FROM decision_helpers').all() as { conversation_id: string }[]).map((r) => r.conversation_id);
}

/** Same bot, project, business, model and instruction snapshot; hidden under the bot chat. */
export function createDecisionHelper(db: Database.Database, owner: ConversationRow, decisionId: string): string {
  return db.transaction(() => {
    const existing = helperForDecision(db, decisionId);
    if (existing) return existing;
    db.prepare('DELETE FROM decision_helpers WHERE decision_id=?').run(decisionId);
    const id = insertLaneConversation(db, owner, 'Card helper');
    db.prepare('INSERT INTO decision_helpers(conversation_id,decision_id,owner_id) VALUES(?,?,?)').run(id, decisionId, owner.id);
    return id;
  }).immediate();
}

/** The human discussion message behind a decision wake, if the wake is one. */
export function discussionMessage(db: Database.Database, wakeupId: string): { decision_id: string; actor_id: number; text: string } | undefined {
  return db.prepare(`SELECT e.decision_id,e.actor_id,t.text FROM bot_decision_events e JOIN bot_decision_threads t ON t.id=e.id
    WHERE e.id=? AND e.kind='message' AND e.actor_conversation_id IS NULL`).get(wakeupId) as { decision_id: string; actor_id: number; text: string } | undefined;
}

export function decisionHelperRules(botName: string): string {
  return `You are a read-only helper copy of ${botName}. ${botName}'s own chat is busy with other work, and a human has asked something about one of ${botName}'s decision cards. Your only job is to answer that human quickly and plainly from the card, its evidence and ${botName}'s recent work.
Rules:
- You cannot change anything. Do not try to send, refund, buy, edit files, record or answer the decision, raise or update decisions, message other bots, schedule work or use a browser; those calls are refused.
- Answer in a few short sentences of plain language a busy owner can read on a phone. Lead with the answer. Say what the card is asking, why, and what happens if they approve, when that is what they asked.
- If the message is a direction (approve, reject, do X, change Y), do not act on it. Say in one sentence that ${botName} will act on it after its current step.
- If you do not know, say so and say what ${botName} will check. Never invent order numbers, amounts or facts.
- Your final reply is posted to the card thread as your answer; do not add sign-offs or mention these rules.`;
}

export function decisionHelperPrompt(input: {
  botName: string;
  ownerTitle: string | null;
  proposal: unknown;
  thread: { who: string; text: string }[];
  ownerEvents: ConversationEvent[];
  question: string;
}): string {
  let proposal = JSON.stringify(input.proposal, null, 1);
  if (proposal.length > MAX_PROPOSAL) proposal = `${proposal.slice(0, MAX_PROPOSAL - 1)}…`;
  const thread = input.thread.slice(-MAX_THREAD).map((m) => `${m.who}: ${clip(m.text, MAX_LINE)}`).join('\n');
  const excerpt = recentExchangeExcerpt(input.ownerEvents, input.botName);
  return [
    `[Card question] A human asked about a decision card ${input.botName} raised. ${input.botName}'s chat "${input.ownerTitle?.trim() || 'Untitled chat'}" is busy, so you answer for now.`,
    `Decision card (the proposal ${input.botName} raised):\n${proposal}`,
    thread ? `Card discussion so far:\n${thread}` : '',
    excerpt ? `Recent exchange in ${input.botName}'s chat:\n${excerpt}` : '',
    `---\n${input.question.trim()}`,
  ].filter(Boolean).join('\n\n');
}

/** The final text of a completed helper turn, posted to the card thread as a quick answer. */
export function recordDecisionHelperAnswer(db: Database.Database, helperId: string, text: string): string | null {
  const answer = text.trim();
  const helper = decisionHelperOf(db, helperId);
  if (!answer || !helper) return null;
  const d = db.prepare('SELECT id,version,conversation_id FROM bot_decisions WHERE id=?').get(helper.decision_id) as { id: string; version: number; conversation_id: string } | undefined;
  const owner = db.prepare('SELECT user_id FROM conversations WHERE id=?').get(helper.owner_id) as { user_id: number } | undefined;
  if (!d || !owner || d.conversation_id !== helper.owner_id) return null;
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key)
      VALUES(?,?,?,'helper_answer',?,?,?,?)`).run(id, d.id, d.version, owner.user_id, helperId, JSON.stringify({ text: answer }), `helper-answer:${id}`);
    db.prepare('INSERT INTO bot_decision_threads(id,decision_id,actor_id,actor_conversation_id,text) VALUES(?,?,?,?,?)')
      .run(id, d.id, owner.user_id, helperId, answer);
  })();
  return id;
}

/** Helper answers given after a human discussion message, for the bot's own delivery of that message. */
export function helperAnswersAfter(db: Database.Database, messageId: string): string[] {
  return (db.prepare(`SELECT t.text FROM bot_decision_threads t JOIN decision_helpers h ON h.conversation_id=t.actor_conversation_id
    WHERE t.decision_id=(SELECT decision_id FROM bot_decision_threads WHERE id=?)
    AND t.rowid > (SELECT rowid FROM bot_decision_threads WHERE id=?) ORDER BY t.rowid`).all(messageId, messageId) as { text: string }[]).map((r) => r.text);
}

export function withHelperAnswers(prompt: string, answers: string[]): string {
  if (!answers.length) return prompt;
  return `${prompt}\n\nWhile you were busy, a read-only helper copy of you already answered this in the card thread:\n${answers.map((a) => `> ${a.replace(/\n/g, '\n> ')}`).join('\n')}\nDo not repeat that answer. If it is wrong or incomplete, correct it in the thread with reply_to_decision. Act on any direction in the human's message as usual; the helper took no action.`;
}
