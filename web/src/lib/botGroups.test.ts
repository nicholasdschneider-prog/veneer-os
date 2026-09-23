import { describe, it, expect } from "vitest";
import { mergeBotGroups, type BotGroup } from "./botGroups";
import type { Bot } from "./bots";
const bot = (name: string, date: string, pinned = false) =>
  ({ name, conversation_id: name, updated_at: date, pinned }) as Bot;
const group = (kind: "room" | "huddle", name: string, date: string) =>
  ({
    kind,
    id: name,
    name,
    updated_at: date,
    preview: "Actual context",
    unread: 1,
    members: [],
  }) as BotGroup;
describe("unified bot conversations", () => {
  it("keeps personal pins first and interleaves both group types by actual activity", () => {
    const entries = mergeBotGroups(
      [
        bot("Old", "2026-09-20"),
        bot("Pinned", "2026-09-01", true),
        bot("Recent", "2026-09-23"),
      ],
      [
        group("room", "Room", "2026-09-22"),
        group("huddle", "Huddle", "2026-09-21"),
      ],
    );
    expect(
      entries.map((e) => (e.kind === "bot" ? e.bot.name : e.name)),
    ).toEqual(["Pinned", "Recent", "Room", "Huddle", "Old"]);
  });
  it("searches bot names and group context without conflating identical identifiers", () => {
    const groups = [group("room", "same", ""), group("huddle", "same", "")];
    expect(mergeBotGroups([bot("same", "")], groups)).toHaveLength(3);
    expect(
      mergeBotGroups([bot("same", "")], groups, "context").map((e) => e.kind),
    ).toEqual(["room", "huddle"]);
    expect(mergeBotGroups([], groups, "missing")).toEqual([]);
  });
});
