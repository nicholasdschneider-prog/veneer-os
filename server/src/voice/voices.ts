import { z } from 'zod';

// Install-specific assignments use immutable bot identity, never its display name.
const BOT_VOICES: Readonly<Record<string, 'cedar'>> = {
  'f4131f81-27c5-4332-902a-a0d9873dfeb9': 'cedar', // Archer, requested by Nick
};

/** Only the voices configured on this install may cross the worker IPC boundary. */
export const callVoiceSchema = z.enum(['marin', 'cedar']);

export function callVoice(conversationId?: string): z.infer<typeof callVoiceSchema> {
  return callVoiceSchema.parse(conversationId && Object.hasOwn(BOT_VOICES, conversationId)
    ? BOT_VOICES[conversationId] : 'marin');
}
