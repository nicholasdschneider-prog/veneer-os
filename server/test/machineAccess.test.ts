import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentHome,
  buildAgentEnv,
  expandUserPath,
  migrateClaudeConfigFile,
  proClaudeConfigDir,
  proCodexHome,
  proGrokHome,
  resetHomesCache,
  resolveLoginHome,
  resolveServiceHome,
  type Homes,
} from '../src/homes.js';
import { createClaudeAdapter } from '../src/providers/claude/adapter.js';
import { claudeSessionFilePath } from '../src/providers/claude/transcript.js';
import { createCodexAdapter } from '../src/providers/codexAppServer/adapter.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { TurnSpec } from '../src/providers/types.js';

/**
 * Full Access means the agent uses this machine the way its owner does: the
 * login account's HOME, and therefore the login account's git config, gh login,
 * SSH keys and keychain helpers. What makes that safe is that Pro's own state is
 * pinned by path, so moving HOME cannot move a provider login or a session
 * history. These tests hold both halves of that bargain in place, on the macOS
 * install shape (two different homes) and the Linux one (a dedicated account,
 * where the two homes are the same path and nothing changes).
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const FAKE_APP_SERVER = path.join(FIXTURES, 'fake-app-server.mjs');
const silent = { warn() {}, error() {} };
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** macOS: the installer gives the services a home of their own. */
const MAC: Homes = { loginHome: '/Users/owner', serviceHome: '/Users/owner/veneer-pro-home' };
/** Linux: the dedicated `veneer` account already separates the two. */
const LINUX: Homes = { loginHome: '/home/veneer', serviceHome: '/home/veneer' };

const dirs: string[] = [];
const savedProviderHomes = {
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  codexHome: process.env.CODEX_HOME,
  grokHome: process.env.GROK_HOME,
};

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.GROK_HOME;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.VP_SERVICE_HOME;
  if (savedProviderHomes.claudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedProviderHomes.claudeConfigDir;
  if (savedProviderHomes.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedProviderHomes.codexHome;
  if (savedProviderHomes.grokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedProviderHomes.grokHome;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetHomesCache();
});

/**
 * Make this process look like a real macOS install for one test: a service home
 * that is NOT the login home. Without it the assertions pass trivially on a dev
 * machine, where the two are the same path.
 */
function withSeparateServiceHome(): string {
  const dir = tmpDir('vp-service-home-');
  process.env.VP_SERVICE_HOME = dir;
  resetHomesCache();
  return dir;
}

describe('resolving the two homes', () => {
  const saved = { home: process.env.HOME, service: process.env.VP_SERVICE_HOME };

  afterEach(() => {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.service === undefined) delete process.env.VP_SERVICE_HOME;
    else process.env.VP_SERVICE_HOME = saved.service;
    resetHomesCache();
  });

  // The whole design rests on this: the launchd plist overrides HOME, so HOME
  // cannot be asked "where does this account really live?". The passwd entry
  // can, on macOS and Linux alike.
  it('reads the login home from the passwd entry, not from an overridden HOME', () => {
    const real = os.userInfo().homedir;
    process.env.HOME = path.join(os.tmpdir(), 'not-the-login-home');
    expect(resolveLoginHome()).toBe(real);
    expect(os.homedir()).not.toBe(real); // proves HOME really was overridden
  });

  it('prefers VP_SERVICE_HOME, and falls back to HOME as installs did before', () => {
    expect(resolveServiceHome({ VP_SERVICE_HOME: '/srv/pro', HOME: '/home/x' })).toBe('/srv/pro');
    expect(resolveServiceHome({ HOME: '/home/x' })).toBe('/home/x');
    // A relative or empty value is not a home; fall through rather than build
    // provider paths against a garbage prefix.
    expect(resolveServiceHome({ VP_SERVICE_HOME: 'relative', HOME: '/home/x' })).toBe('/home/x');
  });
});

