import { MAX_CONVERSATION_TITLE_LENGTH } from '../conversations/title.js';

export interface RenameConversationToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RenameConversationToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type CallApi = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

const CURRENT_CONVERSATION_ALIASES = new Set(['current', 'this', 'self']);

export const RENAME_CONVERSATION_TOOL: RenameConversationToolDefinition = {
  name: 'rename_conversation',
  description:
    'Rename a chat on this local Veneer instance. Use its exact local conversation id, or omit conversationId/use "current" when the user asks to rename this chat. Instance-qualified remote addresses are not supported.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description:
          'Exact local chat id. Omit this or pass "current" to rename the chat making this tool call.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_CONVERSATION_TITLE_LENGTH,
        description: `New chat title, after trimming (maximum ${MAX_CONVERSATION_TITLE_LENGTH} characters).`,
      },
    },
    required: ['title'],
  },
};

export async function callRenameConversationTool({
  name,
  args,
  callApi,
  sourceConversationId,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: CallApi;
  sourceConversationId: string;
}): Promise<RenameConversationToolResult | null> {
  if (name !== RENAME_CONVERSATION_TOOL.name) return null;

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    return {
      content: [{ type: 'text', text: 'rename_conversation needs a non-empty title.' }],
      isError: true,
    };
  }
  if (title.length > MAX_CONVERSATION_TITLE_LENGTH) {
    return {
      content: [
        {
          type: 'text',
          text: `Conversation titles cannot exceed ${MAX_CONVERSATION_TITLE_LENGTH} characters.`,
        },
      ],
      isError: true,
    };
  }

  const requestedId = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
  const usesCurrent = !requestedId || CURRENT_CONVERSATION_ALIASES.has(requestedId.toLowerCase());
  const conversationId = usesCurrent ? sourceConversationId : requestedId;
  if (!conversationId) {
    return {
      content: [
        {
          type: 'text',
          text: 'No current chat is available. Pass an exact local conversationId.',
        },
      ],
      isError: true,
    };
  }
  if (conversationId.includes(':')) {
    return {
      content: [
        {
          type: 'text',
          text: 'rename_conversation only supports chats on this local Veneer instance; instance-qualified addresses are not supported.',
        },
      ],
      isError: true,
    };
  }

  const { conversation } = (await callApi(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })) as { conversation: Record<string, unknown> };
  const renamedId = String(conversation.id ?? conversationId);
  const renamedTitle = String(conversation.title ?? title);
  return {
    content: [{ type: 'text', text: `Renamed conversation ${renamedId} to "${renamedTitle}".` }],
  };
}
