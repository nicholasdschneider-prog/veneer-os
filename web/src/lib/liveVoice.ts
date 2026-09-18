export interface VoiceSnapshot {
  configuration: { ready: boolean; missing: string[]; invalidUrl: boolean };
  call: { id: string; state: string; error: string | null; expiresAt: number } | null;
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
