import { describe, expect, it, vi } from 'vitest';
import { MAX_CONVERSATION_TITLE_LENGTH } from '../src/conversations/title.js';
import {
  callRenameConversationTool,
  RENAME_CONVERSATION_TOOL,
} from '../src/mcp/renameConversationTool.js';

describe('rename_conversation agent tool', () => {
  it('registers an agent tool with a bounded title and optional current-chat id', () => {
    expect(RENAME_CONVERSATION_TOOL.name).toBe('rename_conversation');
    expect(RENAME_CONVERSATION_TOOL.inputSchema).toMatchObject({
      properties: {
        conversationId: { type: 'string' },
        title: { type: 'string', minLength: 1, maxLength: MAX_CONVERSATION_TITLE_LENGTH },
      },
      required: ['title'],
    });
  });

  it('renames an exact local conversation with a trimmed title', async () => {
    const callApi = vi.fn(async (_path: string, init?: RequestInit) => ({
      conversation: { id: 'chat-123', title: JSON.parse(String(init?.body)).title },
    }));

    const result = await callRenameConversationTool({
      name: 'rename_conversation',
      args: { conversationId: 'chat-123', title: '  Today  ' },
      callApi,
      sourceConversationId: 'calling-chat',
    });

    expect(callApi).toHaveBeenCalledWith('/api/conversations/chat-123', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Today' }),
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Renamed conversation chat-123 to "Today".' }],
    });
  });

  it.each([{ conversationId: undefined }, { conversationId: 'current' }, { conversationId: 'this' }, { conversationId: 'self' }])(
    'resolves $conversationId to the calling chat',
    async ({ conversationId }) => {
      const callApi = vi.fn(async () => ({ conversation: { id: 'calling-chat', title: 'Today' } }));
      const result = await callRenameConversationTool({
        name: 'rename_conversation',
        args: { ...(conversationId ? { conversationId } : {}), title: 'Today' },
        callApi,
        sourceConversationId: 'calling-chat',
      });

      expect(callApi).toHaveBeenCalledWith('/api/conversations/calling-chat', expect.any(Object));
      expect(result?.isError).toBeUndefined();
    },
  );

  it.each([
    {
      args: { conversationId: 'chat-123', title: '   ' },
      error: 'rename_conversation needs a non-empty title.',
    },
    {
      args: { conversationId: 'chat-123', title: 'x'.repeat(MAX_CONVERSATION_TITLE_LENGTH + 1) },
      error: `Conversation titles cannot exceed ${MAX_CONVERSATION_TITLE_LENGTH} characters.`,
    },
    {
      args: { conversationId: 'acme:chat-123', title: 'Today' },
      error:
        'rename_conversation only supports chats on this local Veneer instance; instance-qualified addresses are not supported.',
    },
    {
      args: { title: 'Today' },
      sourceConversationId: '',
      error: 'No current chat is available. Pass an exact local conversationId.',
    },
  ])('rejects invalid input: $error', async ({ args, sourceConversationId = 'calling-chat', error }) => {
    const callApi = vi.fn(async () => ({ conversation: {} }));
    const result = await callRenameConversationTool({
      name: 'rename_conversation',
      args,
      callApi,
      sourceConversationId,
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(result).toEqual({ content: [{ type: 'text', text: error }], isError: true });
  });

  it('surfaces a missing local conversation clearly', async () => {
    const callApi = vi.fn(async () => {
      throw new Error('Conversation not found');
    });

    await expect(
      callRenameConversationTool({
        name: 'rename_conversation',
        args: { conversationId: 'missing-chat', title: 'Today' },
        callApi,
        sourceConversationId: 'calling-chat',
      }),
    ).rejects.toThrow('Conversation not found');
  });
});
