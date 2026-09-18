import type { AppContext } from '../context.js';
import type { ConversationRow, QuestionRow } from '../db/db.js';
import type { QuestionAnswers, QuestionPrompt } from '../runtime/events.js';
import { sanitizeMemoryText } from '../memory/capture.js';
import { z } from 'zod';

export const AnswerSchema = z.object({
  requestId: z.string().min(1).max(200),
  answers: z.record(z.array(z.string().min(1).max(4000)).min(1).max(30)),
});

/** Only the caller's own chats are available to voice, including for administrators. */
export class VoiceWorkspace {
  constructor(private ctx: AppContext, readonly userId: number) {}

  private question(requestId: string): (QuestionRow & { title: string | null }) | undefined {
    return this.ctx.db.prepare(`SELECT q.*, c.title FROM questions q
      JOIN conversations c ON c.id=q.conversation_id
      WHERE q.request_id=? AND c.user_id=?`).get(requestId, this.userId) as
      (QuestionRow & { title: string | null }) | undefined;
  }

  private prompts(row: QuestionRow): QuestionPrompt[] {
    try {
      const prompts = JSON.parse(row.questions_json) as QuestionPrompt[];
      // Secret requests and approval requests are deliberately not voice tools.
      return Array.isArray(prompts) && prompts.every(p => !p.kind || p.kind === 'choice') ? prompts : [];
    } catch { return []; }
  }

  blockers() {
    const rows = this.ctx.db.prepare(`SELECT q.*, c.title FROM questions q
      JOIN conversations c ON c.id=q.conversation_id
      WHERE c.user_id=? AND q.status='pending' ORDER BY q.created_at LIMIT 100`)
      .all(this.userId) as (QuestionRow & { title: string | null })[];
    return rows.flatMap(row => {
      const questions = this.prompts(row);
      return questions.length ? [{ requestId: row.request_id, conversationId: row.conversation_id,
        title: row.title, createdAt: row.created_at, questions }] : [];
    });
  }

  chats() {
    return this.ctx.db.prepare(`SELECT c.id, c.title, p.name AS projectName FROM conversations c
      LEFT JOIN projects p ON p.id=c.project_id WHERE c.user_id=? AND c.archived=0
      ORDER BY c.last_active_at DESC LIMIT 80`).all(this.userId);
  }

  async readChat(conversationId: string) {
    const row = this.ctx.db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?')
      .get(conversationId, this.userId) as ConversationRow | undefined;
    if (!row) throw new Error('Chat not found.');
    const events = await this.ctx.manager.snapshot(row.id);
    const messages = events.flatMap(event => {
      if (event.type === 'turn_started') return [{ role: 'user', text: sanitizeMemoryText(event.text ?? '').slice(0,2000) }];
      if (event.type === 'text_final') return [{ role: 'assistant', text: sanitizeMemoryText(event.markdown).slice(0,2000) }];
      return [];
    }).filter(m => m.text).slice(-12);
    return { conversationId, title: row.title, status: await this.ctx.manager.statusOf(row.id), messages };
  }

  history(limit = 40): { id: number; role: string; text: string; createdAt: string }[] {
    return this.ctx.db.prepare(`SELECT id, role, text, created_at AS createdAt FROM
      (SELECT * FROM voice_entries WHERE user_id=? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .all(this.userId, limit) as { id: number; role: string; text: string; createdAt: string }[];
  }

  record(sessionId: string, role: 'user' | 'assistant' | 'decision', text: string) {
    const clean = sanitizeMemoryText(text).slice(0,8000).trim();
    if (clean) this.ctx.db.prepare('INSERT INTO voice_entries(user_id,session_id,role,text) VALUES(?,?,?,?)')
      .run(this.userId, sessionId, role, clean);
  }

  async answer(sessionId: string, input: unknown) {
    const { requestId, answers } = AnswerSchema.parse(input);
    const row = this.question(requestId);
    if (!row || !this.prompts(row).length) throw new Error('Question not available to voice.');
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
