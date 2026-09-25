import type {
  ApprovalMode,
  AutomationFilter,
  ArchivedConversationGroup,
  AutomationTriggerRecipe,
  AutomationsSummary,
  BuildQueueJob,
  Conversation,
  ConversationEvent,
  ConversationQueueSnapshot,
  ConversationStatus,
  DirListing,
  Me,
  MiniApp,
  Page,
  Project,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
  Todo,
  TodoCategory,
  TodoLink,
  VeneerBrowserOtherProfile,
  VeneerBrowserProfile,
  VeneerBrowserSession,
  WorkspaceNavigation,
} from './types';
import type { Artifact } from './artifacts';
import { toPendingWakeups, type WakeupRow } from './wakeups';

const codexAccountListeners = new Set<() => void>();

export function subscribeCodexAccountChanges(listener: () => void): () => void {
  codexAccountListeners.add(listener);
  return () => { codexAccountListeners.delete(listener); };
}

function codexAccountChanged<T>(result: T): T {
  for (const listener of codexAccountListeners) listener();
  return result;
}

/** Concurrent-editing file-lock coordination (Settings → Agents). */
export interface FileLockConfig {
  enabled: boolean;
  ttlSeconds: number;
}

export interface ResolvedProjectFile {
  kind: 'file' | 'directory';
  path: string;
  absolutePath: string;
  line: number | null;
  column: number | null;
}

/** Secret-free diagnostic view of the backend context used for a chat. */
export interface ConversationDebugContext {
  runtime: {
    provider: 'claude' | 'openrouter' | 'codex' | 'grok';
    model: string | null;
    effort: string | null;
    assistantSlug: string;
    projectName: string | null;
    channel: 'web' | 'email' | 'automation';
    workspaceDir: string;
    approvalMode: ApprovalMode | null;
    effectiveApprovalMode: ApprovalMode;
    contextTokens: number | null;
  };
  providerSystemPrompt: { available: false; note: string };
  instructions: {
    capturedAt: string | null;
    exactReceipt: boolean;
    delivery: 'claude-appended-system-prompt' | 'codex-developer-instructions' | null;
    core: {
      source: 'Veneer Pro';
      role: 'system/developer';
      version: number;
      hash: string;
      current: boolean;
      content: string;
    } | null;
    chatSnapshot: {
      source: 'Agent and project settings';
      role: 'system/developer';
      version: number;
      capturedAt: string;
      hash: string;
      current: boolean;
      settingsCurrent: boolean;
      content: string;
    } | null;
    repository: {
      source: 'Repository instruction files';
      role: 'provider-native';
      current: boolean;
      files: Array<{
        path: string;
        role: 'provider-native repository guidance';
        version: string;
        current: boolean;
        legacyGenerated: boolean;
      }>;
      note: string;
    } | null;
    memory: {
      source: 'Shared memory recall';
      role: 'user reference data';
      current: boolean;
      present: boolean;
      content: string | null;
    } | null;
    note: string;
  };
  tooling: {
    mcpServers: string[];
    allowedPermissions: string[];
    deniedPermissions: string[];
    skills: string[];
    snapshotAvailable: boolean;
  };
}

