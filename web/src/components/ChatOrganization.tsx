import { useEffect, useState, useRef } from "react";
import { requestJson } from "@/lib/api";
import type { Bot } from "@/lib/bots";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
export type Organization = {
  revision: number;
  groups: { id: string; name: string }[];
  placements: Record<string, string>;
  fallback: string | null;
};
export function useChatOrganization(business: string) {
  const [data, setData] = useState<Organization | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const url = "/api/bots/organization?business=" + encodeURIComponent(business);
  const currentUrl = useRef(url);
  currentUrl.current = url;
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    requestJson<Organization>(url)
      .then((d) => {
        if (active) setData(d);
      })
      .catch(() => {
        if (active) setError("Could not load your groups.");
      });
    return () => {
      active = false;
    };
  }, [url]);
  async function save(next: Organization) {
    if (saving.current || !data) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<Organization>(url, {
        method: "POST",
        body: JSON.stringify({
          expected_revision: data.revision,
          definition: {
            groups: next.groups,
            placements: next.placements,
            fallback: next.fallback,
          },
        }),
      });
      if (currentUrl.current === url) setData(result);
    } catch (e) {
      if (currentUrl.current !== url) return;
      setError(e instanceof Error ? e.message : "Could not save groups.");
      try {
        const refreshed = await requestJson<Organization>(url);
        if (currentUrl.current === url) setData(refreshed);
      } catch {
        /* Keep last known organization on failure. */
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return { data, error, busy, save };
}
export function OrganizationEditor({
  organization,
  bots,
}: {
  organization: ReturnType<typeof useChatOrganization>;
  bots: Bot[];
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState("");
  const { data, busy, save, error } = organization;
  return (
    <>
      <Button
        variant="ghost"
        className="min-h-[44px] px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        Organize bots
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg [&>[data-slot=dialog-close]]:size-[44px]">
          <DialogTitle>Organize bots</DialogTitle>
          <DialogDescription>
            Personal display groups for this business view. Moving bots never
            changes their job, team, or permissions. Deleting a group keeps its
            bots.
          </DialogDescription>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {!data ? (
            <p>Groups are unavailable. Reopen Chats to retry.</p>
          ) : (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) {
                    void save({
                      ...data,
                      groups: [
                        ...data.groups,
                        { id: crypto.randomUUID(), name: name.trim() },
                      ],
                    });
                    setName("");
                  }
                }}
              >
                <input
                  aria-label="New group name"
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="min-h-[44px] min-w-0 flex-1 rounded-xl border bg-background px-3"
                />
                <Button
                  disabled={busy || !name.trim()}
                  className="min-h-[44px]"
                >
                  Add group
                </Button>
              </form>
              <div className="max-h-[50dvh] space-y-3 overflow-y-auto">
                {data.groups.map((g) => (
                  <GroupName
                    key={g.id + g.name}
                    name={g.name}
                    busy={busy}
                    onRename={(name) =>
                      void save({
                        ...data,
                        groups: data.groups.map((x) =>
                          x.id === g.id ? { ...x, name } : x,
                        ),
                      })
                    }
                    onDelete={() =>
                      void save({
                        ...data,
                        groups: data.groups.filter((x) => x.id !== g.id),
                        placements: Object.fromEntries(
                          Object.entries(data.placements).map(([id, group]) => [
                            id,
                            group === g.id ? "" : group,
                          ]),
                        ),
                      })
                    }
                  />
                ))}
                {data.fallback !== null ? (
                  <GroupName
                    key={"fallback" + data.fallback}
                    name={data.fallback}
                    busy={busy}
                    onRename={(fallback) => void save({ ...data, fallback })}
                    onDelete={() => void save({ ...data, fallback: null })}
                  />
                ) : (
                  <Button
                    variant="outline"
                    className="min-h-[44px]"
                    disabled={busy}
                    onClick={() =>
                      void save({ ...data, fallback: "Unassigned" })
                    }
                  >
                    Show ungrouped heading
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  Bots without a group remain visible. Remove the ungrouped
                  heading to show them directly in the list.
                </p>
                {bots.map((bot) => (
                  <label
                    key={bot.conversation_id}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                    <select
                      aria-label={`Move ${bot.name} to`}
                      disabled={busy}
                      className="min-h-[44px] max-w-[60%] rounded-xl border bg-background px-2"
                      value={data.placements[bot.conversation_id] ?? ""}
                      onChange={(e) =>
                        void save({
                          ...data,
                          placements: {
                            ...data.placements,
                            [bot.conversation_id]: e.target.value,
                          },
                        })
                      }
                    >
                      <option value="">No group</option>
                      {data.groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
function GroupName({
  name,
  busy,
  onRename,
  onDelete,
}: {
  name: string;
  busy: boolean;
  onRename: (s: string) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <div className="flex flex-wrap gap-2">
      <input
        aria-label={`Group name: ${name}`}
        maxLength={80}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="min-h-[44px] min-w-0 flex-1 rounded-xl border bg-background px-3"
      />
      <Button
        variant="outline"
        className="min-h-[44px]"
        disabled={busy || !value.trim() || value.trim() === name}
        onClick={() => onRename(value.trim())}
      >
        Rename
      </Button>
      <Button
        variant="ghost"
        className="min-h-[44px]"
        disabled={busy}
        aria-label={`Delete group ${name}`}
        onClick={onDelete}
      >
        Delete
      </Button>
    </div>
  );
}
