import type { UsageWindow } from '../usage/contract.js';

export const SPARE_TIME_ZONE = 'America/Indiana/Indianapolis';
export const SPARE_RESERVE = 1;
export interface SpareAccount {
  provider: 'claude' | 'codex'; accountId: string; label: string;
  capturedAt: string | null; windows: UsageWindow[]; connected: boolean;
  paidUsageDisabled: boolean; source: string | null;
  credentialRevision?: string;
}
const clock = new Intl.DateTimeFormat('en-US', { timeZone: SPARE_TIME_ZONE, hour: '2-digit', hourCycle: 'h23' });
export function businessHours(now: number): boolean {
  const hour = Number(clock.format(new Date(now)));
  return hour >= 8 && hour < 17;
}
export interface SpareEligibility { reason: string; reset: string | null; deadline: string | null; used: number }
/** Conservative across every reported model window; unknown telemetry never grants capacity. */
export function eligibility(account: SpareAccount, now: number): SpareEligibility {
  const no = (reason: string): SpareEligibility => ({ reason, reset: null, deadline: null, used: 0 });
  if (businessHours(now)) return no('Business hours');
  if (!account.connected) return no('Account disconnected');
  if (!account.paidUsageDisabled) return no('Paid fallback not verified disabled');
  const age = now - Date.parse(account.capturedAt ?? '');
  if (!Number.isFinite(age) || age < -5_000 || age > 30_000 || !['live','oauth'].includes(account.source ?? '')) return no('Fresh provider telemetry required');
  const windows = account.windows;
  if (!windows.length || windows.some(w => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 || !w.resetsAt || !Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) <= now || !w.windowMinutes)) return no('Incomplete or expired usage windows');
  const weekly = windows.filter(w => w.windowMinutes === 10080);
  if (!weekly.length) return no('Weekly reset unavailable');
  // Different model reset times: use the earliest, never assume they coincide.
  const resetMs = Math.min(...weekly.map(w => Date.parse(w.resetsAt!)));
  if (resetMs - now > 6 * 3600_000) return no('Outside final six hours');
  // Check the complete interval in real time: DST and midnight need no guessed offset.
  for (let t = now; t < resetMs; t += 60_000) if (businessHours(t)) return no('Business hours before reset');
  const used = Math.max(...windows.map(w => w.usedPercent));
  if (used >= 100 - SPARE_RESERVE) return no('1% reserve reached');
  // Near the reserve, stop early rather than gambling on another long generation.
  if (used >= 98) return no('Allowance too close to reserve for another batch');
  if (windows.some(w => /rejected|blocked|exceeded/.test(w.status ?? ''))) return no('Provider limit');
  const earliestReset = Math.min(...windows.map(w => Date.parse(w.resetsAt!)));
  const deadlineMs = Math.min(now + 120_000, earliestReset - 30_000);
  if (deadlineMs - now < 30_000) return no('Insufficient time for a checkpoint');
  return { reason: 'Eligible', reset: new Date(resetMs).toISOString(), deadline: new Date(deadlineMs).toISOString(), used };
}
