import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeActivity } from '../desktopActivity.js';
import { serviceHome } from '../homes.js';
import {
  parseTabList,
  urlsMatchExactly,
  type BrowserTab,
} from '../veneerBrowser/tabReuse.js';
import { createSerialQueue } from './serialQueue.js';
import { pinnedCdpAddress, closePinnedCdpBridge } from '../veneerBrowser/pinnedCdpBridge.js';

const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 4_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const EXTERNAL_BROWSER_WAIT_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Serializes commands against the one shared desktop Chrome (configured CDP port).
 *
 * INVARIANT: this server process is the sole spawner of agent-browser against
 * that Chrome, so an in-process queue is sufficient — and unlike the `flock(1)`
 * call it replaces, it exists on macOS. If anything else ever drives the same
 * Chrome (a runner process, a CLI, a second server), this queue stops being
 * sufficient: move the serialization into a single browser-broker process that
 * owns the Chrome. Never go back to an OS-level lock.
 */
const sharedBrowserQueue = createSerialQueue();
const veneerBrowserQueues = new Map<string, ReturnType<typeof createSerialQueue>>();
interface VeneerBrowserBrokerState {
  generation: string | null;
  /** Control address the daemon last ran a command on. A different address on
   * the next command makes the daemon re-dial the browser, which resets its
   * selected tab and expires every @ref — exactly like a daemon restart. */
  cdpUrl: string | null;
  tabs: BrowserTab[];
  activeUrl: string | null;
  refsExpired?: boolean;
}
const veneerBrowserStates = new Map<string, VeneerBrowserBrokerState>();

const BLOCKED_COMMANDS = new Set([
  'auth',
  'batch',
  'chat',
  'connect',
  'dashboard',
  'download',
  'install',
  'inspect',
  // 'pdf' is intentionally allowed: it prints the current page to a PDF, a
  // useful secondary path alongside the `veneer-pdf` CLI. Agents already have
  // host write access via Bash, so writing a PDF file is not a new capability.
  'profiles',
  'profiler',
  'record',
  'session',
  'skills',
  'state',
  'stream',
  'trace',
  'upgrade',
  'upload',
]);

const BLOCKED_OPTIONS = [
  '--action-policy',
  '--allow-file-access',
  '--args',
  '--auto-connect',
  '--cdp',
  '--config',
  '--download-path',
  '--executable-path',
  '--extension',
  '--headed',
  '--init-script',
  '--model',
  '--profile',
  '--provider',
  '--proxy',
  '--proxy-bypass',
  '--screenshot-dir',
  '--session',
  '--session-name',
  '--state',
];

export interface NormalizedBrowserCommand {
  args: string[];
  screenshotPath?: string;
}

export interface BrowserRunResult extends NormalizedBrowserCommand {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function browserSessionName(conversationId: string): string {
  const seed = conversationId || `process-${process.pid}`;
  return `vp-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

function hasBlockedOption(arg: string): boolean {
  return BLOCKED_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`));
}

function assertSafeArgs(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('args must be a non-empty array, for example ["open", "https://example.com"].');
  }
  if (input.length > MAX_ARGS) throw new Error(`At most ${MAX_ARGS} arguments are allowed.`);
  return input.map((value) => {
    if (typeof value !== 'string') throw new Error('Every browser argument must be a string.');
    if (!value || value.length > MAX_ARG_LENGTH || value.includes('\0')) {
      throw new Error('Browser arguments must be non-empty, contain no NUL bytes, and be at most 4000 characters.');
    }
    if (hasBlockedOption(value)) throw new Error(`The browser option ${value} is not available to agents.`);
    return value;
  });
}

/**
 * Constrains the general agent-browser CLI to page automation. The executable
 * is never user-controlled and commands run without a shell. Commands that can
 * read arbitrary host files, overwrite arbitrary paths, start servers, attach
 * to other Chrome instances, or mutate the host installation are denied.
 */
