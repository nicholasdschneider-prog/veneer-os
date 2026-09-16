import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { LocalAppChildMeta } from './child.js';
import { proxyHttpRequest } from '../miniApps/proxy.js';
import type { LocalAppStatusView, MiniAppRow } from '../miniApps/types.js';
import { defaultExecPath } from '../platform.js';

const START_TIMEOUT_MS = 10_000;
const HEALTH_INTERVAL_MS = 10_000;
const LOG_RATE_WINDOW_MS = 10_000;
const MAX_LOG_BYTES_PER_WINDOW = 1024 * 1024;
const MAX_HEAP_MB = 128;

type Phase = LocalAppStatusView['status'];

interface ManagedApp {
  id: string;
  desired: boolean;
  phase: Phase;
  child: ChildProcess | null;
  port: number | null;
  error: string | null;
  restartCount: number;
  restartTimer: NodeJS.Timeout | null;
  readyPromise: Promise<void> | null;
  startedAt: number;
  healthFailures: number;
  logWindowStartedAt: number;
  logBytes: number;
}

export function localAppEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    PATH: source.PATH || defaultExecPath(),
  };
  for (const name of ['LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

/**
 * Local Mini Apps execute as untrusted customer-authored modules. Node's
 * permission model keeps them inside their own materialized directory and
 * denies filesystem writes, child processes, workers, and native addons by
 * default. The launcher itself is the only additional readable file. The one
 * writable path is the app's own `storage/` subdirectory, which backs the
 * context.storage API; the app module itself stays read-only.
 */
export function localAppExecArgv(childEntry: string, appDir: string): string[] {
  const readableEntry = fs.realpathSync(childEntry);
  const readableAppDir = fs.realpathSync(appDir);
  return [
    `--max-old-space-size=${MAX_HEAP_MB}`,
    '--permission',
    `--allow-fs-read=${readableEntry}`,
    `--allow-fs-read=${readableAppDir}`,
    `--allow-fs-write=${path.join(readableAppDir, 'storage')}/`,
  ];
}

export class LocalAppManager {
  private readonly apps = new Map<string, ManagedApp>();
  private readonly getApp;
  private readonly healthTimer: NodeJS.Timeout;

  constructor(
    private readonly options: {
      db: Database.Database;
      dataDir: string;
      childEntry: string;
      publicOrigin: string;
    },
  ) {
    this.getApp = options.db.prepare('SELECT * FROM mini_apps WHERE id = ?');
    this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  restore(): void {
    const rows = this.options.db
      .prepare("SELECT id FROM mini_apps WHERE runtime = 'local' AND status = 'deployed'")
      .all() as { id: string }[];
    for (const row of rows) {
      void this.deploy(row.id).catch((error: Error) => {
        console.error(`[local-apps] restore failed for ${row.id}: ${error.message}`);
      });
    }
  }

  async deploy(appId: string): Promise<void> {
    const app = this.readLocalApp(appId);
    await this.stop(appId);
    const state = this.newState(appId);
    this.apps.set(appId, state);
    try {
      await this.materialize(app);
      await this.spawn(state, app);
    } catch (error) {
      state.desired = false;
      if (state.restartTimer) clearTimeout(state.restartTimer);
      state.restartTimer = null;
      state.phase = 'error';
      state.error = (error as Error).message;
      throw error;
    }
  }

  async remove(appId: string): Promise<void> {
    await this.stop(appId);
    await fs.promises.rm(this.appDir(appId), { recursive: true, force: true });
    this.apps.delete(appId);
  }

  statuses(appIds: string[]): Record<string, LocalAppStatusView> {
    const result: Record<string, LocalAppStatusView> = {};
    for (const id of appIds) {
      const state = this.apps.get(id);
      result[id] = state
        ? { status: state.phase, error: state.error, pid: state.child?.pid ?? null }
        : { status: 'stopped', error: null, pid: null };
    }
    return result;
  }

  async proxy(appId: string, req: IncomingMessage, res: ServerResponse, targetPath: string): Promise<void> {
    const state = await this.ensureRunning(appId);
    if (!state.port) throw new Error('local app did not expose a port');
    proxyHttpRequest({
      req,
      res,
      port: state.port,
      path: targetPath,
      timeoutMs: 20_000,
      onTimeout: () => this.terminateForFailure(state, 'request timed out'),
    });
  }

  shutdown(): void {
    clearInterval(this.healthTimer);
    for (const state of this.apps.values()) {
      state.desired = false;
      if (state.restartTimer) clearTimeout(state.restartTimer);
      state.child?.kill('SIGTERM');
    }
  }

  private readLocalApp(appId: string): MiniAppRow {
    const app = this.getApp.get(appId) as MiniAppRow | undefined;
    if (!app) throw new Error('Mini app not found');
    if (app.runtime !== 'local') throw new Error('Mini app is not configured for the local runtime');
    return app;
  }

  private newState(id: string): ManagedApp {
    return {
      id,
      desired: true,
      phase: 'starting',
      child: null,
      port: null,
      error: null,
      restartCount: 0,
      restartTimer: null,
      readyPromise: null,
      startedAt: 0,
      healthFailures: 0,
      logWindowStartedAt: Date.now(),
      logBytes: 0,
    };
  }

  private appDir(appId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(appId)) throw new Error('Invalid mini app id');
    return path.join(this.options.dataDir, 'mini-apps', appId);
  }

  private appModulePath(appId: string): string {
    return path.join(this.appDir(appId), 'app.mjs');
  }

  private async materialize(app: MiniAppRow): Promise<void> {
    const directory = this.appDir(app.id);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    // The write grant is resolved when the child starts, so the storage
    // directory has to exist before the fork rather than on first write.
    await fs.promises.mkdir(path.join(directory, 'storage'), { recursive: true, mode: 0o700 });
    const target = this.appModulePath(app.id);
    const temporary = path.join(directory, `.app-${process.pid}-${crypto.randomUUID()}.mjs`);
    await fs.promises.writeFile(temporary, app.source_text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporary, target);
  }

  private async spawn(state: ManagedApp, app: MiniAppRow): Promise<void> {
    state.phase = state.restartCount > 0 ? 'restarting' : 'starting';
    state.error = null;
    state.port = null;
    const tenant = new URL(this.options.publicOrigin).hostname.split('.')[0] || 'veneer';
    const meta: LocalAppChildMeta = {
      appId: app.id,
      tenant,
      publicPath: `/tools/${app.slug}`,
      publicUrl: `${this.options.publicOrigin}/tools/${app.slug}/`,
      appsUrl: `${this.options.publicOrigin}/#/apps`,
    };
    const childEntry = fs.realpathSync(this.options.childEntry);
    const child = fork(childEntry, [this.appModulePath(app.id), JSON.stringify(meta)], {
      cwd: this.appDir(app.id),
      env: localAppEnvironment(),
      execArgv: localAppExecArgv(childEntry, this.appDir(app.id)),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    state.child = child;
    state.startedAt = Date.now();
    state.healthFailures = 0;
    if (child.pid) {
      try {
        os.setPriority(child.pid, 10);
      } catch {
        // Lowering priority is availability hygiene; unsupported hosts may skip it.
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => this.trackLogs(state, chunk.length));
    child.stderr?.on('data', (chunk: Buffer) => this.trackLogs(state, chunk.length));

    state.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('local app did not start within 10 seconds'));
      }, START_TIMEOUT_MS);
      timer.unref?.();

      child.on('message', (message: unknown) => {
        if (settled || !message || typeof message !== 'object') return;
        const frame = message as { type?: string; port?: number; error?: string };
        if (frame.type === 'ready' && Number.isInteger(frame.port)) {
          settled = true;
          clearTimeout(timer);
          state.port = frame.port!;
          state.phase = 'running';
          state.error = null;
          resolve();
        } else if (frame.type === 'error') {
          settled = true;
          clearTimeout(timer);
          reject(new Error(frame.error || 'local app failed to start'));
        }
      });
      child.once('exit', (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`local app exited during startup (${signal || code || 'unknown'})`));
        }
        this.handleExit(state, child, code, signal);
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
    await state.readyPromise;
  }

  private handleExit(
    state: ManagedApp,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (state.child !== child) return;
    state.child = null;
    state.port = null;
    state.readyPromise = null;
    if (!state.desired) {
      state.phase = 'stopped';
      return;
    }
    const healthyFor = Date.now() - state.startedAt;
    state.restartCount = healthyFor > 60_000 ? 1 : state.restartCount + 1;
    state.phase = 'restarting';
    state.error = `process exited (${signal || code || 'unknown'})`;
    this.scheduleRestart(state);
  }

  private scheduleRestart(state: ManagedApp): void {
    if (!state.desired || state.restartTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(state.restartCount - 1, 5));
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      void (async () => {
        try {
          const app = this.readLocalApp(state.id);
          if (app.status !== 'deployed') {
            state.desired = false;
            state.phase = 'stopped';
            return;
          }
          await this.materialize(app);
          await this.spawn(state, app);
        } catch (error) {
          state.phase = 'restarting';
          state.error = (error as Error).message;
          state.restartCount += 1;
          this.scheduleRestart(state);
        }
      })();
    }, delay);
    state.restartTimer.unref?.();
  }

  private async stop(appId: string): Promise<void> {
    const state = this.apps.get(appId);
    if (!state) return;
    state.desired = false;
    if (state.restartTimer) clearTimeout(state.restartTimer);
    state.restartTimer = null;
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      state.phase = 'stopped';
      return;
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      force.unref?.();
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
    state.phase = 'stopped';
  }

  private async ensureRunning(appId: string): Promise<ManagedApp> {
    let state = this.apps.get(appId);
    if (state?.phase === 'running' && state.port) return state;
    if (state?.readyPromise) {
      await state.readyPromise;
      if (state.port) return state;
    }
    if (state?.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (!state) {
      state = this.newState(appId);
      this.apps.set(appId, state);
    }
    state.desired = true;
    const app = this.readLocalApp(appId);
    if (app.status !== 'deployed') throw new Error('Mini app is not deployed');
    await this.materialize(app);
    await this.spawn(state, app);
    return state;
  }

  private trackLogs(state: ManagedApp, bytes: number): void {
    const now = Date.now();
    if (now - state.logWindowStartedAt >= LOG_RATE_WINDOW_MS) {
      state.logWindowStartedAt = now;
      state.logBytes = 0;
    }
    state.logBytes += bytes;
    if (state.logBytes > MAX_LOG_BYTES_PER_WINDOW) {
      this.terminateForFailure(state, 'log output exceeded 1MB in 10 seconds');
    }
  }

  private terminateForFailure(state: ManagedApp, reason: string): void {
    state.error = reason;
    state.child?.kill('SIGKILL');
  }

  private async checkHealth(): Promise<void> {
    await Promise.all(
      [...this.apps.values()].map(async (state) => {
        if (state.phase !== 'running' || !state.port) return;
        try {
          const response = await fetch(`http://127.0.0.1:${state.port}/__veneer_health`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (!response.ok) throw new Error(`health returned ${response.status}`);
          state.healthFailures = 0;
        } catch {
          state.healthFailures += 1;
          if (state.healthFailures >= 2) this.terminateForFailure(state, 'health check failed');
        }
      }),
    );
  }
}
