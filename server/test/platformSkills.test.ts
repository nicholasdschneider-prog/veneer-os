import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { proClaudeConfigDir, proCodexHome, proGrokHome, type Homes } from '../src/homes.js';
import { createSkillStore, SkillError } from '../src/skills/store.js';
import {
  installPlatformSkills,
  isInstalledPlatformSkill,
  platformSkillsRoot,
  PLATFORM_SKILL_NAMES,
} from '../src/skills/platform.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(TEST_DIR, '../src/db/migrations');
const PRODUCT_SKILLS = path.resolve(TEST_DIR, '../../agent-skills');
const temporaryDirectories: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-platform-skills-'));
  temporaryDirectories.push(root);
  const sourceDir = path.join(root, 'repo');
  const dataDir = path.join(root, 'data');
  const homes: Homes = {
    loginHome: path.join(root, 'login-home'),
    serviceHome: path.join(root, 'service-home'),
  };
  const productRoot = platformSkillsRoot(sourceDir);
  fs.mkdirSync(productRoot, { recursive: true });
  for (const name of PLATFORM_SKILL_NAMES) {
    fs.cpSync(path.join(PRODUCT_SKILLS, name), path.join(productRoot, name), {
      recursive: true,
    });
  }
  return { root, sourceDir, dataDir, homes };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('product-owned platform skills', () => {
  it('installs shared skills for every provider and repairs stale copies', () => {
    const { sourceDir, homes } = setup();
    const installed = installPlatformSkills({ sourceDir, homes });
    expect(installed.map((item) => item.name)).toEqual([...PLATFORM_SKILL_NAMES]);
    for (const item of installed) {
      expect(fs.lstatSync(item.codexPath).isDirectory()).toBe(true);
      expect(fs.lstatSync(item.claudePath).isDirectory()).toBe(true);
      expect(fs.lstatSync(item.grokPath).isDirectory()).toBe(true);
      expect(isInstalledPlatformSkill(item.codexPath, item.name)).toBe(true);
      expect(isInstalledPlatformSkill(item.claudePath, item.name)).toBe(true);
      expect(isInstalledPlatformSkill(item.grokPath, item.name)).toBe(true);
      expect(fs.readFileSync(path.join(item.codexPath, 'SKILL.md'), 'utf8')).toBe(
        fs.readFileSync(path.join(item.claudePath, 'SKILL.md'), 'utf8'),
      );
      expect(fs.readFileSync(path.join(item.grokPath, 'SKILL.md'), 'utf8')).toBe(
        fs.readFileSync(path.join(item.claudePath, 'SKILL.md'), 'utf8'),
      );
    }

    fs.writeFileSync(path.join(installed[1]!.claudePath, 'SKILL.md'), 'old');
    installPlatformSkills({ sourceDir, homes });
    expect(fs.readFileSync(path.join(installed[1]!.claudePath, 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(installed[1]!.source, 'SKILL.md'), 'utf8'),
    );
  });

  it('never overwrites a real provider skill directory with the reserved name', () => {
    const { sourceDir, homes } = setup();
    const conflict = path.join(proCodexHome(homes), 'skills', 'veneer-publish-page');
    fs.mkdirSync(conflict, { recursive: true });
    fs.writeFileSync(path.join(conflict, 'keep.txt'), 'keep');
    expect(() => installPlatformSkills({ sourceDir, homes })).toThrow('already exists and is not owned by Veneer Pro');
    expect(fs.readFileSync(path.join(conflict, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('never overwrites an unmarked Grok skill directory with a reserved name', () => {
    const { sourceDir, homes } = setup();
    const conflict = path.join(proGrokHome(homes), 'skills', 'veneer-publish-page');
    fs.mkdirSync(conflict, { recursive: true });
    fs.writeFileSync(path.join(conflict, 'keep.txt'), 'keep');
    expect(() => installPlatformSkills({ sourceDir, homes })).toThrow('already exists and is not owned by Veneer Pro');
    expect(fs.readFileSync(path.join(conflict, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('lists the skill as shared and read-only in the Skills store', () => {
    const { sourceDir, dataDir, homes } = setup();
    installPlatformSkills({ sourceDir, homes });
    const db = new Database(':memory:');
    try {
      migrate(db, MIGRATIONS);
      const store = createSkillStore({
        config: { sourceDir, dataDir } as Config,
        db,
        homes: {
          codexHome: proCodexHome(homes),
          claudeHome: proClaudeConfigDir(homes),
          grokHome: proGrokHome(homes),
        },
      });
      const global = store.list('owner').scopes.find((scope) => scope.scope === 'global');
      for (const name of PLATFORM_SKILL_NAMES) {
        const skill = global?.skills.find((item) => item.name === name);
        expect(skill).toMatchObject({
          origin: 'platform',
          readOnly: true,
          shared: true,
          providers: { claude: 'ok', codex: 'ok', grok: 'ok' },
        });
      }
      expect(() => store.save('global', 'veneer-publish-page', { body: 'changed' })).toThrow(SkillError);
    } finally {
      db.close();
    }
  });

  it('contains the required page-first trigger and explicit app exception', () => {
    const skill = fs.readFileSync(path.join(PRODUCT_SKILLS, 'veneer-publish-page', 'SKILL.md'), 'utf8');
    expect(skill).toContain('Default to a page even when it has client-side interaction');
    expect(skill).toContain('Use publish_app only when the user explicitly asks for an app or interactive tool');
    expect(skill).toContain('Localhost is internal verification only');
    expect(skill).toContain('mcp__agents__publish_page');
    expect(skill).not.toContain('[TODO:');
  });

  it('contains the native Todo workflow and browser guard', () => {
    const skill = fs.readFileSync(path.join(PRODUCT_SKILLS, 'veneer-todos', 'SKILL.md'), 'utf8');
    expect(skill).toContain('mcp__agents__create_todo');
    expect(skill).toContain('Never use browser automation');
    expect(skill).toContain('Default to Inbox');
    expect(skill).toContain('Never edit by title alone');
    expect(skill).not.toContain('[TODO:');
  });
});
