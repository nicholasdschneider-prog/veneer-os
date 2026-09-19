// Mirrors server/src/runtime/events.ts (spec §6).
export interface ConnectorToolSource {
  kind: 'connector';
  slug: string;
  name: string;
  mention: string;
  action: string;
  installId?: number;
  label?: string;
  sharing?: 'personal' | 'shared';
}

interface GmailResultConnectorDetails {
  successful?: boolean;
  error?: string;
  gmailUrl?: string;
}

export interface GmailMessageSummary {
  messageRef?: string;
  threadRef?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
  preview?: string;
}

export interface GmailForwardConnectorDetails extends GmailResultConnectorDetails {
  kind: 'gmail-forward';
  messageRef?: string;
  recipients?: string[];
  note?: string;
  sourceSubject?: string;
  sourceSender?: string;
}

export interface GmailSendConnectorDetails extends GmailResultConnectorDetails {
  kind: 'gmail-send';
  recipients?: string[];
  subject?: string;
  body?: string;
}

export interface GmailFetchListConnectorDetails extends GmailResultConnectorDetails {
  kind: 'gmail-fetch-list';
  searchSummary?: string;
  resultCount?: number;
  resultEstimate?: number;
  hasMore?: boolean;
  messages?: GmailMessageSummary[];
}

export interface GmailFetchThreadConnectorDetails extends GmailResultConnectorDetails {
  kind: 'gmail-fetch-thread';
  threadRef?: string;
  subject?: string;
  latestSender?: string;
  latestAt?: string;
  messageCount?: number;
  messages?: GmailMessageSummary[];
}

export interface GmailFetchMessageConnectorDetails extends GmailResultConnectorDetails {
  kind: 'gmail-fetch-message';
  messageRef?: string;
  threadRef?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
  preview?: string;
}

export interface GmailReplyConnectorDetails extends GmailResultConnectorDetails {
  kind: 'gmail-reply';
  threadRef?: string;
  recipients?: string[];
  body?: string;
  subject?: string;
}

export interface GoogleDriveFileSummary {
  name?: string;
  fileType?: string;
  modifiedAt?: string;
  driveUrl?: string;
}

export interface GoogleDriveFindFileConnectorDetails {
  kind: 'google-drive-find-file';
  successful?: boolean;
  searchSummary?: string;
  resultCount?: number;
  hasMore?: boolean;
  files?: GoogleDriveFileSummary[];
}

export interface GoogleSheetsFileSummary {
  name?: string;
  url?: string;
  modifiedAt?: string;
}

export type GoogleSheetsOperation =
  | 'info' | 'read' | 'write' | 'append' | 'clear' | 'search' | 'create' | 'lookup' | 'other';

export interface GoogleSheetsConnectorDetails {
  kind: 'google-sheets';
  operation: GoogleSheetsOperation;
  successful?: boolean;
  actionLabel?: string;
  spreadsheetTitle?: string;
  spreadsheetUrl?: string;
  sheetNames?: string[];
  hasMoreSheets?: boolean;
  range?: string;
  rowCount?: number;
  columnCount?: number;
  updatedCells?: number;
  updatedRows?: number;
  searchSummary?: string;
  resultCount?: number;
  hasMore?: boolean;
  files?: GoogleSheetsFileSummary[];
  error?: string;
}

export type ConnectorToolDetails =
  | GmailForwardConnectorDetails
  | GmailSendConnectorDetails
  | GmailFetchListConnectorDetails
  | GmailFetchThreadConnectorDetails
  | GmailFetchMessageConnectorDetails
  | GmailReplyConnectorDetails
  | GoogleDriveFindFileConnectorDetails
  | GoogleSheetsConnectorDetails;

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

export interface SubagentProgress {
  startedAt?: string;
  durationMs?: number;
  currentAction?: string;
  actionCount?: number;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  resultLabel?: string;
}