describe('Full Access agent environment', () => {
  it('gives macOS Full Access commands the login home and its credential locations', () => {
    const env = buildAgentEnv({ PATH: '/usr/bin' }, { fullAccess: true, homes: MAC });

    expect(env.HOME).toBe('/Users/owner');
    // The locations every normal user-scoped tool derives from HOME.
    expect(path.join(env.HOME!, '.gitconfig')).toBe('/Users/owner/.gitconfig');
    expect(path.join(env.HOME!, '.ssh')).toBe('/Users/owner/.ssh');
    expect(path.join(env.HOME!, '.config', 'gh')).toBe('/Users/owner/.config/gh');
  });

  it('gives Linux Full Access commands the service account home, which is its login home', () => {
    const env = buildAgentEnv({ PATH: '/usr/bin' }, { fullAccess: true, homes: LINUX });

    expect(env.HOME).toBe('/home/veneer');
    expect(agentHome(true, LINUX)).toBe(agentHome(false, LINUX));
  });

  // gh reads XDG_CONFIG_HOME and git reads GIT_CONFIG_GLOBAL. If either still
  // pointed into the service home, the agent would get the login HOME and STILL
  // miss the login credentials — the exact half-working state this fixes.
  it('drops user-config overrides that would keep pointing back at the service home', () => {
    const env = buildAgentEnv(
      {
        XDG_CONFIG_HOME: '/Users/owner/veneer-pro-home/.config',
        GH_CONFIG_DIR: '/Users/owner/veneer-pro-home/.config/gh',
        GIT_CONFIG_GLOBAL: '/Users/owner/veneer-pro-home/.gitconfig',
        XDG_CACHE_HOME: '/var/cache/shared',
      },
      { fullAccess: true, homes: MAC },
    );

    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    // Outside the service home, an operator meant it. Left alone.
    expect(env.XDG_CACHE_HOME).toBe('/var/cache/shared');
  });

  it('carries VP_SERVICE_HOME so an MCP grandchild still finds Pro state', () => {
    const env = buildAgentEnv({}, { fullAccess: true, homes: MAC });
    expect(env.VP_SERVICE_HOME).toBe(MAC.serviceHome);
    // An MCP server the CLI spawns inherits this env and re-derives from it.
    expect(resolveServiceHome(env)).toBe(MAC.serviceHome);
  });

  it('spawns the Claude CLI with the login home and Full Access permissions', async () => {
    const service = withSeparateServiceHome();
    process.env.FAKE_CLAUDE_MODE = 'spawn-env';
    const adapter = createClaudeAdapter({ claudeBin: FAKE_CLAUDE, turnTimeoutMs: 10_000, log: silent });
    const summary = await runFakeClaude(adapter, true);

    expect(summary.home).toBe(resolveLoginHome());
    expect(summary.home).not.toBe(service);
    // …and the profile did not follow HOME.
    expect(summary.claudeConfigDir).toBe(path.join(service, '.claude'));
    expect(summary.codexHome).toBe(path.join(service, '.codex'));
    expect(summary.serviceHome).toBe(service);
    expect(summary.args).toContain('--dangerously-skip-permissions');
    expect(summary.args).not.toContain('--permission-prompt-tool');
  });

  it('uses an approved runtime credential in the Claude agent environment', async () => {
    process.env.FAKE_CLAUDE_MODE = 'spawn-env';
    const adapter = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 10_000,
      log: silent,
      buildEnv: (fullAccess) => ({
        ...buildAgentEnv(process.env, { fullAccess, homes: LINUX }),
        NM_SEARCH_API_TOKEN: 'test-only',
      }),
    });

    expect((await runFakeClaude(adapter, false)).nmSearchTokenPresent).toBe(true);
  });
});

