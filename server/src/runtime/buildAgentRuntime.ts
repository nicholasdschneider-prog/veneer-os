import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { AssistantRow, ConversationRow } from '../db/db.js';
import type { SecretStore } from '../secrets/store.js';
import { LEGACY_ACCOUNT_ID, type UsageStore } from '../usage/store.js';
import { createClaudeAdapter } from '../providers/claude/adapter.js';
import { createCodexAccountFailover } from '../providers/codex/accountFailover.js';
import { createCodexAccountStore, ensureCodexAccountHome, type CodexAccountStore } from '../codex/accounts.js';
import { createCodexAccountUsage, type CodexUsageReader } from '../usage/codex.js';
import { createClaudeAccountFailover } from '../providers/claude/accountFailover.js';
import type { ClaudeProbe } from '../usage/claudeProbe.js';
import { createCodexAdapter } from '../providers/codexAppServer/adapter.js';
import { createGrokAdapter } from '../providers/grok/adapter.js';
import { createOpenRouterAdapter } from '../providers/openrouter/adapter.js';
import { readOpenRouterModelIds } from '../providers/openrouter/models.js';
import { createConversationManager, type ConversationManager } from './conversationManager.js';
import { createTranscriptArchive, type TranscriptArchive } from './transcriptArchive.js';
import { createMaterializer, type Materializer, type WorkspaceTarget } from '../toolbox/materialize.js';
import { enableProjectDopplerCli, type ProjectDopplerCli } from '../secrets/projectDopplerCli.js';
import type { ProviderAdapter } from '../providers/types.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';
import type { DopplerRuntime } from '../secrets/doppler.js';
import { buildRememberedContext, createSupermemoryClient } from '../memory/supermemory.js';
import { createOpenRouterMemoryRelevanceSelector } from '../memory/relevance.js';
import { isMemoryCaptureEnabled, memoryMessagesFromEvents } from '../memory/capture.js';
import { curateConversationMemory } from '../memory/curator.js';
import { agentEnv } from '../homes.js';
import { addBoundAgentSecrets } from '../secrets/agentSecretBindings.js';
import { readBrowserIdentity } from '../veneerBrowser/remoteClient.js';
import {
  cleanupLegacyGeneratedInstructionsOnce,
  initializeConversationInstructionSnapshots,
} from '../instructions/context.js';

/** The turn-execution runtime, shared verbatim by the in-process web boot and the runner. */
export interface AgentRuntime {
  /** One PER_TURN adapter per provider, keyed by conversations.provider. */
  adapters: Record<string, ProviderAdapter>;
  manager: ConversationManager;
  resolveWorkspace: (conv: ConversationRow) => WorkspaceTarget;
  materializer: Materializer;
  /** Everyday assistant's scratch workspace (dataDir/workspaces/<slug>) — ctx.workspaceDir + the boot seed. */
  workspaceDir: string;
  /** Veneer-owned copies of the provider transcript files (boot sweep lives in the runner). */
  transcriptArchive: TranscriptArchive;
  /** Main Pro's authenticated Doppler CLI wrapper, or null on a client instance. */
  projectDopplerCli: ProjectDopplerCli | null;
}

