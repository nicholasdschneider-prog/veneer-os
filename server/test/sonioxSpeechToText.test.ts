import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachSonioxSpeechToText,
  SonioxTranscriptAssembler,
  sonioxConfigFrame,
  sonioxFinalizeSilence,
} from '../src/channels/sonioxSpeechToText.js';

interface UpstreamMessage {
  isBinary: boolean;
  data: Buffer;
}

interface Harness {
  client: WebSocket;
  upstreamMessages: UpstreamMessage[];
  upstreamSocket: () => WebSocket;
  clientFrames: Array<Record<string, unknown>>;
  waitForClientFrame: (messageType: string) => Promise<Record<string, unknown>>;
  waitForUpstreamMessage: (count: number) => Promise<UpstreamMessage[]>;
  waitForClientClose: () => Promise<void>;
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** A fake Soniox endpoint recording everything the adapter sends it. */
async function startFakeSoniox(): Promise<{
  url: string;
  messages: UpstreamMessage[];
  socket: () => WebSocket;
  waitForMessage: (count: number) => Promise<UpstreamMessage[]>;
}> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const messages: UpstreamMessage[] = [];
  const waiters: Array<{ count: number; resolve: (m: UpstreamMessage[]) => void }> = [];
  let current: WebSocket | null = null;
  wss.on('connection', (ws) => {
    current = ws;
    ws.on('message', (data, isBinary) => {
      messages.push({ isBinary, data: Buffer.from(data as Buffer) });
      for (const waiter of waiters.splice(0)) {
        if (messages.length >= waiter.count) waiter.resolve(messages);
        else waiters.push(waiter);
      }
    });
  });
  const url = await listen(server);
  return {
    url,
    messages,
    socket: () => {
      if (!current) throw new Error('no upstream connection yet');
      return current;
    },
    waitForMessage: (count) =>
      new Promise((resolve, reject) => {
        if (messages.length >= count) {
          resolve(messages);
          return;
        }
        waiters.push({ count, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${count} upstream messages`)), 5000);
      }),
  };
}

/** Boot a /ws/stt-style server wired to the adapter plus a connected client. */
async function startHarness(apiKey = 'soniox-test-key'): Promise<Harness> {
  const fake = await startFakeSoniox();
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => attachSonioxSpeechToText(ws, apiKey, { upstreamUrl: fake.url }));
  const url = await listen(server);

  const client = new WebSocket(url);
  sockets.push(client);
  const clientFrames: Array<Record<string, unknown>> = [];
  const frameWaiters: Array<{ messageType: string; resolve: (f: Record<string, unknown>) => void }> = [];
  let closed = false;
  const closeWaiters: Array<() => void> = [];
  client.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    clientFrames.push(frame);
    for (const waiter of frameWaiters.splice(0)) {
      if (frame.message_type === waiter.messageType) waiter.resolve(frame);
      else frameWaiters.push(waiter);
    }
  });
  client.on('close', () => {
    closed = true;
    for (const resolve of closeWaiters.splice(0)) resolve();
  });
  await new Promise<void>((resolve) => client.on('open', () => resolve()));

  return {
    client,
    upstreamMessages: fake.messages,
    upstreamSocket: fake.socket,
    clientFrames,
    waitForClientFrame: (messageType) =>
      new Promise((resolve, reject) => {
        const existing = clientFrames.find((f) => f.message_type === messageType);
        if (existing) {
          resolve(existing);
          return;
        }
        frameWaiters.push({ messageType, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for client frame ${messageType}`)), 5000);
      }),
    waitForUpstreamMessage: fake.waitForMessage,
    waitForClientClose: () =>
      new Promise((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        closeWaiters.push(resolve);
        setTimeout(() => reject(new Error('timed out waiting for client close')), 5000);
      }),
  };
}

function audioChunkFrame(pcm: Buffer): string {
  return JSON.stringify({
    message_type: 'input_audio_chunk',
    audio_base_64: pcm.toString('base64'),
    sample_rate: 16000,
  });
}

