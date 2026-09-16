import type { ActivityRenderItem } from './activityRuns';

export type FrozenTranscriptSegment =
  | { kind: 'static'; key: string; items: ActivityRenderItem[] }
  | {
      kind: 'live-mermaid' | 'live-image';
      key: string;
      item: Extract<ActivityRenderItem, { kind: 'assistant' }>;
    };

const MERMAID_FENCE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*mermaid(?:[ \t]+.*)?$/im;

export function containsMermaidFence(markdown: string): boolean {
  return MERMAID_FENCE_RE.test(markdown);
}

function isInteractiveItem(
  item: ActivityRenderItem,
): item is Extract<ActivityRenderItem, { kind: 'assistant' }> {
  return item.kind === 'assistant' && (containsMermaidFence(item.markdown) || /!\[|<img\b/i.test(item.markdown));
}

/** Keep Mermaid and image messages mounted while preserving inert HTML segments for
 * every ordinary historical row before, between, and after them. */
export function segmentFrozenTranscript(
  items: ActivityRenderItem[],
): FrozenTranscriptSegment[] {
  const result: FrozenTranscriptSegment[] = [];
  let staticItems: ActivityRenderItem[] = [];
  let staticKey = 'frozen-static-start';

  const flushStatic = () => {
    if (!staticItems.length) return;
    result.push({ kind: 'static', key: staticKey, items: staticItems });
    staticItems = [];
  };

  for (const item of items) {
    if (!isInteractiveItem(item)) {
      staticItems.push(item);
      continue;
    }
    flushStatic();
    const type = containsMermaidFence(item.markdown) ? 'mermaid' : 'image';
    result.push({ kind: `live-${type}`, key: `frozen-${type}-${item.key}`, item });
    staticKey = `frozen-static-after-${item.key}`;
  }
  flushStatic();
  return result;
}
