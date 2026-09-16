import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { ConversationRow } from './db/db.js';
import {
  CONVERSATION_DEBUG_CONTEXT_FILENAME,
  prepareConversationInstructions,
  type ConversationInstructionReceipt,
} from './instructions/context.js';
import { resolveEffectiveApprovalMode } from './approvalMode.js';

export interface ConversationDebugContext {
  runtime: {
    provider: ConversationRow['provider'];
    model: string | null;
    effort: string | null;
    assistantSlug: string;
    projectName: string | null;
    channel: ConversationRow['channel'];
    workspaceDir: string;
    approvalMode: ConversationRow['approval_mode'];
    effectiveApprovalMode: 'ask' | 'auto';
    contextTokens: number | null;
  };
  providerSystemPrompt: {
    available: false;
    note: string;
  };
  instructions: {
    capturedAt: string | null;
    exactReceipt: boolean;
    delivery: ConversationInstructionReceipt['delivery'] | null;
    core: ConversationInstructionReceipt['core'] | null;
    chatSnapshot: ConversationInstructionReceipt['chatSnapshot'] | null;
    repository: ConversationInstructionReceipt['repository'] | null;
    memory: ConversationInstructionReceipt['turnData']['memory'] | null;
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

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isInstructionReceipt(value: unknown): value is ConversationInstructionReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 2 || typeof row.capturedAt !== 'string') return false;
  const core = row.core as Record<string, unknown> | undefined;
  const snapshot = row.chatSnapshot as Record<string, unknown> | undefined;
  const repository = row.repository as Record<string, unknown> | undefined;
  return (
    typeof core?.content === 'string' &&
    typeof core?.hash === 'string' &&
    typeof snapshot?.content === 'string' &&
    typeof snapshot?.hash === 'string' &&
    Array.isArray(repository?.files)
  );
}

/** Build a secret-free receipt of the context supplied to the latest turn. */
export function readConversationDebugContext(
  db: Database.Database,
  config: Pick<Config, 'dataDir' | 'sourceDir'>,
  conversation: ConversationRow,
): ConversationDebugContext {
  const assistant = db
    .prepare('SELECT slug, approval_mode, full_access FROM assistants WHERE id = ?')
    .get(conversation.assistant_id) as
      | { slug: string; approval_mode: 'ask' | 'auto'; full_access: 0 | 1 }
      | undefined;
  const assistantSlug = assistant?.slug ?? 'assistant';
  const project = conversation.project_id
    ? (db.prepare('SELECT name, slug, root_dir FROM projects WHERE id = ?').get(conversation.project_id) as
        | { name: string; slug: string; root_dir: string | null }
        | undefined)
    : undefined;
  const workspaceDir =
    assistantSlug === 'platform-dev' && !project
      ? config.sourceDir
      : project?.root_dir
        ? project.root_dir
        : project
          ? path.join(config.dataDir, 'workspaces', 'projects', project.slug)
          : path.join(config.dataDir, 'workspaces', assistantSlug);

  const spawnDir = path.join(config.dataDir, 'spawn', assistantSlug, conversation.id);
  const stored = readJson(path.join(spawnDir, CONVERSATION_DEBUG_CONTEXT_FILENAME));
  const receipt = isInstructionReceipt(stored) ? stored : null;
  let currentReceipt: ConversationInstructionReceipt | null = null;
  try {
    currentReceipt = prepareConversationInstructions(
      db,
      {
        workspaceDir,
        assistantSlug,
        elevated: assistantSlug === 'platform-dev',
        sourceWorkspace:
          assistantSlug === 'platform-dev' && path.resolve(workspaceDir) === path.resolve(config.sourceDir),
      },
      conversation.id,
    ).receipt;
  } catch {
    // A corrupt snapshot must not hide the last exact receipt from diagnostics.
  }
  const core = receipt?.core
    ? { ...receipt.core, current: receipt.core.hash === currentReceipt?.core.hash }
    : currentReceipt?.core
      ? { ...currentReceipt.core, current: false }
      : null;
  const chatSnapshot = receipt?.chatSnapshot
    ? {
        ...receipt.chatSnapshot,
        current: receipt.chatSnapshot.hash === currentReceipt?.chatSnapshot.hash,
        settingsCurrent: currentReceipt?.chatSnapshot.settingsCurrent ?? receipt.chatSnapshot.settingsCurrent,
      }
    : currentReceipt?.chatSnapshot
      ? { ...currentReceipt.chatSnapshot, current: false }
      : null;
  const repository = (() => {
    if (!receipt?.repository) {
      return currentReceipt?.repository
        ? {
            ...currentReceipt.repository,
            current: false,
            files: currentReceipt.repository.files.map((file) => ({ ...file, current: false })),
          }
        : null;
    }
    const latest = new Map(
      (currentReceipt?.repository.files ?? []).map((file) => [file.path, file] as const),
    );
    const files = receipt.repository.files.map((file) => {
      const current = latest.get(file.path);
      return {
        ...file,
        current: Boolean(current && current.version === file.version && current.current),
      };
    });
    return {
      ...receipt.repository,
      current:
        files.length === latest.size && files.every((file) => file.current),
      files,
    };
  })();
  const mcp = readJson(path.join(spawnDir, 'mcp-config.json')) as
    | { mcpServers?: Record<string, unknown> }
    | null;
  const settings = readJson(path.join(spawnDir, 'settings.json')) as
    | { permissions?: { allow?: unknown; deny?: unknown } }
    | null;
  let skills: string[] = [];
  try {
    skills = fs.readdirSync(path.join(workspaceDir, '.claude', 'skills')).sort();
  } catch {
    // Task-specific skills can also come from provider profiles; this list is only the workspace view.
  }

  return {
    runtime: {
      provider: conversation.provider,
      model: conversation.model,
      effort: conversation.effort,
      assistantSlug,
      projectName: project?.name ?? null,
      channel: conversation.channel,
      workspaceDir,
      approvalMode: conversation.approval_mode,
      effectiveApprovalMode: resolveEffectiveApprovalMode(
        Boolean(assistant?.full_access),
        conversation.approval_mode,
        assistant?.approval_mode,
      ),
      contextTokens: conversation.last_input_tokens,
    },
    providerSystemPrompt: {
      available: false,
      note: `${conversation.provider === 'claude' ? 'Claude' : conversation.provider === 'codex' ? 'Codex' : 'OpenRouter'} manages its hidden base prompt. Veneer cannot display that provider-owned text. The Veneer-supplied blocks and their roles are shown below.`,
    },
    instructions: {
      capturedAt: receipt?.capturedAt ?? null,
      exactReceipt: Boolean(receipt),
      delivery: receipt?.delivery ?? currentReceipt?.delivery ?? null,
      core,
      chatSnapshot,
      repository,
      memory: receipt?.turnData.memory ?? null,
      note: receipt
        ? 'Exact receipt from the latest turn. Tool availability is materialized separately for every turn.'
        : 'No provider turn receipt is available yet. The pending blocks below will apply when this chat starts its next turn.',
    },
    tooling: {
      // Names and permission patterns only. Raw MCP entries can contain credentials.
      mcpServers: Object.keys(mcp?.mcpServers ?? {}).sort(),
      allowedPermissions: stringArray(settings?.permissions?.allow),
      deniedPermissions: stringArray(settings?.permissions?.deny),
      skills,
      snapshotAvailable: Boolean(mcp || settings),
    },
  };
}
