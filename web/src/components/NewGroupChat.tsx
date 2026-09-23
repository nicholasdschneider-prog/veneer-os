import { useBusinessSelection } from "./BusinessSelector";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { GroupAvatar } from "./GroupAvatar";
import { BotAvatar } from "./BotIdentity";
import { roomApi, type RoomDirectory } from "@/lib/teamRooms";
export const GROUPS_CHANGED = "bot-groups-changed";
export function NewGroupChat({
  business = "",
  onNavigate,
}: {
  business?: string;
  onNavigate: (hash: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [step, setStep] = useState(1),
    [directory, setDirectory] = useState<RoomDirectory | null>(null),
    [teamId, setTeamId] = useState(business),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const { select } = useBusinessSelection();
  const request = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!open) return;
    let active = true;
    void roomApi
      .directory()
      .then((d) => {
        if (active) {
          setDirectory(d);
          setTeamId((t) =>
            d.teams.some((team) => team.id === t) ? t : (d.teams[0]?.id ?? ""),
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [open]);
  const team = directory?.teams.find((t) => t.id === teamId),
    people = [
      ...(team?.bots ?? []),
      ...(team?.people ?? []).filter((p) => p.key !== directory?.self_key),
    ],
    members = people.filter((p) => selected.includes(p.key));
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await roomApi.create({
        team_id: teamId,
        kind: "group",
        name:
          name.trim() ||
          members
            .map((p) => p.name)
            .join(", ")
            .slice(0, 100),
        members: selected,
        request_key: request.current,
      });
      select(teamId);
      window.dispatchEvent(new Event(GROUPS_CHANGED));
      setOpen(false);
      onNavigate("#/messages/" + result.room.id + "?from=bots");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create group.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        className="min-h-[44px] min-w-[44px] rounded-full"
        aria-label="New group chat"
        onClick={() => {
          setStep(1);
          setSelected([]);
          setName("");
          setQuery("");
          setError("");
          setTeamId(business);
          request.current = crypto.randomUUID();
          setOpen(true);
        }}
      >
        <Plus className="size-5" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="gap-4 rounded-3xl sm:max-w-lg"
        >
          <header className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="min-h-[44px] min-w-[44px] rounded-full"
              disabled={busy}
              aria-label={step === 1 ? "Cancel group" : "Back to members"}
              onClick={() => (step === 1 ? setOpen(false) : setStep(1))}
            >
              {step === 1 ? <X /> : <ArrowLeft />}
            </Button>
            <DialogTitle className="min-w-0 flex-1 truncate">
              New Group Chat
            </DialogTitle>
            {step === 1 && (
              <Button
                className="min-h-[44px] rounded-full bg-blue-600 text-white hover:bg-blue-700"
                disabled={!members.length || !team?.can_create}
                onClick={() => setStep(2)}
              >
                Next
              </Button>
            )}
          </header>
          <DialogDescription className="sr-only">
            Choose members, then name your group. New members can read the group
            history.
          </DialogDescription>
          {step === 1 ? (
            <>
              {(directory?.teams.length ?? 0) > 1 && (
                <label className="text-xs text-muted-foreground">
                  Business
                  <select
                    aria-label="Group business"
                    className="mt-1 min-h-[44px] w-full rounded-xl border bg-background px-3 text-base"
                    value={teamId}
                    onChange={(e) => {
                      setTeamId(e.target.value);
                      setSelected([]);
                    }}
                  >
                    {directory?.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="flex flex-wrap items-center gap-1 rounded-2xl bg-muted p-2">
                <span className="px-1 text-sm text-muted-foreground">To:</span>
                {members.map((p) => (
                  <button
                    key={p.key}
                    className="flex min-h-[44px] max-w-full items-center gap-1 rounded-full bg-background px-2 text-sm"
                    aria-label={`Remove ${p.name}`}
                    onClick={() =>
                      setSelected((old) => old.filter((k) => k !== p.key))
                    }
                  >
                    {p.kind === "bot" ? (
                      <span className="[&>svg]:size-6">
                        <BotAvatar id={p.key.slice(4)} name={p.name} />
                      </span>
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs"
                      >
                        {p.name.slice(0, 1)}
                      </span>
                    )}
                    <span className="truncate">{p.name}</span>
                    <X className="size-3 shrink-0" />
                  </button>
                ))}
                <input
                  aria-label="Add another member"
                  placeholder={
                    members.length ? "Add another" : "Find a bot or person"
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-h-[44px] w-32 min-w-0 flex-1 bg-transparent px-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              {!directory && !error && <p role="status">Loading members…</p>}
              <div className="max-h-[50dvh] overflow-y-auto">
                {people
                  .filter(
                    (p) =>
                      !selected.includes(p.key) &&
                      p.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((p) => (
                    <button
                      key={p.key}
                      className="flex min-h-16 w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                      aria-label={`Add ${p.name} (${p.kind === "bot" ? "bot" : "person"})`}
                      onClick={() => setSelected((old) => [...old, p.key])}
                      disabled={selected.length >= 24 || !team?.can_create}
                    >
                      {p.kind === "bot" ? (
                        <BotAvatar id={p.key.slice(4)} name={p.name} />
                      ) : (
                        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-sm">
                          {p.name.slice(0, 1)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {p.name}
                        <span className="block text-xs text-muted-foreground">
                          {p.kind === "bot" ? "Bot" : "Person"}
                        </span>
                      </span>
                    </button>
                  ))}
              </div>
              {directory && !people.length && (
                <p className="text-sm text-muted-foreground">
                  No available members in this business. Ask a manager to check
                  your access.
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-6 py-6">
              <GroupAvatar members={members} large />
              <label className="w-full">
                <span className="sr-only">Group name</span>
                <input
                  autoFocus
                  value={name}
                  maxLength={100}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.nativeEvent.isComposing &&
                      !busy
                    )
                      void create();
                  }}
                  placeholder="Ex: Customer Service"
                  className="min-h-16 w-full rounded-2xl bg-muted px-4 py-3 text-center text-xl font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <Button
                variant="outline"
                className="min-h-[44px] w-full rounded-full"
                disabled={busy || !members.length}
                onClick={() => void create()}
              >
                {busy ? "Creating…" : name.trim() ? "Create group" : "Skip"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                You’re included. Select @ in the conversation to address bots.
                Everyone must have access to invited bots.
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
