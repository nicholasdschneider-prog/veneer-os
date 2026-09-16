import { useState, type CSSProperties, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { api } from '@/lib/api';
import type { ChatItem } from '@/lib/transcript';
import type { QuestionSecretTarget } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent } from '@/components/ui/message';

type QuestionItem = Extract<ChatItem, { kind: 'question' }>;

/** Doppler holds the value; the agent only ever learns where it landed. */
function targetLocation(secret: QuestionSecretTarget): string | null {
  if (!secret.project && !secret.config) return null;
  return [secret.project, secret.config].filter(Boolean).join(' / ');
}

/** A textarea keeps a trailing newline when the value is pasted with one. */
function normalizeSecretValue(value: string): string {
  return value.replace(/\n$/, '');
}

export function SecretCard({ item }: { item: QuestionItem }) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const question = item.questions[0];
  const secret = question?.secret;
  if (!question || !secret) return null;
  if (item.status === 'dismissed') return null;

  const pending = item.status === 'pending';
  const location = targetLocation(secret);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = normalizeSecretValue(value);
    if (busy || !trimmed.trim()) return;
    setBusy(true);
    setError(null);
    // The card stays busy until question_answered flips the item's status;
    // the value is dropped from state only once Doppler has it, so a failed
    // save does not force a re-paste.
    api.saveSecret(item.requestId, trimmed).then(
      () => setValue(''),
      (reason: Error) => {
        setError(reason.message);
        setBusy(false);
      },
    );
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
              {pending ? (
                <>
                  <p className="text-sm text-pretty text-muted-foreground sm:text-[0.8125rem]">
                    Will be saved as <code className="font-mono text-foreground">{secret.name}</code>
                    {location ? ` in ${location}` : ' in the connected Doppler config'}
                  </p>
                  {secret.exists ? (
                    <p className="text-sm text-muted-foreground sm:text-[0.8125rem]">Replaces the existing value.</p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-pretty text-muted-foreground sm:text-[0.8125rem]">
                  {item.status === 'answered'
                    ? `Saved ${secret.name}${location ? ` to ${location}` : ' to the connected Doppler config'}.`
                    : 'No value was saved.'}
                </p>
              )}
            </div>

            {pending ? (
              <form className="space-y-2" aria-busy={busy} onSubmit={submit}>
                {/* The ring and legend carry the privacy promise, so the old
                    footnote below the field is gone. */}
                <div className="relative pt-2">
                  <span className="absolute top-0 left-3 z-10 bg-(--secret-card-bg) px-1 font-mono text-[0.6875rem] tracking-wide text-ring">
                    Private to you · agent cannot read
                  </span>
                  <div className="relative flex items-center gap-2 rounded-lg border-2 border-transparent px-2.5 py-2.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring/40">
                    {/* Dashed ring drawn as SVG so the dashes can march around
                        the field while it waits for input. */}
                    <svg aria-hidden="true" className="pointer-events-none absolute -inset-0.5 size-[calc(100%+4px)] overflow-visible text-ring">
                      <rect
                        x="1"
                        y="1"
                        width="calc(100% - 2px)"
                        height="calc(100% - 2px)"
                        rx="8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray="6 4"
                        className="vp-secret-march"
                      />
                    </svg>
                    <Lock aria-hidden="true" className="size-3.5 shrink-0 text-ring" />
                    <textarea
                      value={value}
                      onChange={(event) => setValue(event.currentTarget.value)}
                      rows={1}
                      disabled={busy}
                      placeholder="Paste the secret"
                      aria-label={`Value for ${secret.name}`}
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      // WebkitTextSecurity masks a multi-line paste target the way
                      // type="password" masks an input; TS does not know it yet.
                      style={{ WebkitTextSecurity: reveal ? 'none' : 'disc' } as CSSProperties}
                      className="min-w-0 flex-1 resize-none bg-transparent font-mono text-base outline-none placeholder:font-sans placeholder:text-base placeholder:text-muted-foreground disabled:opacity-50 sm:text-sm sm:placeholder:text-[0.9375rem]"
                    />
                  </div>
                </div>
                {error ? (
                  <p className="text-sm text-pretty text-destructive" role="alert">{error}</p>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-pressed={reveal}
                    onClick={() => setReveal((current) => !current)}
                  >
                    {reveal ? 'Hide' : 'Show'}
                  </Button>
                  <Button type="submit" size="sm" disabled={busy || !value.trim()} className="relative">
                    <span
                      aria-hidden="true"
                      className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                    />
                    Save
                  </Button>
                </div>
              </form>
            ) : null}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

export { normalizeSecretValue, targetLocation };
