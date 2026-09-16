#!/usr/bin/env node
// Issues the bearer token the Pro server uses against the local browser manager
// and records only its sha256 hash in the client registry.
//
// Usage: node browser-manager/scripts/local-client.mjs [--client <id>]
// Prints exactly the two lines the installer appends to ~/.config/veneer-pro/browser.env:
//   VP_VENEER_BROWSER_CLIENT_ID=<id>
//   VP_VENEER_BROWSER_TOKEN=<token>
// The token is printed once and nowhere else; re-running rotates it, so the
// caller must replace both lines in the env file together.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.HOME || os.homedir();
const file = process.env.VENEER_BROWSER_CLIENTS_FILE || path.join(home, '.config', 'veneer-browser', 'clients.json');
const flag = process.argv.indexOf('--client');
const clientId = flag === -1 ? 'local' : String(process.argv[flag + 1] || '');
if (!/^[A-Za-z0-9_-]{1,200}$/.test(clientId)) {
  process.stderr.write('Invalid client id.\n');
  process.exit(1);
}

const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

let registry = { version: 1, clients: [] };
try {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed?.version === 1 && Array.isArray(parsed.clients)) registry = parsed;
} catch { /* A missing or unreadable registry is replaced with a fresh one. */ }
registry.clients = registry.clients.filter((entry) => entry?.id !== clientId);
registry.clients.push({ id: clientId, tokenHash });

fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, file);
fs.chmodSync(file, 0o600);

process.stdout.write(`VP_VENEER_BROWSER_CLIENT_ID=${clientId}\nVP_VENEER_BROWSER_TOKEN=${token}\n`);
