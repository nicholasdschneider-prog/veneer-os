import type { ChatItem, TranscriptState } from './transcript';

export type ToolChatItem = Extract<ChatItem, { kind: 'tool' }>;
export type SubagentChatItem = Extract<ChatItem, { kind: 'subagent' }>;
type TranscriptItem = TranscriptState['items'][number];

export type ActivityRenderItem =
  | Exclude<TranscriptItem, ToolChatItem | SubagentChatItem>
  | { kind: 'tool-group'; key: string; tools: ToolChatItem[] }
  | { kind: 'connection-tool'; key: string; tool: ToolChatItem }
  | { kind: 'subagent-group'; key: string; agents: SubagentChatItem[] };

/** Keep ordinary provider activity compact while promoting every Connection
 * action to its own timeline row. A connector also splits the ordinary runs
 * on either side, so it can never be hidden by their disclosure. */
export function groupActivityRuns(items: TranscriptState['items']): ActivityRenderItem[] {
  const result: ActivityRenderItem[] = [];
  let toolRun: ToolChatItem[] = [];
  let subagentRun: SubagentChatItem[] = [];

  const flushTools = () => {
    const [first] = toolRun;
    if (!first) return;
    result.push({ kind: 'tool-group', key: `group-${first.key}`, tools: toolRun });
    toolRun = [];
  };
  const flushSubagents = () => {
    const [first] = subagentRun;
    if (!first) return;
    result.push({ kind: 'subagent-group', key: `group-${first.key}`, agents: subagentRun });
    subagentRun = [];
  };

  for (const item of items) {
    if (item.kind === 'tool') {
      flushSubagents();
      if (item.source) {
        flushTools();
        result.push({ kind: 'connection-tool', key: `connection-${item.key}`, tool: item });
      } else {
        toolRun.push(item);
      }
    } else if (item.kind === 'subagent') {
      flushTools();
      if (subagentRun.length && subagentRun[0]!.turnId !== item.turnId) flushSubagents();
      subagentRun.push(item);
    } else {
      flushTools();
      flushSubagents();
      result.push(item);
    }
  }
  flushTools();
  flushSubagents();
  return result;
}
