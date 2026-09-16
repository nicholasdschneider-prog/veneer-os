import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

/**
 * Agent Client Protocol (ACP) framing for `grok agent … stdio`. JSON-RPC 2.0,
 * one NDJSON line per message — verified live 2026-08-12 against grok 1.0.3
 * (`grok 1.0.3 (1a29d5bc12d4)`):
 *   - {id, method, params} + we must reply   → a request FROM the agent
 *   - {method, params}, no id                → a notification (no reply)
 *   - {id, result} or {id, error}            → a response TO one of our requests
 *
 * Like `codex app-server`, this is a genuine bidirectional long-lived server:
 * one process is spawned per access level and multiplexes every conversation
 * over the same stdin/stdout, routed by `params.sessionId`.
 *
 * Methods the 1.0.3 gateway accepts (probed: an unknown method answers
 * `-32601 Method not found`, a known one with bad arguments answers `-32602`):
 * `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`,
 * `session/cancel`, `session/set_model`.
 */

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ServerMessageHandler = (msg: JsonRpcMessage) => void;

/** Sent to every subscribed session handler if the underlying process dies mid-turn. */
export const DISCONNECTED_METHOD = '__grok_acp_disconnected__';

/**
 * `--always-approve` because Veneer owns the permission story at its own seam;
 * the OS-level sandbox profile (GROK_SANDBOX, set per access level by the
 * adapter) is what actually constrains a non-Full-Access agent.
 *
 * `--no-leader` because Grok can be configured — via `[cli] use_leader` in a
 * config.toml we do not fully control — to attach every client to ONE shared
 * backend process. Sharing a backend across access levels would put a Full
 * Access agent and a sandboxed agent in the same process; this forces a private
 * backend per spawn. (Requesting a non-`off` sandbox profile also refuses
 * leader mode, but we do not want to depend on that as the only guard.)
 */
export const ACP_ARGS = ['agent', '--always-approve', '--no-leader', 'stdio'] as const;

/** Per-model entry of `initialize` → `result._meta.modelState.availableModels`. */
export interface GrokReasoningEffortOption {
  id?: string;
  value?: string;
}

export interface GrokAvailableModel {
  modelId?: string;
  name?: string;
  description?: string;
  _meta?: {
    totalContextTokens?: number;
    supportsReasoningEffort?: boolean;
    /** Effort the agent applies when none is picked. Live 1.0.3 default is `high`. */
    reasoningEffort?: string;
    reasoningEfforts?: GrokReasoningEffortOption[];
  };
}

export interface GrokInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: { id?: string; name?: string }[];
  _meta?: {
    modelState?: {
      currentModelId?: string;
      availableModels?: GrokAvailableModel[];
    };
  };
}

export interface AcpClientOptions {
  grokBin: string;
  /**
   * Environment for the agent process. Grok runs the agent's shell commands as
   * its own children and applies its kernel sandbox to the whole process tree,
   * so this — not a per-session argument — decides both which HOME those
   * commands see and how confined they are. Hence one client per access level.
   */
  env?: NodeJS.ProcessEnv;
  /** Cwd for the agent process. Sessions carry their own cwd; this is only a default. */
  cwd?: string;
  log?: Pick<Console, 'warn' | 'error'>;
  /** Called once per spawn, before the process starts (profile lockdown). */
  onBeforeSpawn?: () => void;
}

/** Bounds on the pre-subscribe buffer, so a stream we never claim cannot grow forever. */
const MAX_BUFFERED_SESSIONS = 32;
const MAX_BUFFERED_MESSAGES = 500;

