import type { ModelSelection, SwitchProviderResult } from '../runtime/providerSwitch.js';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type {
  QuestionSnapshot,
  CompactConversationResult,
  PostMessageResult,
  QueueMutationResult,
  ResolveApprovalResult,
  ResolveQuestionResult,
} from '../runtime/conversationManager.js';
import type {
  ConversationActivity,
  ConversationEvent,
  ConversationQueueSnapshot,
  ConversationStatus,
  MessageOrigin,
  QuestionAnswers,
  QuestionOption,
  QuestionSecretTarget,
} from '../runtime/events.js';
import type { CreatedFileRef, ModelOption } from '../providers/types.js';
import type { ClaudeAccountUsage } from '../usage/store.js';
import type { ClaudeSnapshot } from '../usage/contract.js';
import type { ClaudeLimitResetClaim, ClaudeLimitResetStatus } from '../usage/claudeLimitReset.js';
import type { BuildQueueRow, ConversationWakeupRow, UserRow } from '../db/db.js';
import type { EnqueueBuildResult, ResolveBuildResult } from '../buildQueue/coordinator.js';
import type {
  CancelWakeupResult,
  FireWakeupResult,
  RescheduleWakeupResult,
  ScheduleWakeupResult,
} from '../scheduled/wakeups.js';
import { ensureIpcSecret, IPC_SECRET_HEADER } from './ipcSecret.js';
import type {
  VeneerBrowserCaptureView,
  VeneerBrowserProfileList,
  VeneerBrowserProfileView,
  VeneerBrowserSessionView,
} from '../veneerBrowser/manager.js';

/**
 * Web-side handle to the runner's IPC server (plan §"Web-side client stub").
 * Shaped like ConversationManager but FULLY ASYNC — the sync `statusOf`/`isLive`
 * become promises too — and, crucially, every method takes a `convId` string
 * rather than a full ConversationRow (the Stage 3 contract): the runner re-reads
 * the row from the shared DB. `bus` is fed by the /events WebSocket and emits
 * 'event'/'status' exactly as the in-process manager's bus does, so
 * channels/webSocket.ts subscribes to it unchanged.
 *
 * RPCs reject when the runner is unreachable (restarting) so routes can surface
 * a 503; the event socket auto-reconnects with capped backoff. State is durable,
 * so a runner restart is a brief, self-healing gap.
 */
