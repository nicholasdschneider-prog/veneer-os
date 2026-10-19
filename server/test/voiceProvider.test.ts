import { describe, expect, it } from 'vitest';
import { grokVoice, selectVoiceProvider } from '../src/voice/provider.js';
describe('live voice provider selection', () => {
  it('uses VOICE_PROVIDER when valid, else Grok only once its key exists', () => {
    const pick = (values: Record<string, string>) => selectVoiceProvider(name => values[name]);
    expect(pick({})).toBe('openai');
    expect(pick({ XAI_API_KEY: 'k' })).toBe('grok');
    expect(pick({ XAI_API_KEY: 'k', VOICE_PROVIDER: ' OpenAI ' })).toBe('openai');
    expect(pick({ VOICE_PROVIDER: 'grok' })).toBe('grok');
    expect(pick({ XAI_API_KEY: 'k', VOICE_PROVIDER: 'elevenlabs' })).toBe('grok');
  });
  it('maps each install voice to a Grok voice', () => {
    expect(grokVoice('marin')).toBe('ara');
    expect(grokVoice('cedar')).toBe('rex');
  });
});
