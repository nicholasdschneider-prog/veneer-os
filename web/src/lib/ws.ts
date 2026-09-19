import type {
  ConversationActivity,
  ConversationEvent,
  ConversationQueueSnapshot,
  ConversationStatus,
  PendingWakeup,
} from './types';
import { toPendingWakeups, type WakeupRow } from './wakeups';

// One multiplexed WebSocket for the whole app (spec §9), with reconnect
// backoff + resubscribe. Pattern ported from Veneer's transcriptSocket.js:
// server resends a fresh snapshot on every (re)subscribe, so consumers need
// no reconnect bookkeeping; wake on visibility/online.

const RECONNECT_BACKOFF_MS = [800, 2_000, 5_000, 10_000, 30_000];
const PING_INTERVAL_MS = 25_000;

export interface SubscriptionHandlers {
  presenceOnly?: boolean;
  onSnapshot?: (
    events: ConversationEvent[],
    status: ConversationStatus,
    queue: ConversationQueueSnapshot,
    activity: ConversationActivity,
    wakeups: PendingWakeup[],
  ) => void;
  onEvent?: (event: ConversationEvent) => void;
  onStatus?: (status: ConversationStatus, activity: ConversationActivity) => void;
  onQueue?: (queue: ConversationQueueSnapshot) => void;
  onWakeups?: (wakeups: PendingWakeup[]) => void;
  onError?: (message: string) => void;
  onDisconnect?: () => void;
}

/**
 * Frames that belong to the whole app rather than one conversation (today just
 * `usage_updated`, the runner's "new rate-limit telemetry landed" nudge).
 */
export type GlobalFrameKind = 'usage_updated';

export interface ServerFrame {
  kind: 'snapshot' | 'presence' | 'event' | 'status' | 'queue' | 'wakeups' | 'error' | 'pong' | GlobalFrameKind;
  conversationId?: string;
  events?: ConversationEvent[];
  event?: ConversationEvent;
  status?: ConversationStatus;
  activity?: ConversationActivity;
  queue?: ConversationQueueSnapshot;
  wakeups?: WakeupRow[];
  message?: string;
}

export function deliverServerFrame(frame: ServerFrame, handlers: SubscriptionHandlers): void {
  if (frame.kind === 'snapshot' && frame.events) {
    handlers.onSnapshot?.(
      frame.events,
      frame.status ?? 'idle',
      frame.queue ?? { revision: 0, messages: [], failedTurn: null },
      frame.activity ?? null,
      toPendingWakeups(frame.wakeups),
    );
  } else if (frame.kind === 'presence' && frame.event && handlers.presenceOnly) handlers.onEvent?.(frame.event);
  else if (frame.kind === 'event' && frame.event) handlers.onEvent?.(frame.event);
  else if (frame.kind === 'status' && frame.status) handlers.onStatus?.(frame.status, frame.activity ?? null);
  else if (frame.kind === 'queue' && frame.queue) handlers.onQueue?.(frame.queue);
  else if (frame.kind === 'wakeups' && frame.wakeups) handlers.onWakeups?.(toPendingWakeups(frame.wakeups));
  else if (frame.kind === 'error' && frame.message) handlers.onError?.(frame.message);
}

class WsBus {
  private socket: WebSocket | null = null;
  private subs = new Map<string, Set<SubscriptionHandlers>>();
  private globalHandlers = new Set<(kind: GlobalFrameKind) => void>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  subscribe(conversationId: string, handlers: SubscriptionHandlers): () => void {
    let set = this.subs.get(conversationId);
    if (!set) {
      set = new Set();
      this.subs.set(conversationId, set);
    }
    set.add(handlers);
    this.ensureStarted();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ kind: [...(this.subs.get(conversationId) ?? [])].every(h => h.presenceOnly) ? 'observe' : 'subscribe', conversationId });
    } else if (!this.socket || this.socket.readyState !== WebSocket.CONNECTING) {
      // Socket died (or never opened) while no subs were active, so onDown
      // nulled it and scheduleReconnect() bailed on subs.size === 0. Reopen
      // now; open()'s guard prevents dupes and its handler resubscribes.
      this.reconnectAttempt = 0;
      this.open();
    }
    return () => {
      const s = this.subs.get(conversationId);
      s?.delete(handlers);
      if (s?.size && this.socket?.readyState === WebSocket.OPEN) {
        this.send({ kind: [...s].every(h => h.presenceOnly) ? 'observe' : 'subscribe', conversationId });
      }
      if (s && s.size === 0) {
        this.subs.delete(conversationId);
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.send({ kind: 'unsubscribe', conversationId });
        }
      }
    };
  }

  /**
   * Listen for conversation-less frames. Deliberately does NOT open the socket:
   * a nav-bar listener must not hold a WebSocket open on every screen. It hears
   * pushes whenever a chat subscription already has one up — which is exactly
   * when usage moves — and the hook's own staleness re-probe covers the rest.
   */
  subscribeGlobal(handler: (kind: GlobalFrameKind) => void): () => void {
    this.globalHandlers.add(handler);
    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
    this.open();
  }

  private wake = (): void => {
    if (document.hidden) return;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.open();
  };

  private open(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${scheme}://${window.location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.addEventListener('open', () => {
      if (this.socket !== ws) return;
      this.reconnectAttempt = 0;
      // Resubscribe everything; the server responds with fresh snapshots.
      for (const conversationId of this.subs.keys()) {
        this.send({ kind: [...(this.subs.get(conversationId) ?? [])].every(h => h.presenceOnly) ? 'observe' : 'subscribe', conversationId });
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.send({ kind: 'ping' });
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      if (this.socket !== ws) return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.kind === 'usage_updated') {
        for (const handler of this.globalHandlers) {
          try {
            handler(frame.kind);
          } catch {
            /* handler's problem */
          }
        }
        return;
      }
      if (!frame.conversationId) return;
      const handlers = this.subs.get(frame.conversationId);
      if (!handlers) return;
      for (const h of handlers) {
        try {
          deliverServerFrame(frame, h);
        } catch {
          /* handler's problem */
        }
      }
    });

    const onDown = (): void => {
      // Only tear down state we own: a superseded socket must not clear the
      // live socket's keepalive.
      if (this.socket !== ws) return;
      this.socket = null;
      for (const handlers of this.subs.values()) for (const h of handlers) {
        try { h.onDisconnect?.(); } catch { /* isolate subscribers */ }
      }
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.scheduleReconnect();
    };
    ws.addEventListener('close', onDown);
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.subs.size === 0) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private send(frame: unknown): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      /* socket died */
    }
  }
}

export const wsBus = new WsBus();
