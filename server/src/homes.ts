import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The two homes Veneer Pro deals with, and the one place that tells them apart.
 *
 *  - LOGIN home: the OS account's real home directory, read from the passwd
 *    database. This is where the machine's own credentials and command-line
 *    configuration live — .gitconfig, .ssh, gh's config, the platform keychain
 *    helpers, npm/nvm/fnm, every dotfile the human set up. A Full Access agent
 *    runs with this as HOME, so those tools behave exactly as they do when the
 *    user types the command themselves.
 *
 *  - SERVICE home: where Veneer Pro keeps its OWN runtime state. On macOS the
 *    installer points the services at ~/veneer-pro-home so Pro's provider
 *    profiles never mix with the login user's Claude Code / Codex sessions. On
 *    Linux the dedicated `veneer` account already provides that separation, so
 *    the two paths are the same and nothing here changes.
 *
 * The rule: an artificial HOME is NOT the isolation boundary. Pro-owned state is
 * pinned by explicit path — CLAUDE_CONFIG_DIR, CODEX_HOME, and the service-home
 * lookups below — so changing an agent's HOME can never move, hide, or lose a
 * provider login or a native session history.
 *
 * `VP_SERVICE_HOME` is carried into every agent child process for exactly that
 * reason: a grandchild (an MCP server the CLI spawns) may see HOME=loginHome,
 * and still has to find Pro's browser install, desktop activity state, and Doppler
 * profile.
 */

export interface Homes {
  /** The OS account's real home, from the passwd database. */
  loginHome: string;
  /** Where Veneer Pro keeps its own runtime state. */
  serviceHome: string;
}

/**
 * The login home from the passwd entry of the uid we run as — `getpwuid` on both
 * macOS and Linux (node reads it through libuv, not through $HOME). Deliberately
 * NOT os.homedir(), which returns $HOME when set and would hand back the
 * artificial service home the launchd plist injects.
 */
export function resolveLoginHome(): string {
  try {
    const home = os.userInfo().homedir;
    if (home && path.isAbsolute(home)) return home;
  } catch {
    // No passwd entry (some containers). Fall through to the env-based answer.
  }
  return os.homedir();
}

/**
 * Where Pro's own state lives. `VP_SERVICE_HOME` is authoritative when set (the
 * Linux env file and the launchd plists both set it); HOME is the fallback,
 * which is what the services ran on before this was explicit.
 */
export function resolveServiceHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.VP_SERVICE_HOME?.trim();
  if (explicit && path.isAbsolute(explicit)) return explicit;
  const home = env.HOME?.trim();
  if (home && path.isAbsolute(home)) return home;
  return os.homedir();
}

let cached: Homes | null = null;

/** Both homes, resolved once. Passwd lookups are syscalls; this runs per turn. */
export function currentHomes(env: NodeJS.ProcessEnv = process.env): Homes {
  if (!cached) cached = { loginHome: resolveLoginHome(), serviceHome: resolveServiceHome(env) };
  return cached;
}

/** Test seam: forget the cached lookup. */
export function resetHomesCache(): void {
  cached = null;
}

export function loginHome(): string {
  return currentHomes().loginHome;
}

export function serviceHome(): string {
  return currentHomes().serviceHome;
}

/** Pro's Claude Code profile: credentials, settings, and native session files. */
export function proClaudeConfigDir(homes: Homes = currentHomes()): string {
  return path.join(homes.serviceHome, '.claude');
}

/** Pro's Codex profile: auth.json, config.toml, and the sessions tree. */
export function proCodexHome(homes: Homes = currentHomes()): string {
  return path.join(homes.serviceHome, '.codex');
}

/**
 * Pro's Grok profile: auth.json, config.toml, and the sessions tree. Never
 * `$HOME/.grok` — that is the login account's own Grok CLI profile, and a Full
 * Access agent runs with the login account's HOME.
 */
export function proGrokHome(homes: Homes = currentHomes()): string {
  return path.join(homes.serviceHome, '.grok');
}

/** The HOME an agent's commands see. Full Access means the real machine account. */
export function agentHome(fullAccess: boolean, homes: Homes = currentHomes()): string {
  return fullAccess ? homes.loginHome : homes.serviceHome;
}

/**
 * User-scoped configuration overrides that would otherwise keep pointing back
 * into the service home after HOME moves — gh reads XDG_CONFIG_HOME, git reads
 * GIT_CONFIG_GLOBAL. Only dropped when they actually live under the service
 * home; an operator who points one somewhere else meant it.
 */
