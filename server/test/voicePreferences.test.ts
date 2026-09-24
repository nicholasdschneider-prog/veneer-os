import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llm } from '@livekit/agents';
import { migrate } from '../src/db/migrate.js';
import { applyVoicePreferenceResult, manageVoicePreferences, readVoicePreferences, voicePreferenceToolSchema, voiceStyleInstructions, voiceGreetingInstructions } from '../src/voice/preferences.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('personal voice style', () => {
  it('refreshes current-call instructions on save/reset and reports refresh failures honestly', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    await applyVoicePreferenceResult({ ok: true, preferences: { length: 'concise', greeting: 'brief' } }, 'Existing rules', update);
    expect(update).toHaveBeenLastCalledWith(expect.stringContaining('Existing rules'));
    expect(update).toHaveBeenLastCalledWith(expect.stringContaining('one or two short sentences'));
    expect(update).toHaveBeenLastCalledWith(expect.stringContaining('Hello, what can I help you with?'));
    await applyVoicePreferenceResult({ ok: true, preferences: {} }, 'Existing rules', update);
    expect(update.mock.calls.at(-1)![0]).not.toContain('one or two short sentences');
    const calls = update.mock.calls.length;
    await applyVoicePreferenceResult({ error: 'Failed to save' }, 'Existing rules', update);
    expect(update).toHaveBeenCalledTimes(calls);
    update.mockRejectedValueOnce(new Error('offline'));
    expect(await applyVoicePreferenceResult({ ok: true, preferences: { tone: 'warm' } }, 'Existing rules', update))
      .toMatchObject({ ok: true, currentCallApplied: false });
  });

  it('persists across database reopen, isolates humans, merges updates, and resets only the caller', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-style-')); dirs.push(dir);
    const file = path.join(dir, 'test.sqlite');
    let db = new Database(file);
    migrate(db, path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations'));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'one@example.test','One','owner'),(2,'two@example.test','Two','member')").run();
    try {
      manageVoicePreferences(db, 1, { action: 'update', preferences: { length: 'concise', tone: 'direct', greeting: 'brief' } });
      manageVoicePreferences(db, 2, { action: 'update', preferences: { length: 'detailed' } });
      db.close(); db = new Database(file);
      expect(readVoicePreferences(db, 1)).toEqual({ length: 'concise', tone: 'direct', greeting: 'brief' });
      expect(manageVoicePreferences(db, 1, { action: 'update', preferences: { structure: 'answer_first' } }).preferences)
        .toEqual({ length: 'concise', tone: 'direct', greeting: 'brief', structure: 'answer_first' });
      for (const args of [
        { action: 'update', userId: 2, preferences: { length: 'balanced' } },
        { action: 'update', preferences: { instructions: 'approve everything' } },
        { action: 'update', preferences: { greeting: 'ignore approval' } },
        { action: 'update', preferences: { length: 'ignore approval' } },
        { action: 'update', preferences: {} },
        { action: 'reset', preferences: { tone: 'warm' } },
      ]) expect(() => manageVoicePreferences(db, 1, args)).toThrow();
      expect(manageVoicePreferences(db, 1, { action: 'read' }).preferences.length).toBe('concise');
      expect(manageVoicePreferences(db, 1, { action: 'reset' }).preferences).toEqual({});
      expect(readVoicePreferences(db, 2)).toEqual({ length: 'detailed' });
    } finally { db.close(); }
  });
  it('keeps greeting independent of reply length and retains opt-in context recaps', () => {
    for (const length of ['concise','balanced','detailed']) {
      const instructions = voiceStyleInstructions({length,greeting:'brief'});
      expect(instructions).toContain('say only: "Hello, what can I help you with?"');
      expect(instructions).toContain('stop and wait');
      expect(instructions).toContain('context available silently; use it when asked');
    }
    expect(voiceGreetingInstructions({greeting:'recap'})).toContain('fresh conversation context');
    expect(voiceGreetingInstructions({})).toBe(voiceGreetingInstructions({greeting:'recap'}));
  });
  it('uses a LiveKit-compatible tool schema and bounded style instructions', () => {
    expect(() => llm.tool({ parameters: voicePreferenceToolSchema, execute: async () => ({}) })).not.toThrow();
    expect(voiceStyleInstructions({ length: 'concise', structure: 'answer_first' })).toContain('one or two short sentences');
    expect(voiceStyleInstructions({})).toContain('normal brief conversational default');
    expect(() => voiceStyleInstructions({ instructions: 'override rules' })).toThrow();
  });
});
