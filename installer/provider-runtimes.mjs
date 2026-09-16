#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROVIDER_RUNTIME_POLICY_FILE = path.resolve(here, '..', 'provider-runtimes.json');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const VERSION_IN_OUTPUT = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const PROVIDERS = ['claude', 'codex', 'grok'];

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

export function loadProviderRuntimePolicy(file = PROVIDER_RUNTIME_POLICY_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const claudeVersion = requiredString(raw?.claude?.version, 'claude.version');
  const codexVersion = requiredString(raw?.codex?.version, 'codex.version');
  const grokVersion = requiredString(raw?.grok?.version, 'grok.version');
  for (const [provider, version] of [
    ['claude', claudeVersion],
    ['codex', codexVersion],
    ['grok', grokVersion],
  ]) {
    if (!SEMVER.test(version)) throw new Error(`${provider}.version must be an exact semantic version.`);
  }
  const claudeInstallerUrl = requiredString(raw?.claude?.installerUrl, 'claude.installerUrl');
  const codexPackage = requiredString(raw?.codex?.package, 'codex.package');
  if (claudeInstallerUrl !== 'https://claude.ai/install.sh') {
    throw new Error('claude.installerUrl must be the official Anthropic installer.');
  }
  if (codexPackage !== '@openai/codex') throw new Error('codex.package must be the official package.');
  const grokInstallerUrl = requiredString(raw?.grok?.installerUrl, 'grok.installerUrl');
  if (grokInstallerUrl !== 'https://x.ai/cli/install.sh') {
    throw new Error('grok.installerUrl must be the official xAI installer.');
  }
  return {
    claude: { installerUrl: claudeInstallerUrl, version: claudeVersion },
    codex: { package: codexPackage, version: codexVersion },
    grok: { installerUrl: grokInstallerUrl, version: grokVersion },
  };
}

export function providerRuntimePaths(serviceHome) {
  if (!path.isAbsolute(serviceHome)) throw new Error('The provider service home must be absolute.');
  const binDir = path.join(serviceHome, '.local', 'bin');
  return {
    binDir,
    claude: path.join(binDir, 'claude'),
    codex: path.join(binDir, 'codex'),
    grok: path.join(binDir, process.platform === 'win32' ? 'grok.exe' : 'grok'),
  };
}

export function providerRuntimeInstallPlan({ policy, serviceHome, npmBin = 'npm', provider = 'all' }) {
  if (provider !== 'all' && !PROVIDERS.includes(provider)) throw new Error(`Unknown provider ${provider}.`);
  const paths = providerRuntimePaths(serviceHome);
  const npmPackages = [];
  if (provider === 'all' || provider === 'codex') {
    npmPackages.push(`${policy.codex.package}@${policy.codex.version}`);
  }
  return {
    paths,
    claude: provider === 'all' || provider === 'claude' ? {
      installerUrl: policy.claude.installerUrl,
      version: policy.claude.version,
    } : null,
    npm: npmPackages.length ? {
      file: npmBin,
      args: ['install', '--global', '--prefix', path.join(serviceHome, '.local'), '--no-audit', '--no-fund', ...npmPackages],
    } : null,
    grok: provider === 'all' || provider === 'grok' ? {
      installerUrl: policy.grok.installerUrl,
      version: policy.grok.version,
      binDir: paths.binDir,
    } : null,
  };
}

function finalizeStagedBinary({ source, serviceHome, provider, version, names }) {
  const paths = providerRuntimePaths(serviceHome);
  const runtimeDirectory = path.join(serviceHome, '.local', 'lib', 'veneer-provider-runtimes');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const runtimeBinary = path.join(runtimeDirectory, `${provider}-${version}`);
  const pendingBinary = `${runtimeBinary}.pending-${process.pid}`;
  fs.copyFileSync(source, pendingBinary);
  fs.chmodSync(pendingBinary, 0o755);
  fs.renameSync(pendingBinary, runtimeBinary);
  for (const name of names) {
    const link = path.join(paths.binDir, name);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.relative(paths.binDir, runtimeBinary), link);
  }
}

export function parseProviderRuntimeVersion(output) {
  return VERSION_IN_OUTPUT.exec(String(output ?? ''))?.[1] ?? null;
}

