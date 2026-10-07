import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { reloadLaunchdServices } from './launchd-reload.mjs';

export const WATCHDOG_LABEL = 'com.veneer.web-watchdog';
export function renderWatchdog({ node, codeDir, dataDir, port, logDir, serviceHome }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback web port');
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const template = fs.readFileSync(new URL('../deploy/launchd/com.veneer.web-watchdog.plist', import.meta.url), 'utf8');
  const values = { NODE: node, CODE_DIR: codeDir, DATA_DIR: dataDir, WEB_PORT: port, LOG_DIR: logDir, HOME: serviceHome, PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin` };
  return Object.entries(values).reduce((xml, [key, value]) => xml.replaceAll(`__${key}__`, escape(value)), template);
}
/** Targeted installation never reloads web, runner, browsers or terminals. */
export async function installWebWatchdog(args) {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('macOS and Node 24 required');
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = option('--data-dir'), port = Number(option('--port'));
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Explicit absolute --data-dir required');
  const chat = option('--watchdog-chat'), owner = Number(option('--watchdog-owner'));
  if (!chat || !Number.isSafeInteger(owner) || owner < 1) throw new Error('Exact --watchdog-chat and --watchdog-owner required');
  const load = createRequire(path.join(codeDir, 'server/package.json'));
  const Database = load('better-sqlite3');
  const { bindWebWatchdog, watchdogOwner } = await import(path.join(codeDir, 'server/dist/ops/webWatchdog.js'));
  const db = new Database(path.join(dataDir, 'veneer-pro.db'), { fileMustExist: true });
  db.pragma('busy_timeout=1000'); db.pragma('foreign_keys=ON');
  const logDir = path.join(os.homedir(), 'Library/Logs/veneer-pro');
  const target = path.join(os.homedir(), 'Library/LaunchAgents', `${WATCHDOG_LABEL}.plist`);
  try {
    if (!watchdogOwner(db, chat, owner)) throw new Error('Invalid repair-chat owner');
    const xml = renderWatchdog({ node: process.execPath, codeDir, dataDir, port, logDir, serviceHome: option('--home') || path.join(os.homedir(), 'veneer-pro-home') });
    if (args.includes('--dry-run')) { console.log(xml); return; }
    bindWebWatchdog(db, chat, owner);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(target, xml, { mode: 0o644 });
    const result = await reloadLaunchdServices({ uid: process.getuid(), services: [{ label: WATCHDOG_LABEL, plist: target }] });
    if (!result.ok) throw new Error('Watchdog installation failed; inspect installer result');
    console.log('[install] Independent web watchdog installed; existing bot services unchanged');
  } finally { db.close(); }
}
