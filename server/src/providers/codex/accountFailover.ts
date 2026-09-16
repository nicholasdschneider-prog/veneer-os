import type Database from 'better-sqlite3';
import type { ConversationRow } from '../../db/db.js';
import type { ConversationManager } from '../../runtime/conversationManager.js';
import type { CodexAccountStore } from '../../codex/accounts.js';
import type { CodexUsageReader } from '../../usage/codex.js';
import type { CodexUsageLimitEvent } from '../codexAppServer/adapter.js';
import {
  DEFAULT_EXHAUSTION_MS,
  createFailoverGuard,
  pickFailoverAccount,
  type FailoverCandidate,
  type FailoverGuard,
} from '../claude/accountFailover.js';

/**
 * Automatic Codex account failover — the Codex twin of the Claude version in
 * ../claude/accountFailover.ts, sharing its ranking and loop guard.
 *
 * Codex ends a limited turn with a failed `turn/completed` whose error names
 * the usage limit. With several subscriptions connected, this activates the
 * one with the most headroom (per the live rate-limit read) and asks the
 * conversation to continue. Thread history is shared across account homes, so
 * the continuation resumes the same native thread on the new account.
 */

const USAGE_MAX_AGE_NOTE = 'Codex usage is read live per account (cached ~60s).';

export function codexFailoverContinuationMessage(limitedLabel: string, nextLabel: string, alreadySwitched = false): string {
  return (
    'Continue where you left off; the previous turn was cut off by a Codex usage limit on '
    + `${limitedLabel} and Veneer ${alreadySwitched ? 'is already running on' : 'switched this chat to'} ${nextLabel}. `
    + 'Pick up from the last completed step without repeating finished work.'
  );
}

/** Worst of the reported windows, or null when there is no reading. */
export function worstCodexUsedPercent(windows: { usedPercent: number }[]): number | null {
  if (windows.length === 0) return null;
  return windows.reduce((worst, w) => Math.max(worst, w.usedPercent), 0);
}

export interface CodexAccountFailoverOptions {
  db: Database.Database;
  accounts: CodexAccountStore;
  usage: Pick<CodexUsageReader, 'read'>;
  manager: Pick<ConversationManager, 'bus' | 'deliverWakeup'>;
  guard?: FailoverGuard;
  log?: Pick<Console, 'warn'>;
}

export interface CodexAccountFailover {
  /** Never rejects: failover is best effort on top of a turn that already failed. */
  handleUsageLimit(event: CodexUsageLimitEvent): Promise<void>;
}

export function createCodexAccountFailover(opts: CodexAccountFailoverOptions): CodexAccountFailover {
  const guard = opts.guard ?? createFailoverGuard();
  const log = opts.log ?? console;
  const conversationStmt = opts.db.prepare('SELECT * FROM conversations WHERE id = ?');

  function notice(conversationId: string, message: string): void {
    opts.manager.bus.emit('event', conversationId, { type: 'notice', message });
  }

  async function run(event: CodexUsageLimitEvent): Promise<void> {
    if (!event.conversationId) return;
    const nowMs = event.at.getTime();
    const limitedId = event.accountId ?? opts.accounts.activeAccountId();
    // Codex's message rarely carries a parseable reset time; sit the account
    // out for the default window so the next chat does not switch straight back.
    if (limitedId) guard.markExhausted(limitedId, nowMs + DEFAULT_EXHAUSTION_MS);
    if (!guard.canSwitch(event.conversationId, nowMs)) return;
    const conv = conversationStmt.get(event.conversationId) as ConversationRow | undefined;
    if (!conv) return;

    const usage = await opts.usage.read().catch(() => null);
    const decisionMs = Date.now();
    if (!guard.canSwitch(event.conversationId, decisionMs)) return;
    const accounts = opts.accounts.list().filter((account) => account.connected);
    const activeId = opts.accounts.activeAccountId();
    const labelFor = (id: string | null): string =>
      accounts.find((account) => account.id === id)?.label ?? 'the previous account';
    const usageById = new Map((usage?.accounts ?? []).map((entry) => [entry.accountId, entry]));
    const candidates: FailoverCandidate[] = accounts.map((account) => ({
      id: account.id,
      label: account.label,
      usedPercent: worstCodexUsedPercent(usageById.get(account.id)?.windows ?? []),
    }));
    const exclude = guard.exhausted(decisionMs);
    if (limitedId) exclude.add(limitedId);
    const alreadyActive = limitedId && activeId !== limitedId
      ? pickFailoverAccount(candidates.filter((account) => account.id === activeId), exclude)
      : null;
    const next = alreadyActive ?? pickFailoverAccount(candidates, exclude);
    if (!next) return;
    if (!alreadyActive && !opts.accounts.setActive(next.id)) return;

    guard.noteSwitch(event.conversationId, decisionMs);
    notice(
      event.conversationId,
      `Usage limit hit on ${labelFor(limitedId)}. ${alreadyActive ? 'Already on' : 'Switched to'} ${next.label}, continuing.`,
    );
    opts.manager.deliverWakeup(
      conv,
      codexFailoverContinuationMessage(labelFor(limitedId), next.label, Boolean(alreadyActive)),
      `codex-failover:${event.conversationId}:${nowMs}`,
    );
  }

  return {
    handleUsageLimit(event) {
      return run(event).catch((err: Error) => {
        log.warn(`[codex] account failover failed: ${err.message} (${USAGE_MAX_AGE_NOTE})`);
      });
    },
  };
}
