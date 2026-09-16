import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type ClaudeAccountUsage } from '../../lib/api';
import { cn } from '@/lib/utils';

/**
 * Switch which connected Claude subscription answers, without leaving the chat.
 * The point is speed at the moment it matters: you hit a 5-hour limit mid-task,
 * open the model picker, and move to the account that still has headroom.
 *
 * Renders nothing unless at least two accounts are connected. It self-loads
 * from the admin usage route, so a member (403) simply sees nothing — the
 * caller doesn't have to know the viewer's role. Mount it INSIDE a dialog body
 * so the fetch happens on open rather than on every chat render.
 */
export function ClaudeAccountSwitcher({ provider }: { provider: string | null }) {
  const [accounts, setAccounts] = useState<ClaudeAccountUsage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (provider !== 'claude') return;
    let cancelled = false;
    // refresh=1 so the meters are worth acting on; the route coalesces probes
    // inside 15s, so re-opening the picker doesn't hammer Anthropic.
    api
      .usage(true)
      .then((r) => {
        if (!cancelled) setAccounts(r.providers.claude.accounts ?? []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (provider !== 'claude' || !accounts || accounts.length < 2) return null;

  const activate = async (accountId: string): Promise<void> => {
    setBusy(accountId);
    try {
      await api.claudeAccountActivate(accountId);
      setAccounts((prev) =>
        prev ? prev.map((account) => ({ ...account, active: account.accountId === accountId })) : prev,
      );
    } catch {
      /* the Settings screen is the place to see why; don't derail the picker */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Claude account</p>
      <div role="radiogroup" aria-label="Claude account" className="flex flex-col gap-0.5">
        {accounts.map((account) => {
          const fiveHour = account.windows.find((w) => w.id === 'five_hour');
          const weekly = account.windows.find((w) => w.id === 'seven_day');
          return (
            <button
              key={account.accountId}
              type="button"
              role="radio"
              aria-checked={account.active}
              disabled={busy !== null}
              onPointerUp={() => void activate(account.accountId)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm font-medium transition-colors',
                account.active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{account.label}</span>
              {busy === account.accountId ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {fiveHour ? `5h ${Math.round(fiveHour.usedPercent)}%` : 'no data'}
                {weekly ? ` · wk ${Math.round(weekly.usedPercent)}%` : ''}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Applies to your next message.</p>
    </div>
  );
}
