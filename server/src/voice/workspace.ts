import type { AppContext } from '../context.js';
import type { ConversationRow, QuestionRow, UserRow } from '../db/db.js';
import type { QuestionAnswers, QuestionPrompt } from '../runtime/events.js';
import { sanitizeMemoryText } from '../memory/capture.js';
import { canSendToConversation, canViewConversation, canManageConversation } from '../conversations/access.js';
import { createBotService } from '../bots/service.js';
import { z } from 'zod';

export const AnswerSchema = z.object({
  requestId: z.string().min(1).max(200),
  answers: z.record(z.array(z.string().min(1).max(4000)).min(1).max(30)),
});
export const DecisionAnswerSchema = z.object({
  decisionId: z.string().min(1).max(200),
  version: z.number().int().positive(),
  action: z.enum(['approve', 'reject', 'defer', 'withdraw']),
  text: z.string().trim().min(1).max(12000),
  scope: z.enum(['this_case', 'standing_rule']).default('this_case'),
});
const clip = (value: string, max: number) => sanitizeMemoryText(value ?? '').slice(0, max);

/** Coordinator context is owned chats; pinned calls use the normal conversation access policy.
 * botConversationId is the legacy column/API name and may identify an ordinary thread. */
export class VoiceWorkspace {
  private bots: ReturnType<typeof createBotService>;
  constructor(private ctx: AppContext, readonly userId: number, readonly botConversationId: string | null = null) {
    this.bots = createBotService(ctx.db);
  }

  private get user(): UserRow {
    const row = this.ctx.db.prepare('SELECT * FROM users WHERE id=?').get(this.userId) as UserRow | undefined;
    if (!row || row.status !== 'active') throw new Error('User not available.');
    return row;
  }
  private get actor() { return { user: this.user }; }

  private question(requestId: string): (QuestionRow & { title: string | null }) | undefined {
    return this.ctx.db.prepare(`SELECT q.*, c.title FROM questions q
      JOIN conversations c ON c.id=q.conversation_id
      WHERE q.request_id=? AND (c.user_id=? OR c.id=?)`).get(requestId, this.userId, this.botConversationId) as
      (QuestionRow & { title: string | null }) | undefined;
  }

  private prompts(row: QuestionRow): QuestionPrompt[] {
    try {
      const prompts = JSON.parse(row.questions_json) as QuestionPrompt[];
      // Secret requests and approval requests are deliberately not voice tools.
      return Array.isArray(prompts) && prompts.every(p => !p.kind || p.kind === 'choice') ? prompts : [];
    } catch { return []; }
  }

  /** Pinned agent identity, with a registered bot name when available. */
  bot() {
    const id = this.botConversationId;
    if (!id) throw new Error('This call is not placed to a bot.');
    const chat = this.visibleChat(id);
    const registration = this.ctx.db.prepare('SELECT name FROM bot_registrations WHERE conversation_id=? AND active=1')
      .get(id) as { name: string } | undefined;

    const membership = this.ctx.db.prepare('SELECT role,subteam FROM business_bot_members WHERE conversation_id=?')
      .get(id) as { role: string; subteam: string } | undefined;
    const team = chat.business_team_id
      ? (this.ctx.db.prepare('SELECT name FROM business_teams WHERE id=?').get(chat.business_team_id) as { name: string } | undefined)?.name ?? null
      : null;
    return { conversationId: id, name: registration?.name ?? (this.ctx.db.prepare('SELECT name FROM assistants WHERE id=?').get(chat.assistant_id) as {name:string}|undefined)?.name ?? 'Assistant', title: chat.title, archived: Boolean(chat.archived),
      role: membership?.role ?? null, subteam: membership?.subteam || null, team,
      canMessage: !chat.archived && canSendToConversation(this.user, chat, this.ctx.db) };
  }

