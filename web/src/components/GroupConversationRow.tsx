import { GroupAvatar } from "./GroupAvatar";
import type { BotGroup } from "@/lib/botGroups";
export function GroupConversationRow({
  group,
  selected,
  onNavigate,
}: {
  group: BotGroup;
  selected?: boolean;
  onNavigate: (hash: string) => void;
}) {
  return (
    <button
      aria-current={selected ? "page" : undefined}
      className={`flex min-h-16 w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${selected ? "bg-muted" : ""}`}
      onClick={() =>
        onNavigate(
          group.kind === "room"
            ? `#/messages/${group.id}?from=bots`
            : `#/huddles/${group.id}`,
        )
      }
    >
      <GroupAvatar members={group.members} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">
            {group.name}
          </span>
          {group.updated_at && (
            <time
              dateTime={group.updated_at}
              className="shrink-0 text-[10px] text-muted-foreground"
            >
              {new Date(
                group.updated_at.includes("T")
                  ? group.updated_at
                  : group.updated_at.replace(" ", "T") + "Z",
              ).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </time>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {group.preview}
        </span>
      </span>
      {group.unread > 0 && (
        <span
          aria-label={`${group.unread} unread messages`}
          className="size-2 shrink-0 rounded-full bg-primary"
        />
      )}
    </button>
  );
}
