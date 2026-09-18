import { z } from 'zod';
import http from 'node:http';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { WebSocketServer, WebSocket } from 'ws';
import type { ConversationRow, ConversationWakeupRow, UserRow } from '../db/db.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { ConversationManager } from '../runtime/conversationManager.js';
import type {
  ConversationActivity,
  ConversationEvent,
  ConversationQueueSnapshot,
  ConversationStatus,
  MessageOrigin,
  QuestionSecretTarget,
} from '../runtime/events.js';
import type { UsageStore } from '../usage/store.js';
import type { ClaudeProbe } from '../usage/claudeProbe.js';
import type { ClaudeLimitResetManager } from '../usage/claudeLimitReset.js';
import type { ScheduledTaskScheduler } from '../scheduled/scheduler.js';
import type { ConversationWakeupScheduler } from '../scheduled/wakeups.js';
import type { BuildQueueCoordinator } from '../buildQueue/coordinator.js';
import { ensureIpcSecret, IPC_SECRET_HEADER, ipcSecretMatches } from './ipcSecret.js';
import { handleVeneerBrowserMcp } from '../veneerBrowser/mcp.js';
import type { VeneerBrowserManager } from '../veneerBrowser/manager.js';
import type { SecretAccessDeps } from '../secrets/readSecret.js';
import type { EmailCodeSource } from '../veneerBrowser/emailCode.js';

/**
 * Runner-side IPC server (plan §"IPC boundary"). A loopback HTTP server on
 * 127.0.0.1:${runnerPort} exposing the ConversationManager surface as JSON
 * request/response RPCs plus a WebSocket event stream at /events. The web
 * process is the only client (runner/client.ts). Endpoints that today take a
 * full ConversationRow take { convId } here and re-read the row from the shared
 * DB before delegating — payloads stay small and the DB stays authoritative.
 *
 * The 127.0.0.1 bind is NOT the trust boundary: any page loaded in a browser on
 * this host can reach loopback. Every /rpc/* request and the /events upgrade
 * must present the per-install shared secret (runner/ipcSecret.ts). Two
 * secondary defenses keep a browser from ever getting that far: requests
 * carrying an Origin header are refused outright, and /rpc/* requires a JSON
 * content type (which a cross-origin form/`text/plain` POST cannot set without
 * a preflight). Only /healthz stays open, for the boot probes.
 */
