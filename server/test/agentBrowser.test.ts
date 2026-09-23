import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetHomesCache } from '../src/homes.js';
import {
  closeVeneerBrowserSession,
  normalizeAgentBrowserArgs,
  runAgentBrowser,
  sharedDesktopCdpPort,
  sharedDesktopUrl,
  veneerBrowserSessionName,
} from '../src/mcp/agentBrowser.js';

describe('scoped Agent Browser commands', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // Veneer Browser's pointer and dialog tools are built on these two verbs. If
  // either ever lands in the blocked commands or blocked options, click_at and
  // the dialog tool stop working, so pin them here rather than finding out live.
  it.each([
    ['mouse', ['mouse', 'move', '1', '2']],
    ['mouse', ['mouse', 'down', 'left']],
    ['mouse', ['mouse', 'up', 'middle']],
    ['mouse', ['mouse', 'wheel', '-400', '20']],
    ['dialog', ['dialog', 'status', '--json']],
    ['dialog', ['dialog', 'accept', 'Ada']],
    ['dialog', ['dialog', 'dismiss']],
  ])('passes %s commands through the scoped layer unchanged', (_verb, args) => {
    const normalized = normalizeAgentBrowserArgs(args, {
      conversationId: 'conversation-1',
      workspaceDir,
    });
    expect(normalized.args.slice(4)).toEqual(args);
    expect(normalized.screenshotPath).toBeUndefined();
  });

  it('adds a stable conversation-isolated session to ordinary commands', () => {
    const first = normalizeAgentBrowserArgs(['open', 'https://example.com'], {
      conversationId: 'conversation-1',
      workspaceDir,
    });
    const second = normalizeAgentBrowserArgs(['snapshot', '-i'], {
      conversationId: 'conversation-1',
      workspaceDir,
    });
    const other = normalizeAgentBrowserArgs(['snapshot', '-i'], {
      conversationId: 'conversation-2',
      workspaceDir,
    });

    expect(first.args.slice(0, 4)).toEqual(['--session', second.args[1], '--max-output', '100000']);
    expect(first.args.slice(4)).toEqual(['open', 'https://example.com']);
    expect(other.args[1]).not.toBe(first.args[1]);
  });

  it('manages screenshot output inside the agent workspace', () => {
    const normalized = normalizeAgentBrowserArgs(['screenshot', '--full'], {
      conversationId: 'conversation-1',
      workspaceDir,
      now: 123,
    });

    expect(normalized.screenshotPath).toBe(path.join(workspaceDir, '.veneer-browser', 'screenshot-123.png'));
    expect(normalized.args.slice(-3)).toEqual(['screenshot', normalized.screenshotPath, '--full']);
    expect(fs.statSync(path.dirname(normalized.screenshotPath!)).isDirectory()).toBe(true);
  });

  it.each([
    [['upload', '#file', '/etc/passwd'], 'not available'],
    [['open', 'file:///etc/passwd'], 'local host files'],
    [['open', 'https://example.com', '--profile', 'Default'], 'not available'],
    [['close', '--all'], 'only close their own'],
    [['doctor', '--fix'], 'may not modify'],
    [['cookies', 'set', '--curl=/etc/passwd'], 'arbitrary host files'],
    [['screenshot', '/tmp/overwrite.png'], 'managed automatically'],
  ])('rejects unsafe command %#', (args, message) => {
    expect(() =>
      normalizeAgentBrowserArgs(args, {
        conversationId: 'conversation-1',
        workspaceDir,
      }),
    ).toThrow(message);
  });

  it('allows the pdf command (print current page to PDF)', () => {
    const normalized = normalizeAgentBrowserArgs(['pdf', 'report.pdf'], {
      conversationId: 'conversation-1',
      workspaceDir,
    });
    expect(normalized.args.slice(-2)).toEqual(['pdf', 'report.pdf']);
  });

  it('uses a fresh vp-shared session and injects --cdp 9223 in shared mode', () => {
    const normalized = normalizeAgentBrowserArgs(['open', 'https://example.com'], {
      conversationId: 'conversation-1',
      workspaceDir,
      shared: true,
    });
    expect(normalized.args[0]).toBe('--session');
    // A per-command throwaway name (not a fixed one) so daemons never collide.
    expect(normalized.args[1]).toMatch(/^vp-shared-[0-9a-z]+-[0-9a-f]{8}$/);
    expect(normalized.args.slice(2, 6)).toEqual(['--cdp', '9223', '--max-output', '100000']);
    expect(normalized.args.slice(6)).toEqual(['open', 'https://example.com']);
  });

  it('uses the configured shared CDP port and instance URL', () => {
    const normalized = normalizeAgentBrowserArgs(['get', 'url'], {
      conversationId: 'conversation-1',
      workspaceDir,
      shared: true,
      cdpPort: 9333,
    });
    expect(normalized.args.slice(2, 4)).toEqual(['--cdp', '9333']);
    expect(sharedDesktopCdpPort('9444')).toBe('9444');
    expect(
      sharedDesktopUrl({ VP_APPS_PUBLIC_ORIGIN: 'https://example-veneer.example' }),
    ).toBe('https://example-veneer.example/desktop');
  });

  it('gives each shared invocation a distinct session name', () => {
    const opts = { conversationId: 'conversation-1', workspaceDir, shared: true };
    const a = normalizeAgentBrowserArgs(['get', 'url'], { ...opts, now: 1 });
    const b = normalizeAgentBrowserArgs(['get', 'url'], { ...opts, now: 2 });
    expect(a.args[1]).not.toBe(b.args[1]);
  });

  it('pins a Veneer Browser working copy to one stable, isolated session', () => {
    const first = normalizeAgentBrowserArgs(['tab', 'new', 'https://example.com'], {
      conversationId: 'conversation-1',
      workspaceDir,
      remoteCdpUrl: 'wss://browser.example.test/cdp/ticket-one/ws',
      remoteSessionId: 'copy-1',
      trustedCdpOrigin: 'wss://browser.example.test/cdp/ticket-one/ws',
      now: 1,
    });
    const nextTicket = normalizeAgentBrowserArgs(['screenshot'], {
      conversationId: 'conversation-1',
      workspaceDir,
      remoteCdpUrl: 'wss://browser.example.test/cdp/ticket-two/ws',
      remoteSessionId: 'copy-1',
      trustedCdpOrigin: 'wss://browser.example.test/cdp/ticket-two/ws',
      now: 2,
    });
    const replacementCopy = normalizeAgentBrowserArgs(['screenshot'], {
      conversationId: 'conversation-1',
      workspaceDir,
      remoteCdpUrl: 'wss://browser.example.test/cdp/ticket-three/ws',
      remoteSessionId: 'copy-2',
      trustedCdpOrigin: 'wss://browser.example.test/cdp/ticket-three/ws',
      now: 2,
    });
    const otherChat = normalizeAgentBrowserArgs(['screenshot'], {
      conversationId: 'conversation-2',
      workspaceDir,
      remoteCdpUrl: 'wss://browser.example.test/cdp/ticket-four/ws',
      remoteSessionId: 'copy-1',
      trustedCdpOrigin: 'wss://browser.example.test/cdp/ticket-four/ws',
      now: 2,
    });

    expect(first.args[1]).toBe(veneerBrowserSessionName('conversation-1', 'copy-1'));
    expect(nextTicket.args[1]).toBe(first.args[1]);
    expect(replacementCopy.args[1]).not.toBe(first.args[1]);
    expect(otherChat.args[1]).not.toBe(first.args[1]);
  });

  it('blocks close in shared mode', () => {
    expect(() =>
      normalizeAgentBrowserArgs(['close'], {
        conversationId: 'conversation-1',
        workspaceDir,
        shared: true,
      }),
    ).toThrow('shared desktop browser is not allowed');
  });

  it('still rejects an agent-supplied --cdp in shared mode', () => {
    expect(() =>
      normalizeAgentBrowserArgs(['open', 'https://example.com', '--cdp', '9223'], {
        conversationId: 'conversation-1',
        workspaceDir,
        shared: true,
      }),
    ).toThrow('not available to agents');
  });

  it('leaves non-shared normalization unchanged (no --cdp, hashed session)', () => {
    const normalized = normalizeAgentBrowserArgs(['open', 'https://example.com'], {
      conversationId: 'conversation-1',
      workspaceDir,
    });
    expect(normalized.args).not.toContain('--cdp');
    expect(normalized.args[1]).not.toMatch(/^vp-shared-/);
    expect(normalized.args.slice(0, 4)).toEqual(['--session', normalized.args[1], '--max-output', '100000']);
  });

  it('adapts a pinned WSS connection without leaking its local capability or TLS environment', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-home-'));
    const binary = path.join(tmpHome, 'agent-browser-stub');
    const config = path.join(tmpHome, 'agent-browser.json');
    const caFile = path.join(tmpHome, 'lan-ca.pem');
    const original = { binary: process.env.VP_AGENT_BROWSER_BIN, config: process.env.VP_AGENT_BROWSER_CONFIG };
    const remote = {
      conversationId: 'pinned-adapter', workspaceDir,
      remoteCdpUrl: 'wss://browser.lan.test:8443/cdp/fixture/ws',
      trustedCdpOrigin: 'wss://browser.lan.test:8443/cdp/fixture/ws',
    };
    try {
      fs.writeFileSync(binary, '#!/bin/sh\necho "ca=[$NODE_EXTRA_CA_CERTS] $*"\n', { mode: 0o700 });
      fs.writeFileSync(config, '{}');
      fs.writeFileSync(caFile, 'fixture certificate');
      process.env.VP_AGENT_BROWSER_BIN = binary;
      process.env.VP_AGENT_BROWSER_CONFIG = config;
      const pinned = await runAgentBrowser(['get', 'url'], { ...remote, cdpCaFile: caFile });
      expect(pinned.stdout).toContain('ca=[]');
      expect(pinned.stdout).toContain('--cdp [browser control]');
      expect(JSON.stringify(pinned)).not.toContain('127.0.0.1');
      expect(JSON.stringify(pinned)).not.toContain('/cdp/fixture');
      const plain = await runAgentBrowser(['get', 'url'], { ...remote, conversationId: 'unpinned-adapter' });
      expect(plain.stdout).toContain('--cdp [Veneer Browser control address removed]');
      expect(plain.stdout).toContain('ca=[]');
    } finally {
      await closeVeneerBrowserSession(remote);
      if (original.binary === undefined) delete process.env.VP_AGENT_BROWSER_BIN;
      else process.env.VP_AGENT_BROWSER_BIN = original.binary;
      if (original.config === undefined) delete process.env.VP_AGENT_BROWSER_CONFIG;
      else process.env.VP_AGENT_BROWSER_CONFIG = original.config;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('serializes one working copy through its stable daemon and closes that daemon explicitly', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-home-'));
    const binary = path.join(tmpHome, 'agent-browser-stub');
    const config = path.join(tmpHome, 'agent-browser.json');
    const log = path.join(tmpHome, 'commands.log');
    const originalServiceHome = process.env.VP_SERVICE_HOME;
    const originalBinary = process.env.VP_AGENT_BROWSER_BIN;
    const originalConfig = process.env.VP_AGENT_BROWSER_CONFIG;
    const script = [
      '#!/bin/sh',
      `printf 'start %s\\n' "$*" >> '${log}'`,
      'sleep 0.05',
      `printf 'end %s\\n' "$*" >> '${log}'`,
      'printf "idle=%s\\n" "$AGENT_BROWSER_IDLE_TIMEOUT_MS"',
    ].join('\n');

    try {
      fs.writeFileSync(binary, script, { mode: 0o700 });
      fs.chmodSync(binary, 0o700);
      fs.writeFileSync(config, '{}');
      process.env.VP_SERVICE_HOME = tmpHome;
      process.env.VP_AGENT_BROWSER_BIN = binary;
      process.env.VP_AGENT_BROWSER_CONFIG = config;
      resetHomesCache();

      const base = {
        conversationId: 'conversation-1',
        remoteSessionId: 'copy-1',
        workspaceDir,
      };
      const [first, second] = await Promise.all([
        runAgentBrowser(['get', 'url'], {
          ...base,
          remoteCdpUrl: 'wss://browser.example.test/cdp/ticket-one/ws',
          trustedCdpOrigin: 'wss://browser.example.test/cdp/ticket-one/ws',
        }),
        runAgentBrowser(['get', 'url'], {
          ...base,
          remoteCdpUrl: 'wss://browser.example.test/cdp/ticket-two/ws',
          trustedCdpOrigin: 'wss://browser.example.test/cdp/ticket-two/ws',
        }),
      ]);

      expect(first.args[1]).toBe(second.args[1]);
      expect(first.stdout).toBe('idle=0');
      expect(second.stdout).toBe('idle=0');
      // Five invocations, never interleaved: each command plus its tab-list
      // bookkeeping, and one extra recovery tab list because the second command
      // arrived on a rotated control address.
      expect(fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')[0]))
        .toEqual(['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end', 'start', 'end']);

      await closeVeneerBrowserSession(base);
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(lines.at(-2)).toContain(`--session ${veneerBrowserSessionName('conversation-1', 'copy-1')} close`);
      expect(lines.at(-2)).not.toContain('--cdp');
      expect(lines.at(-1)?.startsWith('end ')).toBe(true);
    } finally {
      if (originalServiceHome === undefined) delete process.env.VP_SERVICE_HOME;
      else process.env.VP_SERVICE_HOME = originalServiceHome;
      if (originalBinary === undefined) delete process.env.VP_AGENT_BROWSER_BIN;
      else process.env.VP_AGENT_BROWSER_BIN = originalBinary;
      if (originalConfig === undefined) delete process.env.VP_AGENT_BROWSER_CONFIG;
      else process.env.VP_AGENT_BROWSER_CONFIG = originalConfig;
      resetHomesCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('remaps tab handles after a daemon restart and expires stale page refs', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-home-'));
    const binary = path.join(tmpHome, 'agent-browser-stub');
    const config = path.join(tmpHome, 'agent-browser.json');
    const log = path.join(tmpHome, 'commands.log');
    const swapped = path.join(tmpHome, 'swapped');
    const originalServiceHome = process.env.VP_SERVICE_HOME;
    const originalBinary = process.env.VP_AGENT_BROWSER_BIN;
    const originalConfig = process.env.VP_AGENT_BROWSER_CONFIG;
    const script = [
      '#!/bin/sh',
      'all="$*"',
      'session=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--session" ]; then session="$2"; shift 2; continue; fi',
      '  shift',
      'done',
      `mkdir -p '${path.join(tmpHome, '.agent-browser')}'`,
      `if [ -f '${swapped}' ]; then generation=222; else generation=111; fi`,
      `printf '%s' "$generation" > '${path.join(tmpHome, '.agent-browser')}/'"$session"'.pid'`,
      `printf '%s\\n' "$all" >> '${log}'`,
      'case " $all " in',
      `  *" tab list "*) if [ -f '${swapped}' ]; then printf '→ [t1] Report - https://report.test/\\n  [t2] First - https://first.test/\\n'; else printf '  [t1] First - https://first.test/\\n→ [t2] Report - https://report.test/\\n'; fi ;;`,
      '  *" tab t1 "*) printf "✓ Report\\n  https://report.test/\\n" ;;',
      '  *" tab t2 "*) printf "✓ First\\n  https://first.test/\\n" ;;',
      '  *" close "*) exit 0 ;;',
      '  *) printf "ok\\n" ;;',
      'esac',
    ].join('\n');

    try {
      fs.writeFileSync(binary, script, { mode: 0o700 });
      fs.chmodSync(binary, 0o700);
      fs.writeFileSync(config, '{}');
      process.env.VP_SERVICE_HOME = tmpHome;
      process.env.VP_AGENT_BROWSER_BIN = binary;
      process.env.VP_AGENT_BROWSER_CONFIG = config;
      resetHomesCache();

      const options = {
        conversationId: 'conversation-restart',
        remoteSessionId: 'copy-restart',
        workspaceDir,
        remoteCdpUrl: 'wss://browser.example.test/cdp/ticket-one/ws',
        trustedCdpOrigin: 'wss://browser.example.test/cdp/ticket-one/ws',
      };
      await runAgentBrowser(['tab', 'list'], options);
      fs.writeFileSync(swapped, '1');
      const session = veneerBrowserSessionName(options.conversationId, options.remoteSessionId);
      const pidFile = path.join(tmpHome, '.agent-browser', `${session}.pid`);
      fs.writeFileSync(pidFile, '222');

      const switched = await runAgentBrowser(['tab', 't2'], options);
      expect(switched.exitCode).toBe(0);
      expect(fs.readFileSync(log, 'utf8')).toContain(`--session ${session} --cdp ${options.remoteCdpUrl} --max-output 100000 tab t1`);

      fs.writeFileSync(pidFile, '333');
      const stale = await runAgentBrowser(['click', '@e1'], options);
      expect(stale).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('references expired') });
      expect(stale.args).not.toContain(options.remoteCdpUrl);
      expect(fs.readFileSync(log, 'utf8')).not.toContain('click @e1');
      await closeVeneerBrowserSession(options);
    } finally {
      if (originalServiceHome === undefined) delete process.env.VP_SERVICE_HOME;
      else process.env.VP_SERVICE_HOME = originalServiceHome;
      if (originalBinary === undefined) delete process.env.VP_AGENT_BROWSER_BIN;
      else process.env.VP_AGENT_BROWSER_BIN = originalBinary;
      if (originalConfig === undefined) delete process.env.VP_AGENT_BROWSER_CONFIG;
      else process.env.VP_AGENT_BROWSER_CONFIG = originalConfig;
      resetHomesCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('restores the selected tab and expires page refs when the control address rotates', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-home-'));
    const binary = path.join(tmpHome, 'agent-browser-stub');
    const config = path.join(tmpHome, 'agent-browser.json');
    const log = path.join(tmpHome, 'commands.log');
    const originalServiceHome = process.env.VP_SERVICE_HOME;
    const originalBinary = process.env.VP_AGENT_BROWSER_BIN;
    const originalConfig = process.env.VP_AGENT_BROWSER_CONFIG;
    // The daemon never restarts here (constant pid): only the --cdp address
    // changes, which makes the real daemon re-dial the browser and reset its
    // selected tab to whatever the browser lists first. The stub plays that
    // reset: on the first address the Report tab is selected; on any later
    // address the ids are renumbered and the First tab is selected instead.
    const script = [
      '#!/bin/sh',
      'all="$*"',
      'session=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--session" ]; then session="$2"; shift 2; continue; fi',
      '  shift',
      'done',
      `mkdir -p '${path.join(tmpHome, '.agent-browser')}'`,
      `printf '111' > '${path.join(tmpHome, '.agent-browser')}/'"$session"'.pid'`,
      `printf '%s\\n' "$all" >> '${log}'`,
      'case " $all " in',
      '  *" tab list "*)',
      '    case " $all " in',
      `      *"ticket-one"*) printf '  [t1] First - https://first.test/\\n→ [t2] Report - https://report.test/\\n' ;;`,
      `      *) printf '→ [t1] First - https://first.test/\\n  [t2] Report - https://report.test/\\n' ;;`,
      '    esac ;;',
      '  *" tab t2 "*) printf "✓ Report\\n  https://report.test/\\n" ;;',
      '  *" close "*) exit 0 ;;',
      '  *) printf "ok\\n" ;;',
      'esac',
    ].join('\n');

    try {
      fs.writeFileSync(binary, script, { mode: 0o700 });
      fs.chmodSync(binary, 0o700);
      fs.writeFileSync(config, '{}');
      process.env.VP_SERVICE_HOME = tmpHome;
      process.env.VP_AGENT_BROWSER_BIN = binary;
      process.env.VP_AGENT_BROWSER_CONFIG = config;
      resetHomesCache();

      const base = {
        conversationId: 'conversation-rotate',
        remoteSessionId: 'copy-rotate',
        workspaceDir,
      };
      const ticket = (name: string) => ({
        ...base,
        remoteCdpUrl: `wss://browser.example.test/cdp/${name}/ws`,
        trustedCdpOrigin: `wss://browser.example.test/cdp/${name}/ws`,
      });
      await runAgentBrowser(['tab', 'list'], ticket('ticket-one'));

      // The rotated address resets the stub's selection to First, so the broker
      // must switch back to Report before the command runs.
      const rotated = await runAgentBrowser(['get', 'url'], ticket('ticket-two'));
      expect(rotated).toMatchObject({ exitCode: 0, stdout: 'ok' });
      const session = veneerBrowserSessionName(base.conversationId, base.remoteSessionId);
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      const ticketTwo = `--session ${session} --cdp wss://browser.example.test/cdp/ticket-two/ws --max-output 100000`;
      const switchIndex = lines.findIndex((line) => line.includes(`${ticketTwo} tab t2`));
      const commandIndex = lines.findIndex((line) => line.includes(`${ticketTwo} get url`));
      expect(switchIndex).toBeGreaterThan(-1);
      expect(commandIndex).toBeGreaterThan(-1);
      expect(switchIndex).toBeLessThan(commandIndex);

      // Another rotation also expires @refs: they lived in the dropped browser
      // connection, so replaying one could hit the wrong element.
      const stale = await runAgentBrowser(['click', '@e1'], ticket('ticket-three'));
      expect(stale).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('references expired') });
      expect(fs.readFileSync(log, 'utf8')).not.toContain('click @e1');
      await closeVeneerBrowserSession(base);
    } finally {
      if (originalServiceHome === undefined) delete process.env.VP_SERVICE_HOME;
      else process.env.VP_SERVICE_HOME = originalServiceHome;
      if (originalBinary === undefined) delete process.env.VP_AGENT_BROWSER_BIN;
      else process.env.VP_AGENT_BROWSER_BIN = originalBinary;
      if (originalConfig === undefined) delete process.env.VP_AGENT_BROWSER_CONFIG;
      else process.env.VP_AGENT_BROWSER_CONFIG = originalConfig;
      resetHomesCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.each(['duplicate', 'closed'])('refreshes failed lookups, rejects %s recovery, and never retries a mutation', async (mode) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-recovery-'));
    const binary = path.join(tmpHome, 'stub');
    const config = path.join(tmpHome, 'config.json');
    const log = path.join(tmpHome, 'commands');
    const state = path.join(tmpHome, 'redirected');
    const conflict = path.join(tmpHome, 'conflict');
    const saved = [process.env.VP_SERVICE_HOME, process.env.VP_AGENT_BROWSER_BIN, process.env.VP_AGENT_BROWSER_CONFIG];
    fs.writeFileSync(binary, [
      '#!/bin/sh',
      'all="$*"; session=""',
      'while [ "$#" -gt 0 ]; do if [ "$1" = "--session" ]; then session="$2"; shift 2; else shift; fi; done',
      `mkdir -p '${tmpHome}/.agent-browser'`,
      // Rewriting the generation models a reconnect observed during the failed command.
      `printf 111 > '${tmpHome}/.agent-browser/'"$session"'.pid'`,
      `printf '%s\\n' "$all" >> '${log}'`,
      'case " $all " in',
      ` *" tab list "*) if [ -f '${conflict}' ]; then if [ '${mode}' = duplicate ]; then printf '→ [t1] Login - https://login.test/redirected\\n  [t7] Login - https://login.test/redirected\\n'; else printf '→ [t1] Blank - about:blank\\n'; fi; exit 0; fi ;;`,
      'esac',
      'case " $all " in',
      ` *" find label Password "*) touch '${state}'; printf 'No element'; exit 1 ;;`,
      ` *" tab list "*) if [ -f '${state}' ]; then printf '  [t1] Blank - about:blank\\n→ [t7] Login - https://login.test/redirected\\n'; else printf '  [t1] Blank - about:blank\\n→ [t7] Login - https://login.test/start\\n'; fi ;;`,
      ' *) printf ok ;;',
      'esac',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(config, '{}');
    try {
      process.env.VP_SERVICE_HOME = tmpHome;
      process.env.VP_AGENT_BROWSER_BIN = binary;
      process.env.VP_AGENT_BROWSER_CONFIG = config;
      resetHomesCache();
      const options = { conversationId: 'failed-lookup', remoteSessionId: 'copy', workspaceDir,
        remoteCdpUrl: 'wss://browser.example.test/cdp/one/ws', trustedCdpOrigin: 'wss://browser.example.test/cdp/one/ws' };
      await runAgentBrowser(['tab', 'list'], options);
      await runAgentBrowser(['tab', 't7'], options);
      expect((await runAgentBrowser(['find', 'label', 'Password'], options)).exitCode).toBe(1);
      expect((await runAgentBrowser(['find', 'role', 'heading'], options)).exitCode).toBe(0);
      expect(fs.readFileSync(log, 'utf8').match(/find label Password/g)).toHaveLength(1);
      const rotated = { ...options, remoteCdpUrl: 'wss://browser.example.test/cdp/two/ws', trustedCdpOrigin: 'wss://browser.example.test/cdp/two/ws' };
      expect((await runAgentBrowser(['find', 'label', 'Password'], rotated)).exitCode).toBe(1);
      // A failed recovered read updates identity but cannot revive references.
      expect((await runAgentBrowser(['click', '@e1'], rotated)).exitCode).toBe(1);
      expect(fs.readFileSync(log, 'utf8')).not.toContain('click @e1');
      expect(await runAgentBrowser(['snapshot', '-i'], rotated)).toMatchObject({exitCode: 0, stderr: ''});
      expect((await runAgentBrowser(['click', '@e2'], rotated)).exitCode).toBe(0);
      fs.writeFileSync(conflict, '1');
      const third = { ...options, remoteCdpUrl: 'wss://browser.example.test/cdp/three/ws', trustedCdpOrigin: 'wss://browser.example.test/cdp/three/ws' };
      expect((await runAgentBrowser(['find', 'role', 'button', 'click'], third)).exitCode).toBe(1);
      expect(fs.readFileSync(log, 'utf8')).not.toContain('find role button click');
      expect((await runAgentBrowser(['tab', 'list'], third)).exitCode).toBe(0);
      if (mode === 'duplicate') {
        expect((await runAgentBrowser(['tab', 't7'], third)).exitCode).toBe(0);
        expect((await runAgentBrowser(['snapshot', '-i'], third)).exitCode).toBe(0);
      }

      await closeVeneerBrowserSession(options);
    } finally {
      for (const [index, key] of ['VP_SERVICE_HOME', 'VP_AGENT_BROWSER_BIN', 'VP_AGENT_BROWSER_CONFIG'].entries()) {
        if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
      }
      resetHomesCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('allows shared browser commands when a legacy pause marker exists', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-home-'));
    const binary = path.join(tmpHome, 'agent-browser-stub');
    const config = path.join(tmpHome, 'agent-browser.json');
    const originalHome = process.env.HOME;
    const originalServiceHome = process.env.VP_SERVICE_HOME;
    const originalBinary = process.env.VP_AGENT_BROWSER_BIN;
    const originalConfig = process.env.VP_AGENT_BROWSER_CONFIG;

    try {
      fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      fs.chmodSync(binary, 0o700);
      fs.writeFileSync(config, '{}');
      fs.mkdirSync(path.join(tmpHome, '.veneer-desktop'), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, '.veneer-desktop', 'agent-block.json'), '{}');

      process.env.HOME = tmpHome;
      process.env.VP_SERVICE_HOME = tmpHome;
      process.env.VP_AGENT_BROWSER_BIN = binary;
      process.env.VP_AGENT_BROWSER_CONFIG = config;
      resetHomesCache();

      const result = await runAgentBrowser(['get', 'url'], {
        conversationId: 'conversation-1',
        workspaceDir,
        shared: true,
      });

      expect(result.exitCode).toBe(0);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalServiceHome === undefined) delete process.env.VP_SERVICE_HOME;
      else process.env.VP_SERVICE_HOME = originalServiceHome;
      if (originalBinary === undefined) delete process.env.VP_AGENT_BROWSER_BIN;
      else process.env.VP_AGENT_BROWSER_BIN = originalBinary;
      if (originalConfig === undefined) delete process.env.VP_AGENT_BROWSER_CONFIG;
      else process.env.VP_AGENT_BROWSER_CONFIG = originalConfig;
      resetHomesCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
