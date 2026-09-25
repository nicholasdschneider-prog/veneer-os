import { isResultReplyDelivery } from './threadReplies';
import type { ConversationEvent } from './types';
import type { ConnectorToolSource } from './types';
import type { ConnectorToolDetails } from './types';
import type { SubagentStatus } from './types';
import type { QuestionAnswers, QuestionPrompt } from './types';
import type { MessageOrigin } from './types';
import type { AgentMessageToolDetails } from './types';
import { connectorToolPresentation } from './connectorTools';
import { normalizeResponseTokenUsage, type ResponseTokenUsage } from './responseMetadata';

// Reduces the normalized event stream into renderable chat items. Works for
// both rehydrated snapshots (no deltas) and live streams: text_delta
// accumulates into a streaming buffer; text_final replaces it.

export type ChatItem =
  | {
      kind: 'user';
      key: string;
      text: string;
      at?: string;
      turnId?: string;
      origin?: MessageOrigin;
      memories?: Array<{
        id?: string;
        content: string;
        similarity: number | null;
        scope: string;
        source?: string;
        relevance?: string;
      }>;
    }
  | {
      kind: 'assistant';
      key: string;
      markdown: string;
      turnId?: string;
      at?: string;
      usage?: ResponseTokenUsage;
    }
  | {
      kind: 'tool';
      key: string;
      label: string;
      actionLabel: string;
      toolName: string;
      source?: ConnectorToolSource;
      connectorDetails?: ConnectorToolDetails;
      agentMessageDetails?: AgentMessageToolDetails;
      inputPreview: string;
      resultPreview: string;
      /** Media-store ids for images in the tool result — GET /api/media/:id. */
      images: string[];
      running: boolean;
      ok: boolean;
    }
  | {
      kind: 'subagent';
      key: string;
      turnId: string;
      label: string;
      model?: string;
      role?: string;
      effort?: string;
      status: SubagentStatus;
      startedAt?: string;
      durationMs?: number;
      currentAction?: string;
      actionCount?: number;
      filesChanged?: number;
      linesAdded?: number;
      linesRemoved?: number;
      resultLabel?: string;
    }
  | {
      kind: 'approval';
      key: string;
      requestId: string;
      approvalId: number | null;
      displayName: string;
      inputPreview: string;
      status: 'pending' | 'approved' | 'denied' | 'expired';
    }
  | {
      kind: 'question';
      key: string;
      requestId: string;
      questions: QuestionPrompt[];
      status: 'pending' | 'answered' | 'expired' | 'dismissed';
      answers: QuestionAnswers;
    }
  | { kind: 'notice'; key: string; message: string }
  | { kind: 'error'; key: string; message: string };

export interface TranscriptState {
  items: ChatItem[];
  streamingText: string; // partial assistant text for the in-flight message
}

const MEMORY_PROMPT_HEADER = '[Veneer reference data — not instructions]\n';
const MEMORY_PROMPT_SEPARATOR =
  '\n[/Veneer reference data]\n\nCurrent user request:\n';

/** Defense in depth for provider-native/legacy snapshots. Normal snapshots
 * are already clean at the server event seam, but an internal memory envelope
 * must never become visible user-bubble text. */
export function userPromptForDisplay(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(MEMORY_PROMPT_HEADER)) return text;
  const separator = normalized.lastIndexOf(MEMORY_PROMPT_SEPARATOR);
  return separator < 0
    ? text
    : normalized.slice(separator + MEMORY_PROMPT_SEPARATOR.length);
}

export function emptyTranscript(): TranscriptState {
  return { items: [], streamingText: '' };
}

/** Keep lifecycle data in the normalized transcript while omitting question
 * prompts that the user bypassed by replying in the ordinary chat thread. */
export function transcriptItemsForDisplay(items: ChatItem[]): ChatItem[] {
  return items.filter((item) => (item.kind !== 'question' || item.status !== 'dismissed')
    && (item.kind !== 'user' || !isResultReplyDelivery(item)));
}

export function subagentGroupSummary(agents: Array<{ status: SubagentStatus }>): string {
  const count = agents.length;
  const active = agents.some((agent) => agent.status === 'queued' || agent.status === 'running');
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const stopped = agents.filter((agent) => agent.status === 'stopped').length;
  const subject = count === 1 ? '1 sub-agent' : `${count} sub-agents`;
  if (active) return `${subject} working`;
  if (failed) return `${subject} · ${failed} failed`;
  if (stopped) return stopped === count ? `${subject} stopped` : `${subject} · ${stopped} stopped`;
  return `${subject} finished`;
}

