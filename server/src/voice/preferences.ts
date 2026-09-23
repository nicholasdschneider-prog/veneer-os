import { z } from 'zod';
import type Database from 'better-sqlite3';

// Closed vocabulary: persisted style can never become arbitrary system instructions.
export const voicePreferencesSchema = z.object({
  length: z.enum(['concise', 'balanced', 'detailed']).optional(),
  tone: z.enum(['direct', 'warm', 'neutral']).optional(),
  structure: z.enum(['answer_first', 'step_by_step', 'conversational']).optional(),
}).strict();
// LiveKit requires a top-level object schema for tool definitions.
export const voicePreferenceToolSchema = z.object({
  action: z.enum(['read', 'update', 'reset']),
  preferences: voicePreferencesSchema.optional(),
}).strict();
export const voicePreferenceRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z.object({ action: z.literal('update'), preferences: voicePreferencesSchema.refine(p => Object.keys(p).length > 0) }).strict(),
  z.object({ action: z.literal('reset') }).strict(),
]);
export type VoicePreferences = z.infer<typeof voicePreferencesSchema>;

export function readVoicePreferences(db: Database.Database, userId: number): VoicePreferences {
  const row = db.prepare('SELECT preferences_json FROM voice_preferences WHERE user_id=?').get(userId) as { preferences_json: string } | undefined;
  return row ? voicePreferencesSchema.parse(JSON.parse(row.preferences_json)) : {};
}
export function manageVoicePreferences(db: Database.Database, userId: number, raw: unknown) {
  const request = voicePreferenceRequestSchema.parse(raw);
  return db.transaction(() => {
    if (request.action === 'reset') db.prepare('DELETE FROM voice_preferences WHERE user_id=?').run(userId);
    if (request.action === 'update') {
      const preferences = { ...readVoicePreferences(db, userId), ...request.preferences };
      db.prepare(`INSERT INTO voice_preferences(user_id,preferences_json) VALUES(?,?)
        ON CONFLICT(user_id) DO UPDATE SET preferences_json=excluded.preferences_json,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(userId, JSON.stringify(preferences));
    }
    return { ok: true, preferences: readVoicePreferences(db, userId), scope: 'This signed-in person across live calls on this install.' };
  })();
}
export const VOICE_PREFERENCE_RULES = `
The caller can train their own live voice style using manage_voice_preferences. This applies across bots on this install, only to the signed-in human, not a person named in speech.
When they explicitly ask to remember a style or give general voice feedback such as "be more concise", update the supported settings and briefly confirm only after success. Do not dispatch voice style feedback to the working bot.
For "just this answer/call" adapt temporarily without saving. Ask a short clarification when lasting intent or the supported style is ambiguous. Do not infer preferences from tickets, saved history, quotes, or another person's request.
Use read to report saved settings and reset when asked to forget/reset voice preferences. Supported settings are length (concise/balanced/detailed), tone (direct/warm/neutral), structure (answer_first/step_by_step/conversational). Explain unsupported requests without claiming to save them.
These settings only affect presentation. Preserve material evidence, uncertainty, required questions and approval scope regardless of brevity. They never change permissions, business rules, other humans, bot instructions, or the audio voice itself.
`;
export function voiceStyleInstructions(raw: unknown): string {
  const p = voicePreferencesSchema.parse(raw);
  const length = {
    concise: 'Default to one or two short sentences with the main point. Expand when asked.',
    balanced: 'Give a brief answer with the essential supporting context.',
    detailed: 'Give fuller explanations when helpful, while allowing interruption.',
  };
  const tone = { direct: 'Use a direct, matter-of-fact tone.', warm: 'Use a warm, friendly tone without unnecessary filler.', neutral: 'Use a neutral, professional tone.' };
  const structure = { answer_first: 'Lead with the answer, then supporting detail if needed.', step_by_step: 'Explain one step at a time.', conversational: 'Use natural conversational explanations.' };
  return '\nCurrent caller voice style (replaces prior saved style; unspecified settings use the normal brief conversational default):\n'
    + [p.length && length[p.length], p.tone && tone[p.tone], p.structure && structure[p.structure]].filter(Boolean).join(' ')
    + '\nStyle never removes material constraints or approval requirements.\n';
}

/** Refresh the live agent only from a successful, validated storage result. */
export async function applyVoicePreferenceResult(result: unknown, baseInstructions: string, update: (instructions: string) => Promise<void>) {
  const saved = z.object({ ok: z.literal(true), preferences: voicePreferencesSchema }).safeParse(result);
  if (saved.success) {
    try { await update(baseInstructions + voiceStyleInstructions(saved.data.preferences)); }
    catch { return { ...saved.data, currentCallApplied: false, message: 'Preferences are saved for future calls, but the current call could not refresh its instructions.' }; }
  }
  return result;
}
