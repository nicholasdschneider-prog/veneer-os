import type { ConversationEvent, SubagentStatus } from '../../runtime/events.js';
import { subagentEventKey, subagentLabel } from '../../runtime/subagents.js';

export const CLAUDE_SUBAGENT_TOOL = 'Agent';

interface AgentInput {
  description?: unknown;
  subagent_type?: unknown;
  model?: unknown;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function claudeSubagentKey(toolUseId: string): string {
  return subagentEventKey('claude', toolUseId);
}

export function claudeSubagentStarted(
  turnId: string,
  toolUseId: string,
  input: unknown,
  startedAt?: string,
): Extract<ConversationEvent, { type: 'subagent_started' }> {
  const agent = input && typeof input === 'object' ? (input as AgentInput) : {};
  const model = optionalText(agent.model);
  const role = optionalText(agent.subagent_type);
  return {
    type: 'subagent_started',
    turnId,
    agentKey: claudeSubagentKey(toolUseId),
    label: subagentLabel(agent.description),
    ...(model ? { model } : {}),
    ...(role ? { role } : {}),
    ...(startedAt ? { startedAt } : {}),
    currentAction: 'Starting',
    status: 'running',
  };
}

function tag(text: string, name: string): string | null {
  return text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
}

type ClaudeTerminalSubagentStatus = Extract<SubagentStatus, 'completed' | 'stopped' | 'failed'>;

function taskStatus(value: string): ClaudeTerminalSubagentStatus | null {
  switch (value.trim().toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'killed':
    case 'stopped':
    case 'interrupted':
    case 'cancelled':
      return 'stopped';
    case 'failed':
    case 'errored':
    case 'error':
      return 'failed';
    default:
      return null;
  }
}

export function claudeAgentLaunchStatus(status: unknown, isError: boolean): SubagentStatus {
  if (isError) return 'failed';
  if (typeof status !== 'string') return 'running';
  switch (status.trim().toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'errored':
    case 'error':
      return 'failed';
    case 'killed':
    case 'stopped':
    case 'interrupted':
    case 'cancelled':
      return 'stopped';
    default:
      // async_launched and successful launch acknowledgements are not child
      // completion signals; the task notification owns that transition.
      return 'running';
  }
}

export interface ClaudeTaskNotification {
  toolUseId: string;
  status: ClaudeTerminalSubagentStatus;
}

/** Parse only Claude's exact background-task envelope, never arbitrary XML-ish user text. */
export function parseClaudeTaskNotification(text: string): ClaudeTaskNotification | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<task-notification>') || !trimmed.endsWith('</task-notification>')) return null;
  const toolUseId = tag(trimmed, 'tool-use-id');
  const rawStatus = tag(trimmed, 'status');
  const status = rawStatus ? taskStatus(rawStatus) : null;
  return toolUseId && status ? { toolUseId, status } : null;
}
