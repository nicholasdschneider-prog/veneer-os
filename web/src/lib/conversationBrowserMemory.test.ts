import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationBrowserPollState,
  rememberConversationBrowserDismissal,
  rememberedConversationBrowserDismissal,
} from './conversationBrowserMemory';

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
      setItem: (key: string, value: string) => {
        if (storageThrows) throw new Error('localStorage unavailable');
        store[key] = value;
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

const NOW = Date.parse('2026-08-25T22:40:00.000Z');
const CLOSED_AT = NOW - 60_000;
const startedBeforeClose = { active: true, startedAt: new Date(CLOSED_AT - 5 * 60_000).toISOString() };
const startedAfterClose = { active: true, startedAt: new Date(CLOSED_AT + 30_000).toISOString() };

describe('conversation browser dismissal memory', () => {
  it('keeps a user-closed active browser hidden', () => {
    expect(conversationBrowserPollState(startedBeforeClose, CLOSED_AT, false, NOW)).toEqual({
      dismissedAt: CLOSED_AT,
      shouldOpen: false,
    });
  });

  it('opens an active browser when the user has not closed it', () => {
    expect(conversationBrowserPollState(startedBeforeClose, null, false, NOW)).toEqual({
      dismissedAt: null,
      shouldOpen: true,
    });
  });

  it('keeps an explicitly selected preview above an active browser', () => {
    const selectedPreview = conversationBrowserPollState(startedBeforeClose, null, true, NOW);
    expect(selectedPreview).toEqual({ dismissedAt: NOW, shouldOpen: false });

    expect(conversationBrowserPollState(startedBeforeClose, selectedPreview.dismissedAt, false, NOW + 3_000)).toEqual({
      dismissedAt: NOW,
      shouldOpen: false,
    });
  });

  it('keeps the dismissal through a runtime restart between commands', () => {
    // The agent's browser restarts between commands, so one poll reads inactive.
    const paused = conversationBrowserPollState({ active: false, startedAt: null }, CLOSED_AT, false, NOW);
    expect(paused).toEqual({ dismissedAt: CLOSED_AT, shouldOpen: false });

    expect(conversationBrowserPollState(startedBeforeClose, paused.dismissedAt, false, NOW + 3_000)).toEqual({
      dismissedAt: CLOSED_AT,
      shouldOpen: false,
    });
  });

  it('reopens for a browser session that started after the close', () => {
    expect(conversationBrowserPollState(startedAfterClose, CLOSED_AT, false, NOW)).toEqual({
      dismissedAt: null,
      shouldOpen: true,
    });
  });

  it('stays closed when the session start time is unknown', () => {
    expect(conversationBrowserPollState({ active: true, startedAt: null }, CLOSED_AT, false, NOW)).toEqual({
      dismissedAt: CLOSED_AT,
      shouldOpen: false,
    });
  });

  it('keeps dismissal state isolated per chat', () => {
    rememberConversationBrowserDismissal('chat-a', CLOSED_AT);

    expect(rememberedConversationBrowserDismissal('chat-a')).toBe(CLOSED_AT);
    expect(rememberedConversationBrowserDismissal('chat-b')).toBeNull();

    rememberConversationBrowserDismissal('chat-a', null);
    expect(rememberedConversationBrowserDismissal('chat-a')).toBeNull();
  });

  it('ignores a corrupt stored value', () => {
    store['veneer:chat-browser-dismissed-at:chat-a'] = 'nope';
    expect(rememberedConversationBrowserDismissal('chat-a')).toBeNull();
  });

  it('keeps the close flow usable when local storage is blocked', () => {
    storageThrows = true;

    expect(rememberedConversationBrowserDismissal('chat-a')).toBeNull();
    expect(() => rememberConversationBrowserDismissal('chat-a', CLOSED_AT)).not.toThrow();
  });
});