describe('soniox transcript assembly', () => {
  it('keeps final subwords together across responses', () => {
    const transcript = new SonioxTranscriptAssembler();
    expect(
      transcript.push([
        { text: 'sa', is_final: true },
        { text: 'id', is_final: false },
      ]),
    ).toEqual({ committed: [], partial: 'said', finalizationAcknowledged: false });
    expect(
      transcript.push([
        { text: 'id', is_final: true },
        { text: '<end>', is_final: true },
      ]),
    ).toEqual({ committed: ['said'], partial: '', finalizationAcknowledged: false });
  });

  it('flushes whole phrases at endpoint and finalization boundaries', () => {
    const transcript = new SonioxTranscriptAssembler();
    expect(
      transcript.push([
        { text: 'One', is_final: true },
        { text: ' two.', is_final: true },
        { text: '<end>', is_final: true },
        { text: ' three', is_final: false },
      ]),
    ).toEqual({ committed: ['One two.'], partial: 'three', finalizationAcknowledged: false });
    expect(
      transcript.push([
        { text: ' three', is_final: true },
        { text: '<fin>', is_final: true },
      ]),
    ).toEqual({ committed: ['three'], partial: '', finalizationAcknowledged: true });
  });

  it('holds exact final tokens until a safe boundary and ignores malformed tokens', () => {
    const transcript = new SonioxTranscriptAssembler();
    expect(
      transcript.push([
        { text: 'word', is_final: true },
        { text: 42, is_final: true },
        {},
      ]),
    ).toEqual({
      committed: [],
      partial: 'word',
      finalizationAcknowledged: false,
    });
    expect(transcript.push([{ text: 's', is_final: true }])).toEqual({
      committed: [],
      partial: 'words',
      finalizationAcknowledged: false,
    });
    expect(transcript.flush()).toBe('words');
  });
});

describe('soniox config frame', () => {
  it('carries the API key, realtime model, and raw PCM format', () => {
    expect(JSON.parse(sonioxConfigFrame('key-123'))).toEqual({
      api_key: 'key-123',
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['en'],
      language_hints_strict: true,
      context: {
        general: [
          { key: 'domain', value: 'Software development and AI agent orchestration' },
          { key: 'application', value: 'Veneer Pro' },
          { key: 'setting', value: 'Single-speaker English dictation' },
          {
            key: 'instructions',
            value: 'Transcribe in English and preserve the spelling, casing, and hyphenation of provided terms.',
          },
        ],
        terms: [
          'Veneer',
          'Veneer Pro',
          'sub-agent',
          'sub-agents',
          'Codex',
          'Claude',
          'OpenRouter',
          'Cloudflare',
          'Doppler',
          'MCP',
          'Soniox',
          'WebSocket',
          'monorepo',
        ],
      },
      enable_endpoint_detection: true,
      endpoint_latency_adjustment_level: 0,
      endpoint_sensitivity: -0.3,
      max_endpoint_delay_ms: 3000,
    });
  });

  it('uses the saved vocabulary hints', () => {
    expect(JSON.parse(sonioxConfigFrame('key-123', ['Veneer Pro', 'Acme'])).context.terms).toEqual([
      'Veneer Pro',
      'Acme',
    ]);
  });
});

describe('soniox finalization silence', () => {
  it('is exactly 200ms of 16kHz mono PCM16 silence', () => {
    const silence = sonioxFinalizeSilence();
    expect(silence).toHaveLength(6400);
    expect(silence.every((byte) => byte === 0)).toBe(true);
  });
});