  blockers() {
    if (this.botConversationId) this.visibleChat(this.botConversationId);
    const rows = this.ctx.db.prepare(`SELECT q.*, c.title FROM questions q
      JOIN conversations c ON c.id=q.conversation_id
      WHERE (c.user_id=? OR c.id=?) AND q.status='pending' AND (? IS NULL OR q.conversation_id=?) ORDER BY q.created_at LIMIT 100`)
      .all(this.userId, this.botConversationId, this.botConversationId, this.botConversationId) as (QuestionRow & { title: string | null })[];
    return rows.flatMap(row => {
      try { this.visibleChat(row.conversation_id); } catch { return []; }
      const questions = this.prompts(row);
      return questions.length ? [{ requestId: row.request_id, conversationId: row.conversation_id,
        title: row.title, createdAt: row.created_at, questions }] : [];
    });
  }

  chats() {
    const rows = this.ctx.db.prepare(`SELECT c.*, p.name AS projectName FROM conversations c
      LEFT JOIN projects p ON p.id=c.project_id WHERE c.user_id=? AND c.archived=0
      ORDER BY c.last_active_at DESC LIMIT 80`).all(this.userId) as (ConversationRow & {projectName:string|null})[];
    return rows.filter(row => canViewConversation(this.user, row, this.ctx.db))
      .map(row => ({id:row.id,title:row.title,projectName:row.projectName}));
  }

