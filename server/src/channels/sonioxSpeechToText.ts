import { WebSocket } from 'ws';
import { DEFAULT_VOICE_VOCABULARY_TERMS } from './voiceSettings.js';

/**
 * Soniox realtime dictation. The browser keeps speaking the neutral /ws/stt
 * protocol (base64 PCM16 frames up, partial/committed transcripts down); this
 * adapter translates it to Soniox's WebSocket API: a config message carrying
 * the API key, then raw binary audio, with transcripts returned as final /
 * non-final tokens.
 */

const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_MODEL = 'stt-rt-v5';
const SONIOX_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SAMPLE = 2;
const FINALIZE_SILENCE_MS = 200;
const FINALIZE_SILENCE_BYTES = (SONIOX_SAMPLE_RATE * FINALIZE_SILENCE_MS * PCM_BYTES_PER_SAMPLE) / 1000;
const MAX_PENDING_CHUNKS = 600;
const FINALIZE_TIMEOUT_MS = 5000;

interface ClientFrame {
  message_type?: string;
  audio_base_64?: string;
}

interface SonioxToken {
  text?: unknown;
  is_final?: unknown;
}

interface SonioxResponse {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: unknown;
  error_message?: unknown;
}

export function sonioxConfigFrame(
  apiKey: string,
  vocabularyTerms: readonly string[] = DEFAULT_VOICE_VOCABULARY_TERMS,
): string {
  return JSON.stringify({
    api_key: apiKey,
    model: SONIOX_MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: SONIOX_SAMPLE_RATE,
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
      terms: vocabularyTerms,
    },
    // Dictation can trade a little endpoint latency for more revision time.
    enable_endpoint_detection: true,
    endpoint_latency_adjustment_level: 0,
    endpoint_sensitivity: -0.3,
    max_endpoint_delay_ms: 3000,
  });
}

/**
 * Soniox tokens can be words, spaces, or subwords, and a word's final tokens
 * may arrive in separate responses. Keep the exact token stream together until
 * Soniox marks a safe phrase boundary; the browser protocol may then add its
 * one separator between whole committed phrases without splitting words.
 */
interface SonioxTranscriptUpdate {
  committed: readonly string[];
  partial: string;
  finalizationAcknowledged: boolean;
}

export class SonioxTranscriptAssembler {
  private pendingFinal = '';

  push(tokens: readonly SonioxToken[]): SonioxTranscriptUpdate {
    const committed: string[] = [];
    let nonFinal = '';
    let finalizationAcknowledged = false;

    for (const token of tokens) {
      if (typeof token.text !== 'string') continue;
      if (token.text === '<end>' || token.text === '<fin>') {
        const phrase = this.takePending();
        if (phrase) committed.push(phrase);
        if (token.text === '<fin>') finalizationAcknowledged = true;
      } else if (token.is_final === true) {
        this.pendingFinal += token.text;
      } else {
        nonFinal += token.text;
      }
    }

    return {
      committed,
      partial: `${this.pendingFinal}${nonFinal}`.trimStart(),
      finalizationAcknowledged,
    };
  }

  flush(): string {
    return this.takePending();
  }

  private takePending(): string {
    const phrase = this.pendingFinal.trimStart();
    this.pendingFinal = '';
    return phrase;
  }
}

function sendTranscriptUpdate(
  client: WebSocket,
  update: {
    committed: readonly string[];
    partial: string;
  },
): void {
  for (const text of update.committed) {
    if (text) sendJson(client, { message_type: 'committed_transcript', text });
  }
  sendJson(client, { message_type: 'partial_transcript', text: update.partial });
}

function flushTranscript(client: WebSocket, assembler: SonioxTranscriptAssembler): void {
  const committed = assembler.flush();
  if (committed) sendJson(client, { message_type: 'committed_transcript', text: committed });
  sendJson(client, { message_type: 'partial_transcript', text: '' });
}

export function sonioxFinalizeSilence(): Buffer {
  return Buffer.alloc(FINALIZE_SILENCE_BYTES);
}

