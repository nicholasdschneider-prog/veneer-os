import os from 'node:os';
import { availableSystemMemoryBytes } from '../platform.js';

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface SystemUsage {
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  sampledAt: string;
}

interface SystemUsageSource {
  cpuTimes: () => CpuTimes;
  availableMemory?: (totalMemoryBytes: number) => number | null;
  freeMemory: () => number;
  totalMemory: () => number;
  now: () => number;
}

const nativeSource: SystemUsageSource = {
  cpuTimes: () =>
    os.cpus().reduce<CpuTimes>(
      (sum, cpu) => {
        const times = cpu.times;
        return {
          idle: sum.idle + times.idle,
          total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
        };
      },
      { idle: 0, total: 0 },
    ),
  availableMemory: (totalMemoryBytes) =>
    availableSystemMemoryBytes(totalMemoryBytes, os.freemem()),
  freeMemory: () => os.freemem(),
  totalMemory: () => os.totalmem(),
  now: () => Date.now(),
};

export function cpuUsagePercent(previous: CpuTimes, current: CpuTimes): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  const percent = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}

/**
 * Host-level CPU and memory sampler. Results are cached briefly so several
 * open tabs share one CPU delta instead of producing noisy near-zero samples.
 */
export function createSystemUsageReader(
  source: SystemUsageSource = nativeSource,
  minimumSampleIntervalMs = 2_000,
): () => SystemUsage {
  let previousCpu = source.cpuTimes();
  let lastSampleAt = 0;
  let cached: SystemUsage | null = null;

  return () => {
    const now = source.now();
    if (cached && now - lastSampleAt < minimumSampleIntervalMs) return cached;

    const currentCpu = source.cpuTimes();
    const memoryTotalBytes = Math.max(0, source.totalMemory());
    let memoryAvailableBytes: number | null = null;
    try {
      memoryAvailableBytes = source.availableMemory?.(memoryTotalBytes) ?? null;
    } catch {
      // The platform-specific reader is optional. Keep os.freemem() as a safe fallback.
    }
    const memoryFreeBytes = Math.min(
      memoryTotalBytes,
      Math.max(0, memoryAvailableBytes ?? source.freeMemory()),
    );
    cached = {
      cpuPercent: cpuUsagePercent(previousCpu, currentCpu),
      memoryUsedBytes: memoryTotalBytes - memoryFreeBytes,
      memoryTotalBytes,
      sampledAt: new Date(now).toISOString(),
    };
    previousCpu = currentCpu;
    lastSampleAt = now;
    return cached;
  };
}
