import { dictationSpectrumLevels } from './dictationWaveformMeter';

// Dictation over /ws/stt. The server relays the configured realtime provider's
// partial/committed text back to the composer. One session at a time: mic
// capture -> 16kHz PCM16 chunks -> our authenticated server socket.

export interface DictationHandlers {
  onPartial?: (text: string) => void;
  onCommitted?: (text: string) => void;
  onError?: (message: string) => void;
  /** Fires after the mic is released while the provider finishes its transcript. */
  onFinalizing?: () => void;
  /** Fires once recording has fully stopped, however it stopped. */
  onEnd?: (reason: DictationEndReason) => void;
}

export type DictationEndReason = 'user' | 'cancel' | 'unexpected';
export type DictationLevelsListener = (levels: readonly number[]) => void;

interface ServerFrame {
  message_type?: string;
  text?: string;
  error?: string;
  message?: string;
}

const TARGET_SAMPLE_RATE = 16000;
// Keep the final un-emitted ScriptProcessor block small so stopping dictation
// cannot discard a large word-ending tail before the server adds drain silence.
const CHUNK_SAMPLES = 2048;
// Audio captured before the socket finishes connecting is buffered so nothing
// spoken during the connect window is lost. 600 chunks of 2048 samples at 16kHz
// is ~75s, far more than a connect ever takes; past that we drop the oldest.
const MAX_BUFFERED_CHUNKS = 600;

class MicDictation {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterFrame: number | null = null;
  private levelListeners = new Set<DictationLevelsListener>();
  private handlers: DictationHandlers = {};
  private finalizing = false;
  private finalizingTimer: number | null = null;
  // Set when the user stops before the socket opened: the backlog still has to
  // be flushed, so end_of_stream waits for the open instead of being dropped.
  private pendingEndOfStream = false;
  // Bumped on every start() and every stop(). start() re-checks it after each
  // await so a stop() (or a new start()) that lands mid-setup aborts cleanly
  // instead of leaving the mic hot with a ghost session the UI can't see.
  private generation = 0;

  get isActive(): boolean {
    return this.ws !== null;
  }

  get isFinalizing(): boolean {
    return this.finalizing;
  }

  /** Subscribe to the live microphone spectrum used by the dictation UI. */
  subscribeLevels(listener: DictationLevelsListener): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  liveVoiceActive = false;

