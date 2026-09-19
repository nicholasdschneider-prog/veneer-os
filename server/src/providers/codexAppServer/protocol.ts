import { execFile, spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { forwardNetSuiteDiagnosticChunk } from '../../connectors/netsuite/diagnostics.js';

/**
 * Minimal JSON-RPC 2.0-ish framing for `codex app-server --stdio` (Codex CLI
 * 0.144.4, verified 2026-07-23 against a live spawn and the locally generated
 * TypeScript schema — see
 * docs/protocol-notes.md). One NDJSON line per message:
 *   - {id, method, params} + we must reply         → a request FROM the server (e.g. an approval prompt)
 *   - {method, params}, no id                       → a notification (no reply)
 *   - {id, result} or {id, error}, no method         → a response TO one of our requests
 * Unlike `codex exec`, this is a genuine bidirectional server: the process is
 * spawned once and stays alive for the lifetime of this adapter, multiplexing
 * every codex-app-server conversation over the same stdin/stdout by threadId.
 */

export interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ServerMessageHandler = (msg: JsonRpcMessage) => void;

/**
 * Codex 0.144.4 generated schema subset for
 * `item/permissions/requestApproval`. Keep these wire names in sync with the
 * app-server schema: this request deliberately does not use the command/file
 * `{ decision }` response shape.
 */
export interface AdditionalNetworkPermissions {
  enabled: boolean | null;
}

export interface AdditionalFileSystemPermissions {
  read: string[] | null;
  write: string[] | null;
  globScanMaxDepth?: number;
  entries?: unknown[];
}

export interface RequestPermissionProfile {
  network: AdditionalNetworkPermissions | null;
  fileSystem: AdditionalFileSystemPermissions | null;
}

export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  environmentId: string | null;
  startedAtMs: number;
  cwd: string;
  reason: string | null;
  permissions: RequestPermissionProfile;
}

export interface PermissionsRequestApprovalResponse {
  permissions: {
    network?: AdditionalNetworkPermissions;
    fileSystem?: AdditionalFileSystemPermissions;
  };
  scope: 'turn' | 'session';
  strictAutoReview?: boolean;
}

export interface ToolRequestUserInputOption {
  label: string;
  description: string;
}

export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ToolRequestUserInputOption[] | null;
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs: number | null;
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export interface AppServerClientOptions {
  codexBin: string;
  /**
   * Environment for the app-server process. Codex runs the agent's shell
   * commands as its own children, so this is what decides whether they see the
   * login account's HOME (Full Access) or the service home — which is why the
   * adapter keeps one client per access level rather than one per process.
   * Omitted in tests, where the parent environment is inherited as before.
   */
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'warn' | 'error'>;
}

/** Sent to every subscribed thread handler if the underlying process dies mid-turn. */
export const DISCONNECTED_METHOD = '__codex_app_server_disconnected__';

export const APP_SERVER_BASE_ARGS = ['app-server', '--stdio'] as const;

// Codex builds before 0.147 served a client-hosted code-mode `exec` tool this
// adapter does not provide; leaving it on made turns wait forever, so Veneer
// disabled the host wrapper (and MCP tool-search deferral, which routed
// selected MCP calls through the same missing host). Codex 0.147 changed both
// semantics: the code-mode host is process-owned (Codex spawns it itself, and
// exec surfaces as ordinary commandExecution items with the usual approvals),
// models such as gpt-5.6-sol are served the exec tool regardless of the
// feature flag — so disabling the host now fails every exec call with
// "code-mode host is disabled" instead of hiding the tool — and
// tool_search_always_defer_mcp_tools was removed. Verified live 2026-08-14:
// 0.147.0 breaks with these flags and works without them. Older or unknown
// versions keep the previously shipped disables (fleet clients update their
// codex binaries independently).
export const LEGACY_CODE_MODE_DISABLE_ARGS = [
  '--disable',
  'code_mode_host',
  '--disable',
  'tool_search_always_defer_mcp_tools',
] as const;

/** First codex version whose app-server needs no code-mode disable flags. */
const CODE_MODE_HOST_PROCESS_OWNED_SINCE = [0, 147] as const;

/** Spawn args for `codexBin --version` output (e.g. "codex-cli 0.147.0"); null/garbage → legacy. */
export function appServerArgs(version: string | null): string[] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return [...APP_SERVER_BASE_ARGS, ...LEGACY_CODE_MODE_DISABLE_ARGS];
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [sinceMajor, sinceMinor] = CODE_MODE_HOST_PROCESS_OWNED_SINCE;
  const processOwned = major > sinceMajor || (major === sinceMajor && minor >= sinceMinor);
  return processOwned
    ? [...APP_SERVER_BASE_ARGS]
    : [...APP_SERVER_BASE_ARGS, ...LEGACY_CODE_MODE_DISABLE_ARGS];
}

