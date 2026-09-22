import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { createSkillsRouter } from '../src/routes/skills.js';
import { resetHomesCache } from '../src/homes.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

const USERS: Record<string, UserRow> = {
  member: { id: 3, email: 'm@x.com', display_name: 'M', role: 'member', created_at: '' },
  owner: { id: 2, email: 'o@x.com', display_name: 'O', role: 'owner', created_at: '' },
  consultant: { id: 1, email: 'c@x.com', display_name: 'C', role: 'consultant', created_at: '' },
};

let tmp: string;
let dataDir: string;
let sourceDir: string;
let codexHome: string;
let claudeHome: string;
let grokHome: string;
let db: Database.Database;
let server: Server;
let base: string;
let savedHome: string | undefined;
let savedCodex: string | undefined;
let savedServiceHome: string | undefined;
let savedGrok: string | undefined;

// Live real/link/holding dirs for the global scope.
const gReal = () => path.join(codexHome, 'skills');
const gLink = () => path.join(claudeHome, 'skills');
const gHold = () => path.join(codexHome, 'skills-disabled');
const gGrok = () => path.join(grokHome, 'skills');

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-skills-'));
  dataDir = path.join(tmp, 'data');
  sourceDir = path.join(tmp, 'source');
  codexHome = path.join(tmp, 'codex');
  claudeHome = path.join(tmp, 'home', '.claude');
  grokHome = path.join(tmp, 'home', '.grok');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  // The router builds its store from env-derived homes at construction time.
  // VP_SERVICE_HOME wins over HOME in resolveServiceHome(), and currentHomes()
  // caches per process — override both and drop the cache, or the Claude-side
  // symlinks land in the REAL global skills dir.
  savedHome = process.env.HOME;
  savedCodex = process.env.CODEX_HOME;
  savedServiceHome = process.env.VP_SERVICE_HOME;
  savedGrok = process.env.GROK_HOME;
  process.env.HOME = path.join(tmp, 'home');
  process.env.CODEX_HOME = codexHome;
  process.env.VP_SERVICE_HOME = path.join(tmp, 'home');
  process.env.GROK_HOME = grokHome;
  resetHomesCache();

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('p1', 'proj-one', 'Proj One')").run();
  for (const user of Object.values(USERS)) db.prepare('INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,?)').run(user.id,user.email,user.display_name,user.role);

  const ctx = { config: { dataDir, sourceDir }, db } as unknown as AppContext;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.agentConversationId = req.headers['x-test-chat'] as string | undefined;
    req.user = USERS[String(req.headers['x-test-user'] ?? 'owner')];
    next();
  });
  app.use('/api/skills', createSkillsRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodex;
  if (savedServiceHome === undefined) delete process.env.VP_SERVICE_HOME;
  else process.env.VP_SERVICE_HOME = savedServiceHome;
  if (savedGrok === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrok;
  resetHomesCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe every scope's on-disk skills between tests.
  for (const dir of [
    gReal(),
    gLink(),
    gHold(),
    gGrok(),
    path.join(sourceDir, '.agents'),
    path.join(sourceDir, '.claude'),
    path.join(dataDir, 'workspaces'),
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(path.join(codexHome, 'skills', '.system'), { recursive: true, force: true });
});

async function call(method: string, url: string, user: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

describe('skills routes', () => {
  it('allows audited project training by business members, without global or linked-skill writes', async () => {
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('training-team','Training',2)").run();
    db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('training-team',3,'member')").run();
    db.prepare(`INSERT INTO conversations(id,assistant_id,user_id,project_id,business_team_id,visibility,provider,native_session_id,channel)
      SELECT 'training-chat',id,2,'p1','training-team','team','codex','training-native','web' FROM assistants WHERE slug='assistant'`).run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by,active) VALUES('training-chat','Training',2,1)").run();
    db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES('training-chat','training-team','bot')").run();
    try {
      const created = await call('POST', '/api/skills/project:p1', 'member', { name: 'training', description: 'Accounting training', body: 'Original' });
      expect(created.status).toBe(200);
      const saved = await call('PUT', '/api/skills/project:p1/training', 'member', { body: 'Durable correction' });
      expect(saved.status).toBe(200);
      expect(saved.json!.skill.body).toContain('Durable correction');
      expect(db.prepare("SELECT actor_id,action FROM business_audit WHERE team_id='training-team'").all()).toEqual([{actor_id:3,action:'skill.created'},{actor_id:3,action:'skill.updated'}]);
      expect((await call('POST', '/api/skills/source', 'member', {name:'blocked',description:'d'})).status).toBe(403);
      const wrongChat = await fetch(`${base}/api/skills/project:p1/training`, {method:'PUT', headers:{'Content-Type':'application/json','x-test-user':'member','x-test-chat':'other-chat'},body:JSON.stringify({body:'Wrong chat'})});
      expect(wrongChat.status).toBe(403);
      await call('POST', '/api/skills/global', 'owner', {name:'global-rule',description:'d',body:'Private'});
      const localRoot = path.dirname(created.json!.skill.canonicalDir);
      fs.symlinkSync(path.join(gReal(),'global-rule'),path.join(localRoot,'linked-rule'));
      expect((await call('PUT', '/api/skills/project:p1/linked-rule', 'member', {body:'Overwrite'})).status).toBe(403);
      fs.symlinkSync(created.json!.skill.canonicalDir,path.join(gReal(),'training'));
      expect((await call('PUT', '/api/skills/project:p1/training', 'member', {body:'Global overwrite'})).status).toBe(403);
      fs.unlinkSync(path.join(gReal(),'training'));
      for (const [change,restore] of [
        ["UPDATE business_team_members SET role='viewer' WHERE user_id=3", "UPDATE business_team_members SET role='member' WHERE user_id=3"],
        ["UPDATE users SET status='disabled' WHERE id=3", "UPDATE users SET status='active' WHERE id=3"],
        ["UPDATE conversations SET visibility='private' WHERE id='training-chat'", "UPDATE conversations SET visibility='team' WHERE id='training-chat'"],
        ["INSERT INTO employee_workspaces(user_id) VALUES(3)", "DELETE FROM employee_workspaces WHERE user_id=3"],
      ]) {
        db.prepare(change!).run();
        expect((await call('PUT', '/api/skills/project:p1/training', 'member', {body:'Denied'})).status).toBe(403);
        db.prepare(restore!).run();
      }
      db.prepare("DELETE FROM business_team_members WHERE team_id='training-team'").run();
      expect((await call('PUT', '/api/skills/project:p1/training', 'member', {body:'Revoked'})).status).toBe(403);
    } finally {
      db.prepare("DELETE FROM business_team_members WHERE team_id='training-team'").run();
    }
  });

  it('sandboxes every scope root inside the test temp dir (never the real home)', async () => {
    // macOS: os.tmpdir() is /var/... but roots may come back canonicalized as /private/var/...
    const bases = [tmp, fs.realpathSync(tmp)];
    const res = await call('GET', '/api/skills', 'owner');
    for (const scope of res.json!.scopes as any[]) {
      expect(bases.some((b) => (scope.root as string).startsWith(b))).toBe(true);
    }
  });

  it('creates a global skill once with resolvable Claude and pinned-Grok links', async () => {
    const res = await call('POST', '/api/skills/global', 'owner', {
      name: 'greet',
      description: 'Greet the customer warmly',
      body: '# Greet\n',
    });
    expect(res.status).toBe(200);
    expect(res.json!.skill.providers).toEqual({ claude: 'ok', codex: 'ok', grok: 'ok' });
    expect(res.json!.skill.shared).toBe(true);
    expect(res.json!.skill.entryKind).toBe('original');
    expect(res.json!.skill.dependents).toEqual([]);
    expect(fs.readFileSync(path.join(gReal(), 'greet', 'SKILL.md'), 'utf8')).toContain('name: greet');
    const link = path.join(gLink(), 'greet');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(gReal(), 'greet')));
    const grokLink = path.join(gGrok(), 'greet');
    expect(fs.lstatSync(grokLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(grokLink)).toBe(fs.realpathSync(path.join(gReal(), 'greet')));
  });

  it('lists and unifies the two paths into one entry', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'onlyone', description: 'x', body: '' });
    const res = await call('GET', '/api/skills', 'owner');
    const global = (res.json!.scopes as any[]).find((s) => s.scope === 'global');
    const rows = global.skills.filter((s: any) => s.name === 'onlyone' || s.name === 'onlyone');
    const entry = global.skills.find((s: any) => s.name === 'onlyone');
    expect(entry).toBeTruthy();
    expect(entry.providers).toEqual({ claude: 'ok', codex: 'ok', grok: 'ok' });
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it('adopts a Claude-only real dir via sync: moves to .agents/skills, relinks, both providers ok', async () => {
    const claudeReal = path.join(sourceDir, '.claude', 'skills', 'verify');
    fs.mkdirSync(claudeReal, { recursive: true });
    fs.writeFileSync(path.join(claudeReal, 'SKILL.md'), '# Verify\n\nRun the checks.\n');

    const before = await call('GET', '/api/skills/source/verify', 'owner');
    expect(before.json!.skill.providers.codex).toBe('missing');
    expect(before.json!.skill.origin).toBe('user');

    const res = await call('POST', '/api/skills/source/verify/sync', 'owner');
    expect(res.status).toBe(200);
    expect(res.json!.skill.providers).toEqual({ claude: 'ok', codex: 'ok', grok: 'ok' });
    const realMd = path.join(sourceDir, '.agents', 'skills', 'verify', 'SKILL.md');
    expect(fs.existsSync(realMd)).toBe(true);
    expect(fs.readFileSync(realMd, 'utf8')).toContain('name: verify');
    const link = path.join(sourceDir, '.claude', 'skills', 'verify');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(path.join('..', '..', '.agents', 'skills', 'verify'));
  });

  it('renames the dir + name line + relinks, and 409s on target collision', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'alpha', description: 'a', body: 'x' });
    await call('POST', '/api/skills/global', 'owner', { name: 'gamma', description: 'g', body: 'y' });

    const clash = await call('PATCH', '/api/skills/global/alpha', 'owner', { newName: 'gamma' });
    expect(clash.status).toBe(409);

    const res = await call('PATCH', '/api/skills/global/alpha', 'owner', { newName: 'beta' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(gReal(), 'alpha'))).toBe(false);
    expect(fs.readFileSync(path.join(gReal(), 'beta', 'SKILL.md'), 'utf8')).toContain('name: beta');
    expect(fs.realpathSync(path.join(gLink(), 'beta'))).toBe(fs.realpathSync(path.join(gReal(), 'beta')));
    expect(fs.existsSync(path.join(gGrok(), 'alpha'))).toBe(false);
    expect(fs.realpathSync(path.join(gGrok(), 'beta'))).toBe(fs.realpathSync(path.join(gReal(), 'beta')));
  });

  it('disables into the sibling holding dir (links gone, still listed) and re-enables', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'toggler', description: 't', body: 'z' });

    const off = await call('PATCH', '/api/skills/global/toggler', 'owner', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json!.skill.enabled).toBe(false);
    expect(fs.existsSync(path.join(gHold(), 'toggler'))).toBe(true);
    expect(fs.existsSync(path.join(gReal(), 'toggler'))).toBe(false);
    expect(fs.existsSync(path.join(gLink(), 'toggler'))).toBe(false);
    expect(fs.existsSync(path.join(gGrok(), 'toggler'))).toBe(false);

    // Repair must remove any stale provider link while the skill is parked.
    fs.mkdirSync(gGrok(), { recursive: true });
    fs.symlinkSync(path.join(gHold(), 'toggler'), path.join(gGrok(), 'toggler'));
    await call('POST', '/api/skills/global/toggler/sync', 'owner');
    expect(fs.existsSync(path.join(gGrok(), 'toggler'))).toBe(false);

    const list = await call('GET', '/api/skills', 'owner');
    const global = (list.json!.scopes as any[]).find((s) => s.scope === 'global');
    expect(global.skills.find((s: any) => s.name === 'toggler').enabled).toBe(false);

    const on = await call('PATCH', '/api/skills/global/toggler', 'owner', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.json!.skill.enabled).toBe(true);
    expect(fs.existsSync(path.join(gReal(), 'toggler'))).toBe(true);
    expect(fs.existsSync(path.join(gHold(), 'toggler'))).toBe(false);
    expect(fs.realpathSync(path.join(gGrok(), 'toggler'))).toBe(fs.realpathSync(path.join(gReal(), 'toggler')));
  });

  it('deletes the real dir and every provider link', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'gone', description: 'd', body: 'q' });
    expect(fs.existsSync(path.join(gReal(), 'gone'))).toBe(true);
    const res = await call('DELETE', '/api/skills/global/gone', 'owner');
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(gReal(), 'gone'))).toBe(false);
    expect(fs.existsSync(path.join(gLink(), 'gone'))).toBe(false);
    expect(fs.existsSync(path.join(gGrok(), 'gone'))).toBe(false);
  });

  it('creates in a project scope at the project .agents/skills path', async () => {
    const res = await call('POST', '/api/skills/project:p1', 'owner', { name: 'pskill', description: 'p', body: 'b' });
    expect(res.status).toBe(200);
    const realMd = path.join(dataDir, 'workspaces', 'projects', 'proj-one', '.agents', 'skills', 'pskill', 'SKILL.md');
    expect(fs.existsSync(realMd)).toBe(true);
    expect(fs.existsSync(path.join(gGrok(), 'pskill'))).toBe(false);
    expect(res.json!.skill.providers.grok).toBe('ok');
  });

  it('rejects invalid skill names on create', async () => {
    for (const name of ['../x', '.hidden', 'A_b', 'x--y', 'a'.repeat(65)]) {
      const res = await call('POST', '/api/skills/global', 'owner', { name, description: 'd', body: '' });
      expect(res.status).toBe(400);
    }
  });

  it('409s a save when expectedMtime no longer matches, echoing current content', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'conf', description: 'c', body: 'first' });
    const detail = await call('GET', '/api/skills/global/conf', 'owner');
    const mtime = detail.json!.skill.mtime as number;
    const res = await call('PUT', '/api/skills/global/conf', 'owner', {
      description: 'second',
      expectedMtime: mtime - 5000,
    });
    expect(res.status).toBe(409);
    expect(res.json!.error).toBeTruthy();
    expect(res.json!.mtime).toBe(mtime);
    expect(typeof res.json!.raw).toBe('string');
  });

  it('saves form edits (description + body) preserving unknown frontmatter', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'formy', description: 'orig', body: 'orig body' });
    // Inject an unknown key directly on disk.
    const md = path.join(gReal(), 'formy', 'SKILL.md');
    fs.writeFileSync(md, '---\nname: formy\ndescription: orig\nallowed-tools: Bash\n---\n\norig body\n');
    const res = await call('PUT', '/api/skills/global/formy', 'owner', { description: 'updated', body: 'new body' });
    expect(res.status).toBe(200);
    const raw = fs.readFileSync(md, 'utf8');
    expect(raw).toContain('allowed-tools: Bash');
    expect(raw).toContain('description: "updated"');
    expect(raw).toContain('new body');
  });

  it('lists Codex .system builtins read-only', async () => {
    const sysDir = path.join(codexHome, 'skills', '.system', 'plan');
    fs.mkdirSync(sysDir, { recursive: true });
    fs.writeFileSync(path.join(sysDir, 'SKILL.md'), '---\nname: plan\ndescription: Built-in planner\n---\nx');
    const res = await call('GET', '/api/skills', 'owner');
    const plan = (res.json!.builtins as any[]).find((s) => s.name === 'plan');
    expect(plan).toBeTruthy();
    expect(plan.readOnly).toBe(true);
    expect(plan.origin).toBe('system');
    // .system is skipped by the global scope enumeration.
    const global = (res.json!.scopes as any[]).find((s) => s.scope === 'global');
    expect(global.skills.find((s: any) => s.name === '.system')).toBeUndefined();
  });

  it('denies members every write but allows reads, and omits source from their list', async () => {
    expect((await call('POST', '/api/skills/global', 'member', { name: 'x', description: 'd', body: '' })).status).toBe(403);
    expect((await call('PUT', '/api/skills/global/x', 'member', { description: 'd' })).status).toBe(403);
    expect((await call('PATCH', '/api/skills/global/x', 'member', { enabled: false })).status).toBe(403);
    expect((await call('POST', '/api/skills/global/x/sync', 'member')).status).toBe(403);
    expect((await call('DELETE', '/api/skills/global/x', 'member')).status).toBe(403);

    const memberList = await call('GET', '/api/skills', 'member');
    expect(memberList.status).toBe(200);
    expect((memberList.json!.scopes as any[]).some((s) => s.scope === 'source')).toBe(false);

    const ownerList = await call('GET', '/api/skills', 'owner');
    expect((ownerList.json!.scopes as any[]).some((s) => s.scope === 'source')).toBe(true);
  });

  it('reports cross-scope duplicates on create', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'dup', description: 'g', body: '' });
    const res = await call('POST', '/api/skills/source', 'owner', { name: 'dup', description: 's', body: '' });
    expect(res.status).toBe(200);
    expect(res.json!.crossScopeDuplicates).toContain('global');
  });

  it('delete spares a same-named unrelated real dir on the Claude side (name clash)', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'twin', description: 'canonical', body: '' });
    // An independent hand-authored skill squatting the Claude path (not a link).
    const clash = path.join(gLink(), 'twin');
    fs.rmSync(clash, { force: true }); // replace our symlink with a real dir
    fs.mkdirSync(clash, { recursive: true });
    fs.writeFileSync(path.join(clash, 'SKILL.md'), '# Other twin\n');

    const res = await call('DELETE', '/api/skills/global/twin', 'owner');
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(gReal(), 'twin'))).toBe(false);
    // The unrelated Claude-side skill survives.
    expect(fs.readFileSync(path.join(clash, 'SKILL.md'), 'utf8')).toContain('Other twin');
  });

  it('never touches a same-named skill in the login-home Claude profile', async () => {
    const loginSkill = path.join(tmp, 'login-owner', '.claude', 'skills', 'private-name');
    fs.mkdirSync(loginSkill, { recursive: true });
    fs.writeFileSync(path.join(loginSkill, 'SKILL.md'), '# Personal skill\n');

    await call('POST', '/api/skills/global', 'owner', { name: 'private-name', description: 'managed', body: '' });
    await call('PATCH', '/api/skills/global/private-name', 'owner', { newName: 'managed-name' });
    await call('DELETE', '/api/skills/global/managed-name', 'owner');

    expect(fs.readFileSync(path.join(loginSkill, 'SKILL.md'), 'utf8')).toBe('# Personal skill\n');
  });

  it('sync repairs a missing global Grok link without replacing a real collision', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'repair-grok', description: 'r', body: '' });
    fs.unlinkSync(path.join(gGrok(), 'repair-grok'));
    const repaired = await call('POST', '/api/skills/global/repair-grok/sync', 'owner');
    expect(repaired.json!.skill.providers.grok).toBe('ok');

    fs.unlinkSync(path.join(gGrok(), 'repair-grok'));
    fs.mkdirSync(path.join(gGrok(), 'repair-grok'));
    fs.writeFileSync(path.join(gGrok(), 'repair-grok', 'keep.txt'), 'personal');
    const collision = await call('POST', '/api/skills/global/repair-grok/sync', 'owner');
    expect(collision.json!.skill.providers.grok).toBe('missing');
    expect(collision.json!.skill.issues).toContain('name-clash:grok');
    expect(fs.readFileSync(path.join(gGrok(), 'repair-grok', 'keep.txt'), 'utf8')).toBe('personal');
  });

  it('disables an unadopted Claude-only skill by adopting it first (no 500)', async () => {
    const claudeReal = path.join(gLink(), 'lonely');
    fs.mkdirSync(claudeReal, { recursive: true });
    fs.writeFileSync(path.join(claudeReal, 'SKILL.md'), '# Lonely\n\nBody.\n');

    const off = await call('PATCH', '/api/skills/global/lonely', 'owner', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json!.skill.enabled).toBe(false);
    expect(fs.existsSync(path.join(gHold(), 'lonely'))).toBe(true);
    expect(fs.existsSync(claudeReal)).toBe(false);

    const on = await call('PATCH', '/api/skills/global/lonely', 'owner', { enabled: true });
    expect(on.status).toBe(200);
    expect(fs.existsSync(path.join(gReal(), 'lonely'))).toBe(true);
    expect(fs.lstatSync(path.join(gLink(), 'lonely')).isSymbolicLink()).toBe(true);
  });

  it('sync adopts a Claude real directory over a dangling Codex link', async () => {
    const name = 'legacy-email';
    const claudeReal = path.join(gLink(), name);
    fs.mkdirSync(claudeReal, { recursive: true });
    fs.writeFileSync(path.join(claudeReal, 'SKILL.md'), `---\nname: ${name}\ndescription: Legacy email\n---\n`);
    fs.mkdirSync(gReal(), { recursive: true });
    fs.symlinkSync('/missing/legacy-email', path.join(gReal(), name));

    const synced = await call('POST', `/api/skills/global/${name}/sync`, 'owner');
    expect(synced.status).toBe(200);
    expect(synced.json!.skill.providers).toEqual({ claude: 'ok', codex: 'ok', grok: 'ok' });
    expect(fs.lstatSync(path.join(gReal(), name)).isDirectory()).toBe(true);
    expect(fs.realpathSync(path.join(gLink(), name))).toBe(fs.realpathSync(path.join(gReal(), name)));
    expect(fs.realpathSync(path.join(gGrok(), name))).toBe(fs.realpathSync(path.join(gReal(), name)));
  });

  it('renames an unadopted Claude-only skill by adopting it first (no 500)', async () => {
    const claudeReal = path.join(gLink(), 'oldname');
    fs.mkdirSync(claudeReal, { recursive: true });
    fs.writeFileSync(path.join(claudeReal, 'SKILL.md'), '# Old\n');

    const res = await call('PATCH', '/api/skills/global/oldname', 'owner', { newName: 'newname' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(gReal(), 'newname', 'SKILL.md'), 'utf8')).toContain('name: newname');
    expect(fs.realpathSync(path.join(gLink(), 'newname'))).toBe(fs.realpathSync(path.join(gReal(), 'newname')));
    expect(fs.existsSync(claudeReal)).toBe(false);
  });

  // ── move (spec v2 §1/§5) ──────────────────────────────────────────────────
  const pReal = () => path.join(dataDir, 'workspaces', 'projects', 'proj-one', '.agents', 'skills');
  const pLink = () => path.join(dataDir, 'workspaces', 'projects', 'proj-one', '.claude', 'skills');
  const pHold = () => path.join(dataDir, 'workspaces', 'projects', 'proj-one', '.agents', 'skills-disabled');

  it('moves a project skill to global: dir moves, old link gone, new link resolves', async () => {
    await call('POST', '/api/skills/project:p1', 'owner', { name: 'promoteme', description: 'p', body: 'b' });
    expect(fs.existsSync(path.join(pReal(), 'promoteme'))).toBe(true);

    const res = await call('POST', '/api/skills/project:p1/promoteme/move', 'owner', { toScope: 'global' });
    expect(res.status).toBe(200);
    expect(res.json!.skill.scope).toBe('global');
    expect(res.json!.skill.providers).toEqual({ claude: 'ok', codex: 'ok', grok: 'ok' });
    // Source dir + link gone.
    expect(fs.existsSync(path.join(pReal(), 'promoteme'))).toBe(false);
    expect(fs.existsSync(path.join(pLink(), 'promoteme'))).toBe(false);
    // Destination real dir + resolvable Claude symlink.
    expect(fs.existsSync(path.join(gReal(), 'promoteme', 'SKILL.md'))).toBe(true);
    expect(fs.realpathSync(path.join(gLink(), 'promoteme'))).toBe(fs.realpathSync(path.join(gReal(), 'promoteme')));
    expect(fs.realpathSync(path.join(gGrok(), 'promoteme'))).toBe(fs.realpathSync(path.join(gReal(), 'promoteme')));
  });

  it('409s a move when the target name is already taken in the destination scope', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'taken', description: 'g', body: '' });
    await call('POST', '/api/skills/project:p1', 'owner', { name: 'taken', description: 'p', body: '' });
    const res = await call('POST', '/api/skills/project:p1/taken/move', 'owner', { toScope: 'global' });
    expect(res.status).toBe(409);
    // Source untouched.
    expect(fs.existsSync(path.join(pReal(), 'taken'))).toBe(true);
  });

  it('moves a parked skill as parked (stays disabled at the destination)', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'parkme', description: 'x', body: 'y' });
    await call('PATCH', '/api/skills/global/parkme', 'owner', { enabled: false });
    expect(fs.existsSync(path.join(gHold(), 'parkme'))).toBe(true);

    const res = await call('POST', '/api/skills/global/parkme/move', 'owner', { toScope: 'project:p1' });
    expect(res.status).toBe(200);
    expect(res.json!.skill.enabled).toBe(false);
    expect(fs.existsSync(path.join(pHold(), 'parkme'))).toBe(true);
    expect(fs.existsSync(path.join(pReal(), 'parkme'))).toBe(false);
    // No Claude link created for a parked move.
    expect(fs.existsSync(path.join(pLink(), 'parkme'))).toBe(false);
    expect(fs.existsSync(path.join(gHold(), 'parkme'))).toBe(false);
    expect(fs.existsSync(path.join(gGrok(), 'parkme'))).toBe(false);
  });

  it('moves source → project', async () => {
    await call('POST', '/api/skills/source', 'owner', { name: 'srcskill', description: 's', body: 'b' });
    const res = await call('POST', '/api/skills/source/srcskill/move', 'owner', { toScope: 'project:p1' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(sourceDir, '.agents', 'skills', 'srcskill'))).toBe(false);
    expect(fs.existsSync(path.join(pReal(), 'srcskill', 'SKILL.md'))).toBe(true);
  });

  // ── copy (spec v2 §1/§5) ──────────────────────────────────────────────────
  it('copies content + extra files to the destination and leaves the source in place', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'copyme', description: 'c', body: 'the body' });
    // An extra reference file alongside SKILL.md.
    fs.mkdirSync(path.join(gReal(), 'copyme', 'references'), { recursive: true });
    fs.writeFileSync(path.join(gReal(), 'copyme', 'references', 'notes.md'), 'ref notes');

    const res = await call('POST', '/api/skills/global/copyme/copy', 'owner', { toScope: 'project:p1' });
    expect(res.status).toBe(200);
    expect(res.json!.skill.scope).toBe('project:p1');
    expect(res.json!.skill.providers).toEqual({ claude: 'ok', codex: 'ok', grok: 'ok' });
    // Extra file arrived.
    expect(fs.readFileSync(path.join(pReal(), 'copyme', 'references', 'notes.md'), 'utf8')).toBe('ref notes');
    expect(fs.readFileSync(path.join(pReal(), 'copyme', 'SKILL.md'), 'utf8')).toContain('the body');
    // Source stays.
    expect(fs.existsSync(path.join(gReal(), 'copyme'))).toBe(true);
    expect(fs.realpathSync(path.join(gLink(), 'copyme'))).toBe(fs.realpathSync(path.join(gReal(), 'copyme')));
  });

  it('409s a copy on a destination-name collision', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'clashy', description: 'g', body: '' });
    await call('POST', '/api/skills/project:p1', 'owner', { name: 'clashy', description: 'p', body: '' });
    const res = await call('POST', '/api/skills/global/clashy/copy', 'owner', { toScope: 'project:p1' });
    expect(res.status).toBe(409);
  });

  it('identifies an external global link and the project original it uses', async () => {
    const original = path.join(pLink(), 'linked-skill');
    fs.mkdirSync(original, { recursive: true });
    fs.writeFileSync(path.join(original, 'SKILL.md'), '---\nname: linked-skill\ndescription: Linked skill\n---\n\nBody.\n');
    fs.mkdirSync(gReal(), { recursive: true });
    fs.mkdirSync(gLink(), { recursive: true });
    fs.symlinkSync(original, path.join(gReal(), 'linked-skill'));
    fs.symlinkSync(path.join(gReal(), 'linked-skill'), path.join(gLink(), 'linked-skill'));

    const res = await call('GET', '/api/skills', 'owner');
    const global = (res.json!.scopes as any[])
      .find((group) => group.scope === 'global')
      .skills.find((skill: any) => skill.name === 'linked-skill');
    const project = (res.json!.scopes as any[])
      .find((group) => group.scope === 'project:p1')
      .skills.find((skill: any) => skill.name === 'linked-skill');

    expect(global.entryKind).toBe('link');
    expect(global.source).toEqual({ scope: 'project:p1', name: 'linked-skill' });
    expect(project.entryKind).toBe('original');
    expect(project.dependents).toEqual([{ scope: 'global', name: 'linked-skill' }]);
  });

  it('removes an external global link without deleting its project original', async () => {
    const original = path.join(pLink(), 'linked-skill');
    fs.mkdirSync(original, { recursive: true });
    fs.writeFileSync(path.join(original, 'SKILL.md'), '---\nname: linked-skill\ndescription: Linked skill\n---\n');
    fs.mkdirSync(gReal(), { recursive: true });
    fs.mkdirSync(gLink(), { recursive: true });
    fs.symlinkSync(original, path.join(gReal(), 'linked-skill'));
    fs.symlinkSync(path.join(gReal(), 'linked-skill'), path.join(gLink(), 'linked-skill'));

    const res = await call('DELETE', '/api/skills/global/linked-skill', 'owner');
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(original, 'SKILL.md'))).toBe(true);
    expect(fs.lstatSync(path.join(gReal(), 'linked-skill'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync(path.join(gLink(), 'linked-skill'), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('protects an original while another scope links to it', async () => {
    const original = path.join(pLink(), 'linked-skill');
    fs.mkdirSync(original, { recursive: true });
    fs.writeFileSync(path.join(original, 'SKILL.md'), '---\nname: linked-skill\ndescription: Linked skill\n---\n');
    fs.mkdirSync(gReal(), { recursive: true });
    fs.mkdirSync(gLink(), { recursive: true });
    fs.symlinkSync(original, path.join(gReal(), 'linked-skill'));
    fs.symlinkSync(path.join(gReal(), 'linked-skill'), path.join(gLink(), 'linked-skill'));

    const res = await call('DELETE', '/api/skills/project:p1/linked-skill', 'owner');
    expect(res.status).toBe(409);
    expect(res.json!.code).toBe('linked-dependents');
    expect(res.json!.dependents).toEqual([{ scope: 'global', name: 'linked-skill' }]);
    expect(fs.existsSync(path.join(original, 'SKILL.md'))).toBe(true);
  });

  it('turns a link into an independent copy so the old original can be removed', async () => {
    const original = path.join(pLink(), 'linked-skill');
    fs.mkdirSync(path.join(original, 'references'), { recursive: true });
    fs.writeFileSync(path.join(original, 'SKILL.md'), '---\nname: linked-skill\ndescription: Linked skill\n---\n\nBody.\n');
    fs.writeFileSync(path.join(original, 'references', 'notes.md'), 'keep me');
    fs.mkdirSync(gReal(), { recursive: true });
    fs.mkdirSync(gLink(), { recursive: true });
    fs.symlinkSync(original, path.join(gReal(), 'linked-skill'));
    fs.symlinkSync(path.join(gReal(), 'linked-skill'), path.join(gLink(), 'linked-skill'));

    const copy = await call('POST', '/api/skills/project:p1/linked-skill/copy', 'owner', { toScope: 'global' });
    expect(copy.status).toBe(200);
    expect(copy.json!.skill.entryKind).toBe('original');
    expect(fs.lstatSync(path.join(gReal(), 'linked-skill')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(gReal(), 'linked-skill', 'references', 'notes.md'), 'utf8')).toBe('keep me');

    const remove = await call('DELETE', '/api/skills/project:p1/linked-skill', 'owner');
    expect(remove.status).toBe(200);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(path.join(gReal(), 'linked-skill', 'SKILL.md'), 'utf8')).toContain('Body.');
    expect(fs.realpathSync(path.join(gLink(), 'linked-skill'))).toBe(fs.realpathSync(path.join(gReal(), 'linked-skill')));
  });

  it('removes a broken external link without following its missing target', async () => {
    fs.mkdirSync(gReal(), { recursive: true });
    fs.mkdirSync(gLink(), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'missing-skill'), path.join(gReal(), 'broken-skill'));
    fs.symlinkSync(path.join(gReal(), 'broken-skill'), path.join(gLink(), 'broken-skill'));

    const detail = await call('GET', '/api/skills/global/broken-skill', 'owner');
    expect(detail.json!.skill.entryKind).toBe('link');
    expect(detail.json!.skill.source).toBeNull();
    const remove = await call('DELETE', '/api/skills/global/broken-skill', 'owner');
    expect(remove.status).toBe(200);
    expect(fs.lstatSync(path.join(gReal(), 'broken-skill'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync(path.join(gLink(), 'broken-skill'), { throwIfNoEntry: false })).toBeUndefined();
  });

  // ── move/copy route guards (spec v2 §2/§5) ────────────────────────────────
  it('denies members move and copy (403)', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'guarded', description: 'g', body: '' });
    expect((await call('POST', '/api/skills/global/guarded/move', 'member', { toScope: 'project:p1' })).status).toBe(403);
    expect((await call('POST', '/api/skills/global/guarded/copy', 'member', { toScope: 'project:p1' })).status).toBe(403);
  });

  it('400s move/copy when toScope equals the source scope', async () => {
    await call('POST', '/api/skills/global', 'owner', { name: 'samescope', description: 'g', body: '' });
    expect((await call('POST', '/api/skills/global/samescope/move', 'owner', { toScope: 'global' })).status).toBe(400);
    expect((await call('POST', '/api/skills/global/samescope/copy', 'owner', { toScope: 'global' })).status).toBe(400);
  });
});