  async start(handlers: DictationHandlers): Promise<void> {
    if (this.liveVoiceActive) { handlers.onError?.('End or pause live voice before dictating.'); handlers.onEnd?.('cancel'); return; }
    if (this.ws) return;
    const gen = ++this.generation;
    this.handlers = handlers;
    this.finalizing = false;
    this.pendingEndOfStream = false;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // Stopped while the permission prompt was up: release the mic and bail so
    // the recording indicator turns off and no stream is wired up.
    if (gen !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${window.location.host}/ws/stt`);
    this.ws = ws;

    // Frames captured before the socket opened, in capture order.
    const backlog: string[] = [];
    let live = false;

    ws.addEventListener(
      'open',
      () => {
        // Session already finished (cancel, error): the backlog dies with it.
        if (this.ws !== ws) return;
        live = true;
        for (const frame of backlog) ws.send(frame);
        backlog.length = 0;
        if (this.pendingEndOfStream) {
          this.pendingEndOfStream = false;
          ws.send(JSON.stringify({ message_type: 'end_of_stream' }));
        }
      },
      { once: true },
    );

    ws.addEventListener('message', (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.message_type === 'partial_transcript' && frame.text !== undefined) {
        this.handlers.onPartial?.(frame.text);
      } else if (frame.message_type === 'committed_transcript' && frame.text !== undefined) {
        this.handlers.onCommitted?.(frame.text);
      } else if (frame.message_type === 'dictation_ended') {
        this.finish('user');
      } else if (scribeErrorKind(frame.message_type)) {
        this.handlers.onError?.(frame.error ?? frame.message ?? 'Voice input error');
        this.finish('unexpected');
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.handlers.onError?.('Voice input stopped unexpectedly');
        this.finish('unexpected');
      }
    });
    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.handlers.onError?.('Voice input connection failed');
      this.finish('unexpected');
    });

    // Build the capture graph now, while the socket is still connecting, so
    // speech during the connect window lands in the backlog instead of nowhere.
    const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.audioCtx = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.72;
    this.analyser = analyser;
    const processor = audioCtx.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
    this.processor = processor;
    // ScriptProcessorNode only fires once wired into the graph; route through
    // a silent gain instead of straight to destination to avoid mic feedback.
    const silence = audioCtx.createGain();
    silence.gain.value = 0;

    processor.onaudioprocess = (e) => {
      // Torn down mid-callback, or the socket is gone: nothing to capture into.
      if (this.processor !== processor) return;
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
      const input = e.inputBuffer.getChannelData(0);
      const resampled = resampleTo16k(input, audioCtx.sampleRate);
      const audioBase64 = base64FromPcm16(floatTo16BitPCM(resampled));
      const frame = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: audioBase64, sample_rate: TARGET_SAMPLE_RATE });
      if (live && ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
        return;
      }
      backlog.push(frame);
      if (backlog.length > MAX_BUFFERED_CHUNKS) backlog.splice(0, backlog.length - MAX_BUFFERED_CHUNKS);
    };

    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(silence);
    silence.connect(audioCtx.destination);

    // Keep metering independent from React's chat tree. The compact waveform
    // subscribes directly and only its small component repaints each frame.
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const meter = () => {
      if (this.analyser !== analyser) return;
      analyser.getByteFrequencyData(frequencyData);
      const levels = dictationSpectrumLevels(frequencyData);
      for (const listener of this.levelListeners) listener(levels);
      this.meterFrame = window.requestAnimationFrame(meter);
    };
    this.meterFrame = window.requestAnimationFrame(meter);

    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('Voice input connection failed')), { once: true });
      });
    } catch (err) {
      // The error listener above already ran finish(); make sure the graph and
      // mic this start() created are gone even if the session moved on.
      backlog.length = 0;
      if (this.audioCtx === audioCtx) this.releaseMicrophone();
      else for (const track of stream.getTracks()) track.stop();
      throw err;
    }

    if (gen !== this.generation) {
      // Stopped while the socket was connecting. A user stop wants its backlog
      // flushed and end_of_stream sent, which the open listener just did, so
      // leave the socket alone and let the server's dictation_ended finish us.
      if (this.finalizing && this.ws === ws) return;
      // Cancelled or superseded: tear down everything we opened.
      backlog.length = 0;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      if (this.audioCtx === audioCtx) this.releaseMicrophone();
      else for (const track of stream.getTracks()) track.stop();
      if (this.ws === ws) this.ws = null;
    }
  }

  stop(reason: DictationEndReason = 'user'): void {
    // Invalidate any start() still working through its awaits so it aborts.
    this.generation++;
    this.releaseMicrophone();
    const ws = this.ws;
    const connecting = ws?.readyState === WebSocket.CONNECTING;
    if (reason === 'user' && (ws?.readyState === WebSocket.OPEN || connecting) && ws && !this.finalizing) {
      this.finalizing = true;
      this.handlers.onFinalizing?.();
      // Still connecting: the open listener flushes the backlog and then sends
      // end_of_stream, so the words spoken before the socket opened survive.
      if (connecting) this.pendingEndOfStream = true;
      else ws.send(JSON.stringify({ message_type: 'end_of_stream' }));
      this.finalizingTimer = window.setTimeout(() => {
        if (!this.finalizing) return;
        this.handlers.onError?.('Voice input took too long to finish');
        this.finish('unexpected');
      }, 65_000);
      return;
    }
    this.finish(reason);
  }

  private releaseMicrophone(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.meterFrame !== null) {
      window.cancelAnimationFrame(this.meterFrame);
      this.meterFrame = null;
    }
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }

  private finish(reason: DictationEndReason): void {
    const handlers = this.handlers;
    this.generation++;
    this.releaseMicrophone();
    if (this.finalizingTimer !== null) {
      window.clearTimeout(this.finalizingTimer);
      this.finalizingTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.finalizing = false;
    this.pendingEndOfStream = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    handlers.onEnd?.(reason);
    this.handlers = {};
  }
}

function scribeErrorKind(messageType: string | undefined): string | null {
  if (!messageType) return null;
  let kind = messageType.trim().toLowerCase();
  if (kind.startsWith('scribe_')) kind = kind.slice('scribe_'.length);
  if (kind.endsWith('_error')) kind = kind.slice(0, -'_error'.length);
  return SCRIBE_ERROR_KINDS.has(kind) ? kind : null;
}

const SCRIBE_ERROR_KINDS = new Set([
  'auth',
  'quota_exceeded',
  'transcriber',
  'input',
  'error',
  'commit_throttled',
  'unaccepted_terms',
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'chunk_size_exceeded',
  'insufficient_audio_activity',
]);

function resampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_SAMPLE_RATE) return input;
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function base64FromPcm16(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export const micDictation = new MicDictation();
