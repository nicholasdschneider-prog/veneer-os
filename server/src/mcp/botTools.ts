import type { ConversationDiscoveryToolDefinition } from './conversationDiscoveryTools.js';
const str = { type: 'string' };
const evidence = {
  type: 'array',
  items: {
    type: 'object',
    properties: { label: str, conversation_id: str },
    required: ['label', 'conversation_id'],
    additionalProperties: false,
  },
};
const proposal = {
  type: 'object',
  properties: {
    question: str,
    recommendation: str,
    consequence: str,
    assignee_id: { type: 'integer' },
    team: str,
    deadline: {
      type: ['string', 'null'],
      description: 'Real ISO deadline, or null.',
    },
    evidence,
    blocked_action: str,
    blocks_scope: { type: 'string', enum: ['task', 'workload'] },
  },
  required: [
    'question',
    'recommendation',
    'consequence',
    'assignee_id',
    'blocked_action',
  ],
  additionalProperties: false,
};
const mutation = {
  decision_id: str,
  expected_version: { type: 'integer' },
  request_key: {
    type: 'string',
    description:
      'Stable unique key for this operation; reuse only for identical retries.',
  },
};
function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ConversationDiscoveryToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}
export const BOT_TOOL_DEFINITIONS = [
  definition('manage_business_team', 'Manage an owned business and explicit membership/delegation. Human owner or owner-authenticated Platform Dev only; the native actor is audited. create is idempotent by owner/name. delegate allows only explicit owned chat IDs; empty allowed_ids revokes. No financial/customer authority is granted.', {
    action: { type: 'string', enum: ['create','member','delegate','remove_bot'] }, name: str, team_id: str, user_id: { type: 'integer' }, role: { type: ['string','null'], enum: ['viewer','member','manager',null] }, conversation_id: str, allowed_ids: { type: 'array', items: str },
  }, ['action']),
  definition('enroll_business_bots', 'Preview or apply reversible enrollment of explicit EXISTING native bot chat IDs. Requires an active owner-granted delegation to THIS conversation and its exact allowlist. preview uses request_key and bots; apply uses returned preview_id and team_id. Apply rechecks ownership, delegation, membership and metadata; changed previews require fresh review. Retries are idempotent. No new chats or executors, no model/project/history changes, no finance or customer authority.', {
    mode: { type: 'string', enum: ['preview','apply'] }, team_id: str, request_key: str, preview_id: str,
    bots: { type: 'array', items: { type: 'object', properties: { conversation_id: str, name: str, role: { type: 'string', enum: ['coordinator','lead','bot'] }, subteam: str, reports_to: { type: ['string','null'] } }, required: ['conversation_id','name','role'], additionalProperties: false } },
  }, ['mode','team_id']),

  definition(
    'raise_decision',
    'Raise a persistent human decision for THIS registered bot. Does not stop unrelated work or grant authority. Dedupe uses source_key + proposal_key. Use conversation evidence references. Release external ticket/case leases with their owning system first, then record park_decision_work. Business fleet enrollment uses explicit delegated preview/apply tools.',
    { source_key: str, proposal_key: str, proposal },
    ['source_key', 'proposal_key', 'proposal'],
  ),
  definition(
    'update_decision',
    'Revise a material proposal or changed evidence. Increments version, clears old approval and requires a fresh human answer. Never execute against a stale version.',
    { ...mutation, proposal },
    [...Object.keys(mutation), 'proposal'],
  ),
  definition(
    'list_decisions',
    'Read THIS bot’s decisions, eligible human approver IDs, and their exact current proposal versions and execution states. Call this before raising the first decision. Pass decision_id for its discussion and audit. A decision is not work completed.',
    { decision_id: str },
    [],
  ),
  definition(
    'reply_to_decision',
    'Reply in a dedicated decision thread as the SAME permanent bot. Discussion never grants execution authority.',
    { decision_id: str, request_key: str, text: str },
    ['decision_id', 'request_key', 'text'],
  ),
  definition(
    'record_decision_result',
    'Record running before executing an approved current version, with material_evidence_unchanged=true after checking evidence. Then record verified_completed, blocked or failed with concrete evidence. Existing money, policy and tool approval gates remain required; a standing rule answer does not broaden authority.',
    {
      ...mutation,
      state: {
        type: 'string',
        enum: ['running', 'verified_completed', 'blocked', 'failed'],
      },
      evidence: str,
      material_evidence_unchanged: { type: 'boolean' },
    },
    [...Object.keys(mutation), 'state', 'evidence'],
  ),
  definition(
    'park_decision_work',
    'Record that the blocked task is parked and any external leases have ALREADY been released through the owning system. This tool records release receipts, it cannot release third-party leases. Supply released_leases (empty if none) and evidence. Continue unrelated eligible work; task scope does not freeze the bot.',
    {
      ...mutation,
      released_leases: { type: 'array', items: str },
      evidence: str,
    },
    [...Object.keys(mutation), 'released_leases', 'evidence'],
  ),
];
export async function callBotTool({
  name,
  args,
  callApi,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: (
    path: string,
    init?: RequestInit,
  ) => Promise<Record<string, unknown>>;
}) {
  if (!BOT_TOOL_DEFINITIONS.some((t) => t.name === name)) return null;
  if (name === 'manage_business_team' || name === 'enroll_business_bots') {
    const result = await callApi(name === 'manage_business_team' ? '/api/bots/teams/manage' : '/api/bots/teams/enroll', { method: 'POST', body: JSON.stringify(args) });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }
  const { decision_id, ...body } = args;
  const base = '/api/bots/decisions';
  const target = `${base}/${encodeURIComponent(String(decision_id ?? ''))}`;
  const routes: Record<string, string> = {
    raise_decision: base,
    update_decision: `${target}/proposal`,
    reply_to_decision: `${target}/thread`,
    record_decision_result: `${target}/result`,
    park_decision_work: `${target}/park`,
  };
  const result =
    name === 'list_decisions'
      ? await callApi(decision_id ? target : '/api/bots')
      : await callApi(routes[name]!, {
          method: 'POST',
          body: JSON.stringify(body),
        });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}
