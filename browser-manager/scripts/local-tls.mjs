#!/usr/bin/env node
// Generates the loopback TLS material the manager serves on VENEER_BROWSER_TLS_PORT.
// The Pro server requires an https origin for CDP tickets and pins this
// certificate through VP_VENEER_BROWSER_LAN_CA, so a plain http listener is not
// an option even when both processes are on the same Mac.
//
// Usage: node browser-manager/scripts/local-tls.mjs [--force]
// Prints: cert=<path> and key=<path>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = process.env.HOME || os.homedir();
const dir = process.env.VENEER_BROWSER_TLS_DIR || path.join(home, '.config', 'veneer-browser', 'tls');
const cert = path.join(dir, 'cert.pem');
const key = path.join(dir, 'key.pem');
const force = process.argv.includes('--force');

if (force || !fs.existsSync(cert) || !fs.existsSync(key)) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-days', '3650',
    '-keyout', key,
    '-out', cert,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    // CA:FALSE on purpose. NODE_EXTRA_CA_CERTS (and curl --cacert) accept a
    // self-signed leaf as its own anchor, so the listener is still trusted, but
    // the key cannot mint a certificate for any other name: a chain signed by it
    // is rejected with INVALID_PURPOSE. A CA:TRUE version of this file would be
    // a process-wide trust anchor for the whole internet.
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth',
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'openssl failed\n');
    process.exit(1);
  }
  fs.chmodSync(key, 0o600);
  fs.chmodSync(cert, 0o644);
}

process.stdout.write(`cert=${cert}\nkey=${key}\n`);
