import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import type { ModelOption } from '../../lib/api';
import {
  effortOptionsFor,
  modelKey,
  orderModels,
  PROVIDERS,
  providerLabel,
  stripProviderPrefix,
  type Provider,
} from '../../lib/modelLabel';
import { modelTier } from '../../lib/modelTier';
import { ProviderIcon } from '@/components/ProviderIcon';
import { CapabilityDots } from '@/components/chat/CapabilityDots';
import { effortLabel, ThinkingLevelControl } from '@/components/chat/ThinkingLevelControl';
import { AccountSwitcher } from '@/components/chat/AccountSwitcher';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export { effortLabel };

export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

export interface ModelChoice {
  provider: Provider;
  /** Empty means the configured provider default. */
  model: string;
  label: string;
  short: string | null;
  efforts: string[] | null;
  isDefault?: boolean;
  /** Capability tier 1–4 for the dots, null when unknown. */
  tier: number | null;
}

export interface ModelThinkingValue {
  provider: Provider;
  model: string;
  /** Empty means the provider default. */
  effort: string;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function stripModelBrand(label: string, provider: Provider): string {
  const prefix = `${providerLabel(provider)} · `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

/** The shared model list used by the chat composer and automation editor. */
export function buildModelChoices(
  all: Record<Provider, ModelOption[]>,
  hidden: string[],
  providerDefaults: Record<string, string | null>,
  modelOrder: Record<string, string[]>,
): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const provider of PROVIDERS) {
    const defaultId = providerDefaults[provider];
    const defaultOption = defaultId
      ? all[provider].find((model) => model.id === defaultId)
      : all[provider].find((model) => model.isDefault);
    const models = orderModels(provider, all[provider], modelOrder)
      .filter((model) => !hidden.includes(modelKey(provider, model.id)));
    const defaultIsVisible = Boolean(defaultOption && models.some((model) => model.id === defaultOption.id));
    if (!defaultIsVisible) {
      const rawLabel = defaultOption?.label ?? defaultId ?? null;
      const short = rawLabel ? stripProviderPrefix(rawLabel, provider) : null;
      choices.push({
        provider,
        model: '',
        label: `${providerLabel(provider)} · ${short ? `Default (${short})` : 'Default'}`,
        short,
        efforts: defaultOption?.efforts ?? null,
        isDefault: true,
        tier: modelTier(provider, defaultOption?.id ?? defaultId ?? ''),
      });
    }
    for (const model of models) {
      const short = stripProviderPrefix(model.label, provider);
      const isDefault = defaultIsVisible && model.id === defaultOption!.id;
      choices.push({
        provider,
        model: isDefault ? '' : model.id,
        label: `${providerLabel(provider)} · ${short}`,
        short,
        efforts: model.efforts ?? null,
        isDefault,
        tier: modelTier(provider, model.id),
      });
    }
    if (provider === 'claude' && all[provider].length === 0) {
      for (const alias of CLAUDE_ALIASES) {
        const short = capitalize(alias);
        choices.push({
          provider,
          model: alias,
          label: `Claude · ${short}`,
          short,
          efforts: null,
          tier: modelTier(provider, alias),
        });
      }
    }
  }
  return choices;
}

/** Existing chats select concrete model IDs, including the provider default. */
export function buildExistingChatModelChoices(
  all: Record<Provider, ModelOption[]>, hidden: string[], modelOrder: Record<string, string[]>,
): ModelChoice[] {
  return PROVIDERS.flatMap((provider) => orderModels(provider, all[provider], modelOrder)
    .filter((model) => !hidden.includes(modelKey(provider, model.id)))
    .map((model) => ({
      provider, model: model.id, label: model.label,
      short: stripProviderPrefix(model.label, provider), efforts: model.efforts ?? null,
      isDefault: model.isDefault, tier: modelTier(provider, model.id),
    })));
}

/**
 * Segmented provider switcher. The dialog is ~360px wide, so with more than
 * three providers only the active tab shows its name; the rest collapse to
 * their brand glyph.
 */
