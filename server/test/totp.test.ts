import { describe, expect, it } from 'vitest';
import { generateTotp, parseTotpSeed, type TotpAlgorithm } from '../src/veneerBrowser/totp.js';

/** RFC 4648 base32, the encoding every authenticator app hands out. */
function base32(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of Buffer.from(input, 'ascii')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const SEEDS: Record<TotpAlgorithm, string> = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
};

function seedFor(algorithm: TotpAlgorithm) {
  return { secret: Buffer.from(SEEDS[algorithm], 'ascii'), digits: 8, period: 30, algorithm };
}

describe('RFC 6238 TOTP', () => {
  // Appendix B, verbatim: 8 digits, 30-second period, the three HMAC families.
  it.each([
    [59, 'SHA1', '94287082'],
    [59, 'SHA256', '46119246'],
    [59, 'SHA512', '90693936'],
    [1111111109, 'SHA1', '07081804'],
    [1111111109, 'SHA256', '68084774'],
    [1111111109, 'SHA512', '25091201'],
    [1234567890, 'SHA1', '89005924'],
    [1234567890, 'SHA256', '91819424'],
    [1234567890, 'SHA512', '93441116'],
    [20000000000, 'SHA1', '65353130'],
    [20000000000, 'SHA256', '77737706'],
    [20000000000, 'SHA512', '47863826'],
  ] as Array<[number, TotpAlgorithm, string]>)('matches T=%i %s', (seconds, algorithm, expected) => {
    expect(generateTotp(seedFor(algorithm), seconds * 1000).code).toBe(expected);
  });

  it('defaults a bare base32 key to 6 digits, 30 seconds, SHA1', () => {
    const parsed = parseTotpSeed(base32(SEEDS.SHA1));
    expect(parsed).toMatchObject({ digits: 6, period: 30, algorithm: 'SHA1' });
    expect(parsed.secret.toString('ascii')).toBe(SEEDS.SHA1);
    // Same counter as the SHA1 vector above, truncated to six digits.
    expect(generateTotp(parsed, 59_000).code).toBe('287082');
  });

  it('accepts the formatting authenticator apps display', () => {
    const spaced = base32(SEEDS.SHA1).toLowerCase().replace(/(.{4})/g, '$1 ').trim();
    expect(parseTotpSeed(spaced).secret.toString('ascii')).toBe(SEEDS.SHA1);
    expect(parseTotpSeed(`${base32(SEEDS.SHA1)}======`).secret.toString('ascii')).toBe(SEEDS.SHA1);
    expect(parseTotpSeed(base32(SEEDS.SHA1).replace(/(.{4})/g, '$1-').replace(/-$/, '')).secret.toString('ascii'))
      .toBe(SEEDS.SHA1);
  });

  it('reads an otpauth URI including a percent-encoded label', () => {
    const uri = `otpauth://totp/Acme%20Co%3Aada%40example.com?secret=${base32(SEEDS.SHA256)}`
      + '&issuer=Acme%20Co&algorithm=SHA256&digits=8&period=60';
    const parsed = parseTotpSeed(uri);
    expect(parsed).toMatchObject({ digits: 8, period: 60, algorithm: 'SHA256' });
    expect(parsed.secret.toString('ascii')).toBe(SEEDS.SHA256);
  });

  it('reports how long the current code lasts', () => {
    expect(generateTotp(seedFor('SHA1'), 59_000).secondsRemaining).toBe(1);
    expect(generateTotp(seedFor('SHA1'), 30_000).secondsRemaining).toBe(30);
    expect(generateTotp(seedFor('SHA1'), 45_000).secondsRemaining).toBe(15);
  });

  it('refuses an unusable seed without repeating it', () => {
    for (const bad of ['', 'not a seed!', 'otpauth://hotp/Acme?secret=JBSWY3DPEHPK3PXP', 'https://example.com']) {
      let message = '';
      try {
        parseTotpSeed(bad);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      // '' has nothing to repeat; every other case must not come back.
      if (bad.trim()) expect(message).not.toContain(bad.trim());
    }
    expect(() => parseTotpSeed(`otpauth://totp/Acme?secret=${base32('x')}&algorithm=MD5`))
      .toThrow(/unsupported algorithm/);
  });
});