/** Give every assistant its own persona/workspace while projects keep their shared folder. */
export function createWorkspaceResolver({
  db,
  dataDir,
  sourceDir,
  defaultAssistantSlug,
}: {
  db: Database.Database;
  dataDir: string;
  sourceDir: string;
  defaultAssistantSlug: string;
}): (conv: Pick<ConversationRow, 'assistant_id' | 'project_id'>) => WorkspaceTarget {
  const assistantForIdStmt = db.prepare('SELECT slug, full_access FROM assistants WHERE id = ?');
  function assistantFor(id: number): { slug: string; fullAccess: boolean } {
    // Read full_access on every turn: Settings lives in the web process while
    // this resolver lives in the runner, so an in-memory cache would make the
    // toggle stale until a runner restart.
    const row = assistantForIdStmt.get(id) as { slug: string; full_access: 0 | 1 } | undefined;
    return {
      slug: row?.slug ?? defaultAssistantSlug,
      fullAccess: Boolean(row?.full_access),
    };
  }

  const projectDirById = new Map<string, { dir: string; customRoot: boolean } | null>();
  function projectDirFor(projectId: string): { dir: string; customRoot: boolean } | null {
    let entry = projectDirById.get(projectId);
    if (entry === undefined) {
      const row = db.prepare('SELECT slug, root_dir FROM projects WHERE id = ?').get(projectId) as
        | { slug: string; root_dir: string | null }
        | undefined;
      entry = row
        ? row.root_dir
          ? { dir: row.root_dir, customRoot: true }
          : { dir: path.join(dataDir, 'workspaces', 'projects', row.slug), customRoot: false }
        : null;
      projectDirById.set(projectId, entry);
    }
    return entry;
  }

  return (conv) => {
    const { slug: assistantSlug, fullAccess } = assistantFor(conv.assistant_id);
    if (conv.project_id) {
      const project = projectDirFor(conv.project_id);
      if (project) {
        fs.mkdirSync(project.dir, { recursive: true });
        const isPlatformDev = assistantSlug === 'platform-dev';
        const sourceWorkspace = isPlatformDev && path.resolve(project.dir) === path.resolve(sourceDir);
        return {
          workspaceDir: project.dir,
          assistantSlug,
          elevated: isPlatformDev,
          sourceWorkspace,
          fullAccess,
          projectId: conv.project_id,
          customRoot: project.customRoot,
        };
      }
    }
    if (assistantSlug === 'platform-dev') {
      return {
        workspaceDir: sourceDir,
        assistantSlug,
        elevated: true,
        sourceWorkspace: true,
        fullAccess,
        projectId: null,
      };
    }
    const assistantWorkspace = path.join(dataDir, 'workspaces', assistantSlug);
    fs.mkdirSync(assistantWorkspace, { recursive: true });
    return { workspaceDir: assistantWorkspace, assistantSlug, elevated: false, fullAccess, projectId: null };
  };
}

/**
 * Constructs the agent-turn runtime (adapters + materializer + conversation
 * manager + workspace resolution). Extracted from index.ts so both the web
 * process (in-process today) and the standalone runner build it identically.
 * The materializer's internal base URL always points at the WEB port (where
 * `/api` lives) — the runner passes the web URL, not its own (plan §5).
 */
