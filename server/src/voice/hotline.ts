import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { createBotService } from '../bots/service.js';
import { questionLine } from '../bots/questionLine.js';
import { VoiceWorkspace } from './workspace.js';

/** Coordinator only: every case operation is delegated to a freshly authorized, pinned workspace. */
export class QuestionHotline {
  constructor(private ctx: AppContext, private userId: number, private timezone = 'UTC') {}
  private line() {
    const user = this.ctx.db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(this.userId) as UserRow | undefined;
    if (!user) throw new Error('Caller is no longer available.');
    return questionLine(this.ctx,user);
  }
  list() { const s=this.line().snapshot(); return { now:new Date().toISOString(), timezone:this.timezone, revision:s.revision, selectedId:s.selectedId, questions:s.decisions.map(d=>({decisionId:d.id,bot:d.bot_name,conversationId:d.conversation_id,question:d.proposal.question,version:d.version})), reminders:s.sleeping.map(d=>({decisionId:d.id,bot:d.bot_name,until:d.until})) }; }
  navigate(action: 'next'|'select'|'skip'|'remind'|'show', decisionId?: string, until?: number, delayMinutes?: number): ReturnType<QuestionHotline['focus']> | {empty:boolean;message:string} {
    if(action==='remind' && delayMinutes!==undefined) { if(!Number.isFinite(delayMinutes)||delayMinutes<1||delayMinutes>43200) throw new Error('Choose a reminder between one minute and 30 days.'); until=Date.now()+Math.round(delayMinutes*60000); }
    const line=this.line(); const s=line.snapshot();
    if(action==='show') { const id=decisionId ?? s.selectedId ?? ''; this.workspace(id);line.mutate({action:'show',decisionId:id,revision:s.revision});return this.focus(id); }
    if(action==='skip'||action==='remind') {
      if(!s.selectedId || (decisionId && decisionId!==s.selectedId)) throw new Error('Read the selected question before moving it.');
      line.mutate({action:action==='skip'?'back':'remind',decisionId:s.selectedId,revision:s.revision,...(until ? {until}: {})});
      return this.navigate('next');
    }
    const target=action==='select' ? decisionId : s.selectedId ?? s.decisions[0]?.id;
    if(!target) return {empty:true,message:'No questions waiting. Reminders remain saved.'};
    line.mutate({action:'select',decisionId:target,revision:s.revision});
    return this.focus(target);
  }
  workspace(decisionId: string, readOnly = false) {
    const s=this.line().snapshot();
    if(!readOnly && s.selectedId!==decisionId) throw new Error('Select and read this question before acting.');
    const user=this.ctx.db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(this.userId) as UserRow;
    const service=createBotService(this.ctx.db);
    const d=readOnly ? service.view({user},service.read({user},decisionId)) : s.decisions.find(d=>d.id===decisionId);
    if(!d) throw new Error('This question is no longer waiting.');
    // Requires actual conversation access as well as decision access; shared decision context
    // alone must not expose the source chat or impersonate its owning bot.
    const workspace=new VoiceWorkspace(this.ctx,this.userId,d.conversation_id); workspace.bot();
    return workspace;
  }
  focus(decisionId: string) { const w=this.workspace(decisionId); return {bot:w.bot().name,...w.voiceDecision(decisionId)}; }
}

export const HOTLINE_INSTRUCTIONS = `You are the question hotline coordinator, not any of the individual bots. Speak English unless the caller requests another language. Identify the bot owning each question. Use question_line to read the current line and navigate_question next to select its front. Discuss one question at a time in the server's round-robin order by default. The caller ALWAYS may switch to another bot or question without answering the current one. When asked to start with or go to a named bot, immediately use question_line then navigate_question select for its exact ID. Never insist on finishing the current question first. Selection and skipping are navigation, not answers, and do not need consent to the proposal. Read all read_decision proposal pages before advising an answer, including exact choices, recipient, amounts and constraints. Give a brief question and grounded recommendation, then wait for the caller. Do not infer an answer from silence, thinking aloud, questions, or conditional statements. For answer_choice or answer_decision include callerQuote quoting the ENTIRE latest caller utterance verbatim. One caller utterance can answer only the exact question/version visible when they began speaking. Never carry a selection to a later question. On a missing-fresh-answer error, do not retry an earlier quote; wait for the caller. This answer guard never prevents navigation, showing evidence, skipping or reminders. For a clearly selected card option use answer_choice with its exact choice ID and version; for explicit approve/reject/defer/withdraw use answer_decision. Clarify ambiguous selections. Repeat the specific answer briefly before recording it. Never ask for a duplicate click after successful recording. Say answer recorded, not action completed. A successful answer or skip returns the selected next question. Before introducing the next item, call read_decision on nextQuestion.decisionId and speak its returned bot and question exactly. Never infer the next item from the old list or assume the same bot goes again. Then wait for a NEW caller answer. Use navigate_question next to refresh if needed. Never repeat the previous approval on the next question. On failure or unknown outcome, reread and reconcile; never replay an uncertain effect. For follow-up information use discuss_decision; this contacts the original owning bot and does not approve anything. Read its latest discussion before reporting results. Never claim photos were viewed from metadata; navigate_question show displays the card and its evidence for the caller. Skip means navigate_question skip, not a decision defer; For relative reminders use delayMinutes (one hour is 60), never calculate Unix milliseconds yourself. For absolute reminders use until in Unix milliseconds from the explicit caller-local time and timezone supplied by question_line; clarify ambiguous times. To go to a named bot, list the line and select its exact question; clarify duplicate names. When asked to stop, use end_hotline. Ending preserves unanswered questions. Never dispatch arbitrary work or share a whole multi-bot transcript with any bot. This mode uses only each question's existing access and approval rights.\n`;
