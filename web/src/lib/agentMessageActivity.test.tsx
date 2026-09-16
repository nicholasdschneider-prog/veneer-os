import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentMessageToolDetails } from '@/components/chat/AgentMessageToolDetails';
import {
  agentMessageActivityLabel,
  agentMessageFocusKey,
  agentMessageGroupLabel,
  agentMessageTargetHash,
  type AgentMessageActivityItem,
} from './agentMessageActivity';

function sent(
  agentName = 'SwapBot',
  disposition: 'running' | 'steered' | 'delivered' | 'queued' = 'steered',
):
AgentMessageActivityItem {
  return {
    running: false,
    ok: true,
    agentMessageDetails: {
      kind: 'agent-message',
      text: 'Exact outbound message.\nSecond line.',
      disposition,
      messageId: 42,
      targetChat: { id: 'swap-chat', title: 'Swap testing', agentName },
    },
  };
}

describe('agent message activity', () => {
  it('uses honest labels for in-flight, queued, delivered, and failed states', () => {
    expect(agentMessageActivityLabel({ ...sent(), running: true })).toBe('Messaging SwapBot…');
    expect(agentMessageActivityLabel(sent('SwapBot', 'queued'))).toBe('Queued for SwapBot');
    expect(agentMessageActivityLabel(sent())).toBe('Messaged SwapBot');
    expect(agentMessageActivityLabel(sent('SwapBot', 'delivered'))).toBe('Messaged SwapBot');
    expect(agentMessageActivityLabel({ ...sent(), ok: false })).toBe('Message to SwapBot failed');
  });

  it('keeps remote or unreceipted calls generic instead of claiming delivery', () => {
    expect(agentMessageActivityLabel({
      running: false,
      ok: true,
      agentMessageDetails: { kind: 'agent-message', text: 'hello', remoteInstance: 'acme' },
    })).toBeNull();
  });

  it('promotes the handoff label across an otherwise ordinary grouped run', () => {
    expect(agentMessageGroupLabel([
      { running: false, ok: true },
      sent(),
      { running: false, ok: true },
    ])).toBe('Messaged SwapBot');
    expect(agentMessageGroupLabel([sent('SwapBot'), sent('Researcher')])).toBe('Messaged 2 agents');
    // A delivered message reached the live process, so it counts as delivered.
    expect(agentMessageGroupLabel([sent('SwapBot', 'delivered'), sent('Researcher')])).toBe('Messaged 2 agents');
  });

  it('deep-links delivered messages and falls back to the target chat while queued', () => {
    expect(agentMessageTargetHash(sent().agentMessageDetails!)).toBe('#/chat/swap-chat?message=42');
    expect(agentMessageTargetHash(sent('SwapBot', 'queued').agentMessageDetails!)).toBe('#/chat/swap-chat');
    expect(agentMessageFocusKey('42')).toBe('u-message-42');
    expect(agentMessageFocusKey('../42')).toBeNull();
  });

  it('renders the exact message and an accessible compact target action', () => {
    const html = renderToStaticMarkup(<AgentMessageToolDetails item={sent()} />);
    expect(html).toContain('Exact outbound message.\nSecond line.');
    expect(html).toContain('To SwapBot');
    expect(html).toContain('Sent');
    expect(html).toContain('href="#/chat/swap-chat?message=42"');
    expect(html).toContain('Open SwapBot at this message');
    expect(html).toContain('size-[max(100%,3rem)]');
  });

  it('distinguishes a message the live agent has not read yet', () => {
    const html = renderToStaticMarkup(<AgentMessageToolDetails item={sent('SwapBot', 'delivered')} />);
    expect(html).toContain('Delivered');
  });
});
