export interface ResponseTokenUsage {
  totalTokens: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /** Cache reads for the turn, a subset of totalInputTokens. */
  cachedInputTokens?: number;
  /** Cache writes for the turn, a subset of totalInputTokens. Claude only. */
  cacheWriteInputTokens?: number;
}

export interface ResponseTokenRow {
  key: 'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'total';
  label: string;
  value: number;
}

export function normalizeResponseTokenUsage(value: unknown): ResponseTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as {
    totalTokens?: unknown;
    totalInputTokens?: unknown;
    totalOutputTokens?: unknown;
    cachedInputTokens?: unknown;
    cacheWriteInputTokens?: unknown;
  };
  if (
    typeof usage.totalTokens !== 'number'
    || !Number.isSafeInteger(usage.totalTokens)
    || usage.totalTokens <= 0
  ) return undefined;
  const hasBreakdown =
    typeof usage.totalInputTokens === 'number'
    && Number.isSafeInteger(usage.totalInputTokens)
    && usage.totalInputTokens >= 0
    && typeof usage.totalOutputTokens === 'number'
    && Number.isSafeInteger(usage.totalOutputTokens)
    && usage.totalOutputTokens >= 0
    && usage.totalInputTokens + usage.totalOutputTokens === usage.totalTokens;
  // Cache figures only mean anything alongside a trustworthy input total, and
  // they are subsets of it, so reads plus writes may never exceed it.
  const cachedInputTokens = cacheSubset(usage.cachedInputTokens);
  const cacheWriteInputTokens = cacheSubset(usage.cacheWriteInputTokens);
  const hasCacheDetail =
    hasBreakdown
    && (cachedInputTokens !== undefined || cacheWriteInputTokens !== undefined)
    && (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) <= (usage.totalInputTokens as number);
  return {
    totalTokens: usage.totalTokens,
    ...(hasBreakdown
      ? {
          totalInputTokens: usage.totalInputTokens as number,
          totalOutputTokens: usage.totalOutputTokens as number,
        }
      : {}),
    ...(hasCacheDetail && cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(hasCacheDetail && cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };
}

function cacheSubset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Rows for the token breakdown card. Providers that report no cache split get
 * input/output/total only; "Input" is always the uncached remainder.
 */
export function responseTokenRows(usage: ResponseTokenUsage): ResponseTokenRow[] {
  if (usage.totalInputTokens === undefined || usage.totalOutputTokens === undefined) {
    return [{ key: 'total', label: 'Total', value: usage.totalTokens }];
  }
  const cacheRead = usage.cachedInputTokens;
  const cacheWrite = usage.cacheWriteInputTokens;
  const rows: ResponseTokenRow[] = [
    {
      key: 'input',
      label: 'Input',
      value: usage.totalInputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0),
    },
  ];
  if (cacheRead !== undefined) rows.push({ key: 'cacheRead', label: 'Cache read', value: cacheRead });
  if (cacheWrite !== undefined) rows.push({ key: 'cacheWrite', label: 'Cache write', value: cacheWrite });
  rows.push({ key: 'output', label: 'Output', value: usage.totalOutputTokens });
  rows.push({ key: 'total', label: 'Total', value: usage.totalTokens });
  return rows;
}

export function formatResponseTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatResponseDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatResponseTokenCount(usage: ResponseTokenUsage): string {
  const total = usage.totalTokens;
  if (total < 1_000) return total.toLocaleString();
  if (total < 999_500) {
    return `${Number((total / 1_000).toFixed(1))}k`;
  }
  return `${Number((total / 1_000_000).toFixed(1))}M`;
}

export function responseTokenBreakdown(usage: ResponseTokenUsage): string {
  if (usage.totalInputTokens === undefined || usage.totalOutputTokens === undefined) {
    return `${usage.totalTokens.toLocaleString()} tokens used this turn`;
  }
  return `${usage.totalInputTokens.toLocaleString()} input + ${usage.totalOutputTokens.toLocaleString()} output tokens this turn`;
}
