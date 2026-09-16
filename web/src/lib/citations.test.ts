import { describe, expect, it } from 'vitest';
import {
  citationForHref,
  citationPayload,
  citationsFromPayload,
  extractCitations,
} from './citations';

describe('extractCitations', () => {
  it('numbers unique source URLs by first appearance and reuses duplicate URLs', () => {
    const citations = extractCitations(
      [
        'The first claim. [9](https://example.com/jobs/42 "Job record")',
        'The same source again. [2](https://example.com/jobs/42)',
        'A second source. [7](https://docs.example.org/report.pdf "Inspection report")',
      ].join('\n\n'),
    );

    expect(citations).toEqual([
      {
        number: 1,
        url: 'https://example.com/jobs/42',
        title: 'Job record',
        site: 'example.com',
      },
      {
        number: 2,
        url: 'https://docs.example.org/report.pdf',
        title: 'Inspection report',
        site: 'docs.example.org',
      },
    ]);
    expect(citationForHref('https://example.com/jobs/42', citations)?.number).toBe(1);
  });

  it('ignores normal links and unsafe citation URLs', () => {
    const citations = extractCitations(
      [
        '[Project website](https://example.com)',
        '[1](javascript:alert(1))',
        '[2](mailto:person@example.com)',
      ].join('\n\n'),
    );

    expect(citations).toEqual([]);
  });

  it('supports protected same-origin paths', () => {
    expect(extractCitations('[1](/records/job-42 "Job 42")')).toEqual([
      {
        number: 1,
        url: '/records/job-42',
        title: 'Job 42',
        site: 'Veneer Pro',
      },
    ]);
  });
});

describe('citation payload', () => {
  it('round-trips valid citations for frozen transcript buttons', () => {
    const citations = extractCitations('[1](https://example.com "Example")');
    expect(citationsFromPayload(citationPayload(citations))).toEqual(citations);
  });

  it('rejects malformed or unsafe payloads', () => {
    expect(citationsFromPayload('{bad json')).toEqual([]);
    expect(citationsFromPayload(JSON.stringify([
      { number: 1, url: 'javascript:alert(1)', title: 'Bad', site: 'Bad' },
    ]))).toEqual([]);
  });
});