export interface RunnerClient {
  /**
   * Emits ('event', conversationId, ConversationEvent), ('status', conversationId,
   * status) and the conversation-less ('usage') when the runner's meters move.
   */
  bus: EventEmitter;
  postMessage(
    convId: string,
    text: string,
    actorUserId: number,
    origin?: MessageOrigin,
  ): Promise<{ ok: true } & PostMessageResult>;
  steerMessage(
    convId: string,
    text: string,
    actorUserId: number,
    idempotencyKey?: string,
    origin?: MessageOrigin,
  ): Promise<{ ok: true } & PostMessageResult>;
  queueMessage(
    convId: string,
    text: string,
    actorUserId: number,
    origin?: MessageOrigin,
  ): Promise<{ ok: true } & PostMessageResult>;
  queueSnapshot(convId: string): Promise<ConversationQueueSnapshot>;
  updateQueuedMessage(convId: string, messageId: number, text: string, actorUserId: number): Promise<QueueMutationResult>;
  removeQueuedMessage(convId: string, messageId: number): Promise<QueueMutationResult>;
  reorderQueuedMessages(convId: string, messageIds: number[]): Promise<QueueMutationResult>;
  sendQueuedMessageNow(convId: string, messageId: number): Promise<QueueMutationResult>;
  retryFailedTurn(convId: string, actorUserId: number): Promise<QueueMutationResult>;
  discardFailedTurn(convId: string): Promise<QueueMutationResult>;
  compactConversation(convId: string): Promise<CompactConversationResult>;
  switchProvider(convId: string, selection: ModelSelection): Promise<SwitchProviderResult>;
  interrupt(convId: string): Promise<boolean>;
  resolveApproval(
    approvalId: number,
    outcome: 'approved' | 'denied',
    byUserId: number,
  ): Promise<ResolveApprovalResult>;
  statusOf(convId: string): Promise<ConversationStatus>;
  activityOf(convId: string): Promise<ConversationActivity>;
  isLive(convId: string): Promise<boolean>;
  snapshot(convId: string): Promise<ConversationEvent[]>;
  listSessionFiles(convId: string): Promise<CreatedFileRef[]>;
  listModels(provider: string): Promise<ModelOption[]>;
  /** Start an immediate run of a user-authorized scheduled task. */
  runScheduledTask(
    taskId: string,
  ): Promise<{ ok: true; conversationId: string; runId: string } | { ok: false; error: 'not_found' | 'already_running' }>;
  scheduleWakeup(
    convId: string,
    actorUserId: number,
    key: string,
    reason: string,
    scheduledFor: string,
  ): Promise<ScheduleWakeupResult>;
  listWakeups(convId: string): Promise<ConversationWakeupRow[]>;
  cancelWakeup(convId: string, wakeupId: string): Promise<CancelWakeupResult>;
  rescheduleWakeup(convId: string, wakeupId: string, scheduledFor: string): Promise<RescheduleWakeupResult>;
  fireWakeup(convId: string, wakeupId: string): Promise<FireWakeupResult>;
  enqueueBuild(convId: string, title: string, brief: string, actorUserId?: number): Promise<EnqueueBuildResult>;
  listBuildQueue(): Promise<BuildQueueRow[]>;
  resolveBuild(jobId: number, action: 'retry' | 'skip'): Promise<ResolveBuildResult>;
  veneerBrowserProfiles(
    userId: number,
    role: UserRow['role'],
    projectId: string,
  ): Promise<VeneerBrowserProfileList & { configured: boolean }>;
  veneerBrowserSetDefault(userId: number, projectId: string, profileId: string): Promise<void>;
  veneerBrowserCreate(userId: number, projectId: string, name: string): Promise<VeneerBrowserProfileView>;
  veneerBrowserRename(userId: number, projectId: string, profileId: string, name: string): Promise<VeneerBrowserProfileView>;
  /** An account owner may delete a teammate's profile; everyone else only their own. */
  veneerBrowserDelete(userId: number, role: UserRow['role'], projectId: string, profileId: string): Promise<void>;
  veneerBrowserStop(userId: number, projectId: string, profileId: string): Promise<VeneerBrowserProfileView>;
  veneerBrowserStatus(userId: number, projectId: string, profileId: string): Promise<VeneerBrowserProfileView>;
  veneerBrowserConversation(userId: number, convId: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationProfiles(userId: number, convId: string): Promise<VeneerBrowserProfileView[]>;
  veneerBrowserConversationCreate(userId: number, convId: string, name: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationSelect(userId: number, convId: string, profileId: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationOpen(userId: number, convId: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationFresh(userId: number, convId: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationUpdateProfile(userId: number, convId: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationSaveAs(userId: number, convId: string, name: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationStop(userId: number, convId: string): Promise<VeneerBrowserSessionView>;
  veneerBrowserConversationTicket(userId: number, convId: string): Promise<{ ticket: string; caFile: string | null }>;
  /** Advanced capture is user-only state: no agent/MCP path may set it. */
  veneerBrowserConversationCaptureGet(userId: number, convId: string): Promise<VeneerBrowserCaptureView>;
  veneerBrowserConversationCaptureSet(
    userId: number,
    convId: string,
    active: boolean,
  ): Promise<VeneerBrowserCaptureView>;
  /** Register an ask_user question (returns its requestId); state lives in the runner. */
  askQuestion(
    convId: string,
    question: string,
    options: QuestionOption[],
    multi: boolean,
    allowOther?: boolean,
    /** Present = a secret prompt (masked input; value never reaches the agent). */
    secret?: QuestionSecretTarget,
    /** Which secret card to render: collect a value ('secret') or show one ('reveal'). */
    secretKind?: 'secret' | 'reveal',
  ): Promise<string>;
  /** Poll a question's current state (null once cleaned up). */
  getQuestion(requestId: string): Promise<QuestionSnapshot | null>;
  /** Record the user's answer (route layer has already authorized the caller). */
  resolveQuestion(requestId: string, answers: QuestionAnswers | string): Promise<ResolveQuestionResult>;
  /**
   * Refresh the runner-owned Claude usage store if its newest snapshot is older
   * than `maxAgeMs` (the runner is the sole usage writer/prober), then return the
   * current snapshots for web's read-only GET /api/usage.
   */
  usage(maxAgeMs: number): Promise<{
    snapshots: ClaudeSnapshot[];
    planType: string | null;
    accountEmail: string | null;
    limitReset: ClaudeLimitResetStatus | null;
    /** One entry per connected Claude account (see usage/store.ts). */
    accounts: ClaudeAccountUsage[];
  }>;
  /** Claim the selected Claude account's provider-authorized weekly reset. */
  claudeLimitReset(accountId: string): Promise<ClaudeLimitResetClaim>;
  /**
   * Ask the runner to drain and exit 0 so its supervisor respawns it — the UI's
   * "unstick" button. Resolves once the runner has accepted, not once it is back
   * up; the event socket reconnects on its own.
   */
  restart(): Promise<void>;
  /** Stop the event socket + reconnect loop (web shutdown). */
  close(): void;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function createRunnerClient({ baseUrl, dataDir }: { baseUrl: string; dataDir: string }): RunnerClient {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);

  // Provisioned lazily (not at construction) so whichever of web/runner boots
  // first mints the file and the other adopts it.
  let cachedSecret: string | null = null;
  const secret = (): string => (cachedSecret ??= ensureIpcSecret(dataDir));

  async function rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [IPC_SECRET_HEADER]: secret() },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Connection refused / DNS / socket error — runner is down or restarting.
      throw new Error(`runner unreachable (${path}): ${(err as Error).message}`);
    }
    if (!res.ok) {
      // The IPC server puts the real failure in the body ({error: message});
      // without it a schema or SQL error surfaces as an opaque status code.
      let detail = '';
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string' && body.error) detail = ` — ${body.error}`;
      } catch {
        /* non-JSON body: report the status alone */
      }
      throw new Error(`runner ${path} failed: HTTP ${res.status}${detail}`);
    }
    return (await res.json()) as T;
  }

  // ── Event stream: connect once, re-emit frames on `bus`, auto-reconnect ──────
  let ws: WebSocket | null = null;
  let backoff = RECONNECT_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function connect(): void {
    if (closed) return;
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/events`;
    ws = new WebSocket(wsUrl, { headers: { [IPC_SECRET_HEADER]: secret() } });
    ws.on('open', () => {
      backoff = RECONNECT_MIN_MS; // reset on a healthy connection
    });
    ws.on('message', (data) => {
      let frame: {
        kind?: string;
        conversationId?: string;
        event?: ConversationEvent;
        status?: ConversationStatus;
        activity?: ConversationActivity;
        queue?: ConversationQueueSnapshot;
        wakeups?: ConversationWakeupRow[];
      };
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      // Conversation-less frame: the runner's meters moved. Re-emitted on the
      // same bus so channels/webSocket.ts can nudge every browser client.
      if (frame.kind === 'usage') {
        bus.emit('usage');
        return;
      }
      if (!frame.conversationId) return;
      if (frame.kind === 'event' && frame.event) bus.emit('event', frame.conversationId, frame.event);
      else if (frame.kind === 'status' && frame.status) {
        bus.emit('status', frame.conversationId, frame.status, frame.activity ?? null);
      }
      else if (frame.kind === 'queue' && frame.queue) bus.emit('queue', frame.conversationId, frame.queue);
      else if (frame.kind === 'wakeups' && frame.wakeups) bus.emit('wakeups', frame.conversationId, frame.wakeups);
    });
    ws.on('close', scheduleReconnect);
    ws.on('error', () => ws?.close());
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }

  connect();

  return {
    bus,
    postMessage: (convId, text, actorUserId, origin) =>
      rpc('/rpc/postMessage', { convId, text, actorUserId, origin }),
    steerMessage: (convId, text, actorUserId, idempotencyKey, origin) =>
      rpc('/rpc/steerMessage', { convId, text, actorUserId, idempotencyKey, origin }),
    queueMessage: (convId, text, actorUserId, origin) =>
      rpc('/rpc/queueMessage', { convId, text, actorUserId, origin }),
    queueSnapshot: (convId) =>
      rpc<{ queue: ConversationQueueSnapshot }>('/rpc/queueSnapshot', { convId }).then((r) => r.queue),
    updateQueuedMessage: (convId, messageId, text, actorUserId) =>
      rpc('/rpc/updateQueuedMessage', { convId, messageId, text, actorUserId }),
    removeQueuedMessage: (convId, messageId) => rpc('/rpc/removeQueuedMessage', { convId, messageId }),
    reorderQueuedMessages: (convId, messageIds) => rpc('/rpc/reorderQueuedMessages', { convId, messageIds }),
    sendQueuedMessageNow: (convId, messageId) => rpc('/rpc/sendQueuedMessageNow', { convId, messageId }),
    retryFailedTurn: (convId, actorUserId) => rpc('/rpc/retryFailedTurn', { convId, actorUserId }),
    discardFailedTurn: (convId) => rpc('/rpc/discardFailedTurn', { convId }),
    compactConversation: (convId) => rpc('/rpc/compactConversation', { convId }),
    switchProvider: (convId, selection) => rpc('/rpc/switchProvider', { convId, selection }),
    interrupt: (convId) => rpc<{ ok: boolean }>('/rpc/interrupt', { convId }).then((r) => r.ok),
    resolveApproval: (approvalId, outcome, byUserId) =>
      rpc('/rpc/resolveApproval', { approvalId, outcome, byUserId }),
    statusOf: (convId) => rpc<{ status: ConversationStatus }>('/rpc/status', { convId }).then((r) => r.status),
    activityOf: (convId) =>
      rpc<{ activity: ConversationActivity }>('/rpc/activity', { convId }).then((r) => r.activity),
    isLive: (convId) => rpc<{ live: boolean }>('/rpc/isLive', { convId }).then((r) => r.live),
    snapshot: (convId) => rpc<{ events: ConversationEvent[] }>('/rpc/snapshot', { convId }).then((r) => r.events),
    listSessionFiles: (convId) =>
      rpc<{ refs: CreatedFileRef[] }>('/rpc/listSessionFiles', { convId }).then((r) => r.refs),
    listModels: (provider) => rpc<{ models: ModelOption[] }>('/rpc/listModels', { provider }).then((r) => r.models),
    restart: () => rpc<{ ok: true }>('/rpc/restart', {}).then(() => undefined),
    runScheduledTask: (taskId) => rpc('/rpc/runScheduledTask', { taskId }),
    scheduleWakeup: (convId, actorUserId, key, reason, scheduledFor) =>
      rpc('/rpc/scheduleWakeup', { convId, actorUserId, key, reason, scheduledFor }),
    listWakeups: (convId) =>
      rpc<{ wakeups: ConversationWakeupRow[] }>('/rpc/listWakeups', { convId }).then((r) => r.wakeups),
    cancelWakeup: (convId, wakeupId) => rpc('/rpc/cancelWakeup', { convId, wakeupId }),
    rescheduleWakeup: (convId, wakeupId, scheduledFor) =>
      rpc('/rpc/rescheduleWakeup', { convId, wakeupId, scheduledFor }),
    fireWakeup: (convId, wakeupId) => rpc('/rpc/fireWakeup', { convId, wakeupId }),
    enqueueBuild: (convId, title, brief, actorUserId) => rpc('/rpc/enqueueBuild', { convId, title, brief, actorUserId }),
    listBuildQueue: () => rpc<{ jobs: BuildQueueRow[] }>('/rpc/listBuildQueue', {}).then((r) => r.jobs),
    resolveBuild: (jobId, action) => rpc('/rpc/resolveBuild', { jobId, action }),
    veneerBrowserProfiles: (userId, role, projectId) =>
      rpc('/rpc/veneerBrowserProfiles', { userId, role, projectId }),
    veneerBrowserSetDefault: (userId, projectId, profileId) =>
      rpc<{ ok: true }>('/rpc/veneerBrowserSetDefault', { userId, projectId, profileId }).then(() => undefined),
    veneerBrowserCreate: (userId, projectId, name) =>
      rpc<{ profile: VeneerBrowserProfileView }>('/rpc/veneerBrowserCreate', { userId, projectId, name }).then((r) => r.profile),
    veneerBrowserRename: (userId, projectId, profileId, name) =>
      rpc<{ profile: VeneerBrowserProfileView }>('/rpc/veneerBrowserRename', { userId, projectId, profileId, name }).then((r) => r.profile),
    veneerBrowserDelete: (userId, role, projectId, profileId) =>
      rpc<{ ok: true }>('/rpc/veneerBrowserDelete', { userId, role, projectId, profileId }).then(() => undefined),
    veneerBrowserStop: (userId, projectId, profileId) =>
      rpc<{ profile: VeneerBrowserProfileView }>('/rpc/veneerBrowserStop', { userId, projectId, profileId }).then((r) => r.profile),
    veneerBrowserStatus: (userId, projectId, profileId) =>
      rpc<{ profile: VeneerBrowserProfileView }>('/rpc/veneerBrowserStatus', { userId, projectId, profileId }).then((r) => r.profile),
    veneerBrowserConversation: (userId, convId) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversation', { userId, convId }).then((r) => r.session),
    veneerBrowserConversationProfiles: (userId, convId) =>
      rpc<{ profiles: VeneerBrowserProfileView[] }>('/rpc/veneerBrowserConversationProfiles', { userId, convId }).then((r) => r.profiles),
    veneerBrowserConversationCreate: (userId, convId, name) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversationCreate', { userId, convId, name }).then((r) => r.session),
    veneerBrowserConversationSelect: (userId, convId, profileId) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversationSelect', { userId, convId, profileId }).then((r) => r.session),
    veneerBrowserConversationOpen: (userId, convId) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversationOpen', { userId, convId }).then((r) => r.session),
    veneerBrowserConversationFresh: (userId, convId) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversationFresh', { userId, convId }).then((r) => r.session),
    veneerBrowserConversationUpdateProfile: (userId, convId) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversationUpdateProfile', { userId, convId }).then((r) => r.session),
    veneerBrowserConversationSaveAs: (userId, convId, name) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversationSaveAs', { userId, convId, name }).then((r) => r.session),
    veneerBrowserConversationStop: (userId, convId) =>
      rpc<{ session: VeneerBrowserSessionView }>('/rpc/veneerBrowserConversationStop', { userId, convId }).then((r) => r.session),
    veneerBrowserConversationTicket: (userId, convId) =>
      rpc<{ ticket: string; caFile?: string | null }>('/rpc/veneerBrowserConversationTicket', { userId, convId })
        .then((r) => ({ ticket: r.ticket, caFile: r.caFile ?? null })),
    veneerBrowserConversationCaptureGet: (userId, convId) =>
      rpc<{ capture: VeneerBrowserCaptureView }>('/rpc/veneerBrowserConversationCaptureGet', { userId, convId }).then((r) => r.capture),
    veneerBrowserConversationCaptureSet: (userId, convId, active) =>
      rpc<{ capture: VeneerBrowserCaptureView }>('/rpc/veneerBrowserConversationCaptureSet', { userId, convId, active }).then((r) => r.capture),
    askQuestion: (convId, question, options, multi, allowOther = false, secret, secretKind = 'secret') =>
      rpc<{ requestId: string }>('/rpc/askQuestion', { convId, question, options, multi, allowOther, secret, secretKind })
        .then((r) => r.requestId),
    getQuestion: (requestId) =>
      rpc<{ question: QuestionSnapshot | null }>('/rpc/getQuestion', { requestId }).then((r) => r.question),
    resolveQuestion: (requestId, answers) => rpc('/rpc/resolveQuestion', { requestId, answers }),
    usage: (maxAgeMs) =>
      rpc<{
        snapshots: ClaudeSnapshot[];
        planType: string | null;
        accountEmail?: string | null;
        limitReset?: ClaudeLimitResetStatus | null;
        accounts?: ClaudeAccountUsage[];
      }>('/rpc/usage', {
        maxAgeMs,
      }).then((r) => ({
        snapshots: r.snapshots,
        planType: r.planType ?? null,
        accountEmail: r.accountEmail ?? null,
        limitReset: r.limitReset ?? null,
        accounts: r.accounts ?? [],
      })),
    claudeLimitReset: (accountId) => rpc('/rpc/claudeLimitReset', { accountId }),
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
