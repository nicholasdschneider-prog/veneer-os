import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// How long to keep trying to switch a brand-new database into WAL mode while
// another service is doing the same thing.
const WAL_SWITCH_TIMEOUT_MS = 10_000;

export function openDb(dataDir: string, migrationsDir: string = MIGRATIONS_DIR): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'veneer-pro.db'));
  // Before anything else: every service shares this DB, so a writer holding the
  // lock must make the others wait rather than fail immediately with
  // SQLITE_BUSY. All four call openDb at boot, so on a fresh install they do
  // this at the same moment.
  db.pragma('busy_timeout = 5000');
  enableWal(db);
  db.pragma('foreign_keys = ON');
  migrate(db, migrationsDir);
  return db;
}

/**
 * Switch to WAL, tolerating a concurrent first boot. Changing journal mode
 * needs an exclusive lock, and SQLite does NOT run the busy handler for this
 * pragma — it returns SQLITE_BUSY straight away — so busy_timeout cannot cover
 * it and we retry by hand. Whoever wins does the switch; the rest read back
 * "wal" and carry on.
 */
function enableWal(db: Database.Database): void {
  const deadline = Date.now() + WAL_SWITCH_TIMEOUT_MS;
  for (;;) {
    if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal') return;
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException).code === 'SQLITE_BUSY';
      if (!busy || Date.now() > deadline) throw err;
      sleepSync(25);
    }
  }
}

/** better-sqlite3 is synchronous, so the retry wait must block this thread. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface UserRow {
  id: number;
  email: string;
  display_name: string;
  role: 'owner' | 'member' | 'consultant';
  status: 'pending' | 'active' | 'disabled';
  created_at: string;
  last_seen_at: string | null;
}

export interface AssistantRow {
  id: number;
  slug: string;
  name: string;
  instructions: string;
  approval_mode: 'ask' | 'auto';
  full_access: 0 | 1;
  default_provider: 'claude' | 'codex';
  default_model: string | null;
  created_at: string;
  /** Retired agents remain as tombstones so historical chats keep their identity. */
  deleted_at: string | null;
}

export interface ApprovalRow {
  id: number;
  conversation_id: string;
  request_id: string;
  tool_name: string;
  request_json: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  resolved_by: number | null;
  created_at: string;
  resolved_at: string | null;
}

export interface QuestionRow {
  request_id: string;
  conversation_id: string;
  turn_id: string;
  response_mode: 'poll' | 'provider';
  questions_json: string;
  status: 'pending' | 'answered' | 'expired' | 'dismissed';
  answers_json: string;
  created_at: string;
  resolved_at: string | null;
}

export interface ConnectionRow {
  id: number;
  name: string;
  slug: string;
  config_json: string;
  policy_json: string;
  enabled: number;
  managed_by: 'consultant' | 'owner';
  created_at: string;
}

