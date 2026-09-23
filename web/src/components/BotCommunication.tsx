import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { requestJson } from '../lib/api';
const root = '/api/bot-communication';
const post = <T,>(path: string, body: unknown) =>
  requestJson<T>(root + path, { method: 'POST', body: JSON.stringify(body) });
type Briefing = {
  id: string;
  transcript: string;
  decision_id: string | null;
  decision_version: number | null;
};
type Payload = {
  channel: string;
  account: string;
  recipients: string[];
  subject: string;
  body: string;
  attachments: { name: string; reference: string }[];
  customer: string;
  ticket: string;
  context: string;
};
type Draft = {
  id: string;
  version: number;
  decision_id: string | null;
  decision_version: number | null;
  payload: Payload;
  state: string;
  stale: boolean;
  cs_lifecycle?: {state:string;label:string;reason:string;owner_conversation_id:string;technical_owner:string;decision_id:string|null} | null;
  receipt: string | null;
  authorization_basis?: 'standing_policy' | 'human_draft' | 'approved_message_delegation';
  retirement?: {reason:string;evidence:string;created_at:string} | null;
};
export function VoiceBriefing({
  decisionId,
  version,
  briefing,
}: {
  decisionId?: string;
  version?: number;
  briefing?: Briefing;
}) {
  const [ready, setReady] = useState<{ id: string; transcript: string } | null>(
      briefing ?? null,
    ),
    [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    epoch.current++;
    audio.current?.pause();
    setReady(briefing ?? null);
    setUrl('');
    setError('');
    setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [decisionId, version, briefing?.id]);
  async function prepare() {
    const current = epoch.current;
    setBusy(true);
    setError('');
    try {
      const b =
        ready ??
        (await post<{ id: string; transcript: string }>(
          `/decisions/${decisionId}/briefing`,
          { expected_version: version },
        ));
      if (current !== epoch.current) return;
      setReady(b);
      const result = await post<{ url: string }>(
        `/briefings/${b.id}/audio`,
        {},
      );
      if (current === epoch.current) setUrl(result.url);
    } catch (e) {
      if (current === epoch.current)
        setError(e instanceof Error ? e.message : 'Unable to prepare audio');
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Voice briefing"
      className="my-3 flex flex-wrap items-center gap-2 rounded-2xl bg-muted/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Briefing</span>
        <span className="text-xs text-muted-foreground">
          AI voice
        </span>
      </div>
      {!url ? (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={() => void prepare()}
        >
          {busy ? 'Preparing briefing…' : 'Play briefing'}
        </Button>
      ) : (
        <audio
          ref={audio}
          controls
          preload="metadata"
          src={url}
          className="h-11 w-full max-w-full"
          onError={() =>
            setError('Audio could not play. Refresh if this proposal changed.')
          }
          aria-label="Play contextual briefing"
        />
      )}
      {ready && (
        <details className="basis-full text-sm">
          <summary className="min-h-9 cursor-pointer py-2">
            Read briefing transcript
          </summary>
          <p className="whitespace-pre-wrap leading-relaxed">
            {ready.transcript}
          </p>
        </details>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
export function DraftCard({ draft, refresh }: { draft: Draft; refresh: () => void }) {
  const [p, setP] = useState(draft.payload),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(false),
    [routineStatus, setRoutineStatus] = useState('');
  const dirty = JSON.stringify(p) !== JSON.stringify(draft.payload);
  const editable = draft.state === 'draft' && !draft.stale && !draft.cs_lifecycle;
  async function act(action: string) {
    setBusy(true);
    setError('');
    try {
      await post(`/drafts/${draft.id}`, {
        expected_version: draft.version,
        action,
        ...(action === 'save' ? { payload: p } : {}),
      });
      setConfirm(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update draft');
    } finally {
      setBusy(false);
    }
  }
  const input =
    'mt-1 min-h-10 w-full rounded-md border bg-background px-2 py-2 text-base';
  return (
    <article
      className="space-y-3 rounded-xl border p-4"
      aria-label="Outgoing message draft"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-semibold">Message to {p.customer}</h3>
        <span className="text-sm capitalize">
          {draft.cs_lifecycle ? draft.cs_lifecycle.label : draft.stale && draft.state === 'draft'
            ? 'Proposal changed'
            : draft.retirement ? 'Retired · not sent by this draft'
            : draft.state === 'sent'
              ? 'Sent · receipt recorded'
              : draft.state === 'queued'
                ? 'Queued for sending'
                : draft.state === 'sending'
                  ? 'Sending · awaiting receipt'
                  : draft.state}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {p.channel} · {p.account} · Ticket {p.ticket}
      </p>
      {draft.cs_lifecycle && <div role="status" className="space-y-2 rounded-lg border p-3 text-sm">
        <p>{draft.cs_lifecycle.reason}</p>
        <p className="text-xs text-muted-foreground">Follow-through: owning bot · Technical repair: {draft.cs_lifecycle.technical_owner}</p>
        <a className="underline" href={draft.cs_lifecycle.decision_id ? `#/bots/${encodeURIComponent(draft.cs_lifecycle.decision_id)}` : '#/bots?view=work'}>Open central work overview</a>
      </div>}
      {p.context && <p className="text-sm">{p.context}</p>}
      <label className="block text-sm">
        Recipients
        <input
          className={input}
          disabled={!editable || busy}
          value={p.recipients.join(', ')}
          onChange={(e) => {
            setConfirm(false);
            setP({
              ...p,
              recipients: e.target.value.split(',').map((v) => v.trim()),
            });
          }}
        />
      </label>
      {p.channel === 'email' && (
        <label className="block text-sm">
          Subject
          <input
            className={input}
            disabled={!editable || busy}
            value={p.subject}
            onChange={(e) => setP({ ...p, subject: e.target.value })}
          />
        </label>
      )}
      <label className="block text-sm">
        Message
        <textarea
          aria-label="Message"
          className={input + ' min-h-36'}
          disabled={!editable || busy}
          value={p.body}
          onChange={(e) => {
            setConfirm(false);
            setP({ ...p, body: e.target.value });
          }}
        />
      </label>
      {p.attachments.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Attachments</p>
          {p.attachments.map((a, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 break-all"
            >
              <span>
                {a.name} · {a.reference}
              </span>
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setP({
                      ...p,
                      attachments: p.attachments.filter((_, j) => j !== i),
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer py-2">Standing routine authority</summary>
        <p className="my-2 text-muted-foreground">{draft.authorization_basis === 'standing_policy' ? 'Authorized by standing policy for this exact message. This is not a per-email human approval or proof of delivery.' : 'Covered routine work uses policy-level authority. This draft is not certified as routine merely because a manager coordinates its bot.'}</p>
        <Button variant="outline" disabled={busy} onClick={() => {
          setBusy(true);
          void requestJson<{message:string}>(`${root}/drafts/${draft.id}/routine-status`)
            .then(result => setRoutineStatus(result.message))
            .catch(e => setRoutineStatus(e instanceof Error ? e.message : 'Unable to check setup'))
            .finally(() => setBusy(false));
        }}>Check routine setup</Button>
        {routineStatus && <p role="status" className="mt-2 break-words">{routineStatus}</p>}
      </details>
      {draft.retirement && <div role="status" className="space-y-1 break-words rounded-lg border p-3 text-sm">
        <p className="font-medium">Retired without delivery</p>
        <p>{draft.retirement.reason}</p>
        <p className="text-muted-foreground">Reference evidence: {draft.retirement.evidence}</p>
        <p className="text-xs">Recorded {draft.retirement.created_at}. Independent message evidence is not a delivery receipt for this draft.</p>
      </div>}
      {draft.receipt && (
        <p role="status" className="break-words text-sm">
          Delivery receipt: {draft.receipt}
        </p>
      )}
      {draft.state === 'uncertain' && (
        <p className="text-sm">
          The bot must check the source receipt before another send.
        </p>
      )}
      {editable && (
        <>
          <p className="text-xs text-muted-foreground">
            Sending authorizes only this exact message. Refunds and other case
            actions require their own decision.
          </p>
          <div className="flex flex-wrap gap-2">
            {dirty ? (
              <Button disabled={busy} onClick={() => void act('save')}>
                Save edits
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() => (confirm ? void act('send') : setConfirm(true))}
              >
                {confirm ? 'Confirm send message' : 'Send message'}
              </Button>
            )}
            {confirm && (
              <Button variant="outline" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy || dirty}
              onClick={() => void act('revise')}
            >
              Ask bot to revise
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void act('discard')}
            >
              Discard
            </Button>
          </div>
        </>
      )}
      {draft.stale && draft.state === 'draft' && (
        <p className="text-sm">
          Ask the bot for a draft tied to the current proposal.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
export function BotCommunication({
  mode = 'all',
  conversationId,
  decisionId,
  version,
}: {
  conversationId: string;
  decisionId?: string;
  version?: number;
  mode?: 'all' | 'briefing' | 'drafts';
}) {
  const [data, setData] = useState<{ drafts: Draft[]; briefings: Briefing[]; approved_obligations?: {decision_id:string;version:number;ready:boolean;reason:string}[] }>({
    drafts: [],
    briefings: [],
  });
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () =>
      requestJson<typeof data>(
        `${root}/chats/${encodeURIComponent(conversationId)}`,
      )
        .then((d) => {
          if (active) {
            setData(d);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [conversationId, revision]);
  const drafts = data.drafts.filter((d) =>
    decisionId ? d.decision_id === decisionId : !d.decision_id,
  );
  const briefings = data.briefings.filter((b) =>
    decisionId
      ? b.decision_id === decisionId && b.decision_version === version
      : !b.decision_id,
  );
  return (
    <div className="space-y-3">
      {mode !== 'briefing' && !decisionId && data.approved_obligations?.map(o => <div key={o.decision_id} className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">Original approved message · {o.ready ? 'awaiting guarded delegation' : 'technically blocked'}</p>
        <p>{o.reason}</p><p>This approval applies only to its exact saved scope, not a different ordinary draft below. No delivery is claimed.</p>
        <a className="underline" href={`#/bots/${encodeURIComponent(o.decision_id)}`}>Review original approval · version {o.version}</a>
      </div>)}
      {mode !== 'drafts' && (decisionId ? (
        <VoiceBriefing
          key={`${decisionId}:${version}`}
          decisionId={decisionId}
          version={version}
          briefing={briefings[0]}
        />
      ) : (
        briefings
          .slice(0, 5)
          .map((b) => <VoiceBriefing key={b.id} briefing={b} />)
      ))}
      {mode !== 'briefing' && drafts.map((d) => (
        <DraftCard
          key={`${d.id}:${d.version}:${d.state}`}
          draft={d}
          refresh={() => setRevision((v) => v + 1)}
        />
      ))}
      {error && (
        <p role="status" className="text-sm text-destructive">
          Message cards unavailable: {error}
        </p>
      )}
    </div>
  );
}
type Thread = {
  id: string;
  source_text: string;
  messages: {
    seq: number;
    id: string;
    text: string;
    actor_name: string;
    actor_conversation_id: string | null;
    created_at: string;
  }[];
  reactions: { emoji: string; count: number; mine: number }[];
};
export function MessageThreadDialog({
  conversationId,
  anchor,
  onClose,
}: {
  conversationId: string;
  anchor: { turn: string; at: string };
  onClose: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(null),
    [error, setError] = useState(''),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false);
  const retry = useRef<{ text: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    let id = '';
    const refresh = async () => {
      try {
        const t = id
          ? await requestJson<Thread>(`${root}/threads/${id}`)
          : await post<Thread>(`/chats/${conversationId}/threads`, anchor);
        if (!active) return;
        id = t.id;
        setThread(t);
        await post(`/threads/${id}/seen`, { seq: t.messages.at(-1)?.seq ?? 0 });
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : 'Thread unavailable');
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [conversationId, anchor.turn, anchor.at]);
  async function send() {
    if (!thread || !text.trim()) return;
    setBusy(true);
    setError('');
    if (retry.current?.text !== text)
      retry.current = { text, key: crypto.randomUUID() };
    try {
      setThread(
        await post<Thread>(`/threads/${thread.id}/replies`, {
          text,
          request_key: retry.current.key,
        }),
      );
      setText('');
      retry.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reply failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogTitle>Discuss this result</DialogTitle>
        <DialogDescription>
          Replies stay with this result. Use the decision’s discussion for
          approvals.
        </DialogDescription>
        {thread && (
          <>
            <details>
              <summary className="cursor-pointer text-sm">
                Original result
              </summary>
              <p className="max-h-56 overflow-auto whitespace-pre-wrap text-sm">
                {thread.source_text}
              </p>
            </details>
            <div className="flex gap-2" aria-label="Reactions">
              {['👍', '❤️', '👀'].map((emoji) => {
                const r = thread.reactions.find((r) => r.emoji === emoji);
                return (
                  <Button
                    key={emoji}
                    variant={r?.mine ? 'secondary' : 'outline'}
                    aria-label={`React ${emoji}`}
                    aria-pressed={!!r?.mine}
                    onClick={() => {
                      void post<Thread>(`/threads/${thread.id}/reactions`, {
                        emoji,
                        active: !r?.mine,
                      })
                        .then(setThread)
                        .catch((e) => setError(e.message));
                    }}
                  >
                    {emoji} {r?.count ?? 0}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Reactions acknowledge a message; they do not approve an action.
            </p>
            <div className="space-y-4">
              {thread.messages.map((m) => (
                <article key={m.id} className="rounded-lg bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    {m.actor_conversation_id ? 'Bot' : m.actor_name} ·{' '}
                    {new Date(m.created_at + 'Z').toLocaleString()}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{m.text}</p>
                </article>
              ))}
            </div>
            <label className="text-sm">
              Reply
              <textarea
                aria-label="Reply"
                className="mt-2 min-h-24 w-full rounded-md border bg-background p-3 text-base"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <Button disabled={busy || !text.trim()} onClick={() => void send()}>
              {busy ? 'Sending…' : 'Reply in thread'}
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
