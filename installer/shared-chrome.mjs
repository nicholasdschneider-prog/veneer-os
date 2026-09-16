#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sharedChromeArgs({
  serviceHome,
  config,
  port = 9223,
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid shared Chrome CDP port: ${port}`);
  }
  const configuredArgs =
    typeof config.args === 'string'
      ? config.args.split(/[\n,]/).map((value) => value.trim()).filter(Boolean)
      : [];
  return [
    ...configuredArgs,
    '--headless=new',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${path.join(serviceHome, '.veneer-chrome')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    'about:blank',
  ];
}

export function readSharedChromeConfig({
  serviceHome,
  fsImpl = fs,
}) {
  const configPath = path.join(serviceHome, '.agent-browser', 'config.json');
  let config;
  try {
    config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`Trusted Agent Browser config is missing or invalid at ${configPath}.`);
  }
  if (
    typeof config.executablePath !== 'string'
    || !config.executablePath
    || !fsImpl.existsSync(config.executablePath)
    || !(fsImpl.statSync(config.executablePath).mode & 0o111)
  ) {
    throw new Error(`Trusted Agent Browser config has no executable Chrome at ${configPath}.`);
  }
  return config;
}

export function startSharedChrome({
  serviceHome = os.homedir(),
  port = Number(process.env.VP_DESKTOP_CDP_PORT || 9223),
  spawnImpl = spawn,
  fsImpl = fs,
} = {}) {
  const config = readSharedChromeConfig({ serviceHome, fsImpl });
  fsImpl.mkdirSync(path.join(serviceHome, '.veneer-chrome'), { recursive: true, mode: 0o700 });
  const child = spawnImpl(
    config.executablePath,
    sharedChromeArgs({ serviceHome, config, port }),
    {
      cwd: serviceHome,
      env: {
        HOME: serviceHome,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        LANG: process.env.LANG || 'C.UTF-8',
      },
      stdio: 'inherit',
    },
  );
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => child.kill(signal));
  }
  child.once('error', (error) => {
    console.error(`[shared-chrome] ${error.message}`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startSharedChrome();
}
