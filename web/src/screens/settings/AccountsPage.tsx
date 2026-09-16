import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Plus,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  api,
  type ClaudeAccount,
  type ClaudeOutputStyle,
  type ClaudePreferences,
  type ClaudeStatus,
  type ProbeResult,
  type CodexAccount,
  type CodexStatus,
  type CodexAttemptState,
  type GrokStatus,
  type GrokAttemptState,
  type ModelOption,
  type ModelPrefs,
  type ApiKeyStatus,
  type ProviderRuntimeVersion,
  type ProviderRuntimeVersions,
} from '../../lib/api';
import { isProvider, modelKey, orderModels, PROVIDERS, providerLabel, type Provider } from '../../lib/modelLabel';
import { ProviderIcon } from '@/components/ProviderIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function formatConnectedAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function useCountdown(expiresAt: string | null): number {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!expiresAt) {
      setRemaining(0);
      return;
    }
    const end = new Date(expiresAt).getTime();
    const tick = () => setRemaining(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return remaining;
}

interface Attempt {
  attemptId: string;
  authorizeUrl: string;
  expiresAt: string;
}

function TimerPill({ remaining }: { remaining: number }) {
  if (remaining <= 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
      <Clock className="size-3.5 shrink-0" />
      Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
    </div>
  );
}

