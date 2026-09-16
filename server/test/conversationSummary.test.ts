import { describe, expect, it } from 'vitest';
import { summarizeConversation } from '../src/mcp/conversationSummary.js';

const conversation = { title: 'Approval test', assistantSlug: 'assistant', status: 'idle' };

describe('conversation transcript summary', () => {
  it('reports only approvals that are still unresolved', () => {
    const summary = summarizeConversation(conversation, [
      { type: 'approval_requested', requestId: 'resolved', toolName: 'shell' },
      { type: 'approval_resolved', requestId: 'resolved', outcome: 'approved' },
      { type: 'approval_requested', requestId: 'pending', toolName: 'file_change' },
    ]);

    expect(summary).not.toContain('[waiting on approval: shell]');
    expect(summary).toContain('[waiting on approval: file_change]');
  });
});
