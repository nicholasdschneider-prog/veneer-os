import type { ConversationEvent } from '../runtime/events.js';

const MAX_LINE = 600;
const MAX_TOTAL = 4000;
const MAX_ITEMS = 8;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The last few exchanges of the parent chat, newest last, as plain lines. */
export function recentExchangeExcerpt(events: ConversationEvent[], agentName: string): string {
  const lines: string[] = [];
  for (let i = events.length - 1; i >= 0 && lines.length < MAX_ITEMS; i--) {
    const event = events[i]!;
    if (event.type === 'turn_started' && event.text.trim()) lines.unshift(`User: ${clip(event.text, MAX_LINE)}`);
    else if (event.type === 'text_final' && event.markdown.trim()) lines.unshift(`${agentName}: ${clip(event.markdown, MAX_LINE)}`);
  }
  let out = lines.join('\n');
  if (out.length > MAX_TOTAL) out = `…${out.slice(out.length - MAX_TOTAL)}`;
  return out;
}

export function sideChatOpeningMessage(input: {
  parentId: string;
  parentTitle: string | null;
  agentName: string;
  status: string;
  events: ConversationEvent[];
  question: string;
}): string {
  const title = input.parentTitle?.trim() || 'Untitled chat';
  const excerpt = recentExchangeExcerpt(input.events, input.agentName);
  return [
    `[Side chat] This is a side conversation about the chat "${title}" (id ${input.parentId}). Its agent, ${input.agentName}, is currently ${input.status === 'working' ? 'working on a turn' : input.status}. The user wants to ask about that work without interrupting it.`,
    `Rules: do not send messages to that chat and do not change files or external systems it is working on. Answer from the context below; when you need more detail, call the read_conversation tool with conversationId "${input.parentId}". Keep replies focused and short unless asked otherwise.`,
    excerpt ? `Recent exchange in that chat:\n${excerpt}` : 'That chat has no messages yet.',
    `---\n${input.question.trim()}`,
  ].join('\n\n');
}