export function ProviderTabs({
  providers,
  value,
  onChange,
}: {
  providers: Provider[];
  value: Provider;
  onChange: (provider: Provider) => void;
}) {
  const iconOnlyInactive = providers.length > 3;
  return (
    <div role="tablist" aria-label="Provider" className="flex gap-0.5 rounded-xl bg-muted p-[3px]">
      {providers.map((provider) => {
        const active = provider === value;
        return (
          <button
            key={provider}
            type="button"
            role="tab"
            aria-selected={active}
            title={providerLabel(provider)}
            onPointerUp={() => onChange(provider)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-1.5 py-1.5 text-[13px] font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
            {active || !iconOnlyInactive ? <span>{providerLabel(provider)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** One model row: name, capability dots, and the Default pill. */
export function ModelRow({
  name,
  tier,
  isDefault,
  selected,
  disabled,
  onPick,
}: {
  name: string;
  tier: number | null;
  isDefault?: boolean;
  selected: boolean;
  disabled?: boolean;
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onPointerUp={onPick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm font-medium transition-colors',
        selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <CapabilityDots tier={tier} />
      {isDefault ? (
        <span className="shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Default
        </span>
      ) : null}
    </button>
  );
}

export function ModelThinkingPicker({
  open,
  onOpenChange,
  choices,
  value,
  defaultEffort,
  onChange,
  title = 'Agent model',
  description, onApply, busy = false, error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: ModelChoice[] | null;
  value: ModelThinkingValue;
  defaultEffort: string | null;
  onChange: (value: ModelThinkingValue) => void;
  title?: string;
  description?: string;
  onApply?: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [tab, setTab] = useState<Provider>(value.provider);

  useEffect(() => {
    if (open) setTab(value.provider);
  }, [open, value.provider]);

  const providers = PROVIDERS.filter((provider) =>
    (choices ?? []).some((choice) => choice.provider === provider),
  );
  const rows = (choices ?? []).filter((choice) => choice.provider === tab);
  const selected = choices?.find(
    (choice) => choice.provider === value.provider && choice.model === value.model,
  );
  const levels = ['', ...effortOptionsFor(value.provider, selected?.efforts)];

  const pick = (choice: ModelChoice) => {
    // Effort vocabularies differ per provider AND per model (GPT-5.6):
    // crossing providers re-applies the Settings default; within a provider a
    // pick the new model doesn't support falls back to its default.
    const vocabulary = effortOptionsFor(choice.provider, choice.efforts);
    const effort =
      choice.provider !== value.provider
        ? vocabulary.includes(defaultEffort ?? '') ? defaultEffort! : ''
        : value.effort && !vocabulary.includes(value.effort) ? '' : value.effort;
    onChange({ provider: choice.provider, model: choice.model, effort });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
          {providers.length > 1 ? (
            <ProviderTabs providers={providers} value={tab} onChange={setTab} />
          ) : null}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Model</p>
            <div
              role="radiogroup"
              aria-label="Model"
              className="flex max-h-[45dvh] flex-col gap-0.5 overflow-y-auto"
            >
              {rows.map((choice) => (
                <ModelRow
                  key={`${choice.provider}|${choice.model}`}
                  name={stripModelBrand(choice.label, choice.provider)}
                  tier={choice.tier}
                  isDefault={choice.isDefault}
                  selected={choice.provider === value.provider && choice.model === value.model}
                  onPick={() => pick(choice)}
                />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Thinking</p>
            <ThinkingLevelControl
              levels={levels}
              value={value.effort}
              onChange={(effort) => onChange({ ...value, effort })}
            />
          </div>
          <AccountSwitcher provider={tab} />
        </fieldset>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {onApply ? <Button disabled={busy || !choices?.some((choice) => choice.provider === value.provider && choice.model === value.model)} onClick={onApply}>{busy ? 'Switching…' : 'Use model'}</Button> : null}
      </DialogContent>
    </Dialog>
  );
}