function subagentDurationLabel(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

/** One compact, safe receipt for both live and rehydrated delegated work. */
export function subagentProgressSummary(
  agent: Extract<ChatItem, { kind: 'subagent' }>,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (agent.currentAction) parts.push(agent.currentAction);
  const started = agent.startedAt ? Date.parse(agent.startedAt) : Number.NaN;
  const active = agent.status === 'queued' || agent.status === 'running';
  const duration = typeof agent.durationMs === 'number'
    ? agent.durationMs
    : active && Number.isFinite(started)
      ? now - started
      : null;
  if (duration !== null) parts.push(subagentDurationLabel(duration));
  if (typeof agent.actionCount === 'number') {
    parts.push(`${agent.actionCount} ${agent.actionCount === 1 ? 'action' : 'actions'}`);
  }
  if (typeof agent.filesChanged === 'number') {
    parts.push(`${agent.filesChanged} ${agent.filesChanged === 1 ? 'file changed' : 'files changed'}`);
  }
  if (typeof agent.linesAdded === 'number' || typeof agent.linesRemoved === 'number') {
    parts.push(`+${agent.linesAdded ?? 0}/−${agent.linesRemoved ?? 0}`);
  }
  if (agent.resultLabel) parts.push(agent.resultLabel);
  return parts.join(' · ');
}

function subagentStatus(value: unknown): SubagentStatus {
  return value === 'queued' || value === 'completed' || value === 'stopped' || value === 'failed'
    ? value
    : 'running';
}

function safeAgentMessageDetails(value: unknown): AgentMessageToolDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'agent-message' || typeof candidate.text !== 'string' || !candidate.text.trim()) {
    return undefined;
  }
  const disposition = candidate.disposition === 'running'
    || candidate.disposition === 'steered'
    || candidate.disposition === 'delivered'
    || candidate.disposition === 'queued'
    || candidate.disposition === 'duplicate'
    ? candidate.disposition
    : undefined;
  const messageId = typeof candidate.messageId === 'number'
    && Number.isSafeInteger(candidate.messageId)
    && candidate.messageId > 0
    ? candidate.messageId
    : undefined;
  const remoteInstance = typeof candidate.remoteInstance === 'string'
    ? candidate.remoteInstance.trim().slice(0, 100)
    : '';
  const rawTarget = candidate.targetChat;
  const target = rawTarget && typeof rawTarget === 'object' && !Array.isArray(rawTarget)
    ? rawTarget as Record<string, unknown>
    : null;
  const id = typeof target?.id === 'string' ? target.id.trim().slice(0, 200) : '';
  const title = typeof target?.title === 'string' ? target.title.trim().slice(0, 200) : '';
  const agentName = typeof target?.agentName === 'string' ? target.agentName.trim().slice(0, 120) : '';
  return {
    kind: 'agent-message',
    text: candidate.text.slice(0, 100_000),
    ...(remoteInstance ? { remoteInstance } : {}),
    ...(disposition ? { disposition } : {}),
    ...(messageId ? { messageId } : {}),
    ...(id && title && agentName ? { targetChat: { id, title, agentName } } : {}),
  };
}

type GmailSourceContext = { subject?: string; sender?: string };

function gmailContexts(items: ChatItem[]): {
  messages: Map<string, GmailSourceContext>;
  threads: Map<string, GmailSourceContext>;
} {
  const messages = new Map<string, GmailSourceContext>();
  const threads = new Map<string, GmailSourceContext>();
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const details = item.connectorDetails;
    if (
      details?.kind !== 'gmail-fetch-list' &&
      details?.kind !== 'gmail-fetch-thread' &&
      details?.kind !== 'gmail-fetch-message'
    ) continue;
    if (details.kind === 'gmail-fetch-message') {
      const context = { subject: details.subject, sender: details.sender };
      if (details.messageRef) messages.set(details.messageRef, context);
      if (details.threadRef) threads.set(details.threadRef, context);
      continue;
    }
    for (const message of details.messages ?? []) {
      const context = { subject: message.subject, sender: message.sender };
      if (message.messageRef) messages.set(message.messageRef, context);
      if (message.threadRef) threads.set(message.threadRef, context);
    }
    if (details.kind === 'gmail-fetch-thread' && details.threadRef) {
      threads.set(details.threadRef, {
        subject: details.subject,
        sender: details.latestSender,
      });
    }
  }
  return { messages, threads };
}

