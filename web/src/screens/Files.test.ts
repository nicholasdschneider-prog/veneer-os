import { describe, expect, it } from 'vitest';
import type { GeneratedFile } from '../lib/api';
import { buildVirtualFileRows, visibleVirtualFileRange } from './Files';

function file(index: number): GeneratedFile {
  return {
    id: `file-${index}`,
    name: `file-${index}.txt`,
    path: `/tmp/file-${index}.txt`,
    source: 'write',
    size: index,
    mtime: index,
    conversationId: null,
    conversationTitle: null,
    projectId: null,
    projectName: null,
    firstSeenAt: new Date(index).toISOString(),
  };
}

describe('Files virtual list', () => {
  it('keeps a large registry bounded to the visible window plus overscan', () => {
    const items = Array.from({ length: 1_000 }, (_, index) => file(index));
    const layout = buildVirtualFileRows([{ label: 'Older', items }]);
    const range = visibleVirtualFileRange(layout.rows, 24_000, 844);

    expect(layout.rows).toHaveLength(1_001);
    expect(range.end - range.start).toBeLessThan(32);
    expect(layout.height).toBeGreaterThan(68_000);
  });

  it('keeps recency headings in the same virtual layout as their files', () => {
    const layout = buildVirtualFileRows([
      { label: 'Today', items: [file(1)] },
      { label: 'Older', items: [file(2)] },
    ]);

    expect(layout.rows.map((row) => row.kind === 'heading' ? row.label : row.file.id)).toEqual([
      'Today',
      'file-1',
      'Older',
      'file-2',
    ]);
    expect(layout.rows[2]!.top).toBe(layout.rows[1]!.top + layout.rows[1]!.height);
  });
});
