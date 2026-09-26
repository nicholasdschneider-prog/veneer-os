import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import {
  LEGACY_GENERATED_INSTRUCTION_MARKER,
  cleanupLegacyGeneratedInstructionsOnce,
  coreVeneerRules,
  prepareConversationInstructions,
  ensureConversationInstructionSnapshot,
  initializeConversationInstructionSnapshots,
  removeLegacyGeneratedInstructionFiles,
  removeLegacyInstructionGitExcludes,
} from '../src/instructions/context.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const tempDirs: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testDb() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'u@example.com', 'User', 'owner')").run();
  return db;
}

describe('instruction context migration', () => {
  it('refreshes capability guidance for existing chats without changing their fixed snapshot', () => {
    const db = testDb();
    db.prepare("UPDATE assistants SET instructions = 'Keep my original role.' WHERE id=1").run();
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,provider,native_session_id) VALUES('existing',1,1,'codex','saved-session')").run();
    const snapshot = ensureConversationInstructionSnapshot(db, 'existing');
    db.prepare("UPDATE assistants SET instructions = 'A later unrelated role.' WHERE id=1").run();
    const result = prepareConversationInstructions(db, { workspaceDir: '/repo', assistantSlug: 'assistant', elevated: false }, 'existing');
    expect(result.developerInstructions).toContain('Current Veneer bot capabilities');
    expect(result.developerInstructions).toContain('Routine training text, procedural documentation, task records and isolated artifacts do not require enqueue_build');
    expect(result.developerInstructions).toContain('Keep software source, executable automation, dependencies, schemas and deployment work in the build queue');
    expect(result.developerInstructions).toContain('defer that edit and continue unrelated work');

    expect(result.developerInstructions).toContain('Proactively use ask_user');
    expect(result.developerInstructions).toContain('no fixed option count cap');
    expect(result.developerInstructions).toContain('list_bot_routines before save_bot_routine');
    expect(result.developerInstructions).toContain('Teach a task');
    expect(result.developerInstructions).toContain('timestamped narration');
    expect(result.developerInstructions).toContain('inspect_routine_message');
    expect(result.developerInstructions).toContain('retire_message_draft');
    expect(result.developerInstructions).toContain('An explicit recorded human answer lowers the hand');
    expect(result.developerInstructions).toContain('Without a fresh trusted proof, ready=false and execute=false');
    expect(result.developerInstructions).toContain('Treat human result replies received mid-turn as follow-up input');
    expect(result.developerInstructions).toContain('Rapid human follow-ups are retained through provider startup');
    expect(result.developerInstructions).toContain('claim_routine_message');
    expect(result.developerInstructions).toContain('/#/routine-reply-setup');
    expect(result.developerInstructions).toContain('/#/routine-scope-review');
    expect(result.developerInstructions).toContain('First observation must use the handoff request key');
    expect(result.developerInstructions).toContain('A retired draft does not resolve the customer request');
    expect(result.developerInstructions).toContain('manage_voice_preferences');
    expect(result.developerInstructions).toContain('Ordinary chat agents must not claim to save these settings themselves.');
    expect(result.developerInstructions).toContain('Listen beside Reply');
    expect(result.developerInstructions).toContain('read_team_room');
    expect(result.developerInstructions).toContain('post_team_room_message');
    expect(result.developerInstructions).toContain('Organize bots for personal display-group');
    expect(result.developerInstructions).toContain('Chats → + (New conversation)');
    expect(result.developerInstructions).toContain('reviewing shared context');
    expect(result.developerInstructions).toContain('Room sessions do not inherit original external connections');
    expect(result.developerInstructions).toContain('Casual groups created with + use team rooms');
    expect(result.developerInstructions).toContain('Keep my original role.');
    expect(result.developerInstructions).not.toContain('A later unrelated role.');
    expect(ensureConversationInstructionSnapshot(db, 'existing')).toEqual(snapshot);
    expect(result.receipt?.core.content).toContain('/#/bot-guide');
  });

  it('freezes active chats once during rollout', () => {
    const db = testDb();
    db.prepare("UPDATE assistants SET instructions = 'Instructions at rollout.' WHERE id = 1").run();
    db.prepare(
      "INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('active-chat', 1, 1, 'claude', 'native')",
    ).run();

    expect(initializeConversationInstructionSnapshots(db)).toBe(1);
    db.prepare("UPDATE assistants SET instructions = 'Changed later.' WHERE id = 1").run();
    const saved = ensureConversationInstructionSnapshot(db, 'active-chat');
    expect(saved.content).toContain('Instructions at rollout.');
    expect(saved.content).not.toContain('Changed later.');
    expect(initializeConversationInstructionSnapshots(db)).toBe(0);
  });

  it('removes only exact, regular Veneer-generated files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-instruction-cleanup-'));
    tempDirs.push(root);
    const generated = path.join(root, 'generated');
    const userOwned = path.join(root, 'user-owned');
    const changedMarker = path.join(root, 'changed-marker');
    const linked = path.join(root, 'linked');
    fs.mkdirSync(generated);
    fs.mkdirSync(userOwned);
    fs.mkdirSync(changedMarker);
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(generated, 'CLAUDE.md'), `${LEGACY_GENERATED_INSTRUCTION_MARKER}\nold\n`);
    fs.writeFileSync(path.join(generated, 'AGENTS.md'), `${LEGACY_GENERATED_INSTRUCTION_MARKER}\r\nold\r\n`);
    fs.writeFileSync(path.join(userOwned, 'CLAUDE.md'), '# User guidance\n');
    fs.writeFileSync(
      path.join(changedMarker, 'AGENTS.md'),
      `${LEGACY_GENERATED_INSTRUCTION_MARKER} edited\nkeep\n`,
    );
    const target = path.join(root, 'target.md');
    fs.writeFileSync(target, `${LEGACY_GENERATED_INSTRUCTION_MARKER}\nlinked target\n`);
    fs.symlinkSync(target, path.join(linked, 'AGENTS.md'));

    const result = removeLegacyGeneratedInstructionFiles([generated, userOwned, changedMarker, linked]);
    expect(result.errors).toEqual([]);
    expect(result.removed.sort()).toEqual([
      path.join(generated, 'AGENTS.md'),
      path.join(generated, 'CLAUDE.md'),
    ]);
    expect(fs.existsSync(path.join(userOwned, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(changedMarker, 'AGENTS.md'))).toBe(true);
    expect(fs.lstatSync(path.join(linked, 'AGENTS.md')).isSymbolicLink()).toBe(true);
  });

  it('limits source-checkout build and restart rules to a Platform Dev source workspace', () => {
    const source = coreVeneerRules({
      workspaceDir: '/repo',
      assistantSlug: 'platform-dev',
      elevated: true,
      sourceWorkspace: true,
    });
    const project = coreVeneerRules({
      workspaceDir: '/client',
      assistantSlug: 'platform-dev',
      elevated: true,
      sourceWorkspace: false,
    });
    expect(source).toContain('npm run restart');
    expect(project).not.toContain('npm run restart');
    expect(project).toContain('Core Veneer rules');
  });

  it('tells every provider to wait for its delegated agents', () => {
    // Cross-provider half of the subagent fix: the adapters keep children
    // inside the turn, this makes the agent actually consume their results.
    const rule = '- Wait for every delegated agent and summarize its result before completing your turn.';
    for (const slug of ['assistant', 'platform-dev']) {
      expect(coreVeneerRules({ workspaceDir: '/repo', assistantSlug: slug, elevated: false })).toContain(rule);
    }
  });

  it('tells every provider the build queue wakes the chat itself', () => {
    // Without this carve-out the headless follow-up rule reads as an order to
    // stack a wake-up on top of the queue, and a stray wake mid-build releases
    // the workspace build lock.
    for (const slug of ['assistant', 'platform-dev']) {
      const instructions = coreVeneerRules({ workspaceDir: '/repo', assistantSlug: slug, elevated: false });
      expect(instructions).toContain('the queue wakes this chat itself, so never schedule a wake-up to wait for your own build slot');
    }
  });

  it('requires every provider to publish browser deliverables instead of returning loopback links', () => {
    const rule = 'Localhost and other loopback URLs are internal verification targets, never user-facing deliverables.';
    for (const slug of ['assistant', 'platform-dev']) {
      const instructions = coreVeneerRules({ workspaceDir: '/repo', assistantSlug: slug, elevated: false });
      expect(instructions).toContain(rule);
      expect(instructions).toContain('publish_page');
      expect(instructions).toContain('publish_app');
    }
  });

  it('documents the shared GFM and math syntax for every provider', () => {
    for (const slug of ['assistant', 'platform-dev']) {
      const instructions = coreVeneerRules({ workspaceDir: '/repo', assistantSlug: slug, elevated: false });
      expect(instructions).toContain('GitHub-flavored markdown plus KaTeX math');
      expect(instructions).toContain('`$$...$$`');
      expect(instructions).toContain('`\\(...\\)`');
      expect(instructions).toContain('`\\[...\\]`');
      expect(instructions).toContain('Single-dollar math is intentionally unsupported');
    }
  });

  it('steers to the Veneer Browser only when that browser is available', () => {
    const base = { workspaceDir: '/repo', assistantSlug: 'assistant', elevated: false };
    const withBrowser = coreVeneerRules({ ...base, veneerBrowserAvailable: true });
    const withoutBrowser = coreVeneerRules(base);

    expect(withBrowser).toContain(
      '- Use the `veneer_browser` tools as the default browser for web tasks. Use `agent_browser` only for apps running on the agent machine (for example localhost dev servers) or when the user asks for the shared visible desktop browser.',
    );
    expect(withoutBrowser).not.toContain('veneer_browser');
    expect(coreVeneerRules({ ...base, veneerBrowserAvailable: false })).not.toContain('veneer_browser');
  });

  it('removes only the obsolete instruction entries from the local Git exclude', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-instruction-exclude-'));
    tempDirs.push(root);
    const info = path.join(root, '.git', 'info');
    fs.mkdirSync(info, { recursive: true });
    const file = path.join(info, 'exclude');
    fs.writeFileSync(file, '# local rules\n/CLAUDE.md\n/AGENTS.md\n/.claude/\n*.tmp\n');

    expect(removeLegacyInstructionGitExcludes(root)).toBe(fs.realpathSync(file));
    expect(fs.readFileSync(file, 'utf8')).toBe('# local rules\n/.claude/\n*.tmp\n');
    expect(removeLegacyInstructionGitExcludes(root)).toBeNull();
  });

  it('removes obsolete Git excludes from custom project repositories during cleanup', () => {
    const db = testDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-instruction-custom-excludes-'));
    tempDirs.push(root);
    const dataDir = path.join(root, 'data');
    const source = path.join(root, 'source');
    const custom = path.join(root, 'custom-project');
    for (const repository of [source, custom]) {
      fs.mkdirSync(path.join(repository, '.git', 'info'), { recursive: true });
      fs.writeFileSync(
        path.join(repository, '.git', 'info', 'exclude'),
        '# keep\n/CLAUDE.md\n/AGENTS.md\n/dist\n',
      );
    }
    db.prepare(
      "INSERT INTO projects (id, slug, name, root_dir) VALUES ('custom-project', 'custom', 'Custom', ?)",
    ).run(custom);

    const result = cleanupLegacyGeneratedInstructionsOnce({ db, dataDir, sourceDir: source });

    expect(result.gitExcludesUpdated.sort()).toEqual([
      fs.realpathSync(path.join(custom, '.git', 'info', 'exclude')),
      fs.realpathSync(path.join(source, '.git', 'info', 'exclude')),
    ].sort());
    for (const repository of [source, custom]) {
      expect(fs.readFileSync(path.join(repository, '.git', 'info', 'exclude'), 'utf8')).toBe('# keep\n/dist\n');
    }
  });
});