function StepMarker({ number, state }: { number: 1 | 2; state: 'active' | 'todo' | 'done' }) {
  return (
    <div
      aria-hidden="true"
      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        state === 'active'
          ? 'bg-primary text-primary-foreground'
          : state === 'done'
            ? 'bg-secondary text-brand'
            : 'bg-secondary text-muted-foreground'
      }`}
    >
      {state === 'done' ? <Check className="size-4 shrink-0" /> : number}
    </div>
  );
}

export function ProviderVersionLine({ info }: { info: ProviderRuntimeVersion | null | undefined }) {
  const text = info === undefined
    ? 'Checking version…'
    : info?.version
      ? `${info.runtime} ${info.version}`
      : `${info?.runtime ?? 'Provider runtime'} version unavailable`;
  return <p className="mt-1 text-xs text-muted-foreground">{text}</p>;
}

/**
 * One connected Claude subscription. Switching is manual and takes effect on
 * the next message, which is the whole point: hit a 5-hour limit on one
 * account, click another, keep working — no logout/login cycle.
 */
/** The fields a per-account row needs; Claude and Codex accounts both carry them. */
interface AccountRowModel {
  id: string;
  label: string;
  email: string | null;
  planType: string | null;
  active: boolean;
  /** Codex only: the profile lost its credential (sign in again). */
  connected?: boolean;
}

function ProviderAccountRow({
  account,
  busy,
  renaming,
  onRename,
  onRenameChange,
  onRenameCommit,
  onActivate,
  onRemove,
  removable,
}: {
  account: AccountRowModel;
  busy: boolean;
  renaming: boolean;
  onRename: () => void;
  onRenameChange: (label: string) => void;
  onRenameCommit: (label: string | null) => void;
  onActivate: () => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <li
      className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 ${
        account.active ? 'border-brand/40 bg-accent/50' : ''
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {renaming ? (
          <Input
            autoFocus
            aria-label="Account name"
            defaultValue={account.label}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit(e.currentTarget.value);
              if (e.key === 'Escape') onRenameCommit(null);
            }}
            onBlur={(e) => onRenameCommit(e.currentTarget.value)}
            className="h-8 max-w-64 rounded-lg text-sm"
          />
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{account.label}</span>
            {account.planType ? (
              <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-brand">
                {account.planType}
              </span>
            ) : null}
          </span>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {account.email && account.email !== account.label ? `${account.email} · ` : ''}
          {account.connected === false
            ? 'Signed out — connect again to use this account'
            : account.active
              ? 'Active — new messages use this account'
              : 'Connected'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {account.active ? (
          <span className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand">Active</span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg text-xs"
            onPointerUp={onActivate}
            disabled={busy}
          >
            {busy ? <Loader2 className="animate-spin" /> : 'Use this'}
          </Button>
        )}
        {renaming ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg text-xs text-muted-foreground"
            onPointerUp={onRename}
          >
            Rename
          </Button>
        )}
        {removable ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${account.label}`}
            className="size-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onPointerUp={onRemove}
            disabled={busy}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function AccountsPage({ showNewChatDefaults = true }: { showNewChatDefaults?: boolean } = {}) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claudePreferences, setClaudePreferences] = useState<ClaudePreferences | null>(null);
  const [claudePreferencesError, setClaudePreferencesError] = useState<string | null>(null);
  const [savingClaudePreferences, setSavingClaudePreferences] = useState(false);
  const [providerVersions, setProviderVersions] = useState<ProviderRuntimeVersions | null>();

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'start' | 'complete' | 'test' | 'disconnect'>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  // Several Claude subscriptions can be connected at once; `accountBusy` holds
  // the id being switched/removed so only that row shows a spinner.
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);

  const attemptRef = useRef<Attempt | null>(null);
  attemptRef.current = attempt;

  const remaining = useCountdown(attempt?.expiresAt ?? null);
  const expired = attempt !== null && remaining <= 0;

  const loadStatus = useCallback(() => {
    api
      .claudeStatus()
      .then(setStatus)
      .catch((err: Error) => setLoadError(err.message));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  // Model preferences are shared across the new-chat defaults and provider
  // cards (each renders its own model list), so they live here.
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null);
  const [models, setModels] = useState<Record<Provider, ModelOption[]> | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [openRouterKey, setOpenRouterKey] = useState<ApiKeyStatus | null>(null);
  const [openRouterProbe, setOpenRouterProbe] = useState<ProbeResult | null>(null);
  const [openRouterTesting, setOpenRouterTesting] = useState(false);
  const [newOpenRouterModel, setNewOpenRouterModel] = useState('');

  const refreshProviderVersions = useCallback(async () => {
    const result = await api.providerVersions();
    setProviderVersions(result.versions);
  }, []);

  useEffect(() => {
    let stop = false;
    void Promise.all([
      api.modelPrefs().then((r) => r.prefs),
      api.models('claude').then((r) => r.models).catch(() => []),
      api.models('openrouter').then((r) => r.models).catch(() => []),
      api.models('codex').then((r) => r.models).catch(() => []),
      api.models('grok').then((r) => r.models).catch(() => []),
      api.apiKeys().then((r) => r.keys.find((k) => k.id === 'openrouter') ?? null).catch(() => null),
      api.claudePreferences().then(
        (r) => ({ value: r.preferences, error: null }),
        (err: Error) => ({ value: null, error: err.message }),
      ),
      api.providerVersions().then((r) => r.versions).catch(() => null),
    ])
      .then(([p, claude, openrouter, codex, grok, openRouterStatus, claudePreferenceResult, versions]) => {
        if (stop) return;
        setPrefs(p);
        setModels({ claude, openrouter, codex, grok });
        setOpenRouterKey(openRouterStatus);
        setClaudePreferences(claudePreferenceResult.value);
        setClaudePreferencesError(claudePreferenceResult.error);
        setProviderVersions(versions);
      })
      .catch((err: Error) => setPrefsError(err.message));
    return () => {
      stop = true;
    };
  }, []);

  const saveClaudeOutputStyle = useCallback(async (outputStyle: ClaudeOutputStyle) => {
    if (!claudePreferences) return;
    const previous = claudePreferences;
    setClaudePreferences({ outputStyle });
    setClaudePreferencesError(null);
    setSavingClaudePreferences(true);
    try {
      const result = await api.updateClaudePreferences({ outputStyle });
      setClaudePreferences(result.preferences);
    } catch (err) {
      setClaudePreferences(previous);
      setClaudePreferencesError((err as Error).message);
    } finally {
      setSavingClaudePreferences(false);
    }
  }, [claudePreferences]);

  const savePrefs = useCallback((next: ModelPrefs) => {
    setPrefs(next); // optimistic; the server response reconciles
    setPrefsError(null);
    void api
      .updateModelPrefs(next)
      .then((r) => setPrefs(r.prefs))
      .catch((err: Error) => setPrefsError(err.message));
  }, []);

  const setProviderDefault = useCallback(
    (provider: Provider, model: string | null) => {
      if (!prefs) return;
      savePrefs({ ...prefs, providerDefaults: { ...prefs.providerDefaults, [provider]: model } });
    },
    [prefs, savePrefs],
  );

  const toggleHidden = useCallback(
    (provider: Provider, model: string) => {
      if (!prefs) return;
      const key = modelKey(provider, model);
      const hiding = !prefs.hiddenModels.includes(key);
      savePrefs({
        ...prefs,
        hiddenModels: hiding ? [...prefs.hiddenModels, key] : prefs.hiddenModels.filter((k) => k !== key),
      });
    },
    [prefs, savePrefs],
  );

  const setModelOrder = useCallback(
    (provider: Provider, ids: string[]) => {
      if (!prefs) return;
      savePrefs({ ...prefs, modelOrder: { ...prefs.modelOrder, [provider]: ids } });
    },
    [prefs, savePrefs],
  );

  const setOpenRouterModels = useCallback(
    (ids: string[]) => {
      if (!prefs || ids.length === 0) return;
      const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      const currentDefault = prefs.providerDefaults.openrouter;
      const next: ModelPrefs = {
        ...prefs,
        openrouterModels: unique,
        providerDefaults: {
          ...prefs.providerDefaults,
          openrouter: currentDefault && unique.includes(currentDefault) ? currentDefault : unique[0]!,
        },
        hiddenModels: prefs.hiddenModels.filter(
          (key) => !key.startsWith('openrouter:') || unique.includes(key.slice('openrouter:'.length)),
        ),
        modelOrder: { ...prefs.modelOrder, openrouter: unique },
      };
      setPrefs(next);
      setModels((prev) =>
        prev
          ? {
              ...prev,
              openrouter: unique.map(
                (id) => prev.openrouter.find((m) => m.id === id) ?? { id, label: id, efforts: ['low', 'medium', 'high'] },
              ),
            }
          : prev,
      );
      setPrefsError(null);
      void api
        .updateModelPrefs(next)
        .then(async (r) => {
          setPrefs(r.prefs);
          const refreshed = await api.models('openrouter');
          setModels((prev) => (prev ? { ...prev, openrouter: refreshed.models } : prev));
        })
        .catch((err: Error) => setPrefsError(err.message));
    },
    [prefs],
  );

  const addOpenRouterModel = useCallback(() => {
    const id = newOpenRouterModel.trim();
    if (!prefs || !/^[^\s/]+\/[^\s/]+$/.test(id)) {
      setPrefsError('Enter an exact OpenRouter model id such as z-ai/glm-5.2.');
      return;
    }
    if (!prefs.openrouterModels.includes(id)) setOpenRouterModels([...prefs.openrouterModels, id]);
    setNewOpenRouterModel('');
  }, [newOpenRouterModel, prefs, setOpenRouterModels]);

  const testOpenRouter = useCallback(async () => {
    setOpenRouterTesting(true);
    setOpenRouterProbe(null);
    try {
      const r = await api.openRouterTest();
      setOpenRouterProbe(r.result);
    } catch (err) {
      setOpenRouterProbe({ ok: false, detail: (err as Error).message });
    } finally {
      setOpenRouterTesting(false);
    }
  }, []);

  // Best-effort cancel of an in-flight attempt if the user leaves.
  useEffect(() => {
    return () => {
      const a = attemptRef.current;
      if (a) void api.claudeConnectCancel(a.attemptId).catch(() => undefined);
    };
  }, []);

  const startConnect = useCallback(async () => {
    setBusy('start');
    setFlowError(null);
    setProbe(null);
    setCode('');
    try {
      const r = await api.claudeConnectStart();
      setAttempt({ attemptId: r.attemptId, authorizeUrl: r.authorizeUrl, expiresAt: r.expiresAt });
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const complete = useCallback(async () => {
    const a = attemptRef.current;
    if (!a || !code.trim()) return;
    setBusy('complete');
    setFlowError(null);
    try {
      const r = await api.claudeConnectComplete(a.attemptId, code.trim());
      setAttempt(null);
      setCode('');
      setProbe(r.probe);
      loadStatus();
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [code, loadStatus]);

  const cancelAttempt = useCallback(async () => {
    const a = attemptRef.current;
    setAttempt(null);
    setCode('');
    setFlowError(null);
    if (a) await api.claudeConnectCancel(a.attemptId).catch(() => undefined);
  }, []);

  const test = useCallback(async () => {
    setBusy('test');
    setProbe(null);
    setFlowError(null);
    try {
      const r = await api.claudeTest();
      setProbe(r.result);
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  /** Run an account action and fold its fresh list back into status. */
  const accountAction = useCallback(
    async (id: string, run: () => Promise<{ accounts: ClaudeAccount[] }>) => {
      setAccountBusy(id);
      setFlowError(null);
      setProbe(null);
      try {
        const r = await run();
        setStatus((prev) => (prev ? { ...prev, accounts: r.accounts, connected: r.accounts.length > 0 } : prev));
        loadStatus();
      } catch (err) {
        setFlowError((err as Error).message);
      } finally {
        setAccountBusy(null);
      }
    },
    [loadStatus],
  );

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    setFlowError(null);
    setProbe(null);
    try {
      await api.claudeDisconnect();
      setConfirmLogout(false);
      loadStatus();
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadStatus]);

  const connected = status?.connected ?? false;
  const accounts = status?.accounts ?? [];
  const conciseOutputStyleSupported = providerVersions?.claude.supportsConciseOutputStyle ?? false;

  return (
    <div className="flex flex-col gap-4">
      {loadError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{loadError}</div>
      ) : null}
      {prefsError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{prefsError}</div>
      ) : null}

      {showNewChatDefaults ? <NewChatDefaultsCard prefs={prefs} models={models} onChange={savePrefs} /> : null}

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <ProviderIcon provider="claude" variant="color" className="size-5" />
            {accounts.length > 1 ? 'Claude accounts' : 'Claude account'}
          </CardTitle>
          <CardAction>
            {status ? (
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                  connected ? 'bg-accent text-brand' : 'bg-destructive/10 text-destructive'
                }`}
              >
                {connected ? 'Connected' : 'Not connected'}
              </span>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">…</span>
            )}
          </CardAction>
        </CardHeader>

        <CardContent className="text-sm">
          {status && connected && !attempt && accounts.length === 0 ? (
            <p className="text-muted-foreground">
              {status.source === 'env'
                ? 'Connected via server configuration.'
                : status.connectedAt
                  ? `Connected ${formatConnectedAt(status.connectedAt)}.`
                  : 'Connected.'}
            </p>
          ) : null}

          {accounts.length > 0 && !attempt ? (
            <>
              <ul className="flex flex-col gap-2">
                {accounts.map((account) => (
                  <ProviderAccountRow
                    key={account.id}
                    account={account}
                    busy={accountBusy === account.id}
                    renaming={renaming?.id === account.id}
                    onRename={() => setRenaming({ id: account.id, label: account.label })}
                    onRenameChange={(label) => setRenaming({ id: account.id, label })}
                    onRenameCommit={(label) => {
                      setRenaming(null);
                      const next = label?.trim();
                      if (!next || next === account.label) return;
                      void accountAction(account.id, () => api.claudeAccountRename(account.id, next));
                    }}
                    onActivate={() => void accountAction(account.id, () => api.claudeAccountActivate(account.id))}
                    onRemove={() => void accountAction(account.id, () => api.claudeAccountRemove(account.id))}
                    // Removing the last account would leave the assistant unable
                    // to answer; Disconnect below is the explicit way to do that.
                    removable={accounts.length > 1}
                  />
                ))}
              </ul>
              {accounts.length > 1 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Switching applies to your next message. A reply already in progress finishes on the account it
                  started with.
                </p>
              ) : null}
            </>
          ) : null}

          {status && !connected && !attempt ? (
            <p className="text-muted-foreground">
              Connect your Claude subscription so your assistant can answer.
            </p>
          ) : null}
          <ProviderVersionLine
            info={providerVersions === undefined ? undefined : providerVersions?.claude ?? null}
          />

          {/* Probe result */}
          {probe ? (
            <div
              className={`mt-4 flex items-start gap-1.5 rounded-xl px-4 py-2.5 ${
                probe.ok ? 'bg-accent text-brand' : 'bg-destructive/10 text-destructive'
              }`}
            >
              {probe.ok ? <CheckCircle2 className="size-4 shrink-0 translate-y-0.5" /> : <XCircle className="size-4 shrink-0 translate-y-0.5" />}
              <span>
                {probe.ok ? 'Connection works. ' : ''}
                {probe.detail}
              </span>
            </div>
          ) : null}

          {flowError ? (
            <div className="mt-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{flowError}</div>
          ) : null}

          {/* ── Connect flow ── */}
          {attempt ? (
            <div className="mt-4 flex flex-col gap-2">
              <div className="overflow-hidden rounded-2xl border">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
                  <p className="font-semibold">Connect in two steps</p>
                  <TimerPill remaining={remaining} />
                </div>
                {expired ? (
                  <div className="p-4">
                    <div className="rounded-xl bg-amber-500/10 px-4 py-2.5 text-amber-700 dark:text-amber-300">
                      This sign-in link expired. Tap Start over to get a fresh one.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-3.5 p-4">
                      <StepMarker number={1} state={code.trim().length > 0 ? 'done' : 'active'} />
                      <div className={`flex min-w-0 flex-1 flex-col gap-3 ${code.trim().length > 0 ? 'opacity-65' : ''}`}>
                        <div>
                          <p className="font-medium">Authorize on claude.com</p>
                          <p className="text-xs text-muted-foreground">
                            {code.trim().length > 0
                              ? 'Authorized in your browser.'
                              : 'Sign in and copy the whole code Claude shows you.'}
                          </p>
                        </div>
                        {code.trim().length === 0 ? (
                          <Button asChild className="h-10 self-start rounded-xl px-5">
                            <a href={attempt.authorizeUrl} target="_blank" rel="noopener noreferrer">
                              Open Claude
                              <ArrowRight />
                            </a>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex gap-3.5 border-t p-4">
                      <StepMarker number={2} state={code.trim().length > 0 ? 'active' : 'todo'} />
                      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                        <div className={code.trim().length > 0 ? '' : 'opacity-65'}>
                          <p className="font-medium">Paste your code</p>
                          {code.trim().length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              The Complete button lights up once a code is pasted.
                            </p>
                          ) : null}
                        </div>
                        <div className="flex overflow-hidden rounded-xl border focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                          <Input
                            name="claude-connect-code"
                            aria-label="Claude authorization code"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="Paste the code here"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            className="h-11 min-w-0 flex-1 rounded-none border-0 px-4 font-mono text-base focus-visible:ring-0 md:text-base"
                          />
                          <Button
                            onPointerUp={() => void complete()}
                            disabled={!code.trim() || busy === 'complete'}
                            className={`h-11 rounded-none border-r border-r-border px-5 ${
                              code.trim() ? '' : 'bg-secondary text-muted-foreground hover:bg-secondary'
                            }`}
                          >
                            {busy === 'complete' ? (
                              <>
                                <Loader2 className="animate-spin" />
                                Completing…
                              </>
                            ) : (
                              'Complete'
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onPointerUp={() => void startConnect()}
                  disabled={busy === 'start'}
                >
                  {busy === 'start' ? 'Starting…' : 'Start over'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onPointerUp={() => void cancelAttempt()}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            /* ── Idle actions ── */
            <div className="mt-4">
              {connected ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="h-9 rounded-xl px-4 text-sm"
                    onPointerUp={() => void test()}
                    disabled={busy === 'test'}
                  >
                    {busy === 'test' ? 'Testing…' : 'Test connection'}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-9 rounded-xl px-4 text-sm"
                    onPointerUp={() => void startConnect()}
                    disabled={busy === 'start'}
                  >
                    {busy === 'start' ? 'Starting…' : accounts.length > 0 ? 'Add account' : 'Reconnect'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-9 rounded-xl px-3 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onPointerUp={() => setConfirmLogout(true)}
                  >
                    {accounts.length > 1 ? 'Disconnect all' : 'Disconnect'}
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    className="h-10 rounded-xl px-5"
                    onPointerUp={() => void startConnect()}
                    disabled={busy === 'start'}
                  >
                    {busy === 'start' ? (
                      'Starting…'
                    ) : (
                      <>
                        Connect Claude
                        <ArrowRight />
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
          )}

          <div className="mt-5 border-t pt-4">
            <label className="block text-sm font-medium" htmlFor="claude-output-style">
              Claude Code response style
            </label>
            <select
              id="claude-output-style"
              value={claudePreferences?.outputStyle ?? 'Default'}
              onChange={(event) => void saveClaudeOutputStyle(event.target.value as ClaudeOutputStyle)}
              disabled={!claudePreferences || savingClaudePreferences}
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="Default">Default</option>
              <option value="Concise" disabled={!conciseOutputStyleSupported}>Concise</option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              Only affects new Claude Code chats. Codex, Grok, and OpenRouter are unchanged.
            </p>
            {providerVersions !== undefined && !conciseOutputStyleSupported ? (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Concise requires Claude Code 2.1.237 or newer.
                {providerVersions?.claude.version
                  ? ` This machine is on ${providerVersions.claude.version}.`
                  : ' The installed version could not be checked.'}
              </p>
            ) : null}
            {claudePreferencesError ? (
              <p className="mt-2 text-xs text-destructive">{claudePreferencesError}</p>
            ) : null}
          </div>

          <ModelSection
            provider="claude"
            models={models?.claude ?? null}
            prefs={prefs}
            onDefault={setProviderDefault}
            onHide={toggleHidden}
            onReorder={setModelOrder}
          />
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <ProviderIcon provider="openrouter" variant="color" className="size-5" />
            OpenRouter
          </CardTitle>
          <CardAction>
            {openRouterKey ? (
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                  openRouterKey.configured ? 'bg-accent text-brand' : 'bg-destructive/10 text-destructive'
                }`}
              >
                {openRouterKey.configured ? 'Connected' : 'Not connected'}
              </span>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">…</span>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="text-sm">
          <p className="text-muted-foreground">
            {openRouterKey?.configured
              ? `Using the ${openRouterKey.source === 'override' ? 'saved override' : 'server default'}${openRouterKey.hint ? ` (${openRouterKey.hint})` : ''}. Claude Code runs in an isolated OpenRouter profile.`
              : 'Add an OpenRouter key under Credentials. Your Claude account stays signed in separately.'}
          </p>
          <ProviderVersionLine
            info={providerVersions === undefined ? undefined : providerVersions?.openrouter ?? null}
          />
          {openRouterProbe ? (
            <div
              className={`mt-4 flex items-start gap-1.5 rounded-xl px-4 py-2.5 ${
                openRouterProbe.ok ? 'bg-accent text-brand' : 'bg-destructive/10 text-destructive'
              }`}
            >
              {openRouterProbe.ok ? <CheckCircle2 className="size-4 shrink-0 translate-y-0.5" /> : <XCircle className="size-4 shrink-0 translate-y-0.5" />}
              <span>{openRouterProbe.detail}</span>
            </div>
          ) : null}
          <Button
            variant="outline"
            className="mt-4 h-12 w-full rounded-xl text-base"
            onPointerUp={() => void testOpenRouter()}
            disabled={!openRouterKey?.configured || openRouterTesting}
          >
            {openRouterTesting ? 'Testing…' : 'Test connection'}
          </Button>

          <div className="mt-5 border-t pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Add exact model</p>
            <div className="flex gap-2">
              <Input
                value={newOpenRouterModel}
                onChange={(e) => setNewOpenRouterModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addOpenRouterModel();
                }}
                placeholder="provider/model-id"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 rounded-xl font-mono text-sm"
              />
              <Button
                size="icon-lg"
                variant="outline"
                className="h-11 w-11 shrink-0 rounded-xl"
                onPointerUp={addOpenRouterModel}
                aria-label="Add OpenRouter model"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          <ModelSection
            provider="openrouter"
            models={models?.openrouter ?? null}
            prefs={prefs}
            onDefault={setProviderDefault}
            onHide={toggleHidden}
            onReorder={setModelOrder}
            onRemove={(_, model) => {
              if (prefs && prefs.openrouterModels.length > 1) {
                setOpenRouterModels(prefs.openrouterModels.filter((id) => id !== model));
              }
            }}
          />
        </CardContent>
      </Card>

      <CodexAccountCard
        version={providerVersions === undefined ? undefined : providerVersions?.codex ?? null}
        onInstalled={refreshProviderVersions}
      >
        <ModelSection
          provider="codex"
          models={models?.codex ?? null}
          prefs={prefs}
          onDefault={setProviderDefault}
          onHide={toggleHidden}
          onReorder={setModelOrder}
        />
      </CodexAccountCard>

      <GrokAccountCard
        version={providerVersions === undefined ? undefined : providerVersions?.grok ?? null}
        onInstalled={refreshProviderVersions}
      >
        <ModelSection
          provider="grok"
          models={models?.grok ?? null}
          prefs={prefs}
          onDefault={setProviderDefault}
          onHide={toggleHidden}
          onReorder={setModelOrder}
        />
      </GrokAccountCard>

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{accounts.length > 1 ? 'Disconnect all Claude accounts?' : 'Disconnect Claude?'}</DialogTitle>
            <DialogDescription>
              {accounts.length > 1
                ? "Removes every connected Claude account. Your assistant won't be able to reply until you connect again."
                : "Your assistant won't be able to reply until you connect again."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={() => setConfirmLogout(false)}>
              Keep connected
            </Button>
            <Button
              variant="destructive"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => void disconnect()}
              disabled={busy === 'disconnect'}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const ALL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function NewChatDefaultsSettings() {
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null);
  const [models, setModels] = useState<Record<Provider, ModelOption[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void Promise.all([
      api.modelPrefs().then((result) => result.prefs),
      api.models('claude').then((result) => result.models).catch(() => []),
      api.models('openrouter').then((result) => result.models).catch(() => []),
      api.models('codex').then((result) => result.models).catch(() => []),
      api.models('grok').then((result) => result.models).catch(() => []),
    ])
      .then(([nextPrefs, claude, openrouter, codex, grok]) => {
        if (stop) return;
        setPrefs(nextPrefs);
        setModels({ claude, openrouter, codex, grok });
      })
      .catch((err: Error) => {
        if (!stop) setError(err.message);
      });
    return () => {
      stop = true;
    };
  }, []);

  const save = useCallback((next: ModelPrefs) => {
    setPrefs(next);
    setError(null);
    void api
      .updateModelPrefs(next)
      .then((result) => setPrefs(result.prefs))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="space-y-3">
      {error ? <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p> : null}
      <NewChatDefaultsCard prefs={prefs} models={models} onChange={save} />
    </div>
  );
}

export function NewChatDefaultsCard({
  prefs,
  models,
  onChange,
}: {
  prefs: ModelPrefs | null;
  models: Record<Provider, ModelOption[]> | null;
  onChange: (next: ModelPrefs) => void;
}) {
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">New chat defaults</CardTitle>
        <CardDescription>
          Choose which account new chats start with. Individual agents can override this under Agents.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {!prefs ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p className="mb-1.5 font-medium">Default provider</p>
            <div className="flex overflow-hidden rounded-xl border">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onPointerUp={() => onChange({ ...prefs, defaultProvider: provider })}
                  aria-pressed={prefs.defaultProvider === provider}
                  className={`flex h-11 flex-1 items-center justify-center gap-1.5 px-2 text-xs font-medium transition-colors ${
                    prefs.defaultProvider === provider
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  <ProviderIcon provider={provider} className="size-3.5" />
                  {providerLabel(provider)}
                </button>
              ))}
            </div>
            {isProvider(prefs.defaultProvider) && prefs.providerDefaults[prefs.defaultProvider] ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Starts on {providerLabel(prefs.defaultProvider)} ·{' '}
                {models?.[prefs.defaultProvider]?.find(
                  (model) => model.id === prefs.providerDefaults[prefs.defaultProvider as Provider],
                )?.label ?? prefs.providerDefaults[prefs.defaultProvider]}
                .
              </p>
            ) : null}
            <label className="mt-4 flex items-center justify-between gap-3">
              <span className="font-medium">Default thinking</span>
              <select
                value={prefs.defaultEffort ?? ''}
                onChange={(event) => onChange({ ...prefs, defaultEffort: event.target.value || null })}
                className="rounded-xl border bg-card px-3 py-2 outline-none focus:border-ring"
              >
                <option value="">Provider default</option>
                {ALL_EFFORTS.map((level) => (
                  <option key={level} value={level}>
                    {level[0]!.toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Unsupported thinking levels fall back to the selected model's default.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Codex accounts: `codex login --device-auth`. Mirror image of the Claude card —
 * the code is entered on the WEBSITE (phone), nothing is pasted back, and the
 * CLI writes auth.json itself, so this polls for completion instead of taking
 * a code. Several subscriptions can be connected with one active; a sign-in
 * runs in a staging profile, so adding an account never signs another out.
 */
function CodexAccountCard({
  children,
  version,
  onInstalled,
}: {
  children?: ReactNode;
  version: ProviderRuntimeVersion | null | undefined;
  onInstalled: () => Promise<void>;
}) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ attemptId: string; verificationUrl: string; userCode: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<null | 'start' | 'disconnect' | 'install'>(null);
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [pollState, setPollState] = useState<CodexAttemptState | null>(null);
  const [signedIn, setSignedIn] = useState<CodexAccount | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);

  const attemptRef = useRef<typeof attempt>(null);
  attemptRef.current = attempt;

  const remaining = useCountdown(attempt?.expiresAt ?? null);
  const expired = attempt !== null && remaining <= 0;
  const connected = status?.connected ?? false;
  const installed = status?.installed ?? true;
  const accounts = status?.accounts ?? [];

  const loadStatus = useCallback(() => {
    api.codexStatus().then((s) => { setStatus(s); setLoadError(null); }).catch((err: Error) => setLoadError(err.message));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  // While an attempt is live, poll the backend until the CLI child finishes.
  useEffect(() => {
    if (!attempt || pollState === 'success') return;
    let stop = false;
    const iv = setInterval(async () => {
      try {
        const r = await api.codexConnectPoll(attempt.attemptId);
        if (stop) return;
        setPollState(r.state);
        if (r.state === 'success') {
          setAttempt(null);
          setSignedIn(r.account ?? null);
          if (r.accounts) setStatus((prev) => (prev ? { ...prev, accounts: r.accounts, connected: true } : prev));
          loadStatus();
        } else if (r.state === 'error' || r.state === 'expired' || r.state === 'no_attempt') {
          setAttempt(null);
          setFlowError(r.detail || 'Codex sign-in did not complete.');
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [attempt, pollState, loadStatus]);

  // Best-effort cancel of an in-flight attempt if the user leaves. The login
  // runs in a staging profile, so cancelling loses nothing already connected.
  useEffect(() => {
    return () => {
      const a = attemptRef.current;
      if (a) void api.codexConnectCancel(a.attemptId).catch(() => undefined);
    };
  }, []);

  const doStart = useCallback(async () => {
    setBusy('start');
    setFlowError(null);
    setPollState(null);
    setSignedIn(null);
    try {
      const r = await api.codexConnectStart();
      setAttempt({ attemptId: r.attemptId, verificationUrl: r.verificationUrl, userCode: r.userCode, expiresAt: r.expiresAt });
      setPollState('pending');
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const doInstall = useCallback(async () => {
    setBusy('install');
    setFlowError(null);
    try {
      await api.codexInstall();
      await onInstalled().catch(() => undefined);
      loadStatus();
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadStatus, onInstalled]);

  const cancelAttempt = useCallback(async () => {
    const a = attemptRef.current;
    setAttempt(null);
    setPollState(null);
    setFlowError(null);
    if (a) await api.codexConnectCancel(a.attemptId).catch(() => undefined);
    loadStatus();
  }, [loadStatus]);

  /** Run an account action and fold its fresh list back into status. */
  const accountAction = useCallback(
    async (id: string, run: () => Promise<{ accounts: CodexAccount[] }>) => {
      setAccountBusy(id);
      setFlowError(null);
      setSignedIn(null);
      try {
        const r = await run();
        setStatus((prev) => (prev ? { ...prev, accounts: r.accounts, connected: r.accounts.some((a) => a.active && a.connected) } : prev));
        loadStatus();
      } catch (err) {
        setFlowError((err as Error).message);
      } finally {
        setAccountBusy(null);
      }
    },
    [loadStatus],
  );

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    setFlowError(null);
    setSignedIn(null);
    try {
      await api.codexDisconnect();
      setConfirmLogout(false);
      loadStatus();
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadStatus]);

  const copyCode = useCallback(() => {
    const a = attemptRef.current;
    if (!a) return;
    void navigator.clipboard?.writeText(a.userCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  }, []);

  const sourceLine = (): string => {
    if (!installed) return "The Codex CLI isn't installed on this machine yet.";
    if (!connected && accounts.length === 0) return 'Connect a ChatGPT (Codex) subscription so your assistants can run on Codex.';
    if (status?.method === 'apikey') return 'Connected with an OpenAI API key.';
    if (accounts.length > 1) {
      return 'Several Codex subscriptions are connected. Pick which one answers; hit a usage limit and Veneer moves to the one with the most headroom.';
    }
    const acct = status?.account;
    if (acct?.email) {
      const plan = acct.plan ? ` · ${acct.plan.charAt(0).toUpperCase()}${acct.plan.slice(1)} plan` : '';
      return `Signed in as ${acct.email}${plan}.`;
    }
    return connected ? 'Connected with ChatGPT.' : 'The connected account is signed out. Connect again to keep using Codex.';
  };

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <ProviderIcon provider="codex" variant="color" className="size-5" />
          {accounts.length > 1 ? 'Codex accounts' : 'Codex account'}
        </CardTitle>
        <CardAction>
          {status ? (
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                connected ? 'bg-accent text-brand' : 'bg-destructive/10 text-destructive'
              }`}
            >
              {!installed
                ? 'Not installed'
                : connected
                  ? accounts.length > 1 ? `${accounts.length} connected` : 'Connected'
                  : 'Not connected'}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">…</span>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="text-sm">
        {loadError ? (
          <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{loadError}</div>
        ) : null}

        {!attempt ? <p className="text-muted-foreground">{sourceLine()}</p> : null}
        <ProviderVersionLine info={version} />

        {accounts.length > 0 && !attempt ? (
          <div className="mt-4">
            <ul className="flex flex-col gap-2">
              {accounts.map((account) => (
                <ProviderAccountRow
                  key={account.id}
                  account={account}
                  busy={accountBusy === account.id}
                  renaming={renaming?.id === account.id}
                  onRename={() => setRenaming({ id: account.id, label: account.label })}
                  onRenameChange={(label) => setRenaming({ id: account.id, label })}
                  onRenameCommit={(label) => {
                    setRenaming(null);
                    const next = label?.trim();
                    if (!next || next === account.label) return;
                    void accountAction(account.id, () => api.codexAccountRename(account.id, next));
                  }}
                  onActivate={() => void accountAction(account.id, () => api.codexAccountActivate(account.id))}
                  onRemove={() => void accountAction(account.id, () => api.codexAccountRemove(account.id))}
                  // Removing the last account would leave the assistant unable
                  // to answer; Disconnect below is the explicit way to do that.
                  removable={accounts.length > 1}
                />
              ))}
            </ul>
            {accounts.length > 1 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Switching applies to your next message. A reply already in progress finishes on the account it
                started with.
              </p>
            ) : null}
          </div>
        ) : null}

        {!attempt && pollState === 'success' ? (
          <div className="mt-4 flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-brand">
            <CheckCircle2 className="size-4 shrink-0" />
            {signedIn?.email ? `Signed in to Codex as ${signedIn.email}.` : 'Signed in to Codex.'}
          </div>
        ) : null}

        {flowError ? (
          <div className="mt-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{flowError}</div>
        ) : null}

        {attempt ? (
          <div className="mt-4 flex flex-col gap-2">
            <div className="overflow-hidden rounded-2xl border">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
                <p className="font-semibold">{accounts.length > 0 ? 'Add a Codex account in two steps' : 'Connect in two steps'}</p>
                <TimerPill remaining={remaining} />
              </div>
              {expired ? (
                <div className="p-4">
                  <div className="rounded-xl bg-amber-500/10 px-4 py-2.5 text-amber-700 dark:text-amber-300">
                    This code expired. Tap Start over to get a fresh one.
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-3.5 p-4">
                    <StepMarker number={1} state="active" />
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                      <div>
                        <p className="font-medium">Open the sign-in link</p>
                        {accounts.length > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            Sign in with the other ChatGPT account there. Accounts already connected stay signed in.
                          </p>
                        ) : null}
                      </div>
                      <Button asChild className="h-10 max-w-full self-start rounded-xl px-5">
                        <a href={attempt.verificationUrl} target="_blank" rel="noopener noreferrer">
                          {attempt.verificationUrl.replace(/^https:\/\//, '')}
                          <ArrowRight />
                        </a>
                      </Button>
                    </div>
                  </div>
                  <div className="flex gap-3.5 border-t p-4">
                    <StepMarker number={2} state="todo" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                      <p className="font-medium">Enter this one-time code</p>
                      <button
                        type="button"
                        onClick={copyCode}
                        className="w-full rounded-xl border bg-muted/40 py-3 text-center font-mono text-2xl tracking-[0.3em] text-brand hover:bg-muted"
                      >
                        {attempt.userCode}
                      </button>
                      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{copied ? 'Copied!' : 'Tap the code to copy.'}</span>
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2 className="size-3.5 shrink-0 animate-spin" />
                          Waiting for you to authorize…
                        </span>
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onPointerUp={() => void doStart()}
                disabled={busy === 'start'}
              >
                {busy === 'start' ? 'Starting…' : 'Start over'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onPointerUp={() => void cancelAttempt()}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : !installed ? (
          <div className="mt-4">
            <Button className="h-10 rounded-xl px-5" onPointerUp={() => void doInstall()} disabled={busy === 'install'}>
              {busy === 'install' ? 'Installing…' : 'Install Codex'}
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button className="h-10 rounded-xl px-5" onPointerUp={() => void doStart()} disabled={busy === 'start'}>
              {busy === 'start' ? (
                'Starting…'
              ) : (
                <>
                  {accounts.length > 0 ? 'Add another account' : 'Connect Codex'}
                  {accounts.length === 0 ? <ArrowRight /> : null}
                </>
              )}
            </Button>
            {accounts.length > 0 ? (
              <Button
                variant="ghost"
                className="h-9 rounded-xl px-3 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive"
                onPointerUp={() => setConfirmLogout(true)}
              >
                {accounts.length > 1 ? 'Disconnect all' : 'Disconnect'}
              </Button>
            ) : null}
          </div>
        )}
        {children}
      </CardContent>

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{accounts.length > 1 ? 'Disconnect every Codex account?' : 'Disconnect Codex?'}</DialogTitle>
            <DialogDescription>
              {accounts.length > 1
                ? "Removes this machine's credentials for all connected Codex accounts. You can connect them again anytime."
                : "Removes this machine's Codex credentials. You can connect again anytime."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={() => setConfirmLogout(false)}>
              Keep connected
            </Button>
            <Button variant="destructive" className="h-11 flex-1 rounded-xl" onPointerUp={() => void disconnect()} disabled={busy === 'disconnect'}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Grok account card — the same device-code flow as CodexAccountCard: the code
 * is confirmed on the WEBSITE (phone), nothing is pasted back, and the CLI
 * writes its own auth.json, so this polls for completion.
 *
 * Unlike Codex, starting a Grok sign-in does NOT wipe the current login (probed
 * against grok 1.0.3 alpha with a sentinel auth.json), so there is no
 * destructive-reconnect hazard here — reconnecting just asks for a plain
 * confirmation, and the existing account keeps working until the new sign-in
 * lands.
 */
function GrokAccountCard({
  children,
  version,
  onInstalled,
}: {
  children?: ReactNode;
  version: ProviderRuntimeVersion | null | undefined;
  onInstalled: () => Promise<void>;
}) {
  const [status, setStatus] = useState<GrokStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ attemptId: string; verificationUrl: string; userCode: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<null | 'start' | 'disconnect' | 'install'>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [pollState, setPollState] = useState<GrokAttemptState | null>(null);
  const [confirmReconnect, setConfirmReconnect] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);

  const attemptRef = useRef<typeof attempt>(null);
  attemptRef.current = attempt;

  const remaining = useCountdown(attempt?.expiresAt ?? null);
  const expired = attempt !== null && remaining <= 0;
  const connected = status?.connected ?? false;
  const installed = status?.installed ?? true;

  const loadStatus = useCallback(() => {
    api.grokStatus().then((s) => { setStatus(s); setLoadError(null); }).catch((err: Error) => setLoadError(err.message));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  // While an attempt is live, poll the backend until the CLI child finishes.
  useEffect(() => {
    if (!attempt || pollState === 'success') return;
    let stop = false;
    const iv = setInterval(async () => {
      try {
        const r = await api.grokConnectPoll(attempt.attemptId);
        if (stop) return;
        setPollState(r.state);
        if (r.state === 'success') {
          setAttempt(null);
          loadStatus();
        } else if (r.state === 'error' || r.state === 'expired' || r.state === 'no_attempt') {
          setAttempt(null);
          setFlowError(r.detail || 'Grok sign-in did not complete.');
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [attempt, pollState, loadStatus]);

  // Best-effort cancel of an in-flight attempt if the user leaves. Safe here:
  // an abandoned Grok attempt leaves the existing login untouched.
  useEffect(() => {
    return () => {
      const a = attemptRef.current;
      if (a) void api.grokConnectCancel(a.attemptId).catch(() => undefined);
    };
  }, []);

  const doStart = useCallback(async (force: boolean) => {
    setBusy('start');
    setFlowError(null);
    setPollState(null);
    setConfirmReconnect(false);
    try {
      const r = await api.grokConnectStart(force);
      setAttempt({ attemptId: r.attemptId, verificationUrl: r.verificationUrl, userCode: r.userCode, expiresAt: r.expiresAt });
      setPollState('pending');
    } catch (err) {
      // The server sends 409 already_connected as an Error with that message.
      if (/already signed in/i.test((err as Error).message)) setConfirmReconnect(true);
      else setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const startConnect = useCallback(() => {
    if (connected) setConfirmReconnect(true);
    else void doStart(false);
  }, [connected, doStart]);

  const doInstall = useCallback(async () => {
    setBusy('install');
    setFlowError(null);
    try {
      await api.grokInstall();
      await onInstalled().catch(() => undefined);
      loadStatus();
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadStatus, onInstalled]);

  const cancelAttempt = useCallback(async () => {
    const a = attemptRef.current;
    setAttempt(null);
    setPollState(null);
    setFlowError(null);
    if (a) await api.grokConnectCancel(a.attemptId).catch(() => undefined);
    loadStatus();
  }, [loadStatus]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    setFlowError(null);
    try {
      await api.grokDisconnect();
      setConfirmLogout(false);
      loadStatus();
    } catch (err) {
      setFlowError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadStatus]);

  const copyCode = useCallback(() => {
    const a = attemptRef.current;
    if (!a) return;
    void navigator.clipboard?.writeText(a.userCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  }, []);

  const sourceLine = (): string => {
    if (!installed) return "The Grok CLI isn't installed on this machine yet.";
    if (!connected) return 'Connect an xAI (Grok) subscription so your assistants can run on Grok.';
    if (status?.method === 'apikey') return 'Connected with an xAI API key.';
    const acct = status?.account;
    const who = acct?.handle ? `@${acct.handle.replace(/^@/, '')}` : acct?.email;
    if (who) {
      const plan = acct?.plan ? ` · ${acct.plan.charAt(0).toUpperCase()}${acct.plan.slice(1)} plan` : '';
      return `Signed in as ${who}${plan}.`;
    }
    return 'Connected with an xAI account.';
  };

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <ProviderIcon provider="grok" variant="color" className="size-5" />
          Grok account
        </CardTitle>
        <CardAction>
          {status ? (
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                connected ? 'bg-accent text-brand' : 'bg-destructive/10 text-destructive'
              }`}
            >
              {!installed ? 'Not installed' : connected ? 'Connected' : 'Not connected'}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">…</span>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="text-sm">
        {loadError ? (
          <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{loadError}</div>
        ) : null}

        {!attempt && !confirmReconnect ? <p className="text-muted-foreground">{sourceLine()}</p> : null}
        <ProviderVersionLine info={version} />

        {!attempt && pollState === 'success' ? (
          <div className="mt-4 flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-brand">
            <CheckCircle2 className="size-4 shrink-0" /> Signed in to Grok.
          </div>
        ) : null}

        {flowError ? (
          <div className="mt-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{flowError}</div>
        ) : null}

        {attempt ? (
          <div className="mt-4 flex flex-col gap-2">
            <div className="overflow-hidden rounded-2xl border">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
                <p className="font-semibold">Connect in two steps</p>
                <TimerPill remaining={remaining} />
              </div>
              {expired ? (
                <div className="p-4">
                  <div className="rounded-xl bg-amber-500/10 px-4 py-2.5 text-amber-700 dark:text-amber-300">
                    This code expired. Tap Start over to get a fresh one.
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-3.5 p-4">
                    <StepMarker number={1} state="active" />
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                      <div>
                        <p className="font-medium">Open the sign-in link</p>
                      </div>
                      <Button asChild className="h-10 max-w-full self-start rounded-xl px-5">
                        <a href={attempt.verificationUrl} target="_blank" rel="noopener noreferrer">
                          <span className="truncate">{attempt.verificationUrl.replace(/^https:\/\//, '').split('?')[0]}</span>
                          <ArrowRight />
                        </a>
                      </Button>
                    </div>
                  </div>
                  <div className="flex gap-3.5 border-t p-4">
                    <StepMarker number={2} state="todo" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                      <p className="font-medium">Confirm this code</p>
                      <button
                        type="button"
                        onClick={copyCode}
                        className="w-full rounded-xl border bg-muted/40 py-3 text-center font-mono text-2xl tracking-[0.3em] text-brand hover:bg-muted"
                      >
                        {attempt.userCode}
                      </button>
                      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{copied ? 'Copied!' : 'Tap the code to copy.'}</span>
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2 className="size-3.5 shrink-0 animate-spin" />
                          Waiting for you to authorize…
                        </span>
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onPointerUp={() => void doStart(true)}
                disabled={busy === 'start'}
              >
                {busy === 'start' ? 'Starting…' : 'Start over'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onPointerUp={() => void cancelAttempt()}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : confirmReconnect ? (
          <div className="mt-4 flex flex-col gap-3">
            <div className="rounded-xl bg-muted/40 px-4 py-2.5 text-muted-foreground">
              Grok is already signed in. Signing in again switches this machine to the new account — the current one
              keeps working until you finish.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="h-10 rounded-xl px-5" onPointerUp={() => void doStart(true)} disabled={busy === 'start'}>
                {busy === 'start' ? 'Starting…' : 'Sign in again'}
              </Button>
              <Button variant="outline" className="h-10 rounded-xl px-5" onPointerUp={() => setConfirmReconnect(false)}>
                Keep current
              </Button>
            </div>
          </div>
        ) : !installed ? (
          <div className="mt-4">
            <Button className="h-10 rounded-xl px-5" onPointerUp={() => void doInstall()} disabled={busy === 'install'}>
              {busy === 'install' ? 'Installing…' : 'Install Grok'}
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button className="h-10 rounded-xl px-5" onPointerUp={startConnect} disabled={busy === 'start'}>
              {busy === 'start' ? (
                'Starting…'
              ) : (
                <>
                  {connected ? 'Reconnect' : 'Connect Grok'}
                  {!connected ? <ArrowRight /> : null}
                </>
              )}
            </Button>
            {connected ? (
              <Button
                variant="ghost"
                className="h-9 rounded-xl px-3 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive"
                onPointerUp={() => setConfirmLogout(true)}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        )}
        {children}
      </CardContent>

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Disconnect Grok?</DialogTitle>
            <DialogDescription>Removes this machine's Grok credentials. You can connect again anytime.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={() => setConfirmLogout(false)}>
              Keep connected
            </Button>
            <Button variant="destructive" className="h-11 flex-1 rounded-xl" onPointerUp={() => void disconnect()} disabled={busy === 'disconnect'}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const SECTION_TITLE: Record<Provider, string> = {
  claude: 'Models',
  openrouter: 'Configured models',
  codex: 'Codex models',
  grok: 'Grok models',
};

/**
 * One provider's model list, rendered inside that provider's account card.
 * The grip drag-reorders models — the saved order (ModelPrefs.modelOrder) is
 * what every model picker in the app uses. The star sets the provider's default
 * model (tap again to unset — the CLI then picks); the eyeball hides a model
 * from the new-chat picker. A hidden model can stay the default: the picker's
 * "Default" entry still uses it.
 *
 * Reordering is hand-rolled pointer events (no dnd dependency), mirroring the
 * queued-message reorder in Chat.tsx: a per-row grip owns the gesture so
 * star/eye taps stay clean. `rows` is a working copy that re-sorts live during
 * the drag and re-syncs from props once a saved reorder reconciles.
 */
function ModelSection({
  provider,
  models,
  prefs,
  onDefault,
  onHide,
  onReorder,
  onRemove,
}: {
  provider: Provider;
  models: ModelOption[] | null;
  prefs: ModelPrefs | null;
  onDefault: (provider: Provider, model: string | null) => void;
  onHide: (provider: Provider, model: string) => void;
  onReorder: (provider: Provider, ids: string[]) => void;
  onRemove?: (provider: Provider, model: string) => void;
}) {
  const ordered = models && prefs ? orderModels(provider, models, prefs.modelOrder) : (models ?? []);
  const signature = ordered.map((m) => m.id).join(',');
  const [rows, setRows] = useState<ModelOption[]>(ordered);
  const [dragId, setDragId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<string | null>(null);

  // Adopt the incoming order on load / after a saved reorder reconciles, but
  // never mid-drag — that would stomp the gesture in progress.
  useEffect(() => {
    if (dragRef.current) return;
    setRows(ordered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const onGripDown = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = id;
    setDragId(id);
  };
  const onGripMove = (e: React.PointerEvent) => {
    const id = dragRef.current;
    if (!id) return;
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-mid]') ?? []);
    const y = e.clientY;
    let target = els.length - 1;
    for (let i = 0; i < els.length; i++) {
      const r = els[i]!.getBoundingClientRect(); // i is bounded by els.length
      if (y < r.top + r.height / 2) {
        target = i;
        break;
      }
    }
    setRows((prev) => {
      const cur = prev.findIndex((m) => m.id === id);
      if (cur === -1 || cur === target) return prev;
      const next = [...prev];
      const [it] = next.splice(cur, 1);
      if (!it) return prev; // cur !== -1 checked above, so this always holds
      next.splice(target, 0, it);
      return next;
    });
  };
  const onGripUp = (e: React.PointerEvent) => {
    const wasDragging = dragRef.current !== null;
    dragRef.current = null;
    setDragId(null);
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (!wasDragging) return;
    const ids = rows.map((m) => m.id);
    if (ids.join(',') !== signature) onReorder(provider, ids); // only persist a real change
  };

  return (
    <div className="mt-5 border-t pt-4">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {SECTION_TITLE[provider]}
      </p>
      {models === null || !prefs ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">No models listed — connect the account first.</p>
      ) : (
        <div ref={listRef} className="flex flex-col">
          {rows.map((m) => {
            const hidden = prefs.hiddenModels.includes(modelKey(provider, m.id));
            const isDefault = prefs.providerDefaults[provider] === m.id;
            return (
              <div
                key={m.id}
                data-mid={m.id}
                className={`flex items-center gap-1 rounded-xl ${dragId === m.id ? 'bg-accent' : ''}`}
              >
                <button
                  type="button"
                  onPointerDown={(e) => onGripDown(e, m.id)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  aria-label={`Drag to reorder ${m.label}`}
                  className="flex h-11 w-7 shrink-0 touch-none cursor-grab items-center justify-center text-muted-foreground/40 active:cursor-grabbing"
                >
                  <GripVertical className="size-4" />
                </button>
                <button
                  type="button"
                  onPointerUp={() => onDefault(provider, isDefault && provider !== 'openrouter' ? null : m.id)}
                  aria-pressed={isDefault}
                  aria-label={
                    isDefault && provider !== 'openrouter'
                      ? `Unset ${m.label} as default model`
                      : `Make ${m.label} the default model`
                  }
                  className={`flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 text-left active:bg-accent ${
                    hidden ? 'text-muted-foreground/60' : ''
                  }`}
                >
                  <Star
                    className={`size-4 shrink-0 ${isDefault ? 'fill-brand text-brand' : 'text-muted-foreground/40'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.label}</span>
                    {provider === 'openrouter' && m.label !== m.id ? (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{m.id}</span>
                    ) : null}
                  </span>
                  {isDefault ? <span className="shrink-0 text-xs font-medium text-brand">Default</span> : null}
                </button>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
                  onPointerUp={() => onHide(provider, m.id)}
                  aria-label={hidden ? `Show ${m.label} in the picker` : `Hide ${m.label} from the picker`}
                  aria-pressed={hidden}
                >
                  {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                {onRemove ? (
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    className="h-11 w-11 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
                    onPointerUp={() => onRemove(provider, m.id)}
                    aria-label={`Remove ${m.label}`}
                    disabled={rows.length <= 1}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
