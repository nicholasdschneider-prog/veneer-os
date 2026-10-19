import { z } from 'zod';

import type { callVoiceSchema } from './voices.js';

/** The live-voice model provider for one call. Both speak the same Realtime protocol through LiveKit. */
export const voiceProviderSchema = z.enum(['openai', 'grok']);
export type VoiceProvider = z.infer<typeof voiceProviderSchema>;

export const VOICE_PROVIDER_KEYS: Readonly<Record<VoiceProvider, 'OPENAI_API_KEY' | 'XAI_API_KEY'>> = { openai: 'OPENAI_API_KEY', grok: 'XAI_API_KEY' };

/** `VOICE_PROVIDER` in Doppler picks the provider at each call start, so switching needs no restart.
 *  Unset, Grok is used once its key exists; otherwise OpenAI. */
export function selectVoiceProvider(get: (name: string) => string | null | undefined): VoiceProvider {
  const configured = voiceProviderSchema.safeParse(get('VOICE_PROVIDER')?.trim().toLowerCase());
  if (configured.success) return configured.data;
  return get('XAI_API_KEY') ? 'grok' : 'openai';
}

/** Grok has its own voice names: the install's warm default and Archer's lower voice keep their character. */
const GROK_VOICES: Readonly<Record<z.infer<typeof callVoiceSchema>, string>> = { marin: 'ara', cedar: 'rex' };
export const grokVoice = (voice: z.infer<typeof callVoiceSchema>) => GROK_VOICES[voice];

/** A tool that returns nothing gets no follow-up reply. With Grok, a successful dispatch the agent
 *  already announced is returned as nothing so the acknowledgment is not spoken twice. */
export function spokenDispatchResult(provider: VoiceProvider, spoke: boolean, result: unknown): unknown {
  const ok = !!result && typeof result === 'object' && !('error' in result) && (result as { ok?: unknown }).ok !== false;
  return provider === 'grok' && spoke && ok ? undefined : result;
}
