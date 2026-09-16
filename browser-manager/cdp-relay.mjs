import path from 'node:path';
import { WebSocket } from 'ws';

// There is no container boundary on the native backend: Chrome runs as the same
// account as the manager, so a CDP command is as privileged as that account. The
// relay is the only thing standing between a control ticket and the local disk,
// so it refuses the handful of commands that turn "drive a web page" into "read
// this Mac". Everything else is forwarded untouched.
const BLOCKED_SCHEMES = new Set([
  'file:',
  'chrome:',
  'devtools:',
  'chrome-extension:',
  // Same reach, different spelling: view-source:file:///… reads the file, and
  // chrome-untrusted: is the internal WebUI origin.
  'view-source:',
  'chrome-untrusted:',
]);

// Commands whose url argument navigates a page somewhere.
const URL_METHODS = new Set(['Page.navigate', 'Target.createTarget', 'Page.setDownloadBehavior']);
// Browser.setDownloadBehavior is the browser-wide twin of the page command and
// would otherwise be the way around the downloads-directory check.
const DOWNLOAD_METHODS = new Set(['Page.setDownloadBehavior', 'Browser.setDownloadBehavior']);

/** The scheme this url would load when it is one Chrome must not be pointed at. */
export function blockedScheme(url) {
  if (typeof url !== 'string') return null;
  // Chrome ignores leading whitespace and C0 controls when it parses a url.
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url.replace(/^[\u0000-\u0020]+/, ''));
  if (!match) return null;
  const scheme = `${match[1].toLowerCase()}:`;
  return BLOCKED_SCHEMES.has(scheme) ? scheme : null;
}

function withinDownloads(downloadPath, downloadsDir) {
  if (typeof downloadPath !== 'string' || !downloadPath || !downloadsDir) return false;
  if (!path.isAbsolute(downloadPath)) return false;
  const root = path.resolve(downloadsDir);
  const target = path.resolve(downloadPath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * The Docker backend mounts every copy's downloads directory at `/downloads`
 * inside its container, and the Pro server's viewer channel was written against
 * that path. Native Chrome sees the real directory instead, so the same command
 * is retargeted rather than refused; anywhere else is still refused below.
 */
export function rewriteDownloadPath(message, downloadsDir, alias = '/downloads') {
  if (!downloadsDir || !alias || downloadsDir === alias) return message;
  if (!message || typeof message !== 'object' || !DOWNLOAD_METHODS.has(message.method)) return message;
  const params = message.params;
  if (!params || typeof params !== 'object' || !withinDownloads(params.downloadPath, alias)) return message;
  const relative = path.relative(path.resolve(alias), path.resolve(params.downloadPath));
  return { ...message, params: { ...params, downloadPath: path.join(path.resolve(downloadsDir), relative) } };
}

/**
 * Why this command must not reach Chrome, or null to forward it.
 *
 * Only the commands above are inspected; a message that is not JSON, or not a
 * command object, is forwarded so Chrome answers for it as it always did.
 */
export function blockedCommand(message, downloadsDir) {
  if (!message || typeof message !== 'object') return null;
  const { method, params } = message;
  if (typeof method !== 'string') return null;
  const args = params && typeof params === 'object' ? params : {};
  if (URL_METHODS.has(method)) {
    const scheme = blockedScheme(args.url);
    if (scheme) return `${method} to a ${scheme} address is not allowed by the browser manager.`;
  }
  if (DOWNLOAD_METHODS.has(method)) {
    // 'deny' and 'default' carry no destination: 'default' falls back to the
    // profile's own preferences, which already point at its downloads dir.
    const behavior = args.behavior;
    if (behavior === 'deny' || behavior === 'default') return null;
    if (!withinDownloads(args.downloadPath, downloadsDir)) {
      return `${method} may only set a download path inside this profile's downloads directory.`;
    }
  }
  return null;
}

/** Install the downstream listener before resolving Chrome's socket address. */
export function relayCdp(client, resolveUrl, {
  onClientMessage = () => {},
  onChromeMessage = () => {},
  downloadsDir = '',
  onBlocked = (reason) => console.log(`[veneer-browser] blocked a CDP command: ${reason}`),
} = {}) {
  let chrome;
  let closed = false;
  let queuedBytes = 0;
  let loggedBlock = false;
  const queued = [];
  const close = () => {
    if (closed) return;
    closed = true;
    queued.length = 0;
    try { client.close(); } catch {}
    try { chrome?.close(); } catch {}
  };
  // A refused command is answered the way Chrome answers a bad one, so the
  // caller's request settles instead of hanging until its own timeout.
  const refuse = (message, reason) => {
    if (!loggedBlock) {
      loggedBlock = true;
      onBlocked(reason);
    }
    if (client.readyState !== WebSocket.OPEN) return;
    const response = { id: message.id, error: { code: -32000, message: reason } };
    if (typeof message.sessionId === 'string') response.sessionId = message.sessionId;
    client.send(JSON.stringify(response));
  };
  client.on('message', (data, binary) => {
    if (closed) return;
    if (!binary) {
      let parsed = null;
      try { parsed = JSON.parse(data.toString()); } catch { /* Not a command; Chrome can say so. */ }
      const command = rewriteDownloadPath(parsed, downloadsDir);
      const reason = blockedCommand(command, downloadsDir);
      if (reason) return refuse(parsed, reason);
      if (command !== parsed) data = Buffer.from(JSON.stringify(command));
    }
    onClientMessage(data, binary);
    if (chrome?.readyState === WebSocket.OPEN) chrome.send(data, { binary });
    else {
      queuedBytes += data.length;
      if (queuedBytes > 1024 * 1024) return close();
      queued.push([data, binary]);
    }
  });
  client.on('close', close);
  client.on('error', close);
  void Promise.resolve().then(resolveUrl).then(url => {
    if (closed) return;
    chrome = new WebSocket(url, { perMessageDeflate: false });
    chrome.on('open', () => {
      for (const [data, binary] of queued.splice(0)) chrome.send(data, { binary });
      queuedBytes = 0;
    });
    chrome.on('message', (data, binary) => {
      onChromeMessage(data, binary);
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    chrome.on('close', close);
    chrome.on('error', close);
  }).catch(close);
}