const USER_CONFIG_OVERRIDES = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'GH_CONFIG_DIR',
  'GIT_CONFIG_GLOBAL',
  'NPM_CONFIG_USERCONFIG',
] as const;

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The environment for one agent's commands.
 *
 * Full Access gets the login account's HOME, so git, gh, ssh and the keychain
 * helpers resolve the machine's real credentials. Safe agents keep the service
 * HOME, which is part of their isolation and is left exactly as it was.
 *
 * Both get Pro's provider directories pinned explicitly, which is what makes the
 * HOME switch safe: provider auth and native session history are addressed by
 * path, not by HOME. An explicitly-set value in the parent environment still
 * wins, so an operator can relocate either profile deliberately.
 */
export function buildAgentEnv(
  base: NodeJS.ProcessEnv,
  options: { fullAccess: boolean; homes?: Homes },
): NodeJS.ProcessEnv {
  const homes = options.homes ?? currentHomes();
  const env: NodeJS.ProcessEnv = { ...base };

  env.VP_SERVICE_HOME = homes.serviceHome;
  if (!env.CLAUDE_CONFIG_DIR?.trim()) env.CLAUDE_CONFIG_DIR = proClaudeConfigDir(homes);
  if (!env.CODEX_HOME?.trim()) env.CODEX_HOME = proCodexHome(homes);
  if (!env.GROK_HOME?.trim()) env.GROK_HOME = proGrokHome(homes);
  // The Grok CLI self-updates its own binary in the background otherwise, which
  // would swap the wire protocol out from under a live ACP session.
  env.GROK_DISABLE_AUTOUPDATER = '1';

  env.HOME = agentHome(options.fullAccess, homes);
  if (options.fullAccess && homes.loginHome !== homes.serviceHome) {
    for (const key of USER_CONFIG_OVERRIDES) {
      const value = env[key];
      if (value && path.isAbsolute(value) && isInside(homes.serviceHome, value)) delete env[key];
    }
  }
  return env;
}

/** buildAgentEnv over this process's environment. */
export function agentEnv(fullAccess: boolean): NodeJS.ProcessEnv {
  return buildAgentEnv(process.env, { fullAccess });
}

/**
 * Environment for a Pro-owned helper that must never see the login home —
 * provider device-auth, the token minter, the managed browser. Same pinning as a
 * safe agent, without implying an agent turn.
 */
export function proServiceEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildAgentEnv(base, { fullAccess: false });
}

/**
 * Claude Code keeps `.claude.json` beside its config directory, not inside it:
 * with no CLAUDE_CONFIG_DIR that is `$HOME/.claude.json`, and with one set it is
 * `$CLAUDE_CONFIG_DIR/.claude.json`. Existing installs ran without the variable,
 * so their file sits at the old location. Copy it forward once, on boot, so
 * pinning the config directory does not look like a fresh Claude profile.
 *
 * A copy, never a move: the original stays where it is, so a rollback to a build
 * without this pinning finds its state untouched. Idempotent — it never
 * overwrites a file the new location already has.
 */
export function migrateClaudeConfigFile(homes: Homes = currentHomes()): 'copied' | 'present' | 'absent' {
  const legacy = path.join(homes.serviceHome, '.claude.json');
  const configDir = proClaudeConfigDir(homes);
  const current = path.join(configDir, '.claude.json');
  if (fs.existsSync(current)) return 'present';
  if (!fs.existsSync(legacy)) return 'absent';
  fs.mkdirSync(configDir, { recursive: true });
  // copyFile with EXCL loses a race to a concurrently-booting sibling service
  // rather than clobbering what it just wrote.
  try {
    fs.copyFileSync(legacy, current, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return 'present';
  }
  return 'copied';
}

/**
 * Expand a leading `~` in a path an agent produced. Both homes belong to the
 * same OS account, and which one the agent meant depends on whether it ran with
 * Full Access, so prefer whichever actually holds the file.
 */
export function expandUserPath(input: string, homes: Homes = currentHomes()): string {
  if (input !== '~' && !input.startsWith('~/')) return input;
  const rest = input === '~' ? '' : input.slice(2);
  const candidates = homes.loginHome === homes.serviceHome
    ? [homes.loginHome]
    : [homes.loginHome, homes.serviceHome];
  for (const home of candidates) {
    const candidate = path.join(home, rest);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(candidates[0]!, rest);
}
