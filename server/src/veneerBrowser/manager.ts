import { activeLoginGrants, authorizeLoginSecret, guardedLoginScript } from './loginGrants.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  ConversationRow,
  ProjectRow,
  UserRow,
  VeneerBrowserCloneSessionRow,
  VeneerBrowserProfileRow,
  VeneerBrowserSessionRow,
} from '../db/db.js';
import {
  closeVeneerBrowserSession,
  runAgentBrowser,
  type BrowserRunResult,
} from '../mcp/agentBrowser.js';
import { createSerialQueue, type SerialQueue } from '../mcp/serialQueue.js';
import { canSendToConversation } from '../conversations/access.js';
import { isEmployee } from '../bots/employeeAccess.js';
import { ReadUrlSchema, readBrowserUrl, readUrlFailure, type ReadUrlResult } from './readUrl.js';
import { hasLiveSecretField } from './secretFill.js';
import {
  isVeneerBrowserRemoteError,
  type RemoteDownload,
  type RemoteOpenResult,
  type RemoteTicket,
  type VeneerBrowserRemote,
} from './remoteClient.js';

const MAX_DOWNLOAD_FILE = 25 * 1024 * 1024;
const MAX_DOWNLOAD_TOTAL = 100 * 1024 * 1024;
const STOPPED_COPY_GRACE_MS = 30 * 60_000;
const UNFILED_SCOPE_PREFIX = 'unfiled-user-';
// A chat that is already running commands re-checks the remote runtime at most
// this often.
const ACTIVE_CHECK_MS = 30_000;
// Only a ticket that has never carried a command is aged out, and well before
// its real lifetime, so the daemon's FIRST connection never dials a stale
// address. Once a command has gone out on an address, the daemon holds one
// long-lived connection to it and re-dials only when the address changes, so
// the same address is handed back for as long as this chat keeps its working
// copy: rotating it is what forced those re-dials, and every re-dial reset the
// daemon's selected tab and expired its @refs mid-task.
const TICKET_REUSE_MS = 90_000;
// A cache entry for a chat that stopped running commands is dropped after this.
const RUNTIME_CACHE_IDLE_MS = 10 * 60_000;
// A failed command is re-run only on evidence that the copy behind it is gone.
// Everything else is the page answering, and answers are never replayed. Tested
// against the tool's own stderr only, and anchored: page text is full of things
// like "401(k)" and the word WebSocket, and none of that is transport evidence.
const LOST_CONNECTION = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE)\b|CDP WebSocket connect failed|WebSocket (connection |is )?clos|Target closed|browserType\.connect|ticket expired|HTTP 401\b/i;
// A probe runs only after something already went wrong, so it waits briefly and
// then gives up rather than adding its own delay to the answer.
const PROBE_TIMEOUT_MS = 5_000;

export interface VeneerBrowserProfileView {
  id: string;
  projectId: string;
  ownerUserId: number;
  name: string;
  active: boolean;
  status: VeneerBrowserSessionRow['status'];
  activeConversationId: string | null;
  activeConversationTitle: string | null;
  activeCloneCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** A profile owned by someone else, listed for account owners only. */
export interface VeneerBrowserOtherProfileView extends VeneerBrowserProfileView {
  ownerName: string;
}

export interface VeneerBrowserProfileList {
  profiles: VeneerBrowserProfileView[];
  defaultProfileId: string | null;
  /** Populated for account owners only, so they can clean up after a teammate. */
  others: VeneerBrowserOtherProfileView[];
}

export interface VeneerBrowserSessionView {
  configured: boolean;
  active: boolean;
  projectId: string;
  profileId: string | null;
  profileName: string | null;
  status: VeneerBrowserSessionRow['status'];
  inUseByAnotherChat: boolean;
  temporaryClone: boolean;
  fresh: boolean;
  canUpdateProfile: boolean;
  // When the current working copy was created; the chat UI reopens a closed
  // browser panel only for a session newer than the close.
  startedAt: string | null;
  lastUsedAt: string | null;
  error: string | null;
}

// Declared here rather than in db/db.ts because this row is only ever read and
// written by the Veneer Browser manager.
interface VeneerBrowserCaptureGrantRow {
  conversation_id: string;
  client_scope: string;
  clone_profile_id: string;
  granted_by: number;
  created_at: string;
}

export interface VeneerBrowserCaptureView {
  active: boolean;
}

interface ConversationContext extends ConversationRow {
  project_slug: string | null;
  project_root_dir: string | null;
  assistant_slug: string;
  browser_actor_id?: number;
}

interface ConversationRuntime {
  row: VeneerBrowserCloneSessionRow;
  auditProfileId: string;
}

/** One member of a sequence that actually ran, in the order it ran. */
export interface BrowserSequenceStep {
  command: string[];
  result: BrowserRunResult;
}

export interface BrowserSequenceFailure {
  /** Position in the requested sequence; everything after it never ran. */
  index: number;
  command: string[];
  /** What the agent should be shown: the member's own output or error. */
  output: string;
}

export interface BrowserSequenceResult {
  steps: BrowserSequenceStep[];
  failure: BrowserSequenceFailure | null;
  /** Whether a compensating `mouse up` was attempted after an abort. */
  released: boolean;
}

interface HeldTicket extends RemoteTicket {
  issuedAt: number;
  /** Commands sent on this address; above zero, the daemon has connected with it. */
  useCount: number;
}

/**
 * In-memory only. It saves round trips on a hot chat and is always safe to
 * throw away: every entry is re-derived from the manager on the next miss.
 */
interface ConversationRuntimeCache {
  activeCheckedAt: number;
  ticket?: HeldTicket;
}

/**
 * The control address a chat's last command actually used.
 *
 * Kept apart from runtimeCache because a failed command deliberately throws
 * that cache away — and a failed command is exactly when a probe has a question
 * to ask. It is pinned to the working copy it was used against, so a replaced
 * copy can never be reached with it, and it is only ever read by probeCommand.
 */
interface ProbeAddress {
  cdpUrl: string;
  cloneProfileId: string;
  usedAt: number;
}

export interface VeneerBrowserManagerOptions {
  db: Database.Database;
  dataDir: string;
  remote: VeneerBrowserRemote;
  runBrowser?: typeof runAgentBrowser;
  closeBrowserSession?: typeof closeVeneerBrowserSession;
  readUrl?: typeof readBrowserUrl;
}

function now(): string {
  return new Date().toISOString();
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100) throw new Error('Profile name must be from 1 to 100 characters.');
  return name;
}

function safeFileName(value: string): string {
  const name = path.basename(value).replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^\.+/, '').slice(0, 180);
  return name || 'download';
}

function auditCommandName(args: unknown): string {
  return Array.isArray(args) && typeof args[0] === 'string' ? args[0].toLowerCase() : 'unknown';
}

/**
 * Sequence members are all two-word verbs (`mouse move`, `mouse down`), and an
 * audit row that said only "mouse" three times would hide what was pressed.
 */
function sequenceAuditName(args: string[]): string {
  const verb = auditCommandName(args);
  const sub = args[1];
  return sub && /^[a-z]+$/i.test(sub) ? `${verb} ${sub.toLowerCase()}` : verb;
}

function isMouseVerb(args: string[], verb: 'down' | 'up'): boolean {
  return args[0]?.toLowerCase() === 'mouse' && args[1]?.toLowerCase() === verb;
}

function commandOutput(result: BrowserRunResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
    || `Browser command exited ${result.exitCode}.`;
}

function decodeDownload(item: RemoteDownload): Buffer | null {
  if (!Number.isInteger(item.size) || item.size < 0 || item.size > MAX_DOWNLOAD_FILE) return null;
  const bytes = Buffer.from(item.data, 'base64');
  return bytes.length === item.size ? bytes : null;
}

export class VeneerBrowserManager {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  private readonly remote: VeneerBrowserRemote;
  private readonly runBrowser: typeof runAgentBrowser;
  private readonly closeBrowserSession: typeof closeVeneerBrowserSession;
  private readonly readUrl: typeof readBrowserUrl;
  private readonly queues = new Map<string, SerialQueue>();
  private readonly runtimeCache = new Map<string, ConversationRuntimeCache>();
  private readonly probeAddresses = new Map<string, ProbeAddress>();
  private readonly maintenanceTimer: NodeJS.Timeout;

  constructor(options: VeneerBrowserManagerOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.remote = options.remote;
    this.runBrowser = options.runBrowser ?? runAgentBrowser;
    this.closeBrowserSession = options.closeBrowserSession ?? closeVeneerBrowserSession;
    this.readUrl = options.readUrl ?? readBrowserUrl;
    this.maintenanceTimer = setInterval(() => {
      this.evictIdleRuntimeCache();
      void this.reconcile().catch(() => undefined);
    }, 60_000);
    this.maintenanceTimer.unref();
  }

  configured(): boolean {
    return this.remote.configured();
  }

  clientScope(): string {
    const scope = this.remote.clientScope();
    if (!scope) throw new Error('Veneer Browser is not configured on this client.');
    return scope;
  }

