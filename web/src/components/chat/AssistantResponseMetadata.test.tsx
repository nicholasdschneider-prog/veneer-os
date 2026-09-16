import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { responseTokenRows } from '@/lib/responseMetadata';
import { AssistantResponseMetadata, TokenBreakdownCard } from './AssistantResponseMetadata';

describe('AssistantResponseMetadata', () => {
  it('renders the token count with the breakdown card inline, so frozen rows keep it', () => {
    const html = renderToStaticMarkup(
      <AssistantResponseMetadata
        at="2026-08-28T19:45:00.000Z"
        usage={{
          totalInputTokens: 31_176,
          totalOutputTokens: 24,
          totalTokens: 31_200,
          cachedInputTokens: 30_000,
          cacheWriteInputTokens: 1_000,
        }}
      />,
    );

    // Older rows are static HTML without React handlers, so the card has to be
    // in the markup: a native <details> for tap, CSS hover for desktop.
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('data-slot="token-count"');
    expect(html).toContain('aria-label="31,176 input + 24 output tokens this turn"');
    expect(html).toContain('31.2k tokens');
    expect(html).toContain('data-slot="token-breakdown-card"');
    expect(html).toContain('group-hover/tokens:block');
    expect(html).toContain('group-open/tokens:block');
    expect(html).toContain('Cache read');
    expect(html).toContain('>30,000</dd>');
  });

  it('lays the card out as label/value rows, cache lines included', () => {
    const html = renderToStaticMarkup(
      <TokenBreakdownCard
        rows={responseTokenRows({
          totalInputTokens: 31_176,
          totalOutputTokens: 24,
          totalTokens: 31_200,
          cachedInputTokens: 30_000,
          cacheWriteInputTokens: 1_000,
        })}
      />,
    );

    expect(html).toContain('<dt class="text-muted-foreground">Input</dt>');
    expect(html).toContain('>176</dd>');
    expect(html).toContain('Cache read');
    expect(html).toContain('>30,000</dd>');
    expect(html).toContain('Cache write');
    expect(html).toContain('>1,000</dd>');
    expect(html).toContain('Output');
    expect(html).toContain('Total');
    expect(html).toContain('tabular-nums');
  });

  it('drops the cache rows when the provider reported no cache figures', () => {
    const html = renderToStaticMarkup(
      <TokenBreakdownCard
        rows={responseTokenRows({
          totalInputTokens: 31_176,
          totalOutputTokens: 24,
          totalTokens: 31_200,
        })}
      />,
    );

    expect(html).not.toContain('Cache');
    expect(html).toContain('>31,176</dd>');
  });

  it('renders a subtle timestamp and token count with exact hover details', () => {
    const html = renderToStaticMarkup(
      <AssistantResponseMetadata
        at="2026-08-28T19:45:00.000Z"
        usage={{ totalInputTokens: 31_176, totalOutputTokens: 24, totalTokens: 31_200 }}
      />,
    );

    expect(html).toContain('data-slot="message-footer"');
    expect(html).toContain('dateTime="2026-08-28T19:45:00.000Z"');
    expect(html).toContain('31.2k tokens');
    expect(html).toContain('31,176 input + 24 output tokens this turn');
    expect(html).toContain('text-muted-foreground/70');
  });

  it('keeps the timestamp when usage is unavailable and renders nothing with neither', () => {
    const timestampOnly = renderToStaticMarkup(
      <AssistantResponseMetadata at="2026-08-28T19:45:00.000Z" />,
    );
    const empty = renderToStaticMarkup(<AssistantResponseMetadata />);

    expect(timestampOnly).toContain('<time');
    expect(timestampOnly).not.toContain('tokens');
    expect(empty).toBe('');
  });
});
