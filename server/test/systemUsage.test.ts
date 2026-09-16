import { describe, expect, it } from 'vitest';
import {
  cpuUsagePercent,
  createSystemUsageReader,
  type CpuTimes,
} from '../src/routes/systemUsage.js';

const GIBIBYTE = 1024 ** 3;

function source(overrides: {
  availableMemory?: (totalMemoryBytes: number) => number | null;
  freeMemory?: () => number;
  totalMemory?: () => number;
} = {}) {
  return {
    cpuTimes: () => ({ idle: 50, total: 100 }),
    freeMemory: overrides.freeMemory ?? (() => 10 * GIBIBYTE),
    totalMemory: overrides.totalMemory ?? (() => 16 * GIBIBYTE),
    now: () => 1_000,
    ...(overrides.availableMemory ? { availableMemory: overrides.availableMemory } : {}),
  };
}

describe('system usage sampler', () => {
  it('calculates CPU utilization from cumulative time deltas', () => {
    expect(cpuUsagePercent({ idle: 50, total: 100 }, { idle: 70, total: 200 })).toBe(80);
    expect(cpuUsagePercent({ idle: 50, total: 100 }, { idle: 50, total: 100 })).toBeNull();
  });

  it('reports bounded memory usage and caches rapid samples', () => {
    const cpuSamples: CpuTimes[] = [
      { idle: 50, total: 100 },
      { idle: 70, total: 200 },
      { idle: 80, total: 300 },
    ];
    let cpuIndex = 0;
    let now = 1_000;
    const read = createSystemUsageReader(
      {
        cpuTimes: () => cpuSamples[cpuIndex++]!,
        totalMemory: () => 16 * GIBIBYTE,
        freeMemory: () => 10 * GIBIBYTE,
        now: () => now,
      },
      2_000,
    );

    const first = read();
    expect(first).toMatchObject({
      cpuPercent: 80,
      memoryUsedBytes: 6 * GIBIBYTE,
      memoryTotalBytes: 16 * GIBIBYTE,
    });
    expect(read()).toBe(first);

    now += 2_000;
    expect(read()).not.toBe(first);
    expect(cpuIndex).toBe(3);
  });

  it('uses platform available memory instead of completely free memory', () => {
    const read = createSystemUsageReader(source({
      availableMemory: () => 11 * GIBIBYTE,
      freeMemory: () => 1 * GIBIBYTE,
    }));

    expect(read().memoryUsedBytes).toBe(5 * GIBIBYTE);
  });

  it('falls back to free memory when the platform reader fails', () => {
    const readNull = createSystemUsageReader(source({
      availableMemory: () => null,
      freeMemory: () => 4 * GIBIBYTE,
    }));
    const readError = createSystemUsageReader(source({
      availableMemory: () => {
        throw new Error('memory_pressure failed');
      },
      freeMemory: () => 4 * GIBIBYTE,
    }));

    expect(readNull().memoryUsedBytes).toBe(12 * GIBIBYTE);
    expect(readError().memoryUsedBytes).toBe(12 * GIBIBYTE);
  });

  it('bounds platform available memory to the total-memory range', () => {
    const aboveTotal = createSystemUsageReader(source({
      availableMemory: () => 20 * GIBIBYTE,
    }));
    const belowZero = createSystemUsageReader(source({
      availableMemory: () => -1,
    }));

    expect(aboveTotal().memoryUsedBytes).toBe(0);
    expect(belowZero().memoryUsedBytes).toBe(16 * GIBIBYTE);
  });
});
