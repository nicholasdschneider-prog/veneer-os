import { execFile } from 'node:child_process';
import type { ProviderAdapter } from '../providers/types.js';

/** ps output contains numeric IDs only, never arguments or environment secrets. */
export function descendantCounts(output: string, roots: number[]): Map<number, number> {
  const children = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [pid, parent] = [Number(match[1]), Number(match[2])];
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  return new Map(roots.map((root) => {
    const seen = new Set<number>([root]);
    const queue = [...(children.get(root) ?? [])];
    for (let i = 0; i < queue.length; i += 1) {
      const pid = queue[i]!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return [root, seen.size - 1];
  }));
}

/** Observe buildup; never kill bots or restart a shared server to meet a limit. */
export function startResourceMonitor(
  adapters: Record<string, ProviderAdapter>,
  log: Pick<Console, 'warn' | 'info'> = console,
): () => void {
  let stopped = false;
  let checking = false;
  let samples = 0;
  let lastWarningSample = -10;
  let wasOverLimit = false;
  const check = () => {
    if (stopped || checking) return;
    const resources = Object.values(adapters).flatMap((adapter) =>
      (adapter.runtimeResources?.() ?? []).map((entry) => ({ provider: adapter.id, ...entry })),
    );
    if (!resources.some((entry) => entry.pid !== null)) return;
    checking = true;
    execFile('ps', ['-axo', 'pid=,ppid='], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      checking = false;
      if (stopped) return;
      if (err) {
        log.warn('[provider-resources] Unable to sample child process counts');
        return;
      }
      const counts = descendantCounts(stdout, resources.flatMap((entry) => entry.pid === null ? [] : [entry.pid]));
      samples += 1;
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      const overLimit = total >= 300 || [...counts.values()].some((count) => count >= 100);
      const warnNow = overLimit && (!wasOverLimit || samples - lastWarningSample >= 10);
      if (warnNow) {
        lastWarningSample = samples;
        log.warn(`[provider-resources] WARNING: ${total} provider descendants; inspect idle subscriptions before restarting active work`);
      }
      wasOverLimit = overLimit;
      for (const entry of resources) {
        if (entry.pid === null) continue;
        const children = counts.get(entry.pid) ?? 0;
        const summary = `[provider-resources] provider=${entry.provider} pid=${entry.pid} descendants=${children} heldThreads=${entry.heldThreads} pinnedThreads=${entry.pinnedThreads}`;
        if (warnNow) log.warn(summary);
        else if (samples % 5 === 1) log.info(summary);
      }
    });
  };
  const timer = setInterval(check, 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
