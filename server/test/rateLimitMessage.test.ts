import { describe, expect, it } from 'vitest';
import {
  displayClaudeRateLimitMessage,
  isClaudeSessionLimitMessage,
  parseClaudeLimitReset,
} from '../src/providers/claude/rateLimitMessage.js';

const MESSAGE = "You've hit your session limit · resets 2:30am (UTC)";
const RATE_LIMIT = { isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit' };

describe('Claude rate-limit message display', () => {
  it('converts a summer reset to EDT', () => {
    expect(displayClaudeRateLimitMessage(MESSAGE, RATE_LIMIT, new Date('2026-08-06T00:27:00Z'))).toBe(
      "You've hit your session limit · resets 10:30 PM EDT",
    );
  });

  it('converts a winter reset to EST', () => {
    expect(displayClaudeRateLimitMessage(MESSAGE, RATE_LIMIT, new Date('2026-01-15T00:27:00Z'))).toBe(
      "You've hit your session limit · resets 9:30 PM EST",
    );
  });

  it('uses the next UTC occurrence across a day and DST boundary', () => {
    expect(displayClaudeRateLimitMessage(MESSAGE, RATE_LIMIT, new Date('2026-11-01T03:00:00Z'))).toBe(
      "You've hit your session limit · resets 9:30 PM EST",
    );
  });

  it('does not change ordinary assistant text or other UTC text', () => {
    expect(displayClaudeRateLimitMessage(MESSAGE, { model: 'claude-sonnet-5' }, new Date('2026-08-06T00:27:00Z'))).toBe(
      MESSAGE,
    );
    expect(
      displayClaudeRateLimitMessage(
        `Claude reported: ${MESSAGE}`,
        RATE_LIMIT,
        new Date('2026-08-06T00:27:00Z'),
      ),
    ).toBe(`Claude reported: ${MESSAGE}`);
  });

  it('leaves a message that already names a local zone exactly as written', () => {
    const local = "You've hit your session limit · resets 6:50pm (America/Indianapolis)";
    expect(displayClaudeRateLimitMessage(local, RATE_LIMIT, new Date('2026-08-06T00:27:00Z'))).toBe(local);
  });
});

describe('Claude rate-limit reset parsing', () => {
  const zoned = (time: string, zone: string): string =>
    `You've hit your session limit · resets ${time} (${zone})`;

  it('resolves a local IANA zone (Indianapolis is EDT in summer)', () => {
    // 6:50pm EDT (UTC-4) on 2026-08-06 = 22:50Z the same day.
    expect(
      parseClaudeLimitReset(zoned('6:50pm', 'America/Indianapolis'), new Date('2026-08-06T18:00:00Z'))?.toISOString(),
    ).toBe('2026-08-06T22:50:00.000Z');
  });

  it('rolls to tomorrow when the named time already passed today', () => {
    // 09:00Z on Aug 6 is 5am in Indianapolis, so 2am has gone — next is Aug 7.
    expect(
      parseClaudeLimitReset(zoned('2am', 'America/Indianapolis'), new Date('2026-08-06T09:00:00Z'))?.toISOString(),
    ).toBe('2026-08-07T06:00:00.000Z');
  });

  it('still handles the UTC wording, and gives up on a zone Intl rejects', () => {
    expect(
      parseClaudeLimitReset(zoned('2:30am', 'UTC'), new Date('2026-08-06T00:27:00Z'))?.toISOString(),
    ).toBe('2026-08-06T02:30:00.000Z');
    // null, not a guess: the caller falls back to a fixed exhaustion window.
    expect(parseClaudeLimitReset(zoned('6:50pm', 'Mars/Olympus_Mons'), new Date())).toBeNull();
    expect(parseClaudeLimitReset('Ordinary assistant text', new Date())).toBeNull();
  });
});

describe('isClaudeSessionLimitMessage', () => {
  const LOCAL = "You've hit your session limit · resets 1:50pm (America/Indianapolis)";

  it('accepts the streamed shape (isApiErrorMessage only, synthetic model)', () => {
    expect(isClaudeSessionLimitMessage(LOCAL, { isApiErrorMessage: true, model: '<synthetic>' })).toBe(true);
    expect(isClaudeSessionLimitMessage(LOCAL, { isApiErrorMessage: true })).toBe(true);
    expect(isClaudeSessionLimitMessage("You've reached your weekly limit · resets 2:30am (UTC)", { apiErrorStatus: 429 })).toBe(true);
  });

  it('rejects ordinary assistant text that merely quotes the limit', () => {
    expect(isClaudeSessionLimitMessage(LOCAL, { model: 'claude-sonnet-5' })).toBe(false);
    expect(isClaudeSessionLimitMessage(`Claude said: ${LOCAL}`, { isApiErrorMessage: true })).toBe(false);
  });

  it('rejects a synthetic failure that is not a limit', () => {
    expect(isClaudeSessionLimitMessage('Something else went wrong', { isApiErrorMessage: true, model: '<synthetic>' })).toBe(false);
  });
});