  private visibleChat(conversationId: string): ConversationRow {
    if (this.botConversationId) {
      if (conversationId !== this.botConversationId) throw new Error('Only the conversation on this call can be read.');
      const row = this.ctx.db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId) as ConversationRow | undefined;
      if (!row || !canViewConversation(this.user, row, this.ctx.db)) throw new Error('Chat not found.');
      return row;
    }
    const row = this.ctx.db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?')
      .get(conversationId, this.userId) as ConversationRow | undefined;
    if (!row || !canViewConversation(this.user, row, this.ctx.db)) throw new Error('Chat not found.');
    return row;
  }

  async readChat(conversationId: string, beforeMessage?: number) {
    const row = this.visibleChat(conversationId);
    if (beforeMessage !== undefined && (!Number.isSafeInteger(beforeMessage) || beforeMessage < 0)) throw new Error('Invalid history cursor.');
    const events = await this.ctx.manager.snapshot(row.id);
    // Recheck after the runner read in case access changed while it was pending.
    this.visibleChat(conversationId);
    const all = events.flatMap(event => {
      if (event.type === 'turn_started') return [{ role: 'user', text: sanitizeMemoryText(event.text ?? '') }];
      if (event.type === 'text_final') return [{ role: 'assistant', text: sanitizeMemoryText(event.markdown) }];
      return [];
    }).filter(m => m.text);
    const end = Math.min(beforeMessage ?? all.length, all.length);
    let start = end;
    let chars = 0;
    while (start > 0 && end - start < 24) {
      const size = Math.min(all[start - 1]!.text.length, 4000);
      if (chars + size > 36000) break;
      chars += size; start--;
    }
    const page = all.slice(start, end);
    const messages = page.map(m => ({ ...m, text: m.text.length <= 4000 ? m.text :
      m.text.slice(0, 3100) + '\n[Middle of message omitted]\n' + m.text.slice(-800) }));
    return { conversationId, title: row.title, status: await this.ctx.manager.statusOf(row.id), messages,
      coverage: { totalMessages: all.length, returnedMessages: messages.length,
        olderBefore: start > 0 ? start : null, clippedMessages: page.filter(m => m.text.length > 4000).length } };
  }

  /** Number of bot replies so far; the call loop uses it to notice a new reply. */
  async replyCount(): Promise<number> {
    if (!this.botConversationId) return 0;
    this.visibleChat(this.botConversationId);
    const events = await this.ctx.manager.snapshot(this.botConversationId);
    return events.filter(event => event.type === 'text_final').length;
  }

  /** Relay what the caller said into the bot's own conversation, the same way the chat composer would. */
  async sendMessage(text: string, instructionId: string) {
    const bot = this.bot();
    if (!bot.canMessage) throw new Error('This bot cannot receive messages right now.');
    const clean = clip(text, 12000).trim();
    if (!clean) throw new Error('Nothing to send.');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(instructionId)) throw new Error('Invalid instruction ID.');
    const prior = this.ctx.db.prepare('SELECT text,result_json FROM voice_dispatches WHERE user_id=? AND conversation_id=? AND instruction_id=?').get(this.userId, bot.conversationId, instructionId) as {text:string;result_json:string|null}|undefined;
    if (prior) {
      if (prior.text !== clean) throw new Error('Instruction ID already used for different text.');
      return prior.result_json ? JSON.parse(prior.result_json) : { ok: false, delivery: 'Delivery is unconfirmed. Check the chat before asking to resend; do not retry this instruction.' };
    }
    this.ctx.db.prepare('INSERT INTO voice_dispatches(user_id,conversation_id,instruction_id,text) VALUES(?,?,?,?)').run(this.userId,bot.conversationId,instructionId,clean);
    // Runner persists the message before steering; do not wait for agent completion.
    const posted = await this.ctx.manager.steerMessage(bot.conversationId, `[Voice call] ${clean}`, this.userId);
    const result = { ok: true, messageId: posted.messageId, disposition: posted.disposition, steerReason: posted.steerReason, status: await this.ctx.manager.statusOf(bot.conversationId), delivery: 'Instruction delivered to the conversation. Keep talking while the agent works. Check read_chat for actual status and results; delivery does not mean completion.' };
    this.ctx.db.prepare('UPDATE voice_dispatches SET result_json=? WHERE user_id=? AND conversation_id=? AND instruction_id=?').run(JSON.stringify(result),this.userId,bot.conversationId,instructionId);
    return result;
  }

  decisions() {
    const id = this.botConversationId;
    if (!id) return [];
    return this.bots.list(this.actor).filter(d => d.conversation_id === id).slice(0, 40).map(d => ({
      decisionId: d.id, version: d.version, state: d.state, createdAt: d.created_at, updatedAt: d.updated_at,
      canAnswer: d.can_answer, assignee: d.assignee_name,
      question: clip(d.proposal.question, 2000), recommendation: clip(d.proposal.recommendation, 2000),
      consequence: clip(d.proposal.consequence, 1000), blockedAction: clip(d.proposal.blocked_action, 1000),
      blocksScope: d.proposal.blocks_scope, deadline: d.proposal.deadline,
      answer: d.answer ? { action: d.answer.action, scope: d.answer.scope, text: clip(d.answer.text, 1000) } : null,
      result: d.result ? { state: d.result.state, evidence: clip(d.result.evidence, 1000) } : null,
    }));
  }

  readDecision(decisionId: string) {
    const id = this.botConversationId;
    if (!id) throw new Error('This call is not placed to a bot.');
    const decision = this.bots.view(this.actor, this.bots.read(this.actor, decisionId));
    if (decision.conversation_id !== id) throw new Error('That decision belongs to another bot.');
    const thread = this.bots.thread(this.actor, decisionId);
    const summary = this.decisions().find(d => d.decisionId === decisionId)!;
    return { ...summary, evidence: (decision.proposal.evidence as { label: string }[]).map(e => clip(e.label, 300)),
      discussion: (thread.messages as { actor_name: string; actor_conversation_id: string | null; text: string; created_at: string }[])
        .slice(-20).map(m => ({ from: m.actor_conversation_id ? decision.bot_name : m.actor_name, text: clip(m.text, 2000), at: m.created_at })) };
  }

  discuss(sessionId: string, decisionId: string, text: string) {
    this.readDecision(decisionId);
    const clean = clip(text, 12000).trim();
    if (!clean) throw new Error('Nothing to send.');
    const decision = this.bots.reply(this.actor, decisionId, `voice:${sessionId}:${Date.now()}`, `[Voice call] ${clean}`);
    return { ok: true, decisionId: decision.id, delivery: 'Discussion message posted; it wakes the bot but does not approve anything.' };
  }

  answerDecision(sessionId: string, input: unknown) {
    const { decisionId, version, action, text, scope } = DecisionAnswerSchema.parse(input);
    const current = this.readDecision(decisionId);
    if (!current.canAnswer) throw new Error('Only the assigned approver can answer this decision.');
    if (current.state !== 'needs_input') throw new Error('This decision already has an answer.');
    const decision = this.bots.answer(this.actor, decisionId, version, `voice:${sessionId}:answer:${version}`, { action, text, scope });
    this.record(sessionId, 'decision', `${decision.bot_name}: ${action} — ${text}${scope === 'standing_rule' ? ' (standing rule requested)' : ''}`);
    return { ok: true, decisionId, state: decision.state, delivery: 'Decision recorded and delivered to the bot. Execution is tracked separately; it has not been verified.' };
  }

  history(limit = 40): { id: number; role: string; text: string; createdAt: string }[] {
    if (this.botConversationId) this.visibleChat(this.botConversationId);
    return this.ctx.db.prepare(`SELECT id, role, text, created_at AS createdAt FROM
      (SELECT * FROM voice_entries WHERE user_id=? AND bot_conversation_id IS ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .all(this.userId, this.botConversationId, limit) as { id: number; role: string; text: string; createdAt: string }[];
  }

  record(sessionId: string, role: 'user' | 'assistant' | 'decision', text: string) {
    if (this.botConversationId) this.visibleChat(this.botConversationId);
    const clean = clip(text, 8000).trim();
    if (clean) this.ctx.db.prepare('INSERT INTO voice_entries(user_id,session_id,role,text,bot_conversation_id) VALUES(?,?,?,?,?)')
      .run(this.userId, sessionId, role, clean, this.botConversationId);
  }

  async answer(sessionId: string, input: unknown) {
    const { requestId, answers } = AnswerSchema.parse(input);
    const row = this.question(requestId);
    if (row && !canManageConversation(this.user, this.visibleChat(row.conversation_id), this.ctx.db)) throw new Error('You cannot answer in this chat.');
    if (!row || !this.prompts(row).length) throw new Error('Question not available to voice.');
    if (this.botConversationId && row.conversation_id !== this.botConversationId) throw new Error('That question belongs to another chat.');
    const canonical = (a: QuestionAnswers) => JSON.stringify(Object.keys(a).sort().map(k => [k, [...a[k]!].sort()]));
    const existing = this.ctx.db.prepare('SELECT answers_json, status FROM voice_decisions WHERE user_id=? AND request_id=?')
      .get(this.userId, requestId) as { answers_json: string; status: string } | undefined;
    const current = await this.ctx.manager.getQuestion(requestId);
    if (current?.status === 'answered' && existing && canonical(JSON.parse(existing.answers_json)) === canonical(answers) && canonical(current.answers) === canonical(answers)) {
      this.ctx.db.prepare("UPDATE voice_decisions SET status='delivered' WHERE user_id=? AND request_id=?")
        .run(this.userId,requestId);
      return { ok: true, alreadyDelivered: true };
    }
    if (!current || current.status !== 'pending' || current.kind === 'secret' || current.kind === 'reveal') {
      throw new Error('This question is no longer waiting for an answer.');
    }
    this.ctx.db.prepare(`INSERT INTO voice_decisions(user_id,request_id,answers_json,status) VALUES(?,?,?,'sending')
      ON CONFLICT(user_id,request_id) DO UPDATE SET answers_json=excluded.answers_json,status='sending',updated_at=datetime('now')`)
      .run(this.userId, requestId, JSON.stringify(answers));
    // The existing runner validates options, persists the answer, and releases its waiting agent.
    const result = await this.ctx.manager.resolveQuestion(requestId, answers);
    this.ctx.db.prepare("UPDATE voice_decisions SET status=?,updated_at=datetime('now') WHERE user_id=? AND request_id=? AND status!='delivered'")
      .run(result.ok ? 'delivered' : 'failed', this.userId, requestId);
    if (!result.ok) throw new Error(result.error === 'invalid' ? 'Choose valid answers for every question.' : 'Question was already resolved or expired.');
    this.record(sessionId, 'decision', `${row.title ?? 'Chat'}: ${JSON.stringify(answers)} — delivered to the waiting agent.`);
    return { ok: true, conversationId: row.conversation_id, delivery: 'Answer saved and delivered. Agent completion has not been verified.' };
  }
}
