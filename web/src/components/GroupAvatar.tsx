import { BotAvatar } from "./BotIdentity";
import type { RoomPerson } from "@/lib/teamRooms";
export function GroupAvatar({
  members,
  large = false,
}: {
  members: RoomPerson[];
  large?: boolean;
}) {
  const shown = [
    ...members.filter((p) => p.kind === "bot"),
    ...members.filter((p) => p.kind === "human"),
  ].slice(0, 2);
  return (
    <span
      aria-label="Group"
      className={`relative inline-block shrink-0 ${large ? "h-28 w-32" : "size-11"}`}
    >
      {shown.map((p, i) => (
        <span
          key={p.key}
          className={`absolute ${i ? "bottom-0 right-0" : "top-0 left-0"} ${large ? "[&>svg]:size-20" : "[&>svg]:size-8"} rounded-xl ring-2 ring-background`}
        >
          {p.kind === "bot" ? (
            <BotAvatar id={p.key.replace(/^bot:/, "")} name={p.name} />
          ) : (
            <span
              className={`flex items-center justify-center rounded-xl bg-muted font-semibold ${large ? "size-20 text-2xl" : "size-8 text-xs"}`}
            >
              {p.name
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((n) => n[0])
                .join("")
                .toUpperCase()}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
