#!/usr/bin/env node
// Live end-to-end check of the /ws/stt dictation pipeline: stream a spoken
// audio file to a running Veneer Pro instance exactly like the browser mic
// does and print the Soniox transcript frames that come back.
//
// Usage:
//   node scripts/verify-dictation.mjs --url ws://127.0.0.1:3100 --file clip.wav
//   node scripts/verify-dictation.mjs --url ws://127.0.0.1:3100 --say "hello world, this is a dictation test"
//   Flags: --fast (no realtime pacing), --timeout <seconds, default 90>
//
// The target must be a dev-identity instance (the script sends no auth). The
// audio file must be 16 kHz mono PCM16 WAV; --say synthesizes one via macOS
// say + afconvert. Exits 0 with the final transcript, non-zero on any error
// frame, close-without-transcript, or timeout.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? null);
}
const url = flag('url') ?? 'ws://127.0.0.1:3100';
const fast = args.includes('--fast');
const timeoutSec = Number(flag('timeout') ?? 90);
const sayText = flag('say');
let file = flag('file');

if (!file && !sayText) {
  console.error('Need --file <16kHz mono PCM16 wav> or --say "text to synthesize" (macOS).');
  process.exit(2);
}

if (!file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-dictation-'));
  const aiff = path.join(tmp, 'clip.aiff');
  file = path.join(tmp, 'clip.wav');
  execFileSync('say', ['-o', aiff, sayText]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, file]);
  console.error(`synthesized: ${file}`);
}

const pcm = readWavPcm16Mono16k(file);
console.error(`audio: ${(pcm.length / 2 / 16000).toFixed(1)}s of 16kHz PCM16 (${pcm.length} bytes)`);

const CHUNK_SAMPLES = 4096; // matches the browser's ScriptProcessorNode buffer
const CHUNK_BYTES = CHUNK_SAMPLES * 2;
const CHUNK_MS = (CHUNK_SAMPLES / 16000) * 1000;

const wsUrl = `${url.replace(/\/$/, '')}/ws/stt`;
console.error(`connecting: ${wsUrl}`);
const ws = new WebSocket(wsUrl);

let base = '';
let tail = '';
let ended = false;

const deadline = setTimeout(() => {
  console.error(`TIMEOUT after ${timeoutSec}s`);
  finish(1);
}, timeoutSec * 1000);

ws.addEventListener('open', async () => {
  console.error('connected, streaming audio...');
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(chunk).toString('base64'),
        sample_rate: 16000,
      }),
    );
    if (!fast) await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
  }
  // Trailing silence gives endpoint detection a chance to commit naturally.
  const silence = Buffer.alloc(CHUNK_BYTES).toString('base64');
  for (let i = 0; i < 3 && ws.readyState === WebSocket.OPEN; i++) {
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: silence, sample_rate: 16000 }));
    if (!fast) await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  console.error('end_of_stream sent, waiting for the final transcript...');
  ws.send(JSON.stringify({ message_type: 'end_of_stream' }));
});

ws.addEventListener('message', (ev) => {
  let frame;
  try {
    frame = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  const type = frame.message_type;
  if (type === 'session_started') {
    console.error(`session_started: provider=${frame.provider ?? 'unknown'}`);
  } else if (type === 'partial_transcript') {
    if (frame.text) console.error(`partial:   ${frame.text}`);
    tail = frame.text ?? '';
  } else if (type === 'committed_transcript') {
    console.error(`committed: ${frame.text}`);
    base = joinDictation(base, frame.text ?? '');
    tail = '';
  } else if (type === 'dictation_ended') {
    ended = true;
    const transcript = joinDictation(base, tail);
    console.log(transcript);
    console.error(transcript ? 'PASS: dictation_ended with transcript above' : 'FAIL: dictation_ended but transcript is empty');
    finish(transcript ? 0 : 1);
  } else {
    console.error(`FAIL: ${type}: ${frame.error ?? frame.message ?? JSON.stringify(frame)}`);
    finish(1);
  }
});

ws.addEventListener('close', (ev) => {
  if (ended) return;
  console.error(`FAIL: socket closed before dictation_ended (code ${ev.code}). A 403-style close means the target is not a dev-identity instance.`);
  finish(1);
});
ws.addEventListener('error', () => {
  if (ended) return;
  console.error('FAIL: websocket error (is the instance running?)');
  finish(1);
});

function finish(code) {
  clearTimeout(deadline);
  try {
    ws.close();
  } catch {
    /* already closed */
  }
  // Give the close frame a beat to flush.
  setTimeout(() => process.exit(code), 100);
}

function joinDictation(baseText, addition) {
  if (!addition) return baseText;
  if (!baseText) return addition;
  return baseText.endsWith(' ') || baseText.endsWith('\n') ? baseText + addition : `${baseText} ${addition}`;
}

function readWavPcm16Mono16k(wavPath) {
  const buf = fs.readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${wavPath} is not a WAV file (use: afconvert -f WAVE -d LEI16@16000 -c 1 in.aiff out.wav)`);
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) {
        throw new Error(
          `WAV must be 16kHz mono PCM16; got format=${fmt.format} channels=${fmt.channels} rate=${fmt.sampleRate} bits=${fmt.bitsPerSample}`,
        );
      }
      return buf.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}