describe('provider auth and session state stay in the Pro service directories', () => {
  it('addresses both provider profiles from the service home, whatever HOME is', () => {
    expect(proClaudeConfigDir(MAC)).toBe('/Users/owner/veneer-pro-home/.claude');
    expect(proCodexHome(MAC)).toBe('/Users/owner/veneer-pro-home/.codex');
    expect(proGrokHome(MAC)).toBe('/Users/owner/veneer-pro-home/.grok');
    // Full Access moves HOME to the login account; the profiles do not follow.
    const env = buildAgentEnv({}, { fullAccess: true, homes: MAC });
    expect(env.CLAUDE_CONFIG_DIR).toBe(proClaudeConfigDir(MAC));
    expect(env.CODEX_HOME).toBe(proCodexHome(MAC));
    expect(env.GROK_HOME).toBe(proGrokHome(MAC));
    expect(env.CLAUDE_CONFIG_DIR!.startsWith(env.HOME!)).toBe(true); // same account…
    expect(path.dirname(env.CLAUDE_CONFIG_DIR!)).not.toBe(env.HOME); // …different home
  });

  it('pins the same directories for a safe agent, so both modes share one profile', () => {
    const safe = buildAgentEnv({}, { fullAccess: false, homes: MAC });
    const full = buildAgentEnv({}, { fullAccess: true, homes: MAC });
    expect(safe.CLAUDE_CONFIG_DIR).toBe(full.CLAUDE_CONFIG_DIR);
    expect(safe.CODEX_HOME).toBe(full.CODEX_HOME);
    expect(safe.GROK_HOME).toBe(full.GROK_HOME);
  });

  it('lets an operator relocate a profile deliberately', () => {
    const env = buildAgentEnv({ CODEX_HOME: '/mnt/codex' }, { fullAccess: true, homes: MAC });
    expect(env.CODEX_HOME).toBe('/mnt/codex');
  });

  it('reads Claude native session files from the service profile', () => {
    process.env.VP_SERVICE_HOME = MAC.serviceHome;
    resetHomesCache();
    try {
      expect(claudeSessionFilePath('/work/repo', 'abc')).toBe(
        path.join(MAC.serviceHome, '.claude', 'projects', '-work-repo', 'abc.jsonl'),
      );
    } finally {
      delete process.env.VP_SERVICE_HOME;
      resetHomesCache();
    }
  });

  it('runs one Codex app-server per access level, since Codex owns the shell env', async () => {
    const dir = tmpDir('vp-codex-env-');
    process.env.REQUEST_LOG = path.join(dir, 'requests.jsonl');
    const asked: boolean[] = [];
    const adapter = createCodexAdapter({
      codexBin: FAKE_APP_SERVER,
      turnTimeoutMs: 10_000,
      transcriptsDir: dir,
      log: silent,
      buildEnv: (fullAccess) => {
        asked.push(fullAccess);
        return buildAgentEnv(process.env, { fullAccess, homes: MAC });
      },
    });

    for (const dangerous of [true, false, true]) {
      const handle = adapter.runTurn(codexSpec(dangerous), () => undefined);
      await delay(120);
      handle.kill();
      await handle.done;
    }
    delete process.env.REQUEST_LOG;

    // One process per access level, reused — not one per turn, and never one
    // shared process whose HOME would be wrong for half the agents.
    expect(asked).toEqual([true, false]);
  });
});

