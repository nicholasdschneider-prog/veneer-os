import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findUserByEmail } from '../context.js';
import type { ConversationRow, ConversationWakeupRow, UserRow } from '../db/db.js';
import { canViewConversation } from '../conversations/access.js';
import {
  presentConversationEventForUser,
  presentConversationQueueForUser,
} from '../conversations/messageOriginPresentation.js';
import { markSeen, markTurnFinished } from '../conversations/unread.js';
import type {
  ConversationActivity,
  ConversationEvent,
  ConversationQueueSnapshot,
  ConversationStatus,
} from '../runtime/events.js';

/**
 * One multiplexed socket at /ws (spec §9):
 *   → {kind:'subscribe', conversationId} | {kind:'unsubscribe', conversationId}
 *   ← {kind:'snapshot', conversationId, events, status, activity, queue, wakeups}
 *   ← {kind:'event', conversationId, event}
 *   ← {kind:'status', conversationId, status}
 *   ← {kind:'usage_updated'}  (no conversation: "the provider meters moved")
 * Identity re-runs on the upgrade (Outpost lesson).
 */

const ClientFrameSchema = z.object({
  kind: z.enum(['subscribe', 'observe', 'unsubscribe', 'ping']),
  conversationId: z.string().optional(),
});

interface Sub {
  socket: WebSocket;
  user: UserRow;
  conversations: Set<string>;
  observers: Set<string>;
}

export function attachWebSocket(server: Server, ctx: AppContext): void {
  const wss = new WebSocketServer({ noServer: true });
  const subs = new Set<Sub>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Other paths (e.g. /ws/stt) are claimed by their own upgrade listener —
    // don't destroy a socket this module doesn't own.
    if (url.pathname !== '/ws') return;
    void (async () => {
      const identity = await ctx.resolveIdentity(req);
      const user = identity ? findUserByEmail(ctx.db, identity.email) : undefined;
      if (!user || user.status !== 'active') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, user: UserRow) => {
    const sub: Sub = { socket: ws, user, conversations: new Set(), observers: new Set() };
    subs.add(sub);

    ws.on('message', (data) => {
      let frame: z.infer<typeof ClientFrameSchema>;
      try {
        frame = ClientFrameSchema.parse(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (frame.kind === 'ping') {
        send(ws, { kind: 'pong' });
        return;
      }
      if (!frame.conversationId) return;
      if (frame.kind === 'unsubscribe') {
        sub.conversations.delete(frame.conversationId);
        sub.observers.delete(frame.conversationId);
        return;
      }
      const row = ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(frame.conversationId) as
        | ConversationRow
        | undefined;
      if (!row || !canViewConversation(user, row, ctx.db)) {
        send(ws, { kind: 'error', conversationId: frame.conversationId, message: 'Conversation not found' });
        return;
      }
      if (frame.kind === 'observe') {
        sub.conversations.delete(row.id);
        sub.observers.add(row.id);
        void ctx.manager.statusOf(row.id).then(status => {
          if (sub.observers.has(row.id)) send(ws, { kind: 'status', conversationId: row.id, status });
        }).catch(() => send(ws, { kind: 'error', conversationId: row.id, message: 'Activity unavailable' }));
        return;
      }
      sub.observers.delete(row.id);
      sub.conversations.add(row.id);
      markSeen(ctx.db, user.id, row.id);
      // The bus subscriptions below are already registered, so no live event is
      // lost while these RPCs are in flight.
      void Promise.all([
        ctx.manager.snapshot(row.id),
        ctx.manager.statusOf(row.id),
        ctx.manager.activityOf(row.id),
        ctx.manager.queueSnapshot(row.id),
        // A pending wake belongs to the chat, not the turn: the chip must be
        // right on first paint, not only after the next mutation.
        ctx.manager.listWakeups(row.id).catch(() => [] as ConversationWakeupRow[]),
      ])
        .then(([events, status, activity, queue, wakeups]) => {
          const current = ctx.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id) as ConversationRow | undefined;
          if (!sub.conversations.has(row.id) || !current || !canViewConversation(user, current, ctx.db)) return;
          send(ws, {
            kind: 'snapshot',
            conversationId: row.id,
            events: events.map((event) => presentConversationEventForUser(ctx.db, user, event)),
            status,
            activity,
            queue: presentConversationQueueForUser(ctx.db, user, queue),
            wakeups: wakeups.filter((wake) => wake.status === 'pending'),
          });
        })
        .catch((err: Error) => {
          send(ws, { kind: 'error', conversationId: row.id, message: err.message });
        });
    });

    ws.on('close', () => subs.delete(sub));
    ws.on('error', () => subs.delete(sub));
  });

  ctx.manager.bus.on('event', (conversationId: string, event: ConversationEvent) => {
    if (event.type === 'turn_done') {
      const row = ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
        | ConversationRow
        | undefined;
      if (row) {
        const viewers: number[] = [];
        for (const sub of subs) {
          if (sub.conversations.has(conversationId)) viewers.push(sub.user.id);
        }
        markTurnFinished(ctx.db, row, viewers);
      }
    }
    for (const sub of subs) {
      if (sub.observers.has(conversationId)) {
        // Presence observers receive no transcript content and never mark a chat read.
        send(sub.socket, { kind: 'presence', conversationId, event: { type: event.type, ...(event.type === 'text_delta' ? { text: event.text.trim() ? '…' : '' } : {}) } });
      }
      if (sub.conversations.has(conversationId)) {
        send(sub.socket, {
          kind: 'event',
          conversationId,
          event: presentConversationEventForUser(ctx.db, sub.user, event),
        });
      }
    }
  });
  ctx.manager.bus.on('status', (
    conversationId: string,
    status: ConversationStatus,
    activity: ConversationActivity = null,
  ) => {
    for (const sub of subs) {
      if (sub.conversations.has(conversationId) || sub.observers.has(conversationId)) {
        send(sub.socket, { kind: 'status', conversationId, status, activity });
      }
    }
  });
  ctx.manager.bus.on('queue', (conversationId: string, queue: ConversationQueueSnapshot) => {
    for (const sub of subs) {
      if (sub.conversations.has(conversationId)) {
        send(sub.socket, { kind: 'queue', conversationId, queue: presentConversationQueueForUser(ctx.db, sub.user, queue) });
      }
    }
  });
  ctx.manager.bus.on('wakeups', (conversationId: string, wakeups: ConversationWakeupRow[]) => {
    for (const sub of subs) {
      if (sub.conversations.has(conversationId)) {
        send(sub.socket, { kind: 'wakeups', conversationId, wakeups });
      }
    }
  });
  // Subscription meters moved (a turn's rate-limit telemetry, or a probe).
  // Everyone gets the nudge — it carries no data, and the /api/usage route the
  // client re-reads does its own admin check, so a member learns nothing.
  ctx.manager.bus.on('usage', () => {
    for (const sub of subs) send(sub.socket, { kind: 'usage_updated' });
  });
  ctx.manager.bus.on('access', (conversationId: string) => {
    const row = ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
      | ConversationRow
      | undefined;
    for (const sub of subs) {
      if (!sub.conversations.has(conversationId) && !sub.observers.has(conversationId)) continue;
      if (row && canViewConversation(sub.user, row, ctx.db)) continue;
      sub.conversations.delete(conversationId);
      sub.observers.delete(conversationId);
      send(sub.socket, { kind: 'error', conversationId, message: 'Conversation access changed' });
    }
  });
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket died mid-send */
  }
}