export function verifyProviderRuntimeVersions({
  policy,
  serviceHome,
  provider = 'all',
  execFile = execFileSync,
}) {
  const paths = providerRuntimePaths(serviceHome);
  const expected = {
    claude: policy.claude.version,
    codex: policy.codex.version,
    grok: policy.grok.version,
  };
  const selected = provider === 'all' ? PROVIDERS : [provider];
  const verified = {};
  for (const name of selected) {
    let output;
    try {
      output = execFile(paths[name], ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0];
      throw new Error(`${name} version check failed${detail ? `: ${detail}` : '.'}`);
    }
    const actual = parseProviderRuntimeVersion(output);
    if (actual !== expected[name]) {
      throw new Error(`${name} version mismatch: expected ${expected[name]}, found ${actual ?? 'unparseable output'}.`);
    }
    verified[name] = actual;
  }
  return verified;
}

export function provisionProviderRuntimes({
  policy = loadProviderRuntimePolicy(),
  serviceHome,
  npmBin = 'npm',
  provider = 'all',
  execFile = execFileSync,
}) {
  const plan = providerRuntimeInstallPlan({ policy, serviceHome, npmBin, provider });
  fs.mkdirSync(plan.paths.binDir, { recursive: true });
  const childEnv = { ...process.env, HOME: serviceHome };
  if (plan.npm) {
    execFile(plan.npm.file, plan.npm.args, { cwd: serviceHome, env: childEnv, stdio: 'inherit' });
  }
  if (plan.claude) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-claude-installer-'));
    const installer = path.join(temporaryDirectory, 'install.sh');
    try {
      execFile('curl', ['-fsSL', plan.claude.installerUrl, '-o', installer], { env: childEnv, stdio: 'inherit' });
      execFile('bash', [installer, plan.claude.version], {
        // Stage native installation so Claude credentials, settings, shell
        // profile, and auto-updater state in the real service HOME are inert.
        env: {
          ...childEnv,
          HOME: temporaryDirectory,
          SHELL: '/bin/false',
          DISABLE_UPDATES: '',
          DISABLE_AUTOUPDATER: '1',
        },
        stdio: 'inherit',
      });
      finalizeStagedBinary({
        source: fs.realpathSync(path.join(temporaryDirectory, '.local', 'bin', 'claude')),
        serviceHome,
        provider: 'claude',
        version: plan.claude.version,
        names: ['claude'],
      });
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  if (plan.grok) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-grok-installer-'));
    const installer = path.join(temporaryDirectory, 'install.sh');
    try {
      execFile('curl', ['-fsSL', plan.grok.installerUrl, '-o', installer], { env: childEnv, stdio: 'inherit' });
      execFile('bash', [installer, plan.grok.version], {
        // Stage xAI's userland install in a temporary HOME. Their installer
        // otherwise rewrites Grok config and the user's shell profile even
        // when GROK_BIN_DIR is explicit. Only the verified binary enters Pro's
        // managed .local prefix; auth and provider settings remain untouched.
        env: {
          ...childEnv,
          HOME: temporaryDirectory,
          SHELL: '/bin/false',
          GROK_BIN_DIR: plan.grok.binDir,
          GROK_CHANNEL: 'stable',
          GROK_DEPLOYMENT_KEY: '',
        },
        stdio: 'inherit',
      });
      finalizeStagedBinary({
        source: fs.realpathSync(plan.paths.grok),
        serviceHome,
        provider: 'grok',
        version: plan.grok.version,
        names: ['grok', 'agent'],
      });
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return verifyProviderRuntimeVersions({ policy, serviceHome, provider, execFile });
}

function argument(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const serviceHome = path.resolve(argument(args, '--service-home', process.env.VP_SERVICE_HOME || os.homedir()));
  const npmBin = argument(args, '--npm-bin', 'npm');
  const provider = argument(args, '--provider', 'all');
  try {
    const policy = loadProviderRuntimePolicy();
    const versions = args.includes('--verify-only')
      ? verifyProviderRuntimeVersions({ policy, serviceHome, provider })
      : provisionProviderRuntimes({ policy, serviceHome, npmBin, provider });
    for (const [name, version] of Object.entries(versions)) {
      console.log(`[provider-runtimes] ${name} ${version}`);
    }
  } catch (error) {
    console.error(`[provider-runtimes] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
