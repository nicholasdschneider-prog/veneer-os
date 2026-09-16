export const CHAT_LINK_TOOL = {
  name: 'get_chat_link',
  description: 'Get the clickable URL for a Veneer chat, identical to the chat menu Copy Link action. Omit conversationId (or use "current") for this chat; use an exact local id from list_conversations for another chat. Use the returned URL when the user asks for a chat link or wants one included in an email. This only retrieves the link; it sends nothing and grants no access. The recipient must already have permission to open the chat.',
  inputSchema: {
    type: 'object',
    properties: { conversationId: { type: 'string', description: 'Exact local chat id; omit or use "current" for this chat.' } },
    additionalProperties: false,
  },
};

export async function callChatLinkTool({ name, args, callApi, sourceConversationId }: {
  name: string;
  args: Record<string, unknown>;
  callApi: (path: string) => Promise<Record<string, unknown>>;
  sourceConversationId: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null> {
  if (name !== CHAT_LINK_TOOL.name) return null;
  const requested = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
  const id = !requested || ['current', 'this', 'self'].includes(requested.toLowerCase()) ? sourceConversationId : requested;
  const error = !id ? 'No current chat is available. Supply an exact local conversationId.'
    : id.includes(':') ? 'get_chat_link needs an exact conversationId from list_conversations.' : null;
  if (error) return { content: [{ type: 'text', text: error }], isError: true };
  const result = await callApi(`/api/conversations/${encodeURIComponent(id)}/link`);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
