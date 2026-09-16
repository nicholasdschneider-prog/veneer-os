import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { api, type ApiKeyStatus } from '../../lib/api';
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
import { SaveStatus } from './SettingsPrimitives';

/**
 * Settings → Credentials. Each managed key resolves local override → client
 * Doppler → legacy server environment. The raw key is never sent back — the
 * server returns only whether it's set, where it comes from, and a masked
 * last-4 hint. Saving a blank value removes the local override.
 */
export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .apiKeys()
      .then((r) => {
        setKeys(r.keys);
        setLoadError(null);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);
  useEffect(load, [load]);
  const filter = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('filter');
  const visibleKeys =
    filter === 'voice' ? keys?.filter((key) => key.id === 'soniox') : keys;

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-sm text-muted-foreground">
        {filter === 'voice'
          ? 'Voice uses the Soniox key below. Set an override or leave the workspace credential in place.'
          : "Keys normally come from this client's Doppler project. Set your own to override; clear it to return to Doppler or the legacy server fallback."}
      </p>

      {loadError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{loadError}</div>
      ) : null}

      {keys === null && !loadError ? (
        <p className="px-1 text-sm text-muted-foreground">Loading…</p>
      ) : null}

      {visibleKeys?.map((k) => (
        <ApiKeyCard key={k.id} status={k} onChanged={setKeys} />
      ))}
    </div>
  );
}

const SOURCE_BADGE: Record<'override' | 'doppler' | 'default' | 'none', { label: string; cls: string }> = {
  override: { label: 'Custom key', cls: 'bg-accent text-brand' },
  doppler: { label: 'Client Doppler', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  default: { label: 'Using default', cls: 'bg-accent text-brand' },
  none: { label: 'Not set', cls: 'bg-destructive/10 text-destructive' },
};

export function ApiKeyCard({
  status,
  onChanged,
}: {
  status: ApiKeyStatus;
  onChanged: (keys: ApiKeyStatus[]) => void;
}) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'clear'>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const badge = SOURCE_BADGE[status.source ?? 'none'];

  const save = useCallback(async () => {
    if (!value.trim()) return;
    setBusy('save');
    setError(null);
    setSaved(false);
    try {
      const r = await api.setApiKey(status.id, value.trim());
      onChanged(r.keys);
      setValue('');
      setReveal(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [value, status.id, onChanged]);

  const clear = useCallback(async () => {
    setBusy('clear');
    setError(null);
    setSaved(false);
    try {
      const r = await api.setApiKey(status.id, '');
      onChanged(r.keys);
      setValue('');
      setReveal(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [status.id, onChanged]);

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{status.label}</CardTitle>
        <CardDescription>{status.description}</CardDescription>
        <CardAction>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${badge.cls}`}>
            {badge.label}
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="text-sm">
        <p className="text-muted-foreground">
          {status.source === 'override'
            ? `Using your custom key${status.hint ? ` (ending ${status.hint})` : ''}.`
            : status.source === 'doppler'
              ? `Using this client's Doppler secret${status.hint ? ` (ending ${status.hint})` : ''}.`
              : status.source === 'default'
                ? `Using the legacy server default${status.hint ? ` (ending ${status.hint})` : ''}.`
              : 'No key is set — this feature is disabled until you add one.'}
        </p>

        {error ? (
          <div className="mt-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{error}</div>
        ) : null}

        {saved ? (
          <div className="mt-4 rounded-xl bg-accent px-4 py-2.5">
            <SaveStatus />
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-2">
          <div className="relative">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type={reveal ? 'text' : 'password'}
              placeholder={status.source === 'override' ? 'Replace with a new key' : 'Paste a key to override'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              className="h-12 rounded-xl px-4 pr-12 text-base md:text-base"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="absolute right-1 top-1 h-10 w-10 rounded-full text-muted-foreground"
              onPointerUp={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide key' : 'Show key'}
              tabIndex={-1}
            >
              {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
          <Button
            className="h-12 rounded-xl text-base"
            onPointerUp={() => void save()}
            disabled={!value.trim() || busy !== null}
          >
            {busy === 'save' ? 'Saving…' : 'Save key'}
          </Button>
          {status.source === 'override' ? (
            <Button
              variant="ghost"
              className="h-12 rounded-xl text-base text-destructive hover:bg-destructive/10 hover:text-destructive"
              onPointerUp={() => void clear()}
              disabled={busy !== null}
            >
              {busy === 'clear' ? 'Reverting…' : 'Remove custom key (use default)'}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