// Shared desktop commands come from unrelated chats and intentionally get
// throwaway daemons. A Veneer Browser working copy belongs to one chat, so its
// stable daemon is the command broker that preserves tabs and @refs. The caller
// supplies the working-copy id too, preventing a stopped copy's daemon from
// attaching commands to a replacement copy in the same conversation.
function sharedBrowserSession(now: number): string {
  return `vp-shared-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function veneerBrowserSessionName(conversationId: string, remoteSessionId?: string): string {
  const seed = `veneer:${conversationId}:${remoteSessionId || conversationId}`;
  return `vp-veneer-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

function veneerBrowserQueue(session: string): ReturnType<typeof createSerialQueue> {
  let queue = veneerBrowserQueues.get(session);
  if (!queue) {
    queue = createSerialQueue();
    veneerBrowserQueues.set(session, queue);
  }
  return queue;
}

function veneerBrowserDaemonGeneration(session: string): string | null {
  const pidFile = path.join(serviceHome(), '.agent-browser', `${session}.pid`);
  try {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    if (!/^\d+$/.test(pid)) return null;
    return `${pid}:${fs.statSync(pidFile).mtimeMs}`;
  } catch {
    return null;
  }
}

function currentTab(tabs: BrowserTab[]): BrowserTab | null {
  return tabs.find((tab) => tab.current) ?? null;
}

function exactTabMatches(tabs: BrowserTab[], url: string): BrowserTab[] {
  return tabs.filter((tab) => urlsMatchExactly(tab.url, url));
}

function tabHandle(args: string[]): { index: number; id: string } | null {
  if (args[0]?.toLowerCase() !== 'tab') return null;
  const index = args[1]?.toLowerCase() === 'close' ? 2 : 1;
  const id = args[index] ?? '';
  return /^t\d+$/i.test(id) ? { index, id: id.toLowerCase() } : null;
}

function hasElementReference(args: string[]): boolean {
  return args.some((arg) => /^@e\d+$/i.test(arg));
}

function brokerFailure(normalized: NormalizedBrowserCommand, message: string, privateValue?: string): BrowserRunResult {
  return {
    ...normalized,
    args: privateValue
      ? normalized.args.map((arg) => (arg === privateValue ? '[Veneer Browser control address removed]' : arg))
      : normalized.args,
    stdout: '',
    stderr: message,
    exitCode: 1,
  };
}

export function sharedDesktopCdpPort(value: unknown = process.env.VP_DESKTOP_CDP_PORT): string {
  const port = value === undefined || value === '' ? 9223 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid shared desktop CDP port: ${String(value)}`);
  }
  return String(port);
}

export function sharedDesktopUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Without a configured public origin the only address that certainly reaches
  // this install is its own loopback listener.
  const port = Number(env.PORT) || 3100;
  const fallback = `http://127.0.0.1:${port}`;
  const origin = env.VP_APPS_PUBLIC_ORIGIN?.trim() || fallback;
  try {
    return new URL('/desktop', origin).toString().replace(/\/$/, '');
  } catch {
    return `${fallback}/desktop`;
  }
}

export function normalizeAgentBrowserArgs(
  input: unknown,
  options: {
    conversationId: string;
    workspaceDir: string;
    now?: number;
    shared?: boolean;
    cdpPort?: number | string;
    remoteCdpUrl?: string;
    remoteSessionId?: string;
    trustedCdpOrigin?: string;
  },
): NormalizedBrowserCommand {
  if (options.shared && options.remoteCdpUrl) throw new Error('A browser command has more than one browser target.');
  const args = assertSafeArgs(input);
  const command = args[0]!.toLowerCase();
  if (BLOCKED_COMMANDS.has(command)) {
    throw new Error(`The agent-browser command "${command}" is not available through the scoped browser tool.`);
  }
  // The shared desktop browser belongs to the user (they watch it live), so an
  // agent may never close it — only detach.
  if (options.shared && command === 'close') {
    throw new Error('Closing the user\'s shared desktop browser is not allowed.');
  }
  if (options.remoteCdpUrl && command === 'close') {
    throw new Error('Use the Veneer Browser stop tool to close this browser safely.');
  }
  if (command === 'doctor' && args.some((arg) => arg === '--fix' || arg.startsWith('--fix='))) {
    throw new Error('doctor --fix is disabled because agents may not modify the host browser installation.');
  }
  if (command === 'close' && args.some((arg) => arg === '--all' || arg.startsWith('--all='))) {
    throw new Error('close --all is disabled because agents may only close their own isolated browser session.');
  }
  if (command === 'cookies' && args.some((arg) => arg === '--curl' || arg.startsWith('--curl='))) {
    throw new Error('cookies --curl is disabled because it can read arbitrary host files.');
  }
  if (command === 'network' && args[1]?.toLowerCase() === 'har') {
    throw new Error('network har is disabled because it can write arbitrary host paths.');
  }
  if (['open', 'goto', 'navigate'].includes(command)) {
    const target = args[1]?.trim() ?? '';
    if (/^file:/i.test(target) || path.isAbsolute(target)) {
      throw new Error('Opening local host files is not available to agents.');
    }
  }

  let screenshotPath: string | undefined;
  let commandArgs = args;
  if (command === 'screenshot') {
    const flags = args.slice(1);
    if (flags.some((arg) => arg !== '--full' && arg !== '--annotate')) {
      throw new Error('Screenshot paths are managed automatically; only --full and --annotate are accepted.');
    }
    const outputDir = path.join(path.resolve(options.workspaceDir), '.veneer-browser');
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    screenshotPath = path.join(outputDir, `screenshot-${options.now ?? Date.now()}.png`);
    commandArgs = ['screenshot', screenshotPath, ...flags];
  }

  // External browser addresses are platform-injected. --cdp stays in
  // BLOCKED_OPTIONS for agent-supplied args, so it can only reach the CLI here,
  // after validation and origin pinning.
  let remoteCdpUrl: string | undefined;
  if (options.remoteCdpUrl) {
    let target: URL;
    let trusted: URL;
    try {
      target = new URL(options.remoteCdpUrl);
      trusted = new URL(options.trustedCdpOrigin ?? '');
    } catch {
      throw new Error('The Veneer Browser control address is invalid.');
    }
    if (target.protocol !== 'wss:' || target.origin !== trusted.origin || !target.pathname.startsWith('/cdp/')) {
      throw new Error('The Veneer Browser control address is not trusted.');
    }
    remoteCdpUrl = target.toString();
  }
  const session = options.shared
    ? sharedBrowserSession(options.now ?? Date.now())
    : remoteCdpUrl
      ? veneerBrowserSessionName(options.conversationId, options.remoteSessionId)
    : browserSessionName(options.conversationId);
  const prefix = options.shared
    ? ['--session', session, '--cdp', sharedDesktopCdpPort(options.cdpPort), '--max-output', '100000']
    : remoteCdpUrl
      ? ['--session', session, '--cdp', remoteCdpUrl, '--max-output', '100000']
    : ['--session', session, '--max-output', '100000'];
  return {
    args: [...prefix, ...commandArgs],
    ...(screenshotPath ? { screenshotPath } : {}),
  };
}

function safeBrowserEnvironment(mode: 'local' | 'shared' | 'veneer'): NodeJS.ProcessEnv {
  // Never inherit service TLS overrides or credentials into the native CLI.
  const keep = ['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR'] as const;
  const env = Object.fromEntries(
    keep.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  ) as NodeJS.ProcessEnv;
  // The managed browser's profile is Pro's, not the login user's. This runs
  // inside an MCP child too, which for a Full Access agent inherits the login
  // HOME — so take the service home by path rather than from the environment.
  env.HOME = serviceHome();
  // Shared mode uses a throwaway session per command, so its daemon self-reaps.
  // Veneer mode is explicitly closed with the working copy; disabling its idle
  // timeout keeps tab and @ref state intact during a long agent turn.
  if (mode === 'shared') env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '15000';
  if (mode === 'veneer') env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '0';
  return env;
}

export function resolveAgentBrowserPaths(): { binary: string; config: string } {
  const home = serviceHome();
  return {
    binary: process.env.VP_AGENT_BROWSER_BIN || path.join(home, '.local', 'bin', 'agent-browser'),
    config: process.env.VP_AGENT_BROWSER_CONFIG || path.join(home, '.agent-browser', 'config.json'),
  };
}

export interface AgentBrowserRunOptions {
  conversationId: string;
  workspaceDir: string;
  timeoutMs?: number;
  shared?: boolean;
  remoteCdpUrl?: string;
  remoteSessionId?: string;
  trustedCdpOrigin?: string;
  cdpCaFile?: string;
  /**
   * Values that must never leave this process: every occurrence is replaced in
   * stdout, stderr, the echoed argv, and any error message. Applied in the
   * exported wrapper below so every return path — including the broker's own
   * restart failures, which echo the command's argv — is covered.
   */
  redact?: string[];
}

const REDACTED = '[redacted]';

async function runAgentBrowserRaw(
  input: unknown,
  options: AgentBrowserRunOptions,
): Promise<BrowserRunResult> {
  const requestedArgs = assertSafeArgs(input);
  let normalized = normalizeAgentBrowserArgs(requestedArgs, options);
  const { binary, config } = resolveAgentBrowserPaths();
  if (!fs.existsSync(binary)) {
    throw new Error(`agent-browser is not installed at ${binary}. Ask Platform Dev to install it on this host.`);
  }
  if (!fs.existsSync(config)) {
    throw new Error(`The trusted agent-browser config is missing at ${config}. Ask Platform Dev to repair the host installation.`);
  }
  // Shared desktop commands are serialized so two chats (or an agent racing
  // the human) never interleave commands on the one visible Chrome. The queue
  // does that serialization; the isolated per-chat path is untouched below.
  const requestedTimeout = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS;

  const execute = async (command: NormalizedBrowserCommand): Promise<BrowserRunResult> => {
    const cliArgs = [...command.args];
    const caFile = options.remoteCdpUrl ? options.cdpCaFile : undefined;
    if (caFile && options.remoteCdpUrl) {
      // Only replace the already validated, platform-injected --cdp value.
      // Agent-supplied WS addresses remain forbidden by normalization.
      const index = cliArgs.indexOf('--cdp');
      cliArgs[index + 1] = await pinnedCdpAddress(
        veneerBrowserSessionName(options.conversationId, options.remoteSessionId),
        options.remoteCdpUrl, caFile,
      );
    }
    const localAddress = cliArgs[cliArgs.indexOf('--cdp') + 1];
    const scrubLocalAddress = (value: string): string => caFile && localAddress
      ? value.split(localAddress).join('[browser control]') : value;
    return await new Promise<BrowserRunResult>((resolve, reject) => {
      const child = spawn(binary, ['--config', config, ...cliArgs], {
        cwd: path.resolve(options.workspaceDir),
        env: safeBrowserEnvironment(
          options.shared ? 'shared' : options.remoteCdpUrl ? 'veneer' : 'local',
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(() => reject(new Error('agent-browser output exceeded the 1 MiB safety limit. Narrow the snapshot or query.')));
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error) => finish(() => reject(error)));
      child.once('close', (code) =>
        finish(() => {
          // Heartbeat for the SPA's live-view auto-pop; never let it fail a command.
          if (options.shared && code === 0) {
            try {
              writeActivity(options.conversationId);
            } catch {
              /* activity is best-effort */
            }
          }
          const redact = (value: string): string =>
            options.remoteCdpUrl ? value.replaceAll(options.remoteCdpUrl, '[Veneer Browser control address removed]') : value;
          resolve({
            ...command,
            args: options.remoteCdpUrl
              ? command.args.map((arg) => (arg === options.remoteCdpUrl ? '[Veneer Browser control address removed]' : arg))
              : command.args,
            stdout: scrubLocalAddress(redact(stdout.trim())),
            stderr: scrubLocalAddress(redact(stderr.trim())),
            exitCode: code ?? 1,
          });
        }),
      );
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`agent-browser timed out after ${timeoutMs}ms.`)));
      }, timeoutMs);
      timer.unref();
    });
  };

  // Waiting longer than EXTERNAL_BROWSER_WAIT_TIMEOUT_MS for a turn fails the
  // command without running it, exactly as `flock -w 60` did.
  const queue = options.shared
    ? sharedBrowserQueue
    : options.remoteCdpUrl
      ? veneerBrowserQueue(veneerBrowserSessionName(options.conversationId, options.remoteSessionId))
      : null;
  if (!options.remoteCdpUrl) {
    return queue
      ? await queue.run(() => execute(normalized), { waitTimeoutMs: EXTERNAL_BROWSER_WAIT_TIMEOUT_MS })
      : await execute(normalized);
  }

  const session = veneerBrowserSessionName(options.conversationId, options.remoteSessionId);
  const listTabs = (): Promise<BrowserRunResult> => execute(normalizeAgentBrowserArgs(['tab', 'list'], options));
  const switchTab = (id: string): Promise<BrowserRunResult> => execute(normalizeAgentBrowserArgs(['tab', id], options));
  const isTabList = (args: string[]): boolean => (
    args[0]?.toLowerCase() === 'tab' && (!args[1] || args[1].toLowerCase() === 'list')
  );
  const isExplicitTabCommand = (args: string[]): boolean => (
    args[0]?.toLowerCase() === 'tab'
    && (args[1]?.toLowerCase() === 'new' || Boolean(tabHandle(args)))
  );

  return await queue!.run(async () => {
    const previous = veneerBrowserStates.get(session);
    const beforeGeneration = veneerBrowserDaemonGeneration(session);
    // The daemon hashes its control address into its launch identity, so a
    // rotated address makes this very command re-dial the browser inside the
    // still-running daemon. That loses the same state a daemon restart does,
    // so both take the same recovery path below.
    const restarted = Boolean(previous?.generation && previous.generation !== beforeGeneration)
      || Boolean(previous?.cdpUrl && options.remoteCdpUrl && previous.cdpUrl !== options.remoteCdpUrl);
    let effectiveArgs = [...requestedArgs];

    if (restarted && previous) {
      const listed = await listTabs();
      if (listed.exitCode !== 0) {
        return brokerFailure(normalized, listed.stderr || 'Veneer Browser could not restore its tab session.', options.remoteCdpUrl);
      }
      const freshTabs = parseTabList(listed.stdout);
      const handle = tabHandle(effectiveArgs);
      if (handle) {
        const oldTab = previous.tabs.find((tab) => tab.id === handle.id);
        const matches = oldTab ? exactTabMatches(freshTabs, oldTab.url) : [];
        if (matches.length !== 1) {
          return brokerFailure(normalized, 'The browser session restarted and that tab handle expired. List tabs again before switching or closing one.', options.remoteCdpUrl);
        }
        effectiveArgs[handle.index] = matches[0]!.id;
        normalized = normalizeAgentBrowserArgs(effectiveArgs, options);
      }

      let activeRestored = !previous.activeUrl;
      if (previous.activeUrl) {
        const matches = exactTabMatches(freshTabs, previous.activeUrl);
        if (matches.length === 1) {
          const restored = matches[0]!;
          const active = currentTab(freshTabs);
          if (active?.id !== restored.id) {
            const switched = await switchTab(restored.id);
            if (switched.exitCode !== 0) {
              return brokerFailure(normalized, switched.stderr || 'Veneer Browser could not restore its selected tab.', options.remoteCdpUrl);
            }
          }
          activeRestored = true;
        }
      }

      // @refs live inside the daemon. After a crash, replaying one could target
      // a different document even when the correct tab was recovered.
      if (hasElementReference(effectiveArgs)) {
        return brokerFailure(normalized, 'The browser automation session restarted, so page references expired. Read the page again before interacting.', options.remoteCdpUrl);
      }
      if (!activeRestored && !isTabList(effectiveArgs) && !isExplicitTabCommand(effectiveArgs)) {
        return brokerFailure(normalized, 'The browser automation session restarted and could not uniquely recover the selected tab. List tabs again before continuing.', options.remoteCdpUrl);
      }
    }

    if (previous?.refsExpired && hasElementReference(effectiveArgs)) {
      return brokerFailure(normalized, 'Page references expired after browser recovery. Take a fresh snapshot before interacting.', options.remoteCdpUrl);
    }
    const result = await execute(normalized);

    // Failed lookups can follow a redirect or reconnect too. Observe tabs even
    // when the requested command fails; never retry that command. Otherwise a
    // stale URL/generation causes the next read to enter recovery repeatedly.
    // Keep a private identity map outside the daemon. It is used only after a
    // crash to recover by URL and to remap stale tN aliases safely; it is never
    // persisted or returned beyond the normal tab-list output.
    const listed = isTabList(effectiveArgs) && result.exitCode === 0
      ? result : await listTabs().catch(() => null);
    if (listed?.exitCode === 0) {
      const tabs = parseTabList(listed.stdout);
      veneerBrowserStates.set(session, {
        generation: veneerBrowserDaemonGeneration(session),
        cdpUrl: options.remoteCdpUrl ?? null,
        tabs,
        activeUrl: currentTab(tabs)?.url ?? null,
        refsExpired: effectiveArgs[0]?.toLowerCase() === 'snapshot' && result.exitCode === 0
          ? false : restarted || previous?.refsExpired || false,
      });
    }
    return result;
  }, { waitTimeoutMs: EXTERNAL_BROWSER_WAIT_TIMEOUT_MS });
}