export function createIpcServer({
  manager,
  adapters,
  db,
  dataDir,
  usage,
  usageBus,
  probe,
  claudeLimitReset,
  veneerBrowser,
  scheduled,
  wakeups,
  buildQueue,
  secretAccess,
  emailCodes,
  onRestart,
}: {
  manager: ConversationManager;
  adapters: Record<string, ProviderAdapter>;
  /** Re-read conversation rows for the {convId}-shaped RPCs. */
  db: Database.Database;
  /** Shared data directory; holds the IPC secret both processes read. */
  dataDir: string;
  /** Runner-owned Claude usage store (sole writer); read by /rpc/usage. */
  usage: UsageStore;
  /**
   * Emits 'changed' whenever the store takes a new snapshot. Forwarded to web
   * as a conversation-less `usage` frame so open browsers re-read /api/usage.
   */
  usageBus: EventEmitter;
  /** Active Claude usage refresh, single-flighted; driven by /rpc/usage. */
  probe: ClaudeProbe;
  /** Explicit-account weekly session reset; never activates an account. */
  claudeLimitReset: ClaudeLimitResetManager;
  veneerBrowser: VeneerBrowserManager;
  /** Runner-owned scheduler; exposed only for authenticated web run-now calls. */
  scheduled: ScheduledTaskScheduler;
  /** Durable same-conversation wake-ups, exposed through authenticated web routes. */
  wakeups: ConversationWakeupScheduler;
  /** Durable FIFO for Platform Dev turns sharing the live source checkout. */
  buildQueue: BuildQueueCoordinator;
  /**
   * Doppler read access for the browser's fill_secret / fill_totp tools. The
   * runner resolves the value itself so it never travels to the web process or
   * back through an agent-visible payload.
   */
  secretAccess?: SecretAccessDeps;
  /** Configured code mailbox for fill_email_code; absent disables the tool. */
  emailCodes?: EmailCodeSource;
  /** Drain and exit 0 so the supervisor respawns us (the UI "unstick" path). */
  onRestart: (reason: string) => void;
}): http.Server {
  const secret = ensureIpcSecret(dataDir);
  const getConv = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const readConv = (convId: string): ConversationRow | undefined =>
    getConv.get(convId) as ConversationRow | undefined;
  const actorFor = (body: Record<string, unknown>, conv: ConversationRow): number => {
    const actorUserId = Number(body.actorUserId);
    return Number.isSafeInteger(actorUserId) && actorUserId > 0 ? actorUserId : conv.user_id;
  };
  const originFor = (body: Record<string, unknown>): MessageOrigin | undefined => {
    const value = body.origin;
    if (!value || typeof value !== 'object') return undefined;
    const origin = value as Partial<MessageOrigin>;
    if (
      (origin.kind !== 'agent' && origin.kind !== 'wakeup' && origin.kind !== 'build_queue') ||
      typeof origin.from !== 'string' ||
      typeof origin.to !== 'string'
    ) return undefined;
    const from = origin.from.trim().slice(0, 120);
    const to = origin.to.trim().slice(0, 120);
    if (!from || !to) return undefined;
    const sourceConversationId = origin.kind === 'agent' && typeof origin.sourceConversationId === 'string'
      ? origin.sourceConversationId.trim().slice(0, 200)
      : '';
    const sourceConversationTitle = sourceConversationId && typeof origin.sourceConversationTitle === 'string'
      ? origin.sourceConversationTitle.trim().slice(0, 200)
      : '';
    return {
      kind: origin.kind,
      from,
      to,
      ...(sourceConversationId ? { sourceConversationId } : {}),
      ...(sourceConversationTitle ? { sourceConversationTitle } : {}),
    };
  };
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    // Every legitimate client here is a Node process, which sends no Origin.
    // A browser cannot suppress it, so its presence is proof of a page.
    if (hasOrigin(req)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (path === '/mcp/veneer-browser') {
      void handleVeneerBrowserMcp(req, res, {
        db,
        manager: veneerBrowser,
        ...(secretAccess ? { secrets: secretAccess } : {}),
        ...(emailCodes ? { emailCodes } : {}),
      }).catch(() => {
        if (!res.headersSent) sendJson(res, 502, { error: 'Veneer Browser MCP failed' });
        else res.destroy();
      });
      return;
    }
    void handleRpc(req, res).catch((err: Error) => sendJson(res, 500, { error: err.message }));
  });

  async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    // A cross-origin form/beacon POST cannot set this content type without a
    // CORS preflight, which this server never answers.
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: 'unsupported media type' });
      return;
    }
    if (!ipcSecretMatches(secret, req.headers[IPC_SECRET_HEADER])) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    const body = await readBody(req);

    switch (path) {
      case '/rpc/postMessage': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, {
          ok: true,
          ...manager.postMessage(conv, String(body.text ?? ''), actorFor(body, conv), originFor(body)),
        });
      }
      case '/rpc/steerMessage': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, {
          ok: true,
          ...(await manager.steerMessage(
            conv,
            String(body.text ?? ''),
            typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
            actorFor(body, conv),
            originFor(body),
          )),
        });
      }
      case '/rpc/queueMessage': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, {
          ok: true,
          ...manager.queueMessage(conv, String(body.text ?? ''), actorFor(body, conv), originFor(body)),
        });
      }
      case '/rpc/queueSnapshot':
        return void sendJson(res, 200, { queue: manager.queueSnapshot(String(body.convId)) });
      case '/rpc/updateQueuedMessage': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(
          res,
          200,
          manager.updateQueuedMessage(
            conv.id,
            Number(body.messageId),
            String(body.text ?? ''),
            actorFor(body, conv),
          ),
        );
      }
      case '/rpc/removeQueuedMessage':
        return void sendJson(
          res,
          200,
          manager.removeQueuedMessage(String(body.convId), Number(body.messageId)),
        );
      case '/rpc/reorderQueuedMessages':
        return void sendJson(
          res,
          200,
          manager.reorderQueuedMessages(
            String(body.convId),
            Array.isArray(body.messageIds) ? body.messageIds.map(Number) : [],
          ),
        );
      case '/rpc/sendQueuedMessageNow': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, manager.sendQueuedMessageNow(conv, Number(body.messageId)));
      }
      case '/rpc/retryFailedTurn': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, manager.retryFailedTurn(conv, actorFor(body, conv)));
      }
      case '/rpc/discardFailedTurn': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, manager.discardFailedTurn(conv));
      }
      case '/rpc/switchProvider': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        const selection = z.object({
          provider: z.enum(['claude', 'codex', 'grok', 'openrouter']),
          model: z.string().min(1).max(100).nullable(),
          effort: z.string().min(1).max(40).nullable(),
        }).safeParse(body.selection);
        if (!selection.success) return void sendJson(res, 400, { error: 'Invalid model selection' });
        return void sendJson(res, 200, await manager.switchProvider(conv, selection.data));
      }
      case '/rpc/compactConversation': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, await manager.compactConversation(conv));
      }
      case '/rpc/interrupt':
        return void sendJson(res, 200, { ok: manager.interrupt(String(body.convId)) });
      case '/rpc/resolveApproval':
        return void sendJson(
          res,
          200,
          manager.resolveApproval(Number(body.approvalId), body.outcome, Number(body.byUserId)),
        );
      case '/rpc/status':
        return void sendJson(res, 200, { status: manager.statusOf(String(body.convId)) });
      case '/rpc/activity':
        return void sendJson(res, 200, { activity: manager.activityOf(String(body.convId)) });
      case '/rpc/isLive':
        return void sendJson(res, 200, { live: manager.isLive(String(body.convId)) });
      case '/rpc/askQuestion':
        return void sendJson(res, 200, {
          requestId: manager.askQuestion(
            String(body.convId),
            String(body.question ?? ''),
            (body.options as { label: string; value: string }[]) ?? [],
            Boolean(body.multi),
            Boolean(body.allowOther),
            (body.secret as QuestionSecretTarget | undefined) ?? undefined,
            (body.secretKind as 'secret' | 'reveal' | undefined) ?? 'secret',
          ),
        });
      case '/rpc/getQuestion':
        return void sendJson(res, 200, { question: manager.getQuestion(String(body.requestId)) });
      case '/rpc/resolveQuestion':
        return void sendJson(
          res,
          200,
          manager.resolveQuestion(
            String(body.requestId),
            typeof body.answers === 'string'
              ? body.answers
              : ((body.answers as Record<string, string[]>) ?? {}),
          ),
        );
      case '/rpc/snapshot': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, { events: await manager.snapshot(conv) });
      }
      case '/rpc/listSessionFiles': {
        const conv = readConv(body.convId);
        if (!conv) return void sendJson(res, 404, { error: 'conversation not found' });
        return void sendJson(res, 200, { refs: await manager.listSessionFiles(conv) });
      }
      case '/rpc/listModels': {
        const adapter = adapters[String(body.provider)];
        const models = adapter?.listModels ? await adapter.listModels() : [];
        return void sendJson(res, 200, { models });
      }
      case '/rpc/restart': {
        // Answer first, then drain — the caller must not wait on our exit, and
        // this very request has to clear the in-flight count for the drain to
        // finish promptly.
        res.on('finish', () => onRestart('restart requested by web'));
        return void sendJson(res, 200, { ok: true });
      }
      case '/rpc/runScheduledTask':
        return void sendJson(res, 200, scheduled.runNow(String(body.taskId ?? '')));
      case '/rpc/scheduleWakeup':
        return void sendJson(
          res,
          200,
          wakeups.schedule({
            conversationId: String(body.convId ?? ''),
            actorUserId: Number(body.actorUserId),
            key: String(body.key ?? ''),
            reason: String(body.reason ?? ''),
            scheduledFor: new Date(String(body.scheduledFor ?? '')),
          }),
        );
      case '/rpc/listWakeups':
        return void sendJson(res, 200, { wakeups: wakeups.list(String(body.convId ?? '')) });
      case '/rpc/cancelWakeup':
        return void sendJson(
          res,
          200,
          wakeups.cancel(String(body.convId ?? ''), String(body.wakeupId ?? '')),
        );
      case '/rpc/rescheduleWakeup':
        return void sendJson(
          res,
          200,
          wakeups.reschedule(
            String(body.convId ?? ''),
            String(body.wakeupId ?? ''),
            new Date(String(body.scheduledFor ?? '')),
          ),
        );
      case '/rpc/fireWakeup':
        return void sendJson(
          res,
          200,
          wakeups.fire(String(body.convId ?? ''), String(body.wakeupId ?? '')),
        );
      case '/rpc/enqueueBuild':
        return void sendJson(
          res,
          200,
          buildQueue.enqueue(String(body.convId ?? ''), String(body.title ?? ''), String(body.brief ?? '')),
        );
      case '/rpc/listBuildQueue':
        return void sendJson(res, 200, { jobs: buildQueue.list() });
      case '/rpc/resolveBuild':
        return void sendJson(
          res,
          200,
          buildQueue.resolve(Number(body.jobId), body.action === 'retry' ? 'retry' : 'skip'),
        );
      case '/rpc/veneerBrowserProfiles':
        if (!veneerBrowser.configured()) {
          return void sendJson(res, 200, { configured: false, defaultProfileId: null, profiles: [], others: [] });
        }
        return void sendJson(res, 200, {
          configured: true,
          ...veneerBrowser.listProfiles(Number(body.userId), actingRole(body.role), String(body.projectId ?? '')),
        });
      case '/rpc/veneerBrowserSetDefault':
        veneerBrowser.setDefaultProfile(
          Number(body.userId), String(body.projectId ?? ''), String(body.profileId ?? ''),
        );
        return void sendJson(res, 200, { ok: true });
      case '/rpc/veneerBrowserCreate':
        return void sendJson(res, 200, { profile: await veneerBrowser.createProfile(
          Number(body.userId), String(body.projectId ?? ''), body.name,
        ) });
      case '/rpc/veneerBrowserRename':
        return void sendJson(res, 200, { profile: await veneerBrowser.renameProfile(
          Number(body.userId), String(body.projectId ?? ''), String(body.profileId ?? ''), body.name,
        ) });
      case '/rpc/veneerBrowserDelete':
        await veneerBrowser.deleteProfile(
          Number(body.userId), actingRole(body.role), String(body.projectId ?? ''), String(body.profileId ?? ''),
        );
        return void sendJson(res, 200, { ok: true });
      case '/rpc/veneerBrowserStop':
        return void sendJson(res, 200, { profile: await veneerBrowser.stopProfile(
          Number(body.userId), String(body.projectId ?? ''), String(body.profileId ?? ''),
        ) });
      case '/rpc/veneerBrowserStatus':
        return void sendJson(res, 200, { profile: await veneerBrowser.refreshProfile(
          Number(body.userId), String(body.projectId ?? ''), String(body.profileId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversation':
        return void sendJson(res, 200, { session: await veneerBrowser.conversationSession(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserFetchUrl': {
        // Trusted local scripts already authenticate with this installation's
        // IPC secret. Derive the profile owner from the chat, never a caller id.
        const conversation = readConv(String(body.convId ?? ''));
        if (!conversation) return void sendJson(res, 404, { error: 'Chat not found.' });
        return void sendJson(res, 200, await veneerBrowser.fetchUrl(
          conversation.user_id, conversation.id, body.request,
        ));
      }
      case '/rpc/veneerBrowserConversationProfiles':
        if (!veneerBrowser.configured()) return void sendJson(res, 200, { profiles: [] });
        return void sendJson(res, 200, { profiles: veneerBrowser.listProfilesForConversation(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversationCreate':
        return void sendJson(res, 200, { session: await veneerBrowser.createForConversation(
          Number(body.userId), String(body.convId ?? ''), body.name,
        ) });
      case '/rpc/veneerBrowserConversationSelect':
        veneerBrowser.selectForConversation(
          Number(body.userId), String(body.convId ?? ''), String(body.profileId ?? ''),
        );
        return void sendJson(res, 200, { session: await veneerBrowser.conversationSession(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversationOpen':
        return void sendJson(res, 200, { session: await veneerBrowser.openConversation(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversationFresh':
        return void sendJson(res, 200, { session: await veneerBrowser.openFreshConversation(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversationUpdateProfile':
        return void sendJson(res, 200, { session: await veneerBrowser.updateConversationProfile(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversationSaveAs':
        return void sendJson(res, 200, { session: await veneerBrowser.saveConversationAsProfile(
          Number(body.userId), String(body.convId ?? ''), body.name,
        ) });
      case '/rpc/veneerBrowserConversationStop':
        return void sendJson(res, 200, { session: await veneerBrowser.stopConversation(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversationTicket':
        return void sendJson(res, 200, await veneerBrowser.viewerTicketForConversation(
          Number(body.userId), String(body.convId ?? ''),
        ));
      // Advanced capture reaches the runner only from the authenticated user's
      // HTTP route; the MCP endpoint above has no equivalent.
      case '/rpc/veneerBrowserConversationCaptureGet':
        return void sendJson(res, 200, { capture: veneerBrowser.conversationCapture(
          Number(body.userId), String(body.convId ?? ''),
        ) });
      case '/rpc/veneerBrowserConversationCaptureSet':
        return void sendJson(res, 200, { capture: veneerBrowser.setCaptureGrant(
          Number(body.userId), String(body.convId ?? ''), body.active === true,
        ) });
      case '/rpc/usage': {
        // maxAgeMs travels as a finite number (JSON has no Infinity); web sends a
        // huge value to mean "don't probe, just read". Guard non-finite anyway.
        const raw = Number(body.maxAgeMs);
        const maxAgeMs = Number.isFinite(raw) ? raw : Number.MAX_SAFE_INTEGER;
        await probe.refreshIfStale(maxAgeMs);
        // Per-account meters plus the active account's, so an older web build
        // (and every non-Claude caller) still reads the same top-level fields.
        return void sendJson(res, 200, {
          snapshots: usage.claudeSnapshots(),
          planType: usage.claudePlanType(),
          accountEmail: usage.claudeAccountEmail(),
          limitReset: usage.claudeLimitReset(),
          accounts: usage.allClaudeAccounts(),
        });
      }
      case '/rpc/claudeLimitReset': {
        const accountId = typeof body.accountId === 'string' ? body.accountId : '';
        if (!accountId) return void sendJson(res, 400, { error: 'accountId required' });
        return void sendJson(res, 200, await claudeLimitReset.claimForAccount(accountId));
      }
      default:
        return void sendJson(res, 404, { error: 'unknown endpoint' });
    }
  }

  // ── Event stream (/events) ─────────────────────────────────────────────────
  // Every connected web client gets every conversation's frames; the web side
  // fans them out to browser subscribers exactly as the in-process bus does.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/events') {
      socket.destroy();
      return;
    }
    // The stream carries every conversation's frames, so it needs the same
    // secret as /rpc/*. A header is fine: the only client is the Node web
    // process (a browser cannot set headers on a WebSocket handshake).
    if (hasOrigin(req) || !ipcSecretMatches(secret, req.headers[IPC_SECRET_HEADER])) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  const broadcast = (frame: unknown): void => {
    const data = JSON.stringify(frame);
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
      } catch {
        /* socket died mid-send */
      }
    }
  };
  manager.bus.on('event', (conversationId: string, event: ConversationEvent) =>
    broadcast({ kind: 'event', conversationId, event }),
  );
  manager.bus.on('status', (
    conversationId: string,
    status: ConversationStatus,
    activity: ConversationActivity,
  ) => broadcast({ kind: 'status', conversationId, status, activity }));
  manager.bus.on('queue', (conversationId: string, queue: ConversationQueueSnapshot) =>
    broadcast({ kind: 'queue', conversationId, queue }),
  );
  manager.bus.on('wakeups', (conversationId: string, rows: ConversationWakeupRow[]) =>
    broadcast({ kind: 'wakeups', conversationId, wakeups: rows }),
  );
  // Payload-free on purpose: web already owns the read path (/rpc/usage joins
  // the runner's meters with the account labels the secret store holds), so the
  // frame only has to say "something moved".
  usageBus.on('changed', () => broadcast({ kind: 'usage' }));

  return server;
}

function hasOrigin(req: http.IncomingMessage): boolean {
  return typeof req.headers.origin === 'string' && req.headers.origin.trim() !== '';
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const type = String(req.headers['content-type'] ?? '').toLowerCase().trim();
  return type === 'application/json' || type.startsWith('application/json;');
}

/** Read + JSON-parse a request body; empty body ⇒ {}. */
function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, any>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Only the account-owner override is role-sensitive, so anything else is a member. */
function actingRole(value: unknown): UserRow['role'] {
  return value === 'owner' ? 'owner' : 'member';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}
