import { requestJson } from './api';
export interface BotProposal {
  question: string;
  recommendation: string;
  consequence: string;
  assignee_id: number;
  team: string;
  deadline: string | null;
  evidence: { label: string; conversation_id: string }[];
  blocked_action: string;
  blocks_scope: 'task' | 'workload';
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
  } | null;
  result: { state: string; evidence: string } | null;
  parked: { released_leases: string[]; evidence: string } | null;
  created_at: string;
  updated_at: string;
  can_answer: boolean;
  dismissed: boolean;
  bot_name: string;
  assignee_name: string;
}
export interface BusinessTeam { id: string; name: string; can_manage: boolean; members: { user_id: number; role: string; display_name: string }[] }
export interface Bot {
  business_team_id?: string | null;
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
}
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
    payload_json: string;
    created_at: string;
  }[];
}
export const botsApi = {
  preferences: (id: string, patch: { pinned?: boolean; unread?: boolean }) =>
    requestJson(`/api/bots/preferences/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  manageTeam: (body: Record<string, unknown>) => requestJson('/api/bots/teams/manage', { method: 'POST', body: JSON.stringify(body) }),
  list: (filter: string, business?: string) =>
    requestJson<{ bots: Bot[]; decisions: BotDecision[]; teams: BusinessTeam[] }>(
      `/api/bots?filter=${filter}${business ? `&business=${encodeURIComponent(business)}` : ''}`,
    ),
  detail: (id: string) =>
    requestJson<BotThread>(`/api/bots/decisions/${encodeURIComponent(id)}`),
  candidates: () =>
    requestJson<{
      conversations: { id: string; title: string | null }[];
      users: { id: number; display_name: string }[];
    }>('/api/bots/candidates'),
  register: (id: string, name: string, active: boolean) =>
    requestJson('/api/bots/registrations/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify({ name, active }),
    }),
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
