#!/usr/bin/env node
// Post-boot self-verification: proves the host actually came back on its own.
//
// The Mac Studio is a server with no operator. Power returns -> `pmset
// autorestart` boots it -> auto-login starts the LaunchAgents -> the tunnel is
// already up as a LaunchDaemon -> the site is live. Every link in that chain is
// configured, but configuration is not evidence. This is the evidence: a
// one-shot LaunchAgent (com.veneer.boot-probe) that runs once per boot, waits
// for the stack to settle, checks every hop from the loopback ports out to the
// public edge, writes ~/veneer-boot-report-<timestamp>.txt, and emails the
// verdict. A boot nobody looked at is a boot nobody verified.
//
// Deliberately standalone: no imports from server/dist, no npm dependencies.
// The report matters most on the boot where the build is broken, so the probe
// must not share a failure mode with the thing it is reporting on.
//
// Checks retry until DEADLINE_MS, so a slow start reads as "green at +47s"
// rather than a false alarm. Anything still failing at the deadline is a real
// failure and the subject line says so.
//
//   node scripts/boot-probe.mjs [--now] [--no-email]
//
//   --now       skip the settle delay (for testing the probe itself)
//   --no-email  write the report but do not send it

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inspectAgentBrowserInstallation } from '../installer/agent-browser.mjs';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const runNow = args.includes('--now');
const noEmail = args.includes('--no-email');

// Boot is the slowest thing this ever waits on: launchd starts everything at
// once, node services compile, Chrome unpacks its profile, and cloudflared
// re-establishes four edge connections. Give it room before the first check.
const SETTLE_MS = runNow ? 0 : 20_000;
const DEADLINE_MS = Number(process.env.VP_BOOT_PROBE_DEADLINE_MS) || 5 * 60_000;
const ATTEMPT_TIMEOUT_MS = 8_000;
const RETRY_GAP_MS = 3_000;
const REPORTS_TO_KEEP = 10;

const home = os.homedir();
const envFile = process.env.VP_ENV_FILE || path.join(home, '.config', 'veneer-pro', 'env');