describe('safe agents keep their sandbox and approval behavior', () => {
  it('leaves a safe agent on the service home in both install shapes', () => {
    expect(buildAgentEnv({}, { fullAccess: false, homes: MAC }).HOME).toBe(MAC.serviceHome);
    expect(buildAgentEnv({}, { fullAccess: false, homes: LINUX }).HOME).toBe(LINUX.serviceHome);
  });

  it('keeps a safe agent out of the login account entirely', () => {
    const env = buildAgentEnv({}, { fullAccess: false, homes: MAC });
    expect(env.HOME).not.toBe(MAC.loginHome);
  });

  it('still asks Claude for permission, with the unchanged flags', async () => {
    const service = withSeparateServiceHome();
    process.env.FAKE_CLAUDE_MODE = 'spawn-env';
    const adapter = createClaudeAdapter({ claudeBin: FAKE_CLAUDE, turnTimeoutMs: 10_000, log: silent });
    const summary = await runFakeClaude(adapter, false);

    expect(summary.home).toBe(service);
    expect(summary.args).not.toContain('--dangerously-skip-permissions');
    expect(summary.args).toContain('--permission-prompt-tool');
    expect(summary.args[summary.args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    expect(summary.args).toContain('--permission-mode');
    expect(summary.args[summary.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });
});

describe('upgrading an existing installation', () => {
  // What an install that predates this change has on disk: HOME was the service
  // home and nothing was pinned, so Claude and Codex wrote to $HOME/.claude and
  // $HOME/.codex. Pinning must resolve to those very paths — that is what makes
  // the upgrade lossless rather than a fresh profile.
  it('pins exactly the directories an existing install already uses', () => {
    const home = tmpDir('vp-existing-install-');
    const homes: Homes = { loginHome: path.join(home, 'login'), serviceHome: home };
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"tokens":{}}');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });

    const env = buildAgentEnv({}, { fullAccess: true, homes });

    expect(env.CODEX_HOME).toBe(path.join(home, '.codex'));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude'));
    expect(env.GROK_HOME).toBe(path.join(home, '.grok'));
    expect(fs.existsSync(path.join(env.CODEX_HOME!, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR!, 'projects'))).toBe(true);
  });

  // Claude keeps .claude.json BESIDE the config dir, so setting
  // CLAUDE_CONFIG_DIR moves that one file's expected location. Carry it.
  it('carries .claude.json into the pinned config directory without removing the original', () => {
    const home = tmpDir('vp-claude-json-');
    const homes: Homes = { loginHome: path.join(home, 'login'), serviceHome: home };
    fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":{"/work":{}}}');

    expect(migrateClaudeConfigFile(homes)).toBe('copied');

    const carried = path.join(home, '.claude', '.claude.json');
    expect(JSON.parse(fs.readFileSync(carried, 'utf8'))).toEqual({ projects: { '/work': {} } });
    // The original stays put, so rolling back to a build without the pinning
    // finds its state untouched.
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(true);
  });

  it('never overwrites an already-migrated file, and repeats harmlessly', () => {
    const home = tmpDir('vp-claude-json-idem-');
    const homes: Homes = { loginHome: path.join(home, 'login'), serviceHome: home };
    fs.writeFileSync(path.join(home, '.claude.json'), '{"old":true}');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), '{"current":true}');

    expect(migrateClaudeConfigFile(homes)).toBe('present');
    expect(migrateClaudeConfigFile(homes)).toBe('present');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude', '.claude.json'), 'utf8'))).toEqual({ current: true });
  });

  it('does nothing on a fresh install', () => {
    const home = tmpDir('vp-claude-json-fresh-');
    expect(migrateClaudeConfigFile({ loginHome: home, serviceHome: home })).toBe('absent');
  });
});

describe('expanding ~ in what an agent wrote', () => {
  it('prefers the home that actually holds the file', () => {
    const root = tmpDir('vp-tilde-');
    const homes: Homes = { loginHome: path.join(root, 'login'), serviceHome: path.join(root, 'service') };
    fs.mkdirSync(homes.serviceHome, { recursive: true });
    fs.mkdirSync(homes.loginHome, { recursive: true });
    fs.writeFileSync(path.join(homes.serviceHome, 'report.csv'), 'a,b\n');

    expect(expandUserPath('~/report.csv', homes)).toBe(path.join(homes.serviceHome, 'report.csv'));
    // Nothing on disk: the login home is the better guess, because that is what
    // `~` means to a Full Access agent.
    expect(expandUserPath('~/missing.csv', homes)).toBe(path.join(homes.loginHome, 'missing.csv'));
    expect(expandUserPath('/absolute/path', homes)).toBe('/absolute/path');
  });
});

interface SpawnEnvSummary {
  home: string;
  claudeConfigDir: string;
  codexHome: string;
  serviceHome: string;
  nmSearchTokenPresent: boolean;
  args: string[];
}

async function runFakeClaude(
  adapter: ReturnType<typeof createClaudeAdapter>,
  dangerous: boolean,
): Promise<SpawnEnvSummary> {
  const events: ConversationEvent[] = [];
  const handle = adapter.runTurn(
    {
      cwd: FIXTURES,
      nativeSessionId: `env-${dangerous}`,
      firstTurn: true,
      prompt: 'hello',
      turnId: 'turn-1',
      dangerous,
    },
    (event) => events.push(event),
  );
  await handle.done;
  const text = events.find((event) => event.type === 'text_final');
  if (!text || text.type !== 'text_final') throw new Error('fake claude produced no summary');
  return JSON.parse(text.markdown) as SpawnEnvSummary;
}

function codexSpec(dangerous: boolean): TurnSpec {
  return {
    cwd: os.tmpdir(),
    nativeSessionId: `t-${dangerous}`,
    firstTurn: true,
    prompt: 'hi',
    turnId: `turn-${dangerous}`,
    dangerous,
  };
}