/** Authenticated origin for a prompt sent by another agent or an automatic
 * system. Missing means the human authored the prompt. */
export interface MessageOrigin {
  kind: 'agent' | 'wakeup' | 'build_queue';
  from: string;
  to: string;
  /** Authenticated local handoff marker. It never implies source-chat access. */
  local?: true;
  sourceChat?: {
    id: string;
    title: string;
  };
}

export type AgentMessageDisposition = 'running' | 'steered' | 'delivered' | 'queued' | 'duplicate';

/** Viewer-safe sender-side receipt. The server omits raw destination ids unless
 * it can resolve them to a chat this viewer may open. */
export interface AgentMessageToolDetails {
  kind: 'agent-message';
  text: string;
  remoteInstance?: string;
  disposition?: AgentMessageDisposition;
  messageId?: number;
  targetChat?: {
    id: string;
    title: string;
    agentName: string;
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  /** Whole-turn cache reads, a subset of totalInputTokens. Provider-dependent. */
  cachedInputTokens?: number;
  /** Whole-turn cache writes, a subset of totalInputTokens. Claude only. */
  cacheWriteInputTokens?: number;
  contextPct?: number;
}

export type ConversationEvent =
  | {
      type: 'turn_started';
      turnId: string;
      role: 'user';
      text: string;
      at: string;
      via: string;
      origin?: MessageOrigin;
      messageId?: number;
    }
  | { type: 'text_delta'; turnId: string; text: string }
  | {
      type: 'text_final';
      turnId: string;
      markdown: string;
      at: string;
      usage?: TokenUsage;
    }
  | { type: 'thinking'; turnId: string; summary?: string }
  | {
      type: 'tool_started';
      turnId: string;
      toolId: string;
      toolName: string;
      displayName: string;
      inputPreview: string;
      source?: ConnectorToolSource;
      connectorDetails?: ConnectorToolDetails;
      agentMessageDetails?: AgentMessageToolDetails;
    }
  | {
      type: 'tool_finished';
      turnId: string;
      toolId: string;
      ok: boolean;
      resultPreview?: string;
      images?: string[];
      connectorDetails?: ConnectorToolDetails;
      agentMessageDetails?: AgentMessageToolDetails;
    }
  | ({
      type: 'subagent_started';
      turnId: string;
      agentKey: string;
      label: string;
      model?: string;
      role?: string;
      effort?: string;
      status: SubagentStatus;
    } & SubagentProgress)
  | ({
      type: 'subagent_updated';
      turnId: string;
      agentKey: string;
      status: SubagentStatus;
      label?: string;
      model?: string;
      role?: string;
      effort?: string;
    } & SubagentProgress)
  | {
      type: 'approval_requested';
      requestId: string;
      approvalId?: number;
      toolName: string;
      displayName: string;
      input: unknown;
      inputPreview: string;
      policyReason: string;
    }
  | { type: 'approval_resolved'; requestId: string; outcome: 'approved' | 'denied' | 'expired'; byUserId?: number }
  | {
      type: 'question_asked';
      requestId: string;
      turnId?: string;
      questions?: QuestionPrompt[];
      responseMode?: 'poll' | 'provider';
      question?: string;
      options?: QuestionOption[];
      multi?: boolean;
    }
  | {
      type: 'question_answered';
      requestId: string;
      answers?: QuestionAnswers;
      answer?: string;
      expired?: boolean;
      dismissed?: boolean;
    }
  | {
      type: 'turn_done';
      turnId: string;
      outcome?: 'completed' | 'interrupted_by_user' | 'timed_out' | 'failed';
      usage?: TokenUsage;
    }
  | { type: 'context_compacted'; contextTokens: number | null; notice?: string }
  | {
      type: 'memory_recall';
      turnId: string;
      memories: Array<{
        id?: string;
        content: string;
        similarity: number | null;
        scope: 'profile' | 'global' | 'project';
        source?: 'profile' | 'search';
        relevance?: 'profile' | 'direct' | 'semantic';
      }>;
    }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: string; [key: string]: unknown };