// --- env file (same format the services read; parsed here rather than imported
// from server/dist so a broken build cannot silence the probe) ---------------
function readEnvFile(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const quoted = /^(['"])([\s\S]*)\1$/.exec(match[2].trim());
    out[match[1]] = quoted ? quoted[2] : match[2].trim();
  }
  return out;
}

const fileEnv = readEnvFile(envFile);
const setting = (name, fallback) => process.env[name] ?? fileEnv[name] ?? fallback;

const port = setting('PORT', '3100');
const runnerPort = setting('VP_RUNNER_PORT', '3101');
const appRunnerPort = setting('VP_APP_RUNNER_PORT', '3102');
const termPort = setting('VP_TERM_PORT', '3103');
const cdpPort = setting('VP_DESKTOP_CDP_PORT', '9223');
const supermemoryPort = setting('VP_SUPERMEMORY_PORT', '6767');
// The edge is the only check that proves the tunnel: loopback health says
// nothing about whether cloudflared reconnected. Unauthenticated it answers
// 302 to the Access login, which is exactly the "up and protected" signal.
// Unset means this install has no public hostname to probe; the check is
// skipped rather than guessed at.
const edgeUrl = setting('VP_BOOT_PROBE_URL', '');
// Host extras as `label=url[,label=url...]`.
const extras = setting('VP_BOOT_PROBE_EXTRA', '');
// Email reporting is entirely opt-in: set both of these plus a Resend key.
const mailTo = setting('VP_BOOT_PROBE_EMAIL', '');
const mailFrom = setting('VP_BOOT_PROBE_FROM', '');
// The subject line is often all a reader sees, so name the machine, not the
// instance: "mac-studio.local" answers "which box died?".
const hostLabel = setting('VP_BOOT_PROBE_HOST', os.hostname().replace(/\.local$/, ''));
const serviceHome = setting('VP_SERVICE_HOME', path.join(home, 'veneer-pro-home'));
const supermemoryBin = path.join(home, '.supermemory', 'bin', 'supermemory-server');

// --- checks -----------------------------------------------------------------
/** @type {{name: string, detail: string, run: () => Promise<string>}[]} */
const CHECKS = [
  httpCheck('veneer-pro web', `http://127.0.0.1:${port}/healthz`, [200]),
  // Web's own /healthz proxies the runner, but check it directly too: that
  // proxy hides *which* of the two is down, and after a boot that matters.
  httpCheck('veneer-pro runner', `http://127.0.0.1:${runnerPort}/healthz`, [200]),
  // The app runner serves RPC only — it has no GET route, so a GET would report
  // a healthy process as 405. POST the cheapest real call instead.
  httpCheck('veneer-pro app-runner', `http://127.0.0.1:${appRunnerPort}/rpc/statuses`, [200], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
  // The terminal service owns every browser shell; it must be back after a
  // reboot even though no web restart ever touches it.
  httpCheck('veneer-pro term', `http://127.0.0.1:${termPort}/healthz`, [200]),
  ...(fs.existsSync(supermemoryBin)
    ? [httpCheck('supermemory', `http://127.0.0.1:${supermemoryPort}/v3/health`, [200])]
    : []),
  agentBrowserCheck(serviceHome),
  // The shared desktop Chrome. /json/version is the DevTools endpoint the CDP
  // viewer and agent-browser both attach through.
  httpCheck('desktop chrome (cdp)', `http://127.0.0.1:${cdpPort}/json/version`, [200]),
  ...(edgeUrl ? [httpCheck('public edge (tunnel)', edgeUrl, [200, 302, 301])] : []),
];
if (!edgeUrl) console.log('[boot-probe] VP_BOOT_PROBE_URL is unset — skipping the public edge check');

for (const entry of extras.split(',').map((s) => s.trim()).filter(Boolean)) {
  const split = entry.indexOf('=');
  if (split < 1) continue;
  CHECKS.push(httpCheck(entry.slice(0, split), entry.slice(split + 1), [200, 301, 302]));
}

function httpCheck(name, url, okStatuses, init = {}) {
  return {
    name,
    detail: `${init.method ?? 'GET'} ${url}`,
    async run() {
      const res = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (!okStatuses.includes(res.status)) {
        throw new Error(`HTTP ${res.status} (want ${okStatuses.join('/')})`);
      }
      return `HTTP ${res.status}`;
    },
  };
}

function agentBrowserCheck(targetHome) {
  const inspected = inspectAgentBrowserInstallation({ serviceHome: targetHome });
  return {
    name: 'agent-browser host',
    detail: inspected.paths.binary,
    async run() {
      const current = inspectAgentBrowserInstallation({ serviceHome: targetHome });
      if (current.problems.length) throw new Error(current.problems.join('; '));
      const { stdout } = await execFileAsync(current.paths.binary, ['--version'], {
        timeout: ATTEMPT_TIMEOUT_MS,
        env: { ...process.env, HOME: targetHome },
      });
      return stdout.trim() || 'version check passed';
    },
  };
}

async function runCheck(check, startedAt) {
  let lastErr = 'never attempted';
  while (Date.now() - startedAt < DEADLINE_MS) {
    try {
      const note = await check.run();
      return {
        ...check,
        ok: true,
        note,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastErr = err?.message ?? String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_GAP_MS));
  }
  return { ...check, ok: false, note: lastErr, elapsedMs: Date.now() - startedAt };
}

// --- context for the report -------------------------------------------------
async function sh(file, argv) {
  try {
    const { stdout } = await execFileAsync(file, argv, { timeout: 10_000 });
    return stdout.trim();
  } catch (err) {
    return `(failed: ${err?.message ?? err})`;
  }
}

async function bootContext() {
  if (process.platform !== 'darwin') {
    return { bootTime: '(not darwin)', uptime: '', sinceBootSec: null, services: [] };
  }
  const kern = await sh('sysctl', ['-n', 'kern.boottime']);
  const bootSec = Number(/sec = (\d+)/.exec(kern)?.[1]);
  const sinceBootSec = Number.isFinite(bootSec) ? Math.round(Date.now() / 1000) - bootSec : null;
  const uptime = await sh('uptime', []);
  const uid = process.getuid();
  const services = [];
  for (const label of [
    'com.veneer.pro',
    'com.veneer.pro.runner',
    'com.veneer.pro.app-runner',
    'com.veneer.pro.term',
    'com.veneer.supermemory',
    'com.veneer.chrome',
  ]) {
    const out = await sh('launchctl', ['print', `gui/${uid}/${label}`]);
    const state = /^\s*state = (.+)$/m.exec(out)?.[1] ?? 'not loaded';
    const pid = /^\s*pid = (\d+)$/m.exec(out)?.[1] ?? '-';
    services.push(`${label.padEnd(28)} ${state.padEnd(12)} pid ${pid}`);
  }
  const tunnel = await sh('sudo', ['-n', 'launchctl', 'print', 'system/com.cloudflare.cloudflared']);
  const tunnelState = /^\s*state = (.+)$/m.exec(tunnel)?.[1] ?? 'unknown (needs sudo)';
  services.push(`${'com.cloudflare.cloudflared'.padEnd(28)} ${tunnelState}`);
  const pm = await sh('pmset', ['-g', 'custom']);
  return { bootTime: kern, uptime, sinceBootSec, services, pmset: pm };
}

// --- report -----------------------------------------------------------------
function renderReport(results, ctx, stamp) {
  const failed = results.filter((r) => !r.ok);
  const lines = [];
  lines.push(`Veneer boot report — ${hostLabel}`);
  lines.push(`generated ${stamp}`);
  lines.push('');
  lines.push(failed.length ? `VERDICT: FAIL — ${failed.length}/${results.length} checks did not come up`
                           : `VERDICT: PASS — all ${results.length} checks green`);
  lines.push('');
  lines.push('Checks');
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    lines.push(`  ${mark} ${r.name.padEnd(24)} ${r.note.padEnd(28)} +${Math.round(r.elapsedMs / 1000)}s`);
    lines.push(`       ${r.detail}`);
  }
  lines.push('');
  lines.push('Host');
  lines.push(`  boot time  ${ctx.bootTime}`);
  lines.push(`  uptime     ${ctx.uptime}`);
  lines.push('');
  lines.push('Services');
  for (const line of ctx.services) lines.push(`  ${line}`);
  if (ctx.pmset) {
    lines.push('');
    lines.push('Power settings (pmset -g custom)');
    for (const line of ctx.pmset.split('\n')) lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push('Known limitation');
  lines.push('  Core veneer agent sessions live in tmux, which does not survive a');
  lines.push('  power loss. After an unattended boot the agents list shows dead');
  lines.push('  sessions that must be recreated by hand. Expected, not a regression.');
  lines.push('  Veneer Pro agents are different: the runner resumes them from SQLite.');
  lines.push('');
  return lines.join('\n');
}

function pruneOldReports() {
  try {
    const files = fs
      .readdirSync(home)
      .filter((name) => /^veneer-boot-report-.+\.txt$/.test(name))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - REPORTS_TO_KEEP))) {
      fs.rmSync(path.join(home, stale), { force: true });
    }
  } catch {
    /* pruning is housekeeping; never let it fail the probe */
  }
}

