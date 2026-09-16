import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '@/lib/transcript';
import { answerPayload, QuestionCard } from './QuestionCard';

const pending: Extract<ChatItem, { kind: 'question' }> = {
  kind: 'question',
  key: 'q-question-1',
  requestId: 'question-1',
  questions: [
    {
      id: 'q1',
      header: 'Release channel',
      question: 'Which channel should we use?',
      options: [
        { label: 'Stable', value: 'stable', description: 'Use the proven channel.' },
        { label: 'Preview', value: 'preview', description: 'Ship the newest changes.' },
      ],
      multi: false,
      allowOther: false,
    },
    {
      id: 'q2',
      header: 'Note',
      question: 'Anything else?',
      options: [],
      multi: false,
      allowOther: true,
    },
  ],
  status: 'pending',
  answers: {},
};

describe('QuestionCard', () => {
  it('renders accessible native controls, descriptions, and free-form Other', () => {
    const html = renderToStaticMarkup(<QuestionCard item={pending} />);
    expect(html).toContain('Waiting for you');
    expect(html).not.toContain('Your input is needed');
    expect(html).not.toContain('Choose an answer for each question');
    expect(html).toContain('Release channel');
    expect(html).toContain('Use the proven channel.');
    expect(html).toContain('type="radio"');
    expect(html).toContain('Other');
    expect(html).toContain('name="question-question-1-q2-other"');
    expect(html).toContain('aria-label="Other answer for Anything else?"');
    expect(html).toContain('Submit answers');
  });

  it('renders a compact read-only answer using the human label', () => {
    const html = renderToStaticMarkup(
      <QuestionCard item={{
        ...pending,
        questions: [pending.questions[0]!],
        status: 'answered',
        answers: { q1: ['stable'] },
      }} />,
    );
    expect(html).toContain('Answered');
    expect(html).toContain('flex justify-start');
    expect(html).not.toContain('flex justify-end');
    expect(html).toContain('Stable');
    expect(html).not.toContain('rounded-md bg-muted');
    expect(html).not.toContain('Submit answer');
    expect(html).not.toContain('value="stable"');
  });

  it('renders no card for a question answered in the normal chat thread', () => {
    const html = renderToStaticMarkup(
      <QuestionCard item={{ ...pending, status: 'dismissed' }} />,
    );
    expect(html).toBe('');
  });

  it('requires one valid answer per question before submission', () => {
    expect(answerPayload(pending.questions, { q1: ['stable'] }, {}, {})).toBeNull();
    expect(answerPayload(
      pending.questions,
      { q1: ['stable'] },
      { q2: true },
      { q2: 'Deploy after lunch' },
    )).toEqual({ q1: ['stable'], q2: ['Deploy after lunch'] });
  });
});