export function attachSonioxSpeechToText(
  client: WebSocket,
  apiKey: string,
  options: { vocabularyTerms?: readonly string[]; upstreamUrl?: string } = {},
): void {
  const vocabularyTerms = options.vocabularyTerms ?? DEFAULT_VOICE_VOCABULARY_TERMS;
  const upstreamUrl = options.upstreamUrl ?? SONIOX_WS_URL;
  let upstream: WebSocket | null = null;
  let configSent = false;
  let closed = false;
  let finalizing = false;
  let hasAudio = false;
  let finalizeRequested = false;
  let endOfAudioSent = false;
  let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  const transcript = new SonioxTranscriptAssembler();

  // Audio that arrives before the upstream socket has opened and taken the
  // config message.
  const pending: Buffer[] = [];

  sendJson(client, { message_type: 'session_started', provider: 'soniox', realtime: true });

  client.on('message', (data) => {
    if (closed) return;
    const frame = parseClientFrame(String(data));
    if (!frame) {
      closeWithError('Voice input received an invalid audio frame.');
      return;
    }
    if (frame.message_type === 'end_of_stream') {
      finalize();
      return;
    }
    if (frame.message_type !== 'input_audio_chunk' || finalizing) return;
    const chunk = decodePcmChunk(frame.audio_base_64);
    if (!chunk) {
      closeWithError('Voice input received an invalid audio chunk.');
      return;
    }
    if (chunk.length === 0) return;
    hasAudio = true;
    if (configSent && upstream?.readyState === WebSocket.OPEN) {
      upstream.send(chunk);
      return;
    }
    if (pending.length >= MAX_PENDING_CHUNKS) {
      closeWithError('Voice input fell too far behind while connecting. Please start dictation again.');
      return;
    }
    pending.push(chunk);
  });

  client.on('close', cleanup);
  client.on('error', cleanup);

  const ws = new WebSocket(upstreamUrl);
  upstream = ws;

  ws.on('open', () => {
    if (closed) return;
    ws.send(sonioxConfigFrame(apiKey, vocabularyTerms));
    configSent = true;
    for (const chunk of pending.splice(0)) ws.send(chunk);
    if (finalizing) requestFinalization();
  });

  ws.on('message', (data) => {
    if (closed) return;
    const response = parseSonioxResponse(String(data));
    if (!response) return;
    if (response.error_code !== undefined && response.error_code !== null) {
      closeWithError(sonioxErrorMessage(response.error_code, response.error_message));
      return;
    }
    if (Array.isArray(response.tokens) && response.tokens.length > 0) {
      const update: SonioxTranscriptUpdate = transcript.push(response.tokens);
      sendTranscriptUpdate(client, update);
      if (finalizing && update.finalizationAcknowledged) sendEndOfAudio();
    }
    if (response.finished === true) {
      if (finalizing) {
        flushTranscript(client, transcript);
        finishFinalizing();
      } else {
        closeWithError('Voice input ended unexpectedly. Please start dictation again.');
      }
    }
  });

  ws.on('error', () => {
    if (closed) return;
    if (finalizing) finishFinalizing();
    else closeWithError('Voice input connection failed. Please start dictation again.');
  });
  ws.on('close', () => {
    if (closed) return;
    if (finalizing) finishFinalizing();
    else closeWithError('Voice input connection failed. Please start dictation again.');
  });

  function finalize(): void {
    if (finalizing) return;
    finalizing = true;
    if (!hasAudio) {
      finishFinalizing();
      return;
    }
    if (configSent && upstream?.readyState === WebSocket.OPEN) requestFinalization();
    // A provider/network failure must not leave the composer waiting forever.
    // The browser already has the latest partial transcript as a fallback.
    finalizeTimer = setTimeout(() => {
      sendEndOfAudio();
      finishFinalizing();
    }, FINALIZE_TIMEOUT_MS);
  }

  function requestFinalization(): void {
    if (!upstream || upstream.readyState !== WebSocket.OPEN || finalizeRequested) return;
    // Give Soniox 200ms of trailing PCM silence before forcing pending tokens
    // final. Wait for <fin> before ending the stream so the final revision is
    // drained instead of racing a back-to-back empty end-of-audio frame.
    upstream.send(sonioxFinalizeSilence());
    upstream.send(JSON.stringify({ type: 'finalize' }));
    finalizeRequested = true;
  }

  function sendEndOfAudio(): void {
    if (!upstream || upstream.readyState !== WebSocket.OPEN || endOfAudioSent) return;
    upstream.send('');
    endOfAudioSent = true;
  }

  function finishFinalizing(): void {
    if (closed) return;
    sendJson(client, { message_type: 'dictation_ended' });
    cleanup();
    client.close();
  }

  function cleanup(): void {
    closed = true;
    pending.length = 0;
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    if (upstream) {
      try {
        upstream.close();
      } catch {
        /* already closed */
      }
      upstream = null;
    }
  }

  function closeWithError(error: string): void {
    if (closed) return;
    sendJson(client, { message_type: 'error', error });
    cleanup();
    client.close();
  }
}

export function sonioxErrorMessage(code: unknown, message: unknown): string {
  if (code === 401 || code === 403) return 'Soniox rejected the API key. Update it in Settings → Voice.';
  if (code === 402) return 'Soniox credits are exhausted.';
  if (code === 429) return 'Soniox is rate-limiting dictation. Try again shortly.';
  if (typeof message === 'string' && message.trim()) return `Soniox voice input error: ${message.trim()}`;
  return 'Soniox voice input failed. Please try again.';
}

function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const frame = JSON.parse(raw) as unknown;
    return frame && typeof frame === 'object' ? (frame as ClientFrame) : null;
  } catch {
    return null;
  }
}

function parseSonioxResponse(raw: string): SonioxResponse | null {
  try {
    const response = JSON.parse(raw) as unknown;
    return response && typeof response === 'object' ? (response as SonioxResponse) : null;
  } catch {
    return null;
  }
}

function decodePcmChunk(value: string | undefined): Buffer | null {
  if (value === undefined || value.length > 1_000_000) return null;
  if (value === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const chunk = Buffer.from(value, 'base64');
  return chunk.length > 0 && chunk.length % 2 === 0 ? chunk : null;
}

function sendJson(ws: WebSocket, frame: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket died mid-send */
  }
}