  private queue(key: string): SerialQueue {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = createSerialQueue();
      this.queues.set(key, queue);
    }
    return queue;
  }

  /**
   * A chat that stopped running commands keeps nothing here. The entries are
   * only a round-trip saver, so dropping them costs one status call at most,
   * and holding a ticket for an abandoned conversation costs memory forever.
   */
  private evictIdleRuntimeCache(): void {
    const cutoff = Date.now() - RUNTIME_CACHE_IDLE_MS;
    for (const [conversationId, entry] of this.runtimeCache) {
      const touchedAt = Math.max(entry.activeCheckedAt, entry.ticket?.issuedAt ?? 0);
      if (touchedAt < cutoff) this.runtimeCache.delete(conversationId);
    }
    for (const [conversationId, address] of this.probeAddresses) {
      if (address.usedAt < cutoff) this.probeAddresses.delete(conversationId);
    }
  }

  private project(projectId: string): ProjectRow {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
    if (!row) throw new Error('Project not found.');
    return row;
  }

  private scopeId(context: Pick<ConversationContext, 'project_id' | 'user_id'>): string {
    return context.project_id ?? `${UNFILED_SCOPE_PREFIX}${context.user_id}`;
  }

  /**
   * A saved profile holds a live signed-in session, so it is visible only to the
   * person who saved it: another member of the same project is told the same
   * thing as someone naming an id that does not exist.
   */
  private profile(projectId: string, profileId: string, userId: number): VeneerBrowserProfileRow {
    const row = this.db.prepare(
      `SELECT * FROM veneer_browser_profiles
       WHERE id = ? AND project_id = ? AND client_scope = ? AND owner_user_id = ?`,
    ).get(profileId, projectId, this.clientScope(), userId) as VeneerBrowserProfileRow | undefined;
    if (!row) throw new Error('Browser profile not found in this project.');
    return row;
  }

  /**
   * The same lookup with no owner filter. Only for reads about a working copy a
   * chat already runs, and for an account owner's delete-for-cleanup.
   */
  private profileInProject(projectId: string, profileId: string): VeneerBrowserProfileRow {
    const row = this.db.prepare(
      'SELECT * FROM veneer_browser_profiles WHERE id = ? AND project_id = ? AND client_scope = ?',
    ).get(profileId, projectId, this.clientScope()) as VeneerBrowserProfileRow | undefined;
    if (!row) throw new Error('Browser profile not found in this project.');
    return row;
  }

  private session(profileId: string): VeneerBrowserSessionRow | null {
    return (this.db.prepare('SELECT * FROM veneer_browser_sessions WHERE profile_id = ?').get(profileId) as
      | VeneerBrowserSessionRow
      | undefined) ?? null;
  }

  private cloneSession(conversationId: string): VeneerBrowserCloneSessionRow | null {
    return (this.db.prepare(
      'SELECT * FROM veneer_browser_clone_sessions WHERE conversation_id = ? AND client_scope = ?',
    ).get(conversationId, this.clientScope()) as VeneerBrowserCloneSessionRow | undefined) ?? null;
  }

  private cloneSessionsForProfile(profileId: string): VeneerBrowserCloneSessionRow[] {
    return this.db.prepare(
      'SELECT * FROM veneer_browser_clone_sessions WHERE source_profile_id = ? AND client_scope = ?',
    ).all(profileId, this.clientScope()) as VeneerBrowserCloneSessionRow[];
  }

  private captureGrant(conversationId: string): VeneerBrowserCaptureGrantRow | null {
    return (this.db.prepare(
      'SELECT * FROM veneer_browser_capture_grants WHERE conversation_id = ? AND client_scope = ?',
    ).get(conversationId, this.clientScope()) as VeneerBrowserCaptureGrantRow | undefined) ?? null;
  }

  /**
   * A grant unlocks network capture for ONE working copy. It is live only while
   * the chat still runs that exact copy, so a discarded, replaced, promoted, or
   * remotely-vanished copy silently ends the grant even before the row is
   * deleted. Callers on the MCP path must never be able to widen this.
   */
  captureGrantActive(conversationId: string): boolean {
    if (!this.configured()) return false;
    const grant = this.captureGrant(conversationId);
    if (!grant) return false;
    return this.cloneSession(conversationId)?.clone_profile_id === grant.clone_profile_id;
  }

  conversationCapture(userId: number, conversationId: string): VeneerBrowserCaptureView {
    const context = this.conversation(conversationId, userId);
    return { active: this.captureGrantActive(context.id) };
  }

  /**
   * Only the authenticated user reaches this, over HTTP. There is deliberately
   * no MCP tool for it: an injected page must not be able to talk the agent into
   * unlocking traffic inspection on the user's signed-in browser.
   */
  setCaptureGrant(userId: number, conversationId: string, active: boolean): VeneerBrowserCaptureView {
    const context = this.conversation(conversationId, userId);
    const copy = this.cloneSession(context.id);
    if (!active) {
      // Turning capture off is always safe, so it never depends on a live copy.
      if (copy) this.clearCaptureGrant(copy, 'capture.revoked', userId);
      else this.db.prepare(
        'DELETE FROM veneer_browser_capture_grants WHERE conversation_id = ? AND client_scope = ?',
      ).run(context.id, this.clientScope());
      return { active: false };
    }
    // A secret that was just typed into this page has not been submitted yet,
    // so turning capture on now would record the very request body the fill
    // tools refuse to let capture see. The guard clears itself as soon as the
    // page navigates, which is what submitting the form does.
    if (hasLiveSecretField(context.id)) {
      throw new Error('A secret was just filled into this page; navigate away before enabling Advanced capture.');
    }
    if (!copy || !['starting', 'active'].includes(copy.status)) {
      throw new Error('Open this chat browser before you turn on Advanced capture.');
    }
    this.db.prepare(
      `INSERT INTO veneer_browser_capture_grants
         (conversation_id, client_scope, clone_profile_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET client_scope = excluded.client_scope,
         clone_profile_id = excluded.clone_profile_id, granted_by = excluded.granted_by,
         created_at = excluded.created_at`,
    ).run(context.id, this.clientScope(), copy.clone_profile_id, userId, now());
    this.audit(copy.project_id, this.auditProfileId(copy), 'capture.granted', userId, context.id, {
      fresh: copy.mode === 'fresh',
    });
    return { active: true };
  }

  /**
   * Called wherever a clone row is deleted or replaced — not merely stopped —
   * because that is exactly when the copy the user granted stops existing.
   */
  private clearCaptureGrant(
    row: VeneerBrowserCloneSessionRow,
    action: 'capture.expired' | 'capture.revoked',
    actorUserId: number | null = null,
  ): void {
    const grant = this.captureGrant(row.conversation_id);
    if (!grant) return;
    this.db.prepare(
      'DELETE FROM veneer_browser_capture_grants WHERE conversation_id = ? AND client_scope = ?',
    ).run(row.conversation_id, this.clientScope());
    this.audit(row.project_id, this.auditProfileId(row), action, actorUserId, row.conversation_id, {
      fresh: row.mode === 'fresh',
    });
  }

  private audit(
    projectId: string,
    profileId: string,
    action: string,
    actorUserId: number | null = null,
    conversationId: string | null = null,
    metadata: Record<string, string | number | boolean> = {},
  ): void {
    this.db.prepare(
      `INSERT INTO veneer_browser_audit
         (client_scope, project_id, profile_id, actor_user_id, conversation_id, action, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(this.clientScope(), projectId, profileId, actorUserId, conversationId, action, JSON.stringify(metadata));
  }

  private auditProfileId(row: VeneerBrowserCloneSessionRow): string {
    return row.source_profile_id ?? row.clone_profile_id;
  }

  private async stopWorkingCopy(row: VeneerBrowserCloneSessionRow): Promise<void> {
    this.runtimeCache.delete(row.conversation_id);
    try {
      await this.remote.stop(row.project_id, row.clone_profile_id);
    } catch (error) {
      if (!isVeneerBrowserRemoteError(error, 404)) {
        this.db.prepare(
          `UPDATE veneer_browser_clone_sessions SET status = 'error', last_error = ?
           WHERE conversation_id = ? AND clone_profile_id = ?`,
        ).run('The temporary browser did not stop.', row.conversation_id, row.clone_profile_id);
        throw new Error('The temporary browser copy did not stop, so Veneer kept its data. Try again.');
      }
    }
    await this.closeCommandSession(row).catch(() => undefined);
    this.db.prepare(
      `UPDATE veneer_browser_clone_sessions SET status = 'stopped', stopped_at = ?, last_error = NULL
       WHERE conversation_id = ? AND clone_profile_id = ?`,
    ).run(now(), row.conversation_id, row.clone_profile_id);
  }

  private async closeCommandSession(row: VeneerBrowserCloneSessionRow): Promise<void> {
    await this.closeBrowserSession({
      conversationId: row.conversation_id,
      remoteSessionId: row.clone_profile_id,
      workspaceDir: this.dataDir,
    });
  }

  private async removeTemporaryClone(
    row: VeneerBrowserCloneSessionRow,
    actorUserId: number | null = null,
  ): Promise<void> {
    await this.stopWorkingCopy(row);
    try {
      await this.remote.delete(row.project_id, row.clone_profile_id);
    } catch (error) {
      if (!isVeneerBrowserRemoteError(error, 404)) {
        throw new Error('The temporary browser copy stopped, but Veneer could not delete its data. Cleanup will retry automatically.');
      }
    }
    this.audit(row.project_id, this.auditProfileId(row), 'clone.removed', actorUserId, row.conversation_id, {
      fresh: row.mode === 'fresh',
    });
    this.clearCaptureGrant(row, 'capture.expired', actorUserId);
    this.db.prepare(
      'DELETE FROM veneer_browser_clone_sessions WHERE conversation_id = ? AND clone_profile_id = ?',
    ).run(row.conversation_id, row.clone_profile_id);
  }

  private view(row: VeneerBrowserProfileRow): VeneerBrowserProfileView {
    const session = this.session(row.id);
    const cloneCount = (this.db.prepare(
      `SELECT COUNT(*) AS count FROM veneer_browser_clone_sessions
       WHERE source_profile_id = ? AND client_scope = ? AND status IN ('starting', 'active')`,
    ).get(row.id, this.clientScope()) as { count: number }).count;
    const legacyConversation = session?.conversation_id && ['starting', 'active'].includes(session.status)
      ? this.db.prepare('SELECT id, title FROM conversations WHERE id = ?').get(session.conversation_id) as
          | { id: string; title: string | null }
          | undefined
      : undefined;
    const copyConversation = this.db.prepare(
      `SELECT c.id, c.title FROM veneer_browser_clone_sessions copy
       JOIN conversations c ON c.id = copy.conversation_id
       WHERE copy.source_profile_id = ? AND copy.client_scope = ?
         AND copy.status IN ('starting', 'active')
       ORDER BY copy.last_used_at DESC LIMIT 1`,
    ).get(row.id, this.clientScope()) as { id: string; title: string | null } | undefined;
    const activeConversation = legacyConversation ?? copyConversation;
    return {
      id: row.id,
      projectId: row.project_id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      active: session?.status === 'active' || cloneCount > 0,
      status: session?.status === 'active' || cloneCount > 0 ? 'active' : session?.status ?? 'stopped',
      activeConversationId: activeConversation?.id ?? null,
      activeConversationTitle: activeConversation?.title ?? null,
      activeCloneCount: cloneCount,
      lastUsedAt: session?.last_used_at ?? row.last_used_at,
      createdAt: row.created_at,
    };
  }

  private profilesInScope(scopeId: string, userId: number): VeneerBrowserProfileView[] {
    return (this.db.prepare(
      `SELECT * FROM veneer_browser_profiles
       WHERE project_id = ? AND client_scope = ? AND owner_user_id = ?
       ORDER BY updated_at DESC, name`,
    ).all(scopeId, this.clientScope(), userId) as VeneerBrowserProfileRow[]).map((row) => this.view(row));
  }

  /**
   * Cleanup only. An account owner may see that a teammate's saved login exists
   * here and delete it; nothing else about it is theirs to use or change.
   */
  private otherProfilesInScope(scopeId: string, userId: number): VeneerBrowserOtherProfileView[] {
    return (this.db.prepare(
      `SELECT p.*, u.display_name AS owner_name FROM veneer_browser_profiles p
       JOIN users u ON u.id = p.owner_user_id
       WHERE p.project_id = ? AND p.client_scope = ? AND p.owner_user_id <> ?
       ORDER BY p.updated_at DESC, p.name`,
    ).all(scopeId, this.clientScope(), userId) as Array<VeneerBrowserProfileRow & { owner_name: string }>)
      .map((row) => ({ ...this.view(row), ownerName: row.owner_name }));
  }

  listProfiles(userId: number, role: UserRow['role'], projectId: string): VeneerBrowserProfileList {
    this.project(projectId);
    return {
      profiles: this.profilesInScope(projectId, userId),
      defaultProfileId: this.defaultProfileIdInScope(projectId, userId),
      others: role === 'owner' ? this.otherProfilesInScope(projectId, userId) : [],
    };
  }

  listProfilesForConversation(userId: number, conversationId: string): VeneerBrowserProfileView[] {
    const context = this.conversation(conversationId, userId, true);
    if (context.user_id !== userId) {
      const selected = this.selectedProfile(context);
      return selected ? [this.view(selected)] : [];
    }
    return this.profilesInScope(this.scopeId(context), userId);
  }

  private defaultProfileIdInScope(scopeId: string, userId: number): string | null {
    const row = this.db.prepare(
       `SELECT p.id FROM veneer_browser_project_settings s
       JOIN veneer_browser_profiles p ON p.id = s.default_profile_id
       WHERE s.project_id = ? AND s.client_scope = ? AND s.user_id = ?
         AND p.project_id = s.project_id AND p.client_scope = s.client_scope
         AND p.owner_user_id = s.user_id`,
    ).get(scopeId, this.clientScope(), userId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  defaultProfileId(userId: number, projectId: string): string | null {
    this.project(projectId);
    return this.defaultProfileIdInScope(projectId, userId);
  }

  private defaultProfile(scopeId: string, userId: number): VeneerBrowserProfileRow | null {
    const profileId = this.defaultProfileIdInScope(scopeId, userId);
    return profileId ? this.profile(scopeId, profileId, userId) : null;
  }

  private async createProfileInScope(
    userId: number,
    scopeId: string,
    nameValue: unknown,
  ): Promise<VeneerBrowserProfileView> {
    const name = cleanName(nameValue);
    const profileId = crypto.randomUUID();
    const scope = this.clientScope();
    await this.remote.create(scopeId, profileId, name);
    const timestamp = now();
    try {
      this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO veneer_browser_profiles
             (id, client_scope, project_id, name, generation, created_by, owner_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        ).run(profileId, scope, scopeId, name, userId, userId, timestamp, timestamp);
        this.db.prepare(
          `INSERT INTO veneer_browser_project_settings (client_scope, project_id, user_id, default_profile_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(client_scope, project_id, user_id) DO UPDATE SET
             default_profile_id = COALESCE(veneer_browser_project_settings.default_profile_id, excluded.default_profile_id),
             updated_at = excluded.updated_at`,
        ).run(scope, scopeId, userId, profileId, timestamp);
      })();
    } catch (error) {
      await this.remote.delete(scopeId, profileId).catch(() => undefined);
      throw error;
    }
    this.audit(scopeId, profileId, 'profile.created', userId);
    return this.view(this.profile(scopeId, profileId, userId));
  }

  async createProfile(userId: number, projectId: string, nameValue: unknown): Promise<VeneerBrowserProfileView> {
    this.project(projectId);
    return this.createProfileInScope(userId, projectId, nameValue);
  }

  async renameProfile(
    userId: number,
    projectId: string,
    profileId: string,
    nameValue: unknown,
  ): Promise<VeneerBrowserProfileView> {
    this.project(projectId);
    this.profile(projectId, profileId, userId);
    const name = cleanName(nameValue);
    await this.remote.rename(projectId, profileId, name);
    this.db.prepare('UPDATE veneer_browser_profiles SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), profileId);
    this.audit(projectId, profileId, 'profile.renamed', userId);
    return this.view(this.profile(projectId, profileId, userId));
  }

  /**
   * An account owner may delete a teammate's saved login as cleanup — a profile
   * outlives the person who made it — but nothing here lets them use one.
   */
  async deleteProfile(
    userId: number,
    role: UserRow['role'],
    projectId: string,
    profileId: string,
  ): Promise<void> {
    this.project(projectId);
    const profile = role === 'owner'
      ? this.profileInProject(projectId, profileId)
      : this.profile(projectId, profileId, userId);
    if (['starting', 'active'].includes(this.session(profileId)?.status ?? 'stopped')) {
      throw new Error('Stop the active browser before you delete this profile.');
    }
    const clones = this.cloneSessionsForProfile(profileId);
    if (clones.some((row) => ['starting', 'active'].includes(row.status))) {
      throw new Error('Stop all temporary browser copies before you delete this profile.');
    }
    for (const clone of clones) await this.removeTemporaryClone(clone);
    await this.remote.delete(projectId, profileId);
    this.audit(projectId, profileId, 'profile.deleted', userId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM veneer_browser_profiles WHERE id = ? AND project_id = ?').run(profileId, projectId);
      // The replacement default belongs to whoever owned the deleted profile,
      // which is not the actor when an account owner is cleaning up.
      const fallback = this.db.prepare(
        `SELECT id FROM veneer_browser_profiles
         WHERE project_id = ? AND client_scope = ? AND owner_user_id = ?
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(projectId, this.clientScope(), profile.owner_user_id) as { id: string } | undefined;
      if (fallback) {
        this.db.prepare(
          `INSERT INTO veneer_browser_project_settings (client_scope, project_id, user_id, default_profile_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(client_scope, project_id, user_id) DO UPDATE SET
             default_profile_id = excluded.default_profile_id, updated_at = excluded.updated_at`,
        ).run(this.clientScope(), projectId, profile.owner_user_id, fallback.id, now());
      }
    })();
  }

  setDefaultProfile(userId: number, projectId: string, profileId: string): void {
    this.project(projectId);
    this.profile(projectId, profileId, userId);
    this.db.prepare(
      `INSERT INTO veneer_browser_project_settings (client_scope, project_id, user_id, default_profile_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(client_scope, project_id, user_id) DO UPDATE SET
         default_profile_id = excluded.default_profile_id, updated_at = excluded.updated_at`,
    ).run(this.clientScope(), projectId, userId, profileId, now());
    this.audit(projectId, profileId, 'profile.default_selected', userId);
  }

  selectForConversation(userId: number, conversationId: string, profileId: string): void {
    const context = this.conversation(conversationId, userId);
    const scopeId = this.scopeId(context);
    const profile = this.profile(scopeId, profileId, userId);
    const selected = this.selectedProfile(context);
    const working = this.cloneSession(context.id);
    if (selected?.id !== profile.id && working && ['starting', 'active'].includes(working.status)) {
      throw new Error('Stop this chat browser before you attach a different profile.');
    }
    this.db.prepare(
      `INSERT INTO veneer_browser_conversation_profiles
         (conversation_id, client_scope, project_id, profile_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET client_scope = excluded.client_scope,
         project_id = excluded.project_id, profile_id = excluded.profile_id, updated_at = excluded.updated_at`,
    ).run(conversationId, this.clientScope(), scopeId, profileId, now(), now());
    this.audit(profile.project_id, profile.id, 'profile.attached', userId, conversationId);
  }

  private conversation(conversationId: string, userId?: number, sharedBrowser = false): ConversationContext {
    const row = this.db.prepare(
      `SELECT c.*, p.slug AS project_slug, p.root_dir AS project_root_dir, a.slug AS assistant_slug
       FROM conversations c JOIN assistants a ON a.id = c.assistant_id
       LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
    ).get(conversationId) as ConversationContext | undefined;
    if (!row) {
      throw new Error('Veneer Browser requires one of your chats.');
    }
    if (userId !== undefined && row.user_id !== userId) {
      // A shared business bot's explicitly assigned browser is operational
      // context for its authorized teammates. This grants no profile management
      // or access to the creator's other saved logins/default profile.
      const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(userId) as UserRow | undefined;
      const bot = this.db.prepare('SELECT 1 FROM bot_registrations r JOIN business_bot_members m ON m.conversation_id=r.conversation_id WHERE r.conversation_id=? AND r.active=1 AND m.team_id=?').get(row.id, row.business_team_id);
      if (!sharedBrowser || !row.business_team_id || !bot || !user || isEmployee(this.db, userId) || !canSendToConversation(user, row, this.db)) {
        throw new Error('Veneer Browser requires one of your chats.');
      }
      const copy = this.cloneSession(row.id);
      if (copy?.source_profile_id && copy.source_profile_id !== this.selectedProfile(row)?.id) {
        throw new Error('The chat owner must assign this browser profile before teammates can use it.');
      }
    }
    return { ...row, browser_actor_id: userId };
  }

  private selectedProfile(context: ConversationContext): VeneerBrowserProfileRow | null {
    const scopeId = this.scopeId(context);
    return (this.db.prepare(
      `SELECT p.* FROM veneer_browser_profiles p
       JOIN veneer_browser_conversation_profiles c ON c.profile_id = p.id
       WHERE c.conversation_id = ? AND c.project_id = ? AND c.client_scope = ?
         AND p.project_id = c.project_id AND p.client_scope = c.client_scope
         AND p.owner_user_id = ? LIMIT 1`,
    ).get(context.id, scopeId, this.clientScope(), context.user_id) as VeneerBrowserProfileRow | undefined) ?? null;
  }

  private effectiveProfile(context: ConversationContext): VeneerBrowserProfileRow | null {
    return this.selectedProfile(context) ?? (context.browser_actor_id !== undefined && context.browser_actor_id !== context.user_id
      ? null : this.defaultProfile(this.scopeId(context), context.user_id));
  }

  async createForConversation(userId: number, conversationId: string, nameValue: unknown): Promise<VeneerBrowserSessionView> {
    const context = this.conversation(conversationId, userId);
    const name = cleanName(nameValue);
    return this.queue(`conversation:${context.id}`).run(async () => {
      if (this.cloneSession(context.id)) throw new Error('Stop this chat browser before you create a saved profile.');
      const profile = await this.createProfileInScope(userId, this.scopeId(context), name);
      this.selectForConversation(userId, context.id, profile.id);
      return this.conversationSession(userId, conversationId);
    });
  }

  private async ensureProfileCopy(
    context: ConversationContext,
    profile: VeneerBrowserProfileRow,
  ): Promise<VeneerBrowserCloneSessionRow> {
    let existing = this.cloneSession(context.id);
    if (existing && (existing.mode !== 'profile' || existing.source_profile_id !== profile.id)) {
      await this.removeTemporaryClone(existing, context.user_id);
      existing = null;
    }
    if (existing) {
      try {
        await this.remote.status(existing.project_id, existing.clone_profile_id);
        return existing;
      } catch (error) {
        if (!isVeneerBrowserRemoteError(error, 404)) throw error;
        await this.closeCommandSession(existing).catch(() => undefined);
        this.clearCaptureGrant(existing, 'capture.expired', context.user_id);
        this.runtimeCache.delete(existing.conversation_id);
        this.db.prepare(
          'DELETE FROM veneer_browser_clone_sessions WHERE conversation_id = ? AND clone_profile_id = ?',
        ).run(existing.conversation_id, existing.clone_profile_id);
      }
    }

    const cloneProfileId = crypto.randomUUID();
    const timestamp = now();
    let sourceGeneration: number;
    try {
      ({ sourceGeneration } = await this.remote.clone(
        profile.project_id,
        profile.id,
        cloneProfileId,
        `Working copy of ${profile.name}`,
      ));
    } catch (error) {
      if (isVeneerBrowserRemoteError(error, 429)) {
        throw new Error('The browser limit is full. Stop an idle browser, then try again.');
      }
      throw new Error('Veneer Browser could not make a working copy. The saved profile is unchanged.');
    }
    try {
      this.db.transaction(() => {
        this.db.prepare('UPDATE veneer_browser_profiles SET generation = ? WHERE id = ?')
          .run(sourceGeneration, profile.id);
        this.db.prepare(
          `INSERT INTO veneer_browser_clone_sessions
             (conversation_id, client_scope, project_id, source_profile_id, source_generation,
              clone_profile_id, mode, status, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, 'profile', 'stopped', ?, ?)`,
        ).run(context.id, this.clientScope(), profile.project_id, profile.id, sourceGeneration,
          cloneProfileId, timestamp, timestamp);
      })();
    } catch (error) {
      await this.remote.delete(profile.project_id, cloneProfileId).catch(() => undefined);
      throw error;
    }
    this.audit(profile.project_id, profile.id, 'clone.created', context.user_id, context.id, {
      sourceGeneration,
    });
    return this.cloneSession(context.id)!;
  }

  /**
   * The fast path: one round trip that clones or adopts a pre-warmed copy AND
   * starts it, so a chat's first command does not wait for a full copy. The
   * manager decides which copy it used, so the id it returns — not the one asked
   * for — is what gets recorded. A manager that predates the route answers 404,
   * exactly like an unknown source profile does, and both mean the same thing
   * here: use the older clone-then-start sequence instead.
   */
  private async openProfileCopy(
    context: ConversationContext,
    profile: VeneerBrowserProfileRow,
  ): Promise<ConversationRuntime | null> {
    let opened: RemoteOpenResult;
    try {
      opened = await this.remote.open(profile.project_id, profile.id, crypto.randomUUID(), 'agent');
    } catch (error) {
      if (isVeneerBrowserRemoteError(error, 404)) return null;
      if (isVeneerBrowserRemoteError(error, 429)) {
        throw new Error('The browser limit is full. Stop an idle browser, then try again.');
      }
      throw new Error('Veneer Browser could not make a working copy. The saved profile is unchanged.');
    }
    const replaced = this.cloneSession(context.id);
    // The copy this chat had is now superseded, so it is stopped and deleted
    // remotely rather than merely forgotten here: dropping the row alone would
    // leave a signed-in browser running with nothing left pointing at it.
    if (replaced && replaced.clone_profile_id !== opened.cloneProfileId) {
      await this.removeTemporaryClone(replaced, context.user_id);
    }
    const timestamp = now();
    try {
      this.db.transaction(() => {
        this.db.prepare('UPDATE veneer_browser_profiles SET generation = ? WHERE id = ?')
          .run(opened.sourceGeneration, profile.id);
        this.db.prepare(
          `INSERT INTO veneer_browser_clone_sessions
             (conversation_id, client_scope, project_id, source_profile_id, source_generation,
              clone_profile_id, mode, status, remote_runtime_id, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, 'profile', 'active', ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET source_profile_id = excluded.source_profile_id,
             source_generation = excluded.source_generation, status = 'active',
             remote_runtime_id = excluded.remote_runtime_id, last_used_at = excluded.last_used_at,
             stopped_at = NULL, last_error = NULL`,
        ).run(context.id, this.clientScope(), profile.project_id, profile.id, opened.sourceGeneration,
          opened.cloneProfileId, opened.runtimeId ?? null, timestamp, timestamp);
      })();
    } catch (error) {
      // Stopped rather than deleted: the copy may be one the manager adopted, so
      // ending the runtime is this side's business and its data is the manager's.
      await this.remote.stop(profile.project_id, opened.cloneProfileId).catch(() => undefined);
      throw error;
    }
    this.audit(profile.project_id, profile.id, 'clone.created', context.user_id, context.id, {
      sourceGeneration: opened.sourceGeneration,
      adopted: opened.adopted,
    });
    this.audit(profile.project_id, profile.id, 'clone.runtime_started', context.user_id, context.id, {
      fresh: false,
    });
    // The address that came back is a full agent ticket, so the first command
    // that follows needs no round trip of its own — but only when this call took
    // the tunnel. A LAN reply carries a LAN address, and agent-browser cannot
    // reach one, so that ticket is dropped and the first command mints its own.
    if (!this.remote.cdpCaFile(opened.cdpUrl)) this.rememberTicket(context.id, opened);
    return { row: this.cloneSession(context.id)!, auditProfileId: profile.id };
  }

  private async ensureFreshCopy(context: ConversationContext): Promise<VeneerBrowserCloneSessionRow> {
    const existing = this.cloneSession(context.id);
    if (existing) throw new Error('Stop or save this chat browser before you open a signed-out browser.');
    const scopeId = this.scopeId(context);
    const cloneProfileId = crypto.randomUUID();
    const timestamp = now();
    try {
      await this.remote.createTemporary(scopeId, cloneProfileId, 'Signed-out working copy');
    } catch (error) {
      if (isVeneerBrowserRemoteError(error, 429)) {
        throw new Error('The browser limit is full. Stop an idle browser, then try again.');
      }
      throw new Error('Veneer Browser could not make a signed-out working copy.');
    }
    try {
      this.db.prepare(
        `INSERT INTO veneer_browser_clone_sessions
           (conversation_id, client_scope, project_id, source_profile_id, source_generation,
            clone_profile_id, mode, status, created_at, last_used_at)
         VALUES (?, ?, ?, NULL, NULL, ?, 'fresh', 'stopped', ?, ?)`,
      ).run(context.id, this.clientScope(), scopeId, cloneProfileId, timestamp, timestamp);
    } catch (error) {
      await this.remote.delete(scopeId, cloneProfileId).catch(() => undefined);
      throw error;
    }
    this.audit(scopeId, cloneProfileId, 'clone.created', context.user_id, context.id, { fresh: true });
    return this.cloneSession(context.id)!;
  }

  private async startWorkingCopy(
    context: ConversationContext,
    row: VeneerBrowserCloneSessionRow,
  ): Promise<ConversationRuntime> {
    const timestamp = now();
    this.db.prepare(
      `UPDATE veneer_browser_clone_sessions SET status = 'starting', last_used_at = ?,
         stopped_at = NULL, last_error = NULL WHERE conversation_id = ? AND clone_profile_id = ?`,
    ).run(timestamp, context.id, row.clone_profile_id);
    try {
      const remote = await this.remote.start(row.project_id, row.clone_profile_id);
      this.db.prepare(
        `UPDATE veneer_browser_clone_sessions SET remote_runtime_id = ?, status = 'active',
           last_used_at = ?, stopped_at = NULL, last_error = NULL
         WHERE conversation_id = ? AND clone_profile_id = ? AND client_scope = ?`,
      ).run(remote.runtimeId ?? null, timestamp, context.id, row.clone_profile_id, this.clientScope());
      const auditProfileId = this.auditProfileId(row);
      this.audit(row.project_id, auditProfileId, 'clone.runtime_started', context.user_id, context.id, {
        fresh: row.mode === 'fresh',
      });
      return { row: this.cloneSession(context.id)!, auditProfileId };
    } catch (error) {
      this.db.prepare(
        `UPDATE veneer_browser_clone_sessions SET status = 'error', last_error = ?
         WHERE conversation_id = ? AND clone_profile_id = ?`,
      ).run('The temporary browser runtime did not start.', context.id, row.clone_profile_id);
      if (isVeneerBrowserRemoteError(error, 429)) {
        throw new Error('The browser limit is full. Stop an idle browser, then try again.');
      }
      throw new Error('The temporary browser copy did not start. Its data was kept for a safe retry.');
    }
  }

  private async startForContext(context: ConversationContext): Promise<ConversationRuntime> {
    const existing = this.cloneSession(context.id);
    if (existing) {
      const key = existing.source_profile_id ?? existing.clone_profile_id;
      return this.queue(key).run(() => this.startWorkingCopy(context, existing));
    }
    const profile = this.effectiveProfile(context);
    if (!profile) {
      return this.queue(`fresh:${context.id}`).run(async () => {
        const row = await this.ensureFreshCopy(context);
        return this.startWorkingCopy(context, row);
      });
    }
    if (!this.selectedProfile(context)) this.selectForConversation(context.user_id, context.id, profile.id);
    return this.queue(profile.id).run(async () => {
      const opened = await this.openProfileCopy(context, profile);
      if (opened) return opened;
      const row = await this.ensureProfileCopy(context, profile);
      return this.startWorkingCopy(context, row);
    });
  }

  /**
   * A hot chat re-checks the remote runtime at most once every ACTIVE_CHECK_MS.
   * The database updates still run every time; only the round trip is skipped.
   */
  private async conversationRuntime(context: ConversationContext): Promise<ConversationRuntime> {
    const cached = this.runtimeCache.get(context.id);
    if (cached && Date.now() - cached.activeCheckedAt < ACTIVE_CHECK_MS) {
      const row = this.cloneSession(context.id);
      if (row && row.status === 'active') return { row, auditProfileId: this.auditProfileId(row) };
    }
    const runtime = await this.startForContext(context);
    const entry = this.runtimeCache.get(context.id);
    this.runtimeCache.set(context.id, {
      activeCheckedAt: Date.now(),
      ...(entry?.ticket ? { ticket: entry.ticket } : {}),
    });
    return runtime;
  }

  private rememberTicket(conversationId: string, ticket: RemoteTicket): HeldTicket {
    const entry = this.runtimeCache.get(conversationId);
    const held: HeldTicket = {
      cdpUrl: ticket.cdpUrl,
      viewerUrl: ticket.viewerUrl,
      expiresAt: ticket.expiresAt,
      issuedAt: Date.now(),
      useCount: 0,
    };
    this.runtimeCache.set(conversationId, {
      activeCheckedAt: entry?.activeCheckedAt ?? Date.now(),
      ticket: held,
    });
    return held;
  }

  private async agentTicket(conversationId: string, row: VeneerBrowserCloneSessionRow): Promise<RemoteTicket> {
    const held = this.runtimeCache.get(conversationId)?.ticket;
    // The gateway checks a ticket's expiry and connection budget only when a
    // NEW WebSocket dials in; an established connection outlives both. So an
    // address the daemon has already connected with (useCount > 0) stays valid
    // for as long as that connection does — and if it ever goes stale under
    // the daemon, the failed command already deletes this cache and the retry
    // mints a fresh ticket.
    const reusable = held && (
      held.useCount > 0
      || (Date.now() - held.issuedAt < TICKET_REUSE_MS && Date.parse(held.expiresAt) > Date.now())
    );
    const ticket = reusable
      ? held!
      : this.rememberTicket(conversationId, await this.remote.ticket(row.project_id, row.clone_profile_id, 'agent'));
    ticket.useCount += 1;
    return ticket;
  }

  private async runOnCopy(
    context: ConversationContext,
    runtime: ConversationRuntime,
    args: unknown,
    options: { timeoutMs?: number; redact?: string[]; beforeCommand?: () => void } = {},
  ): Promise<BrowserRunResult> {
    const ticket = await this.agentTicket(context.id, runtime.row);
    this.probeAddresses.set(context.id, {
      cdpUrl: ticket.cdpUrl,
      cloneProfileId: runtime.row.clone_profile_id,
      usedAt: Date.now(),
    });
    // Only a LAN address needs the pinned certificate; a tunnel address is
    // already trusted by the public roots agent-browser ships with.
    const cdpCaFile = this.remote.cdpCaFile(ticket.cdpUrl);
    return this.runBrowser(args, {
      conversationId: context.id,
      workspaceDir: this.workspace(context),
      timeoutMs: options.timeoutMs,
      // Carried all the way to the spawn so a filled password cannot come back
      // in the command echo, the CLI output, or a timeout message.
      ...(options.redact?.length ? { redact: options.redact } : {}),
      remoteCdpUrl: ticket.cdpUrl,
      remoteSessionId: runtime.row.clone_profile_id,
      trustedCdpOrigin: ticket.cdpUrl,
      ...(cdpCaFile ? { cdpCaFile } : {}),
    });
  }

  async stopProfile(userId: number, projectId: string, profileId: string): Promise<VeneerBrowserProfileView> {
    this.project(projectId);
    const profile = this.profile(projectId, profileId, userId);
    return this.queue(profileId).run(async () => {
      await this.remote.stop(projectId, profileId);
      this.db.prepare(
        `UPDATE veneer_browser_sessions SET conversation_id = NULL, status = 'stopped',
         stopped_at = ?, last_error = NULL WHERE profile_id = ? AND project_id = ?`,
      ).run(now(), profileId, projectId);
      for (const clone of this.cloneSessionsForProfile(profileId)) await this.removeTemporaryClone(clone);
      this.audit(projectId, profileId, 'runtime.stopped', userId);
      return this.view(profile);
    });
  }

  async refreshProfile(userId: number, projectId: string, profileId: string): Promise<VeneerBrowserProfileView> {
    this.project(projectId);
    return this.refreshProfileRow(this.profile(projectId, profileId, userId));
  }

  /** Reconciliation reaches this without an acting user, so it takes the row. */
  private async refreshProfileRow(profile: VeneerBrowserProfileRow): Promise<VeneerBrowserProfileView> {
    const { project_id: projectId, id: profileId } = profile;
    try {
      const remote = await this.remote.status(projectId, profileId);
      const status = remote.active ? 'active' : 'stopped';
      this.db.prepare(
        `INSERT INTO veneer_browser_sessions (profile_id, client_scope, project_id, remote_runtime_id, status, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET remote_runtime_id = excluded.remote_runtime_id,
           conversation_id = CASE WHEN excluded.status = 'stopped' THEN NULL ELSE veneer_browser_sessions.conversation_id END,
           status = excluded.status, last_used_at = excluded.last_used_at, last_error = NULL`,
      ).run(profileId, this.clientScope(), projectId, remote.runtimeId ?? null, status, now());
    } catch {
      // A manager outage is not proof that a saved profile runtime stopped.
    }
    return this.view(profile);
  }

  async viewerTicketForConversation(
    userId: number,
    conversationId: string,
  ): Promise<{ ticket: string; caFile: string | null }> {
    let context = this.conversation(conversationId, userId, true);
    return this.queue(`conversation:${context.id}`).run(async () => {
      context = this.conversation(conversationId, userId, true);
      const stored = this.cloneSession(context.id);
      const copy = stored ? await this.refreshCloneSession(stored) : null;
      if (!copy || copy.status !== 'active') {
        throw new Error('Open this chat browser before you connect the viewer.');
      }
      const connection = await this.remote.viewerConnection(copy.project_id, copy.clone_profile_id);
      return { ticket: connection.viewerUrl, caFile: connection.caFile };
    });
  }

  private workspace(context: ConversationContext): string {
    if (context.project_root_dir) return path.resolve(context.project_root_dir);
    if (context.project_slug) return path.join(this.dataDir, 'workspaces', 'projects', context.project_slug);
    return path.join(this.dataDir, 'workspaces', context.assistant_slug);
  }

  /**
   * Whether a failed command means the working copy itself is gone, rather than
   * the page simply saying no. An ordinary page-level error — a stale @ref, an
   * element that never appeared — is a real answer and is returned as it stands:
   * re-running the click that "failed" could repeat a side effect it already had.
   */
  private async workingCopyLost(
    context: ConversationContext,
    failure: BrowserRunResult | null,
  ): Promise<boolean> {
    const stored = this.cloneSession(context.id);
    const refreshed = stored ? await this.refreshCloneSession(stored) : null;
    const runtimeGone = !refreshed || refreshed.status !== 'active';
    // A command that threw produced no evidence of its own — it may have been
    // killed on this side's timeout or output cap long after it reached the
    // page — so only the copy actually being gone justifies running it again.
    if (!failure) return runtimeGone;
    if (runtimeGone) return true;
    return LOST_CONNECTION.test(failure.stderr);
  }

  /**
   * One command inside an already-held conversation slot.
   *
   * `recover` is the existing lost-copy retry: a failure is held, not acted on,
   * until the copy behind it has been checked, and only a copy that is actually
   * gone justifies running the command again. A command that produced no result
   * at all on a live copy comes back with `result: null` and its `thrown` error;
   * the caller decides whether to rethrow it or record it as a step failure.
   */
  private async runInSlot(
    context: ConversationContext,
    userId: number,
    runtime: ConversationRuntime,
    args: unknown,
    options: { recover: boolean; timeoutMs?: number; redact?: string[]; auditCommand?: string },
  ): Promise<{ runtime: ConversationRuntime; result: BrowserRunResult | null; thrown: unknown }> {
    const passthrough = {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.redact?.length ? { redact: options.redact } : {}),
    };
    let current = runtime;
    let thrown: unknown = null;
    let result = await this.runOnCopy(context, current, args, passthrough).catch((error: unknown) => {
      thrown = error;
      return null;
    });
    if (!result || result.exitCode !== 0) {
      // Whatever this chat had cached is suspect the moment a command fails.
      this.runtimeCache.delete(context.id);
      if (options.recover && await this.workingCopyLost(context, result)) {
        await this.closeCommandSession(current.row).catch(() => undefined);
        // The retry carries nothing forward: it re-opens the copy and takes a
        // new ticket. A second failure is the real answer, so it is not
        // caught, and only this attempt is recorded and audited.
        current = await this.startForContext(context);
        result = await this.runOnCopy(context, current, args, passthrough);
      } else if (!result) {
        // The copy is still there, so whatever went wrong on this side is the
        // answer. Re-running it could repeat a side effect it already had.
        return { runtime: current, result: null, thrown };
      }
    }
    const outcome = result!;
    const timestamp = now();
    this.db.prepare(
      `UPDATE veneer_browser_clone_sessions SET status = 'active', last_used_at = ?,
         last_error = ?, stopped_at = NULL
       WHERE clone_profile_id = ? AND conversation_id = ? AND client_scope = ?`,
    ).run(timestamp, outcome.exitCode ? 'Browser command failed.' : null,
      current.row.clone_profile_id, context.id, this.clientScope());
    this.audit(current.row.project_id, current.auditProfileId, 'command.executed', userId, context.id, {
      command: options.auditCommand ?? auditCommandName(args),
      success: outcome.exitCode === 0,
    });
    return { runtime: current, result: outcome, thrown: null };
  }

  async fetchUrl(userId: number, conversationId: string, input: unknown): Promise<ReadUrlResult> {
    const parsed = ReadUrlSchema.safeParse(input);
    if (!parsed.success) return readUrlFailure('invalid_request', 'Supply an HTTP(S) URL, valid readiness options, and supported timeout/output limits.');
    const context = this.conversation(conversationId, userId, true);
    try {
      return await this.queue(`conversation:${context.id}`).run(async () => {
        // Recheck after waiting; chat ownership may have changed in the queue.
        const currentContext = this.conversation(conversationId, userId, true);
        const user = this.db.prepare('SELECT status FROM users WHERE id = ?').get(userId) as { status: string } | undefined;
        if (user?.status !== 'active') return readUrlFailure('access_denied', 'An active chat owner is required.');
        const runtime = await this.conversationRuntime(currentContext);
        // A fresh connection needs its own ticket. Never consume or rotate the
        // agent-browser daemon's cached ticket or change its selected tab.
        const ticket = await this.remote.ticket(runtime.row.project_id, runtime.row.clone_profile_id, 'agent');
        const result = await this.readUrl(parsed.data, {
          cdpUrl: ticket.cdpUrl, caFile: this.remote.cdpCaFile(ticket.cdpUrl),
        });
        this.db.prepare('UPDATE veneer_browser_clone_sessions SET last_used_at = ? WHERE conversation_id = ? AND clone_profile_id = ?')
          .run(now(), context.id, runtime.row.clone_profile_id);
        this.audit(runtime.row.project_id, runtime.auditProfileId, 'command.executed', userId, context.id, {
          command: 'fetch_url', success: result.ok,
        });
        return result;
      }, { waitTimeoutMs: parsed.data.timeout_ms });
    } catch {
      return readUrlFailure('browser_unavailable', 'The browser is busy or unavailable. Try again when it is ready.');
    }
  }

  async runCommand(
    userId: number,
    conversationId: string,
    args: unknown,
    timeoutMs?: number,
    options: { redact?: string[] } = {},
  ): Promise<BrowserRunResult> {
    let context = this.conversation(conversationId, userId, true);
    return this.queue(`conversation:${context.id}`).run(async () => {
      context = this.conversation(conversationId, userId, true);
      const runtime = await this.conversationRuntime(context);
      const step = await this.runInSlot(context, userId, runtime, args, {
        recover: true,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(options.redact?.length ? { redact: options.redact } : {}),
      });
      if (!step.result) throw step.thrown;
      return step.result;
    });
  }

  /**
   * Run a fixed sequence of commands inside ONE conversation slot.
   *
   * A coordinate click is `mouse move`, `mouse down`, `mouse up`. Those three
   * must not be interleaved with any other chat command, and — unlike a single
   * command — they must never be replayed: the lost-copy retry that is safe for
   * a cold first command would press the button twice halfway through a drag.
   * So only the first member may recover a copy that was never really there;
   * every later member aborts the sequence on its first failure. If a button
   * was pressed and a later `mouse up` will now never run, one best-effort
   * release is attempted so the browser is not left with a held button.
   */
  async runCommands(
    userId: number,
    conversationId: string,
    commands: string[][],
    options: { timeoutMs?: number; redact?: string[]; beforeCommand?: () => void } = {},
  ): Promise<BrowserSequenceResult> {
    if (!Array.isArray(commands) || !commands.length) {
      throw new Error('A browser sequence needs at least one command.');
    }
    let context = this.conversation(conversationId, userId, true);
    return this.queue(`conversation:${context.id}`).run(async () => {
      context = this.conversation(conversationId, userId, true);
      let runtime = await this.conversationRuntime(context);
      // A redacted sequence must not hand its own argv back either: the steps
      // and the failure record both carry the command line verbatim.
      const secrets = (options.redact ?? []).filter(Boolean);
      const safe = (argv: string[]): string[] => (secrets.length
        ? argv.map((arg) => secrets.reduce((acc, secret) => acc.split(secret).join('[redacted]'), arg))
        : argv);
      const steps: BrowserSequenceStep[] = [];
      let failure: BrowserSequenceFailure | null = null;
      let held: { button: string; index: number } | null = null;

      for (let index = 0; index < commands.length; index += 1) {
        options.beforeCommand?.();
        const args = commands[index]!;
        const auditCommand = sequenceAuditName(args);
        let step: { runtime: ConversationRuntime; result: BrowserRunResult | null; thrown: unknown };
        try {
          step = await this.runInSlot(context, userId, runtime, args, {
            // Only a cold first command may re-open the copy and run again.
            recover: index === 0,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.redact?.length ? { redact: options.redact } : {}),
            auditCommand,
          });
        } catch (error) {
          // Reachable only from the first member's recovery attempt.
          failure = { index, command: safe(args), output: `Error: ${(error as Error).message}` };
          break;
        }
        runtime = step.runtime;
        if (!step.result) {
          this.audit(runtime.row.project_id, runtime.auditProfileId, 'command.executed', userId, context.id, {
            command: auditCommand,
            success: false,
          });
          failure = { index, command: safe(args), output: `Error: ${(step.thrown as Error)?.message ?? 'The browser command did not finish.'}` };
          break;
        }
        steps.push({ command: safe(args), result: step.result });
        if (step.result.exitCode !== 0) {
          failure = { index, command: safe(args), output: commandOutput(step.result) };
          break;
        }
        if (isMouseVerb(args, 'down')) held = { button: args[2] ?? 'left', index };
        else if (isMouseVerb(args, 'up')) held = null;
      }

      let released = false;
      // `held` alone is the complete signal: it is set once a `mouse down`
      // succeeds and cleared only once a `mouse up` succeeds, so it is still
      // truthy here whether the abort happened before the up was ever
      // attempted or ON the up itself (e.g. navigation between down and up
      // making the up fail) — both leave a button physically pressed.
      if (failure && held) {
        released = true;
        // Best effort only: the sequence already failed, and a failed release
        // must not replace the answer the agent needs to see.
        await this.runInSlot(context, userId, runtime, ['mouse', 'up', held.button], {
          recover: false,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          auditCommand: 'mouse up',
        }).catch(() => undefined);
      }
      return { steps, failure, released };
    });
  }

  /**
   * A read-only side question asked after a command already failed.
   *
   * It borrows the address this chat already has and nothing else: it never
   * mints a ticket, never starts or re-opens a working copy, never touches the
   * runtime cache, writes no audit row and no last_error, and swallows every
   * failure. A chat with no cached runtime gets `null` immediately, because
   * finding out would cost exactly the round trips this is meant to avoid.
   */
  async probeCommand(userId: number, conversationId: string, args: string[]): Promise<string | null> {
    try {
      const context = this.conversation(conversationId, userId, true);
      const row = this.cloneSession(context.id);
      if (!row || row.status !== 'active') return null;
      const last = this.probeAddresses.get(context.id);
      // The failed command that prompted this probe dropped the runtime cache,
      // so fall back to the address that command itself used — but only while
      // it still belongs to this working copy.
      const cdpUrl = this.runtimeCache.get(context.id)?.ticket?.cdpUrl
        ?? (last?.cloneProfileId === row.clone_profile_id ? last.cdpUrl : undefined);
      if (!cdpUrl) return null;
      const cdpCaFile = this.remote.cdpCaFile(cdpUrl);
      const result = await this.runBrowser(args, {
        conversationId: context.id,
        workspaceDir: this.workspace(context),
        timeoutMs: PROBE_TIMEOUT_MS,
        remoteCdpUrl: cdpUrl,
        remoteSessionId: row.clone_profile_id,
        trustedCdpOrigin: cdpUrl,
        ...(cdpCaFile ? { cdpCaFile } : {}),
      });
      if (result.exitCode !== 0) return null;
      return result.stdout || null;
    } catch {
      return null;
    }
  }

  private async refreshCloneSession(row: VeneerBrowserCloneSessionRow): Promise<VeneerBrowserCloneSessionRow | null> {
    try {
      const remote = await this.remote.status(row.project_id, row.clone_profile_id);
      const status = remote.active ? 'active' : 'stopped';
      this.db.prepare(
        `UPDATE veneer_browser_clone_sessions SET remote_runtime_id = ?, status = ?,
           stopped_at = CASE WHEN ? = 'stopped' THEN COALESCE(stopped_at, ?) ELSE NULL END,
           last_error = CASE WHEN ? = 'active' THEN NULL ELSE last_error END
         WHERE conversation_id = ? AND clone_profile_id = ? AND client_scope = ?`,
      ).run(remote.runtimeId ?? null, status, status, now(), status,
        row.conversation_id, row.clone_profile_id, this.clientScope());
    } catch (error) {
      if (isVeneerBrowserRemoteError(error, 404)) {
        await this.closeCommandSession(row).catch(() => undefined);
        this.clearCaptureGrant(row, 'capture.expired');
        this.runtimeCache.delete(row.conversation_id);
        this.db.prepare(
          'DELETE FROM veneer_browser_clone_sessions WHERE conversation_id = ? AND clone_profile_id = ?',
        ).run(row.conversation_id, row.clone_profile_id);
        return null;
      }
      // A manager outage is not proof that a live working copy stopped.
    }
    return this.cloneSession(row.conversation_id);
  }

  private emptySession(context: ConversationContext, configured: boolean): VeneerBrowserSessionView {
    return {
      configured,
      active: false,
      projectId: this.scopeId(context),
      profileId: null,
      profileName: null,
      status: 'stopped',
      inUseByAnotherChat: false,
      temporaryClone: false,
      fresh: false,
      canUpdateProfile: false,
      startedAt: null,
      lastUsedAt: null,
      error: null,
    };
  }

  async conversationSession(userId: number, conversationId: string): Promise<VeneerBrowserSessionView> {
    const context = this.conversation(conversationId, userId, true);
    if (!this.configured()) return this.emptySession(context, false);
    const storedCopy = this.cloneSession(context.id);
    const copy = storedCopy ? await this.refreshCloneSession(storedCopy) : null;
    if (copy) {
      const profile = copy.source_profile_id
        ? this.profileInProject(copy.project_id, copy.source_profile_id)
        : null;
      return {
        configured: true,
        active: copy.status === 'active',
        projectId: copy.project_id,
        profileId: profile?.id ?? null,
        profileName: profile?.name ?? 'Signed-out browser',
        status: copy.status,
        inUseByAnotherChat: false,
        temporaryClone: true,
        fresh: copy.mode === 'fresh',
        canUpdateProfile: copy.mode === 'profile' && (context.user_id === userId || activeLoginGrants(this.db,userId,conversationId).some(g => g.allow_save === 1)),
        startedAt: copy.created_at,
        lastUsedAt: copy.last_used_at,
        error: copy.last_error,
      };
    }
    const profile = this.effectiveProfile(context);
    if (!profile) return this.emptySession(context, true);
    const current = this.view(profile);
    return {
      configured: true,
      active: false,
      projectId: profile.project_id,
      profileId: profile.id,
      profileName: profile.name,
      status: 'stopped',
      inUseByAnotherChat: false,
      temporaryClone: false,
      fresh: false,
      canUpdateProfile: false,
      startedAt: null,
      lastUsedAt: current.lastUsedAt,
      error: null,
    };
  }

  async openConversation(userId: number, conversationId: string): Promise<VeneerBrowserSessionView> {
    let context = this.conversation(conversationId, userId, true);
    return this.queue(`conversation:${context.id}`).run(async () => {
      context = this.conversation(conversationId, userId, true);
      await this.startForContext(context);
      return this.conversationSession(userId, conversationId);
    });
  }

  async openFreshConversation(userId: number, conversationId: string): Promise<VeneerBrowserSessionView> {
    let context = this.conversation(conversationId, userId, true);
    return this.queue(`conversation:${context.id}`).run(async () => {
      context = this.conversation(conversationId, userId, true);
      const row = await this.ensureFreshCopy(context);
      await this.queue(row.clone_profile_id).run(() => this.startWorkingCopy(context, row));
      return this.conversationSession(userId, conversationId);
    });
  }

  async fillGrantedLogin(userId: number, conversationId: string, args: Record<string, unknown>, kind: 'password' | 'totp', value: string): Promise<void> {
    const grant = authorizeLoginSecret(this.db, userId, conversationId, args, kind);
    const script = guardedLoginScript(String(args.target ?? ''), value, JSON.parse(grant.origins_json), kind);
    try {
      const result = await this.runCommands(userId, conversationId, [['eval', script]], {
        redact: [value, script],
        beforeCommand: () => {
          const current = authorizeLoginSecret(this.db, userId, conversationId, args, kind);
          if (current.id !== grant.id || current.origins_json !== grant.origins_json || this.captureGrantActive(conversationId)) throw new Error('Login grant changed or capture is enabled');
        },
      });
      if (result.failure) throw new Error('Login fill failed');
      this.audit(grant.project_id, grant.profile_id, 'credential.used', userId, conversationId, { grantId: grant.id, kind });
    } catch {
      this.audit(grant.project_id, grant.profile_id, 'credential.refused', userId, conversationId, { grantId: grant.id, kind });
      throw new Error('Granted login fill refused. Check the current approved login page, CSS input selector, grant and capture setting.');
    }
  }

  async updateConversationProfile(userId: number, conversationId: string): Promise<VeneerBrowserSessionView> {
    let context = this.conversation(conversationId, userId, true);
    const authorizeSave = () => {
      context = this.conversation(conversationId, userId, true);
      if (context.user_id !== userId && !activeLoginGrants(this.db,userId,conversationId).some(g => g.allow_save === 1)) throw new Error('The chat owner must grant permission to save this assigned login profile.');
    };
    authorizeSave();
    return this.queue(`conversation:${context.id}`).run(async () => {
      authorizeSave();
      const copy = this.cloneSession(context.id);
      if (!copy || copy.mode !== 'profile' || !copy.source_profile_id || !copy.source_generation) {
        throw new Error('This chat does not have a saved profile working copy to update.');
      }
      const profile = this.profile(copy.project_id, copy.source_profile_id, context.user_id);
      await this.queue(profile.id).run(async () => {
        authorizeSave();
        await this.stopWorkingCopy(copy);
        let generation: number;
        try {
          ({ generation } = await this.remote.promote(
            copy.project_id,
            profile.id,
            copy.clone_profile_id,
            copy.source_generation!,
          ));
        } catch (error) {
          if (isVeneerBrowserRemoteError(error, 409)) {
            const message = 'The saved profile changed after this working copy started. Veneer kept this copy. Save it as a new profile, or discard it and start again.';
            this.db.prepare(
              `UPDATE veneer_browser_clone_sessions SET status = 'error', last_error = ?, stopped_at = ?
               WHERE conversation_id = ? AND clone_profile_id = ?`,
            ).run(message, now(), context.id, copy.clone_profile_id);
            throw new Error(message);
          }
          throw new Error('Veneer Browser could not update the saved profile. The working copy was kept.');
        }
        await this.remote.delete(copy.project_id, copy.clone_profile_id).catch(() => undefined);
        this.runtimeCache.delete(context.id);
        const timestamp = now();
        this.db.transaction(() => {
          this.db.prepare(
            'UPDATE veneer_browser_profiles SET generation = ?, last_used_at = ?, updated_at = ? WHERE id = ?',
          ).run(generation, timestamp, timestamp, profile.id);
          this.db.prepare(
            'DELETE FROM veneer_browser_clone_sessions WHERE conversation_id = ? AND clone_profile_id = ?',
          ).run(context.id, copy.clone_profile_id);
        })();
        this.clearCaptureGrant(copy, 'capture.expired', userId);
        this.audit(copy.project_id, profile.id, 'profile.updated_from_copy', userId, context.id, { generation });
      });
      return this.conversationSession(userId, conversationId);
    });
  }

  async saveConversationAsProfile(
    userId: number,
    conversationId: string,
    nameValue: unknown,
  ): Promise<VeneerBrowserSessionView> {
    const context = this.conversation(conversationId, userId);
    const name = cleanName(nameValue);
    return this.queue(`conversation:${context.id}`).run(async () => {
      const copy = this.cloneSession(context.id);
      if (!copy) throw new Error('Open a temporary browser before you save a new profile.');
      await this.stopWorkingCopy(copy);
      this.runtimeCache.delete(context.id);
      const profileId = crypto.randomUUID();
      let generation: number;
      try {
        ({ generation } = await this.remote.saveTemporary(
          copy.project_id,
          copy.clone_profile_id,
          profileId,
          name,
        ));
      } catch (error) {
        throw new Error('Veneer Browser could not save this working copy as a new profile. The copy was kept.');
      }
      const timestamp = now();
      try {
        this.db.transaction(() => {
          this.db.prepare(
            `INSERT INTO veneer_browser_profiles
               (id, client_scope, project_id, name, generation, created_by, owner_user_id,
                last_used_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(profileId, this.clientScope(), copy.project_id, name, generation, userId, userId,
            timestamp, timestamp, timestamp);
          this.db.prepare(
            `INSERT INTO veneer_browser_project_settings (client_scope, project_id, user_id, default_profile_id, updated_at)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_scope, project_id, user_id) DO UPDATE SET
               default_profile_id = COALESCE(veneer_browser_project_settings.default_profile_id, excluded.default_profile_id),
               updated_at = excluded.updated_at`,
          ).run(this.clientScope(), copy.project_id, userId, profileId, timestamp);
          this.db.prepare(
            `INSERT INTO veneer_browser_conversation_profiles
               (conversation_id, client_scope, project_id, profile_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET client_scope = excluded.client_scope,
               project_id = excluded.project_id, profile_id = excluded.profile_id, updated_at = excluded.updated_at`,
          ).run(context.id, this.clientScope(), copy.project_id, profileId, timestamp, timestamp);
          this.db.prepare(
            'DELETE FROM veneer_browser_clone_sessions WHERE conversation_id = ? AND clone_profile_id = ?',
          ).run(context.id, copy.clone_profile_id);
        })();
      } catch (error) {
        await this.remote.delete(copy.project_id, profileId).catch(() => undefined);
        throw error;
      }
      await this.remote.delete(copy.project_id, copy.clone_profile_id).catch(() => undefined);
      this.clearCaptureGrant(copy, 'capture.expired', userId);
      this.audit(copy.project_id, profileId, 'profile.saved_from_copy', userId, context.id, { generation });
      return this.conversationSession(userId, conversationId);
    });
  }

  async stopConversation(userId: number, conversationId: string): Promise<VeneerBrowserSessionView> {
    let context = this.conversation(conversationId, userId, true);
    return this.queue(`conversation:${context.id}`).run(async () => {
      context = this.conversation(conversationId, userId, true);
      this.runtimeCache.delete(context.id);
      const copy = this.cloneSession(context.id);
      if (copy) {
        const key = copy.source_profile_id ?? copy.clone_profile_id;
        await this.queue(key).run(() => this.removeTemporaryClone(copy, userId));
      } else {
        const profile = this.selectedProfile(context);
        const live = profile ? this.session(profile.id) : null;
        if (profile && live?.conversation_id === context.id && ['starting', 'active'].includes(live.status)) {
          await this.remote.stop(profile.project_id, profile.id);
          this.db.prepare(
            `UPDATE veneer_browser_sessions SET conversation_id = NULL, status = 'stopped',
             stopped_at = ?, last_error = NULL WHERE profile_id = ?`,
          ).run(now(), profile.id);
        }
      }
      return this.conversationSession(userId, conversationId);
    });
  }

  async downloads(userId: number, conversationId: string): Promise<string[]> {
    let context = this.conversation(conversationId, userId, true);
    return this.queue(`conversation:${context.id}`).run(async () => {
      context = this.conversation(conversationId, userId, true);
      const runtime = await this.startForContext(context);
      const items = await this.remote.downloads(runtime.row.project_id, runtime.row.clone_profile_id);
      const outputDir = path.join(
        this.workspace(context),
        '.veneer-browser',
        'downloads',
        runtime.auditProfileId,
      );
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const saved: string[] = [];
      let total = 0;
      for (const item of items) {
        const bytes = decodeDownload(item);
        if (!bytes || total + bytes.length > MAX_DOWNLOAD_TOTAL) continue;
        let target = path.join(outputDir, safeFileName(item.name));
        for (let suffix = 2; fs.existsSync(target); suffix += 1) {
          const ext = path.extname(target);
          target = path.join(outputDir, `${path.basename(target, ext)}-${suffix}${ext}`);
        }
        fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
        total += bytes.length;
        saved.push(target);
      }
      this.audit(runtime.row.project_id, runtime.auditProfileId, 'downloads.imported', userId, conversationId, {
        fileCount: saved.length,
        totalBytes: total,
      });
      return saved;
    });
  }

  async reconcile(): Promise<void> {
    if (!this.configured()) return;
    const rows = this.db.prepare(
      "SELECT * FROM veneer_browser_sessions WHERE client_scope = ? AND status IN ('starting', 'active')",
    ).all(this.clientScope()) as VeneerBrowserSessionRow[];
    await Promise.all(rows.map((row) => this
      .refreshProfileRow(this.profileInProject(row.project_id, row.profile_id))
      .catch(() => undefined)));
    const copies = this.db.prepare(
      'SELECT * FROM veneer_browser_clone_sessions WHERE client_scope = ?',
    ).all(this.clientScope()) as VeneerBrowserCloneSessionRow[];
    await Promise.all(copies.map(async (row) => {
      const refreshed = await this.refreshCloneSession(row).catch(() => row);
      if (!refreshed || refreshed.status !== 'stopped') return;
      const lastUsed = Date.parse(refreshed.last_used_at ?? refreshed.created_at);
      if (Number.isFinite(lastUsed) && Date.now() - lastUsed > STOPPED_COPY_GRACE_MS) {
        await this.removeTemporaryClone(refreshed).catch(() => undefined);
      }
    }));
  }

  shutdown(): void {
    // Remote runtimes intentionally survive runner and web restarts.
    clearInterval(this.maintenanceTimer);
    this.queues.clear();
  }
}
