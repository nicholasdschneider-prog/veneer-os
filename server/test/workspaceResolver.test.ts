import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createWorkspaceResolver } from '../src/runtime/buildAgentRuntime.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

describe('assistant workspace resolver', () => {
  let dir: string;
  let db: Database.Database;
  let resolve: ReturnType<typeof createWorkspaceResolver>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-workspace-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    resolve = createWorkspaceResolver({
      db,
      dataDir: path.join(dir, 'data'),
      sourceDir: path.join(dir, 'source'),
      defaultAssistantSlug: 'assistant',
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function assistantId(slug: string): number {
    return (db.prepare('SELECT id FROM assistants WHERE slug = ?').get(slug) as { id: number }).id;
  }

  it('gives App Creator its own scratch workspace and persona', () => {
    const target = resolve({ assistant_id: assistantId('app-creator'), project_id: null });

    expect(target).toEqual({
      workspaceDir: path.join(dir, 'data', 'workspaces', 'app-creator'),
      assistantSlug: 'app-creator',
      elevated: false,
      fullAccess: true,
      projectId: null,
    });
    expect(fs.existsSync(target.workspaceDir)).toBe(true);
  });

  it('keeps the selected assistant persona inside a shared project folder', () => {
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'acme', 'Acme')").run();

    const target = resolve({ assistant_id: assistantId('app-creator'), project_id: 'project-1' });

    expect(target.workspaceDir).toBe(path.join(dir, 'data', 'workspaces', 'projects', 'acme'));
    expect(target.assistantSlug).toBe('app-creator');
    expect(target.projectId).toBe('project-1');
    expect(target.elevated).toBe(false);
    expect(target.fullAccess).toBe(true);
  });

  it('still reserves the live source checkout and existing Full Access behavior for Platform Dev', () => {
    const target = resolve({ assistant_id: assistantId('platform-dev'), project_id: null });

    expect(target).toEqual({
      workspaceDir: path.join(dir, 'source'),
      assistantSlug: 'platform-dev',
      elevated: true,
      sourceWorkspace: true,
      fullAccess: true,
      projectId: null,
    });
  });

  it('runs Platform Dev inside the selected project folder', () => {
    db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'acme', 'Acme')").run();

    const target = resolve({ assistant_id: assistantId('platform-dev'), project_id: 'project-1' });

    expect(target).toEqual({
      workspaceDir: path.join(dir, 'data', 'workspaces', 'projects', 'acme'),
      assistantSlug: 'platform-dev',
      elevated: true,
      sourceWorkspace: false,
      fullAccess: true,
      projectId: 'project-1',
      customRoot: false,
    });
  });

  it('keeps Platform Dev elevated when the selected project is the live source checkout', () => {
    const sourceDir = path.join(dir, 'source');
    db.prepare("INSERT INTO projects (id, slug, name, root_dir) VALUES ('project-1', 'veneer', 'Veneer', ?)").run(
      sourceDir,
    );

    const target = resolve({ assistant_id: assistantId('platform-dev'), project_id: 'project-1' });

    expect(target).toEqual({
      workspaceDir: sourceDir,
      assistantSlug: 'platform-dev',
      elevated: true,
      sourceWorkspace: true,
      fullAccess: true,
      projectId: 'project-1',
      customRoot: true,
    });
  });

  it('reads an agent Full Access change live without restarting the resolver', () => {
    const id = assistantId('data-analyst');
    expect(resolve({ assistant_id: id, project_id: null }).fullAccess).toBe(true);

    db.prepare("UPDATE assistants SET full_access = 0 WHERE slug = 'data-analyst'").run();

    expect(resolve({ assistant_id: id, project_id: null }).fullAccess).toBe(false);

    db.prepare("UPDATE assistants SET full_access = 1 WHERE slug = 'data-analyst'").run();

    expect(resolve({ assistant_id: id, project_id: null }).fullAccess).toBe(true);
  });
});
