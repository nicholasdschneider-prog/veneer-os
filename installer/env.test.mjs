import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseEnv, upsertEnvValues, validateInstallEnv } from './env.mjs';

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-env-'));
  const file = path.join(dir, 'env');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

test('replaces an existing key in place and appends a new one', () => {
  const file = tempFile('# header\nDATA_DIR=/data\nPORT=3100\n');
  upsertEnvValues(file, { PORT: '3900', VP_VENEER_BROWSER_URL: 'https://localhost:7301' });
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '# header\nDATA_DIR=/data\nPORT="3900"\nVP_VENEER_BROWSER_URL="https://localhost:7301"\n',
  );
});

test('leaves unrelated lines, comments and ordering untouched', () => {
  const file = tempFile('# keep me\nA=1\n\n# and me\nB=2\n');
  upsertEnvValues(file, { B: '3' });
  assert.equal(fs.readFileSync(file, 'utf8'), '# keep me\nA=1\n\n# and me\nB="3"\n');
});

test('collapses duplicate definitions of a rewritten key', () => {
  const file = tempFile('X=1\nY=y\nX=2\n');
  upsertEnvValues(file, { X: '3' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'X="3"\nY=y\n');
});

test('onlyIfMissing keeps an operator value but still adds absent keys', () => {
  const file = tempFile('VP_VENEER_BROWSER_URL=https://browser.example\nEMPTY=\n');
  upsertEnvValues(file, {
    VP_VENEER_BROWSER_URL: 'https://localhost:7301',
    EMPTY: 'filled',
    NODE_EXTRA_CA_CERTS: '/certs/cert.pem',
  }, { onlyIfMissing: true });
  const values = parseEnv(fs.readFileSync(file, 'utf8'));
  assert.equal(values.VP_VENEER_BROWSER_URL, 'https://browser.example');
  // An empty value is not a choice the operator made, so it is filled in.
  assert.equal(values.EMPTY, 'filled');
  assert.equal(values.NODE_EXTRA_CA_CERTS, '/certs/cert.pem');
});

test('creates a missing file and enforces the mode on every write', () => {
  const file = tempFile();
  upsertEnvValues(file, { VP_VENEER_BROWSER_TOKEN: 'first' }, { mode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  upsertEnvValues(file, { VP_VENEER_BROWSER_TOKEN: 'second' }, { mode: 0o600 });
  // remoteClient.ts refuses an identity file any other account could read.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).VP_VENEER_BROWSER_TOKEN, 'second');
});

test('quotes values containing spaces and quotes', () => {
  const file = tempFile('');
  upsertEnvValues(file, { P: '/a b/c "d"' });
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).P, '/a b/c "d"');
});

test('validateInstallEnv fails when cloudflare identity has no team domain', () => {
  const { problems } = validateInstallEnv({ VP_IDENTITY: 'cloudflare', VP_CF_AUD: 'aud-tag' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VP_CF_TEAM_DOMAIN/);
  assert.doesNotMatch(problems[0], /VP_CF_AUD requires/);
});

test('validateInstallEnv fails when cloudflare identity has no AUD', () => {
  const { problems } = validateInstallEnv({
    VP_IDENTITY: 'cloudflare',
    VP_CF_TEAM_DOMAIN: 'veneer.cloudflareaccess.com',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VP_CF_AUD/);
});

test('validateInstallEnv treats an unset identity as cloudflare', () => {
  const { problems } = validateInstallEnv({ DATA_DIR: '/data', VP_SOURCE_DIR: '/src' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VP_CF_TEAM_DOMAIN and VP_CF_AUD/);
  assert.match(problems[0], /unset, the default/);
});

test('validateInstallEnv passes a complete cloudflare config', () => {
  const { problems, warnings } = validateInstallEnv({
    VP_IDENTITY: 'cloudflare',
    VP_CF_TEAM_DOMAIN: 'veneer.cloudflareaccess.com',
    VP_CF_AUD: 'aud-tag',
    DATA_DIR: '/data',
    VP_SOURCE_DIR: '/src',
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
});

test('validateInstallEnv skips the Access check for a non-cloudflare identity', () => {
  const { problems } = validateInstallEnv({
    VP_IDENTITY: 'dev',
    DATA_DIR: '/data',
    VP_SOURCE_DIR: '/src',
  });
  assert.deepEqual(problems, []);
});

test('validateInstallEnv treats a blank Access value as missing', () => {
  const { problems } = validateInstallEnv({
    VP_IDENTITY: 'cloudflare',
    VP_CF_TEAM_DOMAIN: '   ',
    VP_CF_AUD: '',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VP_CF_TEAM_DOMAIN and VP_CF_AUD/);
});

test('validateInstallEnv warns but does not fail on missing DATA_DIR and VP_SOURCE_DIR', () => {
  const { problems, warnings } = validateInstallEnv({ VP_IDENTITY: 'dev' });
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /DATA_DIR/);
  assert.match(warnings[1], /VP_SOURCE_DIR/);
});

test('validateInstallEnv warns for each unset path independently', () => {
  assert.deepEqual(
    validateInstallEnv({ VP_IDENTITY: 'dev', DATA_DIR: '/data' }).warnings.length,
    1,
  );
  assert.deepEqual(
    validateInstallEnv({ VP_IDENTITY: 'dev', VP_SOURCE_DIR: '/src' }).warnings.length,
    1,
  );
});
