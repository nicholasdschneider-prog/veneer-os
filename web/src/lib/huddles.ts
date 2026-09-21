import { requestJson } from './api';

export interface HuddleParticipant {
  conversation_id: string;
  name: string;
  title: string | null;
  archived: boolean;
}
export interface HuddleMember extends HuddleParticipant {
  role: 'lead' | 'member';
  joined_at: string;
  left_at: string | null;
  unread: number;
  pending_wake: boolean;
  last_wake_at: string | null;
}
export interface HuddleMessage {
  id: string;
  seq: number;
  kind: 'message' | 'handoff' | 'status' | 'system';
  author: { conversation_id: string | null; user_id: number | null; name: string };
  body: string;
  targets: string[];
  recipients: string[];
  action_id: string | null;
  created_at: string;
}
export interface HuddleAction {
  id: string;
  title: string;
  owner: HuddleParticipant | null;
  status: 'open' | 'done' | 'blocked' | 'cancelled';
  depends_on: string[];
  blocked_by: string[];
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export interface HuddleSummary {
  id: string;
  goal: string;
  why: string;
  status: 'open' | 'closed';
  status_note: string;
  business_team_id: string | null;
  lead: HuddleParticipant;
  owner: HuddleParticipant | null;
  member_count: number;
  open_action_count: number;
  last_seq: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  reopened_at: string | null;
  my_unread: number;
  my_role: 'lead' | 'member' | 'left' | 'observer';
}
export interface Huddle extends HuddleSummary {
  members: HuddleMember[];
  actions: HuddleAction[];
  messages: HuddleMessage[];
  close_verification: string | null;
  closed_by: string | null;
  can_post: boolean;
  can_manage: boolean;
  my_conversation_id: string | null;
}

const json = (body: unknown) => JSON.stringify(body);
const path = (id: string) => `/api/huddles/${encodeURIComponent(id)}`;

export const huddlesApi = {
  list: (status: 'open' | 'closed' | 'all' = 'open', business?: string) =>
    requestJson<{ huddles: HuddleSummary[] }>(`/api/huddles?status=${status}${business ? `&business=${encodeURIComponent(business)}` : ''}`),
  get: (id: string) => requestJson<{ huddle: Huddle }>(path(id)),
  candidates: (id?: string) =>
    requestJson<{ bots: HuddleParticipant[] }>(`/api/huddles/candidates${id ? `?huddle=${encodeURIComponent(id)}` : ''}`),
  open: (body: { goal: string; why: string; members: string[]; lead?: string; dedupe_key?: string }) =>
    requestJson<{ huddle: Huddle; created: boolean; reused: boolean }>('/api/huddles', { method: 'POST', body: json(body) }),
  post: (id: string, body: { text: string; targets?: string[]; kind?: 'message' | 'handoff' | 'status' }) =>
    requestJson<{ message: HuddleMessage }>(`${path(id)}/messages`, { method: 'POST', body: json(body) }),
  invite: (id: string, conversationIds: string[]) =>
    requestJson<{ huddle: Huddle }>(`${path(id)}/members`, { method: 'POST', body: json({ conversation_ids: conversationIds }) }),
  remove: (id: string, conversationId: string) =>
    requestJson<{ huddle: Huddle }>(`${path(id)}/members/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }),
  patch: (id: string, body: { lead?: string; owner?: string | null; status_note?: string; goal?: string }) =>
    requestJson<{ huddle: Huddle }>(path(id), { method: 'PATCH', body: json(body) }),
  addAction: (id: string, body: { title: string; owner?: string | null; depends_on?: string[]; note?: string }) =>
    requestJson<{ huddle: Huddle }>(`${path(id)}/actions`, { method: 'POST', body: json(body) }),
  updateAction: (id: string, actionId: string, body: { status?: HuddleAction['status']; owner?: string | null; note?: string; title?: string }) =>
    requestJson<{ huddle: Huddle }>(`${path(id)}/actions/${encodeURIComponent(actionId)}`, { method: 'PATCH', body: json(body) }),
  close: (id: string, verification: string) =>
    requestJson<{ huddle: Huddle }>(`${path(id)}/close`, { method: 'POST', body: json({ verification }) }),
  reopen: (id: string, reason: string) =>
    requestJson<{ huddle: Huddle }>(`${path(id)}/reopen`, { method: 'POST', body: json({ reason }) }),
};

export function huddleStatusLabel(h: Pick<HuddleSummary, 'status' | 'owner' | 'open_action_count'>): string {
  if (h.status === 'closed') return 'Closed · verified complete';
  const owner = h.owner ? `${h.owner.name} has the ball` : 'No owner yet';
  return h.open_action_count ? `${owner} · ${h.open_action_count} open action${h.open_action_count === 1 ? '' : 's'}` : owner;
}

/** Turn @Name mentions typed in the composer into member ids; unknown names stay as text. */
export function mentionTargets(text: string, members: Pick<HuddleMember, 'conversation_id' | 'name' | 'left_at'>[]): string[] {
  const ids: string[] = [];
  for (const m of members) {
    if (m.left_at) continue;
    const pattern = new RegExp(`@${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(text)) ids.push(m.conversation_id);
  }
  return ids;
}