export type ConversationStatus = 'working' | 'needs_you' | 'idle' | 'failed';
export type ConversationActivity = 'compacting' | null;

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

/** Where a 'secret' prompt writes the value once the user saves it. */
export interface QuestionSecretTarget {
  name: string;
  project: string | null;
  config: string | null;
  exists?: boolean;
}

export interface QuestionPrompt {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multi: boolean;
  allowOther: boolean;
  /** Absent means 'choice' (every prompt before secrets existed). */
  kind?: 'choice' | 'secret' | 'reveal';
  secret?: QuestionSecretTarget;
}

export type QuestionAnswers = Record<string, string[]>;
export type ApprovalMode = 'ask' | 'auto';

export interface QueuedMessageSnapshot {
  id: number;
  text: string;
  createdAt: string;
  /** Present when another agent or an automatic system queued this message. */
  origin?: MessageOrigin;
}

export interface FailedTurnSnapshot {
  prompt: string;
  attempts: number;
  error: string;
}

export interface ConversationQueueSnapshot {
  /** Monotonic server creation order. Older snapshots must be ignored. */
  revision: number;
  messages: QueuedMessageSnapshot[];
  failedTurn: FailedTurnSnapshot | null;
}

/** A wake-up the agent scheduled for this chat that has not fired yet. */
export interface PendingWakeup {
  id: string;
  key: string;
  reason: string;
  /** ISO 8601, UTC. */
  scheduledFor: string;
  createdAt: string;
}

export interface Conversation {
  isBot?: boolean;
  id: string;
  title: string | null;
  visibility: 'team' | 'private';
  /** True when this user can add messages to the chat. */
  canSend: boolean;
  /** True for every Team collaborator and for the creator of a Private chat. */
  canManage: boolean;
  /** True only for the creator, because visibility changes transcript access. */
  canChangeVisibility: boolean;
  creator: {
    id: number;
    displayName: string;
  };
  provider: string;
  model: string | null;
  lastAnsweredModel?: string | null;
  lastAnsweredProvider?: string | null;
  effort: string | null;
  /** Per-chat override; null inherits the selected agent's setting. */
  approvalMode: ApprovalMode | null;
  effectiveApprovalMode: ApprovalMode;
  /** Full Access overrides both agent and per-chat approval modes. */
  fullAccess: boolean;
  channel: string;
  assistantSlug: string;
  assistantName: string;
  /** Project (folder) this chat belongs to; null = unfiled. Fixed at creation. */
  projectId: string | null;
  /** Chat whose agent spawned this one (handoff etc.); null = human-created. */
  originConversationId: string | null;
  archived: boolean;
  /** Manual pin position; null = not pinned. Lower sorts first. */
  pinOrder: number | null;
  createdAt: string;
  lastActiveAt: string;
  /** Input tokens the provider processed on the most recent turn — the conversation's current "context used". Null until a turn completes with usage. */
  contextTokens: number | null;
  status: ConversationStatus;
  activity: ConversationActivity;
  /** True when an assistant turn finished and this user has not opened the chat since. */
  unread: boolean;
  /** True while this agent/chat has at least one pending self-scheduled wake-up. */
  hasPendingWakeup: boolean;
  /** Set when this chat is one automation run; drives the scheduled-agent strip. Null for ordinary chats. */
  automation: ConversationAutomation | null;
}

export interface ArchivedConversationGroup {
  projectId: string | null;
  projectName: string;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  conversations: Conversation[];
}

/** The automation that produced a chat, as much of it as the chat header needs. */
export interface ConversationAutomation {
  taskId: string;
  name: string;
  triggerKind: 'schedule' | 'event';
  /** Human cadence, e.g. "Every day at 7:00 AM" or the event recipe's name. */
  scheduleText: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runStatus: ScheduledTaskRun['status'];
  runTrigger: ScheduledTaskRun['trigger'];
  /** When this particular run was due. */
  ranAt: string;
}

