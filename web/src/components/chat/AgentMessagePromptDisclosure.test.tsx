import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgentMessagePromptDisclosure,
  isLocalAgentOrigin,
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

  it('does not classify remote agent messages or wakeups as local handoffs', () => {
    expect(isLocalAgentOrigin({ kind: 'agent', from: 'Remote agent', to: 'Writer' })).toBe(false);
    expect(isLocalAgentOrigin({ kind: 'wakeup', from: 'Writer', to: 'Writer' })).toBe(false);
  });
});
