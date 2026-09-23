import { useEffect, useState } from "react";
import { requestJson } from "./api";
export type RoomPerson = {
  key: string;
  name: string;
  kind: "human" | "bot";
  available?: boolean;
};
export type RoomFile = { id: string; name: string; size: number; url: string };
export type RoomMessage = {
  id: string;
  seq: number;
  author_key: string;
  author_name: string;
  text: string;
  created_at: string;
  attachments: RoomFile[];
  mentions: string[];
};
export type TeamRoom = {
  id: string;
  team_id: string;
  kind: "dm" | "group";
  name: string;
  revision: number;
  last_seq: number;
  members: RoomPerson[];
  unread: number;
  self_key: string;
  can_manage: boolean;
  can_send: boolean;
  messages: RoomMessage[];
  next: number | null;
};
export type RoomDirectory = {
  self_key: string;
  teams: {
    id: string;
    name: string;
    can_create: boolean;
    people: RoomPerson[];
    bots: RoomPerson[];
  }[];
};
const base = "/api/team-rooms";
const post = <T>(url: string, body: unknown, method = "POST") =>
  requestJson<T>(url, { method, body: JSON.stringify(body) });
export const roomApi = {
  list: () => requestJson<{ rooms: TeamRoom[] }>(base),
  directory: () => requestJson<RoomDirectory>(base + "/directory"),
  read: (id: string, after = 0) =>
    requestJson<{ room: TeamRoom }>(
      `${base}/${encodeURIComponent(id)}?after=${after}`,
    ),
  create: (body: unknown) => post<{ room: TeamRoom }>(base, body),
  update: (id: string, body: unknown) =>
    post(`${base}/${encodeURIComponent(id)}`, body, "PATCH"),
  send: (id: string, body: unknown) =>
    post(`${base}/${encodeURIComponent(id)}/messages`, body),
  seen: (id: string, seq: number) =>
    post(`${base}/${encodeURIComponent(id)}/seen`, { seq }),
  upload: async (id: string, file: File) => {
    const response = await fetch(
      `${base}/${encodeURIComponent(id)}/files?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Upload failed");
    return result.file as RoomFile;
  },
};
export function roomTitle(
  room: Pick<TeamRoom, "kind" | "members" | "name">,
  self: string,
) {
  return room.kind === "dm"
    ? (room.members.find((p) => p.key !== self)?.name ?? "Direct message")
    : room.name;
}
export function useRoomUnread() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (document.hidden) return;
      void roomApi
        .list()
        .then((r) => {
          if (alive) setCount(r.rooms.reduce((sum, r) => sum + r.unread, 0));
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    window.addEventListener("team-room-seen", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("team-room-seen", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return count;
}
