import crypto from 'node:crypto';

/**
 * RFC 6238 TOTP on node:crypto only.
 *
 * Deliberately dependency-free: the live Pro box must never need `npm install`
 * to take a fleet release, and a one-function HMAC loop is not worth a package.
 *
 * Nothing here logs, and no error message ever repeats the seed it failed to
 * parse — a bad seed is still a secret.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface ParsedTotpSeed {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SEED_ERROR =
  'That Doppler secret is not a TOTP seed. Store the authenticator key (base32) or the full otpauth:// URI.';

/** Tolerates the formatting authenticator apps use: spaces, dashes, lowercase, no padding. */
function decodeBase32(raw: string): Buffer {
  const cleaned = raw.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  if (!cleaned || /[^A-Z2-7]/.test(cleaned)) throw new Error(SEED_ERROR);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (!bytes.length) throw new Error(SEED_ERROR);
  return Buffer.from(bytes);
}

function parseAlgorithm(raw: string | null): TotpAlgorithm {
  const name = (raw ?? 'SHA1').trim().toUpperCase().replace(/-/g, '');
  if (name === 'SHA1' || name === 'SHA256' || name === 'SHA512') return name;
  throw new Error('That TOTP seed names an unsupported algorithm. Only SHA1, SHA256, and SHA512 are supported.');
}

function parseInteger(raw: string | null, fallback: number, min: number, max: number, label: string): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`That TOTP seed has an unusable ${label}.`);
  }
  return value;
}

/**
 * A bare base32 key, or an `otpauth://totp/...` URI with its standard query
 * parameters (secret, digits, period, algorithm). Percent-encoded labels are
 * fine; only the query is read.
 */
export function parseTotpSeed(raw: string): ParsedTotpSeed {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error(SEED_ERROR);
  if (/^otpauth:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(SEED_ERROR);
    }
    if (url.host.toLowerCase() !== 'totp') {
      throw new Error('That otpauth URI is not a TOTP secret (only otpauth://totp/… is supported).');
    }
    const secret = url.searchParams.get('secret');
    if (!secret) throw new Error(SEED_ERROR);
    return {
      secret: decodeBase32(secret),
      digits: parseInteger(url.searchParams.get('digits'), 6, 4, 10, 'digit count'),
      period: parseInteger(url.searchParams.get('period'), 30, 1, 3600, 'period'),
      algorithm: parseAlgorithm(url.searchParams.get('algorithm')),
    };
  }
  return { secret: decodeBase32(trimmed), digits: 6, period: 30, algorithm: 'SHA1' };
}

/** The current code and how long it stays valid, both derived from `nowMs`. */
export function generateTotp(parsed: ParsedTotpSeed, nowMs: number = Date.now()): { code: string; secondsRemaining: number } {
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / parsed.period);
  const message = Buffer.alloc(8);
  // Counters pass 2^32 only in the far future, but write the full 64 bits
  // anyway: BigInt keeps the high word correct without a float round trip.
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(parsed.algorithm.toLowerCase(), parsed.secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  const code = String(binary % 10 ** parsed.digits).padStart(parsed.digits, '0');
  return { code, secondsRemaining: parsed.period - (seconds % parsed.period) };
}
