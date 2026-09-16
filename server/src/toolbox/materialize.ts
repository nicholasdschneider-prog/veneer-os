import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { ConnectionRow, UserConnectorRow } from '../db/db.js';
import { getBuiltinPolicy, policyToPermissions, type Policy } from './policy.js';
import { parseConnectionConfig, policyOf, type McpConfig } from './connections.js';
import {
  connectorDef,
  connectorInstallMcpName,
  connectorMcpConfig,
  type ConnectorDef,
} from '../connectors/catalog.js';
import { connectedConnectorRowsForConversation } from '../connectors/access.js';
import { writeCurrentAgentToken } from '../runtime/agentTokenFile.js';
import { readDopplerMetadata } from '../secrets/doppler.js';
import type { ProjectDopplerCli } from '../secrets/projectDopplerCli.js';
import {
  CONVERSATION_DEBUG_CONTEXT_FILENAME,
  instructionKnownContext,
  prepareConversationInstructions,
} from '../instructions/context.js';
import { readClaudePreferences } from '../providers/claude/preferences.js';

/**
 * Per-turn provider configuration. This writes only conversation-scoped MCP,
 * permission, and context-receipt files under DATA_DIR. It never creates or
 * changes repository CLAUDE.md or AGENTS.md files.
 */
export interface SpawnMaterialization {
  mcpConfigPath: string | null;
  settingsPath: string | null;
  developerInstructions: string;
  instructionHash: string;
}

export interface WorkspaceTarget {
  /** cwd the provider runs in — project folder, scratch workspace, or source checkout. */
  workspaceDir: string;
  assistantSlug: string;
  elevated: boolean;
  sourceWorkspace?: boolean;
  fullAccess?: boolean;
  projectId?: string | null;
  /** Kept for workspace ownership and migration decisions; instruction files are always user-owned. */
  customRoot?: boolean;
}

export interface Materializer {
  prepare(
    target: WorkspaceTarget,
    agentToken: string,
    conversationId: string,
    actorUserId: number | null,
    memoryBlock?: string | null,
  ): SpawnMaterialization;
  /** Durable context already supplied to this exact chat, used to reject duplicate memories. */
  memoryKnownContext(target: WorkspaceTarget, conversationId: string): string;
}

export { CONVERSATION_DEBUG_CONTEXT_FILENAME };

const AGENT_TOOLS_SERVER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'mcp',
  'agentToolsServer.js',
);

const AGENT_BROWSER_SERVER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'mcp',
  'agentBrowserServer.js',
);

const DOPPLER_SERVER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'mcp',
  'dopplerServer.js',
);