/**
 * Error thrown by requestJson, carrying the HTTP status and decoded body so
 * callers can branch on structured failures (e.g. the file API's 409
 * 'conflict' with the on-disk mtime, or 413 'too-large' with the size).
 * message stays the server's error string, so existing catch handlers that
 * only read .message keep working.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !body || body.ok === false) {
    throw new ApiError(
      body?.error ?? `Request failed (${res.status})`,
      res.status,
      body as unknown as Record<string, unknown> | null,
    );
  }
  return body;
}

async function apiErrorFromResponse(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(body?.error ?? fallback, res.status, body);
}

export interface SystemUsage {
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  sampledAt: string;
}

export const api = {
  me: () => requestJson<Me>('/api/me'),
  systemUsage: () => requestJson<{ ok: true; usage: SystemUsage }>('/api/system/usage'),
  setup: (displayName: string) =>
    requestJson<Me>('/api/setup', { method: 'POST', body: JSON.stringify({ displayName }) }),
  // project: a project id filters to that project; 'none' returns only unfiled
  // chats; omit for all. (Ignored by the server for the archived view.)
  conversations: (archived = false, project?: string) => {
    const qs = new URLSearchParams();
    if (archived) qs.set('archived', 'true');
    if (project) qs.set('project', project);
    const q = qs.toString();
    return requestJson<{ conversations: Conversation[] }>(`/api/conversations${q ? `?${q}` : ''}`);
  },
  archivedConversations: (options?: {
    query?: string;
    projectId?: string | null;
    page?: number;
    pageSize?: number;
  }) => {
    const qs = new URLSearchParams();
    if (options?.query) qs.set('query', options.query);
    if (options && 'projectId' in options) qs.set('project', options.projectId ?? 'none');
    if (options?.page) qs.set('page', String(options.page));
    if (options?.pageSize) qs.set('pageSize', String(options.pageSize));
    const q = qs.toString();
    return options && 'projectId' in options
      ? requestJson<{ group: ArchivedConversationGroup }>(`/api/archived-conversations${q ? `?${q}` : ''}`)
      : requestJson<{ groups: ArchivedConversationGroup[] }>(`/api/archived-conversations${q ? `?${q}` : ''}`);
  },
  chatAutoArchiveSettings: () =>
    requestJson<{ settings: ChatAutoArchiveSettings }>('/api/chat/auto-archive-settings'),
  updateChatAutoArchiveSettings: (settings: ChatAutoArchiveSettings) =>
    requestJson<{ settings: ChatAutoArchiveSettings; archivedCount: number }>('/api/chat/auto-archive-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  chatAppearanceSettings: () =>
    requestJson<{ settings: ChatAppearanceSettings }>('/api/chat/appearance-settings'),
  updateChatAppearanceSettings: (settings: ChatAppearanceSettings) =>
    requestJson<{ settings: ChatAppearanceSettings }>('/api/chat/appearance-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  todoPlanningSettings: () =>
    requestJson<{ settings: TodoPlanningSettings }>('/api/chat/todo-planning-settings'),
  updateTodoPlanningSettings: (settings: TodoPlanningSettings) =>
    requestJson<{ settings: TodoPlanningSettings }>('/api/chat/todo-planning-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  assistants: () => requestJson<{ assistants: AssistantType[] }>('/api/assistants'),
  createAssistant: (input: { name: string; instructions?: string }) =>
    requestJson<{ assistant: AssistantType }>('/api/assistants', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAssistant: (
    slug: string,
    patch: { name?: string; instructions?: string; approval_mode?: ApprovalMode; full_access?: boolean },
  ) =>
    requestJson<{ assistant: AssistantType }>(`/api/assistants/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteAssistant: (slug: string) =>
    requestJson<{
      deleted: string;
      prefs: ModelPrefs;
      replacement: { slug: string; name: string };
      reassigned: { projects: number; automations: number };
    }>(`/api/assistants/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  models: (provider: string) =>
    requestJson<{ models: ModelOption[] }>(`/api/models?provider=${encodeURIComponent(provider)}`),
  modelPrefs: () => requestJson<{ prefs: ModelPrefs }>('/api/model-prefs'),
  updateModelPrefs: (prefs: ModelPrefs) =>
    requestJson<{ prefs: ModelPrefs }>('/api/model-prefs', { method: 'PUT', body: JSON.stringify(prefs) }),
  apiKeys: () => requestJson<{ keys: ApiKeyStatus[] }>('/api/admin/api-keys'),
  // Empty value clears the override (reverts to the server default).
  setApiKey: (id: string, value: string) =>
    requestJson<{ keys: ApiKeyStatus[] }>(`/api/admin/api-keys/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  doppler: () => requestJson<{ connection: DopplerConnection }>('/api/admin/doppler'),
  connectDoppler: (body: {
    project: string;
    config: string;
    runtimeToken?: string;
    agentToken?: string;
  }) =>
    requestJson<{
      connection: DopplerConnection;
      memory?: { configured: boolean; error?: string };
    }>('/api/admin/doppler', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  testDoppler: () =>
    requestJson<{ connection: DopplerConnection }>('/api/admin/doppler/test', { method: 'POST' }),
  updateDopplerGuidance: (additionalGuidance: string) =>
    requestJson<{ connection: DopplerConnection }>('/api/admin/doppler/guidance', {
      method: 'PUT',
      body: JSON.stringify({ additionalGuidance }),
    }),
  disconnectDoppler: () =>
    requestJson<{ connection: DopplerConnection }>('/api/admin/doppler', { method: 'DELETE' }),
  clientLogo: async (): Promise<Blob | null> => {
    const res = await fetch('/api/client-logo', { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiErrorFromResponse(res, `Logo could not be loaded (${res.status})`);
    return res.blob();
  },
  updateClientLogo: async (logo: Blob): Promise<void> => {
    const res = await fetch('/api/admin/client-logo', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: logo,
    });
    if (!res.ok) throw await apiErrorFromResponse(res, `Logo could not be saved (${res.status})`);
  },
  deleteClientLogo: () => requestJson<{ ok: true }>('/api/admin/client-logo', { method: 'DELETE' }),
  voiceSettings: () => requestJson<{ settings: VoiceSettings }>('/api/admin/voice-settings'),
  updateVoiceSettings: (settings: VoiceSettings) =>
    requestJson<{ settings: VoiceSettings }>('/api/admin/voice-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  // Team/users admin (owner only). List everyone who's signed in; PATCH sends
  // only changed fields (approve = status:'active'). Errors: 403 editing your
  // own account, 409 removing the last active admin.
  adminCreateUser: (email: string, displayName: string) => requestJson<{ user: AdminUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify({ email, displayName }) }),
  adminListUsers: () => requestJson<{ users: AdminUser[] }>('/api/admin/users'),
  adminUpdateUser: (id: number, patch: { role?: 'owner' | 'member'; status?: AdminUserStatus; displayName?: string }) =>
    requestJson<{ user: AdminUser }>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  fileLock: () => requestJson<{ config: FileLockConfig }>('/api/filelock'),
  updateFileLock: (config: FileLockConfig) =>
    requestJson<{ config: FileLockConfig }>('/api/filelock', { method: 'PUT', body: JSON.stringify(config) }),
  createConversation: (
    firstMessage: string,
    opts?: {
      id?: string;
      assistantSlug?: string;
      provider?: string;
      model?: string;
      effort?: string;
      approval_mode?: ApprovalMode;
      projectId?: string;
      visibility?: 'team' | 'private';
    },
  ) =>
    requestJson<{ conversation: Conversation }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ firstMessage, ...opts }),
    }),
  conversation: (id: string) => requestJson<{ conversation: Conversation }>(`/api/conversations/${id}`),
  // Side chats: ask about a chat without interrupting its agent.
  coordinationThreads: (id: string) => requestJson<{threads: import('../components/chat/Coordination').CoordinationSummary[]}>(`/api/conversations/${id}/coordination`),
  coordinationThread: (id: string) => requestJson<import('../components/chat/Coordination').CoordinationView>(`/api/coordination/${encodeURIComponent(id)}`),
  sideChats: (id: string) =>
    requestJson<{ sideChats: SideChatSummary[] }>(`/api/conversations/${id}/side-chats`),
  createSideChat: (id: string, firstMessage: string) =>
    requestJson<{ conversation: Conversation }>(`/api/conversations/${id}/side-chats`, {
      method: 'POST',
      body: JSON.stringify({ firstMessage }),
    }),
  conversationContext: (id: string) =>
    requestJson<{ context: ConversationDebugContext }>(`/api/conversations/${id}/context`),
  freshConversationContext: (id: string) =>
    requestJson<{ conversation: Conversation }>(`/api/conversations/${id}/fresh-context`, { method: 'POST' }),
  switchConversationModel: (id: string, selection: { provider: string; model: string; effort: string }) =>
    requestJson<{ conversation: Conversation }>(`/api/conversations/${id}/model`, {
      method: 'POST', body: JSON.stringify(selection),
    }),
  updateConversation: (
    id: string,
    patch: {
      title?: string;
      archived?: boolean;
      visibility?: 'team' | 'private';
      model?: string;
      effort?: string | null;
      approval_mode?: ApprovalMode | null;
      pinned?: boolean;
      /** Move the chat to another project; null unfiles it. */
      projectId?: string | null;
    },
    // keepalive lets the write complete during a page unload (used to flush a
    // deferred archive when the tab is refreshed/closed mid grace-period).
    opts?: { keepalive?: boolean },
  ) =>
    requestJson<{ conversation: Conversation }>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      keepalive: opts?.keepalive,
    }),
  // "Mark as unread" for the current user only; returns the refreshed row.
  markConversationUnread: (id: string) =>
    requestJson<{ conversation: Conversation }>(`/api/conversations/${id}/unread`, { method: 'POST' }),
  // The full pinned list in its new order; the server renumbers pin positions.
  reorderPins: (ids: string[]) =>
    requestJson<{ ok: boolean }>('/api/conversations/pins', { method: 'PUT', body: JSON.stringify({ ids }) }),
  transcript: (id: string) =>
    requestJson<{ events: ConversationEvent[]; status: ConversationStatus }>(`/api/conversations/${id}/transcript`),
  // Files the agent created in this chat (CSV etc.), detected server-side from
  // the session transcript. Preview returns capped text; the download URL
  // streams the file as an attachment.
  conversationFiles: (id: string) => requestJson<{ files: SessionFile[] }>(`/api/conversations/${id}/files`),
  conversationArtifacts: (id: string) =>
    requestJson<{ artifacts: Artifact[] }>(`/api/conversations/${id}/artifacts`),
  conversationFilePreview: (id: string, filePath: string) =>
    requestJson<{ file: SessionFile; content?: string; truncated?: boolean; binary?: boolean }>(
      `/api/conversations/${id}/files/content?path=${encodeURIComponent(filePath)}`,
    ),
  conversationFileInlineUrl: (id: string, filePath: string) =>
    `/api/conversations/${id}/files/content?path=${encodeURIComponent(filePath)}&inline=1`,
  conversationFileDownloadUrl: (id: string, filePath: string) =>
    `/api/conversations/${id}/files/content?path=${encodeURIComponent(filePath)}&download=1`,
  sendMessage: (id: string, text: string) =>
    requestJson<{
      status: ConversationStatus;
      messageId: number;
      disposition: 'running' | 'steered' | 'delivered' | 'queued' | 'duplicate';
      queue: ConversationQueueSnapshot;
    }>(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  // Mid-turn sends join the working reply at its next step. The server keeps a
  // durable queue row and reports 'queued' whenever the provider cannot steer.
  steerMessage: (id: string, text: string) =>
    requestJson<{
      status: ConversationStatus;
      messageId: number;
      disposition: 'running' | 'steered' | 'delivered' | 'queued' | 'duplicate';
      queue: ConversationQueueSnapshot;
    }>(`/api/conversations/${id}/steer`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  queueMessage: (id: string, text: string) =>
    requestJson<{
      status: ConversationStatus;
      messageId: number;
      disposition: 'running' | 'queued';
      queue: ConversationQueueSnapshot;
    }>(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, queueOnly: true }),
    }),
  updateQueuedMessage: (id: string, messageId: number, text: string) =>
    requestJson<{ ok: boolean; error?: string; queue: ConversationQueueSnapshot }>(
      `/api/conversations/${id}/queue/${messageId}`,
      { method: 'PATCH', body: JSON.stringify({ text }) },
    ),
  removeQueuedMessage: (id: string, messageId: number) =>
    requestJson<{ ok: boolean; error?: string; queue: ConversationQueueSnapshot }>(
      `/api/conversations/${id}/queue/${messageId}`,
      { method: 'DELETE' },
    ),
  sendQueuedMessageNow: (id: string, messageId: number) =>
    requestJson<{ ok: boolean; error?: string; queue: ConversationQueueSnapshot }>(
      `/api/conversations/${id}/queue/${messageId}/send-now`,
      { method: 'POST' },
    ),
  reorderQueuedMessages: (id: string, messageIds: number[]) =>
    requestJson<{ ok: boolean; error?: string; queue: ConversationQueueSnapshot }>(`/api/conversations/${id}/queue`, {
      method: 'PUT',
      body: JSON.stringify({ messageIds }),
    }),
  retryFailedTurn: (id: string) =>
    requestJson<{ ok: boolean; error?: string; queue: ConversationQueueSnapshot }>(
      `/api/conversations/${id}/failed-turn/retry`,
      { method: 'POST' },
    ),
  discardFailedTurn: (id: string) =>
    requestJson<{ ok: boolean; error?: string; queue: ConversationQueueSnapshot }>(
      `/api/conversations/${id}/failed-turn`,
      { method: 'DELETE' },
    ),
  compactConversation: (id: string) =>
    requestJson<{ ok: true; contextTokens: number | null }>(`/api/conversations/${id}/compact`, {
      method: 'POST',
    }),
  listWakeups: (id: string) =>
    requestJson<{ ok: boolean; wakeups: WakeupRow[] }>(`/api/conversations/${id}/wakeups`).then((r) =>
      toPendingWakeups(r.wakeups),
    ),
  cancelWakeup: (id: string, wakeupId: string) =>
    requestJson<{ ok: boolean; error?: string }>(`/api/conversations/${id}/wakeups/${wakeupId}`, {
      method: 'DELETE',
    }),
  rescheduleWakeup: (id: string, wakeupId: string, runAt: string) =>
    requestJson<{ ok: boolean; error?: string }>(`/api/conversations/${id}/wakeups/${wakeupId}`, {
      method: 'PATCH',
      body: JSON.stringify({ runAt }),
    }),
  fireWakeup: (id: string, wakeupId: string) =>
    requestJson<{ ok: boolean; error?: string }>(`/api/conversations/${id}/wakeups/${wakeupId}/fire`, {
      method: 'POST',
    }),
  interrupt: (id: string) => requestJson<{ interrupted: boolean }>(`/api/conversations/${id}/interrupt`, { method: 'POST' }),
  // Raw-body upload (not multipart): the File streams as the request body and
  // the name travels in the query. Content-Type is forced to octet-stream so
  // the server's JSON body parser never touches it (e.g. an uploaded .json).
  uploadFile: async (file: File): Promise<UploadedFile> => {
    const res = await fetch(`/api/uploads?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; file?: UploadedFile }
      | null;
    if (!res.ok || !body?.ok || !body.file) {
      throw new Error(body?.error ?? `Upload failed (${res.status})`);
    }
    return body.file;
  },
  deleteConversation: (id: string) => requestJson<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),

  // Projects bundle a folder with settings saved into each new chat snapshot.
  // Repository instruction files stay user-owned.
  projects: () => requestJson<{ projects: Project[] }>('/api/projects'),
  buildQueue: () => requestJson<{ jobs: BuildQueueJob[] }>('/api/build-queue'),
  removeBuildQueueJob: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/build-queue/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'skip' }),
    }),
  retryBuildQueueJob: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/build-queue/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'retry' }),
    }),
  project: (id: string) => requestJson<{ project: Project }>(`/api/projects/${id}`),
  createProject: (body: {
    name: string;
    instructions?: string;
    appearance?: Project['appearance'];
    rootDir?: string;
  }) =>
    requestJson<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  reorderProjects: (ids: string[]) =>
    requestJson<{ ok: boolean }>('/api/projects/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  updateProject: (
    id: string,
    patch: {
      name?: string;
      instructions?: string;
      appearance?: Project['appearance'];
      defaultAgent?: string | null;
    },
  ) =>
    requestJson<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: string) => requestJson<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  // `profiles` is only the signed-in user's; `others` is empty unless the
  // caller is an owner.
  veneerBrowserProfiles: (projectId: string) =>
    requestJson<{
      configured: boolean;
      defaultProfileId: string | null;
      profiles: VeneerBrowserProfile[];
      others: VeneerBrowserOtherProfile[];
    }>(`/api/veneer-browser/projects/${encodeURIComponent(projectId)}/profiles`),
  selectVeneerBrowserProfile: (projectId: string, profileId: string) =>
    requestJson<{ ok: boolean }>(
      `/api/veneer-browser/projects/${encodeURIComponent(projectId)}/default`,
      { method: 'PUT', body: JSON.stringify({ profileId }) },
    ),
  createVeneerBrowserProfile: (projectId: string, name: string) =>
    requestJson<{ profile: VeneerBrowserProfile }>(
      `/api/veneer-browser/projects/${encodeURIComponent(projectId)}/profiles`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
  renameVeneerBrowserProfile: (projectId: string, profileId: string, name: string) =>
    requestJson<{ profile: VeneerBrowserProfile }>(
      `/api/veneer-browser/projects/${encodeURIComponent(projectId)}/profiles/${encodeURIComponent(profileId)}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    ),
  deleteVeneerBrowserProfile: (projectId: string, profileId: string) =>
    requestJson<{ ok: boolean }>(
      `/api/veneer-browser/projects/${encodeURIComponent(projectId)}/profiles/${encodeURIComponent(profileId)}`,
      { method: 'DELETE', body: JSON.stringify({ confirm: true }) },
    ),
  stopVeneerBrowserProfile: (projectId: string, profileId: string) =>
    requestJson<{ profile: VeneerBrowserProfile }>(
      `/api/veneer-browser/projects/${encodeURIComponent(projectId)}/profiles/${encodeURIComponent(profileId)}/stop`,
      { method: 'POST' },
    ),
  veneerBrowserProfileStatus: (projectId: string, profileId: string) =>
    requestJson<{ profile: VeneerBrowserProfile }>(
      `/api/veneer-browser/projects/${encodeURIComponent(projectId)}/profiles/${encodeURIComponent(profileId)}/status`,
    ),
  veneerBrowserConversation: (conversationId: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}`,
    ),
  veneerBrowserConversationProfiles: (conversationId: string) =>
    requestJson<{ profiles: VeneerBrowserProfile[] }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/profiles`,
    ),
  createVeneerBrowserConversationProfile: (conversationId: string, name: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/profiles`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
  selectVeneerBrowserConversationProfile: (conversationId: string, profileId: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/profile`,
      { method: 'PUT', body: JSON.stringify({ profileId }) },
    ),
  /** A LAN-served viewer page for this chat, or null when this host has no LAN door. */
  lanVeneerBrowserViewer: async (conversationId: string): Promise<string | null> => {
    const res = await fetch(`/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/lan-viewer`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { viewerUrl?: unknown } | null;
    return typeof body?.viewerUrl === 'string' ? body.viewerUrl : null;
  },
  openVeneerBrowserConversation: (conversationId: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/open`,
      { method: 'POST' },
    ),
  openFreshVeneerBrowserConversation: (conversationId: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/fresh`,
      { method: 'POST' },
    ),
  updateVeneerBrowserConversationProfile: (conversationId: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/update-profile`,
      { method: 'POST' },
    ),
  saveVeneerBrowserConversationAs: (conversationId: string, name: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/save-as`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
  stopVeneerBrowserConversation: (conversationId: string) =>
    requestJson<{ session: VeneerBrowserSession }>(
      `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/stop`,
      { method: 'POST' },
    ),
  // Folder picker for new projects (all active users): list a directory's
  // subdirectories; no path = the server user's home.
  browseDirs: (path?: string) =>
    requestJson<DirListing>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  approvals: (status = 'pending') => requestJson<{ approvals: Approval[] }>(`/api/approvals?status=${status}`),
  resolveApproval: (id: number, outcome: 'approved' | 'denied') =>
    requestJson<{ approval: Approval; status: ConversationStatus }>(`/api/approvals/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome }),
    }),

  // Answer an ask_user question (global by requestId, like resolveApproval).
  resolveQuestion: (requestId: string, answers: Record<string, string[]>) =>
    requestJson<{ status: ConversationStatus }>(`/api/questions/${encodeURIComponent(requestId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),

  // Store a request_secret value straight into Doppler. The value never enters
  // the transcript, so it is posted here instead of through resolveQuestion.
  saveSecret: (requestId: string, value: string) =>
    requestJson<{ status: ConversationStatus }>(`/api/questions/${encodeURIComponent(requestId)}/save-secret`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    }),

  // Show an existing Doppler secret to this user only. The value is returned
  // here and nowhere else — never to the agent, an event, or the transcript.
  revealSecretValue: (requestId: string) =>
    requestJson<{ value: string }>(`/api/questions/${encodeURIComponent(requestId)}/reveal-secret-value`),

  // Decline a reveal_secret card.
  dismissReveal: (requestId: string) =>
    requestJson<{ status: ConversationStatus }>(
      `/api/questions/${encodeURIComponent(requestId)}/dismiss-reveal`,
      { method: 'POST' },
    ),

  // Restart the service to unstick it (owner/consultant only). Returns 202;
  // the server exits right after, so treat a dropped/failed response as success.
  adminRestart: () => requestJson<{ restarting: boolean }>('/api/admin/restart', { method: 'POST' }),

  // Claude account (owner/consultant only).
  providerVersions: () =>
    requestJson<{ versions: ProviderRuntimeVersions }>('/api/admin/provider-versions'),
  claudeStatus: () => requestJson<ClaudeStatus>('/api/admin/claude/status'),
  claudePreferences: () =>
    requestJson<{ preferences: ClaudePreferences }>('/api/admin/claude/preferences'),
  updateClaudePreferences: (preferences: ClaudePreferences) =>
    requestJson<{ preferences: ClaudePreferences }>('/api/admin/claude/preferences', {
      method: 'PUT',
      body: JSON.stringify(preferences),
    }),
  claudeConnectStart: () =>
    requestJson<{ attemptId: string; authorizeUrl: string; expiresAt: string }>('/api/admin/claude/connect/start', {
      method: 'POST',
    }),
  claudeConnectComplete: (attemptId: string, code: string) =>
    requestJson<{ connected: boolean; probe: ProbeResult; account?: ClaudeAccount; accounts?: ClaudeAccount[] }>(
      '/api/admin/claude/connect/complete',
      { method: 'POST', body: JSON.stringify({ attemptId, code }) },
    ),
  // Switch which connected Claude account new turns run on (takes effect on the
  // next message — a turn already running finishes on its own account).
  claudeAccountActivate: (id: string) =>
    requestJson<{ accounts: ClaudeAccount[] }>(`/api/admin/claude/accounts/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    }),
  claudeLimitReset: (id: string) =>
    requestJson<ClaudeLimitResetClaim>(
      `/api/admin/claude/accounts/${encodeURIComponent(id)}/limit-reset`,
      { method: 'POST' },
    ),
  claudeAccountRename: (id: string, label: string) =>
    requestJson<{ accounts: ClaudeAccount[] }>(`/api/admin/claude/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    }),
  claudeAccountRemove: (id: string) =>
    requestJson<{ accounts: ClaudeAccount[]; connected: boolean }>(
      `/api/admin/claude/accounts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  claudeConnectCancel: (attemptId: string) =>
    requestJson<{ cancelled: boolean }>('/api/admin/claude/connect/cancel', {
      method: 'POST',
      body: JSON.stringify({ attemptId }),
    }),
  claudeDisconnect: () =>
    requestJson<{ connected: boolean }>('/api/admin/claude/disconnect', { method: 'POST' }),
  claudeTest: () => requestJson<{ result: ProbeResult }>('/api/admin/claude/test', { method: 'POST' }),
  openRouterTest: () => requestJson<{ result: ProbeResult }>('/api/admin/openrouter/test', { method: 'POST' }),

  // Codex accounts (owner/consultant only). Codex owns `$CODEX_HOME/auth.json`,
  // so there's no token to store — each account is its own profile directory
  // and the device flow drives `codex login` into a staging one.
  codexStatus: () => requestJson<CodexStatus>('/api/admin/codex/status'),
  codexInstall: () => requestJson<{ detail: string }>('/api/admin/codex/install', { method: 'POST' }),
  // Adding an account never signs a connected one out (the login lands in a
  // staging profile), so nothing changes until the poll reports success.
  codexConnectStart: () =>
    requestJson<{ attemptId: string; verificationUrl: string; userCode: string; expiresAt: string }>(
      '/api/admin/codex/connect/start',
      { method: 'POST', body: JSON.stringify({}) },
    ),
  codexConnectPoll: (attemptId: string) =>
    requestJson<{ state: CodexAttemptState; detail: string; account?: CodexAccount | null; accounts?: CodexAccount[] }>(
      '/api/admin/codex/connect/poll',
      { method: 'POST', body: JSON.stringify({ attemptId }) },
    ).then((result) => result.state === 'success' ? codexAccountChanged(result) : result),
  codexConnectCancel: (attemptId: string) =>
    requestJson<{ cancelled: boolean }>('/api/admin/codex/connect/cancel', {
      method: 'POST',
      body: JSON.stringify({ attemptId }),
    }),
  // Switch which connected Codex account new turns run on (next message).
  codexAccountActivate: (id: string) =>
    requestJson<{ accounts: CodexAccount[] }>(`/api/admin/codex/accounts/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    }).then(codexAccountChanged),
  codexAccountRename: (id: string, label: string) =>
    requestJson<{ accounts: CodexAccount[] }>(`/api/admin/codex/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    }),
  codexAccountRemove: (id: string) =>
    requestJson<{ accounts: CodexAccount[]; connected: boolean }>(
      `/api/admin/codex/accounts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ).then(codexAccountChanged),
  codexDisconnect: () =>
    requestJson<{ connected: boolean }>('/api/admin/codex/disconnect', { method: 'POST' }).then(codexAccountChanged),

  // Grok account (owner/consultant only). Same device-code flow as Codex — the
  // CLI owns $GROK_HOME/auth.json, so there's no token to store. Unlike Codex,
  // starting a sign-in does NOT log the current account out.
  grokStatus: () => requestJson<GrokStatus>('/api/admin/grok/status'),
  grokInstall: () => requestJson<{ detail: string }>('/api/admin/grok/install', { method: 'POST' }),
  grokConnectStart: (force = false) =>
    requestJson<{ attemptId: string; verificationUrl: string; userCode: string; expiresAt: string }>(
      '/api/admin/grok/connect/start',
      { method: 'POST', body: JSON.stringify({ force }) },
    ),
  grokConnectPoll: (attemptId: string) =>
    requestJson<{ state: GrokAttemptState; detail: string }>('/api/admin/grok/connect/poll', {
      method: 'POST',
      body: JSON.stringify({ attemptId }),
    }),
  grokConnectCancel: (attemptId: string) =>
    requestJson<{ cancelled: boolean }>('/api/admin/grok/connect/cancel', {
      method: 'POST',
      body: JSON.stringify({ attemptId }),
    }),
  grokDisconnect: () =>
    requestJson<{ connected: boolean }>('/api/admin/grok/disconnect', { method: 'POST' }),

  // Provider rate-limit usage (owner/consultant only). Claude data is passive
  // and can be stale; ?refresh=1 forces a Claude probe and bypasses Grok /
  // OpenRouter caches.
  usage: (refresh = false) => requestJson<UsageResponse>(`/api/usage${refresh ? '?refresh=1' : ''}`),

  // Toolbox connections (consultant full; owner scoped to owner-managed).
  connections: () => requestJson<{ connections: Connection[] }>('/api/connections'),
  createConnection: (body: ConnectionWrite) =>
    requestJson<{ connection: Connection }>('/api/connections', { method: 'POST', body: JSON.stringify(body) }),
  updateConnection: (id: number, patch: Partial<ConnectionWrite>) =>
    requestJson<{ connection: Connection }>(`/api/connections/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteConnection: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/connections/${id}`, { method: 'DELETE' }),
  testConnection: (id: number) =>
    requestJson<{ result: TestResult }>(`/api/connections/${id}/test`, { method: 'POST' }),

  // File manager (owner/consultant only). "root" is a named root id from
  // fileRoots; "path" is a forward-slash relative path inside it ('' = the
  // root itself). Structured failures surface as ApiError: read 409 'conflict'
  // (body.mtime), 413 'too-large' / 415 'binary' (body.size) off err.body.
  fileRoots: () => requestJson<{ roots: FileRoot[] }>('/api/files/roots'),
  resolveProjectFileLink: (projectId: string, target: string) =>
    requestJson<{ file: ResolvedProjectFile }>(
      `/api/files/resolve-link?root=${encodeURIComponent(`project:${projectId}`)}&target=${encodeURIComponent(target)}`,
    ),
  fileList: (root: string, path: string) =>
    requestJson<{ entries: FileEntry[] }>(
      `/api/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  fileRead: (root: string, path: string) =>
    requestJson<{ content: string; size: number; mtime: number }>(
      `/api/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  projectFileMarkdownImageUrl: (projectId: string, path: string, image: string) =>
    `/api/files/read?root=${encodeURIComponent(`project:${projectId}`)}&path=${encodeURIComponent(path)}&image=${encodeURIComponent(image)}`,
  conversationFileMarkdownImageUrl: (id: string, path: string, image: string) =>
    `/api/conversations/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}&image=${encodeURIComponent(image)}`,
  generatedFileMarkdownImageUrl: (id: string, image: string) =>
    `/api/generated-files/${encodeURIComponent(id)}/preview?image=${encodeURIComponent(image)}`,
  fileWrite: (body: { root: string; path: string; content: string; expectedMtime?: number }) =>
    requestJson<{ mtime: number }>('/api/files/write', { method: 'PUT', body: JSON.stringify(body) }),
  fileMkdir: (root: string, path: string) =>
    requestJson<{ ok: boolean }>('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ root, path }) }),
  fileRename: (root: string, from: string, to: string) =>
    requestJson<{ ok: boolean }>('/api/files/rename', { method: 'POST', body: JSON.stringify({ root, from, to }) }),
  fileDelete: (root: string, path: string, recursive = false) =>
    requestJson<{ ok: boolean }>('/api/files/delete', {
      method: 'POST',
      body: JSON.stringify({ root, path, recursive }),
    }),

  // Deliverable files agents have generated across all chats. `pendingSync > 0`
  // means older chats are still being indexed server-side; each subsequent GET
  // indexes another batch, so poll until it reaches 0. Preview returns capped
  // text; the download URL streams the file (add inline=1 for an <img src>).
  generatedFiles: () =>
    requestJson<{ files: GeneratedFile[]; pendingSync: number }>('/api/generated-files'),
  generatedFilePreview: (id: string) =>
    requestJson<{ file: GeneratedFile; content?: string; truncated?: boolean; binary?: boolean }>(
      `/api/generated-files/${encodeURIComponent(id)}/preview`,
    ),
  generatedFileDownloadUrl: (id: string, options?: { inline?: boolean; name?: string }) => {
    const name = options?.name ? `/${encodeURIComponent(options.name)}` : '';
    return `/api/generated-files/${encodeURIComponent(id)}/download${name}${options?.inline ? '?inline=1' : ''}`;
  },
  deleteGeneratedFile: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/generated-files/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Todos scratch-pad (#/todos, owner/consultant). Lightweight cards in
  // user-defined category columns; "firing one off" opens a new chat seeded
  // from the todo and flips it to 'active' + links the conversation.
  todos: () => requestJson<{ categories: TodoCategory[]; todos: Todo[] }>('/api/todos'),
  createTodo: (input: { title: string; notes?: string; categoryId?: string | null; projectId?: string | null }) =>
    requestJson<{ todo: Todo }>('/api/todos', { method: 'POST', body: JSON.stringify(input) }),
  updateTodo: (
    id: string,
    patch: {
      title?: string;
      notes?: string;
      categoryId?: string | null;
      projectId?: string | null;
      sortOrder?: number;
      state?: Todo['state'];
      conversationId?: string | null;
      // Replaces the todo's whole link set.
      links?: { kind: TodoLink['kind']; href: string; label?: string | null }[];
    },
  ) =>
    requestJson<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteTodo: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createTodoCategory: (name: string) =>
    requestJson<{ category: TodoCategory }>('/api/todos/categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateTodoCategory: (id: string, patch: { name?: string; sortOrder?: number }) =>
    requestJson<{ category: TodoCategory }>(`/api/todos/categories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteTodoCategory: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/todos/categories/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Automations: one durable schedule entity with fresh execution chats nested
  // beneath it as run history.
  scheduledTasks: () =>
    requestJson<{ scheduledTasks: ScheduledTask[]; summary: AutomationsSummary }>('/api/scheduled-tasks'),
  createScheduledTask: (input: {
    name: string;
    prompt: string;
    provider?: 'claude' | 'openrouter' | 'codex' | 'grok';
    model?: string | null;
    effort?: string | null;
    triggerKind?: 'schedule';
    schedule?: ScheduledTaskSchedule;
    timezone?: string;
    projectId?: string | null;
  } | {
    name: string;
    prompt: string;
    provider?: 'claude' | 'openrouter' | 'codex' | 'grok';
    model?: string | null;
    effort?: string | null;
    triggerKind: 'event';
    recipe: string;
    connectorId: number;
    triggerConfig: Record<string, unknown>;
    filters: AutomationFilter[];
    projectId?: string | null;
  }) =>
    requestJson<{ scheduledTask: ScheduledTask }>('/api/scheduled-tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateScheduledTask: (
    id: string,
    patch: Partial<Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'timezone' | 'enabled' | 'pinned' | 'projectId' | 'filters' | 'provider' | 'model' | 'effort'>>,
  ) =>
    requestJson<{ scheduledTask: ScheduledTask }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  runScheduledTaskNow: (id: string) =>
    requestJson<{ conversationId: string; runId: string }>(
      `/api/scheduled-tasks/${encodeURIComponent(id)}/run-now`,
      { method: 'POST' },
    ),
  scheduledTaskRuns: (id: string) =>
    requestJson<{ runs: ScheduledTaskRun[] }>(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs`),
  updateScheduledTaskRun: (taskId: string, runId: string, important: boolean) =>
    requestJson<{ run: ScheduledTaskRun }>(
      `/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`,
      { method: 'PATCH', body: JSON.stringify({ important }) },
    ),
  deleteScheduledTaskRun: (taskId: string, runId: string) =>
    requestJson<{ ok: true; archivedConversationId: string | null }>(
      `/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`,
      { method: 'DELETE' },
    ),
  deleteScheduledTask: (id: string) =>
    requestJson<{ ok: true }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  automationTriggerRecipes: () =>
    requestJson<{ recipes: AutomationTriggerRecipe[] }>('/api/scheduled-tasks/trigger-recipes'),

  // Connectors (Settings → Connections): code-defined catalog + per-user installs. All
  // roles. Installing a Composio connector returns a redirectUrl (their hosted
  // OAuth); poll connectorStatus until 'connected' after the user returns.
  connectors: () => requestJson<{ connectors: ConnectorInfo[] }>('/api/connectors'),
  // Install a new account (label required beyond the first) or retry a
  // pending/error one (pass its installId, no new label needed).
  installConnector: (slug: string, opts?: ConnectorInstallWrite) =>
    requestJson<{ status: ConnectorStatus; redirectUrl: string | null }>(
      `/api/connectors/${encodeURIComponent(slug)}/install`,
      { method: 'POST', body: JSON.stringify(opts ?? {}) },
    ),
  connectorStatus: (id: number) =>
    requestJson<{ status: ConnectorStatus; error: string | null }>(`/api/connectors/install/${id}/status`),
  changeConnectorAccessMode: (id: number, accessMode: ConnectorAccessMode) =>
    requestJson<{ status: 'pending' | 'connected'; redirectUrl: string | null }>(
      `/api/connectors/install/${id}/access-mode`,
      { method: 'POST', body: JSON.stringify({ accessMode }) },
    ),
  connectorAccessModeStatus: (id: number) =>
    requestJson<{ status: 'idle' | 'pending' | 'connected' | 'error'; error: string | null }>(
      `/api/connectors/install/${id}/access-mode/status`,
    ),
  cancelConnectorAccessModeChange: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/connectors/install/${id}/access-mode/cancel`, { method: 'POST' }),
  connectorDetails: (id: number, refresh = false) =>
    requestJson<{ details: ConnectorAccountDetails }>(
      `/api/connectors/install/${id}/details${refresh ? '?refresh=1' : ''}`,
    ),
  testConnectorConnection: (id: number) =>
    requestJson<{ health: ConnectorHealthResult }>(`/api/connectors/install/${id}/test`, { method: 'POST' }),
  updateConnectorAccess: (id: number, access: ConnectorAccessWrite) =>
    requestJson<{ ok: boolean }>(`/api/connectors/install/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(access),
    }),
  uninstallConnector: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/connectors/install/${id}/uninstall`, { method: 'POST' }),

  // Provider-neutral, per-user memory shared by every agent backend.
  memories: (query = '') => {
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    return requestJson<{ configured: boolean; memories: MemoryItem[] }>(`/api/memory${suffix}`);
  },
  memoryProfile: () =>
    requestJson<{ configured: boolean; profile: MemoryProfile | null }>('/api/memory/profile'),
  memorySuggestions: () =>
    requestJson<{ suggestions: MemorySuggestion[] }>('/api/memory/suggestions'),
  approveMemorySuggestion: (id: string) =>
    requestJson<{ memory: MemoryItem }>(`/api/memory/suggestions/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
    }),
  dismissMemorySuggestion: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/memory/suggestions/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    }),
  memoryCaptureSettings: () =>
    requestJson<{ settings: MemoryCaptureSettings }>('/api/memory/capture-settings'),
  updateMemoryCaptureSettings: (enabled: boolean) =>
    requestJson<{ settings: MemoryCaptureSettings }>('/api/memory/capture-settings', {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  saveMemory: (content: string, projectId?: string) =>
    requestJson<{ memory: MemoryItem }>('/api/memory', {
      method: 'POST',
      body: JSON.stringify({ content, projectId }),
    }),
  updateMemory: (id: string, content: string) =>
    requestJson<{ memory: MemoryItem }>(`/api/memory/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  deleteMemory: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Pages (#/pages): standalone public HTML pages agents publish (via the
  // publish_page tool) to the configured pages host. Listed by project with pins first;
  // deleting one also removes the public object.
  pages: () => requestJson<{ pages: Page[] }>('/api/pages'),
  updatePage: (id: string, patch: { pinned: boolean }) =>
    requestJson<{ page: Page }>(`/api/pages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deletePage: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Best-effort publish-time screenshot; 404 (no thumbnail yet) is expected.
  pageThumbnailUrl: (id: string) => `/api/pages/${encodeURIComponent(id)}/thumbnail`,

  // Apps (#/apps): private Cloudflare- or host-backed tools under the
  // client's existing Cloudflare Access-protected /tools namespace.
  apps: () =>
    requestJson<{
      configured: boolean;
      hosting: { cloudflare: boolean; local: boolean };
      apps: MiniApp[];
    }>('/api/apps'),
  focusedAutomations: () => requestJson<{ automations: { id: string; name: string; botId: string; botName: string; enabled: boolean; nextRunAt: string | null; timezone: string; schedule: string }[] }>('/api/focused-workspace/automations'),
  navigation: () =>
    requestJson<{ configured: boolean; navigation: WorkspaceNavigation }>('/api/navigation'),
  updateNavigation: (navigation: WorkspaceNavigation) =>
    requestJson<{ configured: true; navigation: WorkspaceNavigation }>('/api/navigation', {
      method: 'PUT',
      body: JSON.stringify(navigation),
    }),
  deleteApp: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Site brand defaults (Settings → Appearance). String fields may be empty
  // (= unset → agents fall back to Veneer's house style). Reading is open;
  // writing is owner/consultant only (PUT 403s for members).
  pageBrand: () => requestJson<{ brand: PageBrand }>('/api/brand'),
  updatePageBrand: (brand: PageBrand) =>
    requestJson<{ brand: PageBrand }>('/api/brand', { method: 'PUT', body: JSON.stringify(brand) }),

  // Uploaded font files (Settings → Appearance → Fonts). `configured` is false
  // when page publishing has no Cloudflare credentials, so hosting is off.
  customFonts: () =>
    requestJson<{ fonts: CustomFont[]; configured: boolean }>('/api/pages/fonts'),
  uploadCustomFont: async (meta: CustomFontUpload, file: File): Promise<CustomFont> => {
    const query = new URLSearchParams({
      family: meta.family,
      weight: meta.weight,
      style: meta.style,
      fileName: file.name,
    });
    const res = await fetch(`/api/pages/fonts?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw await apiErrorFromResponse(res, 'Font upload failed');
    return ((await res.json()) as { font: CustomFont }).font;
  },
  deleteCustomFont: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/pages/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** One uploaded font file. Several rows may share a family (weights/styles). */
export interface CustomFont {
  id: string;
  family: string;
  weight: string;
  style: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  objectKey: string;
  publicUrl: string;
  createdAt: string;
}

export interface CustomFontUpload {
  family: string;
  weight: string;
  style: 'normal' | 'italic';
}

/**
 * Owner-set brand defaults for published pages/apps and the optional app tint.
 * String fields may be empty when unset.
 */
export interface PageBrand {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  /** Body typeface. Named `font` since before headings had their own setting. */
  font: string;
  headingFont: string;
  notes: string;
  applyToApp: boolean;
}

export interface MemoryItem {
  id: string;
  content: string;
  isStatic: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  similarity: number | null;
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface MemoryProfile {
  static: string[];
  dynamic: string[];
  buckets: Record<string, string[]>;
}

export interface MemoryCaptureSettings {
  enabled: boolean;
  processor: 'Codex 5.6 Luna';
}

export interface ChatAutoArchiveSettings {
  enabled: boolean;
  inactivityDays: number;
}

export type ChatListIconMode = 'provider' | 'creator';

export interface ChatAppearanceSettings {
  listIcon: ChatListIconMode;
}

export interface TodoPlanningSettings {
  prompt: string;
}

export interface MemorySuggestion {
  id: string;
  conversationId: string | null;
  projectId: string | null;
  scope: 'profile' | 'global' | 'project';
  kind: 'identity' | 'preference' | 'fact' | 'decision';
  content: string;
  evidence: string;
  isStatic: boolean;
  createdAt: string;
}

export type ConnectorStatus = 'pending' | 'connected' | 'error';
export type ConnectorSharing = 'personal' | 'shared';
export type ConnectorScopeMode = 'all' | 'projects';
export type ConnectorAccessMode = 'read_only' | 'full';

export interface ConnectorAccessWrite {
  sharing: ConnectorSharing;
  scopeMode: ConnectorScopeMode;
  projectIds: string[];
}

export interface ConnectorInstallWrite extends Partial<ConnectorAccessWrite> {
  label?: string;
  settings?: Record<string, string>;
  installId?: number;
  accessMode?: ConnectorAccessMode;
}

export interface ConnectorAccessModeProfile {
  mode: ConnectorAccessMode;
  version: number;
  label: string;
  description: string;
  capabilities: string[];
  providerPermissionNote?: string;
  recommended: boolean;
}

export interface ConnectorFieldDef {
  key: string;
  label: string;
  type: 'text' | 'secret';
  placeholder?: string;
  help?: string;
  required?: boolean;
}

/**
 * One connected account for a connector. `mention` is the token inserted after
 * "@" in the composer (e.g. "gmail" or "gmail-work") and doubles as the MCP
 * server name. `label` is the user's account name ("Work"), null for the first
 * unlabeled account.
 */
export interface ConnectorInstall {
  id: number;
  label: string | null;
  mention: string;
  status: ConnectorStatus;
  error: string | null;
  sharing: ConnectorSharing;
  scopeMode: ConnectorScopeMode;
  projects: { id: string; name: string }[];
  ownedByMe: boolean;
  canManage: boolean;
  createdAt: string;
  accessMode: {
    mode: ConnectorAccessMode | null;
    version: number | null;
    label: string;
    description: string;
    capabilities: string[];
    providerPermissionNote?: string;
  } | null;
  accessChange: {
    status: 'pending' | 'error';
    error: string | null;
    targetMode: ConnectorAccessMode;
    targetLabel: string;
  } | null;
}

export interface ConnectorHealthResult {
  ok: boolean;
  status: 'connected' | 'error';
  error: string | null;
  timeoutStage: 'token' | 'request' | 'backoff' | 'total' | null;
  timings: {
    tokenMs: number | null;
    queryMs: number | null;
    totalMs: number;
  };
}

export type ConnectorRemoteStatus =
  | 'INITIALIZING'
  | 'INITIATED'
  | 'ACTIVE'
  | 'FAILED'
  | 'EXPIRED'
  | 'INACTIVE'
  | 'REVOKED'
  | 'UNKNOWN';

export interface ConnectorAccountIdentity {
  displayName: string | null;
  email: string | null;
}

export interface GoogleAnalyticsPropertyDetails {
  id: string;
  name: string;
  canEdit: boolean | null;
}

export interface GoogleAnalyticsAccountDetails {
  id: string;
  name: string;
  properties: GoogleAnalyticsPropertyDetails[];
}

export type ConnectorResourceDetails = {
  kind: 'googleAnalytics';
  status: 'ready' | 'unavailable';
  accounts: GoogleAnalyticsAccountDetails[];
  truncated: boolean;
};

export interface ConnectorAccountDetails {
  provider: 'composio';
  toolkit: string;
  connectionStatus: ConnectorRemoteStatus;
  identity: ConnectorAccountIdentity | null;
  resources: ConnectorResourceDetails[];
  issues: string[];
  fetchedAt: string;
}

export interface ConnectorInfo {
  slug: string;
  name: string;
  description: string;
  kind: 'composio' | 'custom';
  fields: ConnectorFieldDef[];
  accessModes: ConnectorAccessModeProfile[];
  // One entry per connected account; the same connector can be installed
  // multiple times, each account labeled.
  installs: ConnectorInstall[];
}

/** A browsable root the file API exposes (home, source, data, system). */
export interface FileRoot {
  id: string;
  label: string;
  path: string;
}

/**
 * One directory entry. Symlinks are classified by their target; broken links,
 * sockets, and unstat-able entries come back as kind 'other' with null
 * size/mtime. mtime is mtimeMs.
 */
export interface FileEntry {
  name: string;
  kind: 'dir' | 'file' | 'other';
  size: number | null;
  mtime: number | null;
}

/**
 * A deliverable file an agent generated, registered across all chats. mtime is
 * ms epoch; source is how it was detected (a Write tool call or a bash command).
 * conversation/project fields are null when the originating chat/project is gone.
 */
export interface GeneratedFile {
  id: string;
  name: string;
  path: string;
  size: number;
  mtime: number;
  source: 'write' | 'bash';
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  firstSeenAt: string;
}

/** A file the agent created in a chat, detected from the session transcript. */
export interface SessionFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
  source: 'write' | 'bash';
}

/** A file stored on the server, referenced in messages by absolute path. */
export interface SideChatSummary {
  id: string;
  title: string | null;
  lastActiveAt: string;
  status: string;
  unread: boolean;
}

export interface UploadedFile {
  path: string;
  name: string;
  size: number;
}

export interface AssistantType {
  slug: string;
  name: string;
  /** Editable standing prompt injected before project context on every turn. */
  instructions: string;
  approval_mode: ApprovalMode;
  full_access: boolean;
  adminOnly: boolean;
  isDefault: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  /** Per-model reasoning-effort vocabulary, when the provider reports one
      (Codex does since GPT-5.6 — sets differ per model). Absent → the static
      EFFORT_OPTIONS fallback applies. */
  efforts?: string[];
  /** Effort the provider applies when none is picked, if reported. */
  defaultEffort?: string;
  /** Flagged by the provider as its current default model. */
  isDefault?: boolean;
}

/**
 * Per-agent override. null = inherit the global default: provider null → the
 * global defaultProvider; model null (with a provider) → that provider's
 * default model; effort null → the global defaultEffort.
 */
export interface AgentDefault {
  provider: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Site-wide new-chat defaults. providerDefaults maps each provider to the
 * model used when a chat starts without an explicit pick (null = let the CLI
 * decide); hiddenModels holds "provider:modelId" keys. defaultAgent is the
 * assistant slug new chats open on; agents holds per-agent overrides.
 */
/** LLM auto-naming of new chats (Settings → Chat Titles). */
export interface AutoTitlePrefs {
  enabled: boolean;
  /** OpenRouter model id used to generate titles (e.g. 'z-ai/glm-5.2'). */
  model: string;
}

export interface ModelPrefs {
  defaultProvider: string;
  providerDefaults: Record<string, string | null>;
  /** Exact OpenRouter model ids exposed to agents and chat pickers. */
  openrouterModels: string[];
  defaultEffort: string | null;
  hiddenModels: string[];
  /** User-chosen model display order per provider (arrays of model ids).
      Models not listed fall to the end in their original order. */
  modelOrder: Record<string, string[]>;
  defaultAgent: string | null;
  agents: Record<string, AgentDefault>;
  autoTitle: AutoTitlePrefs;
}

export interface Approval {
  id: number;
  conversationId: string;
  conversationTitle: string | null;
  toolName: string;
  displayName: string;
  inputPreview: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  statusLabel: string;
  autoApproved: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ClaudeAccount {
  id: string;
  /** User-facing name; defaults to the account email. */
  label: string;
  email: string | null;
  planType: string | null;
  connectedAt: string;
  /** True for the account new turns run on. */
  active: boolean;
}

export interface ClaudeStatus {
  connected: boolean;
  connectedAt: string | null;
  source: 'app' | 'env' | null;
  /** Every connected subscription. Optional across adjacent releases. */
  accounts?: ClaudeAccount[];
}

export type ClaudeOutputStyle = 'Default' | 'Concise';

export interface ClaudePreferences {
  outputStyle: ClaudeOutputStyle;
}

export interface ProviderRuntimeVersion {
  runtime: string;
  version: string | null;
  supportsConciseOutputStyle: boolean;
}

export interface ProviderRuntimeVersions {
  claude: ProviderRuntimeVersion;
  openrouter: ProviderRuntimeVersion;
  codex: ProviderRuntimeVersion;
  grok: ProviderRuntimeVersion;
}

export interface ApiKeyStatus {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  /** 'override' = user-set; 'doppler' = client vault; 'default' = legacy server env. */
  source: 'override' | 'doppler' | 'default' | null;
  /** Masked tail (e.g. '…a1b2') so you can tell which key is set; never the full value. */
  hint: string | null;
}

export interface DopplerConnection {
  connected: boolean;
  project: string | null;
  config: string | null;
  connectedAt: string | null;
  access: {
    /** 'none' = no authenticated Doppler CLI, so secrets tooling is unavailable. */
    mode: 'main_full' | 'client_project' | 'none';
    label: string;
    locked: true;
    safetyGuidance: string;
  };
  additionalGuidance: string;
  runtime: {
    configured: boolean;
    healthy: boolean;
    lastCheckedAt: string | null;
    error: string | null;
  };
  agent: { configured: boolean };
}

export interface VoiceSettings {
  vocabularyTerms: string[];
}

/** Account role ('owner' shows as "Admin", 'member' as "Member"; 'consultant' is legacy). */
export type AdminRole = 'owner' | 'member' | 'consultant';
/** Account lifecycle: awaiting approval, approved, or access revoked. */
export type AdminUserStatus = 'pending' | 'active' | 'disabled';

/** One row on the Settings → People & access admin page. lastSeenAt is null until seen. */
export interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  role: AdminRole;
  status: AdminUserStatus;
  createdAt: string;
  lastSeenAt: string | null;
  employeeWorkspace?: boolean;
  focusedWorkspace?: boolean;
  focusedBotIds?: string[];
  allowedBotIds?: string[];
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export type CodexAttemptState = 'pending' | 'success' | 'error' | 'expired' | 'no_attempt';

export interface CodexAccount {
  id: string;
  /** User-facing name; defaults to the account email. */
  label: string;
  email: string | null;
  planType: string | null;
  connectedAt: string;
  /** True for the account new turns run on. */
  active: boolean;
  /** Whether the account's profile still holds a credential. */
  connected: boolean;
}

export interface CodexStatus {
  connected: boolean;
  method: 'chatgpt' | 'apikey' | null;
  installed: boolean;
  /** Signed-in ChatGPT identity of the active account; null when unknown. */
  account?: { email: string | null; plan: string | null } | null;
  /** Every connected subscription. Optional across adjacent releases. */
  accounts?: CodexAccount[];
}

export type GrokAttemptState = 'pending' | 'success' | 'error' | 'expired' | 'no_attempt';

export interface GrokStatus {
  connected: boolean;
  /** 'xai' = subscription login; 'apikey' would be XAI_API_KEY (never used here). */
  method: 'xai' | 'apikey' | null;
  installed: boolean;
  /** Signed-in xAI identity, best-effort from auth.json; null when unreadable. */
  account?: { email: string | null; handle: string | null; plan: string | null } | null;
}

/** One rate-limit window (e.g. 5-hour or weekly) for a provider. */
export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  status: string | null;
}

/**
 * A single provider's usage snapshot. `capturedAt` is when the snapshot was
 * taken (Claude data is passive and can be stale); `error` carries a degraded
 * reason when present.
 */
export interface ProviderUsage {
  connected: boolean;
  planType: string | null;
  /** Claude only: the account the token belongs to. Optional across adjacent releases. */
  accountEmail?: string | null;
  windows: UsageWindow[];
  capturedAt: string | null;
  source: string | null;
  error: string | null;
  /** Claude only: live, provider-authoritative weekly session-reset offer. */
  limitReset?: ClaudeLimitResetStatus | null;
  /** Claude and Codex: per-account meters, one block per connected account. */
  accounts?: ProviderAccountUsage[];
}

/** One connected subscription's meters (Claude or Codex). */
export interface ProviderAccountUsage {
  accountId: string;
  label: string;
  accountEmail: string | null;
  planType: string | null;
  active: boolean;
  windows: UsageWindow[];
  capturedAt: string | null;
  source: string | null;
  limitReset: ClaudeLimitResetStatus | null;
  /** Codex only: whether the account's credential is still present. */
  connected?: boolean;
  /** Codex only: degraded reason for this account, if any. */
  error?: string | null;
}

/** Kept for the Claude-side call sites. */
export type ClaudeAccountUsage = ProviderAccountUsage;

export interface ClaudeLimitResetStatus {
  available: boolean;
  nextAvailableAt: string | null;
  weeklyResetsAt: string | null;
  resetsPerWeek: number;
  capturedAt: string;
}

export interface ClaudeLimitResetClaim {
  result: 'reset' | 'already_used' | 'not_limited' | 'ineligible' | 'unavailable';
  status: ClaudeLimitResetStatus | null;
}

export type OpenRouterSpendPeriod = 'today' | 'week' | 'month' | 'lifetime';

export interface OpenRouterModelSpend {
  model: string;
  costUsd: number;
  requestCount: number;
  tokensTotal: number;
}

export interface OpenRouterUsage {
  connected: boolean;
  capturedAt: string | null;
  summary: {
    todayUsd: number;
    weekUsd: number;
    monthUsd: number;
    lifetimeUsd: number;
    limitUsd: number | null;
    remainingUsd: number | null;
    limitReset: string | null;
  } | null;
  modelBreakdown: {
    configured: boolean;
    capturedAt: string | null;
    periods: Record<OpenRouterSpendPeriod, OpenRouterModelSpend[]>;
    error: string | null;
  };
  error: string | null;
}

export interface UsageResponse {
  providers: {
    claude: ProviderUsage;
    codex: ProviderUsage;
    /** Optional while the web bundle and API process are on adjacent releases. */
    grok?: ProviderUsage;
  };
  openrouter: OpenRouterUsage;
}

export type PolicyAction = 'allow' | 'approve' | 'deny';
export interface PolicyRule {
  match: string;
  action: PolicyAction;
}
export interface Policy {
  default: PolicyAction;
  rules: PolicyRule[];
}

export interface McpStdioConfig {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface McpRemoteConfig {
  transport: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
}
export type McpConfig = McpStdioConfig | McpRemoteConfig;

export interface Connection {
  id: number;
  name: string;
  slug: string;
  enabled: boolean;
  managedBy: 'consultant' | 'owner';
  config: McpConfig;
  hasSecrets: boolean;
  policy: Policy;
  createdAt: string;
}

export interface ConnectionWrite {
  name: string;
  config: McpConfig;
  policy?: Policy;
  enabled?: boolean;
  managedBy?: 'consultant' | 'owner';
}

export interface TestResult {
  ok: boolean;
  detail: string;
  tools: string[];
}
