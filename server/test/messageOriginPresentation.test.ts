import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  presentConversationEventForUser,
  presentConversationQueueForUser,
} from '../src/conversations/messageOriginPresentation.js';
import { migrate } from '../src/db/migrate.js';
import type { ConversationEvent } from '../src/runtime/events.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

describe('message origin presentation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
       VALUES ('private-source', 1, 1, 'private', 'Private planning', 'codex', 'native-private', 'web'),
              ('team-source', 1, 1, 'team', 'Shared research', 'codex', 'native-team', 'web')`,
    ).run();
  });

  afterEach(() => db.close());

  const eventFrom = (sourceConversationId?: string): ConversationEvent => ({
    type: 'turn_started',
    turnId: 'turn-1',
    role: 'user',
    text: 'Please continue.',
    at: '2026-08-24T12:00:00.000Z',
    via: 'web',
    origin: {
      kind: 'agent',
      from: 'Assistant',
      to: 'Assistant',
      ...(sourceConversationId ? { sourceConversationId } : {}),
      ...(sourceConversationId ? { sourceConversationTitle: 'Send-time title' } : {}),
    },
  });

  it('resolves a linked title only when the viewer can access the source chat', () => {
    const owner = { id: 1 };
    const member = { id: 2 };

    expect(presentConversationEventForUser(db, owner, eventFrom('private-source'))).toMatchObject({
      origin: { local: true, sourceChat: { id: 'private-source', title: 'Private planning' } },
    });
    expect(presentConversationEventForUser(db, member, eventFrom('team-source'))).toMatchObject({
      origin: { local: true, sourceChat: { id: 'team-source', title: 'Shared research' } },
    });
  });

  it('strips inaccessible and internal source metadata for a Team viewer', () => {
    const presented = presentConversationEventForUser(db, { id: 2 }, eventFrom('private-source'));

    expect(presented).toMatchObject({
      origin: { kind: 'agent', from: 'Assistant', to: 'Assistant', local: true },
    });
    expect(JSON.stringify(presented)).not.toContain('private-source');
    expect(JSON.stringify(presented)).not.toContain('Private planning');
    expect(JSON.stringify(presented)).not.toContain('Send-time title');
    expect(presented.type === 'turn_started' ? presented.origin : undefined).not.toHaveProperty('sourceConversationId');
    expect(presented.type === 'turn_started' ? presented.origin : undefined).not.toHaveProperty('sourceConversationTitle');
    expect(presented.type === 'turn_started' ? presented.origin : undefined).not.toHaveProperty('sourceChat');
  });

  it('keeps a remote origin non-linked and strips unexpected raw provenance', () => {
    const presented = presentConversationEventForUser(db, { id: 2 }, {
      ...eventFrom(),
      origin: {
        kind: 'agent',
        from: 'Remote agent',
        to: 'Assistant',
        sourceConversationId: 'missing-local-chat',
      },
    });

    expect(presented.type === 'turn_started' ? presented.origin : undefined).toEqual({
      kind: 'agent',
      from: 'Remote agent',
      to: 'Assistant',
    });
  });

  it('applies the same source rule to agent-queued messages', () => {
    const queue = {
      revision: 1,
      failedTurn: null,
      messages: [
        { id: 1, text: 'human', createdAt: '2026-08-24T12:00:00.000Z' },
        {
          id: 2,
          text: 'from agent',
          createdAt: '2026-08-24T12:01:00.000Z',
          origin: {
            kind: 'agent' as const,
            from: 'Assistant',
            to: 'Assistant',
            sourceConversationId: 'private-source',
            sourceConversationTitle: 'Send-time title',
          },
        },
      ],
    };

    const forOwner = presentConversationQueueForUser(db, { id: 1 }, queue);
    expect(forOwner.messages[0]).not.toHaveProperty('origin');
    expect(forOwner.messages[1]!.origin).toEqual({
      kind: 'agent',
      from: 'Assistant',
      to: 'Assistant',
      local: true,
      sourceChat: { id: 'private-source', title: 'Private planning' },
    });

    const forMember = presentConversationQueueForUser(db, { id: 2 }, queue);
    expect(forMember.messages[1]!.origin).toEqual({
      kind: 'agent',
      from: 'Assistant',
      to: 'Assistant',
      local: true,
    });
    expect(JSON.stringify(forMember)).not.toContain('sourceConversation');
  });

  it('resolves sender-side target metadata only for viewers who can open that chat', () => {
    const event: ConversationEvent = {
      type: 'tool_finished',
      turnId: 'turn-1',
      toolId: 'send-1',
      ok: true,
      agentMessageDetails: {
        kind: 'agent-message',
        text: 'Exact outbound message.',
        targetConversationId: 'private-source',
        disposition: 'steered',
        messageId: 42,
      },
    };

    expect(presentConversationEventForUser(db, { id: 1 }, event)).toMatchObject({
      agentMessageDetails: {
        text: 'Exact outbound message.',
        disposition: 'steered',
        messageId: 42,
        targetChat: { id: 'private-source', title: 'Private planning', agentName: 'Assistant' },
      },
    });

    const memberView = presentConversationEventForUser(db, { id: 2 }, event);
    expect(memberView).toMatchObject({
      agentMessageDetails: {
        kind: 'agent-message',
        text: 'Exact outbound message.',
        disposition: 'steered',
      },
    });
    expect(JSON.stringify(memberView)).not.toContain('private-source');
    expect(JSON.stringify(memberView)).not.toContain('Private planning');
    expect(JSON.stringify(memberView)).not.toContain('targetConversationId');
    expect(JSON.stringify(memberView)).not.toContain('messageId');
  });

  it('passes the delivered disposition through untouched', () => {
    const event: ConversationEvent = {
      type: 'tool_finished',
      turnId: 'turn-1',
      toolId: 'send-1',
      ok: true,
      agentMessageDetails: {
        kind: 'agent-message',
        text: 'Exact outbound message.',
        targetConversationId: 'private-source',
        disposition: 'delivered',
        messageId: 43,
      },
    };
    expect(presentConversationEventForUser(db, { id: 1 }, event)).toMatchObject({
      agentMessageDetails: { disposition: 'delivered', messageId: 43 },
    });
  });
});
