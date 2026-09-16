import { describe, expect, it } from 'vitest';
import { pageExpiresSoon, pageExpiryDate, pageExpiryLabel, parsePageDate } from './pageExpiry';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

describe('page expiry formatting', () => {
  it('normalizes SQLite UTC dates', () => {
    expect(parsePageDate('2026-07-29 12:00:00').toISOString()).toBe('2026-07-29T12:00:00.000Z');
  });

  it('shows compact countdowns and the generic policy when metadata is unavailable', () => {
    expect(pageExpiryLabel(undefined, NOW)).toBe('7-day expiry');
    expect(pageExpiryLabel('2026-08-05 12:00:00', NOW)).toBe('Expires in 7d');
    expect(pageExpiryLabel('2026-07-29 12:45:00', NOW)).toBe('Expires in 45m');
    expect(pageExpiryLabel('2026-07-29 11:59:00', NOW)).toBe('Expired');
  });

  it('marks the final day as urgent', () => {
    expect(pageExpiresSoon('2026-07-30 12:00:00', NOW)).toBe(true);
    expect(pageExpiresSoon('2026-07-30 12:01:00', NOW)).toBe(false);
  });

  it('formats an exact expiry date', () => {
    expect(pageExpiryDate('2026-08-05 12:00:00')).not.toBe('');
  });
});
