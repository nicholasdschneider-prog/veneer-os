import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const script = new URL('../../agent-skills/veneer-jev/scripts/decide.mjs', import.meta.url);
const { validateRequest, validateResponse, decide } = await import(script.href);
const directories: string[] = [];
const request = {
  state: 'Synthetic update: supplier confirmation arrived.',
  questions: {
    change: { type: 'choice', instructions: 'Classify the update.', criteria: { material: 'New evidence.', unknown: 'Insufficient context.' } },
    reviewed: { type: 'noul', instructions: 'Was it reviewed?', criteria: { true: 'Explicit review.', false: 'No explicit review.' } },
    urgency: { type: 'score', instructions: 'Rate urgency.', criteria: ['Routine', 'Urgent'] },
  },
};
const response = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    change: { type: 'choice', choice: 'unknown', confidence: 0.1, probabilities: { material: 0.4, unknown: 0.6 } },
    reviewed: { type: 'noul', noul: 0.02 },
    urgency: { type: 'score', score: 0.2, confidence: 0.5, probabilities: { '0': 0.8, '1': 0.2 } },
  },
  usage: { cost: 0.0001, input_tokens: 80, output_tokens: 20 },
};

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Jev skill caller', () => {
  it('validates the documented example without credentials or network access by default', () => {
    const guide = fs.readFileSync(new URL('../../agent-skills/veneer-jev/references/caller.md', import.meta.url), 'utf8');
    const example = guide.match(/```json\n([\s\S]*?)\n```/)![1]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-skill-'));
    directories.push(dir);
    const file = path.join(dir, 'request.json');
    fs.writeFileSync(file, example);
    const child = spawnSync(process.execPath, [fileURLToPath(script), file], {
      encoding: 'utf8', env: { PATH: process.env.PATH },
    });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ validated: true, network: false, questions: 2 });
    expect(child.stderr).toBe('');
    expect(child.stdout).not.toContain('supplier');
  });

  it('rejects invalid or oversized requests before network access', async () => {
    const fetchImpl = vi.fn();
    for (const invalid of [
      { ...request, model: 'another-model' },
      { ...request, state: 'x'.repeat(16384) },
      { ...request, questions: {} },
      { ...request, questions: { bad: { type: 'text', instructions: 'Write prose.' } } },
      { ...request, questions: { bad: { type: 'noul', instructions: 'Check.', criteria: {} } } },
    ]) {
      await expect(decide(invalid, { fetchImpl, key: 'test-placeholder' })).rejects.toThrow();
    }
    await expect(decide(request, { fetchImpl, key: '' })).rejects.toThrow('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(validateRequest(request)).model).toBe('typesafe/jev-1.13');
  });

  it('uses the pinned endpoint once and retains unknown and confident-no results without acting on them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...response, debug: 'omit this' })));
    const result = await decide(request, { fetchImpl, key: 'test-placeholder' });
    expect(result).toEqual(response);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });

  it('does not retry or expose provider error bodies or network error details', async () => {
    for (const fetchImpl of [
      vi.fn().mockResolvedValue(new Response('private provider diagnostics', { status: 429 })),
      vi.fn().mockRejectedValue(new Error('private transport diagnostics')),
    ]) {
      await expect(decide(request, { fetchImpl, key: 'test-placeholder' })).rejects.toThrow('no retry');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects missing, malformed, or out-of-rubric answers and treats missing cost as unknown', () => {
    for (const answers of [
      {},
      { ...response.answers, reviewed: { type: 'noul', noul: 2 } },
      { ...response.answers, change: { ...response.answers.change, choice: 'send_refund' } },
      { ...response.answers, change: { ...response.answers.change, probabilities: { material: 0, unknown: 0 } } },
      { ...response.answers, urgency: { ...response.answers.urgency, score: 5 } },
    ]) expect(() => validateResponse({ ...response, answers }, request.questions)).toThrow();
    expect(validateResponse({ ...response, usage: {} }, request.questions).usage.cost).toBeNull();
  });
});
