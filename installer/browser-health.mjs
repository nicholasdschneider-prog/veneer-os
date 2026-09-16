import os from 'node:os';
import {
  LINUX_AGENT_BROWSER_ARGS,
  inspectAgentBrowserInstallation,
} from './agent-browser.mjs';

export async function browserHealth({
  serviceHome = os.homedir(),
  cdpPort = Number(process.env.VP_DESKTOP_CDP_PORT || 9223),
  fetchImpl = fetch,
  timeoutMs = 2_000,
  expectedBrowserArgs = process.platform === 'linux' ? LINUX_AGENT_BROWSER_ARGS : undefined,
} = {}) {
  const installation = inspectAgentBrowserInstallation({ serviceHome, expectedBrowserArgs });
  let sharedCdpReady = false;
  if (Number.isInteger(cdpPort) && cdpPort > 0 && cdpPort <= 65_535) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const version = response.ok ? await response.json() : null;
      sharedCdpReady =
        typeof version?.Browser === 'string'
        && typeof version?.webSocketDebuggerUrl === 'string'
        && version.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${cdpPort}/`);
    } catch {
      sharedCdpReady = false;
    }
  }
  return {
    agentBrowserReady: installation.problems.length === 0,
    sharedCdpReady,
    cdpPort,
  };
}
