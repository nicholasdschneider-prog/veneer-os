import { EventEmitter } from 'node:events';
import { loadEnvFile } from '../envFile.js';
import { loadConfig } from '../config.js';
import { migrateClaudeConfigFile } from '../homes.js';
import { openDb } from '../db/db.js';
import { initMediaStore } from '../runtime/media.js';
import { buildAgentRuntime } from '../runtime/buildAgentRuntime.js';
import { conversationsForSweep, ensureClaudeTranscriptRetention } from '../runtime/transcriptArchive.js';
import { createSecretStore } from '../secrets/store.js';
import { createUsageStore } from '../usage/store.js';
import { createClaudeProbe } from '../usage/claudeProbe.js';
import { createClaudeLimitResetManager } from '../usage/claudeLimitReset.js';
import { createIpcServer } from './ipcServer.js';
import { createScheduledTaskScheduler } from '../scheduled/scheduler.js';
import { createConversationWakeupScheduler } from '../scheduled/wakeups.js';
import { createBuildQueueCoordinator } from '../buildQueue/coordinator.js';
import { createShutdown } from '../shutdown.js';
import { writePidFile } from '../servicePid.js';
import { createDopplerTokenStore, DopplerRuntime } from '../secrets/doppler.js';
import { installPlatformSkills } from '../skills/platform.js';
import { createVeneerBrowserRemote } from '../veneerBrowser/remoteClient.js';
import { VeneerBrowserManager } from '../veneerBrowser/manager.js';

/**
 * Runner process (plan §"Target topology"): owns all agent CLI child processes
 * and every turn-related DB/usage write. It builds the same turn-execution
 * runtime as the web boot (buildAgentRuntime) but serves ONLY the internal IPC
 * API — no routes, static assets, or channels. Restarting web never touches it,
 * so in-flight turns survive a ship. Web talks to it over runner/client.ts.
 */
// Before config: launchd cannot inject an env file, so the service reads it.
loadEnvFile();
// The runner owns every agent spawn, so it is the one process that pins
// CLAUDE_CONFIG_DIR. Carry an existing install's `.claude.json` into that
// directory first (copy, idempotent) so pinning it does not read as a brand-new
// Claude profile. Never fatal: a fresh install simply has nothing to carry.
try {
  const moved = migrateClaudeConfigFile();
  if (moved === 'copied') console.log('[veneer-pro] carried .claude.json into the pinned Claude config dir');
} catch (err) {
  console.warn(`[veneer-pro] could not carry .claude.json forward: ${(err as Error).message}`);
}
const config = loadConfig();
// Product-owned skills live in the tagged checkout. Install stable discovery
// links into both pinned provider profiles before any agent can spawn.
installPlatformSkills({ sourceDir: config.sourceDir });
const db = openDb(config.dataDir);
// Runner writes tool-result images (adapter/transcript path); web serves them
// from the same dataDir/media — shared filesystem, no IPC.
initMediaStore(config.dataDir);

const secrets = createSecretStore(config.dataDir);
const dopplerTokens = createDopplerTokenStore(config.dataDir);
const doppler = new DopplerRuntime(dopplerTokens);
await doppler.refresh();
doppler.start();
// The runner is the SOLE usage writer (single-writer discipline): the claude
// adapter's onRateLimit records here, and the probe below writes usage.json.
// Fan-out for "the meters moved": the IPC server turns each emit into a
// `usage` frame so browsers refresh their nav rings mid-turn.
const usageBus = new EventEmitter();
usageBus.setMaxListeners(50);
const usage = createUsageStore(config.dataDir, {
  // Unsuffixed reads use the active account; stream writes name the spawn account.
  activeAccountId: () => secrets.activeClaudeAccountId(),
  onRecord: () => usageBus.emit('changed'),
});
// Active Claude usage refresh lives here so all usage.json writes stay in one
// process; web reads snapshots read-only via the /rpc/usage endpoint.
const claudeProbe = createClaudeProbe({
  store: usage,
  // Meter EVERY connected account, not just the active one: the switcher is
  // only useful if you can see which account still has headroom.
  getAccounts: () => secrets.claudeAccountCredentials(),
  onProfile: (accountId, profile) => secrets.updateClaudeAccountProfile(accountId, profile),
});
const runtime = buildAgentRuntime({ config, db, secrets, doppler, usage, claudeProbe });
const { manager, adapters, transcriptArchive, projectDopplerCli } = runtime;
const claudeLimitReset = createClaudeLimitResetManager({
  // The requested account is explicit. This never reads or changes the active
  // account, so a reset cannot silently switch which login the next turn uses.
  getTokenFor: (accountId) => secrets.getClaudeTokenFor(accountId),
  onStatus: (accountId, status) => usage.setClaudeLimitResetFor(accountId, status),
});

const veneerBrowser = new VeneerBrowserManager({
  db,
  dataDir: config.dataDir,
  remote: createVeneerBrowserRemote({
    baseUrl: config.veneerBrowserUrl,
    identityFile: config.veneerBrowserIdentityFile,
    lanUrl: config.veneerBrowserLanUrl,
    lanCaFile: config.veneerBrowserLanCa,
  }),
});
await veneerBrowser.reconcile();
// Two seconds keeps provider-triggered automations responsive; schedule checks
// are cheap and share the same durable tick.
const scheduled = createScheduledTaskScheduler({ db, manager, tickMs: 2_000 });
const wakeups = createConversationWakeupScheduler({ db, manager, bus: manager.bus, tickMs: 2_000 });
const buildQueue = createBuildQueueCoordinator({ db, manager });
const server = createIpcServer({
  manager,
  adapters,
  db,
  dataDir: config.dataDir,
  usage,
  usageBus,
  probe: claudeProbe,
  claudeLimitReset,
  veneerBrowser,
  scheduled,
  wakeups,
  buildQueue,
  // The browser's fill_secret / fill_totp tools read Doppler in this process.
  secretAccess: {
    db,
    projectDopplerCli,
  },
  onRestart: (reason) => shutdown.drainAndExit(reason),
});
const clearPidFile = writePidFile(config.dataDir, 'veneer-pro-runner');

server.listen(config.runnerPort, '127.0.0.1', () => {
  console.log(`[veneer-pro-runner] IPC listening on http://127.0.0.1:${config.runnerPort} (data: ${config.dataDir})`);
  // Now that the IPC server is up (a resumed agent may need it), re-run any
  // turns that were in flight when the runner last died.
  manager.resumeInterruptedTurns();
  // Catch up the transcript archive for turns that ended while the runner was
  // down (process death skips the per-turn hook), and stop Claude Code deleting
  // its own session files in the first place. Both are best effort.
  void transcriptArchive.sweep(conversationsForSweep(db));
  void ensureClaudeTranscriptRetention();
  scheduled.start();
  wakeups.start();
  buildQueue.start();
});

// Clean shutdown: drain in-flight IPC, kill in-flight turn child processes,
// close the DB, exit 0 for the supervisor to respawn. Idempotent — a SIGTERM
// racing a /rpc/restart can't double-close. Pending turns/approvals are DB rows
// and survive for the next boot's resume.
const shutdown = createShutdown({
  name: 'veneer-pro-runner',
  server,
  release: () => {
    scheduled.stop();
    wakeups.stop();
    buildQueue.stop();
    veneerBrowser.shutdown();
    manager.shutdown();
    doppler.stop();
    clearPidFile();
    db.close();
  },
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => shutdown.drainAndExit(sig));
}