describe('soniox speech to text adapter', () => {
  it('sends the config message first, then relays audio as binary', async () => {
    const h = await startHarness('key-abc');
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    h.client.send(audioChunkFrame(pcm));
    const messages = await h.waitForUpstreamMessage(2);
    expect(messages[0]!.isBinary).toBe(false);
    expect(JSON.parse(messages[0]!.data.toString())).toMatchObject({ api_key: 'key-abc', model: 'stt-rt-v5' });
    expect(messages[1]!.isBinary).toBe(true);
    expect(messages[1]!.data.equals(pcm)).toBe(true);
  });

  it('announces the session to the browser', async () => {
    const h = await startHarness();
    const started = await h.waitForClientFrame('session_started');
    expect(started).toMatchObject({ provider: 'soniox', realtime: true });
  });

  it('translates token responses into committed and partial transcript frames', async () => {
    const h = await startHarness();
    h.client.send(audioChunkFrame(Buffer.from([0, 0])));
    await h.waitForUpstreamMessage(2);
    h.upstreamSocket().send(
      JSON.stringify({
        tokens: [
          { text: 'One', is_final: true },
          { text: ' two.', is_final: true },
          { text: '<end>', is_final: true },
          { text: ' three', is_final: false },
        ],
      }),
    );
    const committed = await h.waitForClientFrame('committed_transcript');
    const partial = await h.waitForClientFrame('partial_transcript');
    expect(committed.text).toBe('One two.');
    expect(partial.text).toBe('three');
  });

  it('sends trailing silence, waits for <fin>, then ends the audio stream', async () => {
    const h = await startHarness();
    h.client.send(audioChunkFrame(Buffer.from([9, 0])));
    await h.waitForUpstreamMessage(2);
    h.client.send(JSON.stringify({ message_type: 'end_of_stream' }));
    const messages = await h.waitForUpstreamMessage(4);
    expect(messages[2]!.isBinary).toBe(true);
    expect(messages[2]!.data).toHaveLength(6400);
    expect(messages[2]!.data.every((byte) => byte === 0)).toBe(true);
    expect(JSON.parse(messages[3]!.data.toString())).toEqual({ type: 'finalize' });
    expect(h.upstreamMessages).toHaveLength(4);
    h.upstreamSocket().send(
      JSON.stringify({ tokens: [{ text: 'Done.', is_final: true }, { text: '<fin>', is_final: true }] }),
    );
    const afterFin = await h.waitForUpstreamMessage(5);
    expect(afterFin[4]!.data.toString()).toBe('');
    const committed = await h.waitForClientFrame('committed_transcript');
    expect(committed.text).toBe('Done.');
    h.upstreamSocket().send(JSON.stringify({ tokens: [], finished: true }));
    await h.waitForClientFrame('dictation_ended');
    await h.waitForClientClose();
  });

  it('flushes pending final subwords when a finished response has no control marker', async () => {
    const h = await startHarness();
    h.client.send(audioChunkFrame(Buffer.from([9, 0])));
    await h.waitForUpstreamMessage(2);
    h.upstreamSocket().send(JSON.stringify({ tokens: [{ text: 'word', is_final: true }] }));
    await h.waitForClientFrame('partial_transcript');
    h.client.send(JSON.stringify({ message_type: 'end_of_stream' }));
    await h.waitForUpstreamMessage(4);
    h.upstreamSocket().send(JSON.stringify({ tokens: [{ text: 's', is_final: true }], finished: true }));
    const committed = await h.waitForClientFrame('committed_transcript');
    expect(committed.text).toBe('words');
    await h.waitForClientFrame('dictation_ended');
    await h.waitForClientClose();
  });

  it('ends immediately when stopping before any audio was sent', async () => {
    const h = await startHarness();
    h.client.send(JSON.stringify({ message_type: 'end_of_stream' }));
    await h.waitForClientFrame('dictation_ended');
    await h.waitForClientClose();
  });

  it('maps auth failures to a Settings-facing error', async () => {
    const h = await startHarness();
    h.client.send(audioChunkFrame(Buffer.from([1, 0])));
    await h.waitForUpstreamMessage(2);
    h.upstreamSocket().send(JSON.stringify({ error_code: 401, error_message: 'invalid api key' }));
    const error = await h.waitForClientFrame('error');
    expect(error.error).toBe('Soniox rejected the API key. Update it in Settings → Voice.');
    await h.waitForClientClose();
  });

  it('surfaces other upstream errors with their message', async () => {
    const h = await startHarness();
    h.client.send(audioChunkFrame(Buffer.from([1, 0])));
    await h.waitForUpstreamMessage(2);
    h.upstreamSocket().send(JSON.stringify({ error_code: 400, error_message: 'bad audio' }));
    const error = await h.waitForClientFrame('error');
    expect(error.error).toBe('Soniox voice input error: bad audio');
    await h.waitForClientClose();
  });

  it('rejects invalid audio chunks', async () => {
    const h = await startHarness();
    h.client.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '!!!not-base64!!!' }));
    const error = await h.waitForClientFrame('error');
    expect(error.error).toBe('Voice input received an invalid audio chunk.');
    await h.waitForClientClose();
  });

  it('reports an unexpected upstream close as an error', async () => {
    const h = await startHarness();
    h.client.send(audioChunkFrame(Buffer.from([1, 0])));
    await h.waitForUpstreamMessage(2);
    h.upstreamSocket().close();
    const error = await h.waitForClientFrame('error');
    expect(error.error).toBe('Voice input connection failed. Please start dictation again.');
    await h.waitForClientClose();
  });
});
