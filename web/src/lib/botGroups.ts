import { useEffect, useState } from "react";
import type { Bot } from "./bots";
import { roomApi, type RoomPerson } from "./teamRooms";
import { huddlesApi } from "./huddles";
export type BotGroup = {
  kind: "room" | "huddle";
  id: string;
  name: string;
  updated_at: string;
  preview: string;
  unread: number;
  members: RoomPerson[];
};
export type BotListEntry = { kind: "bot"; bot: Bot } | BotGroup;
const time = (value?: string | null) =>
  !value
    ? 0
    : Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z") ||
      0;
export function mergeBotGroups(
  bots: Bot[],
  groups: BotGroup[],
  query = "",
): BotListEntry[] {
  return [...bots.map((bot) => ({ kind: "bot" as const, bot })), ...groups]
    .filter((e) =>
      (e.kind === "bot"
        ? `${e.bot.name} ${e.bot.title ?? ""}`
        : e.name + " " + e.preview
      )
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((a, b) => {
      const pinA = Boolean(a.kind === "bot" && a.bot.pinned),
        pinB = Boolean(b.kind === "bot" && b.bot.pinned);
      if (pinA !== pinB) return pinA ? -1 : 1;
      return (
        time(b.kind === "bot" ? b.bot.updated_at : b.updated_at) -
        time(a.kind === "bot" ? a.bot.updated_at : a.updated_at)
      );
    });
}
export function useBotGroups(business: string, restricted: boolean) {
  const [groups, setGroups] = useState<BotGroup[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setGroups([]);
    const refresh = async () => {
      const [rooms, huddles] = await Promise.allSettled([
        roomApi.list(),
        restricted
          ? Promise.resolve({ huddles: [] })
          : huddlesApi.list("all", business),
      ]);
      if (!active) return;
      const result: BotGroup[] = [];
      if (rooms.status === "fulfilled")
        for (const r of rooms.value.rooms) {
          if (r.kind !== "group" || (business && r.team_id !== business))
            continue;
          result.push({
            kind: "room",
            id: r.id,
            name: r.name,
            updated_at: r.updated_at ?? "",
            preview: r.last_message?.text || `${r.members.length} members`,
            unread: r.unread,
            members: r.members,
          });
        }
      if (huddles.status === "fulfilled")
        for (const h of huddles.value.huddles) {
          result.push({
            kind: "huddle",
            id: h.id,
            name: h.goal,
            updated_at: h.last_message_at ?? h.updated_at,
            preview:
              h.status === "closed"
                ? "Closed · " + h.status_note
                : h.status_note ||
                  `${h.member_count} bots · ${h.open_action_count} open actions`,
            unread: h.my_unread,
            members: [
              h.lead,
              ...(h.owner && h.owner.conversation_id !== h.lead.conversation_id
                ? [h.owner]
                : []),
            ].map((p) => ({
              key: "bot:" + p.conversation_id,
              name: p.name,
              kind: "bot",
            })),
          });
        }
      setGroups(result);
      setError(
        rooms.status === "rejected" || huddles.status === "rejected"
          ? "Some group conversations could not be loaded."
          : "",
      );
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    window.addEventListener("bot-groups-changed", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("bot-groups-changed", refresh);
    };
  }, [business, restricted]);
  return { groups, error };
}
