import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { micDictation } from './stt';

// The dictation session talks to three browser APIs: getUserMedia, a WebSocket
// and an AudioContext. These fakes let a test drive the connect window by hand
// so audio can be captured before the socket is allowed to open.

type Listener = { fn: (ev: unknown) => void; once: boolean };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void, opts?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: opts?.once === true });
    this.listeners.set(type, list);
  }

  removeEventListener(): void {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  emit(type: string, ev: unknown): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => !l.once),
    );
    for (const l of list) l.fn(ev);
  }

  /** Let the connection complete. */
  openSocket(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  serverFrame(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate: number;
  closed = false;
  destination = {};
  processor: { onaudioprocess: ((e: unknown) => void) | null } | null = null;

  constructor(opts: { sampleRate: number }) {
    this.sampleRate = opts.sampleRate;
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 64,
      getByteFrequencyData: (out: Uint8Array) => out.fill(200),
      connect: () => {},
      disconnect: () => {},
    };
  }

  createScriptProcessor() {
    const processor = { onaudioprocess: null, connect: () => {}, disconnect: () => {} } as {
      onaudioprocess: ((e: unknown) => void) | null;
      connect: () => void;
      disconnect: () => void;
    };
    this.processor = processor;
    return processor;
  }

  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

let tracks: Array<{ stopped: boolean; stop: () => void }> = [];
let rafQueue: Array<() => void> = [];

function makeStream() {
  tracks = [
    { stopped: false, stop() { this.stopped = true; } },
    { stopped: false, stop() { this.stopped = true; } },
  ];
  return { getTracks: () => tracks };
}

/** Chunk k is a Float32Array of length k, so decoded byte length identifies it. */
function emitChunk(id: number): void {
  const ctx = FakeAudioContext.instances.at(-1)!;
  const samples = new Float32Array(id).fill(0.5);
  ctx.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
}

function chunkIds(frames: string[]): number[] {
  return frames
    .map((raw) => JSON.parse(raw) as { message_type: string; audio_base_64?: string })
    .filter((f) => f.message_type === 'input_audio_chunk')
    .map((f) => atob(f.audio_base_64!).length / 2);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function socket(): FakeWebSocket {
  return FakeWebSocket.instances.at(-1)!;
}

/**
 * Runs start() up to the point where it is waiting on the socket to open, and
 * hands back its still-pending promise. Wrapped in an object so awaiting this
 * helper does not adopt (and so block on) the start promise itself.
 */
async function startConnecting(handlers = {}): Promise<{ started: Promise<void> }> {
  const started = micDictation.start(handlers);
  await flush();
  return { started };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeAudioContext.instances = [];
  rafQueue = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => makeStream() } });
  vi.stubGlobal('window', {
    location: { protocol: 'https:', host: 'pro.example.com' },
    requestAnimationFrame: (cb: () => void) => rafQueue.push(cb),
    cancelAnimationFrame: () => {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  });
});

afterEach(() => {
  if (micDictation.isActive) micDictation.stop('cancel');
  vi.unstubAllGlobals();
});

describe('mic dictation connect window', () => {
  it('captures before the socket opens and flushes the backlog in order', async () => {
    const { started } = await startConnecting();
    expect(socket().url).toBe('wss://pro.example.com/ws/stt');

    emitChunk(1);
    emitChunk(2);
    emitChunk(3);
    // Nothing can go out yet, but nothing is lost either.
    expect(socket().sent).toEqual([]);

    socket().openSocket();
    await started;
    expect(chunkIds(socket().sent)).toEqual([1, 2, 3]);

    emitChunk(4);
    expect(chunkIds(socket().sent)).toEqual([1, 2, 3, 4]);
  });

  it('keeps the wire format the server proxy expects', async () => {
    const { started } = await startConnecting();
    emitChunk(2);
    socket().openSocket();
    await started;

    expect(JSON.parse(socket().sent[0]!)).toEqual({
      message_type: 'input_audio_chunk',
      audio_base_64: expect.any(String),
      sample_rate: 16000,
    });
  });

  it('drops the oldest buffered chunks past the cap', async () => {
    const { started } = await startConnecting();
    for (let id = 1; id <= 605; id++) emitChunk(id);

    socket().openSocket();
    await started;

    const ids = chunkIds(socket().sent);
    expect(ids).toHaveLength(600);
    expect(ids[0]).toBe(6);
    expect(ids.at(-1)).toBe(605);
  });

  it('meters levels from the moment capture begins', async () => {
    const levels = vi.fn();
    const unsubscribe = micDictation.subscribeLevels(levels);
    const { started } = await startConnecting();

    // Still connecting, but the analyser graph is already live.
    expect(rafQueue).toHaveLength(1);
    rafQueue.pop()!();
    expect(levels).toHaveBeenCalled();

    socket().openSocket();
    await started;
    unsubscribe();
  });

  it('releases the mic and drops the backlog when cancelled before open', async () => {
    const onEnd = vi.fn();
    const { started } = await startConnecting({ onEnd });
    emitChunk(1);

    micDictation.stop('cancel');
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeAudioContext.instances[0]!.closed).toBe(true);
    expect(onEnd).toHaveBeenCalledWith('cancel');
    expect(micDictation.isActive).toBe(false);

    // A late open must not resurrect the session or replay the backlog.
    socket().emit('open', {});
    await started;
    expect(socket().sent).toEqual([]);
  });

  it('flushes then ends the stream when stopped before open', async () => {
    const onFinalizing = vi.fn();
    const onEnd = vi.fn();
    const { started } = await startConnecting({ onFinalizing, onEnd });
    emitChunk(1);
    emitChunk(2);

    micDictation.stop('user');
    expect(onFinalizing).toHaveBeenCalled();
    expect(micDictation.isFinalizing).toBe(true);
    // The mic is released immediately even though the socket is still opening.
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(socket().sent).toEqual([]);

    socket().openSocket();
    await started;

    expect(chunkIds(socket().sent)).toEqual([1, 2]);
    expect(JSON.parse(socket().sent.at(-1)!)).toEqual({ message_type: 'end_of_stream' });
    expect(micDictation.isActive).toBe(true);

    socket().serverFrame({ message_type: 'dictation_ended' });
    expect(onEnd).toHaveBeenCalledWith('user');
    expect(micDictation.isActive).toBe(false);
  });

  it('stops capturing once the session has been torn down', async () => {
    const { started } = await startConnecting();
    socket().openSocket();
    await started;

    micDictation.stop('cancel');
    const before = socket().sent.length;
    emitChunk(3);
    expect(socket().sent).toHaveLength(before);
  });
});
