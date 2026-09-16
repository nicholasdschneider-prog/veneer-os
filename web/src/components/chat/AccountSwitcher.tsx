import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type ProviderAccountUsage, type UsageWindow } from '../../lib/api';
import { cn } from '@/lib/utils';

/**
 * Switch which connected subscription answers, without leaving the chat. The
 * point is speed at the moment it matters: you hit a usage limit mid-task,
 * open the model picker, and move to the account that still has headroom.
 * Claude and Codex both keep several accounts with one active (see
 * server/src/secrets/store.ts and server/src/codex/accounts.ts).
 *
 * Renders nothing unless at least two accounts are connected. It self-loads
 * from the admin usage route, so a member (403) simply sees nothing — the
 * caller doesn't have to know the viewer's role. Mount it INSIDE a dialog body
 * so the fetch happens on open rather than on every chat render.
 */
type SwitchableProvider = 'claude' | 'codex';

const PROVIDER_NAME: Record<SwitchableProvider, string> = { claude: 'Claude', codex: 'Codex' };

function isSwitchable(provider: string | null): provider is SwitchableProvider {
  return provider === 'claude' || provider === 'codex';
}

/** Short-window and weekly readings, whatever the provider calls its windows. */
export function windowSummary(windows: UsageWindow[]): string {
  const short = windows.find((w) => w.id === 'five_hour' || (w.windowMinutes != null && w.windowMinutes < 1440))
    ?? windows.find((w) => w.id === 'primary');
  const weekly = windows.find((w) => w.id === 'seven_day' || (w.windowMinutes ?? 0) >= 1440)
    ?? windows.find((w) => w.id === 'secondary');
  const parts: string[] = [];
  if (short) parts.push(`5h ${Math.round(short.usedPercent)}%`);
  if (weekly) parts.push(`wk ${Math.round(weekly.usedPercent)}%`);
  return parts.length > 0 ? parts.join(' · ') : 'no data';
}

export function AccountSwitcher({ provider }: { provider: string | null }) {
  const [accounts, setAccounts] = useState<ProviderAccountUsage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isSwitchable(provider)) return;
    let cancelled = false;
    // refresh=1 so the meters are worth acting on; the route coalesces probes
    // inside 15s, so re-opening the picker doesn't hammer the provider.
    api
      .usage(true)
      .then((r) => {
        if (!cancelled) setAccounts(r.providers[provider].accounts ?? []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (!isSwitchable(provider) || !accounts || accounts.length < 2) return null;

  const activate = async (accountId: string): Promise<void> => {
    setBusy(accountId);
    try {
      if (provider === 'claude') await api.claudeAccountActivate(accountId);
      else await api.codexAccountActivate(accountId);
      setAccounts((prev) =>
        prev ? prev.map((account) => ({ ...account, active: account.accountId === accountId })) : prev,
      );
    } catch {
      /* the Settings screen is the place to see why; don't derail the picker */
    } finally {
      setBusy(null);
    }
  };

  const name = `${PROVIDER_NAME[provider]} account`;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{name}</p>
      <div role="radiogroup" aria-label={name} className="flex flex-col gap-0.5">
        {accounts.map((account) => (
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
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{windowSummary(account.windows)}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Applies to your next message.</p>
    </div>
  );
}
