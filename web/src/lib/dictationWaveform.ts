import { useSyncExternalStore } from 'react';

export type DictationWaveformStyle = 10 | 16;

export interface DictationWaveformOption {
  id: DictationWaveformStyle;
  label: string;
  description: string;
}

export const DICTATION_WAVEFORM_OPTIONS: readonly DictationWaveformOption[] = [
  {
    id: 10,
    label: 'Golden Filament',
    description: 'A warm, flowing line with a soft glow.',
  },
  {
    id: 16,
    label: 'Voice Memos',
    description: 'Fine scrolling bars inspired by a classic voice recorder.',
  },
];

export const DEFAULT_DICTATION_WAVEFORM_STYLE: DictationWaveformStyle = 16;

const STORAGE_KEY = 'vp-dictation-waveform';
const listeners = new Set<() => void>();

function isDictationWaveformStyle(value: number): value is DictationWaveformStyle {
  return value === 10 || value === 16;
}

function readStoredStyle(): DictationWaveformStyle {
  if (typeof window === 'undefined') return DEFAULT_DICTATION_WAVEFORM_STYLE;
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    if (isDictationWaveformStyle(stored)) return stored;
  } catch {
    /* localStorage unavailable — retain the in-memory preference */
  }
  return DEFAULT_DICTATION_WAVEFORM_STYLE;
}

let currentStyle = readStoredStyle();

function notify() {
  for (const listener of listeners) listener();
}

function getDictationWaveformStyle(): DictationWaveformStyle {
  return currentStyle;
}

function getDefaultDictationWaveformStyle(): DictationWaveformStyle {
  return DEFAULT_DICTATION_WAVEFORM_STYLE;
}

export function setDictationWaveformStyle(style: DictationWaveformStyle): void {
  currentStyle = style;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(style));
  } catch {
    /* non-fatal: the choice still applies until this page is reloaded */
  }
  notify();
}

function subscribeDictationWaveformStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDictationWaveformStyle(): DictationWaveformStyle {
  return useSyncExternalStore(
    subscribeDictationWaveformStyle,
    getDictationWaveformStyle,
    getDefaultDictationWaveformStyle,
  );
}

export function dictationWaveformLabel(style: DictationWaveformStyle): string {
  return DICTATION_WAVEFORM_OPTIONS.find((option) => option.id === style)?.label ?? 'Voice Memos';
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const next = readStoredStyle();
    if (next === currentStyle) return;
    currentStyle = next;
    notify();
  });
}
