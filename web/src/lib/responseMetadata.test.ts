import { describe, expect, it } from 'vitest';
import {
  formatResponseTime,
  formatResponseTokenCount,
  normalizeResponseTokenUsage,
  responseTokenBreakdown,
  responseTokenRows,
} from './responseMetadata';

describe('assistant response metadata', () => {
  it('accepts reliable usage and formats a compact total with an exact breakdown', () => {
    const usage = normalizeResponseTokenUsage({
      inputTokens: 18_000,
      outputTokens: 24,
      totalInputTokens: 31_176,
      totalOutputTokens: 24,
      totalTokens: 31_200,
    });

    expect(usage).toEqual({ totalInputTokens: 31_176, totalOutputTokens: 24, totalTokens: 31_200 });
    expect(formatResponseTokenCount(usage!)).toBe('31.2k');
    expect(responseTokenBreakdown(usage!)).toBe('31,176 input + 24 output tokens this turn');
  });

  it('does not round a near-million total to 1000k', () => {
    expect(formatResponseTokenCount({ totalTokens: 999_999 })).toBe('1M');
  });

  it.each([
    undefined,
    {},
    { inputTokens: 10 },
    { totalTokens: -1 },
    { totalTokens: 1.5 },
    { totalTokens: 0 },
    { totalTokens: Number.NaN },
  ])('omits missing or unreliable usage: %j', (usage) => {
    expect(normalizeResponseTokenUsage(usage)).toBeUndefined();
  });

  it('keeps a reliable total but omits an inconsistent breakdown', () => {
    const usage = normalizeResponseTokenUsage({
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalTokens: 999,
    });

    expect(usage).toEqual({ totalTokens: 999 });
    expect(responseTokenBreakdown(usage!)).toBe('999 tokens used this turn');
  });

  it('keeps a consistent cache split and reports input as the uncached remainder', () => {
    const usage = normalizeResponseTokenUsage({
      inputTokens: 18_000,
      outputTokens: 24,
      totalInputTokens: 31_176,
      totalOutputTokens: 24,
      totalTokens: 31_200,
      cachedInputTokens: 30_000,
      cacheWriteInputTokens: 1_000,
    });

    expect(usage).toEqual({
      totalInputTokens: 31_176,
      totalOutputTokens: 24,
      totalTokens: 31_200,
      cachedInputTokens: 30_000,
      cacheWriteInputTokens: 1_000,
    });
    expect(responseTokenRows(usage!)).toEqual([
      { key: 'input', label: 'Input', value: 176 },
      { key: 'cacheRead', label: 'Cache read', value: 30_000 },
      { key: 'cacheWrite', label: 'Cache write', value: 1_000 },
      { key: 'output', label: 'Output', value: 24 },
      { key: 'total', label: 'Total', value: 31_200 },
    ]);
  });

  it('keeps a cache-read-only split, as Codex reports no cache writes', () => {
    const usage = normalizeResponseTokenUsage({
      totalInputTokens: 69_960,
      totalOutputTokens: 648,
      totalTokens: 70_608,
      cachedInputTokens: 61_952,
    });

    expect(usage).toEqual({
      totalInputTokens: 69_960,
      totalOutputTokens: 648,
      totalTokens: 70_608,
      cachedInputTokens: 61_952,
    });
    expect(responseTokenRows(usage!).map((row) => row.key)).toEqual([
      'input',
      'cacheRead',
      'output',
      'total',
    ]);
    expect(responseTokenRows(usage!)[0]).toEqual({ key: 'input', label: 'Input', value: 8_008 });
  });

  it.each([
    { cachedInputTokens: 200, cacheWriteInputTokens: 1 },
    { cachedInputTokens: -1 },
    { cachedInputTokens: 1.5 },
  ])('drops a cache split that cannot be a subset of input: %j', (cache) => {
    const usage = normalizeResponseTokenUsage({
      totalInputTokens: 200,
      totalOutputTokens: 10,
      totalTokens: 210,
      ...cache,
    });

    expect(usage).toEqual({ totalInputTokens: 200, totalOutputTokens: 10, totalTokens: 210 });
  });

  it('falls back to input/output/total rows without a cache split', () => {
    expect(
      responseTokenRows({ totalInputTokens: 100, totalOutputTokens: 10, totalTokens: 110 }),
    ).toEqual([
      { key: 'input', label: 'Input', value: 100 },
      { key: 'output', label: 'Output', value: 10 },
      { key: 'total', label: 'Total', value: 110 },
    ]);
  });

  it('shows only a total row when the breakdown is unreliable', () => {
    expect(responseTokenRows({ totalTokens: 999 })).toEqual([
      { key: 'total', label: 'Total', value: 999 },
    ]);
  });

  it('omits an invalid timestamp', () => {
    expect(formatResponseTime(undefined)).toBe('');
    expect(formatResponseTime('not-a-date')).toBe('');
  });
});
