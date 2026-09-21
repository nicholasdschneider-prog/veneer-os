import type { ConversationDiscoveryToolDefinition } from './conversationDiscoveryTools.js';

const str = { type: 'string' };
const ids = { type: 'array', items: str, maxItems: 6 };
function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ConversationDiscoveryToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

/**
 * Huddles: group threads for three to six persistent bots coordinating one
 * outcome. Everything runs through /api/huddles so the REST layer, not this
 * process, decides who may do what.
 */
export const HUDDLE_TOOL_DEFINITIONS = [
  definition(
    'open_huddle',
    'Open (or join the existing) huddle: a focused group thread for sustained work that needs THIS bot plus at least two other registered bots on one outcome. Do not open one for a single request to one other bot; that stays send_message. You become the accountable lead unless the goal already has an open huddle, in which case you and the listed bots join it instead of duplicating it. Members are woken with the goal; they keep their own identity, permissions and tools. Pass a stable request_key so retries are idempotent.',
    {
      goal: { type: 'string', description: 'One sentence naming the outcome, e.g. "Resolve order 1234 replacement and refund".' },
      why: { type: 'string', description: 'Why this needs a shared multi-bot thread rather than direct messages (what is sustained, who depends on whom).' },
      members: { ...ids, description: 'Conversation ids of the other registered bots to invite (list_conversations shows them). Two or more.' },
      dedupe_key: { type: 'string', description: 'Optional stable key for the outcome (order number, ticket id). Same key in the same business reuses the open huddle.' },
      request_key: str,
    },
    ['goal', 'why', 'members', 'request_key'],
  ),
  definition('list_huddles', 'List the huddles this bot belongs to, with goal, status, owner and unread count.', { status: { type: 'string', enum: ['open', 'closed', 'all'] } }, []),
  definition(
    'read_huddle',
    'Read a huddle: goal, members, current owner, actions and the message thread with authorship. Reading acknowledges delivery of everything shown. Use after_seq to fetch only newer messages.',
    { huddle_id: str, after_seq: { type: 'integer', minimum: 0 } },
    ['huddle_id'],
  ),
  definition(
    'post_huddle_message',
    'Post in a huddle as THIS bot. mentions targets specific members (only they are woken); an untargeted message goes to the current owner or the lead, never to everyone. kind=handoff passes ownership of the next step to exactly one mentioned member and wakes them plus the lead. kind=status updates the huddle status line without waking the team. Post only when you add something: a result, a question, a handoff, a blocker. Never post to acknowledge, and never relay huddle traffic with send_message. Pass a stable request_key.',
    {
      huddle_id: str,
      text: str,
      mentions: { ...ids, description: 'Member conversation ids this message is addressed to.' },
      kind: { type: 'string', enum: ['message', 'handoff', 'status'] },
      request_key: str,
    },
    ['huddle_id', 'text', 'request_key'],
  ),
  definition(
    'invite_to_huddle',
    'Invite more registered bots from the same business into an open huddle (six members at most). They receive the goal and current status.',
    { huddle_id: str, members: ids },
    ['huddle_id', 'members'],
  ),
  definition(
    'update_huddle_action',
    'Create or update a tracked action in a huddle. Omit action_id to create one (title required). Set owner to the member responsible; depends_on lists action ids that must finish first, and the owner is woken automatically when they do. Mark your own actions done/blocked with a note; the lead may mark any.',
    {
      huddle_id: str,
      action_id: str,
      title: str,
      owner: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['open', 'done', 'blocked', 'cancelled'] },
      depends_on: { type: 'array', items: str, maxItems: 20 },
      note: str,
    },
    ['huddle_id'],
  ),
  definition(
    'update_huddle',
    'Adjust a huddle: owner (who holds the next step), status_note (one line the team sees), lead (lead-only transfer to an active member), goal (lead-only), or leave=true to leave as a non-lead member.',
    { huddle_id: str, owner: { type: ['string', 'null'] }, status_note: str, lead: str, goal: str, leave: { type: 'boolean' } },
    ['huddle_id'],
  ),
  definition(
    'close_huddle',
    'Lead only. Close the huddle once the outcome is verified complete; give concrete verification evidence. Refused while actions are still open or blocked. History is kept and the huddle can be reopened.',
    { huddle_id: str, verification: str },
    ['huddle_id', 'verification'],
  ),
  definition('reopen_huddle', 'Reopen a closed huddle you belong to, with the reason, when the outcome turns out incomplete. The lead is woken.', { huddle_id: str, reason: str }, ['huddle_id', 'reason']),
];

export async function callHuddleTool({
  name,
  args,
  callApi,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;
}) {
  if (!HUDDLE_TOOL_DEFINITIONS.some((t) => t.name === name)) return null;
  const text = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }] });
  const id = encodeURIComponent(String(args.huddle_id ?? ''));
  const post = (path: string, body: unknown, method = 'POST') => callApi(path, { method, body: JSON.stringify(body) });
  switch (name) {
    case 'open_huddle':
      return text(await post('/api/huddles', { goal: args.goal, why: args.why, members: args.members ?? [], dedupe_key: args.dedupe_key, request_key: args.request_key }));
    case 'list_huddles':
      return text(await callApi(`/api/huddles?status=${encodeURIComponent(String(args.status ?? 'open'))}`));
    case 'read_huddle':
      return text(await callApi(`/api/huddles/${id}?ack=1&after=${encodeURIComponent(String(args.after_seq ?? 0))}`));
    case 'post_huddle_message':
      return text(await post(`/api/huddles/${id}/messages`, { text: args.text, targets: args.mentions ?? [], kind: args.kind ?? 'message', request_key: args.request_key }));
    case 'invite_to_huddle':
      return text(await post(`/api/huddles/${id}/members`, { conversation_ids: args.members ?? [] }));
    case 'update_huddle_action': {
      const { huddle_id: _h, action_id, ...rest } = args;
      void _h;
      return text(
        action_id
          ? await post(`/api/huddles/${id}/actions/${encodeURIComponent(String(action_id))}`, rest, 'PATCH')
          : await post(`/api/huddles/${id}/actions`, rest),
      );
    }
    case 'update_huddle': {
      const { huddle_id: _h, ...rest } = args;
      void _h;
      return text(await post(`/api/huddles/${id}`, rest, 'PATCH'));
    }
    case 'close_huddle':
      return text(await post(`/api/huddles/${id}/close`, { verification: args.verification }));
    case 'reopen_huddle':
      return text(await post(`/api/huddles/${id}/reopen`, { reason: args.reason }));
    default:
      return null;
  }
}
