import Database from "better-sqlite3";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, it, expect } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createRoomsRouter } from "../src/rooms/routes.js";
import { createRoomService } from "../src/rooms/service.js";
import { employeeApiBoundary } from "../src/bots/employeeAccess.js";
import type { UserRow } from "../src/db/db.js";
import type { AppContext } from "../src/context.js";
let db: Database.Database, server: Server, url: string, folder: string;
beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrate(db, fileURLToPath(new URL("../src/db/migrations", import.meta.url)));
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "room-route-"));
  for (let id = 1; id <= 3; id++)
    db.prepare(
      "INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'member')",
    ).run(id, `test${id}@example.test`, `Person ${id}`);
  db.prepare(
    "INSERT INTO business_teams(id,name,owner_id) VALUES('team','Team',1)",
  ).run();
  db.prepare(
    "INSERT INTO business_team_members(team_id,user_id,role) VALUES('team',2,'member'),('team',3,'member')",
  ).run();
  db.prepare("INSERT INTO employee_workspaces(user_id) VALUES(2)").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(Number(req.header("X-Test-User") ?? 1)) as UserRow;
    req.agentConversationId = req.header("X-Test-Bot");
    next();
  });
  app.use(employeeApiBoundary(db));
  app.use(
    "/team-rooms",
    createRoomsRouter({ db, config: { dataDir: folder } } as AppContext),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  db.close();
  fs.rmSync(folder, { recursive: true, force: true });
});
const req = (
  route: string,
  method = "GET",
  body?: unknown,
  user = 1,
  bot?: string,
) =>
  fetch(url + route, {
    method,
    headers: {
      "X-Test-User": String(user),
      ...(bot ? { "X-Test-Bot": bot } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
async function group() {
  const r = await req("/team-rooms", "POST", {
    team_id: "team",
    kind: "group",
    name: "Fixture",
    members: ["user:2"],
    request_key: "new",
  });
  expect(r.status).toBe(200);
  return (await r.json()).room.id as string;
}
it("lets restricted employees read/send only rooms they belong to and rejects forged authors", async () => {
  const id = await group();
  expect((await req("/team-rooms/directory", "GET", undefined, 2)).status).toBe(
    200,
  );
  expect((await req("/team-rooms/" + id, "GET", undefined, 2)).status).toBe(
    200,
  );
  expect((await req("/team-rooms/" + id, "GET", undefined, 3)).status).toBe(
    404,
  );
  expect(
    (
      await req(
        `/team-rooms/${id}/messages`,
        "POST",
        { text: "Fixture", request_key: "one", author_key: "user:1" },
        2,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await req(
        `/team-rooms/${id}/messages`,
        "POST",
        { text: "Fixture", request_key: "one" },
        2,
      )
    ).status,
  ).toBe(200);
  const data = await (await req("/team-rooms/" + id)).json();
  expect(data.room.messages[0].author_key).toBe("user:2");
});
it("stores opaque attachments and gates downloads after removal", async () => {
  const id = await group();
  const upload = await fetch(`${url}/team-rooms/${id}/files?name=fixture.txt`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Test-User": "2" },
    body: "safe fixture",
  });
  expect(upload.status).toBe(200);
  const { file } = await upload.json();
  expect(file).not.toHaveProperty("path");
  expect((await req(file.url.replace("/api", ""))).status).toBe(404);
  await req(
    `/team-rooms/${id}/messages`,
    "POST",
    { text: "File", attachments: [file.id], request_key: "file" },
    2,
  );
  const download = await req(file.url.replace("/api", ""));
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await download.text()).toBe("safe fixture");
  await req(`/team-rooms/${id}`, "PATCH", {
    expected_revision: 1,
    members: ["user:1"],
  });
  expect(
    (await req(file.url.replace("/api", ""), "GET", undefined, 2)).status,
  ).toBe(404);
  expect((await req(`/team-rooms/${id}/files`, "POST", {}, 2)).status).toBe(
    404,
  );
});
it("allows employee-triggered worker replies only in room and denies outside API access", async () => {
  db.prepare(
    "INSERT INTO conversations(id,assistant_id,user_id,provider,native_session_id,visibility,business_team_id) VALUES('bot',1,1,'claude','bot','team','team')",
  ).run();
  db.prepare(
    "INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('bot','Support',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO employee_bot_access(user_id,conversation_id) VALUES(2,'bot')",
  ).run();
  const id = await group();
  await req(`/team-rooms/${id}`, "PATCH", {
    expected_revision: 1,
    members: ["user:1", "user:2", "bot:bot"],
  });
  await req(
    `/team-rooms/${id}/messages`,
    "POST",
    { text: "Summary?", mentions: ["bot:bot"], request_key: "mention" },
    2,
  );
  const worker = (
    db.prepare("SELECT conversation_id FROM team_room_workers").get() as {
      conversation_id: string;
    }
  ).conversation_id;
  expect(
    (await req(`/team-rooms/${id}`, "GET", undefined, 2, worker)).status,
  ).toBe(200);
  expect(
    (
      await req(
        `/team-rooms/${id}/messages`,
        "POST",
        { text: "Room summary", request_key: "answer" },
        2,
        worker,
      )
    ).status,
  ).toBe(200);
  expect(
    (await req("/conversations", "GET", undefined, 2, worker)).status,
  ).toBe(403);
  expect((await req("/team-rooms", "POST", {}, 2, worker)).status).toBe(403);
  db.prepare("DELETE FROM employee_bot_access WHERE user_id=2").run();
  expect(
    (
      await req(
        `/team-rooms/${id}/messages`,
        "POST",
        { text: "Stale reply", request_key: "late" },
        2,
        worker,
      )
    ).status,
  ).toBe(403);
});
it("previews images for authorized humans before and after an attachment-only send", async () => {
  const id = await group();
  const upload = await fetch(`${url}/team-rooms/${id}/files?name=pasted-image.png`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Test-User": "2" },
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'),
  });
  expect(upload.status).toBe(200);
  const { file } = await upload.json();
  const previewUrl = file.url.replace('/api', '') + '?inline=1';
  const staged = await req(previewUrl, 'GET', undefined, 2);
  expect(staged.status).toBe(200);
  expect(staged.headers.get('content-type')).toBe('image/png');
  expect(staged.headers.get('content-disposition')).toBe('inline');
  expect(staged.headers.get('x-content-type-options')).toBe('nosniff');
  expect((await req(previewUrl)).status).toBe(404);
  expect((await req(`/team-rooms/${id}/messages`, 'POST', {
    text: '', attachments: [file.id], request_key: 'image-only',
  }, 2)).status).toBe(200);
  expect((await req(previewUrl)).status).toBe(200);
  expect((await req(previewUrl, 'GET', undefined, 3)).status).toBe(404);
  const download = await req(file.url.replace('/api', ''));
  expect(download.headers.get('content-disposition')).toContain('attachment');
  await req(`/team-rooms/${id}`, 'PATCH', { expected_revision: 1, members: ['user:1'] });
  expect((await req(previewUrl, 'GET', undefined, 2)).status).toBe(404);
});
it("keeps active documents as downloads even when inline is requested", async () => {
  const id = await group();
  for (const name of ['page.html', 'image.svg']) {
    const response = await fetch(`${url}/team-rooms/${id}/files?name=${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: '<svg onload="alert(1)"></svg>',
    });
    const { file } = await response.json();
    const preview = await req(file.url.replace('/api', '') + '?inline=1');
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-disposition')).toContain('attachment');
    expect(preview.headers.get('content-type')).toBe('application/octet-stream');
  }
});
