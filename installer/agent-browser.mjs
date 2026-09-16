import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_BROWSER_VERSION = '0.33.1';
export const LINUX_AGENT_BROWSER_ARGS = ['--no-sandbox'];

export function agentBrowserPaths(serviceHome) {
  const prefix = path.join(serviceHome, '.local');
  return {
    prefix,
    binary: path.join(prefix, 'bin', 'agent-browser'),
    packageJson: path.join(prefix, 'lib', 'node_modules', 'agent-browser', 'package.json'),
    config: path.join(serviceHome, '.agent-browser', 'config.json'),
    browsers: path.join(serviceHome, '.agent-browser', 'browsers'),
  };
}

function readJson(file, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isExecutable(file, fsImpl) {
  try {
    return Boolean(fsImpl.statSync(file).mode & 0o111);
  } catch {
    return false;
  }
}

export function inspectAgentBrowserInstallation({
  serviceHome,
  expectedChrome,
  expectedBrowserArgs,
  fsImpl = fs,
}) {
  const paths = agentBrowserPaths(serviceHome);
  const problems = [];
  const packageInfo = readJson(paths.packageJson, fsImpl);
  const config = readJson(paths.config, fsImpl);

  if (!fsImpl.existsSync(paths.binary)) {
    problems.push(`binary missing at ${paths.binary}`);
  } else if (!isExecutable(paths.binary, fsImpl)) {
    problems.push(`binary is not executable at ${paths.binary}`);
  }
  if (packageInfo?.version !== AGENT_BROWSER_VERSION) {
    problems.push(
      packageInfo?.version
        ? `installed version is ${packageInfo.version}; expected ${AGENT_BROWSER_VERSION}`
        : `package metadata missing at ${paths.packageJson}`,
    );
  }
  if (!config) {
    problems.push(`trusted config missing or invalid at ${paths.config}`);
  } else if (typeof config.executablePath !== 'string' || !config.executablePath) {
    problems.push(`trusted config has no executablePath at ${paths.config}`);
  } else {
    if (!fsImpl.existsSync(config.executablePath)) {
      problems.push(`configured Chrome missing at ${config.executablePath}`);
    } else if (!isExecutable(config.executablePath, fsImpl)) {
      problems.push(`configured Chrome is not executable at ${config.executablePath}`);
    }
    if (expectedChrome && config.executablePath !== expectedChrome) {
      problems.push(`trusted config points to ${config.executablePath}; expected ${expectedChrome}`);
    }
    if (expectedBrowserArgs && config.args !== expectedBrowserArgs.join('\n')) {
      problems.push(`trusted config has incorrect browser launch args at ${paths.config}`);
    }
  }

  return { paths, problems, config };
}

function ensureAgentBrowserCli({
  serviceHome,
  npmBin,
  execFile,
  fsImpl,
  log,
}) {
  const paths = agentBrowserPaths(serviceHome);
  const packageInfo = readJson(paths.packageJson, fsImpl);
  if (!fsImpl.existsSync(paths.binary) || packageInfo?.version !== AGENT_BROWSER_VERSION) {
    fsImpl.mkdirSync(paths.prefix, { recursive: true, mode: 0o700 });
    log(`[install] agent-browser ${AGENT_BROWSER_VERSION} -> ${paths.prefix}`);
    execFile(
      npmBin,
      [
        'install',
        '--global',
        '--prefix',
        paths.prefix,
        '--no-audit',
        '--no-fund',
        `agent-browser@${AGENT_BROWSER_VERSION}`,
      ],
      {
        stdio: 'inherit',
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: serviceHome,
          npm_config_cache: path.join(serviceHome, '.npm'),
        },
      },
    );
  }
  return paths;
}

export function findManagedAgentBrowserChrome({ serviceHome, fsImpl = fs }) {
  const { browsers } = agentBrowserPaths(serviceHome);
  let versions = [];
  try {
    versions = fsImpl
      .readdirSync(browsers, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chrome-'))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return null;
  }

  for (const version of versions) {
    const root = path.join(browsers, version);
    // Chrome for Testing keeps the archive's top-level folder on Linux, while
    // the macOS archive is flattened to the app bundle. Keep all supported
    // layouts explicit so a package update cannot select an unrelated binary.
    const candidates = [
      path.join(root, 'chrome-linux64', 'chrome'),
      path.join(root, 'chrome-linux', 'chrome'),
      path.join(root, 'chrome'),
      path.join(root, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    ];
    for (const candidate of candidates) {
      if (fsImpl.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function provisionAgentBrowser({
  serviceHome,
  chromeBin,
  browserArgs = [],
  npmBin = 'npm',
  execFile = execFileSync,
  fsImpl = fs,
  log = console.log,
}) {
  if (!chromeBin || !fsImpl.existsSync(chromeBin) || !isExecutable(chromeBin, fsImpl)) {
    throw new Error(
      `Cannot provision Agent Browser: Chrome is missing or not executable at ${chromeBin || '(not found)'}.`,
    );
  }

  const paths = ensureAgentBrowserCli({ serviceHome, npmBin, execFile, fsImpl, log });

  const configDir = path.dirname(paths.config);
  fsImpl.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fsImpl.chmodSync(configDir, 0o700);
  const tempConfig = `${paths.config}.${process.pid}.tmp`;
  const config = {
    executablePath: chromeBin,
    ...(browserArgs.length ? { args: browserArgs.join('\n') } : {}),
  };
  fsImpl.writeFileSync(tempConfig, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fsImpl.renameSync(tempConfig, paths.config);
  fsImpl.chmodSync(paths.config, 0o600);

  const inspected = inspectAgentBrowserInstallation({
    serviceHome,
    expectedChrome: chromeBin,
    expectedBrowserArgs: browserArgs.length ? browserArgs : undefined,
    fsImpl,
  });
  if (inspected.problems.length) {
    throw new Error(`Agent Browser provisioning failed: ${inspected.problems.join('; ')}`);
  }

  const version = execFile(paths.binary, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, HOME: serviceHome },
  }).trim();
  log(`[install] agent-browser ready (${version || AGENT_BROWSER_VERSION})`);
  return inspected.paths;
}

export function provisionManagedAgentBrowser({
  serviceHome,
  installSystemDependencies = false,
  npmBin = 'npm',
  execFile = execFileSync,
  fsImpl = fs,
  log = console.log,
}) {
  const browserArgs = installSystemDependencies ? LINUX_AGENT_BROWSER_ARGS : [];
  const paths = ensureAgentBrowserCli({ serviceHome, npmBin, execFile, fsImpl, log });
  let chromeBin = findManagedAgentBrowserChrome({ serviceHome, fsImpl });
  if (!chromeBin) {
    log('[install] managed Chrome for Agent Browser');
    execFile(paths.binary, ['install', ...(installSystemDependencies ? ['--with-deps'] : [])], {
      stdio: 'inherit',
      timeout: 10 * 60_000,
      env: { ...process.env, HOME: serviceHome },
    });
    chromeBin = findManagedAgentBrowserChrome({ serviceHome, fsImpl });
  }
  if (!chromeBin) {
    throw new Error(`Agent Browser installed no managed Chrome under ${paths.browsers}.`);
  }
  return provisionAgentBrowser({
    serviceHome,
    chromeBin,
    browserArgs,
    npmBin,
    execFile,
    fsImpl,
    log,
  });
}
