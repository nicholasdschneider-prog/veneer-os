import { createBotWorkflowsRouter } from '../botWorkflows/routes.js';
import { employeeApiBoundary, isEmployee } from '../bots/employeeAccess.js';
import { businessScopeSql, sameBusiness, businessAgentSql } from '../conversations/access.js';
import { createBotsRouter } from '../bots/routes.js';
import { createHuddlesRouter } from '../huddles/routes.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findUserByEmail, userCount } from '../context.js';
import type { ApprovalRow, AssistantRow, ConversationRow, ProjectRow, UserRow } from '../db/db.js';
import {
  canChangeConversationVisibility,
  canManageConversation,
  canSendToConversation,
  canViewConversation,
} from '../conversations/access.js';
import { sideChatOpeningMessage } from '../conversations/sideChat.js';
import { presentConversationEventForUser } from '../conversations/messageOriginPresentation.js';
import { isUnread, markSeen } from '../conversations/unread.js';
import { MAX_CONVERSATION_TITLE_LENGTH } from '../conversations/title.js';
import { conversationShareUrl } from '../conversations/shareUrl.js';
import { loginHome } from '../homes.js';
import {
  displayNameForTool,
  previewOf,
  type MessageOrigin,
  type QuestionSecretTarget,
} from '../runtime/events.js';
import { mediaFilePath } from '../runtime/media.js';
import { createConnectionsRouter } from './connections.js';
import { createConnectorsRouter } from './connectors.js';
import { createGmailDraftsRouter } from './gmailDrafts.js';
import { createFilesRouter } from './files.js';
import { createGeneratedFilesRouter } from './generatedFiles.js';
import { ensureFileSyncBackfill, listGeneratedFiles } from '../files/generatedFiles.js';
import { artifactKind } from '../files/artifactKind.js';
import { sessionFileView, type SessionFileView } from '../files/sessionFileViews.js';
import { miniAppUrl } from '../miniApps/cloudflare.js';
import { inlineContentSecurityPolicy, inlineContentType } from './inlineContentType.js';
import { serveMarkdownImage } from './markdownImage.js';
import { createSkillsRouter } from './skills.js';
import { createPagesRouter } from './pages.js';
import { createMiniAppsRouter } from './miniApps.js';
import { createNavigationRouter } from './navigation.js';
import { createTodosRouter } from './todos.js';
import { createScheduledTasksRouter } from './scheduledTasks.js';
import { describeSchedule, parseScheduleSpec } from '../scheduled/schedule.js';
import { triggerRecipe } from '../automations/recipes.js';
import { createBuildQueueRouter } from './buildQueue.js';
import { createDesktopRouter } from './desktop.js';
import { createVeneerBrowserRouter } from './veneerBrowser.js';
import { createConversationReactivator } from './conversationActivity.js';
import { createRecentConversationsRouter } from './recentConversations.js';
import { createLiveVoiceRouter } from './liveVoice.js';
import {
  autoArchiveInactiveConversations,
  readChatAutoArchiveSettings,
  writeChatAutoArchiveSettings,
} from './chatAutoArchive.js';
import { readChatAppearanceSettings, writeChatAppearanceSettings } from './chatAppearanceSettings.js';
import {
  MAX_TODO_PLANNING_PROMPT_LENGTH,
  readTodoPlanningSettings,
  writeTodoPlanningSettings,
} from './todoPlanningSettings.js';
import { codexLoginStatus, codexLogout, installCodex, type CodexInstallResult } from '../codex/deviceAuth.js';
import {
  adoptCodexLogins,
  codexStagingHome,
  ensureCodexAccountHome,
  removeCodexAccountFiles,
  type CodexAccountSummary,
} from '../codex/accounts.js';
import { grokLogout, installGrok, type GrokInstallResult } from '../grok/deviceAuth.js';
import { buildClaudeAccountUsage, buildClaudeProvider } from '../usage/contract.js';
import { API_KEY_DEFS, apiKeyStatuses, effectiveApiKey, type ApiKeyId } from '../secrets/apiKeys.js';
import { generateChatTitle } from '../llm/openrouter.js';
import { DEFAULT_OPENROUTER_MODEL_IDS } from '../providers/openrouter/models.js';
import {
  createSupermemoryClient,
  globalMemoryContainerTag,
  profileMemoryContainerTag,
  projectMemoryContainerTag,
  type MemoryMetadata,
} from '../memory/supermemory.js';
import { isMemoryCaptureEnabled, sanitizeMemoryText, setMemoryCaptureEnabled } from '../memory/capture.js';
import { isSensitiveMemory, memoryContainerForScope, type MemoryKind, type MemoryScope } from '../memory/curator.js';
import { ensureSupermemoryConfigured } from '../memory/provision.js';
import { readConversationDebugContext } from '../conversationDebugContext.js';
import { resolveEffectiveApprovalMode } from '../approvalMode.js';
import { ensureConversationInstructionSnapshot } from '../instructions/context.js';
import {
  readClaudePreferences,
  writeClaudePreferences,
} from '../providers/claude/preferences.js';
import {
  MIN_CONCISE_OUTPUT_STYLE_VERSION,
  probeProviderVersion,
  readProviderRuntimeVersions,
  supportsConciseOutputStyle,
  type ProviderRuntimeVersions,
} from '../providers/versions.js';
import {
  MAX_VOICE_VOCABULARY_TERM_LENGTH,
  MAX_VOICE_VOCABULARY_TERMS,
  readVoiceSettings,
  writeVoiceSettings,
} from '../channels/voiceSettings.js';
import { clientDisplayName } from '../identity/clientBrand.js';
import { canUserAccessModel, isUserScopedModel, modelsVisibleToUser } from './modelAccess.js';
import { createSystemUsageReader } from './systemUsage.js';
import {
  CLIENT_LOGO_MAX_BYTES,
  clientLogoPath,
  isPng,
  removeClientLogo,
  writeClientLogo,
} from '../clientLogo.js';
import {
  effectiveProjectAppearance,
  normalizeProjectAppearance,
  ProjectAppearanceSchema,
  readProjectAppearance,
} from '../projects/appearance.js';
import { EMPTY_BRAND, PageBrandSchema, readPageBrand, writePageBrand } from '../pages/brand.js';
import { typographyGuidance } from '../pages/fonts.js';
import {
  assertDopplerSecretName,
  clearDopplerCli,
  clearDopplerMetadata,
  configureDopplerCli,
  deleteDopplerSecret,
  dopplerSecretStdin,
  downloadDopplerSecrets,
  readDopplerAgentGuidance,
  readDopplerMetadata,
  redactDopplerError,
  setDopplerSecret,
  validateDopplerIdentity,
  verifyDopplerWriteAccess,
  writeDopplerAgentGuidance,
  writeDopplerMetadata,
} from '../secrets/doppler.js';
import { dopplerAccessPolicy, runProjectDopplerCli } from '../secrets/projectDopplerCli.js';
import {
  resolveSecretTarget as resolveSecretTargetFor,
  type SecretAccessDeps,
  type SecretTargetResolution,
} from '../secrets/readSecret.js';

const SetupSchema = z.object({ displayName: z.string().trim().min(1).max(120) });
const ApprovalModeSchema = z.enum(['ask', 'auto']);
const CreateConversationSchema = z.object({
  // The web app supplies this UUID so its temporary sidebar row can reconcile
  // with the server row before this request finishes starting the first turn.
  id: z.string().uuid().optional(),
  firstMessage: z.string().trim().min(1).max(100_000),
  visibility: z.enum(['team', 'private']).optional().default('team'),
  provider: z.enum(['claude', 'openrouter', 'codex', 'grok']).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  effort: z.string().trim().min(1).max(40).optional(),
  approval_mode: ApprovalModeSchema.optional(),
  assistantSlug: z.string().trim().min(1).max(80).optional(),
  // The project (folder) to start this chat in; fixed once set. null/absent = unfiled.
  projectId: z.string().trim().min(1).max(64).optional(),
  // Set only by the handoff tool. The route verifies this against the
  // authenticated agent conversation before it records any parent link.
  originConversationId: z.string().trim().min(1).max(128).optional(),
});
const ProjectWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().max(20_000).optional(),
  appearance: ProjectAppearanceSchema.optional(),
  // Custom root folder (absolute path, anywhere on the system). Omitted/empty =
  // the default workspaces/projects/<slug>. Owner/consultant only.
  rootDir: z.string().trim().max(1024).optional(),
});
const ProjectPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().max(20_000).optional(),
  appearance: ProjectAppearanceSchema.optional(),
  defaultAgent: z.string().trim().min(1).max(80).nullable().optional(),
});
const AgentProjectSettingsPatchSchema = z
  .object({
    instructions: z.string().max(20_000).optional(),
    appearance: ProjectAppearanceSchema.strict()
      .refine((appearance) => Object.keys(appearance).length > 0, {
        message: 'At least one appearance field is required',
      })
      .optional(),
  })
  .strict()
  .refine((settings) => settings.instructions !== undefined || settings.appearance !== undefined, {
    message: 'At least one project setting is required',
  });
// The complete project list in its new manual order. Requiring the full list
// lets the route reject a stale reorder if a project was added or removed.
const ReorderProjectsSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });
const ArchivedConversationsQuerySchema = z.object({
  query: z.string().trim().max(200).optional().default(''),
  project: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
});
const AssistantCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // New agents start with safe permission defaults. Model and thinking choices
  // continue to inherit the site defaults until the owner changes them.
  instructions: z.string().max(50_000).optional().default(''),
});
const AssistantPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Saved into the fixed developer-context snapshot of each new chat. Empty
    // means this agent has no custom persona beyond Core Veneer rules.
    instructions: z.string().max(50_000).optional(),
    approval_mode: ApprovalModeSchema.optional(),
    full_access: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.instructions !== undefined ||
      body.approval_mode !== undefined ||
      body.full_access !== undefined,
    {
      message: 'At least one field required',
    },
  );
const MessageSchema = z.object({ text: z.string().trim().min(1).max(100_000), queueOnly: z.boolean().optional() });
const WakeupKeySchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._:-]+$/);
const ScheduleWakeupSchema = z
  .object({
    reason: z.string().trim().min(1).max(4000),
    key: WakeupKeySchema.optional().default('default'),
    delaySeconds: z.number().int().min(1).max(30 * 24 * 60 * 60).optional(),
    runAt: z.string().trim().min(1).max(100).optional(),
  })
  .refine((body) => Number(body.delaySeconds !== undefined) + Number(body.runAt !== undefined) === 1, {
    message: 'Provide exactly one of delaySeconds or runAt',
  });
const WakeupIdSchema = z.string().uuid();
const RescheduleWakeupSchema = z
  .object({
    delaySeconds: z.number().int().min(1).max(30 * 24 * 60 * 60).optional(),
    runAt: z.string().trim().min(1).max(100).optional(),
  })
  .refine((body) => Number(body.delaySeconds !== undefined) + Number(body.runAt !== undefined) === 1, {
    message: 'Provide exactly one of delaySeconds or runAt',
  });
const QueueReorderSchema = z.object({ messageIds: z.array(z.number().int().positive()).max(500) });
const PatchConversationSchema = z.object({
  title: z.string().trim().min(1).max(MAX_CONVERSATION_TITLE_LENGTH).optional(),
  archived: z.boolean().optional(),
  visibility: z.enum(['team', 'private']).optional(),
  // Mid-chat model/thinking switch — picked up by the next turn's spawn
  // (adapters pass --model/--effort every turn). Cross-provider changes use
  // POST /conversations/:id/model to transfer context. effort null = provider default.
  model: z.string().trim().min(1).max(100).optional(),
  effort: z.string().trim().min(1).max(40).nullable().optional(),
  approval_mode: ApprovalModeSchema.nullable().optional(),
  pinned: z.boolean().optional(),
  // Move the chat (and its side chats) to another project; null unfiles it.
  // The runner derives the working folder from the row every turn, and the
  // fixed instruction snapshot is re-frozen against the new project on the
  // next turn, so history is kept while future turns use the new project.
  projectId: z.string().trim().min(1).max(100).nullable().optional(),
});
// Drag-reorder of the pinned chats: the full pinned list in its new order.
const ReorderPinsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
const ResolveApprovalSchema = z.object({ outcome: z.enum(['approved', 'denied']) });
// ask_user tool: the agent posts a question; the user answers it as buttons.
const AskQuestionSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  options: z
    .array(z.object({
      label: z.string().trim().min(1).max(200),
      value: z.string().max(400).optional(),
      description: z.string().trim().min(1).max(500).optional(),
    }))
    .min(1)
    .max(20),
  multi: z.boolean().optional(),
  allowOther: z.boolean().optional(),
});
// request_secret tool: the agent names a secret it needs; the user types the
// value into a masked card and the server writes it straight to Doppler.
const RequestSecretSchema = z.object({
  name: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(500),
  project: z.string().trim().min(1).max(100).optional(),
  config: z.string().trim().min(1).max(100).optional(),
});
// The value is accepted here and nowhere else: it is never echoed, logged, or
// stored in SQLite.
const SaveSecretSchema = z.object({ value: z.string().min(1).max(65_536) });
// reveal_secret tool: the agent names an existing secret to show the user. It
// never supplies or receives a value.
const RevealSecretSchema = z.object({
  name: z.string().trim().min(1).max(200),
  project: z.string().trim().min(1).max(100).optional(),
  config: z.string().trim().min(1).max(100).optional(),
});
const ResolveQuestionSchema = z.union([
  z.object({
    answers: z.record(z.string().min(1).max(100), z.array(z.string().min(1).max(4000)).min(1).max(20)),
  }),
  z.object({ answer: z.string().min(1).max(4000) }),
]);
/** Last-resort guard: a CLI that echoes its stdin must not leak it to the UI. */
function withoutSecretValue(text: string, value: string): string {
  return value ? text.split(value).join('[redacted]') : text;
}

const MemoryCaptureSettingsSchema = z.object({ enabled: z.boolean() });
const ChatAutoArchiveSettingsSchema = z.object({
  enabled: z.boolean(),
  inactivityDays: z.number().int().min(1).max(3650),
});
const ChatAppearanceSettingsSchema = z.object({
  listIcon: z.enum(['provider', 'creator']),
});
const ClaudePreferencesSchema = z.object({ outputStyle: z.enum(['Default', 'Concise']) }).strict();
const ClaudeAccountLabelSchema = z.object({ label: z.string().trim().min(1).max(80) }).strict();
const TodoPlanningSettingsSchema = z.object({
  prompt: z
    .string()
    .max(MAX_TODO_PLANNING_PROMPT_LENGTH)
    .refine((prompt) => prompt.trim().length > 0),
});
// Site-wide new-chat defaults (settings table, key 'model_prefs'): which
// provider the picker starts on, each provider's default model (applied when
// a conversation is created without an explicit model), the default thinking
// level, and which models are hidden from the picker ("provider:modelId").
const ProviderEnum = z.enum(['claude', 'openrouter', 'codex', 'grok']);
const ModelIdSchema = z.string().trim().min(1).max(100);
// Per-agent override, keyed by assistant slug. null means "inherit": provider
// null → the global defaultProvider; model null (with a provider) → that
// provider's default model; effort null → the global defaultEffort.
const AgentDefaultSchema = z.object({
  provider: ProviderEnum.nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
  effort: z.string().trim().min(1).max(40).nullable().default(null),
});
// Default OpenRouter model for auto-titling. GLM 5.2 is cheap, fast, and strong
// at short summaries; the user can change it in Settings → Chat Titles.
const DEFAULT_AUTO_TITLE_MODEL = 'z-ai/glm-5.2';
// Auto chat-naming: when enabled, a new chat's first message is sent to
// OpenRouter for a ≤4-word title (replacing the first-line placeholder). The
// resulting title is locked (title_auto=0) so the provider's own rolling title
// won't overwrite it. Disabled = keep the existing behaviour.
const AutoTitleSchema = z
  .object({
    enabled: z.boolean(),
    model: ModelIdSchema,
  })
  .default({ enabled: true, model: DEFAULT_AUTO_TITLE_MODEL });
// Grok's default chat model. Prefs written before Grok existed have no
// providerDefaults.grok key, so the field carries a default rather than being
// required (migration 0077 backfills stored prefs).
const DEFAULT_GROK_MODEL = 'grok-4.5';
const ModelPrefsSchema = z.object({
  defaultProvider: ProviderEnum,
  providerDefaults: z.object({
    claude: ModelIdSchema.nullable(),
    openrouter: ModelIdSchema.nullable().default(DEFAULT_OPENROUTER_MODEL_IDS[0]),
    codex: ModelIdSchema.nullable(),
    grok: ModelIdSchema.nullable().default(DEFAULT_GROK_MODEL),
  }),
  // Exact allowlist shown by the OpenRouter provider. We intentionally do not
  // expose OpenRouter's full catalog in chat pickers.
  openrouterModels: z.array(ModelIdSchema).min(1).max(20).default([...DEFAULT_OPENROUTER_MODEL_IDS]),
  defaultEffort: z.string().trim().min(1).max(40).nullable(),
  hiddenModels: z.array(z.string().trim().min(1).max(160)).max(500),
  // User-chosen display order per provider (arrays of model ids). Models absent
  // from a provider's list fall to the end in their original (API) order, so a
  // newly released model shows up without needing a re-save. Drag-and-drop in
  // Settings writes this; every model picker in the app reads it.
  modelOrder: z.record(z.string(), z.array(z.string().trim().min(1).max(160)).max(200)).default({}),
  // Which agent new chats open on (assistant slug); null = the built-in default.
  defaultAgent: z.string().trim().min(1).max(80).nullable().default(null),
  // Per-agent model/thinking overrides, keyed by assistant slug.
  agents: z.record(z.string().trim().min(1).max(80), AgentDefaultSchema).default({}),
  // LLM auto-titling of new chats (Settings → Chat Titles).
  autoTitle: AutoTitleSchema,
});
type ModelPrefs = z.infer<typeof ModelPrefsSchema>;
// First-generation shape (one global default model) — converted on read; the
// next save writes the current shape.
const LegacyModelPrefsSchema = z.object({
  defaultModel: z.object({ provider: ProviderEnum, model: ModelIdSchema }).nullable(),
  defaultEffort: z.string().trim().min(1).max(40).nullable(),
  hiddenModels: z.array(z.string().trim().min(1).max(160)).max(500),
});
const MODEL_PREFS_KEY = 'model_prefs';
const DEFAULT_MODEL_PREFS: ModelPrefs = {
  defaultProvider: 'claude',
  providerDefaults: {
    claude: null,
    openrouter: DEFAULT_OPENROUTER_MODEL_IDS[0],
    codex: null,
    grok: DEFAULT_GROK_MODEL,
  },
  openrouterModels: [...DEFAULT_OPENROUTER_MODEL_IDS],
  defaultEffort: null,
  hiddenModels: [],
  modelOrder: {},
  defaultAgent: null,
  agents: {},
  autoTitle: { enabled: true, model: DEFAULT_AUTO_TITLE_MODEL },
};
const API_KEY_IDS = API_KEY_DEFS.map((d) => d.id) as [ApiKeyId, ...ApiKeyId[]];
// Settings → API Keys write. An empty value clears the override (reverts to the
// env/Doppler default); a non-empty value is stored as the override.
const ApiKeyWriteSchema = z.object({ value: z.string().max(4000) });
const DopplerConnectSchema = z.object({
  project: z.string().trim().min(1).max(100),
  config: z.string().trim().min(1).max(100),
  runtimeToken: z.string().trim().max(500).optional().default(''),
  agentToken: z.string().trim().max(500).optional().default(''),
});
const DopplerGuidanceSchema = z
  .object({ additionalGuidance: z.string().max(20_000) })
  .strict();
