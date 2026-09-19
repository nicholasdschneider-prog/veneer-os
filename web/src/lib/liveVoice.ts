export interface VoiceDecisionSummary {
  decisionId: string; version: number; state: string; createdAt: string; canAnswer: boolean; assignee: string;
  question: string; recommendation: string; consequence: string; blockedAction: string; blocksScope: string; deadline: string | null;
  answer: { action: string; scope: string; text: string } | null;
  result: { state: string; evidence: string } | null;
}
export interface VoiceSnapshot {
  configuration: { ready: boolean; missing: string[]; invalidUrl: boolean };
  call: { id: string; state: string; error: string | null; expiresAt: number; botConversationId: string | null; botName: string | null; decisionId: string | null } | null;
  bot: { conversationId: string; name: string; title: string | null; archived: boolean; role: string | null; subteam: string | null; team: string | null; canMessage: boolean } | null;
  decision: (VoiceDecisionSummary & { discussion: { from: string; text: string; at: string }[] }) | null;
  decisions: VoiceDecisionSummary[];
  blockers: { requestId: string; conversationId: string; title: string | null; createdAt: string;
    questions: { id: string; question: string; options: { label: string; value: string }[] }[] }[];
  chats: { id: string; title: string | null; projectName: string | null }[];
  history: { id: number; role: 'user' | 'assistant' | 'decision'; text: string; createdAt: string }[];
}
export async function voiceRequest<T>(path = '', body?: unknown, keepalive = false): Promise<T> {
  const response = await fetch(`/api/live-voice${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), keepalive,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Voice request failed.');
  return data as T;
}
/** Route to the call screen for one bot, optionally opened on a specific decision. */
export function botCallHash(conversationId: string, decisionId?: string | null) {
  return `#/bots/talk/${encodeURIComponent(conversationId)}${decisionId ? `?decision=${encodeURIComponent(decisionId)}` : ''}`;
}