export type ScheduledTaskSchedule =
  | { type: 'once'; runAt: string }
  | { type: 'daily'; time: string }
  | { type: 'weekdays'; time: string }
  | { type: 'weekly'; time: string; weekday: number }
  | { type: 'cron'; expression: string };

export interface ScheduledTaskRun {
  id: string;
  conversationId: string | null;
  conversationTitle: string | null;
  scheduledFor: string;
  trigger: 'scheduled' | 'event' | 'manual';
  eventId: string | null;
  status: 'queued' | 'running' | 'needs_you' | 'completed' | 'failed' | 'skipped';
  important: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  provider: 'claude' | 'openrouter' | 'codex' | 'grok';
  model: string | null;
  effort: string | null;
  triggerKind: 'schedule' | 'event';
  schedule: ScheduledTaskSchedule | null;
  scheduleText: string;
  timezone: string;
  recipe: string | null;
  connectorId: number | null;
  triggerConfig: Record<string, unknown>;
  filters: AutomationFilter[];
  triggerStatus: 'ready' | 'syncing' | 'error';
  triggerError: string | null;
  enabled: boolean;
  pinned: boolean;
  projectId: string | null;
  projectName: string | null;
  nextRunAt: string | null;
  upcomingRuns: string[];
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  recentRuns: ScheduledTaskRun[];
}

export interface AutomationFilter {
  field: string;
  operator: 'equals' | 'contains' | 'word_count_gt';
  value: string | number;
}

export interface AutomationTriggerRecipe {
  id: string;
  name: string;
  description: string;
  toolkit: string;
  filterFields: Array<{
    key: string;
    label: string;
    operators: AutomationFilter['operator'][];
  }>;
}

export interface AutomationsSummary {
  running: number;
  needsAttention: number;
  recentlyCompleted: number;
}

// A project is a folder with shared context; chats filed under it receive that context.
export interface ProjectAppearance {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  font: string;
  notes: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  instructions: string;
  /** Design overrides for pages and apps; empty fields inherit site defaults. */
  appearance: ProjectAppearance;
  /** Custom root folder (absolute path); null = the default project workspace. Fixed at creation. */
  rootDir: string | null;
  /** Agent new chats here start with; null = use the site-wide default. */
  defaultAgent: string | null;
  /** Stable user-chosen position in project lists; lower sorts first. */
  sortOrder: number;
  createdAt: string;
  chatCount: number;
  lastActiveAt: string | null;
}

export interface VeneerBrowserProfile {
  id: string;
  projectId: string;
  name: string;
  active: boolean;
  status: 'starting' | 'active' | 'stopped' | 'error';
  activeConversationId: string | null;
  activeConversationTitle: string | null;
  activeCloneCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Another user's saved profile. Owners see these only to delete stale logins. */
export interface VeneerBrowserOtherProfile extends VeneerBrowserProfile {
  ownerUserId: number;
  ownerName: string;
}

export interface VeneerBrowserSession {
  configured: boolean;
  active: boolean;
  projectId: string;
  profileId: string | null;
  profileName: string | null;
  status: 'starting' | 'active' | 'stopped' | 'error';
  inUseByAnotherChat: boolean;
  temporaryClone: boolean;
  fresh: boolean;
  canUpdateProfile: boolean;
  startedAt: string | null;
  lastUsedAt: string | null;
  error: string | null;
}

/** One active item in a project workspace or Veneer Pro source build queue. */
export interface BuildQueueJob {
  id: number;
  conversationId: string;
  conversationTitle: string | null;
  assistantName: string;
  provider: string | null;
  projectId: string | null;
  projectName: string | null;
  scopeKey: string;
  /** One-based FIFO position within scopeKey. */
  position: number;
  title: string;
  status: 'queued' | 'running' | 'failed' | 'stopped';
  /** Live chat state; user-attention states take visual precedence over queue progress. */
  conversationStatus: ConversationStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
}

/** One level of the server-side folder browser (GET /api/fs/dirs). */
export interface DirListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  home: string;
}

