// Dedicated WebSocket for the browser terminal (/ws/term) — deliberately
// separate from the multiplexed wsBus in ws.ts. One TermSocket owns one
// socket for one pty scope; the server keeps the pty alive across
// disconnects and replays buffered output on (re)attach, so reconnecting is
// just "open the same URL again" (the screen clears before writing replay).

const RECONNECT_BACKOFF_MS = [800, 2_000, 5_000, 10_000, 30_000];
const PING_INTERVAL_MS = 25_000;

export type TermScope = { scope: 'universal' } | { scope: 'project'; projectId: string };
export type TermStatus = 'connecting' | 'open' | 'closed';

interface TermServerFrame {
  t?: 'ready' | 'output' | 'exit' | 'pong' | 'error';
  replay?: string;
  cols?: number;
  rows?: number;
  data?: string;
  code?: number;
  message?: string;
}

export class TermSocket {
  onReady: ((replay: string, cols: number, rows: number) => void) | null = null;
  onOutput: ((data: string) => void) | null = null;
  onExit: ((code: number) => void) | null = null;
  /** Fatal server error (e.g. "Terminal opened elsewhere") — no auto-reconnect after this. */
  onErrorMsg: ((message: string) => void) | null = null;
  onStatus: ((status: TermStatus) => void) | null = null;

  private readonly target: TermScope;
  private cols: number;
  private rows: number;
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private fatal = false;

  constructor(target: TermScope, cols: number, rows: number) {
    this.target = target;
    this.cols = cols;
    this.rows = rows;
  }

  connect(): void {
    if (this.disposed || this.fatal) return;
    this.open();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    const ws = this.socket;
    this.socket = null;
    try {
      ws?.close();
    } catch {
      /* already closing */
    }
  }

  sendInput(data: string): void {
    this.send({ t: 'input', data });
  }

  sendResize(cols: number, rows: number): void {
    // Remember the latest size so a reconnect attaches with current dims.
    this.cols = cols;
    this.rows = rows;
    this.send({ t: 'resize', cols, rows });
  }

  sendRestart(): void {
    this.send({ t: 'restart' });
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private open(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.onStatus?.('connecting');
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams();
    qs.set('scope', this.target.scope);
    if (this.target.scope === 'project') qs.set('project', this.target.projectId);
    qs.set('cols', String(this.cols));
    qs.set('rows', String(this.rows));
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${scheme}://${window.location.host}/ws/term?${qs.toString()}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.addEventListener('open', () => {
      if (this.socket !== ws) return;
      this.reconnectAttempt = 0;
      this.onStatus?.('open');
      this.stopPing();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.send({ t: 'ping' });
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      if (this.socket !== ws) return;
      let frame: TermServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as TermServerFrame;
      } catch {
        return;
      }
      switch (frame.t) {
        case 'ready':
          this.onReady?.(frame.replay ?? '', frame.cols ?? this.cols, frame.rows ?? this.rows);
          break;
        case 'output':
          if (typeof frame.data === 'string') this.onOutput?.(frame.data);
          break;
        case 'exit':
          this.onExit?.(frame.code ?? 0);
          break;
        case 'error':
          // Fatal (e.g. takeover by another tab). The server closes the
          // socket after this; do NOT fight it with reconnects.
          this.fatal = true;
          this.onErrorMsg?.(frame.message ?? 'Terminal error');
          break;
        case 'pong':
        default:
          break;
      }
    });

    const onDown = (): void => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.stopPing();
      if (this.disposed) return;
      this.onStatus?.('closed');
      if (!this.fatal) this.scheduleReconnect();
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
    if (this.reconnectTimer || this.disposed || this.fatal) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      /* socket died */
    }
  }
}
