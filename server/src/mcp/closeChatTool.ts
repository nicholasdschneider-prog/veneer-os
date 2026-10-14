export interface CloseChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CloseChatToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type CallApi = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

export const CLOSE_CHAT_TOOL: CloseChatToolDefinition = {
  name: 'close_chat',
  description:
    'Finish THIS one-issue chat: send the final report to the requester (default: the chat that handed this one off) or record it here, then archive this chat. Archive only: history stays and remains searchable, and a later message reopens it. Refuses, listing each blocker with ids, while this chat has a pending wake-up, a queued/running/failed/stopped build, an open decision or question card, an undelivered approved message, a queued message, or finished builds without a deployment statement. If deployment is pending, every waiting chat (the requester always) must already have a message from this chat since the build finished, or be report_to. Never closes a registered bot’s standing chat, a pinned chat, an automation chat or another chat. A build chat closes in a later turn, after its build slot is released.',
  inputSchema: {
    type: 'object',
    properties: {
      report: {
        type: 'string',
        minLength: 1,
        maxLength: 20000,
        description: 'Final report: outcome, verified evidence, anything still pending and who owns it.',
      },
      report_to: {
        type: ['string', 'null'],
        description:
          'Chat that receives the report through a coordination thread. Omit to use the chat that started this one; pass null to only record the report in this chat.',
      },
      deployment: {
        type: 'object',
        description: 'Required when this chat finished builds.',
        properties: {
          status: {
            type: 'string',
            enum: ['live', 'pending', 'none'],
            description: 'live = verified running; none = nothing to deploy; pending = pushed but not deployed.',
          },
          notified_conversation_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'For pending: the waiting bots or requesters already told by send_message from this chat.',
          },
        },
        required: ['status'],
      },
    },
    required: ['report'],
  },
};

export async function callCloseChatTool({
  name,
  args,
  callApi,
  sourceConversationId,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: CallApi;
  sourceConversationId: string;
}): Promise<CloseChatToolResult | null> {
  if (name !== CLOSE_CHAT_TOOL.name) return null;
  if (!sourceConversationId) {
    return { content: [{ type: 'text', text: 'close_chat is unavailable here (no active conversation).' }], isError: true };
  }
  const report = typeof args.report === 'string' ? args.report.trim() : '';
  if (!report) {
    return { content: [{ type: 'text', text: 'close_chat needs the final report text.' }], isError: true };
  }
  const body: Record<string, unknown> = { report };
  if (args.report_to === null || typeof args.report_to === 'string') body.report_to = args.report_to;
  if (args.deployment && typeof args.deployment === 'object') body.deployment = args.deployment;

  const path = `/api/conversations/${encodeURIComponent(sourceConversationId)}/close`;
  // A refusal throws with the API error, which lists every blocker and its ids.
  let result: Record<string, unknown>;
  try {
    result = await callApi(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    return { content: [{ type: 'text', text: `close_chat refused: ${(err as Error).message}` }], isError: true };
  }
  const closure = (result.closure ?? {}) as Record<string, unknown>;
  const where = closure.report_to
    ? `Report sent to ${String(closure.report_to)} (coordination thread ${String(closure.report_thread_id ?? 'unknown')}).`
    : 'Report recorded in this chat.';
  const lead = result.alreadyClosed ? 'This chat was already closed.' : 'Chat closed and archived.';
  return {
    content: [{ type: 'text', text: `${lead} ${where} Closed at ${String(closure.closed_at ?? '')}. End this turn now.` }],
  };
}
