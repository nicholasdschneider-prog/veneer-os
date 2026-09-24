import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson } from '../../lib/api';
import { mergeThreadReplies, type ReplyAnchor, type ThreadReply } from '../../lib/threadReplies';
import { Markdown } from '../Markdown';

type Page = { replies: ThreadReply[]; hasMore: boolean };
export function useThreadReplies(conversationId: string) {
  const [replies, setReplies] = useState<ThreadReply[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const records = useRef<ThreadReply[]>([]);
  const initialized = useRef(false);
  const loading = useRef(false);
  const epoch = useRef(0);
  const refresh = useCallback(async (older = false) => {
    if (!conversationId || loading.current) return;
    loading.current = true;
    const generation = epoch.current;
    setBusy(true);
    try {
      const first = !initialized.current;
      let cursor = older ? records.current[0]?.seq : first ? undefined : (records.current.at(-1)?.seq ?? 0);
      let more = true;
      while (more) {
        const query = cursor === undefined ? '' : `?${older ? 'before' : 'after'}=${cursor}`;
        const page = await requestJson<Page>(`/api/bot-communication/chats/${encodeURIComponent(conversationId)}/replies${query}`);
        if (generation !== epoch.current) return;
        records.current = mergeThreadReplies(records.current, page.replies);
        setReplies(current => mergeThreadReplies(current, records.current));
        initialized.current = true;
        if (first || older) setHasOlder(page.hasMore);
        // Catch up every newer page, so bursts of replies cannot be skipped.
        more = !first && !older && page.hasMore;
        cursor = records.current.at(-1)?.seq;
      }
      setError('');
    } catch (e) {
      if (generation === epoch.current) setError(e instanceof Error ? e.message : 'Could not load replies');
    } finally {
      if (generation === epoch.current) { loading.current = false; setBusy(false); }
    }
  }, [conversationId]);
  useEffect(() => {
    epoch.current++;
    records.current = []; initialized.current = false; loading.current = false;
    setReplies([]); setHasOlder(false); setError('');
    const poll = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    void refresh();
    const timer = window.setInterval(poll, 4000);
    window.addEventListener('result-replies-changed', poll);
    document.addEventListener('visibilitychange', poll);
    return () => {
      epoch.current++;
      clearInterval(timer);
      window.removeEventListener('result-replies-changed', poll);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refresh]);
  const accept = useCallback((thread: {messages: (Omit<ThreadReply, 'anchor'|'source_text'|'bot_name'|'unread'> & {request_key:string})[]; anchor: string; source_text: string}) => {
    // Immediate readback makes the sent reply visible even during a poll.
    const incoming = thread.messages.map(r => ({...r, anchor: thread.anchor, source_text: thread.source_text, bot_name: 'Bot', unread: 0}));
    // Do not advance the feed cursor here: another thread may have replies in
    // between the last poll and this send. The next poll merges by stable id.
    setReplies(current => mergeThreadReplies(current, incoming));
    window.dispatchEvent(new Event('result-replies-changed'));
  }, []);
  return {replies, hasOlder, error, busy, refresh, accept};
}

export function ThreadReplyRow({reply, canReply, onReply, onOriginal}: {
  reply: ThreadReply; canReply: boolean;
  onReply: (anchor: ReplyAnchor, threadId: string) => void;
  onOriginal: (anchor: ReplyAnchor) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(!reply.unread);
  const bot = !!reply.actor_conversation_id;
  useEffect(() => {
    if (seen || !ref.current) return;
    let busy = false;
    let visible = false;
    const markSeen = () => {
      if (!visible || document.visibilityState === 'hidden' || busy) return;
      busy = true;
      void requestJson(`/api/bot-communication/threads/${reply.thread_id}/seen`, {
        method: 'POST', body: JSON.stringify({seq: reply.seq}),
      }).then(() => { setSeen(true); window.dispatchEvent(new Event('result-reactions-changed')); })
        .catch(() => { busy = false; });
    };
    const observer = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); markSeen(); }, {threshold: 0.1});
    observer.observe(ref.current);
    document.addEventListener('visibilitychange', markSeen);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', markSeen); };
  }, [reply.thread_id, reply.seq, seen]);
  const anchor = JSON.parse(reply.anchor) as ReplyAnchor;
  return <article ref={ref} data-reply-id={reply.id} className={`flex min-w-0 flex-col gap-1 ${bot ? 'items-start' : 'items-end'}`}>
    <div className="w-fit min-w-0 max-w-[94%]">
      <details className="mb-1 text-sm text-muted-foreground">
        <summary className="cursor-pointer truncate rounded-lg px-2 py-2 focus-visible:outline-2 focus-visible:outline-ring" title="Show original message">↩ {reply.source_text.replace(/\s+/g, ' ').slice(0,180)}</summary>
        <div className="mb-2 max-h-64 overflow-auto rounded-lg border-l-2 border-brand bg-muted/30 p-3">
          <p className="whitespace-pre-wrap wrap-break-word">{reply.source_text}</p>
          <button type="button" onClick={() => onOriginal(anchor)} className="mt-2 min-h-11 underline">Go to original message</button>
        </div>
      </details>
      <div className={`rounded-2xl px-4 py-3 ${bot ? 'bg-muted' : 'bg-accent'}`} data-message-quote={bot ? 'assistant' : 'user'}>
        {bot ? <Markdown markdown={reply.text} /> : <p className="whitespace-pre-wrap wrap-break-word">{reply.text}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground">
        <span>{bot ? reply.bot_name : reply.actor_name}</span>
        <time dateTime={reply.created_at.replace(' ', 'T')+'Z'}>{new Date(reply.created_at.replace(' ', 'T')+'Z').toLocaleString()}</time>
        {!seen && <span className="font-medium text-foreground">New reply</span>}
        {canReply && <button type="button" className="min-h-11 rounded-full px-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onReply(anchor, reply.thread_id)}>Reply</button>}
      </div>
    </div>
  </article>;
}
