import { loadEnvFile } from '../envFile.js';
import { installTypeOfServiceGuard } from '../net/typeOfServiceGuard.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/db.js';
import { createTerminalServer } from './server.js';
import { createShutdown } from '../shutdown.js';
import { writePidFile } from '../servicePid.js';

// Before config: launchd cannot inject an env file, so the service reads it.
// Before anything opens a socket: an undici TOS EINVAL must fail one request, not the process.
installTypeOfServiceGuard();
loadEnvFile();
const config = loadConfig();
const db = openDb(config.dataDir);
const terminals = createTerminalServer({ db, dataDir: config.dataDir });
const clearPidFile = writePidFile(config.dataDir, 'veneer-pro-term');

terminals.server.listen(config.termPort, '127.0.0.1', () => {
  console.log(`[veneer-pro-term] IPC listening on http://127.0.0.1:${config.termPort}`);
});

const shutdown = createShutdown({
  name: 'veneer-pro-term',
  server: terminals.server,
  release: () => {
    // Restarting this service is the one thing that ends live shells, which is
    // why ship only restarts it when terminal-service code actually changed.
    terminals.shutdown();
    clearPidFile();
    db.close();
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown.drainAndExit(signal));
}
