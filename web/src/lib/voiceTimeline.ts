import { replyTime, type ThreadReply } from './threadReplies';
import type { ChatItem } from './transcript';
import { groupActivityRuns, type ActivityRenderItem } from './activityRuns';
import { segmentFrozenTranscript, type FrozenTranscriptSegment } from './transcriptFreeze';
export type VoiceSession = { id: string; started_ms: number; connected_ms: number | null; duration_ms: number; outcome: string };
export type VoiceTimelineEntry = FrozenTranscriptSegment | { kind: 'live'; key: string; item: ActivityRenderItem } | { kind: 'voice'; key: string; session: VoiceSession } | { kind: 'reply'; key: string; reply: ThreadReply };
export function mergeVoiceSessions(current: VoiceSession[], incoming: VoiceSession[]) {
  const records = new Map(current.map(s => [s.id, s]));
  for (const s of incoming) records.set(s.id, s);
  return [...records.values()].sort((a, b) => b.started_ms - a.started_ms || b.id.localeCompare(a.id));
}
function messageTime(item: ChatItem) {
  const value = 'at' in item && typeof item.at === 'string' ? Date.parse(item.at) : NaN;
  return Number.isFinite(value) ? value : null;
}
/** Insert calls at the first later/equal recorded message timestamp. Never sort
 * transcript rows or assign invented times to tool/status/legacy rows. */
export function voiceTimeline(items: ChatItem[], frozenLength: number, sessions: VoiceSession[], replies: ThreadReply[] = []) {
  const entries: VoiceTimelineEntry[] = [];
  const dated = [
    ...mergeVoiceSessions([], sessions).map(session => ({time:session.started_ms, entry:{kind:'voice' as const,key:`voice-${session.id}`,session}})),
    ...replies.map(reply => ({time:replyTime(reply), entry:{kind:'reply' as const,key:`reply-${reply.id}`,reply}})),
  ].sort((a,b)=>a.time-b.time || (a.entry.kind==='reply' && b.entry.kind==='reply' ? a.entry.reply.seq-b.entry.reply.seq : a.entry.key.localeCompare(b.entry.key)));
  const hasMessageTimes = items.some(i => messageTime(i) !== null);
  let call = 0, start = 0;
  function flush(end: number) {
    if (end <= start) return;
    const grouped = groupActivityRuns(items.slice(start, end));
    if (start < frozenLength) {
      for (const segment of segmentFrozenTranscript(grouped)) {
        if(segment.kind!=='static'){entries.push(segment);continue;}
        let chunk:typeof segment.items=[];
        const push=()=>{if(chunk.length)entries.push({kind:'static',key:`frozen-static-${chunk[0]!.key}`,items:chunk});chunk=[];};
        for(const item of segment.items){if(item.kind==='user'&&chunk.length)push();chunk.push(item);}
        push();
      }
    } else for (const item of grouped) entries.push({ kind: 'live', key: item.key, item });
    start = end;
  }
  function voice() {
    entries.push(dated[call++]!.entry);
  }
  // Explicitly separate dated calls from legacy transcripts without usable times.
  if (!hasMessageTimes) while (call < dated.length) voice();
  for (let i = 0; i < items.length; i++) {
    if (i === frozenLength) flush(i);
    const time = messageTime(items[i]!);
    if (time !== null && call < dated.length && dated[call]!.time <= time) {
      flush(i);
      while (call < dated.length && dated[call]!.time <= time) voice();
    }
  }
  flush(items.length);
  while (call < dated.length) voice();
  return { entries, hasMessageTimes };
}