// --- email ------------------------------------------------------------------
// Read at send time from Doppler (the operator-email pattern) so no key is written
// into a plist or this repo. Doppler's own token lives in ~/.doppler, not the
// login Keychain, so this works in a launchd context too.
const resendSecret = setting('VP_BOOT_PROBE_RESEND_SECRET', 'RESEND_API_KEY');
const resendProject = setting('VP_BOOT_PROBE_RESEND_PROJECT', '');
const resendConfig = setting('VP_BOOT_PROBE_RESEND_CONFIG', 'prd');

async function resendKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  if (!resendProject) return null;
  for (const bin of [path.join(home, '.local', 'bin', 'doppler'), '/opt/homebrew/bin/doppler', 'doppler']) {
    try {
      const { stdout } = await execFileAsync(
        bin,
        ['secrets', 'get', resendSecret, '--project', resendProject, '--config', resendConfig, '--plain'],
        { timeout: 20_000 },
      );
      const key = stdout.trim();
      if (key) return key;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function sendReport(subject, body) {
  if (!mailTo || !mailFrom) return 'skipped (VP_BOOT_PROBE_EMAIL / VP_BOOT_PROBE_FROM unset)';
  const key = await resendKey();
  if (!key) return 'skipped (no Resend key configured)';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: mailFrom,
        to: [mailTo],
        subject,
        text: body,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return `FAILED (HTTP ${res.status}: ${JSON.stringify(json)})`;
    return `sent (${json.id ?? 'no id'})`;
  } catch (err) {
    return `FAILED (${err?.message ?? err})`;
  }
}

// --- main -------------------------------------------------------------------
const stamp = new Date().toISOString();
console.log(`[boot-probe] ${stamp} settling ${SETTLE_MS / 1000}s before first check`);
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const startedAt = Date.now();
// Concurrently: every check has the same deadline, and a slow one must not eat
// another's budget.
const results = await Promise.all(CHECKS.map((check) => runCheck(check, startedAt)));
const ctx = await bootContext();

const report = renderReport(results, ctx, stamp);
const reportPath = path.join(home, `veneer-boot-report-${stamp.replace(/[:.]/g, '-')}.txt`);
fs.writeFileSync(reportPath, report + '\n');
pruneOldReports();
console.log(report);
console.log(`[boot-probe] report written to ${reportPath}`);

const failed = results.filter((r) => !r.ok);
// A probe firing at an uptime of days is a reload, not a boot. Say so in the
// subject: an unlabelled "boot report" arriving out of nowhere reads as an
// unexplained reboot, which is exactly the false alarm this is meant to avoid.
const manual = ctx.sinceBootSec != null && ctx.sinceBootSec > 15 * 60
  ? ` [manual run, uptime ${Math.round(ctx.sinceBootSec / 3600)}h]`
  : '';
const subject = failed.length
  ? `FAILED: ${hostLabel} boot — ${failed.map((r) => r.name).join(', ')} down${manual}`
  : `OK: ${hostLabel} boot — all ${results.length} checks green${manual}`;

if (noEmail) {
  console.log('[boot-probe] --no-email, not sending');
} else {
  console.log(`[boot-probe] email ${await sendReport(subject, report)}`);
}

// Non-zero on failure so `launchctl print` shows a last exit status worth
// noticing, and so `--now` runs are usable from a shell or from CI.
process.exit(failed.length ? 1 : 0);
