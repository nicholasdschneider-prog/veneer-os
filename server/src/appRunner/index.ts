import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../envFile.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/db.js';
import { createAppRunnerIpcServer } from './ipcServer.js';
import { LocalAppManager } from './manager.js';
import { createShutdown } from '../shutdown.js';
import { writePidFile } from '../servicePid.js';

// Before config: launchd cannot inject an env file, so the service reads it.
loadEnvFile();
const config = loadConfig();
const db = openDb(config.dataDir);
const manager = config.appPublicOrigin
  ? new LocalAppManager({
      db,
      dataDir: config.dataDir,
      childEntry: path.join(path.dirname(fileURLToPath(import.meta.url)), 'child.js'),
      publicOrigin: config.appPublicOrigin,
    })
  : null;
const server = createAppRunnerIpcServer(manager);
const clearPidFile = writePidFile(config.dataDir, 'veneer-pro-app-runner');

server.listen(config.appRunnerPort, '127.0.0.1', () => {
  console.log(
    `[veneer-pro-app-runner] IPC listening on http://127.0.0.1:${config.appRunnerPort}` +
      (manager ? '' : ' (local apps disabled: VP_APPS_PUBLIC_ORIGIN is unset)'),
  );
  manager?.restore();
});

const shutdown = createShutdown({
  name: 'veneer-pro-app-runner',
  server,
  release: () => {
    manager?.shutdown();
    clearPidFile();
    db.close();
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown.drainAndExit(signal));
}
