import { describe, expect, it } from 'vitest';
import { groupActivityRuns, type ToolChatItem } from './activityRuns';
import type { ChatItem } from './transcript';

function tool(key: string, connector = false): ToolChatItem {
  return {
    kind: 'tool',
    key,
    label: connector ? 'Using Gmail' : 'Using Bash',
    actionLabel: connector ? 'Forward Message' : 'Using Bash',
    toolName: connector ? 'mcp__gmail__GMAIL_FORWARD_MESSAGE' : 'Bash',
    ...(connector ? {
      source: {
        kind: 'connector' as const,
        slug: 'gmail',
        name: 'Gmail',
        mention: 'gmail',
        action: 'Forward Message',
      },
    } : {}),
    inputPreview: '',
    resultPreview: '',
    images: [],
    running: false,
    ok: true,
  };
}

describe('chat activity grouping', () => {
  it('surfaces each connector action between otherwise unchanged tool groups', () => {
    const items: ChatItem[] = [tool('bash-1'), tool('gmail', true), tool('bash-2'), tool('bash-3')];
    const grouped = groupActivityRuns(items);

    expect(grouped.map((item) => item.kind)).toEqual(['tool-group', 'connection-tool', 'tool-group']);
    expect(grouped[0]).toMatchObject({ kind: 'tool-group', tools: [{ key: 'bash-1' }] });
    expect(grouped[1]).toMatchObject({ kind: 'connection-tool', tool: { key: 'gmail' } });
    expect(grouped[2]).toMatchObject({ kind: 'tool-group', tools: [{ key: 'bash-2' }, { key: 'bash-3' }] });
  });

  it('never combines consecutive connector actions', () => {
    const grouped = groupActivityRuns([tool('gmail-1', true), tool('gmail-2', true)]);
    expect(grouped.map((item) => item.kind)).toEqual(['connection-tool', 'connection-tool']);
  });
});
