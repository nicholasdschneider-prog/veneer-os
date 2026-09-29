import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgentMessagePromptDisclosure,
  isInternalMessageOrigin,
} from './AgentMessagePromptDisclosure';

describe('AgentMessagePromptDisclosure', () => {
  it('keeps the exact local agent message closed by default with an authorized source action', () => {
    const origin = {
      kind: 'agent' as const,
      from: 'Platform Dev',
      to: 'SwapBot',
      local: true as const,
      sourceChat: { id: 'source-chat', title: 'Arbitrage Bot Plan Draft' },
    };
    const html = renderToStaticMarkup(
      <AgentMessagePromptDisclosure origin={origin}>
        {'Exact message text.\nSecond line.'}
      </AgentMessagePromptDisclosure>,
    );

    expect(html).toContain('<details');
    expect(html.match(/<details[^>]*>/)?.[0]).not.toContain('open=');
    expect(html).toContain('Message from Arbitrage Bot Plan Draft');
    expect(html).toContain('Exact message text.\nSecond line.');
    expect(html).toContain('href="#/chat/source-chat"');
    expect(html).toContain('Open source chat');
    expect(html).toContain('min-h-12');
    expect(html).toContain('size-[max(100%,3rem)]');
  });

  it('uses the authenticated sender name without exposing a source link', () => {
    const html = renderToStaticMarkup(
      <AgentMessagePromptDisclosure
        origin={{ kind: 'agent', from: 'Researcher', to: 'Writer', local: true }}
      >
        Private-source handoff.
      </AgentMessagePromptDisclosure>,
    );

    expect(html).toContain('Message from Researcher');
    expect(html).not.toContain('href="#/chat/');
  });

  it.each([
    { kind: 'agent' as const, from: 'Agent', to: 'Writer' },
    { kind: 'agent' as const, from: 'Remote agent', to: 'Writer' },
    { kind: 'wakeup' as const, from: 'Writer', to: 'Writer' },
  ])('collapses internal $kind messages without requiring local provenance', (origin) => {
    expect(isInternalMessageOrigin(origin)).toBe(true);
    const text = 'VeneerBots discussion (not an approval). Decision fixture, proposal version 3.\n{"proposal":{"request":"Keep the exact details"}}';
    const html = renderToStaticMarkup(
      <AgentMessagePromptDisclosure origin={origin}>{text}</AgentMessagePromptDisclosure>,
    );
    expect(html.match(/<details[^>]*>/)?.[0]).not.toContain('open=');
    expect(html).toContain('Keep the exact details');
    const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/s)?.[1];
    expect(summary).not.toContain('proposal');
    expect(summary).toContain(origin.kind === 'wakeup' ? 'Scheduled follow-up' : origin.from === 'Agent' ? 'Agent message' : 'Message from Remote agent');
    expect(html).not.toContain('href="#/chat/');
  });

  it('keeps human result replies and build prompts out of the internal disclosure', () => {
    expect(isInternalMessageOrigin({ kind: 'result_reply', from: 'Nick', to: 'Writer' })).toBe(false);
    expect(isInternalMessageOrigin({ kind: 'build_queue', from: 'Queue', to: 'Writer' })).toBe(false);
  });
});