export function buildAgentRuntime({
  config,
  db,
  secrets,
  doppler,
  usage,
  claudeProbe,
  codexAccounts = createCodexAccountStore(config.dataDir),
  codexUsage = createCodexAccountUsage({ codexBin: config.codexBin, accounts: codexAccounts }),
}: {
  config: Config;
  db: Database.Database;
  secrets: SecretStore;
  doppler: DopplerRuntime;
  usage: UsageStore;
  /** Connected Codex accounts; defaults to the registry in `config.dataDir`. */
  codexAccounts?: CodexAccountStore;
  /** Per-account Codex usage, consulted by failover to rank spare accounts. */
  codexUsage?: Pick<CodexUsageReader, 'read'>;
  claudeProbe?: Pick<ClaudeProbe, 'refreshIfStale'>;
}): AgentRuntime {
  const projectDopplerCli = enableProjectDopplerCli(config.dataDir, process.env);
  const buildProviderEnv = (fullAccess: boolean): NodeJS.ProcessEnv =>
    addBoundAgentSecrets(agentEnv(fullAccess), doppler);

  // Assistant workspace: provider CLIs run here. Repository instruction files
  // are user-owned; only conversation-scoped toolbox files are materialized.
  const assistant = db
    .prepare('SELECT * FROM assistants WHERE deleted_at IS NULL ORDER BY id LIMIT 1')
    .get() as AssistantRow;
  const workspaceDir = path.join(config.dataDir, 'workspaces', assistant.slug);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const resolveWorkspace = createWorkspaceResolver({
    db,
    dataDir: config.dataDir,
    sourceDir: config.sourceDir,
    defaultAssistantSlug: assistant.slug,
  });

  // Subscription-usage plumbing: the claude adapter forwards every stream
  // `rate_limit_event` into this store (passive capture); codex usage is fetched
  // on demand. Both surface via GET /api/usage.
  const adapters = {
    claude: createClaudeAdapter({
      claudeBin: config.claudeBin,
      turnTimeoutMs: config.turnTimeoutMs,
      turnInactivityMs: config.turnInactivityMs,
      buildEnv: buildProviderEnv,
      getOauthToken: () => secrets.getClaudeToken(),
      onRateLimit: (info, accountId) => {
        usage.recordClaudeFor(accountId ?? LEGACY_ACCOUNT_ID, info, 'stream');
      },
      getAccountId: () => secrets.activeClaudeAccountId(),
      onSessionLimit: (event) => {
        void claudeFailover.handleSessionLimit(event);
      },
    }),
    openrouter: createOpenRouterAdapter({
      claudeBin: config.claudeBin,
      turnTimeoutMs: config.turnTimeoutMs,
      turnInactivityMs: config.turnInactivityMs,
      configDir: path.join(config.dataDir, 'claude-openrouter'),
      buildEnv: buildProviderEnv,
      getApiKey: () => effectiveApiKey('openrouter', secrets, config, doppler).value,
      getModelIds: () => readOpenRouterModelIds(db),
    }),
    codex: createCodexAdapter({
      codexBin: config.codexBin,
      turnTimeoutMs: config.turnTimeoutMs,
      turnInactivityMs: config.turnInactivityMs,
      transcriptsDir: path.join(config.dataDir, 'codex-app-server-transcripts'),
      buildEnv: buildProviderEnv,
      // Pre-consolidation `codex exec` chats wrote their normalized history
      // here. App Server can resume their native Codex thread ids, while this
      // fallback keeps their already-rendered turns visible.
      legacyTranscriptsDir: path.join(config.dataDir, 'codex-transcripts'),
      getAccountId: () => codexAccounts.activeAccountId(),
      // Every account is its own CODEX_HOME sharing the primary profile's
      // history through links; refresh those links before each spawn.
      codexHomeFor: (accountId) => ensureCodexAccountHome(codexAccounts.homeFor(accountId)),
      onUsageLimit: (event) => {
        void codexFailover.handleUsageLimit(event);
      },
    }),
    grok: createGrokAdapter({
      grokBin: config.grokBin,
      turnTimeoutMs: config.turnTimeoutMs,
      turnInactivityMs: config.turnInactivityMs,
      transcriptsDir: path.join(config.dataDir, 'grok-transcripts'),
      // Same per-access-level builder every provider uses; the Grok adapter
      // then strips XAI_API_KEY and pins GROK_SANDBOX on top of it.
      buildEnv: buildProviderEnv,
    }),
  };
  const materializer = createMaterializer({
    db,
    dataDir: config.dataDir,
    internalBaseUrl: `http://127.0.0.1:${config.port}`,
    runnerBaseUrl: `http://127.0.0.1:${config.runnerPort}`,
    desktopCdpPort: config.desktopCdpPort,
    publicOrigin: config.appPublicOrigin,
    pagesPublicBase: config.pages?.publicBase ?? null,
    projectDopplerCli,
    veneerBrowserAvailable: () => Boolean(config.veneerBrowserUrl && readBrowserIdentity(config.veneerBrowserIdentityFile)),
  });
  const frozen = initializeConversationInstructionSnapshots(db);
  if (frozen > 0) console.log(`[veneer-pro] froze instruction context for ${frozen} existing chat(s)`);
  const cleanup = cleanupLegacyGeneratedInstructionsOnce({
    db,
    dataDir: config.dataDir,
    sourceDir: config.sourceDir,
  });
  for (const file of cleanup.removed) console.log(`[veneer-pro] removed legacy generated instructions: ${file}`);
  for (const file of cleanup.gitExcludesUpdated) {
    console.log(`[veneer-pro] removed legacy instruction ignores from ${file}`);
  }
  for (const error of cleanup.errors) console.warn(`[veneer-pro] legacy instruction cleanup failed: ${error}`);
  const supermemory = createSupermemoryClient({
    baseUrl: config.supermemoryBaseUrl,
    apiKey: config.supermemoryApiKey,
    apiKeyFile: path.join(config.dataDir, 'supermemory', 'api-key'),
  });
  const selectRelevantMemory = createOpenRouterMemoryRelevanceSelector({
    getApiKey: () => effectiveApiKey('openrouter', secrets, config, doppler).value,
  });
  // One Luna process at a time keeps automatic curation cheap and prevents two
  // simultaneous turns from racing to save the same durable fact.
  let memoryCuratorQueue: Promise<void> = Promise.resolve();
  // Providers own their history files and some of them delete it (Claude Code
  // purges session JSONLs after 30 days), so Veneer keeps its own copy.
  const transcriptArchive = createTranscriptArchive({
    dataDir: config.dataDir,
    adapters,
    resolveCwd: (conv) => resolveWorkspace(conv).workspaceDir,
  });
  const manager = createConversationManager({
    db,
    adapters,
    resolveWorkspace,
    transcriptArchive,
    loadMemoryBlock: async (conv, prompt, { firstTurn }) => {
      const target = resolveWorkspace(conv);
      return buildRememberedContext({
        client: supermemory,
        userId: conv.user_id,
        projectId: conv.project_id,
        // Search only the cleaned request. containerTag already supplies scope;
        // labels and project names polluted embedding relevance in production.
        query: prompt,
        knownContext: materializer.memoryKnownContext(target, conv.id),
        includeProfile: firstTurn,
        limit: 3,
        selectRelevant: selectRelevantMemory,
        log: console,
      });
    },
    captureMemoryTurn: async (conv, events) => {
      if (!supermemory.configured || !isMemoryCaptureEnabled(db, conv.user_id)) return;
      memoryCuratorQueue = memoryCuratorQueue.catch(() => undefined).then(async () => {
        const adapter = adapters[conv.provider];
        const workspace = resolveWorkspace(conv);
        const current = memoryMessagesFromEvents(events);
        const historyEvents = await adapter.readTranscript({
          cwd: workspace.workspaceDir,
          nativeSessionId: conv.native_session_id,
        }).catch(() => []);
        const history = memoryMessagesFromEvents(historyEvents).slice(-16);
        const messages = history.length ? [...history] : current;
        for (const message of current) {
          const recent = messages.slice(-4);
          if (!recent.some((item) => item.role === message.role && item.content === message.content)) messages.push(message);
        }
        const project = conv.project_id
          ? db.prepare('SELECT name FROM projects WHERE id = ?').get(conv.project_id) as { name: string } | undefined
          : undefined;
        const target = resolveWorkspace(conv);
        await curateConversationMemory({
          db,
          client: supermemory,
          codexBin: config.codexBin,
          claudeBin: config.claudeBin,
          getClaudeOauthToken: () => secrets.getClaudeToken(),
          conversation: conv,
          messages,
          projectName: project?.name,
          knownContext: materializer.memoryKnownContext(target, conv.id),
        });
      });
      await memoryCuratorQueue;
    },
    materialize: (target, agentToken, conversationId, actorUserId, memoryBlock) =>
      materializer.prepare(target, agentToken, conversationId, actorUserId, memoryBlock),
    approvalTimeoutMs: config.approvalTimeoutMs,
  });

  // Wire recovery as part of runtime construction so a boot caller cannot omit it.
  const claudeFailover = createClaudeAccountFailover({ db, secrets, usage, manager, probe: claudeProbe });
  const codexFailover = createCodexAccountFailover({ db, accounts: codexAccounts, usage: codexUsage, manager });

  return {
    adapters,
    manager,
    resolveWorkspace,
    materializer,
    workspaceDir,
    transcriptArchive,
    projectDopplerCli,
  };
}
