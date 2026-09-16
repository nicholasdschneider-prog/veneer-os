import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyColorMode, applyTheme, getColorMode } from './theme';

const values = new Map<string, string>();
const dataset: Record<string, string> = {};
const metas = [
  { media: '(prefers-color-scheme: light)', content: '#fafafa' },
  { media: '(prefers-color-scheme: dark)', content: '#191c21' },
];

beforeEach(() => {
  values.clear();
  for (const key of Object.keys(dataset)) delete dataset[key];
  metas[0]!.content = '#fafafa';
  metas[1]!.content = '#191c21';

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('document', {
    documentElement: { dataset },
    querySelectorAll: () => metas,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('color mode', () => {
  it('uses System when no valid saved mode exists', () => {
    expect(getColorMode()).toBe('system');
    values.set('vp-color-mode', 'sepia');
    expect(getColorMode()).toBe('system');
  });

  it('saves and applies forced modes, then restores System behavior', () => {
    applyColorMode('dark');
    expect(dataset.colorMode).toBe('dark');
    expect(values.get('vp-color-mode')).toBe('dark');
    expect(metas.map((meta) => meta.content)).toEqual(['#191c21', '#191c21']);

    applyColorMode('system');
    expect(dataset.colorMode).toBeUndefined();
    expect(values.get('vp-color-mode')).toBe('system');
    expect(metas.map((meta) => meta.content)).toEqual(['#fafafa', '#191c21']);
  });

  it('keeps an always-dark named theme dark and restores the saved mode later', () => {
    applyTheme('terminal');
    applyColorMode('light');
    expect(metas.map((meta) => meta.content)).toEqual(['#101014', '#101014']);

    applyTheme('default');
    expect(dataset.theme).toBeUndefined();
    expect(dataset.colorMode).toBe('light');
    expect(metas.map((meta) => meta.content)).toEqual(['#fafafa', '#fafafa']);
  });
});
