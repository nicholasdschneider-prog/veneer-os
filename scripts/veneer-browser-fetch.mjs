#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function localSettings() {
  const values = {};
  const envFile = process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env');
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?(DATA_DIR|VP_RUNNER_PORT)\s*=\s*(.*)$/.exec(line);
      if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* Explicit options and environment can supply the settings. */ }
  return values;
}

/** Runs on the Veneer host. It reads the existing IPC credential only at use time. */
export async function fetchBrowserUrl({ conversationId, request, dataDir, port } = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('A conversationId is required.');
  if (!request || typeof request.url !== 'string') throw new Error('A request with a URL is required.');
  const settings = localSettings();
  const directory = dataDir || process.env.DATA_DIR || settings.DATA_DIR || path.join(os.homedir(), '.local', 'share', 'veneer-pro');
  const root = directory.startsWith('~') ? path.join(os.homedir(), directory.slice(1)) : directory;
  const runnerPort = Number(port ?? process.env.VP_RUNNER_PORT ?? settings.VP_RUNNER_PORT ?? 3101);
  if (!Number.isInteger(runnerPort) || runnerPort < 1 || runnerPort > 65535) throw new Error('Invalid local runner port.');
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${runnerPort}/rpc/veneerBrowserFetchUrl`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json',
        'x-vp-ipc-secret': fs.readFileSync(path.join(root, 'runner-ipc-secret'), 'utf8').trim() },
      body: JSON.stringify({ convId: conversationId, request }),
      // Cold profile startup is separately bounded by the browser manager.
      signal: AbortSignal.timeout(360000),
    });
  } catch { throw new Error('Could not reach the local Veneer runner. Check DATA_DIR, VP_RUNNER_PORT, and that Veneer is running.'); }
  if (!response.ok) throw new Error(`Local Veneer reader returned HTTP ${response.status}. Check the chat id and installed server version.`);
  const result = await response.json();
  if (typeof result?.ok !== 'boolean' || typeof result?.fetched_at !== 'string') throw new Error('The local runner returned an invalid reader response.');
  return result;
}

async function main() {
  const [conversationId, rawRequest, ...extra] = process.argv.slice(2);
  if (!conversationId || !rawRequest || extra.length || conversationId === '--help') {
    console.log('Usage: node scripts/veneer-browser-fetch.mjs CHAT_ID \'{"url":"https://example.com","wait_for":{"text":"Example"}}\'\nReturns JSON. Exit 0: ready; 1: page read failed; 2: setup/transport error.');
    process.exitCode = conversationId === '--help' ? 0 : 2;
    return;
  }
  try {
    const result = await fetchBrowserUrl({ conversationId, request: JSON.parse(rawRequest) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    // JSON syntax errors may repeat part of the input. Keep CLI failures generic.
    console.error(error instanceof SyntaxError ? 'The request must be valid JSON.' : error.message);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
