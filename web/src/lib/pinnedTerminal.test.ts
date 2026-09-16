import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearLegacyTerminalPin, isLegacyTerminalPinned, TERMINAL_PINNED_KEY } from './pinnedTerminal';

// The web suite runs in the node environment (no jsdom), so stub localStorage.
const hadWindow = 'window' in globalThis;
let store: Record<string, string>;
let storageThrows = false;

function installWindow() {
  store = {};
  storageThrows = false;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error('localStorage unavailable');
        return store[key] ?? null;
      },
      removeItem: (key: string) => {
        if (storageThrows) throw new Error('localStorage unavailable');
        delete store[key];
      },
    },
  };
}

beforeEach(installWindow);

afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

describe('legacy terminal pin migration', () => {
  it('starts unpinned', () => {
    expect(isLegacyTerminalPinned()).toBe(false);
  });

  it('reads a former per-device pin', () => {
    store[TERMINAL_PINNED_KEY] = 'true';
    expect(isLegacyTerminalPinned()).toBe(true);
  });

  it('clears the former key after migration', () => {
    store[TERMINAL_PINNED_KEY] = 'true';
    clearLegacyTerminalPin();
    expect(TERMINAL_PINNED_KEY in store).toBe(false);
    expect(isLegacyTerminalPinned()).toBe(false);
  });

  it('stays usable when localStorage is blocked', () => {
    storageThrows = true;
    expect(isLegacyTerminalPinned()).toBe(false);
    expect(() => clearLegacyTerminalPin()).not.toThrow();
  });
});