function atomicWrite(file: string, data: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function mcpServerEntry(config: McpConfig): Record<string, unknown> {
  if (config.transport === 'stdio') {
    return { command: config.command, args: config.args, env: config.env };
  }
  return { type: config.transport, url: config.url, headers: config.headers };
}

export function createMaterializer({
  db,
  dataDir,
  internalBaseUrl,
  runnerBaseUrl = internalBaseUrl,
  desktopCdpPort,
  publicOrigin,
  pagesPublicBase = null,
  projectDopplerCli = null,
  veneerBrowserAvailable = () => false,
  log = console,
}: {
  db: Database.Database;
  dataDir: string;
  internalBaseUrl: string;
  runnerBaseUrl?: string;
  desktopCdpPort?: number;
  publicOrigin?: string | null;
  /** config.pages.publicBase — lets the agents MCP server name the real page
   * host in its publish_page description. Null when publishing is unconfigured. */
  pagesPublicBase?: string | null;
  projectDopplerCli?: ProjectDopplerCli | null;
  veneerBrowserAvailable?: () => boolean;
  log?: Pick<Console, 'warn' | 'error'>;
}): Materializer {
  return {
    memoryKnownContext: (target, conversationId) => instructionKnownContext(db, target, conversationId),
    prepare(
      target: WorkspaceTarget,
      agentToken: string,
      conversationId: string,
      actorUserId: number | null,
      memoryBlock: string | null = null,
    ): SpawnMaterialization {
      const spawnDir = path.join(dataDir, 'spawn', target.assistantSlug, conversationId || 'boot');
      const mcpConfigPath = path.join(spawnDir, 'mcp-config.json');
      const settingsPath = path.join(spawnDir, 'settings.json');
      let agentTokenFile: string | null = null;
      if (conversationId) {
        try {
          agentTokenFile = writeCurrentAgentToken(conversationId, agentToken);
        } catch (err) {
          log.warn(`[materialize] could not refresh agent token file: ${(err as Error).message}`);
        }
      }

      const conversation = conversationId
        ? (db
            .prepare(
              `SELECT c.provider AS provider, u.role AS actor_role
                 FROM conversations c
                 JOIN users u ON u.id = ? AND u.status = 'active'
                WHERE c.id = ?`,
            )
            .get(actorUserId, conversationId) as
            | {
                provider: 'claude' | 'openrouter' | 'codex' | 'grok';
                actor_role: 'owner' | 'member' | 'consultant';
              }
            | undefined)
        : undefined;
      // Members are 403'd by requireDopplerAdmin on every Doppler API route, so
      // showing them the tools is just clutter. Hide the whole block when we can
      // positively see the turn actor is a member; a boot/system turn has no
      // conversation actor and keeps Doppler, as before. This
      // also denies members the main-box run_cli, which bypasses that API check.
      const dopplerHiddenForMember = Boolean(conversationId) && (!conversation || conversation.actor_role === 'member');
      // One read gates both the veneer_browser MCP registration below and the
      // steering rule, so the instructions can never advertise a browser the
      // agent was not given.
      const veneerBrowser = Boolean(conversationId) && veneerBrowserAvailable();
      const instructions = prepareConversationInstructions(
        db,
        { ...target, veneerBrowserAvailable: veneerBrowser },
        conversation ? conversationId : null,
        memoryBlock,
      );
      if (instructions.receipt) {
        atomicWrite(
          path.join(spawnDir, CONVERSATION_DEBUG_CONTEXT_FILENAME),
          `${JSON.stringify(instructions.receipt, null, 2)}\n`,
        );
      }

      let userInstalls: Array<{ row: UserConnectorRow; def: ConnectorDef }> = [];
      if (conversation) {
        userInstalls = connectedConnectorRowsForConversation(db, conversationId, actorUserId)
          .map((row) => ({ row, def: connectorDef(row.connector_slug) }))
          .filter((item): item is { row: UserConnectorRow; def: ConnectorDef } => Boolean(item.def));
      }

      const rows = db
        .prepare('SELECT * FROM connections WHERE enabled = 1 ORDER BY id')
        .all() as ConnectionRow[];
      const mcpServers: Record<string, unknown> = {};
      const allow: string[] = [];
      const deny: string[] = [];

      for (const row of rows) {
        try {
          const config = parseConnectionConfig(row.config_json);
          mcpServers[row.slug] = mcpServerEntry(config);
          const permissions = policyToPermissions(policyOf(row), `mcp__${row.slug}__`);
          allow.push(...permissions.allow);
          deny.push(...permissions.deny);
        } catch (err) {
          log.warn(`[materialize] skipping malformed connection ${row.slug}: ${(err as Error).message}`);
        }
      }

      for (const { row: install, def } of userInstalls) {
        const name = connectorInstallMcpName(
          install.connector_slug,
          install.label,
          install.sharing,
          install.id,
        );
        if (mcpServers[name]) continue;
        try {
          const config = connectorMcpConfig(def, install.config_json);
          if (!config) continue;
          mcpServers[name] = mcpServerEntry(config);
          allow.push(`mcp__${name}__*`);
        } catch (err) {
          log.warn(`[materialize] skipping connector ${name}: ${(err as Error).message}`);
        }
      }

      // request_secret / reveal_secret both end at the same Doppler CLI the
      // member gate above denies, and both fail at save time when there is no
      // authenticated CLI at all. Either way, do not offer them: the API routes
      // 403 a member and 409 a missing CLI, so listing them only invites a turn
      // that cannot finish.
      const secretToolsHidden = dopplerHiddenForMember || !projectDopplerCli;
      mcpServers.agents = {
        command: process.execPath,
        args: [AGENT_TOOLS_SERVER_PATH],
        env: {
          VP_AGENT_TOKEN: agentToken,
          VP_INTERNAL_BASE_URL: internalBaseUrl,
          VP_CONVERSATION_ID: conversationId,
          ...(pagesPublicBase ? { VP_PAGES_PUBLIC_BASE: pagesPublicBase } : {}),
          ...(agentTokenFile ? { VP_AGENT_TOKEN_FILE: agentTokenFile } : {}),
          ...(secretToolsHidden ? { VP_SECRET_TOOLS_DISABLED: '1' } : {}),
        },
      };
      allow.push('mcp__agents__*');

      const dopplerApiConnected = readDopplerMetadata(db)?.agentConfigured === true;
      if (!dopplerHiddenForMember && (dopplerApiConnected || projectDopplerCli)) {
        mcpServers.doppler = {
          command: process.execPath,
          args: [DOPPLER_SERVER_PATH],
          env: {
            VP_AGENT_TOKEN: agentToken,
            VP_INTERNAL_BASE_URL: internalBaseUrl,
            VP_CONVERSATION_ID: conversationId,
            VP_WORKSPACE_DIR: target.workspaceDir,
            ...(dopplerApiConnected ? { VP_DOPPLER_API_CONNECTED: '1' } : {}),
            ...(projectDopplerCli
              ? { VP_PROJECT_DOPPLER_BIN: path.join(projectDopplerCli.binDir, 'doppler') }
              : {}),
            ...(agentTokenFile ? { VP_AGENT_TOKEN_FILE: agentTokenFile } : {}),
          },
        };
        if (projectDopplerCli) allow.push('mcp__doppler__*');
        else allow.push('mcp__doppler__status', 'mcp__doppler__list_secret_names');
      }

      mcpServers.agent_browser = {
        command: process.execPath,
        args: [AGENT_BROWSER_SERVER_PATH],
        env: {
          VP_CONVERSATION_ID: conversationId,
          VP_WORKSPACE_DIR: target.workspaceDir,
          ...(desktopCdpPort ? { VP_DESKTOP_CDP_PORT: String(desktopCdpPort) } : {}),
          ...(publicOrigin ? { VP_APPS_PUBLIC_ORIGIN: publicOrigin } : {}),
          VP_AGENT_BROWSER_RETURN_IMAGES: conversation?.provider === 'openrouter' ? '0' : '1',
        },
      };
      allow.push('mcp__agent_browser__*');

      if (veneerBrowser) {
        mcpServers.veneer_browser = {
          type: 'http',
          url: `${runnerBaseUrl}/mcp/veneer-browser`,
          headers: { 'X-VP-Agent-Token': agentToken },
        };
        allow.push('mcp__veneer_browser__*');
      }

      const basePolicy = getBuiltinPolicy(db);
      const builtin = policyToPermissions(target.elevated ? elevatePolicy(basePolicy) : basePolicy);
      allow.push(...builtin.allow);
      deny.push(...builtin.deny);
      allow.push(`Read(/${path.join(dataDir, 'uploads')}/**)`);

      atomicWrite(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));
      const settings = {
        // This is a Claude Code preference, not a provider-neutral prompt rule.
        // OpenRouter also uses the Claude harness, but keeps its existing output
        // behavior because the preference is explicitly scoped to Claude chats.
        ...(conversation?.provider === 'claude'
          ? { outputStyle: readClaudePreferences(db).outputStyle }
          : {}),
        // Full Access bypasses permission evaluation. Omitting permission keys
        // keeps that behavior unchanged while still letting Claude receive its
        // non-permission preferences through --settings.
        ...(target.fullAccess
          ? {}
          : { permissions: { allow: dedupe(allow), deny: dedupe(deny) } }),
      };
      atomicWrite(settingsPath, JSON.stringify(settings, null, 2));

      return {
        mcpConfigPath,
        settingsPath,
        developerInstructions: instructions.developerInstructions,
        instructionHash: instructions.instructionHash,
      };
    },
  };
}

function elevatePolicy(policy: Policy): Policy {
  return {
    default: policy.default,
    rules: [...policy.rules.filter((rule) => rule.match !== 'Bash'), { match: 'Bash', action: 'allow' }],
  };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
