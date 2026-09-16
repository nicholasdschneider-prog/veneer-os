import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseEnv } from './env.mjs';
import { browserManagerPaths, provisionLocalBrowserManager } from './browser-manager.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-browser-install-'));
  const serviceHome = path.join(root, 'home');
  const envFile = path.join(root, 'config', 'veneer-pro', 'env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, 'DATA_DIR=/data\n');
  return { root, serviceHome, envFile };
}

function fakeScripts(certFile) {
  const calls = [];
  const runScript = (script, args, home) => {
    calls.push({ script: path.basename(script), args, home });
    if (path.basename(script) === 'local-tls.mjs') {
      return `cert=${certFile}\nkey=${certFile.replace('cert.pem', 'key.pem')}\n`;
    }
    return 'VP_VENEER_BROWSER_CLIENT_ID=local\nVP_VENEER_BROWSER_TOKEN=s3cret-token\n';
  };
  return { calls, runScript };
}

test('writes the identity 0600 and the server wiring into the env file', () => {
  const { serviceHome, envFile } = fixture();
  const paths = browserManagerPaths(serviceHome, envFile);
  const { calls, runScript } = fakeScripts(paths.certFile);

  const result = provisionLocalBrowserManager({ codeDir: '/code', serviceHome, envFile, runScript });

  // Both scripts derive their paths from HOME, so they must see the service home.
  assert.deepEqual(calls.map((call) => [call.script, call.home]), [
    ['local-tls.mjs', serviceHome],
    ['local-client.mjs', serviceHome],
  ]);
  assert.deepEqual(calls[1].args, ['--client', 'local']);

  const identity = parseEnv(fs.readFileSync(result.browserEnvFile, 'utf8'));
  assert.equal(identity.VP_VENEER_BROWSER_CLIENT_ID, 'local');
  assert.equal(identity.VP_VENEER_BROWSER_TOKEN, 's3cret-token');
  assert.equal(fs.statSync(result.browserEnvFile).mode & 0o077, 0);

  const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.equal(env.DATA_DIR, '/data');
  assert.equal(env.VP_VENEER_BROWSER_URL, 'https://localhost:7301');
  assert.equal(env.VP_VENEER_BROWSER_LAN_CA, paths.certFile);
  assert.equal(env.VP_VENEER_BROWSER_IDENTITY_FILE, result.browserEnvFile);
  assert.equal(env.NODE_EXTRA_CA_CERTS, paths.certFile);
  // The token belongs in browser.env alone.
  assert.equal(env.VP_VENEER_BROWSER_TOKEN, undefined);
});

test('rotates the token without disturbing operator overrides', () => {
  const { serviceHome, envFile } = fixture();
  const paths = browserManagerPaths(serviceHome, envFile);
  fs.appendFileSync(envFile, 'VP_VENEER_BROWSER_URL=https://browser.example\n');

  provisionLocalBrowserManager({ codeDir: '/code', serviceHome, envFile, ...fakeScripts(paths.certFile) });
  const second = fakeScripts(paths.certFile);
  second.runScript = (script, args, home) => {
    if (path.basename(script) === 'local-tls.mjs') return `cert=${paths.certFile}\nkey=${paths.keyFile}\n`;
    return 'VP_VENEER_BROWSER_CLIENT_ID=local\nVP_VENEER_BROWSER_TOKEN=rotated\n';
  };
  const result = provisionLocalBrowserManager({ codeDir: '/code', serviceHome, envFile, runScript: second.runScript });

  const identity = parseEnv(fs.readFileSync(result.browserEnvFile, 'utf8'));
  assert.equal(identity.VP_VENEER_BROWSER_TOKEN, 'rotated');
  assert.equal(
    Object.keys(identity).filter((key) => key === 'VP_VENEER_BROWSER_TOKEN').length,
    1,
  );
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).VP_VENEER_BROWSER_URL, 'https://browser.example');
});

test('fails loudly when the client script prints no identity', () => {
  const { serviceHome, envFile } = fixture();
  const paths = browserManagerPaths(serviceHome, envFile);
  assert.throws(() => provisionLocalBrowserManager({
    codeDir: '/code',
    serviceHome,
    envFile,
    runScript: (script) => (path.basename(script) === 'local-tls.mjs' ? `cert=${paths.certFile}\n` : ''),
  }), /printed no client identity/);
});
