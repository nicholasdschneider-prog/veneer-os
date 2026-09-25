import { Check } from 'lucide-react';
import { useState, type FormEvent } from 'react';
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
  const pending = item.status === 'pending';
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !answers) return;
    setBusy(true);
    setError(null);
    api.resolveQuestion(item.requestId, answers).catch((reason: Error) => {
      setError(reason.message);
      setBusy(false);
    });
  };

  const statusLabel = pending
    ? 'Waiting for you'
    : item.status === 'answered'
      ? 'Answered'
      : 'No answer given';

  if (item.status === 'dismissed') return null;

  return (
    <Message>
      <MessageContent>
        <Bubble variant="outline" className="w-full max-w-full">
          <BubbleContent className="w-full space-y-3 rounded-lg border-border/50 p-3">
            <div className="flex justify-start">
              <p className="font-mono text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                {statusLabel}
              </p>
            </div>

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
                          <p className="text-sm text-muted-foreground sm:text-[0.8125rem]">{question.header}</p>
                        ) : item.questions.length > 1 ? (
                          <p className="text-sm text-muted-foreground sm:text-[0.8125rem]">Question {questionIndex + 1}</p>
                        ) : null}
                        <p className="text-[0.9375rem] font-medium text-pretty text-foreground sm:text-[0.8125rem]">{question.question}</p>
                      </div>

                      <div className="space-y-2">
                        {question.options.map((option, optionIndex) => {
                          const id = `question-${item.requestId}-${question.id}-${optionIndex}`;
                          const selected = (choices[question.id] ?? []).includes(option.value);
                          return (
                            <label
                              key={`${option.value}-${optionIndex}`}
                              htmlFor={id}
                              className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-[0.9375rem] has-[:checked]:border-primary sm:text-[0.8125rem]"
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
                                  <p className="text-sm text-pretty text-muted-foreground sm:text-[0.8125rem]">{option.description}</p>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}

                        {question.allowOther ? (
                          <div className="space-y-1.5 py-1">
                            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[0.9375rem] sm:text-[0.8125rem]">
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
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busy || !answers} className="relative">
                    <span
                      aria-hidden="true"
                      className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                    />
                    {item.questions.length > 1 || item.questions.some((question) => question.multi)
                      ? 'Submit answers'
                      : 'Submit answer'}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-3">
                {item.questions.map((question) => (
                  <div key={question.id} className="space-y-1 border-t border-border/50 pt-2.5 first:border-t-0 first:pt-0">
                    <p className="text-[0.9375rem] font-medium text-pretty text-foreground sm:text-[0.8125rem]">{question.question}</p>
                    {item.status === 'answered' ? (
                      <ul role="list" className="space-y-1">
                        {(item.answers[question.id] ?? []).map((answer) => (
                          <li key={answer} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border bg-muted/40 px-3 py-2 text-sm sm:text-[0.8125rem]">
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
