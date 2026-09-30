import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionsForConversation, OpenQuestionsPanel, readChatDecisions, subscribeChatDecisions, CHAT_DECISIONS_CHANGED } from './OpenQuestionsPanel';
import { botsApi } from '@/lib/bots';

vi.mock('@/lib/bots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bots')>();
  return { ...actual, botsApi: { ...actual.botsApi, decisionsFor: vi.fn() } };
});
import { BotCommunicationContent } from '../BotCommunication';
import type { BotDecision } from '@/lib/bots';

const decision = (id: string, state: string, action?: string, conversationId = 'chat') => ({
  id, state, conversation_id: conversationId, answer: action ? { action } : null,
} as BotDecision);

describe('chat open questions', () => {
  it('keeps only unanswered questions for this chat; answered work stays in history', () => {
    const decisions = [
      decision('pending', 'needs_input'), decision('blocked', 'blocked', 'approve'),
      decision('deferred', 'decided', 'defer'), decision('running', 'running', 'approve'),
      decision('completed', 'verified_completed', 'approve'), decision('rejected', 'decided', 'reject'),
      decision('withdrawn', 'decided', 'withdraw'), decision('other', 'needs_input', undefined, 'other-chat'),
    ];
    expect(questionsForConversation(decisions, 'chat').map(d => d.id)).toEqual(['pending']);
    expect(questionsForConversation(decisions, 'other-chat').map(d => d.id)).toEqual(['other']);
  });

  it('removes persistent obligations from transcript rendering without dropping the underlying records', () => {
    const props = { data: { drafts: [], briefings: [], approved_obligations: [{ decision_id: 'original', version: 4, ready: false, reason: 'Awaiting source mapping' }] }, error: '', refresh: () => {} };
    expect(renderToStaticMarkup(<BotCommunicationContent {...props} hideDrafts hideObligations />)).not.toContain('Original approved message');
    expect(renderToStaticMarkup(<BotCommunicationContent {...props} />)).toContain('Awaiting source mapping');
    expect(props.data.approved_obligations).toHaveLength(1);
  });

  it('exposes unanswered questions and a separate progress link while loading', () => {
    const html = renderToStaticMarkup(<OpenQuestionsPanel conversationId="chat" onClose={() => {}} onNavigate={() => {}} />);
    expect(html).toContain('Close open questions');
    expect(html).toContain('aria-label="Needs your input"');
    expect(html).not.toContain('aria-label="Follow-through"');
    expect(html).toContain('Progress &amp; history');
    expect(html).toContain('Loading questions');
    expect(html).not.toContain('No questions waiting');
  });

  describe('shared per-chat poller', () => {
    type Listener = (event?: unknown) => void;
    const windowListeners = new Map<string, Set<Listener>>();
    const timers: { fn: () => void; ms: number }[] = [];
    beforeEach(() => {
      timers.length = 0; windowListeners.clear();
      const on = (name: string, fn: Listener) => { (windowListeners.get(name) ?? windowListeners.set(name, new Set()).get(name)!).add(fn); };
      const off = (name: string, fn: Listener) => windowListeners.get(name)?.delete(fn);
      vi.stubGlobal('window', { setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }), clearTimeout: () => undefined, addEventListener: on, removeEventListener: off });
      vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: on, removeEventListener: off });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.mocked(botsApi.decisionsFor).mockReset(); });
    const deferred = () => { let resolve!: (v: { decisions: BotDecision[] }) => void; let reject!: (e: Error) => void; const promise = new Promise<{ decisions: BotDecision[] }>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

    it('makes one request for every consumer, keeps a slow reply, and polls only after the last one settles', async () => {
      const first = deferred();
      vi.mocked(botsApi.decisionsFor).mockReturnValueOnce(first.promise);
      const notified: string[] = [];
      const stopA = subscribeChatDecisions('slow', () => notified.push('a'));
      const stopB = subscribeChatDecisions('slow', () => notified.push('b'));
      expect(botsApi.decisionsFor).toHaveBeenCalledTimes(1);
      expect(readChatDecisions('slow')).toMatchObject({ loaded: false, decisions: [] });
      // Refresh triggers while the request is in flight never start a second one.
      for (const fn of windowListeners.get(CHAT_DECISIONS_CHANGED) ?? []) fn();
      for (const fn of windowListeners.get('focus') ?? []) fn();
      expect(botsApi.decisionsFor).toHaveBeenCalledTimes(1);
      expect(timers).toHaveLength(0);
      // The reply lands well after a "poll interval" would have elapsed and is still applied.
      first.resolve({ decisions: [decision('q', 'needs_input', undefined, 'slow'), decision('elsewhere', 'needs_input', undefined, 'other')] });
      await first.promise;
      expect(readChatDecisions('slow')).toMatchObject({ loaded: true, error: '' });
      expect(readChatDecisions('slow')!.decisions.map(d => d.id)).toEqual(['q']);
      expect(notified).toEqual(['a', 'b']);
      expect(timers).toHaveLength(1);
      // A failure keeps the last questions and reports the error instead of loading forever.
      const second = deferred();
      vi.mocked(botsApi.decisionsFor).mockReturnValueOnce(second.promise);
      timers.shift()!.fn();
      second.reject(new Error('tunnel'));
      await second.promise.catch(() => undefined);
      expect(readChatDecisions('slow')).toMatchObject({ loaded: true, error: 'Could not refresh open questions.' });
      expect(readChatDecisions('slow')!.decisions.map(d => d.id)).toEqual(['q']);
      stopA(); stopB();
      expect(windowListeners.get(CHAT_DECISIONS_CHANGED)?.size ?? 0).toBe(0);
    });
  });
});
