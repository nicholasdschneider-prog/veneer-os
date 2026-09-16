import type { AgentMessageToolDetails } from './events.js';

const AGENT_SEND_MESSAGE_TOOL = 'mcp__agents__send_message';
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_ID_LENGTH = 500;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as UnknownRecord;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as UnknownRecord
      : null;
  } catch {
    return null;
  }
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function isAgentSendMessageTool(toolName: string): boolean {
  return toolName === AGENT_SEND_MESSAGE_TOOL;
}

/** Preserve only the destination and exact outbound text. Delivery state comes
 * from Veneer's authenticated receipt table, never from provider prose. */
export function agentMessageInputDetails(
  toolName: string,
  input: unknown,
): AgentMessageToolDetails | undefined {
  if (!isAgentSendMessageTool(toolName)) return undefined;
  const record = asRecord(input);
  if (!record) return undefined;
  const address = bounded(record.conversationId, MAX_ID_LENGTH);
  const text = bounded(record.text, MAX_MESSAGE_LENGTH);
  if (!address || !text) return undefined;

  return {
    kind: 'agent-message',
    text,
    targetConversationId: address,
  };
}
