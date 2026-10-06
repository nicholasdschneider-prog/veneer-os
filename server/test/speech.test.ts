import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { SPEECH_MODEL, spokenFaithfully, synthesizeSpeech } from '../src/bots/speech.js';

let server: WebSocketServer | undefined;
afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())));

/** A Realtime stand-in that "speaks" whatever `say` returns for the script it was given. */
async function realtime(say: (script: string, call: number) => string | null) {
  const seen: { url: string; auth: string; events: Array<Record<string, any>> }[] = [];
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (ws, req) => {
    const call = { url: req.url!, auth: String(req.headers.authorization), events: [] as Array<Record<string, any>> };
    seen.push(call);
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      call.events.push(event);
      if (event.type !== 'response.create') return;
      const script = call.events.find(e => e.type === 'conversation.item.create')!.item.content[0].text as string;
      const transcript = say(script, seen.length);
      if (transcript === null) return ws.send(JSON.stringify({ type: 'error', error: { message: 'no' } }));
      ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(RATE_BYTES).toString('base64') }));
      ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript }));
      ws.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
    });
  });
  await new Promise(resolve => server!.once('listening', resolve));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`, seen };
}
const RATE_BYTES = 48000;

describe('speech', () => {
  it('accepts exact readings and rejects answers, summaries and changed amounts', () => {
    const text = 'Refund $212.50 (16.5%) — only if label 1Z999 is scanned.';
    expect(spokenFaithfully(text, text)).toBe(true);
    expect(spokenFaithfully(text, 'Refund $212.50, 16.5%, only if label 1Z999 is scanned')).toBe(true);
    expect(spokenFaithfully(text, 'Refund $212.60 (16.5%) — only if label 1Z999 is scanned.')).toBe(false);
    expect(spokenFaithfully(text, 'Refund $212.50 (16.5%) for label 1Z999.')).toBe(false);
    expect(spokenFaithfully(text, 'Sure! Here is a joke.')).toBe(false);
  });

  it('narrates through the Realtime model in the Marin voice and returns MP3', async () => {
    const { url, seen } = await realtime(script => script);
    const audio = await synthesizeSpeech('test-key', 'Pay $5 today.', 'Read clearly.', { url });
    expect(audio.length).toBeGreaterThan(100);
    expect(audio[0]).toBe(0xff);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`/v1/realtime?model=${SPEECH_MODEL}`);
    expect(seen[0]!.auth).toBe('Bearer test-key');
    const session = seen[0]!.events[0]!.session;
    expect(session.output_modalities).toEqual(['audio']);
    expect(session.audio.output).toEqual({ format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' });
    expect(session.audio.input.turn_detection).toBeNull();
    expect(session.instructions).toContain('Read clearly.');
  });

  it('retries one unfaithful reading, then succeeds', async () => {
    const { url, seen } = await realtime((script, call) => (call === 1 ? 'Here is a summary.' : script));
    await expect(synthesizeSpeech('k', 'Pay $5 today.', '', { url })).resolves.toBeInstanceOf(Buffer);
    expect(seen).toHaveLength(2);
  });

  it('fails closed when the reading stays unfaithful, errors, or stalls', async () => {
    const wrong = await realtime(() => 'Pay $6 today.');
    await expect(synthesizeSpeech('k', 'Pay $5 today.', '', { url: wrong.url })).rejects.toMatchObject({ status: 503 });
    expect(wrong.seen).toHaveLength(2);
    await new Promise<void>(resolve => server!.close(() => resolve()));
    const failing = await realtime(() => null);
    await expect(synthesizeSpeech('k', 'Pay $5 today.', '', { url: failing.url })).rejects.toMatchObject({ status: 503 });
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => server!.once('listening', resolve));
    const silent = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`;
    await expect(synthesizeSpeech('k', 'Pay $5 today.', '', { url: silent, timeoutMs: 100 })).rejects.toMatchObject({ status: 503 });
  });
});
