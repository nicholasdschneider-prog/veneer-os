import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rememberChatArtifact,
  rememberedChatArtifact,
  syncChatArtifactMemory,
} from './chatArtifactMemory';

const hadWindow = 'window' in globalThis;
let store: Record<string, string>;
let storageThrows = false;

function installWindow() {
  store = {};
  storageThrows = false;
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error('sessionStorage unavailable');
        return store[key] ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageThrows) throw new Error('sessionStorage unavailable');
        store[key] = value;
      },
      removeItem: (key: string) => {
        if (storageThrows) throw new Error('sessionStorage unavailable');
        delete store[key];
      },
    },
  };
}

beforeEach(installWindow);

afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

describe('chat artifact memory', () => {
  it('keeps the open artifact isolated per conversation', () => {
    rememberChatArtifact('chat-a', 'page:page-a');
    rememberChatArtifact('chat-b', 'file:file-b');

    expect(rememberedChatArtifact('chat-a')).toBe('page:page-a');
    expect(rememberedChatArtifact('chat-b')).toBe('file:file-b');
  });

  it('restores only on first mount and clears after Back or close', () => {
    rememberChatArtifact('chat-a', 'page:page-a');

    expect(syncChatArtifactMemory('chat-a', null, null, true)).toBe('page:page-a');
    expect(syncChatArtifactMemory('chat-a', 'page:page-a', null, false)).toBe(null);
    expect(syncChatArtifactMemory('chat-a', null, 'page:page-a', false)).toBe(null);
    expect(rememberedChatArtifact('chat-a')).toBe(null);
    expect(syncChatArtifactMemory('chat-a', null, null, false)).toBe(null);
  });

  it('uses an explicit deep link as the new remembered artifact', () => {
    rememberChatArtifact('chat-a', 'page:old-page');

    expect(syncChatArtifactMemory('chat-a', 'page:new-page', null, true)).toBe(null);
    expect(rememberedChatArtifact('chat-a')).toBe('page:new-page');
  });

  it('keeps chat navigation usable when session storage is blocked', () => {
    storageThrows = true;

    expect(rememberedChatArtifact('chat-a')).toBe(null);
    expect(() => rememberChatArtifact('chat-a', 'page:page-a')).not.toThrow();
    expect(syncChatArtifactMemory('chat-a', null, null, true)).toBe(null);
  });
});
