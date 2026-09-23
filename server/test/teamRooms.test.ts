import { createConversationManager } from "../src/runtime/conversationManager.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../src/db/migrate.js";
import type {
  UserRow,
  ConversationWakeupRow,
  ConversationRow,
} from "../src/db/db.js";
import {
  createRoomService,
  roomWakeAllowed,
  queuedRoomWakeAllowed,
  type RoomActor,
} from "../src/rooms/service.js";
import {
  canViewConversation,
  businessScopeSql,
} from "../src/conversations/access.js";
import { employeeRouteAllowed } from "../src/bots/employeeAccess.js";
import { createConversationWakeupScheduler } from "../src/scheduled/wakeups.js";
import { callRoomTool } from "../src/mcp/roomTools.js";
describe("private team rooms", () => {
  let db: Database.Database,
    s: ReturnType<typeof createRoomService>,
    owner: RoomActor,
    ali: RoomActor,
    other: RoomActor;
  const user = (id: number) => ({
    user: db.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow,
  });
  const create = (members = ["user:2", "bot:bot-a"]) =>
    s.create(owner, {
      team_id: "one",
      kind: "group",
      name: "Support",
      members,
      request_key: crypto.randomUUID(),
    });
  const post = (id: string, a = owner, extra = {}) =>
    s.post(a, id, {
      text: "Please review the attached context.",
      request_key: crypto.randomUUID(),
      ...extra,
    });
  const wakes = () =>
    db
      .prepare("SELECT * FROM conversation_wakeups")
      .all() as ConversationWakeupRow[];
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys=ON");
    migrate(
      db,
      fileURLToPath(new URL("../src/db/migrations", import.meta.url)),
    );
    for (let id = 1; id <= 5; id++)
      db.prepare(
        "INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,?)",
      ).run(
        id,
        `fixture${id}@example.test`,
        id === 2 ? "Ali" : `Person ${id}`,
        id === 1 ? "owner" : "member",
      );
    db.prepare(
      "INSERT INTO business_teams(id,name,owner_id) VALUES('one','First business',1),('two','Other business',3)",
    ).run();
    db.prepare(
      "INSERT INTO business_team_members(team_id,user_id,role) VALUES('one',2,'member'),('one',4,'member'),('one',5,'viewer')",
    ).run();
    for (const id of ["bot-a", "bot-b"]) {
      db.prepare(
        "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team','one')",
      ).run(id, id, id);
      db.prepare(
        "INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)",
      ).run(id, id);
    }
    owner = user(1);
    ali = user(2);
    other = user(3);
    s = createRoomService(db);
  });
  afterEach(() => db.close());
  it("uses active business IDs and distinguishes humans/bots", () => {
    expect(s.directory(ali).teams[0]!.people.map((p) => p.key)).not.toContain(
      "user:3",
    );
    expect(s.directory(ali).teams[0]!.bots).toHaveLength(2);
    db.prepare("UPDATE users SET status='disabled' WHERE id=4").run();
    expect(s.directory(owner).teams[0]!.people.map((p) => p.key)).not.toContain(
      "user:4",
    );
  });
  it("reuses one DM per pair and rejects changed request identities", () => {
    const p = {
      team_id: "one",
      kind: "dm",
      name: "DM",
      members: ["user:2"],
      request_key: "same",
    };
    const r = s.create(owner, p);
    expect(
      s.create(ali, { ...p, members: ["user:1"], request_key: "reverse" }).id,
    ).toBe(r.id);
    expect(() => s.create(owner, { ...p, members: ["user:4"] })).toThrow(
      "key already",
    );
    expect(s.list(other)).toEqual([]);
    expect(() => s.read(other, r.id)).toThrow("not found");
  });
  it("rejects cross-business members and bots in human DMs", () => {
    expect(() => create(["user:3"])).toThrow();
    expect(() =>
      s.create(owner, {
        team_id: "one",
        kind: "dm",
        name: "DM",
        members: ["bot:bot-a"],
        request_key: "x",
      }),
    ).toThrow("two people");
  });
  it("keeps human-only messages quiet and sends idempotently", () => {
    const r = create();
    const p = { text: "Hello Ali", request_key: "once" };
    const first = s.post(owner, r.id, p);
    expect(s.post(owner, r.id, p)).toEqual({ ...first, duplicate: true });
    expect(wakes()).toHaveLength(0);
    expect(() => s.post(owner, r.id, { ...p, text: "different" })).toThrow(
      "key already",
    );
    expect(s.read(ali, r.id).messages).toHaveLength(1);
  });
  it("routes mentions once with human attribution in an isolated provider session", () => {
    const r = create();
    const p = {
      text: "@bot-a please summarize",
      mentions: ["bot:bot-a"],
      request_key: "mention",
    };
    s.post(ali, r.id, p);
    s.post(ali, r.id, p);
    const w = wakes()[0]!;
    expect(wakes()).toHaveLength(1);
    expect(w.conversation_id).not.toBe("bot-a");
    expect(w.actor_user_id).toBe(2);
    expect(w.reason).not.toContain(p.text);
    expect(roomWakeAllowed(db, w)).toBe(true);
    const actor = { ...ali, conversationId: w.conversation_id };
    expect(s.read(actor, r.id).messages).toHaveLength(1);
    post(r.id, actor, { text: "Summary from the room" });
    const message = s.read(ali, r.id).messages[1] as unknown as {
      author_key: string;
    };
    expect(message.author_key).toBe("bot:bot-a");
    expect(wakes()).toHaveLength(1);
    expect(() => post(r.id, actor, { everyone: true })).toThrow("do not wake");
  });
  it("does not expose worker transcripts or read room text from the original bot", () => {
    const r = create();
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    const w = wakes()[0]!;
    const c = db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get(w.conversation_id) as ConversationRow;
    expect(canViewConversation(owner.user, c, db)).toBe(false);
    expect(
      db
        .prepare(`SELECT id FROM conversations c WHERE ${businessScopeSql(1)}`)
        .all(),
    ).toHaveLength(2);
    expect(() => s.read({ ...owner, conversationId: "bot-a" }, r.id)).toThrow(
      "isolated",
    );
    expect(c.native_session_id).not.toBe("bot-a");
    expect(c.approval_mode).toBe("ask");
  });
  it("cannot use a worker to read or reply in another group", () => {
    const r = create(),
      r2 = create();
    post(r.id, owner, { mentions: ["bot:bot-a"] });
    const a = { ...owner, conversationId: wakes()[0]!.conversation_id };
    expect(() => s.read(a, r2.id)).toThrow();
    expect(() => post(r2.id, a)).toThrow();
    expect(s.list(a).map((r) => r.id)).toEqual([r.id]);
  });
  it("checks removed humans, stale membership versions and bot rejoin epochs", () => {
    const r = create();
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    const w = wakes()[0]!;
    s.update(owner, r.id, {
      expected_revision: 1,
      members: ["user:1", "bot:bot-a"],
    });
    expect(() => s.read(ali, r.id)).toThrow();
    expect(roomWakeAllowed(db, w)).toBe(false);
    expect(() =>
      s.update(owner, r.id, { expected_revision: 1, name: "Stale" }),
    ).toThrow("Refresh");
    s.update(owner, r.id, {
      expected_revision: 2,
      members: ["user:1", "user:2"],
    });
    s.update(owner, r.id, {
      expected_revision: 3,
      members: ["user:1", "user:2", "bot:bot-a"],
    });
    expect(roomWakeAllowed(db, w)).toBe(false);
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    expect(wakes()[1]!.conversation_id).not.toBe(w.conversation_id);
    expect(() =>
      s.read({ ...ali, conversationId: w.conversation_id }, r.id),
    ).toThrow();
  });
  it("keeps restricted employee bot scope and cancels revocations", () => {
    db.prepare("INSERT INTO employee_workspaces(user_id) VALUES(2)").run();
    expect(() => create()).toThrow("Each person");
    db.prepare(
      "INSERT INTO employee_bot_access(user_id,conversation_id) VALUES(2,'bot-a')",
    ).run();
    const r = create();
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    const w = wakes()[0]!;
    expect(roomWakeAllowed(db, w)).toBe(true);
    db.prepare("DELETE FROM employee_bot_access WHERE user_id=2").run();
    expect(() => s.read(ali, r.id)).toThrow("access");
    expect(roomWakeAllowed(db, w)).toBe(false);
  });
  it("supports unread and seen state without clearing other users", () => {
    const r = create(["user:2"]);
    post(r.id);
    expect(s.list(ali)[0]!.unread).toBe(1);
    expect(s.list(owner)[0]!.unread).toBe(0);
    s.seen(ali, r.id, 999);
    post(r.id);
    expect(s.list(ali)[0]!.unread).toBe(1);
    s.seen(ali, r.id, 0);
    expect(s.list(ali)[0]!.unread).toBe(1);
  });
  it("enforces viewer read-only and group creator edit rules", () => {
    const r = create(["user:2", "user:5"]);
    expect(s.read(user(5), r.id).can_send).toBe(false);
    expect(() => post(r.id, user(5))).toThrow();
    expect(() =>
      s.update(ali, r.id, { expected_revision: 1, name: "No" }),
    ).toThrow("creator");
    expect(() =>
      s.update(owner, r.id, { expected_revision: 1, leave: true }),
    ).toThrow("remain");
    s.update(ali, r.id, { expected_revision: 1, leave: true });
    expect(() => s.read(ali, r.id)).toThrow();
  });
  it("guards attachment ownership, room boundary and removed members", () => {
    const r = create(["user:2"]),
      r2 = create(["user:4"]);
    db.prepare(
      "INSERT INTO team_room_files(id,room_id,uploader_key,name,storage_path,size) VALUES('file',?,'user:1','fixture.txt','/fixture/opaque',5)",
    ).run(r.id);
    expect(() => s.file(ali, r.id, "file")).toThrow();
    expect(() => post(r2.id, owner, { attachments: ["file"] })).toThrow();
    post(r.id, owner, { attachments: ["file"] });
    expect(s.file(ali, r.id, "file")).not.toHaveProperty("path");
    s.update(owner, r.id, { expected_revision: 1, members: ["user:1"] });
    expect(() => s.file(ali, r.id, "file")).toThrow();
  });
  it("persists messages and wake validation across service reconstruction", () => {
    const r = create();
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    s = createRoomService(db);
    expect(s.read(ali, r.id).messages).toHaveLength(1);
    expect(roomWakeAllowed(db, wakes()[0]!)).toBe(true);
    db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();
    expect(roomWakeAllowed(db, wakes()[0]!)).toBe(false);
  });
  it("allows only narrow employee room routes", () => {
    for (const [method, path] of [
      ["GET", "/team-rooms"],
      ["GET", "/team-rooms/directory"],
      ["POST", "/team-rooms/room/messages"],
      ["PATCH", "/team-rooms/room"],
      ["GET", "/team-rooms/room/files/file"],
    ])
      expect(employeeRouteAllowed(method!, path!)).toBe(true);
    expect(employeeRouteAllowed("DELETE", "/team-rooms/room")).toBe(false);
    expect(employeeRouteAllowed("POST", "/team-rooms/room/admin")).toBe(false);
  });
  it("maps bot room tools to the same authorized REST path", async () => {
    const calls: unknown[] = [];
    const callApi = async (path: string, init?: RequestInit) => {
      calls.push([path, init?.body]);
      return { ok: true };
    };
    await callRoomTool({
      name: "post_team_room_message",
      args: { room_id: "room", text: "Result", request_key: "same" },
      callApi,
    });
    expect(calls).toEqual([
      [
        "/api/team-rooms/room/messages",
        JSON.stringify({ text: "Result", request_key: "same" }),
      ],
    ]);
  });
  it("delivers pending mentions once after scheduler reconstruction and rejects queued stale work", () => {
    const r = create();
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    const w = wakes()[0]!;
    const calls: string[] = [];
    const scheduler = () =>
      createConversationWakeupScheduler({
        db,
        now: () => new Date(Date.now() + 10000),
        manager: {
          deliverWakeup: (_c, _text, id) => {
            calls.push(id);
            return {
              disposition: "queued",
              messageId: 1,
              queue: { messages: [], revision: 0 },
            } as never;
          },
        },
        log: { info() {}, warn() {}, error() {} },
      });
    scheduler().tick();
    scheduler().tick();
    expect(calls).toEqual([w.id]);
    db.prepare(
      "INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES(?,?,?,'wakeup')",
    ).run("wakeup:" + w.id, w.conversation_id, 42);
    expect(queuedRoomWakeAllowed(db, w.conversation_id, 42)).toBe(true);
    s.update(owner, r.id, {
      expected_revision: 1,
      members: ["user:1", "user:2"],
    });
    expect(queuedRoomWakeAllowed(db, w.conversation_id, 42)).toBe(false);
  });
  it("runs a durable room wake with the real manager without recalling or capturing private memory", async () => {
    const runs: string[] = [];
    const recall = vi.fn(),
      capture = vi.fn();
    const adapter: ProviderAdapter = {
      id: "claude",
      mintSessionId: () => "",
      readTranscript: async () => [],
      runTurn(spec, onEvent) {
        runs.push(spec.conversationId!);
        onEvent({
          type: "text_final",
          turnId: spec.turnId,
          markdown: "Room-only reply",
          at: new Date().toISOString(),
        });
        onEvent({ type: "turn_done", turnId: spec.turnId });
        return {
          done: Promise.resolve(),
          kill() {},
          respondToApproval: () => true,
        };
      },
    };
    const manager = createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({
        workspaceDir: "/tmp",
        assistantSlug: "assistant",
        elevated: false,
        fullAccess: false,
      }),
      loadMemoryBlock: recall,
      captureMemoryTurn: capture,
      log: { warn() {}, error() {} },
    });
    const scheduler = createConversationWakeupScheduler({
      db,
      manager,
      log: { info() {}, warn() {}, error() {} },
    });
    try {
      const r = create();
      post(r.id, ali, { mentions: ["bot:bot-a"] });
      db.prepare(
        "UPDATE conversation_wakeups SET scheduled_for=datetime('now','-1 minute')",
      ).run();
      scheduler.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      expect(runs[0]).toBe(wakes()[0]!.conversation_id);
      expect(runs[0]).not.toBe("bot-a");
      expect(recall).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      manager.shutdown();
      await new Promise((r) => setImmediate(r));
    }
  });
  it("caps explicit bot requests and rolls back a rate-limited message", () => {
    const r = create();
    for (let i = 0; i < 10; i++) post(r.id, ali, { mentions: ["bot:bot-a"] });
    expect(() => post(r.id, ali, { mentions: ["bot:bot-a"] })).toThrow(
      "10 requests",
    );
    expect(s.read(ali, r.id).messages).toHaveLength(10);
    expect(wakes()).toHaveLength(10);
  });
  it("reopens an idle archived internal session only after a new authorized mention", () => {
    const r = create();
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    const worker = wakes()[0]!.conversation_id;
    db.prepare("UPDATE conversations SET archived=1 WHERE id=?").run(worker);
    post(r.id, ali, { mentions: ["bot:bot-a"] });
    expect(
      db.prepare("SELECT archived FROM conversations WHERE id=?").get(worker),
    ).toEqual({ archived: 0 });
    expect(wakes()[1]!.conversation_id).toBe(worker);
  });
});