/**
 * The only entry point callers use. A command that carries a secret (a password
 * fill, a TOTP code) names it in `redact`, and nothing it touches can carry it
 * back out: not the CLI's own echo of the field it filled, not a stderr trace,
 * not a thrown timeout. Redaction is unconditional — a one-character value is
 * still replaced — because "too short to matter" is not a judgment this layer
 * gets to make.
 */
export async function runAgentBrowser(
  input: unknown,
  options: AgentBrowserRunOptions,
): Promise<BrowserRunResult> {
  const secrets = (options.redact ?? []).filter((value) => typeof value === 'string' && value.length > 0);
  if (!secrets.length) return runAgentBrowserRaw(input, options);
  const scrub = (text: string): string => secrets.reduce((acc, value) => acc.split(value).join(REDACTED), text);
  try {
    const result = await runAgentBrowserRaw(input, options);
    return {
      ...result,
      args: result.args.map(scrub),
      stdout: scrub(result.stdout),
      stderr: scrub(result.stderr),
    };
  } catch (error) {
    throw new Error(scrub((error as Error)?.message ?? 'The browser command failed.'));
  }
}

/** Stop only the stable agent-browser daemon; the manager owns remote Chrome. */
export async function closeVeneerBrowserSession(options: {
  conversationId: string;
  remoteSessionId?: string;
  workspaceDir: string;
  timeoutMs?: number;
}): Promise<void> {
  const session = veneerBrowserSessionName(options.conversationId, options.remoteSessionId);
  const queue = veneerBrowserQueue(session);
  const { binary, config } = resolveAgentBrowserPaths();
  if (!fs.existsSync(binary) || !fs.existsSync(config)) {
    closePinnedCdpBridge(session);
    veneerBrowserQueues.delete(session);
    veneerBrowserStates.delete(session);
    return;
  }
  const requestedTimeout = Number(options.timeoutMs ?? SESSION_CLOSE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(requestedTimeout)))
    : SESSION_CLOSE_TIMEOUT_MS;

  try {
    await queue.run(() => new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ['--config', config, '--session', session, 'close'], {
        cwd: path.resolve(options.workspaceDir),
        env: safeBrowserEnvironment('veneer'),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => finish(() => reject(error)));
      child.once('close', (code) => finish(() => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `agent-browser close exited ${code ?? 1}.`));
      }));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`agent-browser close timed out after ${timeoutMs}ms.`)));
      }, timeoutMs);
      timer.unref();
    }), { waitTimeoutMs: EXTERNAL_BROWSER_WAIT_TIMEOUT_MS });
  } finally {
    closePinnedCdpBridge(session);
    veneerBrowserQueues.delete(session);
    veneerBrowserStates.delete(session);
  }
}
