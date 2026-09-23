import {BotConversationRail} from '@/components/BotConversationRail';
import {GroupAvatar} from '@/components/GroupAvatar';
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  AtSign,
  Bot,
  MessageCircle,
  Mic,
  Paperclip,
  Plus,
  Square,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  roomApi,
  roomTitle,
  type TeamRoom,
  type RoomDirectory,
  type RoomPerson,
  type RoomFile,
} from "@/lib/teamRooms";
import { micDictation } from "@/lib/stt";
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Could not complete this request.";
const inputStyle =
  "w-full min-w-0 rounded-xl border bg-background px-3 py-2 text-base";
function Avatar({ name, bot = false }: { name: string; bot?: boolean }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold"
      aria-hidden="true"
    >
      {bot ? (
        <Bot className="size-4" />
      ) : (
        name
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((n) => n[0])
          .join("")
          .toUpperCase()
      )}
    </span>
  );
}
export function TeamMessages({
  roomId,
  fromBots = false,
  restricted = false,
  onNavigate,
}: {
  roomId?: string;
  fromBots?: boolean;
  restricted?: boolean;
  onNavigate: (hash: string) => void;
}) {
  const [rooms, setRooms] = useState<TeamRoom[]>([]),
    [directory, setDirectory] = useState<RoomDirectory | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [create, setCreate] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (document.hidden) return;
      void Promise.all([roomApi.list(), roomApi.directory()])
        .then(([r, d]) => {
          if (alive) {
            setRooms(r.rooms);
            setDirectory(d);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [roomId, create]);
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      {fromBots ? <div className="hidden w-72 shrink-0 md:block"><BotConversationRail restricted={restricted} selectedGroup={"room:"+roomId} onNavigate={onNavigate}/></div> : <aside
        className={`${roomId ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r md:w-72`}
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h1 className="text-lg font-semibold">Messages</h1>
          <Button
            variant="ghost"
            size="icon"
            className="size-[44px] text-foreground"
            aria-label="New message"
            onClick={() => setCreate(true)}
          >
            <Plus />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              Loading messages…
            </p>
          )}
          {error && (
            <p role="alert" className="p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {!loading && !rooms.length && (
            <div className="p-4 text-sm text-muted-foreground">
              <MessageCircle className="mb-3 size-7" />
              <p>Keep your team’s conversations here.</p>
              <Button className="mt-4" onClick={() => setCreate(true)}>
                New message
              </Button>
            </div>
          )}
          {rooms.map((r) => (
            <button
              key={r.id}
              onClick={() => onNavigate("#/messages/" + r.id)}
              aria-current={r.id === roomId ? "page" : undefined}
              className={`flex min-h-16 w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted ${r.id === roomId ? "bg-muted" : ""}`}
            >
              {r.kind==="group"?<GroupAvatar members={r.members}/>:<Avatar name={roomTitle(r, directory?.self_key ?? "")} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {roomTitle(r, directory?.self_key ?? "")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {r.kind === "dm"
                    ? "Direct message"
                    : `${r.members.length} members`}
                </span>
              </span>
              {r.unread > 0 && (
                <span
                  className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground"
                  aria-label={`${r.unread} unread`}
                >
                  {r.unread}
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Private to the people and bots in each room.
        </p>
      </aside>}
      {roomId ? (
        <RoomConversation
          key={roomId}
          id={roomId}
          backHash={fromBots?"#/bots":"#/messages"}
          directory={directory}
          onNavigate={onNavigate}
        />
      ) : (
        <div className="hidden flex-1 flex-col items-center justify-center gap-3 p-8 text-center md:flex">
          <Users className="size-9 text-muted-foreground" />
          <h2 className="text-xl font-semibold">
            Your team, in one conversation
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Message a teammate or bring people and bots together in a named
            group.
          </p>
          <Button onClick={() => setCreate(true)}>New message</Button>
        </div>
      )}
      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent className="rounded-3xl sm:max-w-lg [&>[data-slot=dialog-close]]:size-[44px]">
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>
            Choose a teammate, or create a group with people and bots.
          </DialogDescription>
          {directory ? (
            <RoomEditor
              directory={directory}
              onDone={(id) => {
                setCreate(false);
                onNavigate("#/messages/" + id);
              }}
            />
          ) : (
            <p role="status">Loading your team…</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function RoomEditor({
  directory,
  room,
  onDone,
}: {
  directory: RoomDirectory;
  room?: TeamRoom;
  onDone: (id: string) => void;
}) {
  const [teamId, setTeamId] = useState(
      room?.team_id ?? directory.teams[0]?.id ?? "",
    ),
    [kind, setKind] = useState<"dm" | "group">(room ? "group" : "dm"),
    [name, setName] = useState(room?.name ?? ""),
    [selected, setSelected] = useState<string[]>(
      room?.members.map((m) => m.key).filter((k) => k !== directory.self_key) ??
        [],
    ),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef(crypto.randomUUID()),
    team = directory.teams.find((t) => t.id === teamId);
  const people = [
    ...(team?.people ?? []),
    ...(kind === "group" ? (team?.bots ?? []) : []),
  ].filter(
    (p) =>
      p.key !== directory.self_key &&
      p.name.toLowerCase().includes(query.toLowerCase()),
  );
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (room) {
        await roomApi.update(room.id, {
          expected_revision: room.revision,
          name,
          members: [directory.self_key, ...selected],
        });
        onDone(room.id);
      } else {
        const r = await roomApi.create({
          team_id: teamId,
          kind,
          name: kind === "dm" ? "Direct message" : name,
          members: selected,
          request_key: request.current,
        });
        onDone(r.room.id);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      {!room && (
        <>
          <label className="block text-sm">
            Business
            <select
              aria-label="Business"
              className={inputStyle}
              value={teamId}
              disabled={busy}
              onChange={(e) => {
                setTeamId(e.target.value);
                setSelected([]);
                request.current = crypto.randomUUID();
              }}
            >
              {directory.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            {(["dm", "group"] as const).map((k) => (
              <Button
                key={k}
                variant={kind === k ? "default" : "outline"}
                disabled={busy}
                onClick={() => {
                  setKind(k);
                  setSelected([]);
                  request.current = crypto.randomUUID();
                }}
              >
                {k === "dm" ? "Direct message" : "New group chat"}
              </Button>
            ))}
          </div>
        </>
      )}
      {kind === "group" && (
        <label className="block text-sm">
          Group name
          <input
            className={inputStyle}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
      )}
      <input
        aria-label="Find people or bots"
        placeholder="Find people or bots"
        className={inputStyle}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {selected.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          aria-label="Selected participants"
        >
          {selected.map((key) => (
            <button
              key={key}
              disabled={busy}
              className="min-h-9 rounded-full bg-muted px-3 text-xs"
              onClick={() =>
                setSelected((old) => old.filter((id) => id !== key))
              }
            >
              Remove{" "}
              {[
                ...(team?.people ?? []),
                ...(team?.bots ?? []),
                ...(room?.members ?? []),
              ].find((p) => p.key === key)?.name ?? key}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-64 overflow-y-auto rounded-xl border">
        {people.map((p) => (
          <label
            key={p.key}
            className="flex min-h-14 cursor-pointer items-center gap-3 border-b p-3 last:border-0"
          >
            <input
              type={kind === "dm" ? "radio" : "checkbox"}
              name="room-members"
              checked={selected.includes(p.key)}
              disabled={busy}
              onChange={() => {
                setSelected(
                  kind === "dm"
                    ? [p.key]
                    : selected.includes(p.key)
                      ? selected.filter((k) => k !== p.key)
                      : [...selected, p.key],
                );
              }}
            />
            <Avatar name={p.name} bot={p.kind === "bot"} />
            <span className="min-w-0 break-words">
              {p.name}
              <span className="block text-xs text-muted-foreground">
                {p.kind === "bot" ? "Bot" : "Person"} · {p.key}
              </span>
            </span>
          </label>
        ))}
        {!people.length && (
          <p className="p-4 text-sm text-muted-foreground">
            No matching teammates. Ask a manager to check business membership
            and bot access.
          </p>
        )}
      </div>
      {kind === "group" && (
        <p className="text-xs text-muted-foreground">
          Members can read the group’s full history. Everyone needs access to
          invited bots. Only the creator can rename the group or change members;
          other people can leave.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        className="w-full min-h-11"
        disabled={
          busy ||
          !team?.can_create ||
          !selected.length ||
          (kind === "group" && !name.trim())
        }
        onClick={() => void save()}
      >
        {busy
          ? "Saving…"
          : room
            ? "Save group"
            : kind === "dm"
              ? "Start conversation"
              : "Create group"}
      </Button>
    </div>
  );
}
function RoomConversation({
  id,
  backHash,
  directory,
  onNavigate,
}: {
  id: string;
  backHash: string;
  directory: RoomDirectory | null;
  onNavigate: (hash: string) => void;
}) {
  const [room, setRoom] = useState<TeamRoom | null>(null),
    [error, setError] = useState(""),
    [details, setDetails] = useState(false),
    [edit, setEdit] = useState(false),
    [draft, setDraft] = useState(""),
    [mentions, setMentions] = useState<RoomPerson[]>([]),
    [everyone, setEveryone] = useState(false),
    [mentionOpen, setMentionOpen] = useState(false),
    [files, setFiles] = useState<RoomFile[]>([]),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [recording, setRecording] = useState(false),
    [finalizing, setFinalizing] = useState(false);
  const alive = useRef(true),
    roomRef = useRef<TeamRoom | null>(null),
    scroller = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    micOwn = useRef(false),
    base = useRef(""),
    sendAttempt = useRef<{ key: string; body: string } | null>(null),
    loading = useRef(false);
  const refresh = async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      let after = roomRef.current?.last_seq ?? 0;
      const messages: TeamRoom["messages"] = [
        ...(roomRef.current?.messages ?? []),
      ];
      let latest: TeamRoom;
      do {
        latest = (await roomApi.read(id, after)).room;
        messages.push(...latest.messages);
        after = latest.next ?? 0;
      } while (after);
      if (!alive.current) return;
      const nearBottom =
        !scroller.current ||
        scroller.current.scrollHeight -
          scroller.current.scrollTop -
          scroller.current.clientHeight <
          100;
      const wasEmpty = !roomRef.current;
      latest.messages = [
        ...new Map(messages.map((message) => [message.id, message])).values(),
      ];
      roomRef.current = latest;
      setRoom(latest);
      if (!document.hidden) {
        await roomApi.seen(id, latest.last_seq);
        window.dispatchEvent(new Event("team-room-seen"));
      }
      if (nearBottom || wasEmpty)
        requestAnimationFrame(() =>
          scroller.current?.scrollTo({ top: scroller.current.scrollHeight }),
        );
    } catch (e) {
      if (alive.current) {
        setError(errorText(e));
        setRoom(null);
        roomRef.current = null;
      }
    } finally {
      loading.current = false;
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      if (micOwn.current) micDictation.stop("cancel");
    };
  }, [id]);
  const send = async () => {
    if (
      !room ||
      busy ||
      uploading ||
      recording ||
      finalizing ||
      (!draft.trim() && !files.length)
    )
      return;
    const body = {
      text: draft,
      mentions: mentions.map((m) => m.key),
      everyone,
      attachments: files.map((f) => f.id),
    };
    const fingerprint = JSON.stringify(body);
    if (!sendAttempt.current || sendAttempt.current.body !== fingerprint)
      sendAttempt.current = { key: crypto.randomUUID(), body: fingerprint };
    setBusy(true);
    setError("");
    try {
      await roomApi.send(id, { ...body, request_key: sendAttempt.current.key });
      if (!alive.current) return;
      setDraft("");
      setFiles([]);
      setMentions([]);
      setEveryone(false);
      sendAttempt.current = null;
      await refresh();
      textarea.current?.focus();
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const upload = async (list: FileList | null) => {
    if (!list) return;
    setUploading(true);
    setError("");
    try {
      if (files.length + list.length > 10)
        throw new Error("Attach up to 10 files.");
      for (const file of Array.from(list)) {
        if (file.size > 20 * 1024 * 1024)
          throw new Error("Each file must be 20 MB or smaller.");
        const f = await roomApi.upload(id, file);
        if (alive.current) setFiles((old) => [...old, f]);
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const dictate = () => {
    if (micOwn.current) {
      micDictation.stop();
      return;
    }
    base.current = draft;
    micOwn.current = true;
    void micDictation
      .start({
        onPartial: (text) => {
          if (alive.current) setDraft(`${base.current} ${text}`.trim());
        },
        onCommitted: (text) => {
          base.current = `${base.current} ${text}`.trim();
          if (alive.current) setDraft(base.current);
        },
        onFinalizing: () => {
          if (alive.current) setFinalizing(true);
        },
        onEnd: () => {
          micOwn.current = false;
          if (alive.current) {
            setRecording(false);
            setFinalizing(false);
          }
        },
        onError: (message) => {
          if (alive.current) setError(message);
        },
      })
      .then(() => {
        if (alive.current) setRecording(true);
        else micDictation.stop("cancel");
      })
      .catch((e) => {
        micOwn.current = false;
        if (alive.current) setError(errorText(e));
      });
  };
  const addMention = (p: RoomPerson | null) => {
    if (p) {
      setMentions((old) =>
        old.some((m) => m.key === p.key) ? old : [...old, p],
      );
      setDraft((old) => old.replace(/@[^@\s]*$/, "") + `@${p.name} `);
    } else {
      setEveryone(true);
      setDraft((old) => old.replace(/@[^@\s]*$/, "") + "@everyone ");
    }
    setMentionOpen(false);
    textarea.current?.focus();
  };
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col conversation-surface">
      <header className="flex min-h-16 items-center gap-3 border-b px-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-[44px] text-foreground"
          aria-label={backHash==="#/bots"?"Back to bots":"Back to messages"}
          onClick={() => onNavigate(backHash)}
        >
          <ArrowLeft />
        </Button>
        <button
          className="flex min-w-0 flex-1 items-center justify-center gap-2 py-2 text-center"
          onClick={() => setDetails(true)}
          disabled={!room}
        >
          {room?.kind==="group"?<GroupAvatar members={room.members}/>:<Avatar name={room ? roomTitle(room, room.self_key) : "Team"} />}
          <span className="min-w-0">
            <span className="block truncate font-semibold">
              {room ? roomTitle(room, room.self_key) : "Messages"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {room
                ? `${room.members.length} members · Details`
                : "Loading conversation…"}
            </span>
          </span>
        </button>
        <span className="w-11" />
      </header>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b p-3 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Refresh
          </Button>
        </div>
      )}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6"
        aria-label="Messages"
      >
        <div className="mx-auto max-w-3xl space-y-5">
          {room?.messages.map((m) => (
            <article
              key={m.id}
              className={`flex gap-2.5 ${m.author_key === room.self_key ? "flex-row-reverse" : ""}`}
            >
              <Avatar
                name={m.author_name}
                bot={m.author_key.startsWith("bot:")}
              />
              <div className="min-w-0 max-w-[85%]">
                <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium">
                    {m.author_name}
                    {m.author_key.startsWith("bot:") ? " · Bot" : ""}
                  </span>
                  <time
                    className="text-muted-foreground"
                    dateTime={m.created_at.replace(" ", "T") + "Z"}
                  >
                    {new Date(
                      m.created_at.replace(" ", "T") + "Z",
                    ).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <div
                  className={`rounded-2xl px-4 py-3 ${m.author_key === room.self_key ? "bg-primary/10" : "bg-card border"}`}
                >
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
                    {m.text}
                  </p>
                  {m.attachments.map((f) => (
                    <a
                      key={f.id}
                      href={f.url}
                      download
                      className="mt-2 flex min-h-11 items-center gap-2 break-all text-sm underline"
                    >
                      <Paperclip className="size-4 shrink-0" />
                      {f.name}
                    </a>
                  ))}
                </div>
              </div>
            </article>
          ))}
          {room && !room.messages.length && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Start the conversation. Bots respond when you select them with @.
            </p>
          )}
        </div>
      </div>
      {room && (
        <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-2 sm:px-6">
          <button
            className="mb-2 block min-h-9 rounded-full border bg-background px-3 text-xs text-muted-foreground"
            onClick={() =>
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
            }
          >
            ↓ Latest messages
          </button>
          <div className="rounded-3xl border bg-card p-3 shadow-sm">
            {(mentions.length > 0 || everyone) && (
              <div
                className="mb-2 flex flex-wrap gap-1"
                aria-label="Addressed members"
              >
                {everyone && (
                  <button
                    className="min-h-9 rounded-full bg-muted px-2 text-xs"
                    onClick={() => setEveryone(false)}
                  >
                    @everyone ×
                  </button>
                )}
                {mentions.map((m) => (
                  <button
                    key={m.key}
                    className="min-h-9 rounded-full bg-muted px-2 text-xs"
                    onClick={() =>
                      setMentions((old) => old.filter((p) => p.key !== m.key))
                    }
                  >
                    @{m.name} ×
                  </button>
                ))}
              </div>
            )}
            {files.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="truncate">{f.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-[44px] text-foreground"
                  aria-label={`Remove ${f.name}`}
                  disabled={busy}
                  onClick={() =>
                    setFiles((old) => old.filter((a) => a.id !== f.id))
                  }
                >
                  <X />
                </Button>
              </div>
            ))}
            <textarea
              ref={textarea}
              aria-label="Message"
              placeholder={
                room.can_send
                  ? "Message your team…"
                  : "This business access is read-only"
              }
              rows={2}
              maxLength={12000}
              disabled={!room.can_send || busy || finalizing}
              value={draft}
              className="max-h-40 min-h-16 w-full resize-y bg-transparent px-1 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              onChange={(e) => {
                setDraft(e.target.value);
                setMentionOpen(/@[^@\s]*$/.test(e.target.value));
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setMentionOpen(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {mentionOpen && (
              <div
                className="mb-2 max-h-40 overflow-auto rounded-xl border p-1"
                aria-label="Choose who to mention"
              >
                <button
                  className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-muted"
                  onClick={() => addMention(null)}
                >
                  @everyone · All room members
                </button>
                {room.members
                  .filter(
                    (m) => m.available !== false && m.key !== room.self_key,
                  )
                  .map((m) => (
                    <button
                      key={m.key}
                      className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-muted"
                      onClick={() => addMention(m)}
                    >
                      @{m.name}{" "}
                      <span className="text-muted-foreground">
                        · {m.kind === "bot" ? "Bot" : "Person"}
                      </span>
                    </button>
                  ))}
              </div>
            )}
            <div className="flex items-center gap-1">
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void upload(e.target.files)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-[44px] text-foreground"
                aria-label="Attach files"
                disabled={busy || uploading || !room.can_send}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-[44px] text-foreground"
                aria-label="Mention a member"
                disabled={busy || !room.can_send}
                onClick={() => setMentionOpen(!mentionOpen)}
              >
                <AtSign />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-[44px] text-foreground"
                aria-label={recording ? "Stop dictation" : "Dictate message"}
                disabled={busy || finalizing || !room.can_send}
                onClick={dictate}
              >
                {recording ? <Square /> : <Mic />}
              </Button>
              <span
                role="status"
                className="min-w-0 flex-1 text-xs text-muted-foreground"
              >
                {uploading
                  ? "Uploading…"
                  : finalizing
                    ? "Transcribing…"
                    : recording
                      ? "Listening…"
                      : ""}
              </span>
              <Button
                className="size-11 rounded-full bg-blue-600 text-white hover:bg-blue-700"
                size="icon"
                aria-label="Send message"
                disabled={
                  busy ||
                  uploading ||
                  recording ||
                  finalizing ||
                  !room.can_send ||
                  (!draft.trim() && !files.length)
                }
                onClick={() => void send()}
              >
                <ArrowUp />
              </Button>
            </div>
          </div>
          <p className="px-2 pt-2 text-[11px] text-muted-foreground">
            Select @ to address bots. Other messages stay between people.
            Dictation adds text; it is not a group call.
          </p>
        </div>
      )}
      <Dialog
        open={details}
        onOpenChange={(open) => {
          setDetails(open);
          if (!open) setEdit(false);
        }}
      >
        <DialogContent className="rounded-3xl sm:max-w-lg [&>[data-slot=dialog-close]]:size-[44px]">
          <DialogTitle>
            {room ? roomTitle(room, room.self_key) : "Conversation details"}
          </DialogTitle>
          <DialogDescription>
            Only current members can access this conversation. New members can
            read its history.
          </DialogDescription>
          {room && (
            <>
              {edit && directory ? (
                <RoomEditor
                  key={room.revision}
                  directory={directory}
                  room={room}
                  onDone={() => {
                    setEdit(false);
                    void refresh();
                  }}
                />
              ) : (
                <>
                  {room.kind==="group"&&<div className="flex justify-center py-4"><GroupAvatar members={room.members} large/></div>}
                  <div className="divide-y rounded-2xl bg-muted/50 px-3">
                    {room.members.map((p) => (
                      <div key={p.key} className="flex items-center gap-3 py-2">
                        <Avatar name={p.name} bot={p.kind === "bot"} />
                        <span className="min-w-0 break-words">
                          {p.kind==="bot"&&p.available!==false?<button className="min-h-[44px] max-w-full truncate text-left hover:underline" onClick={()=>onNavigate('#/chat/'+p.key.slice(4)+'?from=bots')}>{p.name} ›</button>:p.name}
                          <span className="block text-xs text-muted-foreground">
                            {p.kind === "bot" ? "Bot" : "Person"}
                            {p.key === room.self_key ? " · You" : ""}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  {room.kind === "group" &&
                    (room.can_manage ? (
                      <div className="flex flex-wrap gap-2"><Button className="min-h-[44px]" variant="outline" onClick={() => setEdit(true)}>Rename group</Button><Button className="min-h-[44px]" onClick={() => setEdit(true)}>Add member</Button></div>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => {
                          void roomApi
                            .update(id, {
                              expected_revision: room.revision,
                              leave: true,
                            })
                            .then(() => onNavigate(backHash))
                            .catch((e) => setError(errorText(e)));
                        }}
                      >
                        Leave group
                      </Button>
                    ))}
                  <p className="text-xs text-muted-foreground">
                    Room messages and mentions do not approve business actions
                    or customer sends. Use Needs input for those decisions.
                  </p>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
