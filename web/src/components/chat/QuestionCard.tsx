import { Check } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import type { ChatItem } from '@/lib/transcript';
import type { QuestionAnswers, QuestionPrompt } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent } from '@/components/ui/message';

type QuestionItem = Extract<ChatItem, { kind: 'question' }>;

function answerPayload(
  questions: QuestionPrompt[],
  choices: QuestionAnswers,
  otherActive: Record<string, boolean>,
  otherText: Record<string, string>,
): QuestionAnswers | null {
  const answers: QuestionAnswers = {};
  for (const question of questions) {
    const selected = choices[question.id] ?? [];
    const includeOther = question.allowOther && (question.options.length === 0 || otherActive[question.id]);
    const other = includeOther ? (otherText[question.id] ?? '').trim() : '';
    const values = other ? [...selected, other] : selected;
    if (values.length === 0 || (includeOther && !other)) return null;
    answers[question.id] = values;
  }
  return answers;
}

function answerLabel(question: QuestionPrompt, answer: string): string {
  return question.options.find((option) => option.value === answer)?.label ?? answer;
}

export function QuestionCard({ item }: { item: QuestionItem }) {
  const [choices, setChoices] = useState<QuestionAnswers>({});
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [submitted, setSubmitted] = useState<QuestionAnswers | null>(null);
  const pending = item.status === 'pending' && !submitted;
  const recorded = item.status === 'answered' ? item.answers : submitted;
  const instant = item.questions.length === 1 && !item.questions[0]!.multi;
  const answers = answerPayload(item.questions, choices, otherActive, otherText);

  const chooseOption = (question: QuestionPrompt, value: string, checked: boolean) => {
    setChoices((current) => {
      if (!question.multi) return { ...current, [question.id]: checked ? [value] : [] };
      const selected = current[question.id] ?? [];
      return {
        ...current,
        [question.id]: checked
          ? [...selected.filter((candidate) => candidate !== value), value]
          : selected.filter((candidate) => candidate !== value),
      };
    });
    if (!question.multi && checked) {
      setOtherActive((current) => ({ ...current, [question.id]: false }));
    }
  };

  const chooseOther = (question: QuestionPrompt, checked: boolean) => {
    setOtherActive((current) => ({ ...current, [question.id]: checked }));
    if (!question.multi && checked) {
      setChoices((current) => ({ ...current, [question.id]: [] }));
    }
  };

  const send = (payload: QuestionAnswers) => {
    if (inFlight.current || !pending) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void api.resolveQuestion(item.requestId, payload).then(() => {
      setSubmitted(payload);
    }).catch((reason: Error) => {
      setError(reason.message);
      inFlight.current = false;
      setBusy(false);
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (answers) send(answers);
  };

  if (item.status === 'dismissed') return null;

  return (
    <Message>
      <MessageContent>
        <Bubble variant="muted" className="w-full max-w-[34rem]">
          <BubbleContent className="w-full space-y-3 rounded-2xl p-3 sm:p-4">
            {pending ? (
              <form className="space-y-4" aria-busy={busy} onSubmit={submit}>
                {item.questions.map((question, questionIndex) => {
                  const activeOther = question.options.length === 0 || Boolean(otherActive[question.id]);
                  const labelId = `question-${item.requestId}-${question.id}-label`;
                  return (
                    <fieldset
                      key={question.id}
                      className="min-w-0 space-y-2.5 border-t border-border/50 pt-4 first:border-t-0 first:pt-0"
                      disabled={busy}
                      aria-labelledby={labelId}
                    >
                      <div id={labelId} className="space-y-1">
                        {question.header ? (
                          <p className="text-sm text-muted-foreground sm:text-sm">{question.header}</p>
                        ) : item.questions.length > 1 ? (
                          <p className="text-sm text-muted-foreground sm:text-sm">Question {questionIndex + 1}</p>
                        ) : null}
                        <p className="text-[0.9375rem] font-medium text-pretty text-foreground sm:text-sm">{question.question}</p>
                      </div>

                      <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40 divide-y divide-border/60">
                        {question.options.map((option, optionIndex) => {
                          const id = `question-${item.requestId}-${question.id}-${optionIndex}`;
                          const selected = (choices[question.id] ?? []).includes(option.value);
                          if (instant) return (
                            <button key={option.value} type="button" disabled={busy}
                              onClick={() => send({ [question.id]: [option.value] })}
                              className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60">
                              <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded bg-foreground/5 text-xs text-muted-foreground">{optionIndex < 26 ? String.fromCharCode(65 + optionIndex) : String(optionIndex + 1)}</span>
                              <span className="min-w-0 flex-1 break-words"><span className="block">{option.label}</span>{option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}</span>
                            </button>
                          );
                          return (
                            <label
                              key={`${option.value}-${optionIndex}`}
                              htmlFor={id}
                              className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 text-[0.9375rem] has-[:checked]:bg-foreground/5 sm:text-sm"
                            >
                              <span className="flex h-lh shrink-0 items-center">
                                <input
                                  id={id}
                                  name={`question-${item.requestId}-${question.id}`}
                                  type={question.multi ? 'checkbox' : 'radio'}
                                  checked={selected}
                                  onChange={(event) => chooseOption(question, option.value, event.currentTarget.checked)}
                                  className="peer sr-only"
                                />
                                <span aria-hidden="true" className="flex size-7 items-center justify-center rounded border text-xs peer-focus-visible:outline-2 peer-checked:bg-primary peer-checked:text-primary-foreground">{optionIndex < 26 ? String.fromCharCode(65 + optionIndex) : String(optionIndex + 1)}</span>
                              </span>
                              <span className="min-w-0 flex-1 break-words">
                                <p className="font-medium text-foreground">{option.label}</p>
                                {option.description ? (
                                  <p className="text-sm text-pretty text-muted-foreground sm:text-sm">{option.description}</p>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}

                        {question.allowOther ? (
                          <div className="space-y-1.5 px-3 py-1">
                            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[0.9375rem] sm:text-sm">
                              <span className="flex h-lh shrink-0 items-center">
                                <input
                                  name={`question-${item.requestId}-${question.id}`}
                                  type={question.multi ? 'checkbox' : 'radio'}
                                  checked={activeOther}
                                  onChange={(event) => chooseOther(question, event.currentTarget.checked)}
                                  className="size-5 shrink-0 accent-primary sm:size-4"
                                />
                              </span>
                              <p className="font-medium text-foreground">Other</p>
                            </label>
                            {activeOther ? (
                              <Input
                                name={`question-${item.requestId}-${question.id}-other`}
                                value={otherText[question.id] ?? ''}
                                onFocus={() => chooseOther(question, true)}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  chooseOther(question, true);
                                  setOtherText((current) => ({ ...current, [question.id]: value }));
                                }}
                                placeholder="Type another answer"
                                aria-label={`Other answer for ${question.question}`}
                                autoComplete="off"
                                maxLength={4000}
                                className="text-foreground"
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </fieldset>
                  );
                })}

                {error ? (
                  <p className="text-sm text-pretty text-destructive" role="alert">{error}</p>
                ) : null}
                {busy && <p role="status" className="text-xs text-muted-foreground">Sending…</p>}
                {(!instant || otherActive[item.questions[0]!.id] || item.questions[0]!.options.length === 0) && <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busy || !answers} className="relative">
                    <span
                      aria-hidden="true"
                      className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                    />
                    {item.questions.length > 1 || item.questions.some((question) => question.multi)
                      ? 'Send answers'
                      : 'Send answer'}
                  </Button>
                </div>}
              </form>
            ) : (
              <div className="space-y-3" role="status">
                <span className="sr-only">{recorded ? 'Answered' : 'No answer given'}</span>
                {item.questions.map((question) => (
                  <div key={question.id} className="space-y-1 border-t border-border/50 pt-2.5 first:border-t-0 first:pt-0">
                    <p className="text-[0.9375rem] font-medium text-pretty text-foreground sm:text-sm">{question.question}</p>
                    {recorded ? (
                      <ul role="list" className="space-y-1">
                        {(recorded[question.id] ?? []).map((answer) => (
                          <li key={answer} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border bg-muted/40 px-3 py-2 text-sm sm:text-sm">
                            {answerLabel(question, answer)}<Check className="size-4 shrink-0 text-emerald-500" aria-label="Answer recorded" />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

export { answerPayload };