export class AcpClient {
  private readonly opts: AcpClientOptions;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly sessionHandlers = new Map<string, Set<ServerMessageHandler>>();
  /**
   * `session/new` returns the session id in its RESPONSE, but the agent may
   * already have queued `session/update` notifications for it on the same
   * stream. We cannot subscribe before we know the id, so unclaimed
   * session-scoped notifications wait here and are replayed on subscribe.
   */
  private readonly preSubscribe = new Map<string, JsonRpcMessage[]>();
  private starting: Promise<GrokInitializeResult> | null = null;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
  }

  private ensureStarted(): Promise<GrokInitializeResult> {
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }

  private start(): Promise<GrokInitializeResult> {
    const log = this.opts.log ?? console;
    try {
      this.opts.onBeforeSpawn?.();
    } catch (err) {
      log.warn(`[grok] profile preparation failed: ${(err as Error).message}`);
    }
    const child = spawn(this.opts.grokBin, [...ACP_ARGS], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.opts.env ? { env: this.opts.env } : {}),
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      this.handleMessage(msg);
    });
    // Grok writes sandbox warnings and startup noise to stderr. Only the
    // sandbox refusal matters operationally, so surface just that.
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (/sandbox/i.test(text)) log.warn(`[grok] ${text.trim().slice(0, 500)}`);
    });
    // On a spawn failure (ENOENT — binary missing) Node fires 'error' and
    // 'close' but never 'exit', so cleanup hangs off both. cleanup() is
    // idempotent, so error+close+exit firing together is harmless.
    child.on('error', (err) => {
      log.warn(`[grok] spawn failed: ${err.message}`);
      this.cleanup(child, `grok agent failed to start: ${err.message}`);
    });
    child.on('close', () => this.cleanup(child, 'grok agent exited'));

    // The initialize RESPONSE only arrives while stdin stays open, which it
    // does for the process lifetime. `clientCapabilities.fs` is declared false
    // on purpose: Veneer does not host a filesystem for the agent, so Grok must
    // use its own tools (and stay inside its sandbox) to touch files.
    return this.rawRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }).then((result) => (result ?? {}) as GrokInitializeResult);
  }

  /**
   * Tear down after the child dies for any reason (exit, close, or a spawn
   * 'error'): reject every in-flight request, clear the start latch so a later
   * request() respawns, and tell each subscribed session the agent is gone.
   * Idempotent, guarded on process identity.
   */
  private cleanup(child: ChildProcess, reason: string): void {
    if (this.child !== child) return; // already cleaned up (or a newer process is live)
    this.child = null;
    this.starting = null;
    this.preSubscribe.clear();
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
    for (const handlers of this.sessionHandlers.values()) {
      for (const h of handlers) h({ method: DISCONNECTED_METHOD, params: {} });
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (msg.method === undefined) {
      // A response to one of OUR requests.
      if (msg.id === undefined) return;
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) pending.reject(new AcpError(msg.error.code, msg.error.message, msg.error.data));
      else pending.resolve(msg.result);
      return;
    }
    // A notification or an agent-initiated request — route by params.sessionId.
    const sessionId = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : undefined;
    const handlers = sessionId ? this.sessionHandlers.get(sessionId) : undefined;
    if (handlers?.size) {
      for (const h of handlers) h(msg);
      return;
    }
    if (sessionId && msg.id === undefined) {
      this.buffer(sessionId, msg);
      return;
    }
    if (msg.id !== undefined) {
      // Nobody is listening for this session (turn already ended, or the id is
      // unknown) — still answer, or the agent waits on us forever.
      this.respondError(msg.id, -32000, 'No handler for this session');
    }
    // Session-less notifications (e.g. `_x.ai/mcp/servers_updated`) are dropped.
  }

  private buffer(sessionId: string, msg: JsonRpcMessage): void {
    let queue = this.preSubscribe.get(sessionId);
    if (!queue) {
      if (this.preSubscribe.size >= MAX_BUFFERED_SESSIONS) {
        const oldest = this.preSubscribe.keys().next().value;
        if (oldest !== undefined) this.preSubscribe.delete(oldest);
      }
      queue = [];
      this.preSubscribe.set(sessionId, queue);
    }
    if (queue.length < MAX_BUFFERED_MESSAGES) queue.push(msg);
  }

  private write(obj: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
    } catch {
      /* process already gone — the pending request rejects via 'close' */
    }
  }

  private rawRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return p;
  }

  /** Send a request; resolves with `result`, rejects on a JSON-RPC error or process death. */
  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.rawRequest(method, params);
  }

  /** Send a notification (ACP `session/cancel` is one — it has no response). */
  async notify(method: string, params: unknown): Promise<void> {
    await this.ensureStarted();
    this.write({ method, params });
  }

  /** The agent's `initialize` result — model list, capabilities, auth methods. */
  initialize(): Promise<GrokInitializeResult> {
    return this.ensureStarted();
  }

  /** Answer an agent-initiated request by its id. */
  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  /** Fail an agent-initiated request explicitly so the agent never waits forever. */
  respondError(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  /**
   * Scope notifications/requests carrying this sessionId to `handler`, replaying
   * anything that arrived before the id was known. Returns an unsubscribe fn.
   */
  subscribe(sessionId: string, handler: ServerMessageHandler): () => void {
    let set = this.sessionHandlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionHandlers.set(sessionId, set);
    }
    set.add(handler);
    const buffered = this.preSubscribe.get(sessionId);
    if (buffered) {
      this.preSubscribe.delete(sessionId);
      for (const msg of buffered) handler(msg);
    }
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.sessionHandlers.delete(sessionId);
    };
  }

  shutdown(): void {
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** A JSON-RPC error from the agent, with its code preserved for classification. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Pre-login, `session/new` answers
 * `{code:-32000, message:"Authentication required", data:"no auth method id provided"}`
 * (verified live). Recognized by code first, with a text fallback for drift.
 */
export function isAuthenticationError(err: unknown): boolean {
  if (err instanceof AcpError && err.code === -32000 && /auth/i.test(err.message)) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /authentication required|not authenticated|no auth method|unauthorized|401/i.test(message);
}