export interface Me {
  ok: boolean;
  setupRequired: boolean;
  /** Workspace display name from `VP_CLIENT_NAME`; null when unset. */
  clientName: string | null;
  /** Configured public base for published pages (e.g. https://pages.example.com);
   * null when page publishing is not configured. The web app derives the trusted
   * page-artifact host from this instead of hardcoding one. */
  pagesPublicBase?: string | null;
  /** Signed in but not yet approved by an admin — App shows the pending screen. */
  pending?: boolean;
  email?: string;
  user?: { id: number; email: string; displayName: string; role: string; status?: 'pending' | 'active' | 'disabled' };
}

/**
 * A standalone public HTML page an agent published to the configured pages host. `url`
 * is the live public address; `projectId`/`conversationId` are null when the
 * originating project/chat is gone. Timestamps are DB date strings.
 */
export interface Page {
  id: string;
  slug: string;
  title: string;
  url: string;
  projectId: string | null;
  projectName: string | null;
  conversationId: string | null;
  creator: {
    id: number | null;
    displayName: string;
  };
  /** Manual pin position; null means not pinned. Lower values sort first. */
  pinOrder: number | null;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  /** Public content is removed at this UTC timestamp. */
  expiresAt: string;
}

/** A private Mini App mounted below this client's /tools path. */
export interface MiniApp {
  id: string;
  slug: string;
  title: string;
  url: string;
  runtime: 'cloudflare' | 'local';
  runtimeStatus: {
    status: 'starting' | 'running' | 'restarting' | 'stopped' | 'error' | 'unavailable';
    error: string | null;
    pid: number | null;
  } | null;
  status: 'deploying' | 'deployed' | 'error';
  lastError: string | null;
  projectId: string | null;
  projectName: string | null;
  conversationId: string | null;
  sourceSizeBytes: number;
  createdAt: string;
  updatedAt: string;
  deployedAt: string | null;
}

export type BuiltinNavigationKey = 'automations' | 'todos' | 'pages' | 'apps' | 'terminal';
export type MiniAppNavigationIcon = 'app' | 'chart' | 'table' | 'calendar' | 'list' | 'star';

export type WorkspaceNavigationItem =
  | { kind: 'builtin'; key: BuiltinNavigationKey; visible: boolean }
  | {
      kind: 'app';
      appId: string;
      visible: boolean;
      icon: MiniAppNavigationIcon;
      label: string | null;
      /** Current Mini App title, resolved by the server and not stored in the preference. */
      title: string;
    };

export interface WorkspaceNavigation {
  items: WorkspaceNavigationItem[];
}

/** A user-defined column on the Todos screen. "Inbox" (categoryId null) is implicit and always first. */
export interface TodoCategory {
  id: string;
  name: string;
  sortOrder: number;
}

/** A link or file attachment carried by a todo. `href` is a URL (link) or a server path (file). */
export interface TodoLink {
  id: string;
  kind: 'link' | 'file';
  href: string;
  label: string | null;
}

/**
 * One scratch-pad todo (#/todos). `state` is 'pending' (not yet acted on),
 * 'active' (fired off as a chat — `conversationId` then points at it), or 'done'
 * (finished/archived). `categoryId` null lands it in the implicit Inbox column;
 * `projectId` is the project selected for its eventual chat.
 */
export interface Todo {
  id: string;
  title: string;
  notes: string;
  categoryId: string | null;
  projectId: string | null;
  state: 'pending' | 'active' | 'done';
  conversationId: string | null;
  sortOrder: number;
  links: TodoLink[];
  createdAt: string;
  updatedAt: string;
}
