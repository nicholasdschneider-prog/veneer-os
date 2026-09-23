import { it, expect, vi } from 'vitest';
import { callBotTool } from '../src/mcp/botTools.js';
it.each(['accept_routine_message','claim_routine_message'])('preserves exact draft ID in %s endpoint payload', async name => {
  const args = { draft_id: 'fixture', proof_id: 'proof', claim_key: 'claim', expected_version: 1, request_key: 'once' };
  const callApi = vi.fn(async (_path: string, _init?: RequestInit): Promise<Record<string, unknown>> => ({})); await callBotTool({ name, args, callApi });
  expect(callApi.mock.calls[0]?.[0]).toBe('/api/bot-communication/routine-messages/' + (name.startsWith('accept') ? 'accept' : 'claim'));
  expect(JSON.parse((callApi.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual(args);
});
