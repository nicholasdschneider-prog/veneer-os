import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';

const REAL_MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

/** Write numbered .sql migration files to a fresh temp dir. */
function makeMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-migrate-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('migrate', () => {
  it('repairs turn origins created before event timestamps were added', () => {
    const dir = makeMigrationsDir({
      '0001_message_origins.sql': `
        CREATE TABLE conversations (id TEXT PRIMARY KEY);
        INSERT INTO conversations (id) VALUES ('conversation-1');
        CREATE TABLE turn_origins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL,
          prompt_text TEXT NOT NULL,
          origin_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX turn_origins_conversation ON turn_origins(conversation_id, id);
        INSERT INTO turn_origins
          (conversation_id, turn_id, prompt_text, origin_json, created_at)
        VALUES
          ('conversation-1', 'turn-1', 'hello', '{"kind":"agent"}', '2026-08-24T12:00:00.000Z');
      `,
      '0002_turn_origin_event_at.sql': fs.readFileSync(
        path.join(REAL_MIGRATIONS, '0084_turn_origin_event_at.sql'),
        'utf8',
      ),
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);

    expect(db.prepare('SELECT * FROM turn_origins').get()).toEqual({
      id: 1,
      conversation_id: 'conversation-1',
      turn_id: 'turn-1',
      prompt_text: 'hello',
      event_at: '2026-08-24T12:00:00.000Z',
      origin_json: '{"kind":"agent"}',
      created_at: '2026-08-24T12:00:00.000Z',
    });
    const eventAt = (db.pragma('table_info(turn_origins)') as { name: string; notnull: number }[])
      .find((column) => column.name === 'event_at');
    expect(eventAt?.notnull).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('does not cascade-delete child rows when a migration rebuilds a parent table', () => {
    const dir = makeMigrationsDir({
      '0001_init.sql': `
        CREATE TABLE parent (id INTEGER PRIMARY KEY, note TEXT);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
        );
        INSERT INTO parent (id, note) VALUES (1, 'hello');
        INSERT INTO child (id, parent_id) VALUES (1, 1);
      `,
      // Rebuild parent the SQLite way: create new, copy, DROP old, rename.
      '0002_rebuild_parent.sql': `
        CREATE TABLE parent_new (id INTEGER PRIMARY KEY, note TEXT, extra TEXT);
        INSERT INTO parent_new (id, note) SELECT id, note FROM parent;
        DROP TABLE parent;
        ALTER TABLE parent_new RENAME TO parent;
      `,
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);

    // The DROP TABLE parent would cascade-delete the child row if FK enforcement
    // were left on during the rebuild.
    const childCount = db.prepare('SELECT COUNT(*) AS n FROM child').get() as { n: number };
    expect(childCount.n).toBe(1);

    // FK enforcement is restored after migrations run.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('throws when a migration leaves dangling foreign key references', () => {
    const dir = makeMigrationsDir({
      '0001_bad.sql': `
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id)
        );
        INSERT INTO child (id, parent_id) VALUES (1, 999);
      `,
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    expect(() => migrate(db, dir)).toThrow(/foreign key violations/);
    db.close();
  });

  it('removes the retired Browser Use tables with a forward migration', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, REAL_MIGRATIONS);

    const retiredTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'browser_use_%'")
      .all();
    expect(retiredTables).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'veneer_browser_profiles'").get()).toEqual({ name: 'veneer_browser_profiles' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'veneer_browser_audit'").get()).toEqual({ name: 'veneer_browser_audit' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('removes retired Browserbase connector data with a forward migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-browser-connector-migrate-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0070_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'one', 'Project One')").run();
    const connectorId = Number(
      db
        .prepare(
          "INSERT INTO user_connectors (user_id, connector_slug, status, config_json) VALUES (1, 'browserbase', 'connected', '{}')",
        )
        .run().lastInsertRowid,
    );
    db.prepare('INSERT INTO user_connector_projects (connector_id, project_id) VALUES (?, ?)').run(
      connectorId,
      'project-1',
    );
    db.prepare(
      `INSERT INTO connector_access_changes
       (connector_id, access_mode, access_version, status, config_json)
       VALUES (?, 'full', 1, 'pending', '{}')`,
    ).run(connectorId);
    db.prepare(
      `INSERT INTO connector_auth_configs
       (connector_slug, access_mode, access_version, auth_config_id, toolkit_version, oauth_scopes_json, tool_slugs_json)
       VALUES ('browserbase', 'full', 1, 'auth-old-browser', 'v1', '[]', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO scheduled_tasks
       (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider, connector_id)
       VALUES ('task-1', 1, 1, 'Old browser task', 'Run it', '{}', 'UTC', 'claude', ?)`,
    ).run(connectorId);
    db.prepare(
      "INSERT INTO connections (name, slug, config_json) VALUES ('Old browser', 'browserbase', '{}')",
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0070_remove_browserbase.sql'),
      path.join(dir, '0070_remove_browserbase.sql'),
    );
    migrate(db, dir);

    expect(db.prepare("SELECT 1 FROM user_connectors WHERE connector_slug = 'browserbase'").get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM user_connector_projects WHERE connector_id = ?').get(connectorId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM connector_access_changes WHERE connector_id = ?').get(connectorId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM connector_auth_configs WHERE connector_slug = 'browserbase'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM connections WHERE slug = 'browserbase'").get()).toBeUndefined();
    expect(db.prepare("SELECT connector_id FROM scheduled_tasks WHERE id = 'task-1'").get()).toEqual({ connector_id: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('adds new models to existing OpenRouter preferences', () => {
    const dir = makeMigrationsDir({
      '0001_settings.sql': `
        CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        INSERT INTO settings (key, value_json) VALUES (
          'model_prefs',
          '{"openrouterModels":["z-ai/glm-5.2"],"providerDefaults":{"openrouter":"z-ai/glm-5.2"},"marker":"keep"}'
        );
      `,
      '0002_add_deepseek_v4_flash.sql': fs.readFileSync(
        path.join(REAL_MIGRATIONS, '0063_add_deepseek_v4_flash.sql'),
        'utf8',
      ),
      '0003_add_thinking_machines_inkling.sql': fs.readFileSync(
        path.join(REAL_MIGRATIONS, '0064_add_thinking_machines_inkling.sql'),
        'utf8',
      ),
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    migrate(db, dir);
    const stored = JSON.parse(
      (db.prepare("SELECT value_json FROM settings WHERE key = 'model_prefs'").get() as { value_json: string })
        .value_json,
    );

    expect(stored).toEqual({
      openrouterModels: [
        'z-ai/glm-5.2',
        'deepseek/deepseek-v4-flash-latest',
        'thinkingmachines/inkling',
      ],
      providerDefaults: { openrouter: 'z-ai/glm-5.2' },
      marker: 'keep',
    });
    db.close();
  });

  it('repairs the OpenRouter Deepseek V4 Flash alias in saved selections', () => {
    const oldId = 'deepseek/deepseek-v4-flash-latest';
    const newId = '~deepseek/deepseek-v4-flash-latest';
    const dir = makeMigrationsDir({
      '0001_model_storage.sql': `
        CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE conversations (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT);
        CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT);
        INSERT INTO settings (key, value_json) VALUES
          ('model_prefs', '${JSON.stringify({
            openrouterModels: [oldId, 'z-ai/glm-5.2'],
            providerDefaults: { openrouter: oldId },
            hiddenModels: [`openrouter:${oldId}`],
            modelOrder: { openrouter: [oldId] },
            agents: { assistant: { provider: 'openrouter', model: oldId, effort: 'high' } },
            autoTitle: { enabled: true, model: oldId },
            marker: 'keep',
          })}'),
          ('voice_agent_settings', '${JSON.stringify({ enabled: true, provider: 'openrouter', model: oldId })}');
        INSERT INTO conversations (id, provider, model) VALUES
          ('openrouter-chat', 'openrouter', '${oldId}'),
          ('claude-chat', 'claude', '${oldId}');
        INSERT INTO scheduled_tasks (id, provider, model) VALUES
          ('openrouter-task', 'openrouter', '${oldId}'),
          ('claude-task', 'claude', '${oldId}');
      `,
      '0002_fix_deepseek_v4_flash_alias.sql': fs.readFileSync(
        path.join(REAL_MIGRATIONS, '0073_fix_deepseek_v4_flash_alias.sql'),
        'utf8',
      ),
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    migrate(db, dir);
    const prefs = JSON.parse(
      (db.prepare("SELECT value_json FROM settings WHERE key = 'model_prefs'").get() as { value_json: string })
        .value_json,
    );
    const voice = JSON.parse(
      (db.prepare("SELECT value_json FROM settings WHERE key = 'voice_agent_settings'").get() as { value_json: string })
        .value_json,
    );

    expect(prefs).toEqual({
      openrouterModels: [newId, 'z-ai/glm-5.2'],
      providerDefaults: { openrouter: newId },
      hiddenModels: [`openrouter:${newId}`],
      modelOrder: { openrouter: [newId] },
      agents: { assistant: { provider: 'openrouter', model: newId, effort: 'high' } },
      autoTitle: { enabled: true, model: newId },
      marker: 'keep',
    });
    expect(voice).toEqual({ enabled: true, provider: 'openrouter', model: newId });
    expect(db.prepare("SELECT model FROM conversations WHERE id = 'openrouter-chat'").get()).toEqual({ model: newId });
    expect(db.prepare("SELECT model FROM conversations WHERE id = 'claude-chat'").get()).toEqual({ model: oldId });
    expect(db.prepare("SELECT model FROM scheduled_tasks WHERE id = 'openrouter-task'").get()).toEqual({ model: newId });
    expect(db.prepare("SELECT model FROM scheduled_tasks WHERE id = 'claude-task'").get()).toEqual({ model: oldId });
    db.close();
  });

  it('backfills todo projects from their linked chats and clears them when the project is deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-todo-project-migrate-'));
    dirs.push(dir);
    for (const file of fs.readdirSync(REAL_MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0049_').sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'one', 'Project One')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id)
       VALUES ('todo-chat', 1, 1, 'project-1', 'claude', 'todo-native')`,
    ).run();
    db.prepare(
      "INSERT INTO todos (id, title, state, conversation_id) VALUES ('todo-1', 'Existing todo', 'active', 'todo-chat')",
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0049_todo_projects.sql'),
      path.join(dir, '0049_todo_projects.sql'),
    );
    migrate(db, dir);

    expect(db.prepare("SELECT project_id FROM todos WHERE id = 'todo-1'").get()).toEqual({ project_id: 'project-1' });
    db.prepare("DELETE FROM projects WHERE id = 'project-1'").run();
    expect(db.prepare("SELECT project_id FROM todos WHERE id = 'todo-1'").get()).toEqual({ project_id: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('widens conversations for OpenRouter without losing dependent rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-openrouter-migrate-'));
    dirs.push(dir);
    for (const file of fs.readdirSync(REAL_MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0023_').sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id)
       VALUES ('c1', 1, 1, 'Existing', 'claude', 's1')`,
    ).run();
    db.prepare("INSERT INTO approvals (conversation_id, request_id, tool_name, request_json) VALUES ('c1','r1','Write','{}')").run();
    db.prepare("INSERT INTO pending_turns (conversation_id, prompt) VALUES ('c1','continue')").run();
    db.prepare("INSERT INTO queued_messages (conversation_id, prompt) VALUES ('c1','next')").run();
    db.prepare(
      `INSERT INTO generated_files (id, path, name, source, conversation_id)
       VALUES ('f1','/tmp/report.csv','report.csv','write','c1')`,
    ).run();
    db.prepare("INSERT INTO todos (id, title, state, conversation_id) VALUES ('t1','Todo','active','c1')").run();
    db.prepare("INSERT INTO pages (id, slug, title, conversation_id) VALUES ('p1','page-slug','Page','c1')").run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0023_openrouter_provider.sql'),
      path.join(dir, '0023_openrouter_provider.sql'),
    );
    migrate(db, dir);

    for (const table of ['conversations', 'approvals', 'pending_turns', 'queued_messages', 'generated_files', 'todos', 'pages']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(1);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      db.prepare(
        `INSERT INTO conversations (id, assistant_id, user_id, title, provider, model, native_session_id)
         VALUES ('c2', 1, 1, 'OpenRouter', 'openrouter', 'z-ai/glm-5.2', 's2')`,
      ).run(),
    ).not.toThrow();
    db.close();
  });

  it('consolidates App Server and exec conversations under canonical Codex without losing compatibility data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-codex-migrate-'));
    dirs.push(dir);
    // Replay history up to (but not including) 0027, so the legacy rows below
    // are written against the schema that actually held them. Everything from
    // 0027 on is applied afterwards, as a real upgrade would: later migrations
    // rebuild conversations again (0077) and assume 0027 already ran.
    const allFiles = fs.readdirSync(REAL_MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of allFiles.filter((f) => f < '0027_')) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id)
       VALUES ('exec-chat', 1, 1, 'Exec', 'codex', 'exec-thread'),
              ('app-chat', 1, 1, 'App Server', 'codex-app-server', 'app-thread')`,
    ).run();
    db.prepare("INSERT INTO approvals (conversation_id, request_id, tool_name, request_json) VALUES ('app-chat','r1','shell','{}')").run();
    db.prepare(
      `INSERT INTO scheduled_tasks
        (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider)
       VALUES ('task-1', 1, 1, 'Codex task', 'work', '{"type":"daily","time":"09:00"}', 'UTC', 'codex-app-server')`,
    ).run();
    const prefs = {
      defaultProvider: 'codex-app-server',
      providerDefaults: { claude: null, openrouter: 'z-ai/glm-5.2', codex: 'exec-model', 'codex-app-server': 'app-model' },
      defaultEffort: 'high',
      hiddenModels: ['codex-app-server:gpt-hidden', 'codex:gpt-hidden'],
      modelOrder: { codex: ['exec-model'], 'codex-app-server': ['app-model'] },
      agents: { assistant: { provider: 'codex-app-server', model: 'app-model', effort: null } },
    };
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('model_prefs', ?)").run(JSON.stringify(prefs));

    for (const file of allFiles.filter((f) => f >= '0027_')) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    migrate(db, dir);

    expect(db.prepare('SELECT id, provider, native_session_id FROM conversations ORDER BY id').all()).toEqual([
      { id: 'app-chat', provider: 'codex', native_session_id: 'app-thread' },
      { id: 'exec-chat', provider: 'codex', native_session_id: 'exec-thread' },
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE conversation_id = 'app-chat'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT provider FROM scheduled_tasks WHERE id = 'task-1'").get() as { provider: string }).provider).toBe('codex');
    const stored = JSON.parse(
      (db.prepare("SELECT value_json FROM settings WHERE key = 'model_prefs'").get() as { value_json: string }).value_json,
    ) as typeof prefs;
    expect(stored.defaultProvider).toBe('codex');
    // 0077 adds Grok's default alongside the consolidated Codex one.
    expect(stored.providerDefaults).toEqual({
      claude: null,
      openrouter: 'z-ai/glm-5.2',
      codex: 'app-model',
      grok: 'grok-4.5',
    });
    expect(stored.modelOrder).toEqual({ codex: ['app-model'] });
    expect(stored.hiddenModels).toEqual(['codex:gpt-hidden']);
    expect(stored.agents.assistant.provider).toBe('codex');
    expect(() =>
      db.prepare(
        `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id)
         VALUES ('old-provider', 1, 1, 'Old', 'codex-app-server', 'old-thread')`,
      ).run(),
    ).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('consolidates duplicate active build slots before enforcing one per conversation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-build-queue-migrate-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0034_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'platform-dev'").get() as { id: number };
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id)
       VALUES ('build-chat', ?, 1, 'Build chat', 'codex', 'thread')`,
    ).run(assistant.id);
    db.prepare(
      `INSERT INTO build_queue (id, user_id, conversation_id, title, brief, status)
       VALUES (1, 1, 'build-chat', 'First', 'First brief', 'running'),
              (2, 1, 'build-chat', 'Second', 'Second brief', 'queued')`,
    ).run();
    db.prepare("INSERT INTO pending_turns (conversation_id, prompt) VALUES ('build-chat', 'First prompt')").run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0034_build_queue_one_active_conversation.sql'),
      path.join(dir, '0034_build_queue_one_active_conversation.sql'),
    );
    migrate(db, dir);

    expect(db.prepare('SELECT id, status, brief FROM build_queue ORDER BY id').all()).toEqual([
      { id: 1, status: 'running', brief: expect.stringContaining('Additional queued request: Second') },
      { id: 2, status: 'skipped', brief: 'Second brief' },
    ]);
    expect((db.prepare("SELECT prompt FROM pending_turns WHERE conversation_id = 'build-chat'").get() as { prompt: string }).prompt)
      .toContain('Additional queued request: Second');
    expect(() =>
      db.prepare("INSERT INTO build_queue (user_id, conversation_id, title, brief) VALUES (1, 'build-chat', 'Third', 'x')").run(),
    ).toThrow();
    db.close();
  });

  it('migrates the global source queue to per-workspace running locks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-build-scopes-migrate-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0041_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      "INSERT INTO projects (id, slug, name, instructions) VALUES ('alpha', 'alpha', 'Alpha', ''), ('beta', 'beta', 'Beta', '')",
    ).run();
    const platformDev = db.prepare("SELECT id FROM assistants WHERE slug = 'platform-dev'").get() as { id: number };
    const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
    const insertConversation = db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, project_id, title, provider, native_session_id)
       VALUES (?, ?, 1, ?, ?, 'codex', ?)`,
    );
    insertConversation.run('source-chat', platformDev.id, null, 'Source', 'source-native');
    insertConversation.run('alpha-chat', assistant.id, 'alpha', 'Alpha', 'alpha-native');
    insertConversation.run('beta-chat', assistant.id, 'beta', 'Beta', 'beta-native');
    db.prepare(
      `INSERT INTO build_queue (user_id, conversation_id, title, brief, status)
       VALUES (1, 'source-chat', 'Existing source build', 'x', 'running')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0041_project_build_queues.sql'),
      path.join(dir, '0041_project_build_queues.sql'),
    );
    migrate(db, dir);

    expect(db.prepare("SELECT scope_key FROM build_queue WHERE conversation_id = 'source-chat'").get()).toEqual({
      scope_key: 'source',
    });
    db.prepare(
      `INSERT INTO build_queue (user_id, conversation_id, scope_key, title, brief, status)
       VALUES (1, 'alpha-chat', 'project:alpha', 'Alpha build', 'x', 'running'),
              (1, 'beta-chat', 'project:beta', 'Beta build', 'x', 'running')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO build_queue (user_id, conversation_id, scope_key, title, brief, status)
         VALUES (1, 'source-chat', 'project:alpha', 'Duplicate Alpha', 'x', 'running')`,
      ).run(),
    ).toThrow();
    db.close();
  });

  it('adds Automations visibility metadata without losing existing schedules or run history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-automations-migrate-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0039_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('old-run-chat', 1, 1, 'Old run', 'claude', 'old-native', 'automation')`,
    ).run();
    db.prepare(
      `INSERT INTO scheduled_tasks
        (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider)
       VALUES ('old-task', 1, 1, 'Old automation', 'work', '{"type":"daily","time":"09:00"}', 'UTC', 'claude')`,
    ).run();
    db.prepare(
      `INSERT INTO scheduled_task_runs
        (id, scheduled_task_id, conversation_id, scheduled_for, trigger, status)
       VALUES ('old-run', 'old-task', 'old-run-chat', '2026-07-21T09:00:00.000Z', 'scheduled', 'completed')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0039_automations_workspace.sql'),
      path.join(dir, '0039_automations_workspace.sql'),
    );
    migrate(db, dir);

    expect(db.prepare("SELECT id, pin_order FROM scheduled_tasks WHERE id = 'old-task'").get()).toEqual({
      id: 'old-task',
      pin_order: null,
    });
    expect(db.prepare("SELECT id, important FROM scheduled_task_runs WHERE id = 'old-run'").get()).toEqual({
      id: 'old-run',
      important: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('marks only synced Claude-harness chats for the one-time generated-file rescan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-generated-files-rescan-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0043_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations
        (id, assistant_id, user_id, title, provider, native_session_id, last_active_at, files_synced_at)
       VALUES
        ('claude-chat', 1, 1, 'Claude', 'claude', 's1', '2026-07-23 12:00:00', '2026-07-23 12:00:00'),
        ('openrouter-chat', 1, 1, 'OpenRouter', 'openrouter', 's2', '2026-07-23 12:00:00', '2026-07-23 12:00:00'),
        ('codex-chat', 1, 1, 'Codex', 'codex', 's3', '2026-07-23 12:00:00', '2026-07-23 12:00:00'),
        ('never-synced', 1, 1, 'Never synced', 'claude', 's4', '2026-07-23 12:00:00', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO generated_files (id, path, name, source, user_id, conversation_id)
       VALUES ('existing-file', '/tmp/existing.pdf', 'existing.pdf', 'bash', 1, 'claude-chat')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0043_rescan_bash_generated_files.sql'),
      path.join(dir, '0043_rescan_bash_generated_files.sql'),
    );
    migrate(db, dir);

    expect(db.prepare('SELECT id, files_synced_at FROM conversations ORDER BY id').all()).toEqual([
      { id: 'claude-chat', files_synced_at: null },
      { id: 'codex-chat', files_synced_at: '2026-07-23 12:00:00' },
      { id: 'never-synced', files_synced_at: null },
      { id: 'openrouter-chat', files_synced_at: null },
    ]);
    expect(db.prepare("SELECT id, conversation_id FROM generated_files WHERE id = 'existing-file'").get()).toEqual({
      id: 'existing-file',
      conversation_id: 'claude-chat',
    });

    // The numbered migration is one-time: a later high-water mark is not
    // repeatedly cleared on every startup.
    db.prepare("UPDATE conversations SET files_synced_at = last_active_at WHERE id = 'claude-chat'").run();
    migrate(db, dir);
    expect(db.prepare("SELECT files_synced_at FROM conversations WHERE id = 'claude-chat'").get()).toEqual({
      files_synced_at: '2026-07-23 12:00:00',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('backfills Page creators while preserving unattributable legacy pages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-page-creators-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0045_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (7, 'creator@example.com', 'Creator', 'member')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id)
       VALUES ('creator-chat', 1, 7, 'Published from here', 'claude', 'native-page')`,
    ).run();
    db.prepare(
      `INSERT INTO pages (id, slug, title, conversation_id)
       VALUES
        ('attributed', 'attributed-page', 'Attributed', 'creator-chat'),
        ('orphaned', 'orphaned-page', 'Orphaned', NULL)`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0045_page_creator.sql'),
      path.join(dir, '0045_page_creator.sql'),
    );
    migrate(db, dir);

    expect(db.prepare('SELECT id, creator_user_id FROM pages ORDER BY id').all()).toEqual([
      { id: 'attributed', creator_user_id: 7 },
      { id: 'orphaned', creator_user_id: null },
    ]);

    // Creator attribution survives chat deletion, but degrades safely if the
    // user record itself is later removed.
    db.prepare("DELETE FROM conversations WHERE id = 'creator-chat'").run();
    expect(db.prepare("SELECT creator_user_id FROM pages WHERE id = 'attributed'").get()).toEqual({
      creator_user_id: 7,
    });
    db.prepare('DELETE FROM users WHERE id = 7').run();
    expect(db.prepare("SELECT creator_user_id FROM pages WHERE id = 'attributed'").get()).toEqual({
      creator_user_id: null,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('gives existing Pages seven days from their last update', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-page-expiry-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0054_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    migrate(db, dir);
    db.prepare(
      `INSERT INTO pages (id, slug, title, updated_at)
       VALUES ('legacy-page', 'legacy-page-slug', 'Legacy page', '2026-07-20 12:30:00')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0054_page_expiry.sql'),
      path.join(dir, '0054_page_expiry.sql'),
    );
    migrate(db, dir);

    expect(db.prepare("SELECT expires_at FROM pages WHERE id = 'legacy-page'").get()).toEqual({
      expires_at: '2026-07-27 12:30:00',
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'page_expiry_deletions'").get()).toEqual({
      name: 'page_expiry_deletions',
    });
    db.close();
  });

  it('adds the stopped build state without losing existing queue rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-build-stopped-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0047_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id)
       VALUES ('done-chat', 1, 1, 'Done', 'claude', 'done-native'),
              ('failed-chat', 1, 1, 'Failed', 'claude', 'failed-native'),
              ('stopped-chat', 1, 1, 'Stopped', 'claude', 'stopped-native')`,
    ).run();
    db.prepare(
      `INSERT INTO build_queue (id, user_id, conversation_id, title, brief, status, error, scope_key)
       VALUES (1, 1, 'done-chat', 'Done build', 'done', 'done', NULL, 'source'),
              (2, 1, 'failed-chat', 'Failed build', 'failed', 'failed', 'provider failed', 'source')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0047_build_queue_stopped.sql'),
      path.join(dir, '0047_build_queue_stopped.sql'),
    );
    migrate(db, dir);

    expect(db.prepare('SELECT id, status, error, scope_key FROM build_queue ORDER BY id').all()).toEqual([
      { id: 1, status: 'done', error: null, scope_key: 'source' },
      { id: 2, status: 'failed', error: 'provider failed', scope_key: 'source' },
    ]);
    expect(() =>
      db.prepare(
        `INSERT INTO build_queue (user_id, conversation_id, title, brief, status, scope_key)
         VALUES (1, 'stopped-chat', 'Stopped build', 'stopped', 'stopped', 'source')`,
      ).run(),
    ).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('backfills existing chats as Team and constrains new visibility values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-chat-visibility-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0053_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id)
       VALUES ('legacy-chat', 1, 1, 'claude', 'legacy-native')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0053_chat_visibility.sql'),
      path.join(dir, '0053_chat_visibility.sql'),
    );
    migrate(db, dir);

    expect(db.prepare("SELECT visibility FROM conversations WHERE id = 'legacy-chat'").get()).toEqual({
      visibility: 'team',
    });
    expect(() => db.prepare("UPDATE conversations SET visibility = 'hidden'").run()).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('removes connector permission state without breaking existing connections', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-connector-access-migrate-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0056_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('p1', 'alpha', 'Alpha')").run();
    const config = JSON.stringify({
      sessionId: 'session-existing',
      connectedAccountId: 'account-existing',
      mcp: { type: 'http', url: 'https://mcp.example.test' },
      permission: {
        profile: 'read_only',
        version: 1,
        authConfigId: 'auth-existing',
        requestedScopes: ['mail.read'],
        requestedUserScopes: [],
        toolSlugs: ['GMAIL_FETCH_EMAILS'],
      },
    });
    db.prepare(
      `INSERT INTO user_connectors
         (id, user_id, connector_slug, status, config_json, permission_profile, permission_version)
       VALUES (10, 1, 'gmail', 'connected', ?, 'read_only', 1)`,
    ).run(config);
    db.prepare("INSERT INTO user_connector_projects (connector_id, project_id) VALUES (10, 'p1')").run();
    db.prepare(
      `INSERT INTO connector_auth_configs
         (connector_slug, permission_profile, permission_version, auth_config_id,
          requested_scopes_json, requested_user_scopes_json)
       VALUES ('gmail', 'read_only', 1, 'auth-existing', '["mail.read"]', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO settings (key, value_json)
       VALUES ('connector_permission_settings', '{"gmail":{"enabledProfiles":["read_only"]}}')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0056_simplify_composio_connectors.sql'),
      path.join(dir, '0056_simplify_composio_connectors.sql'),
    );
    migrate(db, dir);

    const columns = (db.pragma('table_info(user_connectors)') as { name: string }[]).map((column) => column.name);
    expect(columns).not.toContain('permission_profile');
    expect(columns).not.toContain('permission_version');
    const row = db.prepare('SELECT config_json FROM user_connectors WHERE id = 10').get() as { config_json: string };
    expect(JSON.parse(row.config_json)).toEqual({
      sessionId: 'session-existing',
      connectedAccountId: 'account-existing',
      mcp: { type: 'http', url: 'https://mcp.example.test' },
    });
    expect(db.prepare('SELECT * FROM user_connector_projects').all()).toEqual([{ connector_id: 10, project_id: 'p1' }]);
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'connector_permission_settings'").get()).toBeUndefined();
    expect(() => db.prepare('SELECT * FROM connector_auth_configs').all()).toThrow();
    expect(() => db.prepare('SELECT * FROM connector_permission_changes').all()).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('adds connector access modes without changing old sessions or custom settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-access-modes-migrate-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0061_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    const customConfig = JSON.stringify({ settings: { accountId: '123', privateKey: 'stored-custom-secret' } });
    db.prepare(
      `INSERT INTO user_connectors (id, user_id, connector_slug, status, config_json)
       VALUES (20, 1, 'netsuite', 'connected', ?)`,
    ).run(customConfig);
    const driveConfig = JSON.stringify({
      sessionId: 'drive-existing',
      connectedAccountId: 'drive-account-existing',
      mcp: { type: 'http', url: 'https://mcp.example.test/drive' },
    });
    db.prepare(
      `INSERT INTO user_connectors (id, user_id, connector_slug, status, config_json)
       VALUES (21, 1, 'googledrive', 'connected', ?)`,
    ).run(driveConfig);

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0061_connector_access_modes.sql'),
      path.join(dir, '0061_connector_access_modes.sql'),
    );
    migrate(db, dir);

    expect(db.prepare('SELECT access_mode, access_version, config_json FROM user_connectors WHERE id = 20').get()).toEqual({
      access_mode: null,
      access_version: null,
      config_json: customConfig,
    });
    expect(db.prepare('SELECT access_mode, access_version, config_json FROM user_connectors WHERE id = 21').get()).toEqual({
      access_mode: null,
      access_version: null,
      config_json: driveConfig,
    });
    expect(() => db.prepare("UPDATE user_connectors SET access_mode = 'admin' WHERE id = 20").run()).toThrow();
    db.prepare(
      `INSERT INTO connector_auth_configs
         (connector_slug, access_mode, access_version, auth_config_id, toolkit_version,
          oauth_scopes_json, tool_slugs_json)
       VALUES ('gmail', 'read_only', 1, 'auth-legacy', '20260721_00', '[]', '[]')`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0062_connector_auth_scope_strategy.sql'),
      path.join(dir, '0062_connector_auth_scope_strategy.sql'),
    );
    migrate(db, dir);

    expect(db.prepare(
      "SELECT oauth_scope_strategy FROM connector_auth_configs WHERE auth_config_id = 'auth-legacy'",
    ).get()).toEqual({ oauth_scope_strategy: 'explicit' });
    db.prepare(
      `INSERT INTO connector_auth_configs
         (connector_slug, access_mode, access_version, auth_config_id, toolkit_version,
          oauth_scope_strategy, oauth_scopes_json, tool_slugs_json)
       VALUES ('googledrive', 'read_only', 1, 'auth-drive', '20260721_00',
               'managed_default', '[]', '[]')`,
    ).run();
    expect(() => db.prepare(
      "UPDATE connector_auth_configs SET oauth_scope_strategy = 'derived' WHERE auth_config_id = 'auth-drive'",
    ).run()).toThrow();
    db.prepare(
      `INSERT INTO connector_access_changes
         (connector_id, access_mode, access_version, config_json)
       VALUES (20, 'read_only', 1, '{}')`,
    ).run();
    db.prepare('DELETE FROM user_connectors WHERE id = 20').run();
    db.prepare('DELETE FROM user_connectors WHERE id = 21').run();
    expect(db.prepare('SELECT * FROM connector_access_changes').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('gives each browser profile an owner and turns the project default into a personal one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-browser-owners-'));
    dirs.push(dir);
    for (const file of fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0085_')
      .sort()) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'one', 'Project One')").run();
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-2', 'two', 'Project Two')").run();
    db.prepare(
      `INSERT INTO veneer_browser_profiles (id, client_scope, project_id, name, created_by)
       VALUES ('profile-owner', 'client-a', 'project-1', 'Owner login', 1),
              ('profile-member', 'client-a', 'project-1', 'Member login', 2),
              ('profile-two', 'client-a', 'project-2', 'Other project', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO veneer_browser_project_settings (client_scope, project_id, default_profile_id)
       VALUES ('client-a', 'project-1', 'profile-member'), ('client-a', 'project-2', NULL)`,
    ).run();

    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, '0085_veneer_browser_profile_owners.sql'),
      path.join(dir, '0085_veneer_browser_profile_owners.sql'),
    );
    migrate(db, dir);

    expect(db.prepare('SELECT id, owner_user_id FROM veneer_browser_profiles ORDER BY id').all()).toEqual([
      { id: 'profile-member', owner_user_id: 2 },
      { id: 'profile-owner', owner_user_id: 1 },
      { id: 'profile-two', owner_user_id: 1 },
    ]);
    // The one project-wide default becomes the personal default of the person
    // who owns it; nobody else inherits it, and a default that pointed nowhere
    // named no person to give it to.
    expect(db.prepare(
      'SELECT project_id, user_id, default_profile_id FROM veneer_browser_project_settings ORDER BY project_id, user_id',
    ).all()).toEqual([
      { project_id: 'project-1', user_id: 2, default_profile_id: 'profile-member' },
    ]);

    db.prepare('DELETE FROM users WHERE id = 2').run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM veneer_browser_profiles WHERE id = 'profile-member'").get())
      .toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('records a content hash for each applied migration', () => {
    const dir = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    migrate(db, dir);

    const row = db.prepare("SELECT content_hash FROM migrations WHERE name = '0001_init.sql'").get() as {
      content_hash: string | null;
    };
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it('warns loudly without throwing or re-running when an applied migration file is edited', () => {
    const dir = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    migrate(db, dir);

    fs.writeFileSync(
      path.join(dir, '0001_init.sql'),
      'CREATE TABLE t (id INTEGER PRIMARY KEY);\nALTER TABLE t ADD COLUMN added_later TEXT;',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => migrate(db, dir)).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('DRIFT: 0001_init.sql'));
      // The edit never runs: only a NEW migration may change an applied schema.
      const columns = (db.pragma('table_info(t)') as { name: string }[]).map((c) => c.name);
      expect(columns).not.toContain('added_later');
    } finally {
      error.mockRestore();
    }
    db.close();
  });

  it('silently backfills hashes for migrations applied before hashing existed', () => {
    const dir = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
    });
    dirs.push(dir);

    const db = new Database(':memory:');
    migrate(db, dir);
    db.prepare('UPDATE migrations SET content_hash = NULL').run();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      migrate(db, dir);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    const row = db.prepare("SELECT content_hash FROM migrations WHERE name = '0001_init.sql'").get() as {
      content_hash: string | null;
    };
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });
});
