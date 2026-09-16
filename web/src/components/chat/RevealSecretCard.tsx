import { useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import type { ChatItem } from '@/lib/transcript';
import { Button } from '@/components/ui/button';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent } from '@/components/ui/message';
import { targetLocation } from './SecretCard';

type QuestionItem = Extract<ChatItem, { kind: 'question' }>;

/** Fixed-width mask so the rendered value's length is not a hint either. */
const MASK = '••••••••••••••••';

/** The user chatted instead, or pressed Dismiss on the card. */
function wasDismissed(item: QuestionItem): boolean {
  if (item.status === 'dismissed') return true;
  const first = item.questions[0];
  return Boolean(first && (item.answers?.[first.id] ?? []).includes('dismissed'));
}

/** The revealed row. Split out so it can be asserted without a DOM test env. */
export function RevealedSecretValue({
  name,
  value,
  unmasked,
  copied,
  onToggle,
  onCopy,
}: {
  name: string;
  value: string;
  unmasked: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2">
      <KeyRound aria-hidden="true" className="size-3.5 shrink-0 text-ring" />
      <span data-testid="reveal-secret-value" className="min-w-0 flex-1 font-mono text-base break-all sm:text-sm">
        {unmasked ? value : MASK}
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-pressed={unmasked}
        aria-label={unmasked ? `Hide ${name}` : `Show ${name}`}
        onClick={onToggle}
      >
        {unmasked ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
      </Button>
      <Button type="button" size="icon" variant="ghost" aria-label={`Copy ${name}`} onClick={onCopy}>
        {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
      </Button>
    </div>
  );
}

/**
 * reveal_secret's card. The agent only learns 'shown' or 'dismissed'; the value
 * is fetched straight from the server into this component's state and is never
 * persisted, so a chat reload shows the Reveal button again.
 */
export function RevealSecretCard({ item }: { item: QuestionItem }) {
  const [value, setValue] = useState<string | null>(null);
  const [unmasked, setUnmasked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const question = item.questions[0];
  const secret = question?.secret;
  if (!question || !secret) return null;

  const dismissed = wasDismissed(item);
  const location = targetLocation(secret);

  const reveal = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.revealSecretValue(item.requestId).then(
      (result) => {
        setValue(result.value);
        setBusy(false);
      },
      (reason: Error) => {
        setError(reason.message);
        setBusy(false);
      },
    );
  };

  const dismiss = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.dismissReveal(item.requestId).then(
      () => setBusy(false),
      (reason: Error) => {
        setError(reason.message);
        setBusy(false);
      },
    );
  };

  const copy = () => {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Message>
      <MessageContent>
        <Bubble variant="outline" className="w-full max-w-full">
          <BubbleContent className="w-full space-y-3 rounded-lg border-border/50 p-3 [--secret-card-bg:color-mix(in_oklch,var(--background),var(--foreground)_4%)] bg-(--secret-card-bg)!">
            <div className="space-y-1">
              <p className="text-[0.9375rem] font-medium text-pretty text-foreground sm:text-[0.8125rem]">
                {question.question}
              </p>
              <p className="text-sm text-pretty text-muted-foreground sm:text-[0.8125rem]">
                <code className="font-mono text-foreground">{secret.name}</code>
                {location ? ` in ${location}` : ' in the connected Doppler config'}
              </p>
              {dismissed ? null : (
                <p className="text-sm text-muted-foreground sm:text-[0.8125rem]">
                  Shown to you only — the agent never receives the value.
                </p>
              )}
            </div>

            {dismissed ? (
              <p className="text-sm text-muted-foreground sm:text-[0.8125rem]">Dismissed.</p>
            ) : value === null ? (
              <>
                {error ? (
                  <p className="text-sm text-pretty text-destructive" role="alert">{error}</p>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={dismiss}>
                    Dismiss
                  </Button>
                  <Button type="button" size="sm" disabled={busy} onClick={reveal}>
                    Reveal
                  </Button>
                </div>
              </>
            ) : (
              <RevealedSecretValue
                name={secret.name}
                value={value}
                unmasked={unmasked}
                copied={copied}
                onToggle={() => setUnmasked((current) => !current)}
                onCopy={copy}
              />
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

export { wasDismissed };
