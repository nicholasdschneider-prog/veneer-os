import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_BROWSER_VERSION,
  LINUX_AGENT_BROWSER_ARGS,
  agentBrowserPaths,
  findManagedAgentBrowserChrome,
  inspectAgentBrowserInstallation,
  provisionAgentBrowser,
  provisionManagedAgentBrowser,
} from '../../installer/agent-browser.mjs';

describe('Agent Browser provisioning', () => {
  let serviceHome: string;
  let chromeBin: string;

  beforeEach(() => {
    serviceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-agent-browser-install-'));
    chromeBin = path.join(serviceHome, 'Google Chrome');
    fs.writeFileSync(chromeBin, 'chrome', { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(serviceHome, { recursive: true, force: true });
  });

  it('installs the pinned CLI and writes a trusted Chrome config', () => {
    const paths = agentBrowserPaths(serviceHome);
    const execFile = vi.fn((file: string, args: string[]) => {
      if (file === 'npm') {
        fs.mkdirSync(path.dirname(paths.binary), { recursive: true });
        fs.mkdirSync(path.dirname(paths.packageJson), { recursive: true });
        fs.writeFileSync(paths.binary, '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(paths.packageJson, JSON.stringify({ version: AGENT_BROWSER_VERSION }));
        return Buffer.from('');
      }
      expect(file).toBe(paths.binary);
      expect(args).toEqual(['--version']);
      return `agent-browser ${AGENT_BROWSER_VERSION}\n`;
    });

    provisionAgentBrowser({ serviceHome, chromeBin, execFile, log: vi.fn() });

    expect(execFile).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining([`agent-browser@${AGENT_BROWSER_VERSION}`]),
      expect.objectContaining({ timeout: 120_000 }),
    );
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8'))).toEqual({
      executablePath: chromeBin,
    });
    expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(inspectAgentBrowserInstallation({ serviceHome, expectedChrome: chromeBin }).problems).toEqual([]);
  });

  it('does not reinstall an already pinned CLI but repairs its config', () => {
    const paths = agentBrowserPaths(serviceHome);
    fs.mkdirSync(path.dirname(paths.binary), { recursive: true });
    fs.mkdirSync(path.dirname(paths.packageJson), { recursive: true });
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.binary, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(paths.packageJson, JSON.stringify({ version: AGENT_BROWSER_VERSION }));
    fs.writeFileSync(paths.config, JSON.stringify({ executablePath: '/stale/chrome' }));
    const execFile = vi.fn(() => `agent-browser ${AGENT_BROWSER_VERSION}\n`);

    provisionAgentBrowser({ serviceHome, chromeBin, execFile, log: vi.fn() });

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      paths.binary,
      ['--version'],
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8'))).toEqual({
      executablePath: chromeBin,
    });
  });

  it('reports every missing host dependency clearly', () => {
    const inspected = inspectAgentBrowserInstallation({ serviceHome });
    expect(inspected.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('binary missing'),
        expect.stringContaining('package metadata missing'),
        expect.stringContaining('trusted config missing'),
      ]),
    );
  });

  it('refuses to provision without a real Chrome executable', () => {
    expect(() =>
      provisionAgentBrowser({
        serviceHome,
        chromeBin: path.join(serviceHome, 'missing-chrome'),
        execFile: vi.fn(),
        log: vi.fn(),
      }),
    ).toThrow('Cannot provision Agent Browser: Chrome is missing or not executable');

    const nonExecutableChrome = path.join(serviceHome, 'non-executable-chrome');
    fs.writeFileSync(nonExecutableChrome, 'chrome', { mode: 0o600 });
    expect(() =>
      provisionAgentBrowser({
        serviceHome,
        chromeBin: nonExecutableChrome,
        execFile: vi.fn(),
        log: vi.fn(),
      }),
    ).toThrow('Cannot provision Agent Browser: Chrome is missing or not executable');
  });

  it('installs managed Chrome with Linux dependencies and trusted no-sandbox config', () => {
    const paths = agentBrowserPaths(serviceHome);
    const managedChrome = path.join(
      paths.browsers,
      'chrome-151.0.7922.47',
      'chrome-linux64',
      'chrome',
    );
    const execFile = vi.fn((file: string, args: string[]) => {
      if (file === '/usr/bin/npm') {
        fs.mkdirSync(path.dirname(paths.binary), { recursive: true });
        fs.mkdirSync(path.dirname(paths.packageJson), { recursive: true });
        fs.writeFileSync(paths.binary, '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(paths.packageJson, JSON.stringify({ version: AGENT_BROWSER_VERSION }));
        return Buffer.from('');
      }
      expect(file).toBe(paths.binary);
      if (args[0] === 'install') {
        fs.mkdirSync(path.dirname(managedChrome), { recursive: true });
        fs.writeFileSync(managedChrome, 'chrome', { mode: 0o755 });
        return Buffer.from('');
      }
      expect(args).toEqual(['--version']);
      return `agent-browser ${AGENT_BROWSER_VERSION}\n`;
    });

    provisionManagedAgentBrowser({
      serviceHome,
      installSystemDependencies: true,
      npmBin: '/usr/bin/npm',
      execFile,
      log: vi.fn(),
    });

    expect(execFile).toHaveBeenCalledWith(
      paths.binary,
      ['install', '--with-deps'],
      expect.objectContaining({ timeout: 10 * 60_000 }),
    );
    expect(findManagedAgentBrowserChrome({ serviceHome })).toBe(managedChrome);
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8'))).toEqual({
      executablePath: managedChrome,
      args: LINUX_AGENT_BROWSER_ARGS.join('\n'),
    });
    expect(fs.statSync(path.dirname(paths.config)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(
      inspectAgentBrowserInstallation({
        serviceHome,
        expectedChrome: managedChrome,
        expectedBrowserArgs: LINUX_AGENT_BROWSER_ARGS,
      }).problems,
    ).toEqual([]);
  });

  it('reuses an existing managed Chrome installation', () => {
    const paths = agentBrowserPaths(serviceHome);
    const managedChrome = path.join(paths.browsers, 'chrome-151.0.7922.47', 'chrome-linux64', 'chrome');
    fs.mkdirSync(path.dirname(paths.binary), { recursive: true });
    fs.mkdirSync(path.dirname(paths.packageJson), { recursive: true });
    fs.mkdirSync(path.dirname(managedChrome), { recursive: true });
    fs.writeFileSync(paths.binary, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(paths.packageJson, JSON.stringify({ version: AGENT_BROWSER_VERSION }));
    fs.writeFileSync(managedChrome, 'chrome', { mode: 0o755 });
    const execFile = vi.fn(() => `agent-browser ${AGENT_BROWSER_VERSION}\n`);

    provisionManagedAgentBrowser({
      serviceHome,
      installSystemDependencies: true,
      execFile,
      log: vi.fn(),
    });

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      paths.binary,
      ['--version'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });
});