/** Add display context from preceding safe fetch receipts. Correlation keys are
 * opaque hashes; raw Gmail message/thread IDs never reach the web transcript. */
function correlateGmailDetails(details: ConnectorToolDetails, items: ChatItem[]): ConnectorToolDetails {
  const contexts = gmailContexts(items);
  if (details.kind === 'gmail-forward' && details.messageRef) {
    const source = contexts.messages.get(details.messageRef);
    if (!source) return details;
    return {
      ...details,
      ...(details.sourceSubject || !source.subject ? {} : { sourceSubject: source.subject }),
      ...(details.sourceSender || !source.sender ? {} : { sourceSender: source.sender }),
    };
  }
  if (details.kind === 'gmail-reply' && details.threadRef && !details.subject) {
    const source = contexts.threads.get(details.threadRef);
    return source?.subject ? { ...details, subject: source.subject } : details;
  }
  return details;
}

export function reduceEvents(state: TranscriptState, events: ConversationEvent[]): TranscriptState {
  const items = [...state.items];
  let streamingText = state.streamingText;
  let seq = items.length;

  for (const event of events) {
    if(typeof event.displaySequence==='number'&&Number.isSafeInteger(event.displaySequence))seq=event.displaySequence;
    switch (event.type) {
      case 'turn_started':
        const origin = event.origin;
        const validOrigin = origin
          && typeof origin === 'object'
          && ('kind' in origin)
          && (origin.kind === 'agent' || origin.kind === 'wakeup' || origin.kind === 'build_queue' || origin.kind === 'result_reply')
          && ('from' in origin)
          && typeof origin.from === 'string'
          && ('to' in origin)
          && typeof origin.to === 'string'
          ? {
              kind: origin.kind,
              from: origin.from,
              to: origin.to,
              ...(origin.kind === 'agent' && 'local' in origin && origin.local === true
                ? { local: true as const }
                : {}),
              ...(origin.kind === 'agent'
                && 'sourceChat' in origin
                && origin.sourceChat
                && typeof origin.sourceChat === 'object'
                && 'id' in origin.sourceChat
                && typeof origin.sourceChat.id === 'string'
                && origin.sourceChat.id.trim()
                && 'title' in origin.sourceChat
                && typeof origin.sourceChat.title === 'string'
                && origin.sourceChat.title.trim()
                ? {
                    sourceChat: {
                      id: origin.sourceChat.id.trim().slice(0, 200),
                      title: origin.sourceChat.title.trim().slice(0, 200),
                    },
                  }
                : {}),
            } satisfies MessageOrigin
          : undefined;
        items.push({
          kind: 'user',
          key: typeof event.messageId === 'number' && Number.isSafeInteger(event.messageId) && event.messageId > 0
            ? `u-message-${event.messageId}`
            : `u${seq++}`,
          text: userPromptForDisplay(String(event.text ?? '')),
          at: event.at ? String(event.at) : undefined,
          turnId: event.turnId ? String(event.turnId) : undefined,
          ...(validOrigin ? { origin: validOrigin } : {}),
        });
        streamingText = '';
        break;
      case 'text_delta':
        streamingText += String(event.text ?? '');
        break;
      case 'text_final': {
        const usage = normalizeResponseTokenUsage(event.usage);
        items.push({
          kind: 'assistant',
          key: `a${seq++}`,
          markdown: String(event.markdown ?? ''),
          ...(event.turnId ? { turnId: String(event.turnId) } : {}),
          ...(event.at ? { at: String(event.at) } : {}),
          ...(usage ? { usage } : {}),
        });
        streamingText = '';
        break;
      }
      case 'tool_started': {
        const presentation = connectorToolPresentation(
          String(event.toolName ?? ''),
          String(event.displayName ?? 'Working'),
          event.source as ConnectorToolSource | undefined,
        );
        const connectorDetails = event.connectorDetails
          ? correlateGmailDetails(event.connectorDetails as ConnectorToolDetails, items)
          : undefined;
        const agentMessageDetails = safeAgentMessageDetails(event.agentMessageDetails);
        items.push({
          kind: 'tool',
          key: `tool-${String(event.toolId ?? seq++)}`,
          label: `${presentation.label}…`,
          actionLabel: presentation.action,
          toolName: String(event.toolName ?? ''),
          ...(presentation.source ? { source: presentation.source } : {}),
          ...(connectorDetails ? { connectorDetails } : {}),
          ...(agentMessageDetails ? { agentMessageDetails } : {}),
          inputPreview: String(event.inputPreview ?? ''),
          resultPreview: '',
          images: [],
          running: true,
          ok: true,
        });
        break;
      }
      case 'tool_finished': {
        const key = `tool-${String(event.toolId ?? '')}`;
        const idx = items.findLastIndex((i) => i.kind === 'tool' && i.key === key);
        if (idx >= 0) {
          const tool = items[idx] as Extract<ChatItem, { kind: 'tool' }>;
          const connectorDetails = event.connectorDetails
            ? correlateGmailDetails({
                ...(tool.connectorDetails ?? {}),
                ...(event.connectorDetails as ConnectorToolDetails),
              } as ConnectorToolDetails, items.slice(0, idx))
            : tool.connectorDetails;
          const finishedAgentMessageDetails = safeAgentMessageDetails(event.agentMessageDetails);
          const agentMessageDetails = finishedAgentMessageDetails
            ? {
                ...(tool.agentMessageDetails ?? {}),
                ...finishedAgentMessageDetails,
              } as AgentMessageToolDetails
            : tool.agentMessageDetails;
          items[idx] = {
            ...tool,
            running: false,
            ok: Boolean(event.ok),
            label: tool.label.replace(/…$/, ''),
            resultPreview: String(event.resultPreview ?? ''),
            images: Array.isArray(event.images) ? event.images.map(String) : tool.images,
            ...(connectorDetails ? { connectorDetails } : {}),
            ...(agentMessageDetails ? { agentMessageDetails } : {}),
          };
        }
        break;
      }
      case 'subagent_started':
      case 'subagent_updated': {
        const agentKey = String(event.agentKey ?? '');
        if (!agentKey) break;
        const key = `subagent-${agentKey}`;
        const idx = items.findLastIndex((item) => item.kind === 'subagent' && item.key === key);
        const patch = {
          turnId: String(event.turnId ?? ''),
          ...(event.label ? { label: String(event.label) } : {}),
          ...(event.model ? { model: String(event.model) } : {}),
          ...(event.role ? { role: String(event.role) } : {}),
          ...(event.effort ? { effort: String(event.effort) } : {}),
          ...(event.startedAt ? { startedAt: String(event.startedAt) } : {}),
          ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
          ...(event.currentAction ? { currentAction: String(event.currentAction) } : {}),
          ...(typeof event.actionCount === 'number' ? { actionCount: event.actionCount } : {}),
          ...(typeof event.filesChanged === 'number' ? { filesChanged: event.filesChanged } : {}),
          ...(typeof event.linesAdded === 'number' ? { linesAdded: event.linesAdded } : {}),
          ...(typeof event.linesRemoved === 'number' ? { linesRemoved: event.linesRemoved } : {}),
          ...(typeof event.resultLabel === 'string' ? { resultLabel: event.resultLabel } : {}),
          status: subagentStatus(event.status),
        };
        if (idx >= 0) {
          const current = items[idx] as Extract<ChatItem, { kind: 'subagent' }>;
          items[idx] = { ...current, ...patch };
        } else {
          items.push({ kind: 'subagent', key, label: 'Delegated task', ...patch });
        }
        break;
      }
      case 'approval_requested': {
        items.push({
          kind: 'approval',
          key: `ap-${String(event.requestId ?? seq++)}`,
          requestId: String(event.requestId ?? ''),
          approvalId: typeof event.approvalId === 'number' ? event.approvalId : null,
          displayName: String(event.displayName ?? event.toolName ?? 'An action'),
          inputPreview: String(event.inputPreview ?? ''),
          status: 'pending',
        });
        break;
      }
      case 'approval_resolved': {
        const key = `ap-${String(event.requestId ?? '')}`;
        const idx = items.findLastIndex((i) => i.kind === 'approval' && i.key === key);
        if (idx >= 0) {
          const card = items[idx] as Extract<ChatItem, { kind: 'approval' }>;
          const outcome = String(event.outcome ?? 'expired');
          items[idx] = {
            ...card,
            status: outcome === 'approved' ? 'approved' : outcome === 'denied' ? 'denied' : 'expired',
          };
        }
        break;
      }
      case 'question_asked': {
        // The raw MCP tool row is useful only when the structured event never
        // arrives. Once represented, remove it so the user sees one question.
        const rawToolIdx = items.findLastIndex(
          (item) =>
            item.kind === 'tool' &&
            (item.toolName === 'mcp__agents__ask_user'
              || item.toolName === 'mcp__agents__request_secret'
              || item.toolName === 'mcp__agents__reveal_secret'),
        );
        if (rawToolIdx >= 0) items.splice(rawToolIdx, 1);
        const questions = Array.isArray(event.questions)
          ? (event.questions as QuestionPrompt[])
          : [{
              id: 'q1',
              question: String(event.question ?? ''),
              options: Array.isArray(event.options)
                ? (event.options as unknown[]).map((option) => {
                    const obj = (option ?? {}) as { label?: unknown; value?: unknown; description?: unknown };
                    const label = String(obj.label ?? '');
                    return {
                      label,
                      value: String(obj.value ?? label),
                      ...(obj.description ? { description: String(obj.description) } : {}),
                    };
                  })
                : [],
              multi: Boolean(event.multi),
              allowOther: false,
            }];
        items.push({
          kind: 'question',
          key: `q-${String(event.requestId ?? seq++)}`,
          requestId: String(event.requestId ?? ''),
          questions,
          status: 'pending',
          answers: {},
        });
        break;
      }
      case 'question_answered': {
        const key = `q-${String(event.requestId ?? '')}`;
        const idx = items.findLastIndex((i) => i.kind === 'question' && i.key === key);
        if (idx >= 0) {
          const card = items[idx] as Extract<ChatItem, { kind: 'question' }>;
          // dismissed (user chatted instead) wins over expired.
          const status = event.dismissed ? 'dismissed' : event.expired ? 'expired' : 'answered';
          const answers = event.answers && typeof event.answers === 'object'
            ? (event.answers as QuestionAnswers)
            : card.questions[0]
              ? { [card.questions[0].id]: [String(event.answer ?? '')].filter(Boolean) }
              : {};
          items[idx] = { ...card, status, answers };
        }
        break;
      }
      case 'turn_done': {
        const usage = normalizeResponseTokenUsage(event.usage);
        if (usage) {
          const turnId = event.turnId ? String(event.turnId) : '';
          const idx = items.findLastIndex(
            (item) => item.kind === 'assistant' && (!turnId || item.turnId === turnId),
          );
          if (idx >= 0) {
            const assistant = items[idx] as Extract<ChatItem, { kind: 'assistant' }>;
            // Claude reloads attach whole-turn usage to the final text event.
            // Completion usage is the fallback for providers that report only
            // at the turn boundary (Codex and live streams).
            if (!assistant.usage) items[idx] = { ...assistant, usage };
          }
        }
        streamingText = '';
        break;
      }
      case 'memory_recall': {
        const turnId = event.turnId ? String(event.turnId) : '';
        const memories = Array.isArray(event.memories)
          ? (event.memories as unknown[]).map((m) => {
              const obj = (m ?? {}) as {
                id?: unknown;
                content?: unknown;
                similarity?: unknown;
                scope?: unknown;
                source?: unknown;
                relevance?: unknown;
              };
              return {
                id: typeof obj.id === 'string' ? obj.id : undefined,
                content: String(obj.content ?? ''),
                similarity: typeof obj.similarity === 'number' ? obj.similarity : null,
                scope: String(obj.scope ?? ''),
                source: typeof obj.source === 'string' ? obj.source : undefined,
                relevance: typeof obj.relevance === 'string' ? obj.relevance : undefined,
              };
            })
          : [];
        // Match the originating user turn; fall back to the latest user prompt
        // when no turnId lines up. Setting `memories` is idempotent — the same
        // recall may arrive twice (once live, once via a snapshot merge).
        let idx = turnId
          ? items.findLastIndex((i) => i.kind === 'user' && i.turnId === turnId)
          : -1;
        if (idx < 0) idx = items.findLastIndex((i) => i.kind === 'user');
        if (idx >= 0) {
          const user = items[idx] as Extract<ChatItem, { kind: 'user' }>;
          items[idx] = { ...user, memories };
        }
        break;
      }
      case 'notice':
        items.push({ kind: 'notice', key: `n${seq++}`, message: String(event.message ?? '') });
        break;
      case 'context_compacted': {
        const message = typeof event.notice === 'string' ? event.notice.trim() : '';
        const previous = items.at(-1);
        if (message && (previous?.kind !== 'notice' || previous.message !== message)) {
          items.push({ kind: 'notice', key: `n${seq++}`, message });
        }
        break;
      }
      case 'error':
        items.push({ kind: 'error', key: `e${seq++}`, message: String(event.message ?? 'Something went wrong') });
        break;
      default:
        break; // thinking, future event types
    }
  }

  return { items, streamingText };
}
