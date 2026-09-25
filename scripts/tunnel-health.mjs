import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// Attribute the metrics listener to the process writing this installation's
// tunnel log. Never guess 20241: another tunnel may own that port. Do not read
// process arguments, credentials, log contents, or arbitrary response bodies.
export function tunnelPid(output) {
  const owners = new Set();
  let pid;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) pid = line.slice(1);
    if (line === 'ccloudflared' && pid) owners.add(pid);
  }
  if (owners.size !== 1) throw new Error('Cannot identify one Veneer tunnel process from its log; inspect its service and network connection');
  return [...owners][0];
}

export function metricsAddress(output, pid) {
  let current;
  const addresses = new Set();
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) current = line.slice(1);
    if (current !== pid) continue;
    const match = /^n(127\.0\.0\.1|\[::1\]):(\d+)$/.exec(line);
    if (match && Number(match[2]) > 0 && Number(match[2]) < 65536) addresses.add(`http://${match[1]}:${match[2]}`);
  }
  if (addresses.size !== 1) throw new Error('Veneer tunnel has no unambiguous loopback metrics listener; inspect its service configuration');
  return [...addresses][0];
}

export async function inspectTunnel(logFile, { exec = execute, fetcher = fetch } = {}) {
  let address;
  try {
    const { stdout: owners } = await exec('/usr/sbin/lsof', ['-nP', '-Fpc', logFile], {timeout: 2000, maxBuffer: 65536});
    const pid = tunnelPid(owners);
    const { stdout: listeners } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fpn'], {timeout: 2000, maxBuffer: 65536});
    address = metricsAddress(listeners, pid);
  } catch {
    // Subprocess errors may embed arguments/output; return fixed diagnostic text.
    throw new Error('Tunnel readiness unknown: cannot identify Veneer’s live loopback metrics listener from its log owner');
  }
  let res, body;
  try {
    res = await fetcher(`${address}/ready`, {redirect: 'error', signal: AbortSignal.timeout(2000)});
    body = await res.json();
  } catch {
    throw new Error('Tunnel readiness unavailable: inspect cloudflared and the host network');
  }
  if (res.status !== 200 || body.status !== 200 || !Number.isInteger(body.readyConnections) || body.readyConnections < 1) {
    throw new Error('Tunnel disconnected or readiness invalid: check the host route and Cloudflare connectivity; restarting the web app will not repair a missing network route');
  }
  return `${body.readyConnections} active edge connections; authenticated public chat remains unverified`;
}

export async function inspectPublicEdge(url, fetcher = fetch) {
  // Never echo a configured URL (it could contain sensitive query parameters).
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('invalid');
    const res = await fetcher(target, {redirect: 'manual', signal: AbortSignal.timeout(3000)});
    await res.body?.cancel();
    if (![200, 301, 302].includes(res.status)) throw new Error('unreachable');
    return `HTTP ${res.status}; public front door reachable, origin/authenticated chat unverified`;
  } catch {
    throw new Error('Public front door unavailable or URL invalid; check DNS/network and Cloudflare (HTTPS URL required)');
  }
}
