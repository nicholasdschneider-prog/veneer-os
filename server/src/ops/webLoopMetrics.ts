import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Pure bounded telemetry; no middleware, request bodies or business gates. */
export function startWebLoopMetrics(dataDir: string) {
  const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
  const dir = path.join(dataDir, 'ops'), file = path.join(dir, 'web-event-loop.json');
  const temporary = `${file}.${process.pid}.tmp`;
  let busy = false, stopped = false;
  const publish = async () => {
    if (busy || stopped) return;
    busy = true;
    const value = { pid: process.pid, at: Date.now(), delayMs: Number((histogram.percentile(99) / 1e6).toFixed(1)) };
    histogram.reset();
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      if (!stopped) await fs.rename(temporary, file);
      else await fs.rm(temporary, { force: true });
    } catch { /* Health latency and independent CPU observation remain available. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => void publish(), 30000); timer.unref();
  return () => { stopped = true; clearInterval(timer); histogram.disable(); };
}
