import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/db/migrate.js";
import {
  createOrganizationService,
  latestBotPreview,
} from "../src/bots/organization.js";
import type { UserRow } from "../src/db/db.js";
import { employeeRouteAllowed } from "../src/bots/employeeAccess.js";
let db: Database.Database, s: ReturnType<typeof createOrganizationService>;
const user = (id: number) =>
  db.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrate(db, fileURLToPath(new URL("../src/db/migrations", import.meta.url)));
  for (let i = 1; i <= 2; i++)
    db.prepare(
      "INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'member')",
    ).run(i, `u${i}@example.test`, `User ${i}`);
  for (const id of ["a", "b"]) {
    db.prepare(
      "INSERT INTO conversations(id,assistant_id,user_id,provider,native_session_id,visibility) VALUES(?,1,?,'claude','fixture','private')",
    ).run(id, id === "a" ? 1 : 2);
    db.prepare(
      "INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)",
    ).run(id, id);
  }
  s = createOrganizationService(db);
});
afterEach(() => db.close());
it("persists personal organization, rejects stale writes, retains bots when deleting groups", () => {
  let d = s.get(user(1), "");
  expect(d.revision).toBe(0);
  d = s.save(user(1), "", {
    expected_revision: 0,
    definition: {
      ...d,
      groups: [{ id: "g", name: "Support" }],
      placements: { a: "g" },
    },
  });
  expect(d.revision).toBe(1);
  expect(s.get(user(2), "").groups).toEqual([]);
  expect(() =>
    s.save(user(1), "", { expected_revision: 0, definition: d }),
  ).toThrow("changed");
  s.save(user(1), "", {
    expected_revision: 1,
    definition: { groups: [], placements: { a: "" }, fallback: null },
  });
  expect(s.get(user(1), "").fallback).toBeNull();
  expect(
    db
      .prepare("SELECT active FROM bot_registrations WHERE conversation_id=?")
      .get("a"),
  ).toEqual({ active: 1 });
});
it("rejects inaccessible bots, unknown groups and cross-business placements", () => {
  const d = {
    groups: [{ id: "g", name: "Support" }],
    placements: { b: "g" },
    fallback: "Unassigned",
  };
  expect(() =>
    s.save(user(1), "", { expected_revision: 0, definition: d }),
  ).toThrow("not available");
  expect(() =>
    s.save(user(1), "", {
      expected_revision: 0,
      definition: { ...d, placements: { a: "missing" } },
    }),
  ).toThrow("Unknown group");
  expect(() =>
    s.save(user(1), "other", {
      expected_revision: 0,
      definition: { ...d, placements: { a: "g" } },
    }),
  ).toThrow("not available");
});
it("removes revoked bot placements and allows only narrow employee routes", () => {
  s.save(user(1), "", {
    expected_revision: 0,
    definition: { groups: [], placements: { a: "" }, fallback: "Unassigned" },
  });
  db.prepare("UPDATE conversations SET user_id=2 WHERE id=?").run("a");
  expect(s.get(user(1), "").placements).toEqual({});
  expect(employeeRouteAllowed("GET", "/bots/organization")).toBe(true);
  expect(employeeRouteAllowed("POST", "/bots/organization")).toBe(true);
  expect(employeeRouteAllowed("DELETE", "/bots/organization")).toBe(false);
});
it("previews only completed assistant documents, bounded and plain text", () => {
  const insert = db.prepare(
    "INSERT INTO bot_search_documents(id,conversation_id,kind,body,at,href) VALUES(?,?,?,?,?,?)",
  );
  insert.run(
    "1",
    "a",
    "assistant",
    "**Got it.**\n[Stopping](https://example.test) until you say otherwise.",
    "2026-09-23T01:00:00Z",
    "#",
  );
  insert.run(
    "2",
    "a",
    "user",
    "Do not show user message",
    "2026-09-23T02:00:00Z",
    "#",
  );
  insert.run(
    "3",
    "b",
    "assistant",
    "Private other result",
    "2026-09-23T03:00:00Z",
    "#",
  );
  expect(latestBotPreview(db, "a")?.text).toBe(
    "Got it. Stopping until you say otherwise.",
  );
  expect(latestBotPreview(db, "missing")).toBeNull();
});