export class AppServerClient {
  private readonly opts: AppServerClientOptions;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly threadHandlers = new Map<string, Set<ServerMessageHandler>>();
  private starting: Promise<void> | null = null;
  /** Cached `codexBin --version` output; undefined = not probed yet, null = probe failed. */
  private codexVersion: string | null | undefined;

  constructor(opts: AppServerClientOptions) {
    this.opts = opts;
  }

  /** True while an app-server process is up (or starting) for this client. */
  get running(): boolean {
    return this.child !== null || this.starting !== null;
  }

  private ensureStarted(): Promise<void> {
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }

  /**
   * The spawn args depend on the codex version (see appServerArgs). A probe
   * failure resolves null → legacy args, matching what shipped before the
   * version gate; the subsequent spawn then reports the real error if the
   * binary is genuinely broken.
   */
  private probeCodexVersion(): Promise<string | null> {
    if (this.codexVersion !== undefined) return Promise.resolve(this.codexVersion);
    return new Promise((resolve) => {
      execFile(
        this.opts.codexBin,
        ['--version'],
        { timeout: 10_000, ...(this.opts.env ? { env: this.opts.env } : {}) },
        (err, stdout) => {
          this.codexVersion = err ? null : String(stdout).trim();
          resolve(this.codexVersion);
        },
      );
    });
  }

  private async start(): Promise<void> {
    const log = this.opts.log ?? console;
    const version = await this.probeCodexVersion();
    const child = spawn(this.opts.codexBin, appServerArgs(version), {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.opts.env ? { env: this.opts.env } : {}),
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
    // Startup noise stays hidden. The sole exception is our canonical,
    // whitelist-validated NetSuite timing stream from nested MCP stderr.
    let diagnosticBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBuffer = forwardNetSuiteDiagnosticChunk(diagnosticBuffer, chunk.toString('utf8'), log);
    });
    // On a spawn failure (e.g. ENOENT — binary missing/renamed) Node fires 'error'
    // and 'close' but never 'exit', so cleanup must hang off both, not just 'exit'.
    // cleanup() is idempotent, so error+close+exit firing together is harmless.
    child.on('error', (err) => {
      log.warn(`[codex-app-server] spawn failed: ${err.message}`);
      this.cleanup(child, `codex app-server failed to start: ${err.message}`);
    });
    child.on('close', () => this.cleanup(child, 'codex app-server exited'));

    return this.rawRequest('initialize', {
      clientInfo: { name: 'veneer-pro', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }).then(() => {
      this.write({ method: 'initialized' });
    });
  }

  /**
   * Tear down after the child process dies for any reason (exit, close, or a spawn
   * 'error'): reject every in-flight request, clear the start latch so a later
   * request() can respawn, and tell each subscribed thread the server is gone.
   * Idempotent — guarded on the process identity so the error+close pair a spawn
   * failure produces (and a normal exit's close) only run this once.
   */
  private cleanup(child: ChildProcess, reason: string): void {
    if (this.child !== child) return; // already cleaned up for this process (or a newer one is live)
    this.child = null;
    this.starting = null;
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
    for (const handlers of this.threadHandlers.values()) {
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
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    // A notification or a server-initiated request — route by params.threadId.
    const threadId = typeof msg.params?.threadId === 'string' ? msg.params.threadId : undefined;
    const handlers = threadId ? this.threadHandlers.get(threadId) : undefined;
    if (handlers?.size) {
      for (const h of handlers) h(msg);
      return;
    }
    if (msg.id !== undefined) {
      // Nobody's listening for this thread (turn already ended) — still must
      // answer, or the server will wait on us forever.
      this.write({ id: msg.id, error: { code: -32000, message: 'No handler for this thread' } });
    }
  }

  private write(obj: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* process already gone — the pending request will reject via 'exit' */
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

  /** Answer a server-initiated request (e.g. an approval prompt) by its id. */
  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  /** Fail a server-initiated request explicitly so app-server never waits forever. */
  respondError(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  /** Scope notifications/requests carrying this threadId to `handler`. Returns an unsubscribe fn. */
  subscribe(threadId: string, handler: ServerMessageHandler): () => void {
    let set = this.threadHandlers.get(threadId);
    if (!set) {
      set = new Set();
      this.threadHandlers.set(threadId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.threadHandlers.delete(threadId);
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
