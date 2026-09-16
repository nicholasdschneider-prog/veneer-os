import { useEffect, useState } from 'react';
import { api, type ModelOption, type ModelPrefs, type UsageResponse } from '@/lib/api';
import { modelKey, orderModels, PROVIDERS, providerLabel, type Provider } from '@/lib/modelLabel';
import { ProviderIcon } from '@/components/ProviderIcon';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type ProviderModels = Record<Provider, ModelOption[]>;

// Only use member-readable data here. Credential and connection controls live
// in AccountsPage, which is mounted for administrators only.
export function MemberProvidersPage() {
  const [data, setData] = useState<{ prefs: ModelPrefs; models: ProviderModels; usage: UsageResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.modelPrefs(),
      api.usage(),
      Promise.all(PROVIDERS.map(async (provider) => [provider, (await api.models(provider)).models] as const)),
    ]).then(([{ prefs }, usage, models]) => {
      if (active) setData({ prefs, usage, models: Object.fromEntries(models) as ProviderModels });
    }).catch((err: Error) => {
      if (active) setError(err.message);
    });
    return () => { active = false; };
  }, []);

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading providers…</p>;
  return <MemberProviderCards {...data} />;
}

export function MemberProviderCards({ prefs, models, usage }: {
  prefs: ModelPrefs;
  models: ProviderModels;
  usage: UsageResponse;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        New chats default to {providerLabel(prefs.defaultProvider)}. Default thinking: {prefs.defaultEffort ?? 'Provider default'}.
      </p>
      {PROVIDERS.map((provider) => {
        const status = provider === 'openrouter' ? usage.openrouter : usage.providers[provider];
        const accounts = provider === 'claude' ? usage.providers.claude.accounts : undefined;
        const rows = orderModels(provider, models[provider], prefs.modelOrder);
        return (
          <Card key={provider}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ProviderIcon provider={provider} variant="color" className="size-5" />
                {providerLabel(provider)}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {status ? (status.connected ? 'Connected' : 'Not connected') : 'Status unavailable'}
              </p>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {accounts?.length ? (
                <ul className="space-y-1">
                  {accounts.map((account) => (
                    <li key={account.accountId}>
                      {account.label}{account.accountEmail ? ` · ${account.accountEmail}` : ''}
                      {account.planType ? ` · ${account.planType}` : ''}{account.active ? ' · Active' : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="font-medium">Models</p>
              {rows.length ? (
                <ul className="divide-y">
                  {rows.map((model) => (
                    <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{model.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {[
                          prefs.providerDefaults[provider] === model.id ? 'Default' : null,
                          prefs.hiddenModels.includes(modelKey(provider, model.id)) ? 'Hidden from picker' : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground">No models available.</p>}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