export interface UserConnectorRow {
  id: number;
  user_id: number;
  /** Catalog slug (server/src/connectors/catalog.ts) — e.g. 'gmail'. */
  connector_slug: string;
  /** User's name for this install ("Work"); NULL = the unlabeled first/legacy install. */
  label: string | null;
  status: 'pending' | 'connected' | 'error';
  error: string | null;
  /** Personal = only the owner; shared = every user in an assigned project. */
  sharing: 'personal' | 'shared';
  /** All chats, or the explicit rows in user_connector_projects. */
  scope_mode: 'all' | 'projects';
  /** NULL means the install predates verified access-mode snapshots. */
  access_mode: 'read_only' | 'full' | null;
  access_version: number | null;
  /** Secrets inside (Composio MCP endpoint/headers, custom settings) — never returned raw over the API. */
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectorAccessChangeRow {
  connector_id: number;
  access_mode: 'read_only' | 'full';
  access_version: number;
  status: 'pending' | 'error';
  error: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  instructions: string;
  /** JSON-encoded project design overrides; empty fields inherit site defaults. */
  appearance_json: string;
  /** Custom root folder (absolute path); null = workspaces/projects/<slug>. Fixed at creation. */
  root_dir: string | null;
  /** Agent new chats in this project start with; null = use the site-wide default. */
  default_assistant_id: number | null;
  /** Stable user-chosen position in project lists; lower sorts first. */
  sort_order: number;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  assistant_id: number;
  user_id: number;
  /** Team chats are visible to every active user; private chats only to their creator. */
  visibility: 'team' | 'private';
  business_team_id?: string | null;
  /** Project (folder) this chat runs in; null = the shared assistant workspace. Fixed at creation. */
  project_id: string | null;
  title: string | null;
  /** 1 while the title is still Claude's/Codex's auto-generated one; 0 once the user renames it. */
  title_auto: number;
  provider: 'claude' | 'openrouter' | 'codex' | 'grok';
  model: string | null;
  effort: string | null;
  /** Per-chat approval override; null inherits the assistant's setting. */
  approval_mode: 'ask' | 'auto' | null;
  last_answered_model?: string | null;
  last_answered_provider?: string | null;
  native_session_id: string;
  /** Fixed agent + project instruction snapshot, created when the chat starts. */
  instruction_snapshot_json: string | null;
  instruction_snapshot_at: string | null;
  /** Hash of the developer instructions applied to the current native provider session. */
  provider_instruction_hash: string | null;
  /** Chat whose agent spawned this one (handoff etc.); NULL = human-created. No FK — orphans render top-level. */
  origin_conversation_id: string | null;
  channel: 'web' | 'email' | 'automation';
  archived: number;
  /** Manual pin position (migration 0016): NULL = not pinned; lower sorts first. */
  pin_order: number | null;
  created_at: string;
  last_active_at: string;
  /** Last time the user opened this chat or sent it a prompt; drives auto-archive. */
  last_user_activity_at: string | null;
  /** Input tokens (incl. cache) the provider processed on the most recent turn — the conversation's current "context used". Null until a turn completes with usage. */
  last_input_tokens: number | null;
  /** High-water mark for the generated-files sync: the last_active_at we last scanned this chat's files up to. Null = never synced (stale). */
  files_synced_at: string | null;
}

export interface VeneerBrowserProfileRow {
  id: string;
  client_scope: string;
  project_id: string;
  name: string;
  generation: number;
  created_by: number;
  owner_user_id: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VeneerBrowserSessionRow {
  profile_id: string;
  client_scope: string;
  project_id: string;
  conversation_id: string | null;
  remote_runtime_id: string | null;
  status: 'starting' | 'active' | 'stopped' | 'error';
  started_at: string | null;
  last_used_at: string | null;
  stopped_at: string | null;
  last_error: string | null;
}

export interface VeneerBrowserCloneSessionRow {
  conversation_id: string;
  client_scope: string;
  project_id: string;
  source_profile_id: string | null;
  source_generation: number | null;
  clone_profile_id: string;
  mode: 'profile' | 'fresh';
  remote_runtime_id: string | null;
  status: 'starting' | 'active' | 'stopped' | 'error';
  created_at: string;
  last_used_at: string | null;
  stopped_at: string | null;
  last_error: string | null;
}

export interface ScheduledTaskRow {
  id: string;
  user_id: number;
  assistant_id: number;
  project_id: string | null;
  name: string;
  prompt: string;
  schedule_json: string;
  timezone: string;
  provider: ConversationRow['provider'];
  model: string | null;
  effort: string | null;
  enabled: number;
  trigger_kind: 'schedule' | 'event';
  connector_id: number | null;
  trigger_recipe: string | null;
  trigger_config_json: string;
  filter_json: string;
  external_trigger_id: string | null;
  trigger_status: 'ready' | 'syncing' | 'error';
  trigger_error: string | null;
  /** Manual position in Automations; null = not pinned. */
  pin_order: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRunRow {
  id: string;
  scheduled_task_id: string;
  conversation_id: string | null;
  scheduled_for: string;
  trigger: 'scheduled' | 'event' | 'manual';
  status: 'queued' | 'running' | 'needs_you' | 'completed' | 'failed' | 'skipped';
  /** Explicitly promoted result; important runs also surface in Chats. */
  important: number;
  event_id: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface AutomationEventRow {
  id: string;
  scheduled_task_id: string;
  external_trigger_id: string;
  occurred_at: string;
  payload_json: string;
  status: 'pending' | 'processing' | 'ignored' | 'processed' | 'failed';
  attempts: number;
  error: string | null;
  received_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}

export interface ConversationWakeupRow {
  id: string;
  conversation_id: string;
  actor_user_id: number | null;
  wake_key: string;
  reason: string;
  scheduled_for: string;
  status: 'pending' | 'delivered' | 'cancelled';
  created_at: string;
  delivered_at: string | null;
  cancelled_at: string | null;
}

export interface BuildQueueRow {
  id: number;
  user_id: number;
  conversation_id: string;
  /** Non-null workspace mutex: source, or project:<immutable project id>. */
  scope_key: string;
  title: string;
  brief: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';
  error: string | null;
  /** Automatic requeues consumed after failed/timed-out turns. */
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** A user-defined column for the todos scratch-pad (migration 0017). */
export interface TodoCategoryRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

/** One lightweight scratch-pad todo (migration 0017). Belongs to an optional
 * category and, while pending, may target a project (migration 0049).
 * State 'active' means a chat was fired off from it,
 * with the conversation stored in conversation_id; 'done' (migration 0018) means it's
 * finished/archived (set manually, or automatically when its chat is archived). Links
 * live in todo_links. */
export interface TodoRow {
  id: string;
  title: string;
  notes: string;
  category_id: string | null;
  project_id: string | null;
  state: 'pending' | 'active' | 'done';
  conversation_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** A link or file attachment on a todo (migration 0017); CASCADE-deleted with its todo. */
export interface TodoLinkRow {
  id: string;
  todo_id: string;
  kind: 'link' | 'file';
  href: string;
  label: string | null;
  created_at: string;
}

/** One row of the generated_files registry (migration 0014). Outlives its chat: the conversation/project/user FKs SET NULL on delete, so the file stays listed and downloadable. */
export interface GeneratedFileRow {
  id: string;
  /** Absolute path on disk; UNIQUE (re-detection upserts by path). */
  path: string;
  name: string;
  source: 'write' | 'bash';
  size: number;
  mtime_ms: number;
  user_id: number | null;
  conversation_id: string | null;
  project_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}
