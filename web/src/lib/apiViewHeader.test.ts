import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

// Every typed message carries the screen it was typed on, so a message that
// reaches the wrong chat is visible in the server log. The JSON content type
// must survive: without it the server cannot read the message at all.
describe('typed messages report the chat on screen', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ['sendMessage', '/api/conversations/chat-a/messages'],
    ['steerMessage', '/api/conversations/chat-a/steer'],
    ['queueMessage', '/api/conversations/chat-a/messages'],
  ] as const)('%s', async (method, path) => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { hash: '#/chat/chat-a' });
    await api[method]('chat-a', 'hello');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(path);
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Veneer-View': '#/chat/chat-a' });
    expect(JSON.parse(String(init?.body)).text).toBe('hello');
  });
});