const DopplerSecretWriteSchema = z.object({
  value: z.string().min(1).max(100_000),
});
const VoiceSettingsSchema = z.object({
  vocabularyTerms: z
    .array(z.string().trim().min(1).max(MAX_VOICE_VOCABULARY_TERM_LENGTH))
    .max(MAX_VOICE_VOCABULARY_TERMS)
    .optional(),
}).strict();
// User management (admin). 'consultant' is deliberately not offered going forward,
// so role updates only accept owner/member; existing consultant rows are left alone.
const AdminUserPatchSchema = z
  .object({
    role: z.enum(['owner', 'member']).optional(),
    status: z.enum(['pending', 'active', 'disabled']).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .refine((b) => b.role !== undefined || b.status !== undefined || b.displayName !== undefined, {
    message: 'At least one field required',
  });
const AttemptIdSchema = z.object({ attemptId: z.string().trim().min(1).max(200) });
const CompleteSchema = z.object({
  attemptId: z.string().trim().min(1).max(200),
  // The pasted code is `<base64url>#<state>` — opaque, kept as a string.
  code: z.string().trim().min(1).max(4000),
});
const MemorySaveSchema = z.object({
  content: z.string().trim().min(1).max(10_000),
  // Explicit null means global. Omission preserves the conversation-project
  // default used by human/API callers that identify a conversation.
  projectId: z.string().trim().min(1).max(100).nullable().optional(),
  conversationId: z.string().trim().min(1).max(100).optional(),
  // Supermemory semantics: static = permanent identity traits, exempt from the
  // engine's temporal updating/summarization. Default dynamic so saved facts evolve.
  isStatic: z.boolean().optional().default(false),
});
const MemoryPatchSchema = z.object({ content: z.string().trim().min(1).max(10_000) });

declare module 'express-serve-static-core' {
  interface Request {
    identityEmail?: string;
    /** Chat whose agent authenticated this request (agent token), if any. */
    agentConversationId?: string;
    user?: UserRow;
  }
}

/** Agent types only owner/consultant may start (they act on privileged surfaces). */
const ADMIN_ONLY_ASSISTANTS = new Set(['platform-dev', 'skill-smith']);
// A recreated custom agent must never acquire hard-coded privileges or special
// product behavior just because a built-in with the same slug was removed.
const RESERVED_ASSISTANT_SLUGS = new Set([
  'assistant',
  'platform-dev',
  'skill-smith',
  'app-creator',
  'data-analyst',
]);

function uniqueAssistantSlug(db: AppContext['db'], name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'agent';
  const exists = db.prepare('SELECT 1 FROM assistants WHERE slug = ?');
  let slug = base;
  for (let n = 2; RESERVED_ASSISTANT_SLUGS.has(slug) || exists.get(slug); n++) {
    slug = `${base}-${n}`;
  }
  return slug;
}

// Providers a new chat may name — mirrors the runner's adapter keys
// (buildAgentRuntime.adapters). Web no longer holds adapters, so it validates
// against this static set instead; the runner rejects anything else too.
const KNOWN_PROVIDERS = new Set(['claude', 'openrouter', 'codex', 'grok']);

// File-edit lock coordination for concurrent agents sharing the source checkout.
// The source of truth is .claude/filelock.config.json in sourceDir, because the
// PreToolUse hook (a standalone process) reads that file directly — the Settings
// UI just reads/writes it. See .claude/hooks/filelock.py.
const FILELOCK_HELP =
  'File-edit lock coordination for concurrent agents sharing this checkout. Managed from Settings → Agents. ' +
  'enabled:false turns it off instantly for every agent (read live on each edit). ttlSeconds = how long a lock ' +
  'survives with no edits before another agent may steal it.';
const FileLockSchema = z.object({
  enabled: z.boolean(),
  ttlSeconds: z.number().int().min(5).max(3600),
});

function titleFrom(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || 'New conversation';
}

// A project's slug is its immutable folder name under workspaces/projects/.
// Derive it from the name, keep it filesystem-safe, and disambiguate collisions
// so two projects never share a folder (which would merge their files/context).
function uniqueProjectSlug(db: AppContext['db'], name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  const exists = db.prepare('SELECT 1 FROM projects WHERE slug = ?');
  let slug = base;
  for (let n = 2; exists.get(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// Best-effort removal of a deleted project's workspace folder. Never touches
// anything outside workspaces/projects/, and a failure is non-fatal (the row is
// already gone; a leftover folder is harmless).
function removeProjectFolder(ctx: AppContext, slug: string): void {
  try {
    if (!/^[a-z0-9-]+$/.test(slug)) return;
    const dir = path.join(ctx.config.dataDir, 'workspaces', 'projects', slug);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leftover folder is harmless */
  }
}

// Human label for an automation's cadence, mirroring the Automations list. A
// malformed schedule_json is only a label problem, so it degrades to a generic
// word rather than failing the whole conversation read.
function scheduleTextFor(
  triggerKind: string | null,
  scheduleJson: string | null,
  timezone: string | null,
  recipeId: string | null,
): string {
  if (triggerKind !== 'schedule') return (recipeId ? triggerRecipe(recipeId)?.name : null) ?? 'Event trigger';
  try {
    return describeSchedule(parseScheduleSpec(scheduleJson ?? ''), timezone ?? 'UTC');
  } catch {
    return 'Scheduled';
  }
}

export async function conversationView(
  ctx: AppContext,
  row: ConversationRow,
  viewer?: UserRow,
  hasPendingWakeup = false,
): Promise<Record<string, unknown>> {
  const assistant = ctx.db.prepare('SELECT slug, name, approval_mode, full_access FROM assistants WHERE id = ?').get(row.assistant_id) as
    | { slug: string; name: string; approval_mode: 'ask' | 'auto'; full_access: 0 | 1 }
    | undefined;
  const creator = ctx.db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(row.user_id) as
    | Pick<UserRow, 'id' | 'display_name'>
    | undefined;
  const [initialStatus, activity] = await Promise.all([
    ctx.manager.statusOf(row.id),
    ctx.manager.activityOf?.(row.id).catch(() => null) ?? Promise.resolve(null),
  ]);
  let status = initialStatus;
  let automation: Record<string, unknown> | null = null;
  if (row.channel === 'automation') {
    // One query does double duty: the run's status overrides the live status,
    // and the joined task backs the chat's "scheduled agent" strip.
    const run = ctx.db
      .prepare(
        `SELECT r.status, r.scheduled_for, r.trigger,
                t.id AS task_id, t.name AS task_name, t.schedule_json, t.timezone, t.trigger_kind,
                t.trigger_recipe, t.enabled, t.next_run_at, t.last_run_at
           FROM scheduled_task_runs r
           LEFT JOIN scheduled_tasks t ON t.id = r.scheduled_task_id
          WHERE r.conversation_id = ?
          ORDER BY r.started_at DESC LIMIT 1`,
      )
      .get(row.id) as
      | {
          status: string;
          scheduled_for: string;
          trigger: string;
          task_id: string | null;
          task_name: string | null;
          schedule_json: string | null;
          timezone: string | null;
          trigger_kind: string | null;
          trigger_recipe: string | null;
          enabled: number | null;
          next_run_at: string | null;
          last_run_at: string | null;
        }
      | undefined;
    if (run?.status === 'needs_you') status = 'needs_you';
    else if (run?.status === 'failed') status = 'failed';
    else if (run?.status === 'queued' || run?.status === 'running') status = 'working';
    if (run?.task_id) {
      automation = {
        taskId: run.task_id,
        name: run.task_name,
        triggerKind: run.trigger_kind,
        scheduleText: scheduleTextFor(run.trigger_kind, run.schedule_json, run.timezone, run.trigger_recipe),
        timezone: run.timezone,
        enabled: run.enabled === 1,
        nextRunAt: run.next_run_at,
        lastRunAt: run.last_run_at,
        runStatus: run.status,
        runTrigger: run.trigger,
        ranAt: run.scheduled_for,
      };
    }
  }
  return {
    id: row.id,
    businessTeamId: row.business_team_id ?? null,
    isBot: Boolean(ctx.db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(row.id)),
    title: row.title,
    creator: {
      id: row.user_id,
      displayName: creator?.display_name ?? 'Unknown user',
    },
    visibility: row.visibility,
    canSend: viewer ? canSendToConversation(viewer, row, ctx.db) : true,
    canManage: viewer ? canManageConversation(viewer, row, ctx.db) : true,
    canChangeVisibility: viewer ? canChangeConversationVisibility(viewer, row) : true,
    provider: row.provider,
    model: row.model,
    lastAnsweredModel: row.last_answered_model ?? null,
    lastAnsweredProvider: row.last_answered_provider ?? null,
    effort: row.effort,
    approvalMode: row.approval_mode,
    effectiveApprovalMode: resolveEffectiveApprovalMode(
      Boolean(assistant?.full_access),
      row.approval_mode,
      assistant?.approval_mode,
    ),
    fullAccess: Boolean(assistant?.full_access),
    channel: row.channel,
    assistantSlug: assistant?.slug ?? 'assistant',
    assistantName: assistant?.name ?? 'Assistant',
    projectId: row.project_id ?? null,
    originConversationId: row.origin_conversation_id ?? null,
    sideChatOf: row.side_chat_of ?? null,
    archived: Boolean(row.archived),
    pinOrder: row.pin_order,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    contextTokens: row.last_input_tokens ?? null,
    status,
    activity,
    unread: viewer ? isUnread(ctx.db, viewer.id, row.id) : false,
    hasPendingWakeup,
    automation,
  };
}

export function createApiRouter(ctx: AppContext): Router {
  const { db, manager } = ctx;
  const clientName = clientDisplayName();
  // Public base published pages are served from, so the web app can trust that
  // host for page artifacts instead of hardcoding one. Null when unconfigured.
  const pagesPublicBase = ctx.config?.pages?.publicBase ?? null;
  const readSystemUsage = createSystemUsageReader();
  const reactivateConversation = createConversationReactivator(db);
  const lastAutoArchiveCheckAt = new Map<number, number>();
  let providerVersionsCache: { at: number; versions: ProviderRuntimeVersions } | null = null;
  const applyChatAutoArchive = (userId: number, force = false): number => {
    const now = Date.now();
    if (!force && now - (lastAutoArchiveCheckAt.get(userId) ?? 0) < 60_000) return 0;
    const archivedIds = autoArchiveInactiveConversations(db, userId);
    lastAutoArchiveCheckAt.set(userId, now);
    for (const conversationId of archivedIds) {
      void manager.interrupt(conversationId);
      void manager.veneerBrowserConversationStop?.(userId, conversationId)?.catch(() => {});
    }
    return archivedIds.length;
  };
  const memory = createSupermemoryClient({
    // A few focused route tests intentionally supply a minimal AppContext with
    // no config. Treat those the same as an unset production key: disabled.
    baseUrl: ctx.config?.supermemoryBaseUrl ?? 'http://127.0.0.1:6767',
    apiKey: ctx.config?.supermemoryApiKey ?? null,
    apiKeyFile: ctx.config?.dataDir ? path.join(ctx.config.dataDir, 'supermemory', 'api-key') : null,
  });
  const router = express.Router();
  // /files/write bodies carry whole text files (read cap 2 MiB, JSON-escaped),
  // so they get a higher limit than the 1mb default.
  const jsonBody = express.json({ limit: '1mb' });
  const jsonBodyLarge = express.json({ limit: '8mb' });
  // /files/write carries whole text files; POST /pages and POST /apps carry
  // complete publishable artifacts, so route them to the large parser.
  router.use((req, res, next) =>
    req.path === '/files/write' || req.path === '/pages' || req.path === '/apps'
      ? jsonBodyLarge(req, res, next)
      : jsonBody(req, res, next),
  );

  // Identity gate — every /api route.
  router.use((req, res, next) => {
    void (async () => {
      const identity = await ctx.resolveIdentity(req);
      if (!identity) {
        res.status(403).json({ ok: false, error: 'No identity' });
        return;
      }
      req.identityEmail = identity.email;
      req.agentConversationId = identity.agentConversationId;
      next();
    })().catch(() => res.status(500).json({ ok: false, error: 'Identity resolution failed' }));
  });

  router.get('/me', (req, res) => {
    if (userCount(db) === 0) {
      res.json({ ok: true, setupRequired: true, email: req.identityEmail, clientName, pagesPublicBase });
      return;
    }
    const email = req.identityEmail!.toLowerCase();
    let user = findUserByEmail(db, email);
    if (!user) {
      // Auto-provision an unknown-but-authenticated email as a pending member.
      // ON CONFLICT swallows the race where two /me hits provision at once; the
      // display name defaults to the local part before '@'. Only /me provisions.
      db.prepare(
        `INSERT INTO users (email, display_name, role, status) VALUES (?, ?, 'member', 'pending')
         ON CONFLICT(email) DO NOTHING`,
      ).run(email, email.split('@')[0]);
      user = findUserByEmail(db, email)!;
    }
    if (user.status === 'disabled') {
      res.status(403).json({ ok: false, error: 'Account disabled — contact your administrator' });
      return;
    }
    if (user.status === 'pending') {
      res.json({ ok: true, setupRequired: false, pending: true, email: user.email, clientName, pagesPublicBase });
      return;
    }
    res.json({
      ok: true,
      setupRequired: false,
      clientName,
      pagesPublicBase,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        status: user.status,
        employeeWorkspace: isEmployee(db, user.id),
      },
    });
  });

  router.post('/setup', (req, res) => {
    if (userCount(db) !== 0) {
      res.status(409).json({ ok: false, error: 'Already set up' });
      return;
    }
    const body = SetupSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'displayName required' });
      return;
    }
    db.prepare('INSERT INTO users (email, display_name, role) VALUES (?, ?, ?)').run(
      req.identityEmail!.toLowerCase(),
      body.data.displayName,
      'owner',
    );
    const user = findUserByEmail(db, req.identityEmail!)!;
    res.json({ ok: true, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
  });

  // Everything below requires a known, active user. Unlike /me, this does NOT
  // auto-provision — an unknown email hitting any other route is just rejected.
  router.use((req, res, next) => {
    const user = findUserByEmail(db, req.identityEmail!);
    if (!user) {
      res.status(403).json({ ok: false, error: 'Unknown user — contact your administrator' });
      return;
    }
    if (user.status === 'pending') {
      res.status(403).json({ ok: false, error: 'Account pending approval' });
      return;
    }
    if (user.status === 'disabled') {
      res.status(403).json({ ok: false, error: 'Account disabled — contact your administrator' });
      return;
    }
    // Last-seen: refresh at most once every 5 minutes to avoid a write per request.
    db.prepare(
      `UPDATE users SET last_seen_at = datetime('now')
       WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now','-5 minutes'))`,
    ).run(user.id);
    req.user = user;
    next();
  });

  router.use(employeeApiBoundary(db));

  router.use(
    '/recent-conversations',
    createRecentConversationsRouter(ctx, {
      refreshAutoArchive: (userId) => {
        applyChatAutoArchive(userId);
      },
      conversationView: (row, viewer) => conversationView(ctx, row, viewer),
    }),
  );

  router.use('/conversations/:id', (req, res, next) => {
    if (req.params.id === 'new') return next();
    const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id) as ConversationRow | undefined;
    if (c && (!canViewConversation(req.user!, c, db) || !sameBusiness(db, req.agentConversationId, c))) {
      res.status(404).json({ error: 'Conversation not found' }); return;
    }
    next();
  });
  router.use('/live-voice', createLiveVoiceRouter(ctx));
  router.use('/bot-workflows', createBotWorkflowsRouter(ctx));
  router.use('/bots', createBotsRouter(ctx));
  router.use('/huddles', createHuddlesRouter(ctx));

  router.get('/system/usage', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, usage: readSystemUsage() });
  });

  /**
   * Reassign a chat and its side chats to another project (null = unfiled).
   * Generated files follow the chat. The fixed instruction snapshot and the
   * provider instruction hash are cleared so the next turn re-freezes the new
   * project's instructions and re-sends them; the working folder is resolved
   * from the row each turn, so it moves on its own. Browser profile bindings
   * are project-scoped and are dropped.
   */
  function moveConversationToProject(database: typeof db, conversationId: string, projectId: string | null): void {
    const sideChats = database
      .prepare('SELECT id FROM conversations WHERE side_chat_of = ?')
      .all(conversationId) as { id: string }[];
    const ids = [conversationId, ...sideChats.map((chat) => chat.id)];
    database.transaction(() => {
      const update = database.prepare(
        `UPDATE conversations
            SET project_id = ?, instruction_snapshot_json = NULL, instruction_snapshot_at = NULL,
                provider_instruction_hash = NULL
          WHERE id = ?`,
      );
      const moveFiles = database.prepare('UPDATE generated_files SET project_id = ? WHERE conversation_id = ?');
      const dropProfile = database.prepare('DELETE FROM veneer_browser_conversation_profiles WHERE conversation_id = ?');
      for (const id of ids) {
        update.run(projectId, id);
        moveFiles.run(projectId, id);
        dropProfile.run(id);
      }
    })();
  }

  function conversationFor(req: Request, res: Response, manage = false): ConversationRow | null {
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as
      | ConversationRow
      | undefined;
    const allowed = row && sameBusiness(db, req.agentConversationId, row) && (manage ? canManageConversation(req.user!, row, ctx.db) : canViewConversation(req.user!, row, ctx.db));
    if (!row || !allowed) {
      res.status(404).json({ ok: false, error: 'Conversation not found' });
      return null;
    }
    return row;
  }

  const assistantNameForConversationStmt = db.prepare(
    `SELECT a.name
       FROM conversations c
       JOIN assistants a ON a.id = c.assistant_id
      WHERE c.id = ?`,
  );
  const sourceChatTitleStmt = db.prepare('SELECT title FROM conversations WHERE id = ?');
  const insertAgentMessageReceiptStmt = db.prepare(
    `INSERT OR IGNORE INTO agent_message_receipts
       (source_conversation_id, target_conversation_id, message_id, message_text, disposition)
     VALUES (?, ?, ?, ?, ?)`,
  );

  function agentMessageOrigin(req: Request, targetConversationId: string): MessageOrigin | undefined {
    if (!req.agentConversationId) return undefined;
    const source = assistantNameForConversationStmt.get(req.agentConversationId) as { name: string } | undefined;
    const target = assistantNameForConversationStmt.get(targetConversationId) as { name: string } | undefined;
    const sourceChat = sourceChatTitleStmt.get(req.agentConversationId) as { title: string | null } | undefined;
    return {
      kind: 'agent',
      from: source?.name?.trim() || 'Agent',
      to: target?.name?.trim() || 'Agent',
      sourceConversationId: req.agentConversationId,
      sourceConversationTitle: sourceChat?.title?.trim().slice(0, MAX_CONVERSATION_TITLE_LENGTH) || 'Untitled chat',
    };
  }

  const memoryNotConfigured = (res: Response): boolean => {
    if (memory.configured) return false;
    res.status(503).json({ ok: false, configured: false, error: 'Memory is not configured for this Veneer instance.' });
    return true;
  };

  const memoryContainerTagsForRequest = (req: Request): string[] => {
    const tags = [profileMemoryContainerTag(req.user!.id), globalMemoryContainerTag(req.user!.id)];
    if (!req.agentConversationId) return tags;
    const row = db.prepare('SELECT project_id FROM conversations WHERE id = ? AND user_id = ?').get(
      req.agentConversationId,
      req.user!.id,
    ) as { project_id: string | null } | undefined;
    if (row?.project_id) tags.push(projectMemoryContainerTag(req.user!.id, row.project_id));
    return tags;
  };

  const allMemoryContainerTagsForUser = (userId: number): string[] => {
    const projectIds = db.prepare('SELECT id AS project_id FROM projects').all() as { project_id: string }[];
    return [
      profileMemoryContainerTag(userId),
      globalMemoryContainerTag(userId),
      ...projectIds.map((row) => projectMemoryContainerTag(userId, row.project_id)),
    ];
  };

  router.get('/memory/capture-settings', (req, res) => {
    res.json({
      ok: true,
      settings: {
        enabled: isMemoryCaptureEnabled(db, req.user!.id),
        processor: 'Codex 5.6 Luna',
      },
    });
  });

  router.patch('/memory/capture-settings', (req, res) => {
    const body = MemoryCaptureSettingsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid memory capture setting.' });
      return;
    }
    setMemoryCaptureEnabled(db, req.user!.id, body.data.enabled);
    res.json({ ok: true, settings: { enabled: body.data.enabled, processor: 'Codex 5.6 Luna' } });
  });

  router.get('/chat/auto-archive-settings', (req, res) => {
    res.json({ ok: true, settings: readChatAutoArchiveSettings(db, req.user!.id) });
  });

  router.put('/chat/auto-archive-settings', (req, res) => {
    const body = ChatAutoArchiveSettingsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid chat auto-archive settings.' });
      return;
    }
    const settings = writeChatAutoArchiveSettings(db, req.user!.id, body.data);
    const archivedCount = applyChatAutoArchive(req.user!.id, true);
    res.json({ ok: true, settings, archivedCount });
  });

  router.get('/chat/appearance-settings', (_req, res) => {
    res.json({ ok: true, settings: readChatAppearanceSettings(db) });
  });

  router.put('/chat/appearance-settings', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const body = ChatAppearanceSettingsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid chat appearance settings.' });
      return;
    }
    const settings = writeChatAppearanceSettings(db, body.data);
    res.json({ ok: true, settings });
  });

  router.get('/chat/todo-planning-settings', (req, res) => {
    res.json({ ok: true, settings: readTodoPlanningSettings(db, req.user!.id) });
  });

  router.put('/chat/todo-planning-settings', (req, res) => {
    const body = TodoPlanningSettingsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid to-do planning prompt.' });
      return;
    }
    const settings = writeTodoPlanningSettings(db, req.user!.id, body.data);
    res.json({ ok: true, settings });
  });

  // Canonical site-brand routes. /api/pages/brand remains available for
  // compatibility with existing clients.
  router.get('/brand', (_req, res) => {
    res.json({ ok: true, brand: readPageBrand(db) ?? EMPTY_BRAND });
  });

  router.put('/brand', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const parsed = PageBrandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid brand' });
      return;
    }
    const brand = { ...EMPTY_BRAND, ...parsed.data };
    writePageBrand(db, brand);
    res.json({ ok: true, brand });
  });

  // Shared cross-provider memory. Unlike ordinary owner/consultant visibility,
  // memory is ALWAYS scoped to the authenticated user id. Agent-token requests
  // resolve to their conversation owner in the identity middleware above.
  router.get('/memory', (req, res) => {
    void (async () => {
      if (memoryNotConfigured(res)) return;
      const containerTags = req.agentConversationId
        ? memoryContainerTagsForRequest(req)
        : allMemoryContainerTagsForUser(req.user!.id);
      const limitRaw = Number(req.query.limit ?? 100);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 100;
      const query = String(req.query.q ?? '').trim();
      const scoped = await Promise.all(
        containerTags.map((containerTag) =>
          query
            ? memory.searchMemories({ containerTag, query, limit })
            : memory.listMemories({ containerTag, limit }),
        ),
      );
      const memories = [...new Map(scoped.flat().map((item) => [item.id, item])).values()].slice(0, limit);
      res.json({ ok: true, configured: true, memories });
    })().catch(() => res.status(502).json({ ok: false, error: 'Memory is temporarily unavailable.' }));
  });

  router.get('/memory/profile', (req, res) => {
    void (async () => {
      if (memoryNotConfigured(res)) return;
      // A Supermemory profile is user-profile data, not a roll-up of global or
      // project facts. Query recall handles those other containers.
      const profile = await memory.getProfile({ containerTag: profileMemoryContainerTag(req.user!.id) });
      res.json({ ok: true, configured: true, profile });
    })().catch(() => res.status(502).json({ ok: false, error: 'Memory is temporarily unavailable.' }));
  });

  router.post('/memory', (req, res) => {
    void (async () => {
      if (memoryNotConfigured(res)) return;
      const body = MemorySaveSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: 'Memory content is required.' });
        return;
      }

      // The agent token is authoritative for provenance. Human/API callers may
      // name a conversation only when it belongs to the same authenticated user.
      const conversationId = req.agentConversationId ?? body.data.conversationId ?? null;
      let conversation: Pick<ConversationRow, 'id' | 'user_id' | 'project_id'> | undefined;
      if (conversationId) {
        conversation = db
          .prepare('SELECT id, user_id, project_id FROM conversations WHERE id = ?')
          .get(conversationId) as Pick<ConversationRow, 'id' | 'user_id' | 'project_id'> | undefined;
        if (!conversation || conversation.user_id !== req.user!.id) {
          res.status(404).json({ ok: false, error: 'Conversation not found.' });
          return;
        }
      }

      const projectId = body.data.projectId === undefined
        ? req.agentConversationId
          ? null
          : conversation?.project_id ?? null
        : body.data.projectId;
      if (isSensitiveMemory(body.data.content) || sanitizeMemoryText(body.data.content) !== body.data.content) {
        res.status(400).json({ ok: false, error: 'Sensitive identifiers and credentials cannot be saved to memory.' });
        return;
      }
      const scope: MemoryScope = projectId ? 'project' : body.data.isStatic ? 'profile' : 'global';
      const metadata: MemoryMetadata = { user_id: String(req.user!.id), memory_scope: scope };
      if (projectId) metadata.project_id = projectId;
      if (conversationId) metadata.conversation_id = conversationId;
      const saved = await memory.addMemory({
        containerTag: memoryContainerForScope(req.user!.id, scope, projectId)!,
        content: body.data.content,
        isStatic: body.data.isStatic,
        metadata,
      });
      if (!saved) {
        res.status(502).json({ ok: false, error: 'Memory could not be saved right now.' });
        return;
      }
      res.status(201).json({ ok: true, memory: saved });
    })().catch(() => res.status(502).json({ ok: false, error: 'Memory could not be saved right now.' }));
  });

  router.get('/memory/suggestions', (req, res) => {
    const rows = db.prepare(
      `SELECT id, conversation_id, project_id, scope, kind, content, evidence, is_static, created_at
       FROM memory_suggestions WHERE user_id = ? AND status = 'suggested' ORDER BY created_at DESC`,
    ).all(req.user!.id) as {
      id: string;
      conversation_id: string | null;
      project_id: string | null;
      scope: MemoryScope;
      kind: MemoryKind;
      content: string;
      evidence: string;
      is_static: number;
      created_at: string;
    }[];
    res.json({
      ok: true,
      suggestions: rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        projectId: row.project_id,
        scope: row.scope,
        kind: row.kind,
        content: row.content,
        evidence: row.evidence,
        isStatic: Boolean(row.is_static),
        createdAt: row.created_at,
      })),
    });
  });

  router.post('/memory/suggestions/:id/approve', (req, res) => {
    void (async () => {
      if (memoryNotConfigured(res)) return;
      const row = db.prepare(
        `SELECT * FROM memory_suggestions WHERE id = ? AND user_id = ? AND status = 'suggested'`,
      ).get(String(req.params.id), req.user!.id) as {
        id: string;
        conversation_id: string | null;
        project_id: string | null;
        scope: MemoryScope;
        kind: MemoryKind;
        content: string;
        replace_memory_id: string;
        is_static: number;
      } | undefined;
      if (!row) {
        res.status(404).json({ ok: false, error: 'Memory suggestion not found.' });
        return;
      }
      if (isSensitiveMemory(row.content) || sanitizeMemoryText(row.content) !== row.content) {
        res.status(400).json({ ok: false, error: 'Sensitive identifiers and credentials cannot be saved to memory.' });
        return;
      }
      const containerTag = memoryContainerForScope(req.user!.id, row.scope, row.project_id);
      if (!containerTag) {
        res.status(409).json({ ok: false, error: 'This project memory no longer has a project.' });
        return;
      }
      const metadata: MemoryMetadata = {
        source: 'veneer-luna-curator-approved',
        memory_scope: row.scope,
        memory_kind: row.kind,
        user_id: String(req.user!.id),
      };
      if (row.conversation_id) metadata.conversation_id = row.conversation_id;
      if (row.project_id) metadata.project_id = row.project_id;
      const saved = row.replace_memory_id
        ? await memory.updateMemory({ containerTag, id: row.replace_memory_id, content: row.content })
        : await memory.addMemory({
            containerTag,
            content: row.content,
            isStatic: Boolean(row.is_static),
            metadata,
          });
      if (!saved) {
        res.status(502).json({ ok: false, error: 'Memory could not be saved right now.' });
        return;
      }
      db.prepare(
        `UPDATE memory_suggestions SET status = 'approved', resolved_at = datetime('now') WHERE id = ?`,
      ).run(row.id);
      res.json({ ok: true, memory: saved });
    })().catch(() => res.status(502).json({ ok: false, error: 'Memory could not be saved right now.' }));
  });

  router.post('/memory/suggestions/:id/dismiss', (req, res) => {
    const changed = db.prepare(
      `UPDATE memory_suggestions SET status = 'dismissed', resolved_at = datetime('now')
       WHERE id = ? AND user_id = ? AND status = 'suggested'`,
    ).run(String(req.params.id), req.user!.id).changes;
    if (!changed) {
      res.status(404).json({ ok: false, error: 'Memory suggestion not found.' });
      return;
    }
    res.json({ ok: true });
  });

  router.patch('/memory/:id', (req, res) => {
    void (async () => {
      if (memoryNotConfigured(res)) return;
      const body = MemoryPatchSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: 'Updated memory content is required.' });
        return;
      }
      if (isSensitiveMemory(body.data.content) || sanitizeMemoryText(body.data.content) !== body.data.content) {
        res.status(400).json({ ok: false, error: 'Sensitive identifiers and credentials cannot be saved to memory.' });
        return;
      }
      let updated = null;
      for (const containerTag of allMemoryContainerTagsForUser(req.user!.id)) {
        updated = await memory.updateMemory({ containerTag, id: String(req.params.id), content: body.data.content });
        if (updated) break;
      }
      if (!updated) {
        res.status(404).json({ ok: false, error: 'Memory not found or temporarily unavailable.' });
        return;
      }
      res.json({ ok: true, memory: updated });
    })().catch(() => res.status(502).json({ ok: false, error: 'Memory could not be updated right now.' }));
  });

  router.delete('/memory/:id', (req, res) => {
    void (async () => {
      if (memoryNotConfigured(res)) return;
      let forgotten = false;
      for (const containerTag of allMemoryContainerTagsForUser(req.user!.id)) {
        forgotten = (await memory.deleteMemory({ containerTag, id: String(req.params.id) })) === true;
        if (forgotten) break;
      }
      if (!forgotten) {
        res.status(404).json({ ok: false, error: 'Memory not found or temporarily unavailable.' });
        return;
      }
      res.json({ ok: true });
    })().catch(() => res.status(502).json({ ok: false, error: 'Memory could not be forgotten right now.' }));
  });

  router.get('/conversations', (req, res) => {
    void (async () => {
      applyChatAutoArchive(req.user!.id);
      const archived = req.query.archived === 'true' ? 1 : 0;
      // ?project=none → only unfiled chats; ?project=<id> → that project's chats;
      // absent → all. (Archived view ignores the filter — it shows everything.)
      const project = req.query.project === undefined ? null : String(req.query.project);
      const where = ['archived = ?', 'side_chat_of IS NULL'];
      const params: unknown[] = [archived];
      where.push("(visibility = 'team' OR user_id = ?)");
      where.push(businessScopeSql(req.user!.id, 'conversations'));
      where.push(businessAgentSql(db, req.agentConversationId, 'conversations'));
      params.push(req.user!.id);
      if (!archived && project === 'none') {
        // Automation project assignment controls its execution workspace; its
        // actionable/important result still belongs in the top-level attention
        // flow rather than being buried inside a collapsed project.
        where.push("(project_id IS NULL OR channel = 'automation')");
      } else if (!archived && project) {
        where.push('project_id = ?');
        where.push("channel <> 'automation'");
        params.push(project);
      }
      // Routine automation executions live under their persistent Automation
      // entity, not beside user-created chats. Surface only actionable runs and
      // explicitly important results in the manual-chat timeline. Pinning affects
      // the durable automation entity's position in the separate Chats section.
      // Orphan automation chats (for example after deleting an old schedule)
      // remain discoverable rather than becoming unreachable.
      where.push(
        `(channel <> 'automation'
          OR NOT EXISTS (
            SELECT 1 FROM scheduled_task_runs linked WHERE linked.conversation_id = conversations.id
          )
          OR EXISTS (
            SELECT 1
            FROM scheduled_task_runs r
            WHERE r.conversation_id = conversations.id
              AND (
                (r.status IN ('needs_you','failed') AND r.id = (
                  SELECT latest.id FROM scheduled_task_runs latest
                  WHERE latest.scheduled_task_id = r.scheduled_task_id
                  ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1
                ))
                OR r.important = 1
              )
          ))`,
      );
      // Loose chats keep following activity so the Today/This week sections stay
      // useful. Inside a project, keep the original newest-first creation order:
      // an agent doing work should not make its row jump around the project list.
      const chronologicalOrder =
        !archived && project && project !== 'none'
          ? 'created_at DESC, rowid DESC'
          : 'last_active_at DESC, rowid DESC';
      const rows = db
        .prepare(
          `SELECT conversations.*,
                  EXISTS (
                    SELECT 1 FROM conversation_wakeups wake
                    WHERE wake.conversation_id = conversations.id AND wake.status = 'pending'
                  ) AS has_pending_wakeup
             FROM conversations WHERE ${where.join(' AND ')}
           ORDER BY (pin_order IS NULL), pin_order, ${chronologicalOrder}`,
        )
        .all(...params) as Array<ConversationRow & { has_pending_wakeup: 0 | 1 }>;
      const conversations = await Promise.all(
        rows.filter(row => sameBusiness(db, req.agentConversationId, row)).map((row) => conversationView(ctx, row, req.user!, row.has_pending_wakeup === 1)),
      );
      res.json({ ok: true, conversations });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.get('/archived-conversations', (req, res) => {
    void (async () => {
      applyChatAutoArchive(req.user!.id);
      const parsed = ArchivedConversationsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: parsed.error.flatten() });
        return;
      }

      const { query, project, page, pageSize } = parsed.data;
      const where = [
        'c.archived = 1',
        "(c.visibility = 'team' OR c.user_id = ?)",
        businessScopeSql(req.user!.id),
        businessAgentSql(db, req.agentConversationId),
        `(c.channel <> 'automation'
          OR NOT EXISTS (
            SELECT 1 FROM scheduled_task_runs linked WHERE linked.conversation_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM scheduled_task_runs r
            WHERE r.conversation_id = c.id
              AND (
                (r.status IN ('needs_you','failed') AND r.id = (
                  SELECT latest.id FROM scheduled_task_runs latest
                  WHERE latest.scheduled_task_id = r.scheduled_task_id
                  ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1
                ))
                OR r.important = 1
              )
          ))`,
      ];
      const params: unknown[] = [req.user!.id];
      if (query) {
        const escaped = query.replace(/[\\%_]/g, '\\$&');
        where.push("COALESCE(c.title, '') LIKE ? ESCAPE '\\'");
        params.push(`%${escaped}%`);
      }
      const baseWhere = where.join(' AND ');

      const conversationPage = async (
        projectId: string | null,
        totalCount: number,
        projectName: string,
        requestedPage: number,
        requestedPageSize: number,
      ) => {
        const totalPages = Math.max(1, Math.ceil(totalCount / requestedPageSize));
        const safePage = Math.min(requestedPage, totalPages);
        const projectWhere = projectId === null ? 'c.project_id IS NULL' : 'c.project_id = ?';
        const projectParams = projectId === null ? params : [...params, projectId];
        const rows = db
          .prepare(
            `SELECT c.*,
                    EXISTS (
                      SELECT 1 FROM conversation_wakeups wake
                      WHERE wake.conversation_id = c.id AND wake.status = 'pending'
                    ) AS has_pending_wakeup
               FROM conversations c
             WHERE ${baseWhere} AND ${projectWhere}
             ORDER BY c.last_active_at DESC, c.rowid DESC
             LIMIT ? OFFSET ?`,
          )
          .all(...projectParams, requestedPageSize, (safePage - 1) * requestedPageSize) as Array<
            ConversationRow & { has_pending_wakeup: 0 | 1 }
          >;
        return {
          projectId,
          projectName,
          totalCount,
          page: safePage,
          pageSize: requestedPageSize,
          totalPages,
          conversations: await Promise.all(
            rows.filter(row => sameBusiness(db, req.agentConversationId, row)).map((row) => conversationView(ctx, row, req.user!, row.has_pending_wakeup === 1)),
          ),
        };
      };

      if (project !== undefined) {
        const projectId = project === 'none' ? null : project;
        const projectName = projectId === null
          ? 'Unfiled'
          : (db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)
              ?.name ?? 'Unknown project';
        const projectWhere = projectId === null ? 'c.project_id IS NULL' : 'c.project_id = ?';
        const projectParams = projectId === null ? params : [...params, projectId];
        const { totalCount } = db
          .prepare(`SELECT COUNT(*) AS totalCount FROM conversations c WHERE ${baseWhere} AND ${projectWhere}`)
          .get(...projectParams) as { totalCount: number };
        res.json({
          ok: true,
          group: await conversationPage(projectId, totalCount, projectName, page, pageSize),
        });
        return;
      }

      const summaries = db
        .prepare(
          `SELECT c.project_id AS projectId,
                  COALESCE(p.name, 'Unfiled') AS projectName,
                  COUNT(*) AS totalCount,
                  MAX(c.last_active_at) AS latestActivity
           FROM conversations c
           LEFT JOIN projects p ON p.id = c.project_id
           WHERE ${baseWhere}
           GROUP BY c.project_id, p.name
           ORDER BY latestActivity DESC, projectName COLLATE NOCASE`,
        )
        .all(...params) as Array<{
          projectId: string | null;
          projectName: string;
          totalCount: number;
          latestActivity: string;
        }>;
      const groups = await Promise.all(
        summaries.map((summary) =>
          conversationPage(summary.projectId, summary.totalCount, summary.projectName, 1, 10),
        ),
      );
      res.json({ ok: true, groups });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Projects (folders) ─────────────────────────────────────────────────────
  // A project is a shared folder with durable settings. New chats save its
  // instructions into their fixed context snapshot. Repository instruction
  // files remain user-owned. Everyone may list/create/edit; deletion removes
  // the folder and CASCADEs the chats and is owner/consultant only.
  function projectView(row: ProjectRow, user: UserRow): Record<string, unknown> {
    // Private chats do not change another user's visible project count.
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS chatCount, MAX(last_active_at) AS lastActiveAt
         FROM conversations
         WHERE project_id = ? AND archived = 0 AND channel <> 'automation'
           AND (visibility = 'team' OR user_id = ?) AND ${businessScopeSql(user.id, 'conversations')}`,
      )
      .get(row.id, user.id) as {
      chatCount: number;
      lastActiveAt: string | null;
    };
    const defaultAgent = row.default_assistant_id
      ? (db.prepare('SELECT slug FROM assistants WHERE id = ? AND deleted_at IS NULL').get(row.default_assistant_id) as
          | { slug: string }
          | undefined)?.slug ?? null
      : null;
    const folder = path.resolve(
      row.root_dir ??
        (ctx.config?.dataDir
          ? path.join(ctx.config.dataDir, 'workspaces', 'projects', row.slug)
          : path.join('workspaces', 'projects', row.slug)),
    );
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      instructions: row.instructions,
      appearance: readProjectAppearance(row.appearance_json),
      rootDir: row.root_dir ?? null,
      folder,
      defaultAgent,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      chatCount: stats.chatCount,
      lastActiveAt: stats.lastActiveAt,
    };
  }

  function currentAgentProject(
    req: Request,
    res: Response,
    allowUnfiled = false,
  ): ProjectRow | null | undefined {
    if (!req.agentConversationId) {
      res.status(403).json({
        ok: false,
        error: 'Project settings are only available to an authenticated agent conversation.',
      });
      return undefined;
    }
    const conversation = db
      .prepare('SELECT project_id FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.agentConversationId, req.user!.id) as { project_id: string | null } | undefined;
    if (!conversation) {
      res.status(404).json({ ok: false, error: 'Authenticated agent conversation not found.' });
      return undefined;
    }
    if (!conversation.project_id) {
      if (allowUnfiled) return null;
      res.status(409).json({ ok: false, error: 'This chat is not in a project.' });
      return undefined;
    }
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(conversation.project_id) as
      | ProjectRow
      | undefined;
    if (!project) {
      res.status(404).json({ ok: false, error: 'This chat’s project no longer exists.' });
      return undefined;
    }
    return project;
  }

  function projectSettingsView(row: ProjectRow | null): Record<string, unknown> {
    const appearance = row ? readProjectAppearance(row.appearance_json) : {};
    const effectiveAppearance = effectiveProjectAppearance(appearance, readPageBrand(db));
    return {
      project: row ? { id: row.id, slug: row.slug, name: row.name } : null,
      instructions: row?.instructions ?? '',
      appearance,
      effectiveAppearance,
      typographyGuidance: typographyGuidance(db, effectiveAppearance),
    };
  }

  router.get('/project-settings', (req, res) => {
    const project = currentAgentProject(req, res, true);
    if (project === undefined) return;
    res.json({ ok: true, projectSettings: projectSettingsView(project) });
  });

  router.patch('/project-settings', (req, res) => {
    const project = currentAgentProject(req, res);
    if (!project) return;
    const body = AgentProjectSettingsPatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        ok: false,
        error: body.error.issues[0]?.message ?? 'Invalid project settings.',
      });
      return;
    }
    if (body.data.instructions !== undefined) {
      db.prepare('UPDATE projects SET instructions = ? WHERE id = ?').run(body.data.instructions, project.id);
    }
    if (body.data.appearance !== undefined) {
      const appearance = normalizeProjectAppearance({
        ...readProjectAppearance(project.appearance_json),
        ...body.data.appearance,
      });
      db.prepare('UPDATE projects SET appearance_json = ? WHERE id = ?').run(JSON.stringify(appearance), project.id);
    }
    const fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
    res.json({ ok: true, projectSettings: projectSettingsView(fresh) });
  });

  router.get('/projects', (req, res) => {
    applyChatAutoArchive(req.user!.id);
    const rows = db.prepare('SELECT * FROM projects ORDER BY sort_order, created_at, id').all() as ProjectRow[];
    res.json({ ok: true, projects: rows.map((row) => projectView(row, req.user!)) });
  });

  router.put('/projects/order', (req, res) => {
    const body = ReorderProjectsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid project order' });
      return;
    }
    const current = db.prepare('SELECT id FROM projects').all() as { id: string }[];
    const ids = body.data.ids;
    const requested = new Set(ids);
    if (requested.size !== ids.length || ids.length !== current.length || current.some(({ id }) => !requested.has(id))) {
      res.status(409).json({ ok: false, error: 'The project list changed; refresh and try again' });
      return;
    }
    const update = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
    db.transaction((orderedIds: string[]) => {
      orderedIds.forEach((id, index) => update.run(index, id));
    })(ids);
    res.json({ ok: true });
  });

  router.get('/projects/:id', (req, res) => {
    applyChatAutoArchive(req.user!.id);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as ProjectRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: 'Project not found' });
      return;
    }
    res.json({ ok: true, project: projectView(row, req.user!) });
  });

  router.post('/projects', (req, res) => {
    const body = ProjectWriteSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'name required' });
      return;
    }
    // All active users may choose an absolute project folder. The service's
    // filesystem permissions still determine which paths it can create/use.
    let rootDir: string | null = null;
    if (body.data.rootDir) {
      if (!path.isAbsolute(body.data.rootDir)) {
        res.status(400).json({ ok: false, error: 'Folder must be an absolute path' });
        return;
      }
      rootDir = path.resolve(body.data.rootDir);
      try {
        fs.mkdirSync(rootDir, { recursive: true });
        if (!fs.statSync(rootDir).isDirectory()) throw new Error('path exists but is not a directory');
      } catch (err) {
        // Surface WHY the folder is unusable — most often a permission error
        // (the service user can't write outside the dirs it owns), which is
        // otherwise invisible behind a generic message.
        const code = (err as NodeJS.ErrnoException).code;
        const reason =
          code === 'EACCES' || code === 'EPERM'
            ? 'permission denied — the server has no write access there'
            : code === 'ENOTDIR'
              ? 'a parent path is a file, not a folder'
              : (err as Error).message;
        res.status(400).json({ ok: false, error: `Cannot use folder ${rootDir}: ${reason}` });
        return;
      }
    }
    const id = crypto.randomUUID();
    const slug = uniqueProjectSlug(db, body.data.name);
    db.prepare(
      `INSERT INTO projects (id, slug, name, instructions, appearance_json, root_dir, sort_order)
       SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(sort_order), -1) + 1 FROM projects`,
    ).run(
      id,
      slug,
      body.data.name,
      body.data.instructions ?? '',
      JSON.stringify(normalizeProjectAppearance(body.data.appearance)),
      rootDir,
    );
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    res.json({ ok: true, project: projectView(row, req.user!) });
  });

  // ── Folder browsing (all active users) ─────────────────────────────────────
  // Lists the subdirectories of an absolute path so the UI can offer a folder
  // picker for new projects. Read-only, directories only; hidden folders are
  // skipped from listings but any path (hidden or not) may be typed directly.
  router.get('/fs/dirs', (req, res) => {
    const raw = req.query.path === undefined ? loginHome() : String(req.query.path);
    if (!path.isAbsolute(raw)) {
      res.status(400).json({ ok: false, error: 'path must be absolute' });
      return;
    }
    const dir = path.resolve(raw);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      res.status(400).json({ ok: false, error: `Cannot read ${dir}` });
      return;
    }
    const dirs: { name: string; path: string }[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isDirectory()) dirs.push({ name, path: full });
      } catch {
        /* unreadable entry — skip */
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    res.json({ ok: true, path: dir, parent: parent === dir ? null : parent, dirs, home: loginHome() });
  });

  router.patch('/projects/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as ProjectRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: 'Project not found' });
      return;
    }
    const body = ProjectPatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid patch' });
      return;
    }
    let defaultAssistantId: number | null | undefined;
    if (body.data.defaultAgent !== undefined) {
      defaultAssistantId = null;
      if (body.data.defaultAgent !== null) {
        if (ADMIN_ONLY_ASSISTANTS.has(body.data.defaultAgent) && req.user!.role === 'member') {
          res.status(403).json({ ok: false, error: 'Not allowed' });
          return;
        }
        const assistant = db
          .prepare('SELECT id FROM assistants WHERE slug = ? AND deleted_at IS NULL')
          .get(body.data.defaultAgent) as
          | { id: number }
          | undefined;
        if (!assistant) {
          res.status(400).json({ ok: false, error: 'Unknown agent' });
          return;
        }
        defaultAssistantId = assistant.id;
      }
    }
    // Slug (folder) is intentionally never renamed — chats already run in it.
    if (body.data.name !== undefined) {
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(body.data.name, row.id);
    }
    if (body.data.instructions !== undefined) {
      db.prepare('UPDATE projects SET instructions = ? WHERE id = ?').run(body.data.instructions, row.id);
    }
    if (body.data.appearance !== undefined) {
      db.prepare('UPDATE projects SET appearance_json = ? WHERE id = ?').run(
        JSON.stringify(normalizeProjectAppearance(body.data.appearance)),
        row.id,
      );
    }
    if (defaultAssistantId !== undefined) {
      db.prepare('UPDATE projects SET default_assistant_id = ? WHERE id = ?').run(defaultAssistantId, row.id);
    }
    const fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id) as ProjectRow;
    res.json({ ok: true, project: projectView(fresh, req.user!) });
  });

  router.delete('/projects/:id', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as ProjectRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: 'Project not found' });
      return;
    }
    // Interrupt any live turns, then delete the project (chats CASCADE away),
    // then remove the folder. Order matters: kill processes before their rows
    // vanish so nothing writes back into a deleted conversation.
    const chatIds = db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(row.id) as { id: string }[];
    void (async () => {
      for (const { id } of chatIds) await manager.interrupt(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
      // A custom root folder is the user's own directory — never delete it.
      if (!row.root_dir) removeProjectFolder(ctx, row.slug);
      res.json({ ok: true });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // Agent types the caller may start a chat with (spec: assistants modeled in
  // schema). The everyday assistant is the default; Platform Dev is admin-only.
  router.get('/assistants', (req, res) => {
    const isAdmin = req.user!.role !== 'member';
    const rows = db
      .prepare(
        `SELECT slug, name, instructions, approval_mode, full_access
           FROM assistants
          WHERE deleted_at IS NULL
          ORDER BY id`,
      )
      .all() as {
      slug: string;
      name: string;
      instructions: string;
      approval_mode: 'ask' | 'auto';
      full_access: 0 | 1;
    }[];
    const assistants = rows
      .filter((r) => isAdmin || !ADMIN_ONLY_ASSISTANTS.has(r.slug))
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        // Agent prompts are owner-managed configuration. Members need the
        // picker metadata but not the full standing prompt.
        instructions: isAdmin ? r.instructions : '',
        approval_mode: r.approval_mode,
        full_access: Boolean(r.full_access),
        adminOnly: ADMIN_ONLY_ASSISTANTS.has(r.slug),
        isDefault: r.slug === 'assistant',
      }));
    res.json({ ok: true, assistants });
  });

  // Administrators create ordinary agents here. The server owns the immutable
  // slug so names cannot opt into privileged or special built-in behavior.
  router.post('/assistants', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const body = AssistantCreateSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Agent name is required' });
      return;
    }
    const slug = uniqueAssistantSlug(db, body.data.name);
    db.prepare('INSERT INTO assistants (slug, name, instructions, full_access) VALUES (?, ?, ?, 1)').run(
      slug,
      body.data.name,
      body.data.instructions,
    );
    res.status(201).json({
      ok: true,
      assistant: {
        slug,
        name: body.data.name,
        instructions: body.data.instructions,
        approval_mode: 'ask',
        full_access: true,
        adminOnly: false,
        isDefault: false,
      },
    });
  });

  // Update an agent's owner-managed display name and/or standing prompt. The
  // slug is immutable. Prompt changes apply to new chat snapshots; active
  // chats keep the context they started with. Admin-only, like model prefs.
  router.patch('/assistants/:slug', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const { slug } = req.params;
    const row = db.prepare('SELECT slug FROM assistants WHERE slug = ? AND deleted_at IS NULL').get(slug) as
      | { slug: string }
      | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: 'Agent not found' });
      return;
    }
    const body = AssistantPatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid agent update' });
      return;
    }
    if (slug === 'platform-dev' && body.data.approval_mode !== undefined) {
      res.status(400).json({ ok: false, error: 'Platform Dev approval mode cannot be changed' });
      return;
    }
    if (body.data.name !== undefined) {
      db.prepare('UPDATE assistants SET name = ? WHERE slug = ?').run(body.data.name, slug);
    }
    if (body.data.instructions !== undefined) {
      db.prepare('UPDATE assistants SET instructions = ? WHERE slug = ?').run(body.data.instructions, slug);
    }
    if (body.data.approval_mode !== undefined) {
      db.prepare('UPDATE assistants SET approval_mode = ? WHERE slug = ?').run(body.data.approval_mode, slug);
    }
    if (body.data.full_access !== undefined) {
      db.prepare('UPDATE assistants SET full_access = ? WHERE slug = ?').run(body.data.full_access ? 1 : 0, slug);
    }
    const fresh = db.prepare('SELECT name, instructions, approval_mode, full_access FROM assistants WHERE slug = ?').get(slug) as {
      name: string;
      instructions: string;
      approval_mode: 'ask' | 'auto';
      full_access: 0 | 1;
    };
    res.json({
      ok: true,
      assistant: {
        slug,
        name: fresh.name,
        instructions: fresh.instructions,
        approval_mode: fresh.approval_mode,
        full_access: Boolean(fresh.full_access),
        adminOnly: ADMIN_ONLY_ASSISTANTS.has(slug),
        isDefault: slug === 'assistant',
      },
    });
  });

  // Retire an optional agent instead of deleting its database row. Historical
  // chats keep the row as an identity snapshot and can still resume with their
  // original persona. New work, defaults, and automations stop using it.
  router.delete('/assistants/:slug', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const { slug } = req.params;
    const assistant = db
      .prepare('SELECT id, slug, name FROM assistants WHERE slug = ? AND deleted_at IS NULL')
      .get(slug) as
      | { id: number; slug: string; name: string }
      | undefined;
    if (!assistant) {
      res.status(404).json({ ok: false, error: 'Agent not found' });
      return;
    }
    void (async () => {
      const chats = db.prepare('SELECT id FROM conversations WHERE assistant_id = ?').all(assistant.id) as {
        id: string;
      }[];
      const statuses = await Promise.all(chats.map(({ id }) => manager.statusOf(id)));
      if (statuses.some((status) => status === 'working' || status === 'needs_you')) {
        res.status(409).json({
          ok: false,
          error: `Can't delete ${assistant.name} while it is working or waiting for you.`,
        });
        return;
      }

      // Keep one ordinary agent available to every role. Privileged agents are
      // not a safe fallback for members (or a sensible implicit new-chat choice
      // for administrators), so they do not satisfy this requirement.
      const replacement = db
        .prepare(
          `SELECT id, slug, name FROM assistants
           WHERE id <> ? AND deleted_at IS NULL
             AND slug NOT IN ('platform-dev', 'skill-smith')
           ORDER BY id LIMIT 1`,
        )
        .get(assistant.id) as { id: number; slug: string; name: string } | undefined;
      if (!replacement) {
        res.status(409).json({
          ok: false,
          error: `Can't delete ${assistant.name} because it is the last agent available for regular chats.`,
        });
        return;
      }

      const result = db.transaction(() => {
        const next = readModelPrefs();
        const agents = { ...next.agents };
        delete agents[slug];
        const assistantRemains =
          slug !== 'assistant' &&
          Boolean(db.prepare("SELECT 1 FROM assistants WHERE slug = 'assistant' AND deleted_at IS NULL").get());
        const cleaned: ModelPrefs = {
          ...next,
          // null historically means the built-in Assistant. If that row is
          // removed, persist a real replacement so every caller has a valid
          // role-safe site default.
          defaultAgent:
            next.defaultAgent === slug
              ? assistantRemains
                ? null
                : replacement.slug
              : slug === 'assistant' && next.defaultAgent === null
                ? replacement.slug
                : next.defaultAgent,
          agents,
        };
        db.prepare(
          'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
        ).run(MODEL_PREFS_KEY, JSON.stringify(cleaned));
        const projects = db
          .prepare('UPDATE projects SET default_assistant_id = ? WHERE default_assistant_id = ?')
          .run(replacement.id, assistant.id).changes;
        const automations = db
          .prepare(
            `UPDATE scheduled_tasks
                SET assistant_id = ?, updated_at = datetime('now')
              WHERE assistant_id = ?`,
          )
          .run(replacement.id, assistant.id).changes;
        db.prepare("UPDATE assistants SET deleted_at = datetime('now') WHERE id = ?").run(assistant.id);
        return { prefs: cleaned, projects, automations };
      })();

      res.json({
        ok: true,
        deleted: slug,
        prefs: result.prefs,
        replacement: { slug: replacement.slug, name: replacement.name },
        reassigned: { projects: result.projects, automations: result.automations },
      });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // Live model options for the new-conversation picker (spec: provider/model/
  // effort picked per conversation). Empty array (never an error) when the
  // provider isn't connected yet or has no listModels support — the UI falls
  // back to free text in that case.
  router.get('/models', (req, res) => {
    const provider = String(req.query.provider ?? '');
    // The runner returns [] for an unknown provider or one without listModels.
    manager
      .listModels(provider)
      .then((models) => res.json({ ok: true, models: modelsVisibleToUser(req.user!.email, provider, models) }))
      .catch(() => res.json({ ok: true, models: [] }));
  });

  // All workspace users can view provider usage. Refresh retains the existing
  // probe/cache limits; account changes remain behind the admin router.
  router.get('/usage', (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    void (async () => {
      // The probe + usage store live in the runner (sole writer). `?refresh=1`
      // asks it to run a probe when its newest snapshot is >15s old (an explicit
      // click should re-fetch; the 15s floor just coalesces frantic double-taps).
      // Without it we pass a huge maxAge so the runner never probes — just reads.
      // (JSON has no Infinity, so MAX_SAFE_INTEGER stands in for "don't probe".)
      let snapshots: Awaited<ReturnType<typeof ctx.manager.usage>>['snapshots'] = [];
      let planType: string | null = null;
      let accountEmail: string | null = null;
      let limitReset: Awaited<ReturnType<typeof ctx.manager.usage>>['limitReset'] = null;
      let perAccount: Awaited<ReturnType<typeof ctx.manager.usage>>['accounts'] = [];
      try {
        ({ snapshots, planType, accountEmail, limitReset, accounts: perAccount } = await ctx.manager.usage(
          refresh ? 15 * 1000 : Number.MAX_SAFE_INTEGER,
        ));
      } catch {
        /* runner unreachable — fall back to an empty (disconnected) claude view */
      }
      // The runner owns the meters (keyed by account id); the labels and which
      // account is active live here in the secret store. Join them so the Usage
      // screen can show "which account still has headroom" at a glance.
      const usageById = new Map(perAccount.map((entry) => [entry.accountId, entry]));
      const claudeAccounts = ctx.secrets.listClaudeAccounts().map((account) =>
        buildClaudeAccountUsage(
          {
            accountId: account.id,
            label: account.label,
            accountEmail: account.email ?? usageById.get(account.id)?.accountEmail ?? null,
            planType: account.planType ?? usageById.get(account.id)?.planType ?? null,
            active: account.active,
            limitReset: usageById.get(account.id)?.limitReset ?? null,
          },
          usageById.get(account.id)?.snapshots ?? [],
        ),
      );
      const claude = buildClaudeProvider(
        snapshots,
        ctx.secrets.status().connected,
        planType,
        accountEmail,
        claudeAccounts.length > 0 ? claudeAccounts : undefined,
        limitReset,
      );
      const [codex, grok, openrouter] = await Promise.all([
        ctx.codexUsage.read(),
        ctx.grokUsage.read(refresh),
        ctx.openRouterUsage.read(refresh),
      ]);
      res.json({ providers: { claude, codex, grok }, openrouter });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // New-chat model preferences. Everyone reads them (the picker needs them);
  // only owner/consultant may write (it's a Settings-screen surface).
  function readModelPrefs(): ModelPrefs {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(MODEL_PREFS_KEY) as
      | { value_json: string }
      | undefined;
    if (!row) return DEFAULT_MODEL_PREFS;
    try {
      const stored: unknown = JSON.parse(row.value_json);
      const parsed = ModelPrefsSchema.safeParse(stored);
      if (parsed.success) return parsed.data;
      const legacy = LegacyModelPrefsSchema.safeParse(stored);
      if (legacy.success) {
        const prefs: ModelPrefs = {
          ...DEFAULT_MODEL_PREFS,
          providerDefaults: { ...DEFAULT_MODEL_PREFS.providerDefaults },
          defaultEffort: legacy.data.defaultEffort,
          hiddenModels: legacy.data.hiddenModels,
        };
        if (legacy.data.defaultModel) {
          prefs.defaultProvider = legacy.data.defaultModel.provider;
          prefs.providerDefaults[legacy.data.defaultModel.provider] = legacy.data.defaultModel.model;
        }
        return prefs;
      }
      return DEFAULT_MODEL_PREFS;
    } catch {
      return DEFAULT_MODEL_PREFS;
    }
  }

  function modelPrefsVisibleToUser(email: string, prefs = readModelPrefs()): ModelPrefs {
    const providerDefaults = {
      claude: canUserAccessModel(email, 'claude', prefs.providerDefaults.claude)
        ? prefs.providerDefaults.claude
        : null,
      openrouter: canUserAccessModel(email, 'openrouter', prefs.providerDefaults.openrouter)
        ? prefs.providerDefaults.openrouter
        : null,
      codex: canUserAccessModel(email, 'codex', prefs.providerDefaults.codex)
        ? prefs.providerDefaults.codex
        : null,
      grok: canUserAccessModel(email, 'grok', prefs.providerDefaults.grok)
        ? prefs.providerDefaults.grok
        : null,
    };
    const agents = Object.fromEntries(Object.entries(prefs.agents).map(([slug, agent]) => {
      const provider = agent.provider ?? prefs.defaultProvider;
      return [
        slug,
        canUserAccessModel(email, provider, agent.model) ? agent : { ...agent, model: null },
      ];
    }));
    const hiddenModels = prefs.hiddenModels.filter((key) => {
      const separator = key.indexOf(':');
      return separator < 0 || canUserAccessModel(email, key.slice(0, separator), key.slice(separator + 1));
    });
    const modelOrder = Object.fromEntries(
      Object.entries(prefs.modelOrder).map(([provider, models]) => [
        provider,
        models.filter((model) => canUserAccessModel(email, provider, model)),
      ]),
    );
    return { ...prefs, providerDefaults, agents, hiddenModels, modelOrder };
  }

  // Auto-name a new chat via OpenRouter (best-effort, fire-and-forget). Replaces
  // the first-line placeholder with a ≤4-word title and locks it (title_auto=0)
  // so the provider's own rolling title can't overwrite it. Any failure (feature
  // off, no key, API error, empty reply) simply leaves the placeholder in place.
  const lockTitleStmt = db.prepare('UPDATE conversations SET title = ?, title_auto = 0 WHERE id = ?');
  async function autoTitleConversation(
    conversationId: string,
    firstMessage: string,
    prefs: ModelPrefs,
  ): Promise<void> {
    if (!prefs.autoTitle.enabled) return;
    const apiKey = effectiveApiKey('openrouter', ctx.secrets, ctx.config, ctx.doppler).value;
    if (!apiKey) {
      console.warn('[auto-title] skipped: no OpenRouter key configured');
      return;
    }
    try {
      const title = await generateChatTitle(firstMessage, prefs.autoTitle.model, apiKey);
      if (title) lockTitleStmt.run(title, conversationId);
    } catch (err) {
      console.warn(`[auto-title] failed: ${(err as Error).message}`);
    }
  }

  router.get('/model-prefs', (req, res) => {
    res.json({ ok: true, prefs: modelPrefsVisibleToUser(req.user!.email) });
  });

  router.put('/model-prefs', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const body = ModelPrefsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid preferences' });
      return;
    }
    const prefs = body.data;
    prefs.openrouterModels = [...new Set(prefs.openrouterModels)];
    if (!prefs.providerDefaults.openrouter || !prefs.openrouterModels.includes(prefs.providerDefaults.openrouter)) {
      prefs.providerDefaults.openrouter = prefs.openrouterModels[0] ?? null;
    }
    for (const agent of Object.values(prefs.agents)) {
      if (agent.provider === 'openrouter' && agent.model && !prefs.openrouterModels.includes(agent.model)) {
        res.status(400).json({ ok: false, error: `OpenRouter model "${agent.model}" is not in the configured list` });
        return;
      }
    }
    const sharedModels = [
      ...Object.entries(prefs.providerDefaults),
      ...Object.values(prefs.agents).map((agent) => [agent.provider ?? prefs.defaultProvider, agent.model] as const),
    ];
    if (sharedModels.some(([provider, model]) => isUserScopedModel(provider, model))) {
      res.status(400).json({ ok: false, error: 'User-only models cannot be saved as shared defaults' });
      return;
    }
    db.prepare(
      'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
    ).run(MODEL_PREFS_KEY, JSON.stringify(prefs));
    res.json({ ok: true, prefs });
  });

  const requireDopplerAdmin = (req: Request, res: Response): boolean => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return false;
    }
    return true;
  };

  const requireDopplerOwner = (req: Request, res: Response): boolean => {
    if (req.user!.role !== 'owner') {
      res.status(403).json({ ok: false, error: 'Owner access required' });
      return false;
    }
    return true;
  };

  const dopplerStatus = () => {
    const metadata = readDopplerMetadata(db);
    const tokens = ctx.dopplerTokens.get();
    const runtime = ctx.doppler.status();
    return {
      connected: Boolean(metadata && tokens.runtimeToken && tokens.agentToken),
      project: metadata?.project ?? runtime.project,
      config: metadata?.config ?? runtime.config,
      connectedAt: metadata?.connectedAt ?? tokens.connectedAt ?? null,
      runtime: {
        configured: Boolean(tokens.runtimeToken),
        healthy: runtime.healthy,
        lastCheckedAt: runtime.lastCheckedAt,
        error: runtime.error,
      },
      agent: {
        configured: Boolean(tokens.agentToken),
      },
      access: dopplerAccessPolicy(Boolean(ctx.projectDopplerCli)),
      additionalGuidance: readDopplerAgentGuidance(db),
    };
  };

  // Client-scoped Doppler connection. Tokens are write-only and live in
  // DATA_DIR/doppler.json (0600, explicitly excluded from backups). SQLite
  // contains only safe project/config/status metadata for agent materialization.
  router.get('/admin/doppler', (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, connection: dopplerStatus() });
  });

  router.put('/admin/doppler', async (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    const body = DopplerConnectSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Project, config, and valid service tokens are required.' });
      return;
    }
    const existing = ctx.dopplerTokens.get();
    const runtimeToken = body.data.runtimeToken || existing.runtimeToken;
    const agentToken = body.data.agentToken || existing.agentToken;
    if (!runtimeToken || !agentToken) {
      res.status(400).json({ ok: false, error: 'Add both a read-only runtime token and a read/write agent token.' });
      return;
    }
    try {
      const [runtimeSecrets, agentSecrets] = await Promise.all([
        downloadDopplerSecrets(runtimeToken),
        downloadDopplerSecrets(agentToken),
      ]);
      validateDopplerIdentity(runtimeSecrets, body.data.project, body.data.config);
      validateDopplerIdentity(agentSecrets, body.data.project, body.data.config);
      // A newly supplied agent token must prove read/write access. A blank
      // field means "keep the already-tested token" during runtime rotation.
      if (body.data.agentToken) await verifyDopplerWriteAccess(agentToken);
      await configureDopplerCli(agentToken);
      const connectedAt = new Date().toISOString();
      ctx.dopplerTokens.set(
        {
          ...(body.data.runtimeToken ? { runtimeToken: body.data.runtimeToken } : {}),
          ...(body.data.agentToken ? { agentToken: body.data.agentToken } : {}),
        },
        connectedAt,
      );
      writeDopplerMetadata(db, {
        project: body.data.project,
        config: body.data.config,
        connectedAt,
        runtimeConfigured: true,
        agentConfigured: true,
      });
      await ctx.doppler.refresh();
      let memoryProvisioningError: string | null = null;
      if (ctx.config && !memory.configured) {
        try {
          const result = ctx.memoryProvisioner
            ? await ctx.memoryProvisioner.ensure()
            : await ensureSupermemoryConfigured({
                dataDir: ctx.config.dataDir,
                openRouterApiKey: runtimeSecrets.get('OPENROUTER_API_KEY') ?? '',
              });
          if (!result.configured) {
            memoryProvisioningError = result.reason ?? 'Memory setup did not complete.';
          }
        } catch (error) {
          memoryProvisioningError = redactDopplerError(error);
          console.warn(`[supermemory] setup after Doppler connection failed: ${memoryProvisioningError}`);
        }
      }
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        connection: dopplerStatus(),
        memory: {
          configured: memory.configured,
          ...(memoryProvisioningError ? { error: memoryProvisioningError } : {}),
        },
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: redactDopplerError(error) });
    }
  });

  router.put('/admin/doppler/guidance', (req, res) => {
    if (!requireDopplerOwner(req, res)) return;
    const body = DopplerGuidanceSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Additional guidance must be 20,000 characters or less.' });
      return;
    }
    writeDopplerAgentGuidance(db, body.data.additionalGuidance);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, connection: dopplerStatus() });
  });

  router.post('/admin/doppler/test', async (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    const tokens = ctx.dopplerTokens.get();
    const metadata = readDopplerMetadata(db);
    if (!tokens.runtimeToken || !tokens.agentToken || !metadata) {
      res.status(409).json({ ok: false, error: 'Connect Doppler first.' });
      return;
    }
    try {
      const runtime = await ctx.doppler.refresh();
      if (!runtime.healthy) throw new Error(runtime.error ?? 'The runtime token could not read secrets.');
      const agentSecrets = await downloadDopplerSecrets(tokens.agentToken);
      validateDopplerIdentity(agentSecrets, metadata.project, metadata.config);
      await verifyDopplerWriteAccess(tokens.agentToken);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, connection: dopplerStatus() });
    } catch (error) {
      res.status(400).json({ ok: false, error: redactDopplerError(error), connection: dopplerStatus() });
    }
  });

  router.delete('/admin/doppler', async (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    try {
      // The dedicated CLI config directory contains both the persisted token
      // and any encrypted fallback cache produced by terminal use.
      clearDopplerCli();
      ctx.dopplerTokens.clear();
      clearDopplerMetadata(db);
      await ctx.doppler.refresh();
      res.json({ ok: true, connection: dopplerStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: redactDopplerError(error) });
    }
  });

  // Approval-gated agent surface. The separate `doppler` MCP server forwards
  // here with the conversation owner's short-lived agent token, so the normal
  // owner/consultant authorization remains authoritative.
  router.get('/doppler/secrets', async (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    const agentToken = ctx.dopplerTokens.get().agentToken;
    if (!agentToken) {
      res.status(409).json({ ok: false, error: 'Doppler is not connected.' });
      return;
    }
    try {
      const values = await downloadDopplerSecrets(agentToken);
      const names = [...values.keys()].filter((name) => !name.startsWith('DOPPLER_')).sort();
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, names });
    } catch (error) {
      res.status(502).json({ ok: false, error: redactDopplerError(error) });
    }
  });

  router.get('/doppler/secrets/:name', async (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    const agentToken = ctx.dopplerTokens.get().agentToken;
    if (!agentToken) {
      res.status(409).json({ ok: false, error: 'Doppler is not connected.' });
      return;
    }
    try {
      const name = String(req.params.name ?? '').trim().toUpperCase();
      const values = await downloadDopplerSecrets(agentToken);
      const value = values.get(name);
      if (value === undefined || name.startsWith('DOPPLER_')) {
        res.status(404).json({ ok: false, error: 'Secret not found.' });
        return;
      }
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, name, value });
    } catch (error) {
      res.status(502).json({ ok: false, error: redactDopplerError(error) });
    }
  });

  router.put('/doppler/secrets/:name', async (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    const body = DopplerSecretWriteSchema.safeParse(req.body);
    const agentToken = ctx.dopplerTokens.get().agentToken;
    if (!body.success || !agentToken) {
      res.status(agentToken ? 400 : 409).json({ ok: false, error: agentToken ? 'A value is required.' : 'Doppler is not connected.' });
      return;
    }
    try {
      const name = String(req.params.name ?? '');
      await setDopplerSecret(agentToken, name, body.data.value);
      await ctx.doppler.refresh();
      res.json({ ok: true, name: name.trim().toUpperCase() });
    } catch (error) {
      res.status(400).json({ ok: false, error: redactDopplerError(error) });
    }
  });

  router.delete('/doppler/secrets/:name', async (req, res) => {
    if (!requireDopplerAdmin(req, res)) return;
    const agentToken = ctx.dopplerTokens.get().agentToken;
    if (!agentToken) {
      res.status(409).json({ ok: false, error: 'Doppler is not connected.' });
      return;
    }
    try {
      const name = String(req.params.name ?? '');
      await deleteDopplerSecret(agentToken, name);
      await ctx.doppler.refresh();
      res.json({ ok: true, name: name.trim().toUpperCase() });
    } catch (error) {
      res.status(400).json({ ok: false, error: redactDopplerError(error) });
    }
  });

  // Managed third-party API keys (Settings → API Keys). Admin-only, matching the
  // account-admin routes. Status is non-secret (configured/source/last-4 hint);
  // the raw key is never returned. Overrides live in DATA_DIR/secrets.json; a
  // blank value clears the override and reverts to the env/Doppler default.
  router.get('/admin/api-keys', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    res.json({ ok: true, keys: apiKeyStatuses(ctx.secrets, ctx.config, ctx.doppler) });
  });

  router.put('/admin/api-keys/:id', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const id = req.params.id;
    if (!API_KEY_IDS.includes(id as ApiKeyId)) {
      res.status(404).json({ ok: false, error: 'Unknown API key' });
      return;
    }
    const body = ApiKeyWriteSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid value' });
      return;
    }
    ctx.secrets.setApiKeyOverride(id, body.data.value);
    res.json({ ok: true, keys: apiKeyStatuses(ctx.secrets, ctx.config, ctx.doppler) });
  });

  // One shared client logo for this Veneer instance. The browser normalizes
  // source files to a square PNG before upload; the server stores only that
  // safe raster result and never exposes the original SVG/JPEG/WebP bytes.
  const parseClientLogo = express.raw({ type: 'image/png', limit: CLIENT_LOGO_MAX_BYTES });
  const requireClientLogoAdmin = (req: Request, res: Response, next: () => void): void => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    next();
  };
  const sendClientLogo = (res: Response): void => {
    const file = clientLogoPath(ctx.config.dataDir);
    if (!fs.existsSync(file)) {
      res.status(404).json({ ok: false, error: 'No client logo configured' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('png').sendFile(file);
  };

  // The brand is visible to every signed-in user, while management remains
  // restricted to owners and consultants on the admin routes below.
  router.get('/client-logo', (_req, res) => {
    sendClientLogo(res);
  });

  router.get('/admin/client-logo', requireClientLogoAdmin, (_req, res) => {
    sendClientLogo(res);
  });

  router.put(
    '/admin/client-logo',
    requireClientLogoAdmin,
    (req, res, next) => {
      parseClientLogo(req, res, (error) => {
        if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
          res.status(413).json({ ok: false, error: 'Logo exceeds the 2 MB upload limit' });
          return;
        }
        if (error) {
          next(error);
          return;
        }
        next();
      });
    },
    (req, res) => {
      if (!req.is('image/png')) {
        res.status(415).json({ ok: false, error: 'Client logo must be a PNG' });
        return;
      }
      const data = req.body as unknown;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        res.status(400).json({ ok: false, error: 'Client logo is empty' });
        return;
      }
      if (!isPng(data)) {
        res.status(400).json({ ok: false, error: 'Client logo is not a valid PNG' });
        return;
      }
      try {
        writeClientLogo(ctx.config.dataDir, data);
      } catch {
        res.status(500).json({ ok: false, error: 'Client logo could not be saved' });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.delete('/admin/client-logo', requireClientLogoAdmin, (_req, res) => {
    try {
      removeClientLogo(ctx.config.dataDir);
    } catch {
      res.status(500).json({ ok: false, error: 'Client logo could not be removed' });
      return;
    }
    res.json({ ok: true });
  });

  // Site-wide Soniox dictation vocabulary hints. Credentials remain in the
  // managed secret store above; this row contains no secrets.
  router.get('/admin/voice-settings', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    res.json({ ok: true, settings: readVoiceSettings(ctx.db) });
  });

  router.put('/admin/voice-settings', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const body = VoiceSettingsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid voice settings' });
      return;
    }
    const current = readVoiceSettings(ctx.db);
    res.json({ ok: true, settings: writeVoiceSettings(ctx.db, { ...current, ...body.data }) });
  });

  // Concurrent-editing file locks. Everyone may read the current state (so the
  // Settings toggle reflects reality); only owner/consultant may change it.
  const fileLockPath = (): string => path.join(ctx.config.sourceDir, '.claude', 'filelock.config.json');
  function readFileLock(): { enabled: boolean; ttlSeconds: number } {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(fileLockPath(), 'utf8'));
      const c = (parsed ?? {}) as { enabled?: unknown; ttlSeconds?: unknown };
      return {
        enabled: typeof c.enabled === 'boolean' ? c.enabled : true,
        ttlSeconds: typeof c.ttlSeconds === 'number' && c.ttlSeconds > 0 ? c.ttlSeconds : 90,
      };
    } catch {
      return { enabled: true, ttlSeconds: 90 }; // missing/broken file → hook default (on)
    }
  }

  router.get('/filelock', (_req, res) => {
    res.json({ ok: true, config: readFileLock() });
  });

  router.put('/filelock', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const body = FileLockSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid file-lock settings' });
      return;
    }
    const next = { enabled: body.data.enabled, ttlSeconds: body.data.ttlSeconds, _help: FILELOCK_HELP };
    try {
      const p = fileLockPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
      return;
    }
    res.json({ ok: true, config: { enabled: next.enabled, ttlSeconds: next.ttlSeconds } });
  });

  router.post('/conversations', (req, res) => {
    const body = CreateConversationSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'firstMessage required' });
      return;
    }
    const prefs = modelPrefsVisibleToUser(req.user!.email);
    // Resolve the project before the agent: when the caller leaves the agent
    // unset, a project's default takes precedence over the site-wide default.
    let projectId: string | null = null;
    let projectDefaultAgent: string | null = null;
    if (body.data.projectId) {
      const project = db
        .prepare(
          `SELECT p.id, a.slug AS default_agent
             FROM projects p
             LEFT JOIN assistants a ON a.id = p.default_assistant_id AND a.deleted_at IS NULL
            WHERE p.id = ?`,
        )
        .get(body.data.projectId) as { id: string; default_agent: string | null } | undefined;
      if (!project) {
        res.status(400).json({ ok: false, error: 'Unknown project' });
        return;
      }
      projectId = project.id;
      projectDefaultAgent = project.default_agent;
    }
    const available = (
      db.prepare('SELECT * FROM assistants WHERE deleted_at IS NULL ORDER BY id').all() as AssistantRow[]
    ).filter(
      (candidate) => req.user!.role !== 'member' || !ADMIN_ONLY_ASSISTANTS.has(candidate.slug),
    );
    let assistant: AssistantRow | undefined;
    if (body.data.assistantSlug) {
      // An explicit missing slug must fail visibly. Silently running a
      // different persona is especially dangerous for privileged agents.
      if (ADMIN_ONLY_ASSISTANTS.has(body.data.assistantSlug) && req.user!.role === 'member') {
        res.status(403).json({ ok: false, error: 'Not allowed' });
        return;
      }
      assistant = available.find((candidate) => candidate.slug === body.data.assistantSlug);
      if (!assistant) {
        res.status(400).json({ ok: false, error: 'Agent is unavailable' });
        return;
      }
    } else {
      // Project and site defaults win when they still exist and are allowed.
      // Otherwise prefer an ordinary agent; never fall through by raw row id
      // to Platform Dev or Skill Builder.
      for (const preferred of [projectDefaultAgent, prefs.defaultAgent, 'assistant']) {
        if (!preferred) continue;
        assistant = available.find((candidate) => candidate.slug === preferred);
        if (assistant) break;
      }
      assistant ??= available.find((candidate) => !ADMIN_ONLY_ASSISTANTS.has(candidate.slug)) ?? available[0];
      if (!assistant) {
        res.status(409).json({ ok: false, error: 'No agent is available' });
        return;
      }
    }
    const slug = assistant.slug;
    if (assistant.slug === 'platform-dev' && body.data.approval_mode !== undefined) {
      res.status(400).json({ ok: false, error: 'Platform Dev approval mode cannot be changed' });
      return;
    }
    // Fill in anything the client left unset from this agent's Settings default,
    // then the global new-chat default. (The web picker sends explicit values,
    // so this mainly serves other channels and honours per-agent defaults.)
    const agentDef = prefs.agents[slug];
    const provider = body.data.provider ?? agentDef?.provider ?? prefs.defaultProvider;
    if (!KNOWN_PROVIDERS.has(provider)) {
      res.status(400).json({ ok: false, error: `Unknown provider "${provider}"` });
      return;
    }
    // No explicit model → the agent's model, else the provider's default model.
    const model = body.data.model ?? agentDef?.model ?? prefs.providerDefaults[provider] ?? null;
    if (provider === 'openrouter' && (!model || !prefs.openrouterModels.includes(model))) {
      res.status(400).json({ ok: false, error: 'Choose a configured OpenRouter model' });
      return;
    }
    if (!canUserAccessModel(req.user!.email, provider, model)) {
      res.status(400).json({ ok: false, error: 'This model is not available' });
      return;
    }
    const effort = body.data.effort ?? agentDef?.effort ?? prefs.defaultEffort ?? null;
    // Project (folder) this chat runs in is fixed for the chat's life.
    const id = body.data.id ?? crypto.randomUUID();
    // A parent link means "explicit handoff", not merely "an agent made this
    // request". Require both signals to agree so a stale MCP token cannot nest
    // an unrelated chat. Other agent-created chats remain top-level.
    let originId: string | null = null;
    if (body.data.originConversationId) {
      if (body.data.originConversationId !== req.agentConversationId) {
        res.status(403).json({ ok: false, error: 'Handoff origin does not match the current agent chat' });
        return;
      }
      if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(body.data.originConversationId)) {
        res.status(409).json({ ok: false, error: 'Handoff origin is no longer available' });
        return;
      }
      originId = body.data.originConversationId;
    }
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations
           (id, assistant_id, user_id, visibility, project_id, title, provider, model, effort, approval_mode, native_session_id, channel, origin_conversation_id, last_user_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, datetime('now'))`,
      ).run(
        id,
        assistant.id,
        req.user!.id,
        body.data.visibility,
        projectId,
        titleFrom(body.data.firstMessage),
        provider,
        model,
        effort,
        body.data.approval_mode ?? null,
        // Every adapter mints a native session id as a random UUID; web no longer
        // holds adapters, so mint it directly (the runner keys off this row).
        crypto.randomUUID(),
        originId,
      );
      if (req.agentConversationId) db.prepare('UPDATE conversations SET business_team_id=(SELECT business_team_id FROM conversations WHERE id=?) WHERE id=?').run(req.agentConversationId, id);
      ensureConversationInstructionSnapshot(db, id);
    })();
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;
    // The creating human is already in this chat. Agent handoffs stay unseen
    // until that user actually opens them.
    if (!req.agentConversationId) markSeen(db, req.user!.id, row.id);
    // Kick off LLM auto-titling (if enabled) in parallel with the first turn.
    void autoTitleConversation(row.id, body.data.firstMessage, prefs);
    void (async () => {
      const origin = agentMessageOrigin(req, row.id);
      if (origin) await manager.postMessage(row.id, body.data.firstMessage, req.user!.id, origin);
      else await manager.postMessage(row.id, body.data.firstMessage, req.user!.id);
      res.json({ ok: true, conversation: await conversationView(ctx, row, req.user!) });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.get('/conversations/:id', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    // Agent reads are coordination, not a human reopening the chat.
    if (!req.agentConversationId && canManageConversation(req.user!, row, ctx.db)) {
      db.prepare("UPDATE conversations SET last_user_activity_at = datetime('now') WHERE id = ?").run(row.id);
      markSeen(db, req.user!.id, row.id);
    }
    void conversationView(ctx, row, req.user!)
      .then((conversation) => res.json({ ok: true, conversation }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.get('/conversations/:id/context', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    try {
      res.json({ ok: true, context: readConversationDebugContext(db, ctx.config, row) });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get('/conversations/:id/link', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    res.set('Cache-Control', 'no-store');
    try {
      const url = conversationShareUrl(ctx.config?.appPublicOrigin, row.id, row.project_id);
      res.json({ ok: true, url, conversationId: row.id, projectId: row.project_id ?? null, title: row.title });
    } catch (error) {
      res.status(503).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post('/conversations/:id/fresh-context', (req, res) => {
    const source = conversationFor(req, res);
    if (!source) return;
    if (!canUserAccessModel(req.user!.email, source.provider, source.model)) {
      res.status(400).json({ ok: false, error: 'This model is not available' });
      return;
    }
    const assistant = db
      .prepare('SELECT slug FROM assistants WHERE id = ? AND deleted_at IS NULL')
      .get(source.assistant_id) as { slug: string } | undefined;
    if (!assistant || (req.user!.role === 'member' && ADMIN_ONLY_ASSISTANTS.has(assistant.slug))) {
      res.status(403).json({ ok: false, error: 'This agent is not available for a new chat.' });
      return;
    }
    const id = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations
           (id, assistant_id, user_id, visibility, project_id, title, title_auto,
            provider, model, effort, approval_mode, native_session_id, channel, last_user_activity_at)
         VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, 'web', datetime('now'))`,
      ).run(
        id,
        source.assistant_id,
        req.user!.id,
        source.visibility,
        source.project_id,
        source.provider,
        source.model,
        source.effort,
        source.approval_mode,
        crypto.randomUUID(),
      );
      if (source.business_team_id) db.prepare('UPDATE conversations SET business_team_id=? WHERE id=?').run(source.business_team_id, id);
      ensureConversationInstructionSnapshot(db, id);
    })();
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;
    markSeen(db, req.user!.id, row.id);
    void conversationView(ctx, row, req.user!)
      .then((conversation) => res.status(201).json({ ok: true, conversation }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Side chats: ask about a chat without interrupting its agent ───────────
  // A side chat is a private conversation on the same agent, project and model
  // as its parent, seeded with the parent's recent exchange. It never posts to
  // the parent; the parent's turn keeps running untouched.
  router.get('/conversations/:id/side-chats', (req, res) => {
    const parent = conversationFor(req, res);
    if (!parent) return;
    const rows = db
      .prepare(
        `SELECT * FROM conversations
          WHERE side_chat_of = ? AND archived = 0 AND (visibility = 'team' OR user_id = ?)
          ORDER BY last_active_at DESC`,
      )
      .all(parent.id, req.user!.id) as ConversationRow[];
    res.json({
      ok: true,
      sideChats: rows.map((row) => ({
        id: row.id,
        title: row.title,
        lastActiveAt: row.last_active_at,
        status: manager.statusOf(row.id),
        unread: isUnread(db, req.user!.id, row.id),
      })),
    });
  });

  router.post('/conversations/:id/side-chats', (req, res) => {
    const parent = conversationFor(req, res);
    if (!parent) return;
    const body = z.object({ firstMessage: z.string().trim().min(1).max(20_000) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'firstMessage required' });
      return;
    }
    if (parent.side_chat_of) {
      res.status(400).json({ ok: false, error: 'Open side chats from the main chat' });
      return;
    }
    if (!canUserAccessModel(req.user!.email, parent.provider, parent.model)) {
      res.status(400).json({ ok: false, error: 'This model is not available' });
      return;
    }
    const assistant = db
      .prepare('SELECT slug, name FROM assistants WHERE id = ? AND deleted_at IS NULL')
      .get(parent.assistant_id) as { slug: string; name: string } | undefined;
    if (!assistant || (req.user!.role === 'member' && ADMIN_ONLY_ASSISTANTS.has(assistant.slug))) {
      res.status(403).json({ ok: false, error: 'This agent is not available for a side chat.' });
      return;
    }
    const id = crypto.randomUUID();
    const title = `Side chat · ${parent.title?.trim() || 'Untitled chat'}`;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations
           (id, assistant_id, user_id, visibility, project_id, title, title_auto,
            provider, model, effort, approval_mode, native_session_id, channel, side_chat_of, last_user_activity_at)
         VALUES (?, ?, ?, 'private', ?, ?, 0, ?, ?, ?, ?, ?, 'web', ?, datetime('now'))`,
      ).run(
        id,
        parent.assistant_id,
        req.user!.id,
        parent.project_id,
        title,
        parent.provider,
        parent.model,
        parent.effort,
        parent.approval_mode,
        crypto.randomUUID(),
        parent.id,
      );
      if (parent.business_team_id) db.prepare('UPDATE conversations SET business_team_id=? WHERE id=?').run(parent.business_team_id, id);
      ensureConversationInstructionSnapshot(db, id);
    })();
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;
    markSeen(db, req.user!.id, row.id);
    void (async () => {
      const [events, status] = await Promise.all([manager.snapshot(parent.id), manager.statusOf(parent.id)]);
      const opening = sideChatOpeningMessage({
        parentId: parent.id,
        parentTitle: parent.title,
        agentName: assistant.name,
        status,
        events,
        question: body.data.firstMessage,
      });
      await manager.postMessage(row.id, opening, req.user!.id);
      res.status(201).json({ ok: true, conversation: await conversationView(ctx, row, req.user!) });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.get('/conversations/:id/transcript', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    void (async () => {
      const [events, status] = await Promise.all([manager.snapshot(row.id), manager.statusOf(row.id)]);
      res.json({
        ok: true,
        events: events.map((event) => presentConversationEventForUser(db, req.user!, event)),
        status,
      });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Session files: deliverables (CSV etc.) this chat's agent created ───────
  // Detected by scanning the native session transcript for Write tool calls
  // and file-producing Bash commands (see providers/claude/sessionFiles.ts),
  // then filtered to files that still exist. Bash detection is heuristic — a
  // command can also *mention* a pre-existing file — so bash-sourced hits must
  // additionally have been modified after the chat began.
  const SESSION_FILE_PREVIEW_BYTES = 512 * 1024;

  async function sessionFilesFor(row: ConversationRow): Promise<SessionFileView[]> {
    // conversations.created_at is sqlite datetime('now') — UTC without a zone.
    const createdAtMs = new Date(`${row.created_at.replace(' ', 'T')}Z`).getTime();
    const refs = await manager.listSessionFiles(row.id);
    const files: SessionFileView[] = [];
    for (const ref of refs) {
      const file = sessionFileView(ref, createdAtMs);
      if (file) files.push(file);
    }
    return files;
  }

  router.get('/conversations/:id/files', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    void sessionFilesFor(row)
      .then((files) => res.json({ ok: true, files }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // Published pages, mini apps and durable generated files associated with one
  // conversation. conversationFor applies the usual member ownership gate;
  // listGeneratedFiles additionally preserves the generated-files member scope
  // and prunes registry rows whose on-disk file has disappeared.
  router.get('/conversations/:id/artifacts', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    void ensureFileSyncBackfill(ctx);
    try {
      const pages = db
        .prepare(
          `SELECT id, slug, title, updated_at,
                  COALESCE(expires_at, datetime(updated_at, '+7 days')) AS expires_at
             FROM pages
            WHERE conversation_id = ?
              AND COALESCE(expires_at, datetime(updated_at, '+7 days')) > datetime('now')`,
        )
        .all(row.id) as { id: string; slug: string; title: string; updated_at: string; expires_at: string }[];
      const apps = db
        .prepare(
          `SELECT id, slug, title, runtime, status, last_error, updated_at
             FROM mini_apps WHERE conversation_id = ?`,
        )
        .all(row.id) as {
        id: string;
        slug: string;
        title: string;
        runtime: 'cloudflare' | 'local';
        status: 'deploying' | 'deployed' | 'error';
        last_error: string | null;
        updated_at: string;
      }[];
      const files = listGeneratedFiles(ctx, req.user!, req.agentConversationId).filter((file) => file.conversationId === row.id);
      const artifacts = [
        ...pages.map((page) => ({
          type: 'page' as const,
          id: page.id,
          title: page.title,
          slug: page.slug,
          url: `${ctx.config.pages?.publicBase ?? ''}/p/${page.slug}`,
          updatedAt: page.updated_at,
          expiresAt: page.expires_at,
        })),
        ...apps.map((app) => ({
          type: 'app' as const,
          id: app.id,
          title: app.title,
          slug: app.slug,
          url: ctx.config.appPublicOrigin ? miniAppUrl(ctx.config.appPublicOrigin, app.slug) : `/tools/${app.slug}/`,
          runtime: app.runtime,
          status: app.status,
          lastError: app.last_error,
          updatedAt: app.updated_at,
        })),
        ...files.map((file) => ({
          type: 'file' as const,
          id: file.id,
          name: file.name,
          path: file.path,
          size: file.size,
          updatedAt: file.mtime,
          kind: artifactKind(file.name),
        })),
      ];
      const timestamp = (value: string | number): number => {
        if (typeof value === 'number') return value;
        return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).getTime();
      };
      artifacts.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
      res.json({ ok: true, artifacts });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Content of ONE detected session file: ?download=1 streams it as an
  // attachment, ?inline=1 streams it for browser-native previews, otherwise
  // this returns a JSON text preview (capped, binary-guarded). The requested
  // path must exactly match a currently-detected file — this endpoint never
  // serves arbitrary paths.
  router.get('/conversations/:id/files/content', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    void sessionFilesFor(row)
      .then((files) => {
        const file = files.find((f) => f.path === target);
        if (!file) {
          res.status(404).json({ ok: false, error: 'File not found in this chat' });
          return;
        }
        if (serveMarkdownImage(res, file.path, req.query.image)) return;
        if (req.query.download === '1' || req.query.inline === '1') {
          if (req.query.download === '1') {
            res.attachment(file.name);
          } else {
            const contentType = inlineContentType(file.path);
            if (contentType) res.setHeader('Content-Type', contentType);
            const csp = inlineContentSecurityPolicy(contentType);
            if (csp) res.setHeader('Content-Security-Policy', csp);
          }
          res.sendFile(file.path);
          return;
        }
        const fd = fs.openSync(file.path, 'r');
        let buf: Buffer;
        try {
          buf = Buffer.alloc(Math.min(file.size, SESSION_FILE_PREVIEW_BYTES));
          fs.readSync(fd, buf, 0, buf.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (buf.subarray(0, 8192).includes(0)) {
          res.json({ ok: true, file, binary: true });
          return;
        }
        res.json({ ok: true, file, content: buf.toString('utf8'), truncated: file.size > buf.length });
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.post('/conversations/:id/messages', (req, res) => {
    // A Team chat is collaborative: every active user who can view it may add
    // messages. Management actions still use the stricter creator/admin rule.
    const row = conversationFor(req, res);
    if (!row) return;
    if (!canSendToConversation(req.user!, row, ctx.db)) {
      res.status(404).json({ ok: false, error: 'Conversation not found' });
      return;
    }
    const body = MessageSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'text required' });
      return;
    }
    reactivateConversation(row.id);
    if (!row.title) {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(titleFrom(body.data.text), row.id);
    }
    void (async () => {
      const origin = agentMessageOrigin(req, row.id);
      const posted = body.data.queueOnly
        ? origin
          ? await manager.queueMessage(row.id, body.data.text, req.user!.id, origin)
          : await manager.queueMessage(row.id, body.data.text, req.user!.id)
        : origin
          ? await manager.postMessage(row.id, body.data.text, req.user!.id, origin)
          : await manager.postMessage(row.id, body.data.text, req.user!.id);
      res.json({ ...posted, status: await manager.statusOf(row.id) });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // Agent-owned continuation timers. These differ from scheduled tasks: a wake
  // always resumes THIS chat and never creates a new automation conversation.
  // Agent-token binding prevents one chat from scheduling another chat.
  router.post('/conversations/:id/wakeups', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    if (req.agentConversationId !== row.id) {
      res.status(403).json({ ok: false, error: 'Wake-ups can only be managed by the current agent chat.' });
      return;
    }
    const body = ScheduleWakeupSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: body.error.issues[0]?.message ?? 'Invalid wake-up request' });
      return;
    }
    let scheduledFor: Date;
    if (body.data.delaySeconds !== undefined) {
      scheduledFor = new Date(Date.now() + body.data.delaySeconds * 1000);
    } else {
      scheduledFor = new Date(body.data.runAt!);
      if (!Number.isFinite(scheduledFor.getTime())) {
        res.status(400).json({ ok: false, error: 'runAt must be a valid ISO 8601 timestamp.' });
        return;
      }
    }
    void manager
      .scheduleWakeup(row.id, req.user!.id, body.data.key, body.data.reason, scheduledFor.toISOString())
      .then((result) => {
        if (!result.ok) {
          const status = result.error === 'invalid_time' ? 400 : result.error === 'conversation_archived' ? 409 : 404;
          res.status(status).json(result);
          return;
        }
        res.status(201).json(result);
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.get('/conversations/:id/wakeups', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    if (req.agentConversationId && req.agentConversationId !== row.id) {
      res.status(403).json({ ok: false, error: 'Wake-ups can only be managed by the current agent chat.' });
      return;
    }
    void manager
      .listWakeups(row.id)
      .then((wakeups) => res.json({ ok: true, wakeups }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.delete('/conversations/:id/wakeups/:wakeupId', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    if (req.agentConversationId && req.agentConversationId !== row.id) {
      res.status(403).json({ ok: false, error: 'Wake-ups can only be managed by the current agent chat.' });
      return;
    }
    const wakeupId = WakeupIdSchema.safeParse(req.params.wakeupId);
    if (!wakeupId.success) {
      res.status(400).json({ ok: false, error: 'A valid wake-up id is required.' });
      return;
    }
    void manager
      .cancelWakeup(row.id, wakeupId.data)
      .then((result) => {
        if (!result.ok) {
          res.status(result.error === 'not_found' ? 404 : 409).json(result);
          return;
        }
        res.json(result);
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // Move a pending wake. Owner-usable so the chip can push a wake out or pull
  // it in without asking the agent to rewrite its own timer.
  router.patch('/conversations/:id/wakeups/:wakeupId', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    if (req.agentConversationId && req.agentConversationId !== row.id) {
      res.status(403).json({ ok: false, error: 'Wake-ups can only be managed by the current agent chat.' });
      return;
    }
    const wakeupId = WakeupIdSchema.safeParse(req.params.wakeupId);
    if (!wakeupId.success) {
      res.status(400).json({ ok: false, error: 'A valid wake-up id is required.' });
      return;
    }
    const body = RescheduleWakeupSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: body.error.issues[0]?.message ?? 'Invalid wake-up request' });
      return;
    }
    let scheduledFor: Date;
    if (body.data.delaySeconds !== undefined) {
      scheduledFor = new Date(Date.now() + body.data.delaySeconds * 1000);
    } else {
      scheduledFor = new Date(body.data.runAt!);
      if (!Number.isFinite(scheduledFor.getTime())) {
        res.status(400).json({ ok: false, error: 'runAt must be a valid ISO 8601 timestamp.' });
        return;
      }
    }
    void manager
      .rescheduleWakeup(row.id, wakeupId.data, scheduledFor.toISOString())
      .then((result) => {
        if (!result.ok) {
          const status = result.error === 'not_found' ? 404 : result.error === 'invalid_time' ? 400 : 409;
          res.status(status).json(result);
          return;
        }
        res.json(result);
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.post('/conversations/:id/wakeups/:wakeupId/fire', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    if (req.agentConversationId && req.agentConversationId !== row.id) {
      res.status(403).json({ ok: false, error: 'Wake-ups can only be managed by the current agent chat.' });
      return;
    }
    const wakeupId = WakeupIdSchema.safeParse(req.params.wakeupId);
    if (!wakeupId.success) {
      res.status(400).json({ ok: false, error: 'A valid wake-up id is required.' });
      return;
    }
    reactivateConversation(row.id);
    void manager
      .fireWakeup(row.id, wakeupId.data)
      .then((result) => {
        if (!result.ok) {
          const status = result.error === 'not_found' || result.error === 'conversation_not_found' ? 404 : 409;
          res.status(status).json(result);
          return;
        }
        res.json(result);
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // Agent-to-agent guidance is different from a human follow-up: persist it
  // first, then steer the active provider turn when possible. If steering
  // cannot be acknowledged, the runner keeps it in the ordinary durable queue.
  router.post('/conversations/:id/steer', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    // Asking another team bot for evidence is message authority, not authority
    // to manage that bot's configuration or lifecycle.
    if (!canSendToConversation(req.user!, row, db)) {
      res.status(404).json({ ok: false, error: 'Conversation not found' });
      return;
    }
    const body = MessageSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'text required' });
      return;
    }
    reactivateConversation(row.id);
    const origin = agentMessageOrigin(req, row.id);
    const posted = origin
      ? manager.steerMessage(row.id, body.data.text, req.user!.id, undefined, origin)
      : manager.steerMessage(row.id, body.data.text, req.user!.id);
    void posted
      .then(async (posted) => {
        if (origin && req.agentConversationId) {
          insertAgentMessageReceiptStmt.run(
            req.agentConversationId,
            row.id,
            posted.messageId,
            body.data.text,
            posted.disposition,
          );
        }
        res.json({ ...posted, status: await manager.statusOf(row.id) });
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.patch('/conversations/:id/queue/:messageId', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    const body = MessageSchema.safeParse(req.body);
    const messageId = Number(req.params.messageId);
    if (!body.success || !Number.isSafeInteger(messageId) || messageId <= 0) {
      res.status(400).json({ ok: false, error: 'valid message and text required' });
      return;
    }
    void manager
      .updateQueuedMessage(row.id, messageId, body.data.text, req.user!.id)
      .then((result) => res.json(result))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.delete('/conversations/:id/queue/:messageId', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      res.status(400).json({ ok: false, error: 'valid message id required' });
      return;
    }
    void manager
      .removeQueuedMessage(row.id, messageId)
      .then((result) => res.json(result))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.post('/conversations/:id/queue/:messageId/send-now', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      res.status(400).json({ ok: false, error: 'valid message id required' });
      return;
    }
    void manager
      .sendQueuedMessageNow(row.id, messageId)
      .then((result) => res.json(result))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.put('/conversations/:id/queue', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    const body = QueueReorderSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'valid messageIds required' });
      return;
    }
    void manager
      .reorderQueuedMessages(row.id, body.data.messageIds)
      .then((result) => res.json(result))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.post('/conversations/:id/failed-turn/retry', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    void manager
      .retryFailedTurn(row.id, req.user!.id)
      .then((result) => res.json(result))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.delete('/conversations/:id/failed-turn', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    void manager
      .discardFailedTurn(row.id)
      .then((result) => res.json(result))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // File attachment upload: raw bytes in the body (Content-Type octet-stream,
  // so the router's JSON parser above never touches it), filename in the
  // query. Stored under <dataDir>/uploads/<random>/<name>; the client then
  // references the returned absolute path in the message it sends, and agents
  // read the file straight from disk (pre-allowed in materialize.ts).
  router.post(
    '/uploads',
    express.raw({ type: 'application/octet-stream', limit: '100mb' }),
    (req, res) => {
      const rawName = typeof req.query.filename === 'string' ? req.query.filename : '';
      // basename + character allowlist: the name becomes part of a disk path.
      const name =
        path.basename(rawName).replace(/[^\w.\- ()]/g, '_').slice(0, 120).replace(/^\.+$/, '') || 'file';
      const data = req.body as unknown;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        res.status(400).json({ ok: false, error: 'Empty upload' });
        return;
      }
      const dir = path.join(ctx.config.dataDir, 'uploads', crypto.randomBytes(5).toString('hex'));
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, data);
      res.json({ ok: true, file: { path: filePath, name, size: data.length } });
    },
  );

  // Tool-result images (screenshots, Read on an image, …) captured by the
  // media store (runtime/media.ts). Ids are content hashes minted server-side,
  // so a valid id is proof the bytes came through this app; immutable caching
  // is safe for the same reason.
  router.get('/media/:id', (req, res) => {
    const file = mediaFilePath(String(req.params.id));
    if (!file || !fs.existsSync(file)) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(file);
  });

  router.post('/conversations/:id/interrupt', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    void manager
      .interrupt(row.id)
      .then((interrupted) => res.json({ ok: true, interrupted }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.post('/conversations/:id/compact', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    if (req.agentConversationId) {
      res.status(403).json({ ok: false, error: 'Context compaction is a user-only chat action.' });
      return;
    }
    if (row.archived) {
      res.status(409).json({ ok: false, error: 'Restore this chat before compacting its context.' });
      return;
    }
    void manager
      .compactConversation(row.id)
      .then((result) => {
        if (result.ok) {
          res.json(result);
          return;
        }
        const status = result.error === 'unsupported'
          ? 501
          : result.error === 'failed'
            ? 502
            : 409;
        res.status(status).json({ ok: false, code: result.error, error: result.message });
      })
      .catch(() => res.status(503).json({ ok: false, error: 'Context compaction is temporarily unavailable.' }));
  });

  // ── ask_user (agent side) ──────────────────────────────────────────────────
  // The agent's ask_user MCP tool posts a question here (agent-token auth), then
  // polls the GET below until the user answers. conversationFor authorizes it as
  // the chat's owner — the same rule as read_conversation/send_message. The
  // human answers via POST /questions/:id/resolve. Registering the question
  // pushes a question card to the UI and flips the chat to "needs you".
  router.post('/conversations/:id/ask', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    const body = AskQuestionSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'question and at least one option are required' });
      return;
    }
    // A bare async handler here lets a runner-restart rejection escape Express
    // and kill the whole web process; same for the other question routes.
    void (async () => {
      const options = body.data.options.map((o) => ({
        label: o.label,
        value: o.value ?? o.label,
        ...(o.description ? { description: o.description } : {}),
      }));
      const questionId = await manager.askQuestion(
        row.id,
        body.data.question,
        options,
        body.data.multi ?? false,
        body.data.allowOther ?? false,
      );
      res.json({ ok: true, questionId });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  // ── request_secret / reveal_secret (agent side) ──────────────────────
  // The agent names a credential it needs; the user types the value into a
  // masked card and POST /questions/:id/save-secret writes it straight to
  // Doppler. The value never reaches the agent, the transcript, the questions
  // table, an event, or a log — the agent only learns the name and location.
  // reveal_secret is the mirror image: the user is shown a value the agent
  // never receives.
  const secretAccess = (): SecretAccessDeps => ({
    db,
    projectDopplerCli: ctx.projectDopplerCli ?? null,
  });

  /** Where a named secret lives for this instance, plus a best-effort presence hint. */
  function resolveSecretTarget(
    name: string,
    requestedProject: string | undefined,
    requestedConfig: string | undefined,
  ): Promise<SecretTargetResolution> {
    return resolveSecretTargetFor(secretAccess(), name, requestedProject, requestedConfig);
  }

  router.post('/conversations/:id/request-secret', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    // Doppler secrets are workplace credentials: members are 403'd on every
    // Doppler route, and these two write to and read from the same vault.
    if (!requireDopplerAdmin(req, res)) return;
    const body = RequestSecretSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'name and purpose are required' });
      return;
    }
    let name: string;
    try {
      name = assertDopplerSecretName(body.data.name);
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
      return;
    }
    void (async () => {
      const target = await resolveSecretTarget(name, body.data.project, body.data.config);
      if (!target.ok) {
        res.status(target.status).json({ ok: false, error: target.error });
        return;
      }
      const { project, config } = target;
      const questionId = await manager.askQuestion(row.id, body.data.purpose, [], false, true, {
        name,
        project,
        config,
        ...(target.exists === undefined ? {} : { exists: target.exists }),
      });
      res.set('Cache-Control', 'no-store');
      // project/config are echoed back so the agent can name the destination it
      // actually got (client instances override whatever it asked for).
      res.json({ ok: true, questionId, name, project, config });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  // reveal_secret: show an existing Doppler secret to the user on their screen.
  // The value is fetched by a separate GET the *user's* browser makes; it never
  // touches this question, an event, or the agent's tool result.
  router.post('/conversations/:id/reveal-secret', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    // Doppler secrets are workplace credentials: members are 403'd on every
    // Doppler route, and these two write to and read from the same vault.
    if (!requireDopplerAdmin(req, res)) return;
    const body = RevealSecretSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    let name: string;
    try {
      name = assertDopplerSecretName(body.data.name);
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
      return;
    }
    void (async () => {
      const target = await resolveSecretTarget(name, body.data.project, body.data.config);
      if (!target.ok) {
        res.status(target.status).json({ ok: false, error: target.error });
        return;
      }
      const { project, config } = target;
      const questionId = await manager.askQuestion(
        row.id,
        `Show ${name} on your screen?`,
        [],
        false,
        true,
        { name, project, config, ...(target.exists === undefined ? {} : { exists: target.exists }) },
        'reveal',
      );
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, questionId, name, project, config });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  router.get('/conversations/:id/questions/:questionId', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    void (async () => {
      const q = await manager.getQuestion(String(req.params.questionId));
      if (!q || q.conversationId !== row.id) {
        res.status(404).json({ ok: false, error: 'Question not found' });
        return;
      }
      res.json({
        ok: true,
        pending: q.status === 'pending',
        expired: q.status === 'expired',
        dismissed: q.status === 'dismissed',
        answer: q.answer,
        answers: q.answers,
      });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  // Drag-reorder: renumber visible pinned chats 0..n-1. A concurrent unpin
  // stays unpinned, and Private chats remain creator-only.
  router.put('/conversations/pins', (req, res) => {
    const body = ReorderPinsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid pin order' });
      return;
    }
    const stmt = db.prepare(
      `UPDATE conversations SET pin_order = ?
       WHERE id = ? AND pin_order IS NOT NULL AND (visibility = 'team' OR user_id = ?) AND ${businessScopeSql(req.user!.id, 'conversations')}`,
    );
    db.transaction((ids: string[]) => {
      ids.forEach((id, i) => stmt.run(i, id, req.user!.id));
    })(body.data.ids);
    res.json({ ok: true });
  });

  // Per-user, view-only: anyone who can see the chat can flag it unread for
  // themselves. Reopening the chat (WS subscribe / GET) marks it seen again.
  router.post('/conversations/:id/unread', (req, res) => {
    const row = conversationFor(req, res);
    if (!row) return;
    // Lives here rather than conversations/unread.ts so a web-only ship
    // (no runner restart) can carry it.
    db.prepare(
      `INSERT INTO conversation_last_seen (user_id, conversation_id, unread)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id, conversation_id) DO UPDATE SET unread = 1`,
    ).run(req.user!.id, row.id);
    void conversationView(ctx, row, req.user!)
      .then((conversation) => res.json({ ok: true, conversation }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.post('/conversations/:id/model', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    if (req.agentConversationId) {
      res.status(403).json({ ok: false, error: 'Only a user can switch the chat provider.' });
      return;
    }
    if (row.archived) {
      res.status(409).json({ ok: false, error: 'Reopen this chat before switching models.' });
      return;
    }
    const parsed = z.object({
      provider: z.enum(['claude', 'codex', 'grok', 'openrouter']),
      model: z.string().trim().max(100).nullable(),
      effort: z.string().trim().max(40).nullable(),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid model selection' });
      return;
    }
    const prefs = readModelPrefs();
    const provider = parsed.data.provider;
    const model = parsed.data.model || prefs.providerDefaults[provider] || null;
    if ((provider === 'openrouter' && (!model || !prefs.openrouterModels.includes(model))) ||
        !canUserAccessModel(req.user!.email, provider, model)) {
      res.status(400).json({ ok: false, error: 'This model is not available' });
      return;
    }
    void manager.switchProvider(row.id, { provider, model, effort: parsed.data.effort || null })
      .then(async (result) => {
        if (!result.ok) {
          res.status(409).json({ ok: false, error: result.message });
          return;
        }
        const fresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(row.id) as ConversationRow;
        res.json({ ok: true, conversation: await conversationView(ctx, fresh, req.user!) });
      }).catch(() => res.status(503).json({ ok: false, error: 'Could not reach the runner. Refresh the chat before trying again.' }));
  });

  router.patch('/conversations/:id', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    const body = PatchConversationSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid patch' });
      return;
    }
    if (body.data.visibility !== undefined && !canChangeConversationVisibility(req.user!, row)) {
      res.status(403).json({ ok: false, error: 'Only the chat creator can change its visibility' });
      return;
    }
    if (body.data.approval_mode !== undefined) {
      const assistant = db.prepare('SELECT slug FROM assistants WHERE id = ?').get(row.assistant_id) as
        | { slug: string }
        | undefined;
      if (assistant?.slug === 'platform-dev') {
        res.status(400).json({ ok: false, error: 'Platform Dev approval mode cannot be changed' });
        return;
      }
    }
    const targetProjectId = body.data.projectId;
    const movingProject = targetProjectId !== undefined && targetProjectId !== (row.project_id ?? null);
    if (movingProject) {
      if (row.side_chat_of) {
        res.status(400).json({ ok: false, error: 'Side chats move with their parent chat' });
        return;
      }
      if (targetProjectId && !db.prepare('SELECT id FROM projects WHERE id = ?').get(targetProjectId)) {
        res.status(404).json({ ok: false, error: 'Project not found' });
        return;
      }
    }
    void (async () => {
      if (movingProject) {
        const status = await manager.statusOf(row.id);
        if (status === 'working' || status === 'needs_you') {
          res.status(409).json({ ok: false, error: 'Wait for the current reply to finish before moving this chat' });
          return;
        }
      }
      if (body.data.title !== undefined) {
        db.prepare('UPDATE conversations SET title = ?, title_auto = 0 WHERE id = ?').run(body.data.title, row.id);
      }
      if (body.data.visibility !== undefined && body.data.visibility !== row.visibility) {
        db.prepare('UPDATE conversations SET visibility = ? WHERE id = ?').run(body.data.visibility, row.id);
        // Re-check every live browser subscriber now. A teammate who already had
        // the Team chat open must stop receiving events as soon as it is Private.
        manager.bus?.emit('access', row.id);
      }
      if (body.data.archived !== undefined) {
        if (body.data.archived) {
          db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(row.id);
        } else {
          db.prepare(
            "UPDATE conversations SET archived = 0, last_user_activity_at = datetime('now') WHERE id = ?",
          ).run(row.id);
        }
        // Archiving means "done with this" — stop any agent still working in it (same as delete does).
        // Provider-agnostic: interrupt() → entry.kill() stops Claude, OpenRouter, or Codex, and is a
        // safe no-op if the conversation is idle. Unarchiving does not touch the runner.
        if (body.data.archived) {
          void manager.interrupt(row.id);
        }
        // Archiving also unpins — the archived view has no pinned section, and a
        // restored chat shouldn't jump back to the top of the list unasked.
        if (body.data.archived) db.prepare('UPDATE conversations SET pin_order = NULL WHERE id = ?').run(row.id);
        // A scratch-pad todo fired off into this chat rides along: archiving the
        // chat marks its todo 'done', restoring the chat reopens it to 'active'.
        // Only touches todos whose state matches, so a manually-moved todo isn't
        // yanked back by a later archive/unarchive.
        if (body.data.archived) {
          db.prepare(
            `UPDATE todos SET state = 'done', updated_at = datetime('now')
             WHERE conversation_id = ? AND state = 'active'`,
          ).run(row.id);
        } else {
          db.prepare(
            `UPDATE todos SET state = 'active', updated_at = datetime('now')
             WHERE conversation_id = ? AND state = 'done'`,
          ).run(row.id);
        }
      }
      if (body.data.pinned !== undefined) {
        if (body.data.pinned) {
          // New pins land on top: MIN-1 across all pins. (Global, not per-user:
          // each user only sees their own rows interleaved, so relative order holds.)
          db.prepare(
            `UPDATE conversations
             SET pin_order = COALESCE((SELECT MIN(pin_order) FROM conversations), 1) - 1
             WHERE id = ?`,
          ).run(row.id);
        } else {
          db.prepare('UPDATE conversations SET pin_order = NULL WHERE id = ?').run(row.id);
        }
      }
      if (body.data.model !== undefined) {
        if (row.provider === 'openrouter' && !readModelPrefs().openrouterModels.includes(body.data.model)) {
          res.status(400).json({ ok: false, error: 'Choose a configured OpenRouter model' });
          return;
        }
        if (!canUserAccessModel(req.user!.email, row.provider, body.data.model)) {
          res.status(400).json({ ok: false, error: 'This model is not available' });
          return;
        }
        db.prepare('UPDATE conversations SET model = ? WHERE id = ?').run(body.data.model, row.id);
      }
      if (body.data.effort !== undefined) {
        db.prepare('UPDATE conversations SET effort = ? WHERE id = ?').run(body.data.effort, row.id);
      }
      if (body.data.approval_mode !== undefined) {
        db.prepare('UPDATE conversations SET approval_mode = ? WHERE id = ?').run(body.data.approval_mode, row.id);
      }
      if (body.data.archived || movingProject) {
        await (manager.veneerBrowserConversationStop?.(req.user!.id, row.id) ?? Promise.resolve(null)).catch(() => null);
      }
      if (movingProject) moveConversationToProject(db, row.id, targetProjectId ?? null);
      const fresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(row.id) as ConversationRow;
      const conversation = await conversationView(ctx, fresh, req.user!);
      res.json({ ok: true, conversation });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.delete('/conversations/:id', (req, res) => {
    const row = conversationFor(req, res, true);
    if (!row) return;
    void (async () => {
      await manager.interrupt(row.id);
      await manager.veneerBrowserConversationStop?.(req.user!.id, row.id)?.catch(() => {});
      db.prepare('DELETE FROM conversations WHERE id = ?').run(row.id);
      res.json({ ok: true });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Approvals (spec §9): visible to all Team collaborators or the Private-chat creator.
  function approvalView(row: ApprovalRow, conversation?: ConversationRow): Record<string, unknown> {
    let input: unknown = null;
    try {
      input = JSON.parse(row.request_json);
    } catch {
      /* stored by us, but stay lenient */
    }
    const autoApproved = row.status === 'approved' && row.resolved_by === null;
    const statusLabel = autoApproved
      ? 'Auto-approved'
      : row.status === 'approved'
        ? 'Approved'
        : row.status === 'denied'
          ? 'Denied'
          : row.status === 'expired'
            ? 'Timed out — automatically declined'
            : 'Approval needed';
    return {
      id: row.id,
      conversationId: row.conversation_id,
      conversationTitle: conversation?.title ?? null,
      toolName: row.tool_name,
      displayName: displayNameForTool(row.tool_name),
      inputPreview: previewOf(input ?? {}),
      status: row.status,
      statusLabel,
      autoApproved,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  router.get('/approvals', (req, res) => {
    const status = req.query.status === undefined ? 'pending' : String(req.query.status);
    if (!['pending', 'approved', 'denied', 'expired'].includes(status)) {
      res.status(400).json({ ok: false, error: 'Invalid status' });
      return;
    }
    const rows = db
      .prepare(
        `SELECT a.* FROM approvals a JOIN conversations c ON c.id = a.conversation_id
         WHERE a.status = ? AND (c.visibility = 'team' OR c.user_id = ?) AND ${businessScopeSql(req.user!.id)} AND ${businessAgentSql(db, req.agentConversationId)}
         ORDER BY a.created_at DESC`,
      )
      .all(status, req.user!.id) as ApprovalRow[];
    const convById = new Map<string, ConversationRow>();
    for (const row of rows) {
      if (!convById.has(row.conversation_id)) {
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(row.conversation_id) as
          | ConversationRow
          | undefined;
        if (conv) convById.set(row.conversation_id, conv);
      }
    }
    res.json({ ok: true, approvals: rows.map((r) => approvalView(r, convById.get(r.conversation_id))) });
  });

  router.post('/approvals/:id/resolve', (req, res) => {
    const body = ResolveApprovalSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'outcome must be approved or denied' });
      return;
    }
    const approvalId = Number(req.params.id);
    const row = Number.isInteger(approvalId)
      ? (db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined)
      : undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: 'Approval not found' });
      return;
    }
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(row.conversation_id) as
      | ConversationRow
      | undefined;
    if (!conv || !canManageConversation(req.user!, conv, ctx.db)) {
      res.status(404).json({ ok: false, error: 'Approval not found' });
      return;
    }
    void (async () => {
      const result = await manager.resolveApproval(row.id, body.data.outcome, req.user!.id);
      if (!result.ok) {
        const msg =
          result.error === 'expired'
            ? 'This request expired before it could be resolved.'
            : 'This request was already resolved.';
        res.status(409).json({ ok: false, error: msg });
        return;
      }
      const fresh = db.prepare('SELECT * FROM approvals WHERE id = ?').get(row.id) as ApprovalRow;
      res.json({ ok: true, approval: approvalView(fresh, conv), status: await manager.statusOf(conv.id) });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // The user answers an ask_user question. Global by requestId (like approvals);
  // authorization mirrors the approval-resolve route via the question's chat.
  router.post('/questions/:requestId/resolve', (req, res) => {
    const body = ResolveQuestionSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'answer required' });
      return;
    }
    void (async () => {
      const requestId = String(req.params.requestId);
      const q = await manager.getQuestion(requestId);
      if (!q) {
        res.status(404).json({ ok: false, error: 'Question not found' });
        return;
      }
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(q.conversationId) as
        | ConversationRow
        | undefined;
      if (!conv || !canManageConversation(req.user!, conv, ctx.db)) {
        res.status(404).json({ ok: false, error: 'Question not found' });
        return;
      }
      const result = await manager.resolveQuestion(
        requestId,
        'answers' in body.data ? body.data.answers : body.data.answer,
      );
      if (!result.ok) {
        const error = result.error === 'invalid'
          ? 'Choose a valid answer for every question.'
          : result.error === 'expired'
            ? 'This question expired before the provider received your answer.'
            : 'This question was already answered.';
        res.status(result.error === 'invalid' ? 400 : 409).json({ ok: false, error });
        return;
      }
      res.json({ ok: true, status: await manager.statusOf(conv.id) });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  // The user saves a secret a request_secret card asked for. Same authorization
  // as /questions/:id/resolve. The value is written to Doppler here and then
  // dropped: only the literal answer 'saved' is recorded on the question.
  router.post('/questions/:requestId/save-secret', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = SaveSecretSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'A secret value of 65,536 characters or less is required.' });
      return;
    }
    // Defensive: a pasted value usually carries one trailing newline the CLI
    // would otherwise store verbatim.
    const value = body.data.value.replace(/\n$/, '');
    if (!value) {
      res.status(400).json({ ok: false, error: 'A secret value is required.' });
      return;
    }
    void (async () => {
      const requestId = String(req.params.requestId);
      const q = await manager.getQuestion(requestId);
      if (!q) {
        res.status(404).json({ ok: false, error: 'Question not found' });
        return;
      }
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(q.conversationId) as
        | ConversationRow
        | undefined;
      if (!conv || !canManageConversation(req.user!, conv, ctx.db)) {
        res.status(404).json({ ok: false, error: 'Question not found' });
        return;
      }
      // Doppler secrets are workplace credentials; members are 403'd on every
      // other Doppler route and must not reach the vault through a chat card.
      if (!requireDopplerAdmin(req, res)) return;
      const target = q.kind === 'secret' ? q.secret : undefined;
      if (!target) {
        res.status(409).json({ ok: false, error: 'This question does not accept a secret.' });
        return;
      }
      if (q.status !== 'pending') {
        res.status(409).json({ ok: false, error: 'This request was already resolved.' });
        return;
      }
      const cli = ctx.projectDopplerCli;
      if (!cli || !target.project || !target.config) {
        res.status(409).json({
          ok: false,
          error: cli
            ? 'This request has no Doppler project and config to write to.'
            : 'Doppler CLI is not available on this instance.',
        });
        return;
      }
      try {
        const result = await runProjectDopplerCli(
          path.join(cli.binDir, 'doppler'),
          ['secrets', 'set', target.name, '--project', target.project, '--config', target.config, '--silent'],
          os.tmpdir(),
          process.env,
          dopplerSecretStdin(value),
        );
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || `The Doppler CLI exited with code ${result.code}.`);
        }
      } catch (error) {
        // Stays pending so the user can retry; the value can never ride along.
        res.status(400).json({ ok: false, error: withoutSecretValue(redactDopplerError(error), value) });
        return;
      }
      const result = await manager.resolveQuestion(requestId, { q1: ['saved'] });
      if (!result.ok) {
        res.status(409).json({ ok: false, error: 'This request was already resolved.' });
        return;
      }
      res.json({ ok: true, status: await manager.statusOf(conv.id) });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  // ── reveal_secret (user side) ──────────────────────────────────────────────
  // Only the user who owns the chat can pull the value, and it is returned to
  // their browser alone: never to the agent, an event, the questions table, or
  // a log line. A 'shown' question may be fetched again so a reloaded card can
  // re-reveal; a dismissed one cannot.
  async function revealQuestionFor(
    req: express.Request,
    res: express.Response,
  ): Promise<
    | { requestId: string; conv: ConversationRow; target: QuestionSecretTarget; status: string; answer: string }
    | null
  > {
    const requestId = String(req.params.requestId);
    const q = await manager.getQuestion(requestId);
    if (!q) {
      res.status(404).json({ ok: false, error: 'Question not found' });
      return null;
    }
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(q.conversationId) as
      | ConversationRow
      | undefined;
    if (!conv || !canManageConversation(req.user!, conv, ctx.db)) {
      res.status(404).json({ ok: false, error: 'Question not found' });
      return null;
    }
    const target = q.kind === 'reveal' ? q.secret : undefined;
    if (!target) {
      res.status(409).json({ ok: false, error: 'This question is not a secret reveal.' });
      return null;
    }
    return { requestId, conv, target, status: q.status, answer: q.answer };
  }

  router.get('/questions/:requestId/reveal-secret-value', (req, res) => {
    res.set('Cache-Control', 'no-store');
    void (async () => {
      const found = await revealQuestionFor(req, res);
      if (!found) return;
      // Doppler secrets are workplace credentials; members are 403'd on every
      // other Doppler route and must not reach the vault through a chat card.
      if (!requireDopplerAdmin(req, res)) return;
      const { requestId, conv, target, status, answer } = found;
      // A shown request may be fetched again (a reloaded card holds no value);
      // a dismissed or expired one is closed for good.
      if (status !== 'pending' && !(status === 'answered' && answer === 'shown')) {
        res.status(409).json({ ok: false, error: 'This request was already resolved.' });
        return;
      }
      const cli = ctx.projectDopplerCli;
      if (!cli || !target.project || !target.config) {
        res.status(409).json({
          ok: false,
          error: cli
            ? 'This request has no Doppler project and config to read from.'
            : 'Doppler CLI is not available on this instance.',
        });
        return;
      }
      let value: string | null = null;
      try {
        const result = await runProjectDopplerCli(
          path.join(cli.binDir, 'doppler'),
          ['secrets', 'get', target.name, '--project', target.project, '--config', target.config, '--plain'],
          os.tmpdir(),
        );
        // A missing secret is an ordinary CLI failure, not a server error.
        value = result.code !== 0 ? null : result.stdout.replace(/\n$/, '');
      } catch (error) {
        res.status(400).json({ ok: false, error: redactDopplerError(error) });
        return;
      }
      if (value === null || value === '') {
        res.status(404).json({
          ok: false,
          error: `${target.name} was not found in ${[target.project, target.config].filter(Boolean).join(' / ') || 'the connected Doppler config'}.`,
        });
        return;
      }
      // Audit only — never the value.
      console.info(
        `[reveal-secret] user=${req.user!.id} secret=${target.name} ` +
          `target=${[target.project, target.config].filter(Boolean).join('/') || 'connected'} conversation=${conv.id}`,
      );
      // Unblocks the agent's turn on the first successful reveal; a later
      // re-reveal after a reload finds the question already answered.
      if (status === 'pending') await manager.resolveQuestion(requestId, { q1: ['shown'] });
      res.json({ ok: true, value });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  router.post('/questions/:requestId/dismiss-reveal', (req, res) => {
    res.set('Cache-Control', 'no-store');
    void (async () => {
      const found = await revealQuestionFor(req, res);
      if (!found) return;
      if (found.status !== 'pending') {
        res.status(409).json({ ok: false, error: 'This request was already resolved.' });
        return;
      }
      const result = await manager.resolveQuestion(found.requestId, { q1: ['dismissed'] });
      if (!result.ok) {
        res.status(409).json({ ok: false, error: 'This request was already resolved.' });
        return;
      }
      res.json({ ok: true, status: await manager.statusOf(found.conv.id) });
    })().catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  // ── Admin: Claude account connect/logout (owner + consultant only) ──────────
  const admin = express.Router();
  admin.use((req, res, next) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    next();
  });

  // Restart the service to unstick it (owner/consultant only). Respond first,
  // then exit cleanly; systemd (Restart=always) brings it back and the client
  // reconnects. A mid-turn restart kills the running turn — that's the point.
  admin.post('/restart', (_req, res) => {
    if (!ctx.requestRestart) {
      res.status(503).json({ ok: false, error: 'Restart is not available' });
      return;
    }
    res.status(202).json({ ok: true, restarting: true });
    ctx.requestRestart();
  });

  admin.get('/provider-versions', (_req, res) => {
    if (providerVersionsCache && Date.now() - providerVersionsCache.at < 5 * 60_000) {
      res.json({ ok: true, versions: providerVersionsCache.versions });
      return;
    }
    void readProviderRuntimeVersions({
      claudeBin: ctx.config?.claudeBin,
      codexBin: ctx.config?.codexBin,
      grokBin: ctx.config?.grokBin,
    })
      .then((versions) => {
        // Do not cache an unavailable binary: installing it should be visible
        // on the next refresh instead of waiting for the success-cache TTL.
        providerVersionsCache = Object.values(versions).every((entry) => entry.version !== null)
          ? { at: Date.now(), versions }
          : null;
        res.json({ ok: true, versions });
      })
      .catch(() => res.json({
        ok: true,
        versions: {
          claude: { runtime: 'Claude Code', version: null, supportsConciseOutputStyle: false },
          openrouter: { runtime: 'Claude Code harness', version: null, supportsConciseOutputStyle: false },
          codex: { runtime: 'Codex CLI', version: null, supportsConciseOutputStyle: false },
          grok: { runtime: 'Grok CLI', version: null, supportsConciseOutputStyle: false },
        } satisfies ProviderRuntimeVersions,
      }));
  });

  admin.get('/claude/status', (_req, res) => {
    const s = ctx.secrets.status();
    // NEVER return a token — not even masked. `accounts` carries labels and
    // which one is active; several subscriptions can be connected at once.
    res.json({
      ok: true,
      connected: s.connected,
      connectedAt: s.connectedAt,
      source: s.source,
      accounts: ctx.secrets.listClaudeAccounts(),
    });
  });

  // Switch which connected account turns run on. The claude adapter reads the
  // active token per turn, so this lands on the next message — no restart, and
  // a turn already in flight finishes on the account it started with.
  admin.post('/claude/accounts/:id/activate', (req, res) => {
    if (!ctx.secrets.setActiveClaudeAccount(req.params.id)) {
      res.status(404).json({ ok: false, error: 'That Claude account is not connected.' });
      return;
    }
    res.json({ ok: true, accounts: ctx.secrets.listClaudeAccounts() });
  });

  // Spend Claude's provider-controlled once-weekly session reset on exactly
  // the named account. The runner rechecks live eligibility immediately before
  // claiming; neither this route nor the runner changes the active account.
  admin.post('/claude/accounts/:id/limit-reset', (req, res) => {
    if (!ctx.secrets.getClaudeTokenFor(req.params.id)) {
      res.status(404).json({ ok: false, error: 'That Claude account is not connected.' });
      return;
    }
    void ctx.manager
      .claudeLimitReset(req.params.id)
      .then((result) => res.json({ ok: true, ...result }))
      .catch(() => res.status(502).json({
        ok: false,
        error: 'Claude could not check or reset this account right now.',
      }));
  });

  admin.patch('/claude/accounts/:id', (req, res) => {
    const body = ClaudeAccountLabelSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'A name is required.' });
      return;
    }
    if (!ctx.secrets.renameClaudeAccount(req.params.id, body.data.label)) {
      res.status(404).json({ ok: false, error: 'That Claude account is not connected.' });
      return;
    }
    res.json({ ok: true, accounts: ctx.secrets.listClaudeAccounts() });
  });

  admin.delete('/claude/accounts/:id', (req, res) => {
    if (!ctx.secrets.removeClaudeAccount(req.params.id)) {
      res.status(404).json({ ok: false, error: 'That Claude account is not connected.' });
      return;
    }
    const accounts = ctx.secrets.listClaudeAccounts();
    res.json({ ok: true, accounts, connected: accounts.length > 0 });
  });

  admin.get('/claude/preferences', (_req, res) => {
    res.json({ ok: true, preferences: readClaudePreferences(db) });
  });

  admin.put('/claude/preferences', (req, res) => {
    const body = ClaudePreferencesSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Choose a supported Claude Code output style.' });
      return;
    }
    if (body.data.outputStyle === 'Concise') {
      void probeProviderVersion(ctx.config?.claudeBin)
        .catch(() => null)
        .then((version) => {
          if (!supportsConciseOutputStyle(version)) {
            res.status(409).json({
              ok: false,
              error: `Concise requires Claude Code ${MIN_CONCISE_OUTPUT_STYLE_VERSION} or newer.`,
            });
            return;
          }
          res.json({ ok: true, preferences: writeClaudePreferences(db, body.data) });
        });
      return;
    }
    res.json({ ok: true, preferences: writeClaudePreferences(db, body.data) });
  });

  admin.post('/claude/connect/start', (_req, res) => {
    void ctx.claudeConnect
      .start()
      .then((r) => res.json({ ok: true, ...r }))
      .catch((err: Error) => res.status(502).json({ ok: false, error: err.message }));
  });

  admin.post('/claude/connect/complete', (req, res) => {
    const body = CompleteSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'attemptId and code are required' });
      return;
    }
    void ctx.claudeConnect
      .complete(body.data.attemptId, body.data.code)
      .then((r) => res.json({
        ok: true,
        connected: true,
        probe: r.probe,
        account: r.account,
        accounts: ctx.secrets.listClaudeAccounts(),
      }))
      .catch((err: Error) => res.status(400).json({ ok: false, error: err.message }));
  });

  admin.post('/claude/connect/cancel', (req, res) => {
    const body = AttemptIdSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'attemptId required' });
      return;
    }
    const r = ctx.claudeConnect.cancel(body.data.attemptId);
    res.json({ ok: true, cancelled: r.cancelled });
  });

  admin.post('/claude/disconnect', (_req, res) => {
    // Remove the in-app token only; never touch the env file.
    ctx.secrets.clearClaudeToken();
    res.json({ ok: true, connected: false });
  });

  admin.post('/claude/test', (_req, res) => {
    void ctx.claudeConnect
      .test()
      .then((r) => res.json({ ok: true, result: r }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  admin.post('/openrouter/test', (_req, res) => {
    void (async () => {
      const apiKey = effectiveApiKey('openrouter', ctx.secrets, ctx.config, ctx.doppler).value;
      if (!apiKey) {
        res.json({ ok: true, result: { ok: false, detail: 'No OpenRouter API key is configured.' } });
        return;
      }
      const keyRes = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!keyRes.ok) {
        res.json({ ok: true, result: { ok: false, detail: `OpenRouter rejected the key (${keyRes.status}).` } });
        return;
      }
      const configured = readModelPrefs().openrouterModels;
      const catalogRes = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!catalogRes.ok) {
        res.json({ ok: true, result: { ok: false, detail: `Could not validate the model catalog (${catalogRes.status}).` } });
        return;
      }
      const catalog = (await catalogRes.json()) as { data?: { id?: string }[] };
      const available = new Set((catalog.data ?? []).map((model) => model.id).filter(Boolean));
      const missing = configured.filter((id) => !available.has(id));
      if (missing.length) {
        res.json({
          ok: true,
          result: { ok: false, detail: `Unknown or unavailable model${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}` },
        });
        return;
      }
      res.json({
        ok: true,
        result: {
          ok: true,
          detail: `Connection works. ${configured.length} configured model${configured.length === 1 ? '' : 's'} ready.`,
        },
      });
    })().catch((err: Error) =>
      res.json({ ok: true, result: { ok: false, detail: `OpenRouter test failed: ${err.message}` } }),
    );
  });

  // ── Admin: Codex accounts connect/switch/logout (owner + consultant only) ──
  // Codex owns `$CODEX_HOME/auth.json`, so there is no token to store or
  // inject: each connected account is its own CODEX_HOME (codex/accounts.ts),
  // and these routes drive `codex login --device-auth` into a staging home,
  // then adopt the credential into the registry.
  function codexAccountsPayload(): { accounts: CodexAccountSummary[]; connected: boolean } {
    const accounts = ctx.codexAccounts.list();
    return { accounts, connected: accounts.some((account) => account.active && account.connected) };
  }

  admin.get('/codex/status', (_req, res) => {
    // Re-sync identity from each home (Codex refreshes id_tokens itself) and
    // pick up a login placed in the primary profile by hand.
    adoptCodexLogins(ctx.codexAccounts);
    const active = ctx.codexAccounts.active();
    const statusFor = active
      ? codexLoginStatus(ctx.config.codexBin, undefined, undefined, ctx.codexAccounts.homeFor(active.id))
      : ctx.codexConnect.status();
    void statusFor
      .then((s) => {
        const { accounts } = codexAccountsPayload();
        res.json({
          ok: true,
          connected: s.connected,
          method: s.method,
          installed: s.installed,
          account: s.account ?? (active ? { email: active.email, plan: active.planType } : null),
          accounts,
        });
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  let codexInstallInFlight: Promise<CodexInstallResult> | null = null;
  admin.post('/codex/install', (_req, res) => {
    if (!codexInstallInFlight) {
      codexInstallInFlight = installCodex().finally(() => {
        codexInstallInFlight = null;
      });
    }
    void codexInstallInFlight
      .then((r) => res.json({ ok: r.ok, detail: r.detail }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // Adding an account never touches a connected one: the sign-in lands in a
  // throwaway staging home, so `force` is accepted for older clients and ignored.
  admin.post('/codex/connect/start', (_req, res) => {
    const stagingHome = ensureCodexAccountHome(codexStagingHome(crypto.randomUUID()));
    void ctx.codexConnect
      .start({ codexHome: stagingHome })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((err: Error) => res.status(502).json({ ok: false, error: err.message }));
  });

  admin.post('/codex/connect/poll', (req, res) => {
    const body = AttemptIdSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'attemptId required' });
      return;
    }
    void ctx.codexConnect
      .poll(body.data.attemptId)
      .then((r) => res.json({ ok: true, ...r, ...(r.state === 'success' ? codexAccountsPayload() : {}) }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  admin.post('/codex/connect/cancel', (req, res) => {
    const body = AttemptIdSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'attemptId required' });
      return;
    }
    const r = ctx.codexConnect.cancel(body.data.attemptId);
    res.json({ ok: true, cancelled: r.cancelled });
  });

  // Switch which connected account new turns run on. Lands on the next
  // message: a turn already running finishes on the app-server it started on.
  admin.post('/codex/accounts/:id/activate', (req, res) => {
    if (!ctx.codexAccounts.setActive(String(req.params.id))) {
      res.status(404).json({ ok: false, error: 'That Codex account is not connected.' });
      return;
    }
    res.json({ ok: true, ...codexAccountsPayload() });
  });

  admin.patch('/codex/accounts/:id', (req, res) => {
    const body = ClaudeAccountLabelSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'label required' });
      return;
    }
    if (!ctx.codexAccounts.rename(String(req.params.id), body.data.label)) {
      res.status(404).json({ ok: false, error: 'That Codex account is not connected.' });
      return;
    }
    res.json({ ok: true, ...codexAccountsPayload() });
  });

  admin.delete('/codex/accounts/:id', (req, res) => {
    const id = String(req.params.id);
    if (!ctx.codexAccounts.list().some((account) => account.id === id)) {
      res.status(404).json({ ok: false, error: 'That Codex account is not connected.' });
      return;
    }
    // `codex logout` first so the CLI drops any keychain/cache state of its
    // own; the home (or, for the primary profile, just its credential) goes after.
    void codexLogout(ctx.config.codexBin, undefined, ctx.codexAccounts.homeFor(id))
      .catch(() => undefined)
      .then(() => {
        removeCodexAccountFiles(ctx.codexAccounts, id);
        ctx.codexAccounts.remove(id);
        res.json({ ok: true, ...codexAccountsPayload() });
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  /** Disconnect every account (the card's "Disconnect all"). */
  admin.post('/codex/disconnect', (_req, res) => {
    void (async () => {
      for (const account of ctx.codexAccounts.list()) {
        await codexLogout(ctx.config.codexBin, undefined, ctx.codexAccounts.homeFor(account.id)).catch(() => undefined);
        removeCodexAccountFiles(ctx.codexAccounts, account.id);
      }
      ctx.codexAccounts.clear();
      res.json({ ok: true, connected: false, accounts: [], detail: 'Logged out of Codex.' });
    })().catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Admin: Grok account connect/logout (owner + consultant only) ───────────
  // Same shape as the Codex routes above — Grok owns $GROK_HOME/auth.json, so
  // these just drive `grok login --device-auth` and report state. Unlike Codex,
  // starting a sign-in does NOT wipe the existing login, so the 409 below is a
  // plain "already signed in" check rather than a destructive-action guard.
  admin.get('/grok/status', (_req, res) => {
    void ctx.grokConnect
      .status()
      .then((s) => res.json({ ok: true, connected: s.connected, method: s.method, installed: s.installed, account: s.account ?? null }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  let grokInstallInFlight: Promise<GrokInstallResult> | null = null;
  admin.post('/grok/install', (_req, res) => {
    if (!grokInstallInFlight) {
      grokInstallInFlight = installGrok().finally(() => {
        grokInstallInFlight = null;
      });
    }
    void grokInstallInFlight
      .then((r) => res.json({ ok: r.ok, detail: r.detail }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  admin.post('/grok/connect/start', (req, res) => {
    const force = req.body?.force === true;
    const proceed = force
      ? Promise.resolve<{ connected: boolean; method: 'xai' | 'apikey' | null } | null>(null)
      : ctx.grokConnect.status();
    void proceed
      .then((s) => {
        if (s && s.connected) {
          res.status(409).json({
            ok: false,
            code: 'already_connected',
            error: 'Grok is already signed in. Starting a new sign-in will replace it.',
            method: s.method,
          });
          return undefined;
        }
        return ctx.grokConnect.start().then((r) => res.json({ ok: true, ...r }));
      })
      .catch((err: Error) => res.status(502).json({ ok: false, error: err.message }));
  });

  admin.post('/grok/connect/poll', (req, res) => {
    const body = AttemptIdSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'attemptId required' });
      return;
    }
    void ctx.grokConnect
      .poll(body.data.attemptId)
      .then((r) => res.json({ ok: true, ...r }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  admin.post('/grok/connect/cancel', (req, res) => {
    const body = AttemptIdSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'attemptId required' });
      return;
    }
    const r = ctx.grokConnect.cancel(body.data.attemptId);
    res.json({ ok: true, cancelled: r.cancelled });
  });

  admin.post('/grok/disconnect', (_req, res) => {
    void grokLogout(ctx.config.grokBin)
      .then((r) => res.json({ ok: r.ok, connected: false, detail: r.detail }))
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  // ── Admin: user management (owner + consultant only) ────────────────────────
  const shapeUser = (u: UserRow) => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    employeeWorkspace: isEmployee(db, u.id),
    allowedBotIds: (db.prepare('SELECT conversation_id FROM employee_bot_access WHERE user_id=?').all(u.id) as { conversation_id: string }[]).map(row => row.conversation_id),
  });

  admin.post('/users', (req, res) => {
    const body = z.object({ email: z.string().trim().email(), displayName: z.string().trim().min(1).max(80) }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Name and work email required' }); return; }
    const email = body.data.email.toLowerCase();
    db.prepare("INSERT INTO users(email,display_name,role,status) VALUES(?,?,'member','pending') ON CONFLICT(email) DO NOTHING").run(email, body.data.displayName);
    res.json({ user: shapeUser(findUserByEmail(db, email)!) });
  });

  admin.get('/users', (_req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
    res.json({ ok: true, users: rows.map(shapeUser) });
  });

  admin.patch('/users/:id', (req, res) => {
    const body = AdminUserPatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'At least one of role, status, displayName required' });
      return;
    }
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as UserRow | undefined;
    if (!target) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }
    if (body.data.role === 'owner' && isEmployee(db, target.id)) {
      res.status(409).json({ error: 'Restricted employee accounts cannot be made administrators.' }); return;
    }
    if (target.id === req.user!.id) {
      res.status(403).json({ ok: false, error: 'You cannot modify your own account' });
      return;
    }
    // If this change demotes or de-activates the target, make sure it isn't the
    // last active admin (owner + active). Count active owners other than the target.
    const demotes = body.data.role !== undefined && body.data.role !== 'owner';
    const deactivates = body.data.status !== undefined && body.data.status !== 'active';
    if ((demotes || deactivates) && target.role === 'owner' && target.status === 'active') {
      const others = (
        db
          .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active' AND id != ?")
          .get(target.id) as { n: number }
      ).n;
      if (others === 0) {
        res.status(409).json({ ok: false, error: 'Cannot remove the last active admin' });
        return;
      }
    }
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (body.data.role !== undefined) {
      sets.push('role = ?');
      vals.push(body.data.role);
    }
    if (body.data.status !== undefined) {
      sets.push('status = ?');
      vals.push(body.data.status);
    }
    if (body.data.displayName !== undefined) {
      sets.push('display_name = ?');
      vals.push(body.data.displayName);
    }
    vals.push(target.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    for (const c of db.prepare('SELECT id FROM conversations').all() as { id: string }[]) manager.bus?.emit('access', c.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id) as UserRow;
    res.json({ ok: true, user: shapeUser(updated) });
  });

  router.use('/admin', admin);

  // Toolbox: MCP connections + policies (spec §11). Own authz inside
  // (members denied; owner scoped to managed_by='owner'; consultant full).
  router.use('/connections', createConnectionsRouter(ctx));

  // Connectors (Settings → Connectors): catalog + per-user installs (Gmail via Composio
  // etc.). Open to every signed-in user — rows are scoped to req.user inside.
  router.use('/connectors/gmail', createGmailDraftsRouter(ctx));
  router.use('/connectors', createConnectorsRouter(ctx));

  // File Manager: browse/edit files under named roots. Own authz inside
  // (members denied at the router level).
  router.use('/files', createFilesRouter(ctx));

  // Files page: the durable registry of agent-generated deliverables (migration
  // 0014). Member-scoped inside the router; a foreign id is a 404.
  router.use('/generated-files', createGeneratedFilesRouter(ctx));

  // Skills Manager: cross-provider skills on disk. Reads open to known users;
  // writes inline-deny members inside the router.
  router.use('/skills', createSkillsRouter(ctx));

  // Todos: lightweight scratch-pad with user-defined category columns;
  // 'active' todos carry the conversation fired off from them.
  // Reads open to known users; writes deny members inside the router.
  router.use('/todos', createTodosRouter(ctx));

  // Automations: a persistent user-owned schedule with fresh execution chats
  // nested beneath it as run history.
  router.use('/scheduled-tasks', createScheduledTasksRouter(ctx));

  // One durable FIFO for Platform Dev chats sharing the live source checkout.
  router.use('/build-queue', createBuildQueueRouter(ctx));

  // Pages: standalone public HTML pages agents publish to Cloudflare R2. Reads
  // open to known users; writes are agent-driven (publish_page) — no member gate.
  router.use('/pages', createPagesRouter(ctx));

  // Apps: private, short-lived-request tools deployed as isolated Workers under
  // this client's existing Cloudflare Access-protected /tools namespace.
  router.use('/navigation', createNavigationRouter(ctx));
  router.use('/apps', createMiniAppsRouter(ctx));

  // VM Desktop activity for the in-app shared-browser live view.
  // Owner/consultant only (member gate inside the router).
  router.use('/desktop', createDesktopRouter(ctx));
  router.use('/veneer-browser', createVeneerBrowserRouter(ctx));

  return router;
}
