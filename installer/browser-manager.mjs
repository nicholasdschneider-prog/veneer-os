// Local Veneer Browser manager provisioning.
//
// On Veneer OS the browser manager is not a remote VM: it runs beside the Pro
// server as com.veneer.browser-manager and drives native Chrome processes. That
// leaves the installer three jobs, all idempotent, all described in
// browser-manager/INSTALL-MACOS.md:
//
//   1. the loopback TLS pair the manager serves on 7301,
//   2. a bearer token for client id `local` (hash stored, token printed once),
//   3. the env wiring the Pro server needs to reach and trust that listener.
//
// The token never reaches a log: it goes straight from the script's stdout into
// browser.env, which is written 0600 because remoteClient.ts refuses to read an
// identity file that any other account could open.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { upsertEnvValues } from './env.mjs';

export const VENEER_BROWSER_LOCAL_URL = 'https://localhost:7301';
export const VENEER_BROWSER_LOCAL_CLIENT_ID = 'local';

/** Where the rendered plist points its TLS, store and registry paths. */
export function browserManagerPaths(serviceHome, envFile) {
  const tlsDir = path.join(serviceHome, '.config', 'veneer-browser', 'tls');
  return {
    tlsDir,
    certFile: path.join(tlsDir, 'cert.pem'),
    keyFile: path.join(tlsDir, 'key.pem'),
    clientsFile: path.join(serviceHome, '.config', 'veneer-browser', 'clients.json'),
    storeDir: path.join(serviceHome, 'Library', 'Application Support', 'veneer-browser', 'store'),
    // Next to the main env file, and named explicitly in it, so the identity is
    // found whether or not the service home is the login home.
    browserEnvFile: path.join(path.dirname(envFile), 'browser.env'),
  };
}

function parseScriptOutput(output) {
  const values = {};
  for (const line of String(output).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Run the two browser-manager scripts and merge their results into the env
 * files. `runScript` is injectable so the tests never shell out.
 *
 * Returns the paths the caller renders into the plist and the README; it never
 * returns or logs the bearer token.
 */
export function provisionLocalBrowserManager({
  codeDir,
  serviceHome,
  envFile,
  nodeBin = process.execPath,
  runScript = (script, args, home) => execFileSync(nodeBin, [script, ...args], {
    encoding: 'utf8',
    // Both scripts derive every path from HOME, and the manager runs with the
    // service home — so the installer must too, or the cert and the registry
    // would land where the service never looks.
    env: { ...process.env, HOME: home },
  }),
}) {
  const paths = browserManagerPaths(serviceHome, envFile);
  const scripts = path.join(codeDir, 'browser-manager', 'scripts');

  const tls = parseScriptOutput(runScript(path.join(scripts, 'local-tls.mjs'), [], serviceHome));
  const certFile = tls.cert || paths.certFile;

  const client = parseScriptOutput(
    runScript(path.join(scripts, 'local-client.mjs'), ['--client', VENEER_BROWSER_LOCAL_CLIENT_ID], serviceHome),
  );
  if (!client.VP_VENEER_BROWSER_CLIENT_ID || !client.VP_VENEER_BROWSER_TOKEN) {
    throw new Error('browser-manager/scripts/local-client.mjs printed no client identity.');
  }
  upsertEnvValues(paths.browserEnvFile, {
    VP_VENEER_BROWSER_CLIENT_ID: client.VP_VENEER_BROWSER_CLIENT_ID,
    VP_VENEER_BROWSER_TOKEN: client.VP_VENEER_BROWSER_TOKEN,
  }, { mode: 0o600 });

  // Overridable by the operator: a host that points Pro at a different manager
  // keeps its own values across re-installs.
  upsertEnvValues(envFile, {
    VP_VENEER_BROWSER_URL: VENEER_BROWSER_LOCAL_URL,
    VP_VENEER_BROWSER_LAN_CA: certFile,
    VP_VENEER_BROWSER_IDENTITY_FILE: paths.browserEnvFile,
  }, { onlyIfMissing: true });

  // Node reads NODE_EXTRA_CA_CERTS once, at process start, before any env file
  // the service loads itself — so this line is documentation for humans and for
  // `npm run dev`; the launchd services get the same value from their plists.
  upsertEnvValues(envFile, { NODE_EXTRA_CA_CERTS: certFile }, { onlyIfMissing: true });

  return { ...paths, certFile, keyFile: tls.key || paths.keyFile };
}
