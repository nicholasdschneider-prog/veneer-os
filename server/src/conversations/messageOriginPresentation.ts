import type Database from 'better-sqlite3';
import type { ConversationRow, UserRow } from '../db/db.js';
import type {
  AgentMessageToolDetails,
  ConversationEvent,
  ConversationQueueSnapshot,
  MessageOrigin,
} from '../runtime/events.js';
import { canViewConversation } from './access.js';

function presentMessageOrigin(
  db: Database.Database,
  user: Pick<UserRow, 'id'>,
  origin: MessageOrigin,
): MessageOrigin {
  const presented: MessageOrigin = {
    kind: origin.kind,
    from: origin.from,
    to: origin.to,
  };
  if (origin.kind !== 'agent' || !origin.sourceConversationId) return presented;

  const source = db.prepare('SELECT * FROM conversations WHERE id = ?').get(origin.sourceConversationId) as
    | ConversationRow
    | undefined;
  if (!source) return presented;

  const localPresented: MessageOrigin = { ...presented, local: true };
  if (!canViewConversation(user, source)) return localPresented;

  const title = source.title?.trim() || origin.sourceConversationTitle?.trim() || 'Untitled chat';
  return {
    ...localPresented,
    sourceChat: { id: source.id, title },
  };
}

function presentAgentMessageDetails(
  db: Database.Database,
  user: Pick<UserRow, 'id'>,
  details: AgentMessageToolDetails,
): AgentMessageToolDetails {
  const presented: AgentMessageToolDetails = {
    kind: 'agent-message',
    text: details.text,
    ...(details.remoteInstance ? { remoteInstance: details.remoteInstance } : {}),
    ...(details.disposition ? { disposition: details.disposition } : {}),
  };
  if (!details.targetConversationId) return presented;

  const target = db.prepare(
    `SELECT c.*, a.name AS agent_name
       FROM conversations c
       JOIN assistants a ON a.id = c.assistant_id
      WHERE c.id = ?`,
  ).get(details.targetConversationId) as (ConversationRow & { agent_name: string }) | undefined;
  if (!target || !canViewConversation(user, target)) return presented;

  return {
    ...presented,
    ...(details.messageId ? { messageId: details.messageId } : {}),
    targetChat: {
      id: target.id,
      title: target.title?.trim() || 'Untitled chat',
      agentName: target.agent_name?.trim() || 'Agent',
    },
  };
}

/** Convert internal provenance into the metadata this specific viewer may see. */
export function presentConversationEventForUser(
  db: Database.Database,
  user: Pick<UserRow, 'id'>,
  event: ConversationEvent,
): ConversationEvent {
  if (event.type === 'turn_started' && event.origin) {
    return {
      ...event,
      origin: presentMessageOrigin(db, user, event.origin),
    };
  }
  if (
    (event.type === 'tool_started' || event.type === 'tool_finished')
    && event.agentMessageDetails
  ) {
    return {
      ...event,
      agentMessageDetails: presentAgentMessageDetails(db, user, event.agentMessageDetails),
    };
  }
  return event;
}

/** Same privacy rule for queued messages that another agent sent. */
export function presentConversationQueueForUser(
  db: Database.Database,
  user: Pick<UserRow, 'id'>,
  queue: ConversationQueueSnapshot,
): ConversationQueueSnapshot {
  if (!queue.messages.some((message) => message.origin)) return queue;
  return {
    ...queue,
    messages: queue.messages.map((message) =>
      message.origin ? { ...message, origin: presentMessageOrigin(db, user, message.origin) } : message,
    ),
  };
}
