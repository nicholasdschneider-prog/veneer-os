import { describe, expect, it } from 'vitest';
import type { ActivityRenderItem } from './activityRuns';
import { containsMermaidFence, segmentFrozenTranscript } from './transcriptFreeze';

function assistant(key: string, markdown: string): ActivityRenderItem {
  return { kind: 'assistant', key, markdown };
}

function user(key: string): ActivityRenderItem {
  return { kind: 'user', key, text: key };
}

describe('selective transcript freezing', () => {
  it('keeps historical images mounted so late file metadata and load errors can update them', () => {
    const segments = segmentFrozenTranscript([
      assistant('before', 'Ordinary text'),
      assistant('image', '![Outline](/tmp/outline.png)'),
      assistant('reference', '![Outline][plot]\n\n[plot]: /tmp/outline.png'),
      assistant('html', '<img src="/tmp/outline.png" alt="Outline">'),
      assistant('after', 'Ordinary text'),
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(['static', 'live-image', 'live-image', 'live-image', 'static']);
  });

  it('recognizes fenced Mermaid blocks without treating ordinary code as Mermaid', () => {
    expect(containsMermaidFence('```mermaid\nflowchart LR\nA --> B\n```')).toBe(true);
    expect(containsMermaidFence('  ~~~MERMAID title="Flow"\nflowchart LR\nA --> B\n~~~')).toBe(true);
    expect(containsMermaidFence('```typescript\nconst language = "mermaid";\n```')).toBe(false);
    expect(containsMermaidFence('Use `mermaid` for diagrams.')).toBe(false);
  });

  it('keeps only the Mermaid row live and freezes rows on both sides', () => {
    const segments = segmentFrozenTranscript([
      user('before-user'),
      assistant('before-assistant', 'Ordinary Markdown'),
      assistant('diagram', '```mermaid\nflowchart LR\nA --> B\n```'),
      user('after-user'),
      assistant('after-assistant', 'Still ordinary'),
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual([
      'static',
      'live-mermaid',
      'static',
    ]);
    expect(segments[0]).toMatchObject({
      key: 'frozen-static-start',
      items: [{ key: 'before-user' }, { key: 'before-assistant' }],
    });
    expect(segments[1]).toMatchObject({
      key: 'frozen-mermaid-diagram',
      item: { key: 'diagram' },
    });
    expect(segments[2]).toMatchObject({
      key: 'frozen-static-after-diagram',
      items: [{ key: 'after-user' }, { key: 'after-assistant' }],
    });
  });

  it('keeps an ordinary transcript on one frozen static fast path', () => {
    const segments = segmentFrozenTranscript([
      user('one'),
      assistant('two', 'No diagrams here.'),
      user('three'),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: 'static',
      key: 'frozen-static-start',
      items: [{ key: 'one' }, { key: 'two' }, { key: 'three' }],
    });
  });

  it('supports multiple and adjacent Mermaid rows without empty static segments', () => {
    const segments = segmentFrozenTranscript([
      assistant('first', '```mermaid\nflowchart LR\nA --> B\n```'),
      user('between'),
      assistant('second', '~~~mermaid\nsequenceDiagram\nA->>B: Hello\n~~~'),
      assistant('third', '```mermaid\ngraph TD\nC --> D\n```'),
      user('after'),
    ]);

    expect(segments.map((segment) => [segment.kind, segment.key])).toEqual([
      ['live-mermaid', 'frozen-mermaid-first'],
      ['static', 'frozen-static-after-first'],
      ['live-mermaid', 'frozen-mermaid-second'],
      ['live-mermaid', 'frozen-mermaid-third'],
      ['static', 'frozen-static-after-third'],
    ]);
  });

  it('keeps the trailing static segment identity stable when history appends', () => {
    const initial = segmentFrozenTranscript([
      assistant('diagram', '```mermaid\nflowchart LR\nA --> B\n```'),
      user('after-one'),
    ]);
    const appended = segmentFrozenTranscript([
      assistant('diagram', '```mermaid\nflowchart LR\nA --> B\n```'),
      user('after-one'),
      assistant('after-two', 'Appended later'),
    ]);

    expect(initial[1]?.key).toBe('frozen-static-after-diagram');
    expect(appended[1]?.key).toBe(initial[1]?.key);
  });
});
