import { describe, expect, it } from 'vitest';
import {
  agentMessageInputDetails,
  isAgentSendMessageTool,
} from '../src/runtime/agentMessageToolDetails.js';

describe('agent message tool details', () => {
  it('captures the exact local destination and full outbound text', () => {
    const text = `First line.\n${'x'.repeat(400)}`;
    expect(agentMessageInputDetails('mcp__agents__send_message', {
      conversationId: 'swap-chat',
      text,
    })).toEqual({
      kind: 'agent-message',
      targetConversationId: 'swap-chat',
      text,
    });
  });

  it('treats the whole conversationId as the local destination', () => {
    expect(agentMessageInputDetails('mcp__agents__send_message', {
      conversationId: 'swap:chat',
      text: 'Steer it.',
    })).toEqual({ kind: 'agent-message', targetConversationId: 'swap:chat', text: 'Steer it.' });
  });

  it('ignores adjacent agent tools and malformed calls', () => {
    expect(isAgentSendMessageTool('mcp__agents__read_conversation')).toBe(false);
    expect(agentMessageInputDetails('mcp__agents__read_conversation', {
      conversationId: 'swap-chat', text: 'hello',
    })).toBeUndefined();
    expect(agentMessageInputDetails('mcp__agents__send_message', { conversationId: 'swap-chat' })).toBeUndefined();
  });
});
