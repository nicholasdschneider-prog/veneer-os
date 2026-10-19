import { describe, expect, it } from 'vitest';
import { voiceFailureCode, voiceFailureMessage } from '../src/voice/failure.js';
describe('safe voice failure diagnostics', () => {
  it('extracts nested SDK codes without serializing private provider data', () => {
    for (const [code, expected] of [['context_length_exceeded','context_limit'],['invalid_api_key','authentication'],['insufficient_quota','quota'],['rate_limit_exceeded','rate_limit']]) {
      const result = voiceFailureCode({error:{error:{body:{code,message:'private request and token'}}}});
      expect(result).toBe(expected);
      expect(voiceFailureMessage(result)).not.toContain('private');
    }
    // The shape OpenAI sent when the account ran out of credits on 2026-10-19.
    expect(voiceFailureCode({type:'realtime_model_error',error:{name:'APIError',retryable:true,body:{type:'insufficient_quota',code:'credit_balance_exhausted',message:'private'}}})).toBe('quota');
    expect(voiceFailureCode({error:{body:{type:'insufficient_quota',code:'some_new_code'}}})).toBe('quota');
    expect(voiceFailureCode(new Error('You have no credits remaining. private'))).toBe('quota');
    expect(voiceFailureCode(new Error('Unexpected server response: 400'))).toBe('rejected');
    expect(voiceFailureCode(new Error('Unexpected server response: 401'))).toBe('authentication');
    expect(voiceFailureCode(new Error('Unexpected server response: 429'))).toBe('rate_limit');
    expect(voiceFailureMessage('rejected')).toContain('API key');
    expect(voiceFailureCode(new Error('Maximum context length exceeded: private payload'))).toBe('context_limit');
    expect(voiceFailureCode(new Error('Invalid schema for tool: private payload'))).toBe('tool_schema');
    expect(voiceFailureCode(new Error('fetch failed: private URL'))).toBe('network');
    expect(voiceFailureMessage('tool_schema')).not.toContain('private');
    expect(voiceFailureMessage('network')).not.toContain('private');
    const circular: {error?: unknown} = {}; circular.error = circular;
    expect(voiceFailureCode(circular)).toBe('connection');
    expect(voiceFailureCode(new Error('private request'))).toBe('connection');
    expect(voiceFailureMessage('unknown private content')).not.toContain('private content');
  });
});
