import { requestJson } from './api';
export interface CaseTimelineEntry {
  when: string | null;
  actor: string;
  bot?: string | null;
  channel?: string | null;
  kind: 'event' | 'request' | 'promise' | 'proposal';
  summary: string;
  source: string;
}
export const defaultDecisionChoices: NonNullable<BotProposal['choices']> = [
  { id: 'approve', label: 'Approve as proposed', action: 'approve' },
  { id: 'reject', label: 'Reject proposal', action: 'reject' },
  { id: 'defer', label: 'Not now', action: 'defer' },
  { id: 'withdraw', label: 'Withdraw request', action: 'withdraw' },
];
export interface EvidenceItem {
  kind: 'image' | 'document' | 'message' | 'record';
  label: string;
  source: { system: 'chat_file' | 'upload' | 'gmail' | 'orderops' | 'shopify'; [key: string]: unknown };
  text?: string;
  sha256?: string;
  retained?: boolean;
  captured_at?: string;
  added_by?: 'bot' | 'human';
}
export interface StaleMark { reason: string; since: string; detail: string; resolved?: boolean }
/** A question the human can still answer: waiting, and not already settled somewhere else. */
export function isOpenQuestion(d: { state: string; stale?: { resolved?: boolean } | null }): boolean {
  return d.state === 'needs_input' && !d.stale?.resolved;
}
export interface BotProposal {
  review_summary?: {
    action_title: string; request?: string; customer_request?: string; background: string[];
    refund?: { status: 'not_verified' } | { status: 'none'; source: string; as_of: string; scope: string; evidence_kind: 'complete_refund_history' } | { status: 'partial' | 'full'; source: string; as_of: string; scope: string; evidence_kind: 'completed_refund'; receipt: string; amount: number; currency: string };
    evidence_gap?: { kind: 'image' | 'document'; description: string; reason: 'not_yet_available' | 'requires_human_access'; source_ref?: string };
  };
  choices?: { id: string; label: string; description?: string; action: string; answer?: string; recommended?: boolean }[];
  evidence_items?: EvidenceItem[];
  as_of?: { captured_at: string; ticket_id?: string; ticket_status?: string; last_inbound: { channel: string; message_id: string; at?: string }[]; evidence_hashes: string[]; orders?: { order_number: string; order_id?: string }[]; moot_when?: string[] };
  question: string;
  recommendation: string;
  consequence: string;
  assignee_id: number;
  team: string;
  deadline: string | null;
  message_delivery?: {canonical_case:string;executor_conversation_id:string;payload:{channel:string;account:string;recipients:string[];subject:string;body:string;customer:string;ticket:string;context:string;attachments:{name:string;reference:string;sha256:string}[]}};
  images?: { conversation_id: string; path: string; label: string; source: string; sha256?: string }[];
  evidence: { label: string; conversation_id: string }[];
  blocked_action: string;
  blocks_scope: 'task' | 'workload';
  case_timeline?: CaseTimelineEntry[];
  shopify_order?: { number: string; url: string } | null;
}
export interface BotDecision {
  id: string;
  conversation_id: string;
  version: number;
  state: string;
  source_key: string;
  proposal_key: string;
  proposal: BotProposal;
  answer: {
    action: string;
    text: string;
    scope: string;
    actor_id: number;
    choice_id?: string;
    choice_label?: string;
    answer?: string;
    /** Recorded by the owner's standing rule, not by a person. */
    automatic?: boolean;
  } | null;
  result: { state: string; evidence: string } | null;
  parked: { released_leases: string[]; evidence: string } | null;
  stale?: StaleMark | null;
  human_evidence?: (EvidenceItem & { actor_id?: number })[];
  created_at: string;
  updated_at: string;
  answered_by?: string | null;
  image_access?: ('source_access'|'decision_context_only')[];
  evidence_access?: ('source_access' | 'decision_context_only')[];
  collaborative_answers?: boolean;
  shared_queue?: boolean;
  handler_id?: number | null;
  handler_name?: string | null;
  handling_revision?: number;
  handling_mine?: boolean;
  can_handle?: boolean;
  can_release?: boolean;
  can_amend?: boolean;
  can_edit_reply?: boolean;
  can_answer: boolean;
  dismissed: boolean;
  bot_name: string;
  assignee_name: string;
  order_reference?: { number: string; url: string | null; direct: boolean } | null;
  reply_status?: 'queued' | 'not_delivered' | 'awaiting_reply' | 'responding' | null;
}
export interface BusinessTeam { id: string; name: string; can_manage: boolean; members: { user_id: number; role: string; display_name: string; restricted?: boolean }[] }
export interface Bot {
  business_team_id?: string | null;
  last_reply?: {text:string;at:string}|null;
  membership?: { role: string; subteam: string; reports_to: string | null } | null;
  title?: string | null;
  updated_at?: string | null;
  unread?: boolean;
  pinned?: boolean;
  conversation_id: string;
  name: string;
  state: string;
  questions: number;
  can_manage: boolean;
  archived: boolean;
  provider: string;
  project_id: string | null;
  /** Enrolled to own customer tickets inside Veneer (Miles pilot). */
  ticket_owner?: boolean;
  open_tickets?: number;
}
export type CsTicketStatus = 'open' | 'waiting_customer' | 'waiting_human' | 'done';
export interface CsTicket {
  id: string;
  orderops_ticket_id: string;
  owner_conversation_id: string;
  ticket_conversation_id: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  subject: string;
  channel: string;
  status: CsTicketStatus;
  orders: { order_number: string; order_id?: string }[];
  summary: string;
  last_inbound_at: string | null;
  last_polled_at?: string | null;
  last_poll_error?: string | null;
  created_at: string;
  updated_at: string;
}
export interface CsTicketListItem extends CsTicket {
  open_decision: { id: string; version: number; question: string; recommended: string | null } | null;
  message_count: number;
}
export interface CsTicketMessage {
  id: string;
  direction: 'in' | 'out' | 'note';
  channel: string;
  external_id: string | null;
  author: 'customer' | 'bot' | 'human';
  author_label: string;
  body: string;
  attachments: { name: string; reference?: string }[];
  /** Tappable next steps the bot offered under this note. */
  choices?: { label: string; note: string; recommended?: boolean }[];
  remember: boolean;
  at: string;
}
export const csTicketsApi = {
  list: (owner: string, filter: string, q: string, signal?: AbortSignal) =>
    requestJson<{ owner: { conversation_id: string; name: string }; enabled: boolean; tickets: CsTicketListItem[] }>(
      `/api/cs-tickets?owner=${encodeURIComponent(owner)}&filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}`, { signal }),
  detail: (id: string, signal?: AbortSignal) =>
    requestJson<{ ticket: CsTicket; owner: { conversation_id: string; name: string }; messages: CsTicketMessage[]; decisions: BotDecision[] }>(`/api/cs-tickets/${encodeURIComponent(id)}`, { signal }),
  note: (id: string, body: { body: string; remember: boolean; request_key: string; attachments?: { name: string; reference: string }[] }) =>
    requestJson<{ note_id: string; duplicate: boolean }>(`/api/cs-tickets/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify(body) }),
};
export interface BotThread {
  decision: BotDecision;
  messages: {
    id: string;
    actor_name: string;
    actor_conversation_id: string | null;
    text: string;
    created_at: string;
  }[];
  events: {
    id: string;
    kind: string;
    version: number;
    actor_id: number;
    choice_id?: string;
    choice_label?: string;
    payload_json: string;
    created_at: string;
  }[];
}
export const botsApi = {
  preferences: (id: string, patch: { pinned?: boolean; unread?: boolean }) =>
    requestJson(`/api/bots/preferences/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  manageTeam: (body: Record<string, unknown>) => requestJson('/api/bots/teams/manage', { method: 'POST', body: JSON.stringify(body) }),
  list: (filter: string, business?: string, signal?: AbortSignal) =>
    requestJson<{ bots: Bot[]; decisions: BotDecision[]; teams: BusinessTeam[] }>(
      `/api/bots?filter=${filter}${business ? `&business=${encodeURIComponent(business)}` : ''}`,
      { signal },
    ),
  /** Only this conversation's decisions; no bot rows or runner status calls. */
  decisionsFor: (conversationId: string) =>
    requestJson<{ decisions: BotDecision[] }>(`/api/bots?filter=all&conversation=${encodeURIComponent(conversationId)}`),
  detail: (id: string, signal?: AbortSignal) =>
    requestJson<BotThread>(`/api/bots/decisions/${encodeURIComponent(id)}`, { signal }),
  candidates: () =>
    requestJson<{
      conversations: { id: string; title: string | null }[];
      users: { id: number; display_name: string; restricted?: boolean }[];
    }>('/api/bots/candidates'),
  register: (id: string, name: string, active: boolean) =>
    requestJson('/api/bots/registrations/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify({ name, active }),
    }),
  /** Attach a composer upload to a question as human evidence. */
  attachEvidence: (id: string, body: { path: string; label: string; expected_version: number; request_key: string }) =>
    requestJson<{ decision: BotDecision }>(`/api/bots/decisions/${encodeURIComponent(id)}/evidence`, { method: 'POST', body: JSON.stringify(body) }),
  mutate: (id: string, action: string, body: Record<string, unknown>) =>
    requestJson(`/api/bots/decisions/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
export function decisionLabel(state: string) {
  return (
    {
      needs_input: 'Needs your input',
      decided: 'Decision recorded',
      action_pending: 'Action pending',
      running: 'Running',
      verified_completed: 'Verified complete',
      blocked: 'Blocked',
      failed: 'Failed',
    }[state] ?? state
  );
}
