// Full application fixtures; all APIs and chat WebSockets isolated from production.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const vite = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 3299, strictPort: true },
});
await vite.listen();
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const restricted = process.env.CHAT_FIXTURE_RESTRICTED === "1";
const output = new URL("../docs/reports/desktop-chats/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
try {
  for (const width of (restricted ? [375, 1280] : [320, 375, 414, 768, 1280, 1440, 1920]))
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.log("PAGE ERROR", e.stack);
      });
      let org = {
          revision: 0,
          groups: [{ id: "support", name: "Customer Service" }],
          placements: { bot0: "support" },
          fallback: "Unassigned",
        },
        fail = false;
      const bots = Array.from({ length: 26 }, (_, i) => ({
        conversation_id: "bot" + i,
        name: i === 0 ? "Goldberg" : "Bot " + i,
        title: i === 0 ? "Accounting" : "Support",
        questions: i === 1 ? 2 : 0,
        state: "idle",
        unread: i === 0,
        updated_at: "2026-09-23",
        last_reply: {
          text:
            i === 0
              ? "Got it. Stopping until you say otherwise."
              : "The latest completed response with context for this item.",
          at: "2026-09-23",
        },
        membership: {
          subteam: i === 0 ? "Customer Service" : "",
          role: "specialist",
        },
      }));
      await page.addInitScript(() =>
        localStorage.setItem("veneer:selected-business", "team"),
      );
      await page.route("**/api/**", async (route) => {
        const req = route.request(),
          p = new URL(req.url()).pathname;
        let body = {};
        if (p === "/api/me")
          body = {
            setupRequired: false,
            pending: false,
            user: {
              id: 1,
              email: "fixture@example.test",
              displayName: "Alex",
              role: restricted ? "member" : "owner",
              employeeWorkspace: restricted,
            },
          };
        else if (p === "/api/bots")
          body = {
            bots,
            teams: [{ id: "team", name: "Fixture Business" }],
            decisions: [],
          };
        else if (p === "/api/bots/organization") {
          if (req.method() === "POST") {
            if (fail) {
              fail = false;
              return route.fulfill({
                status: 409,
                json: { error: "Organization changed. Reload and try again." },
              });
            }
            const b = req.postDataJSON();
            assert.equal(b.expected_revision, org.revision);
            org = { ...b.definition, revision: org.revision + 1 };
          }
          body = org;
        } else if (p === "/api/navigation")
          body = { configured: false, navigation: { items: [] } };
        else if (p === "/api/page-brand") body = { brand: {} };
        else if (p === "/api/huddles") body = { huddles: [] };
        else if (p === "/api/team-rooms") body = { rooms: [] };
        else if (p === "/api/team-rooms/directory")
          body = { self_key: "user:1", teams: [] };
        else if (p === "/api/projects") body = { projects: [] };
        else if (
          p === "/api/conversations" ||
          p === "/api/recent-conversations"
        )
          body = { conversations: [] };
        else if (/^\/api\/conversations\/bot\d+$/.test(p)) {
          const id = p.split("/").at(-1);
          body = {
            conversation: {
              id,
              title: "Goldberg",
              isBot: true,
              visibility: "team",
              canSend: true,
              canManage: true,
              canChangeVisibility: true,
              creator: { id: 1, displayName: "Alex" },
              model: null,
              effort: null,
              approvalMode: null,
              effectiveApprovalMode: "default",
              fullAccess: false,
              channel: "web",
              assistantSlug: "assistant",
              assistantName: "Assistant",
              projectId: null,
              originConversationId: null,
              archived: false,
              pinOrder: null,
              contextTokens: null,
              status: "idle",
              activity: null,
              unread: false,
              hasPendingWakeup: false,
              automation: null,
              provider: "claude",
              assistantId: 1,
              workspaceDir: "/fixture",
              businessTeamId: "team",
              botName: "Goldberg",
              createdAt: "2026-09-23",
              updatedAt: "2026-09-23",
            },
          };
        } else if (p === "/api/assistants")
          body = {
            assistants: [{ id: 1, name: "Assistant", slug: "assistant" }],
          };
        else if (p === "/api/models") body = { models: [] };
        else if (p.includes("/threads")) body = { threads: [] };
        else if (p.includes("/sessions")) body = { sessions: [] };
        else if (p.includes("/bot-communication/chats/"))
          body = { drafts: [], briefings: [] };
        else if (p.includes("/connectors")) body = { connectors: [] };
        else if (p.includes("/model-prefs")) body = { prefs: {} };
        else
          return route.fulfill({
            status: 404,
            json: { error: "Not present in fixture" },
          });
        await route.fulfill({ json: body });
      });
      await page.routeWebSocket("**/ws", (ws) =>
        ws.onMessage((raw) => {
          const p = JSON.parse(String(raw));
          if (p.kind === "subscribe")
            ws.send(
              JSON.stringify({
                kind: "snapshot",
                conversationId: p.conversationId,
                status: "idle",
                queue: { revision: 0, messages: [], failedTurn: null },
                wakeups: [],
                events: Array.from({ length: 35 }, (_, i) => [
                  {
                    type: "turn_started",
                    turnId: "t" + i,
                    role: "user",
                    text: "Review fixture item " + i,
                    at: "2026-09-23T12:00:00Z",
                    via: "web",
                  },
                  {
                    type: "text_final",
                    turnId: "t" + i,
                    markdown:
                      "The requested review is complete. This is a fixture response with enough detail to check message layout and scrolling.\n\nThe proposed next step remains subject to the existing approval process.",
                    at: "2026-09-23T12:01:00Z",
                  },
                ]).flat(),
              }),
            );
        }),
      );
      await page.goto("http://127.0.0.1:3299/#/bots");
      await page.evaluate(
        (t) => document.documentElement.setAttribute("data-color-mode", t),
        theme,
      );
      const rail = page.getByRole("complementary", { name: "Chats" });
      await rail
        .getByText("Got it. Stopping until you say otherwise.")
        .waitFor();
      if (width >= 768) {
        const b = await rail.boundingBox();
        assert(b.x < 100);
        assert(b.width < 530);
        assert(b.height > 850);
      }
      await page.screenshot({ path: output + `${restricted ? "employee-" : ""}list-${width}-${theme}.png` });
      await page
        .getByRole("button", { name: "Organize bots", exact: true })
        .click();
      await page.getByLabel("New group name").fill("Priority");
      await page
        .getByRole("button", { name: "Add group", exact: true })
        .click();
      await page.getByLabel("Group name: Priority").waitFor();
      await page
        .getByLabel("Move Goldberg to")
        .selectOption({ label: "Priority" });
      await page.waitForFunction(
        () =>
          !document.querySelector('select[aria-label="Move Goldberg to"]')
            ?.disabled,
      );
      await page.getByLabel("Group name: Customer Service").fill("Care");
      await page
        .getByRole("button", { name: "Rename", exact: true })
        .first()
        .click();
      await page.getByLabel("Group name: Care").waitFor();
      await page.getByLabel("Delete group Care").click();
      await page.getByLabel("Delete group Unassigned").click();
      await page
        .getByRole("button", { name: "Show ungrouped heading" })
        .waitFor();
      await page.screenshot({
        path: output + `${restricted ? "employee-" : ""}organize-${width}-${theme}.png`,
      });
      await page.keyboard.press("Escape");
      await page.reload();
      await page.getByRole("button", { name: /^Priority/ }).waitFor();
      assert.equal(org.placements.bot0, org.groups[0].id);
      if (width >= 768) {
        const data = await page.evaluateHandle(() => new DataTransfer());
        await rail
          .getByRole("button", { name: /Bot 1Support/ })
          .dispatchEvent("dragstart", { dataTransfer: data });
        await page
          .locator("[data-chat-group]")
          .filter({ has: page.getByRole("button", { name: /^Priority/ }) })
          .dispatchEvent("drop", { dataTransfer: data });
        await page.waitForTimeout(200);
        assert.equal(org.placements.bot1, org.groups[0].id);
      }
      await page
        .getByRole("button", { name: "Organize bots", exact: true })
        .click();
      fail = true;
      await page.getByLabel("Move Goldberg to").selectOption("");
      await page
        .getByRole("alert")
        .filter({ hasText: "Organization changed" })
        .first()
        .waitFor();
      assert.equal(org.placements.bot0, org.groups[0].id);
      await page.getByLabel("Move Goldberg to").selectOption(org.groups[0].id);
      await page
        .getByRole("alert")
        .filter({ hasText: "Organization changed" })
        .first()
        .waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await rail.getByRole("button", { name: /GoldbergAccounting/ }).click();
      await page.locator(".conversation-surface").waitFor();
      await page
        .getByText("The requested review is complete.", { exact: false })
        .first()
        .waitFor();
      const surface = await page.locator(".conversation-surface").boundingBox();
      if (width >= 1280) assert(surface.width > width - 650);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      if (width >= 768) {
        const bounds = await page.evaluate(() => {
          const surface = document.querySelector(".conversation-surface");
          const header =
            surface.querySelector("header") ?? surface.firstElementChild;
          const composer =
            surface.querySelector("textarea") ??
            surface.querySelector("[contenteditable]");
          return {
            header: header.getBoundingClientRect().top,
            composer: composer?.getBoundingClientRect().bottom,
            document: document.documentElement.scrollHeight,
            height: innerHeight,
          };
        });
        assert(bounds.header >= 0);
        assert(bounds.document <= bounds.height + 1);
        if (bounds.composer) assert(bounds.composer <= 1000);
        const before = await rail.boundingBox();
        await rail
          .locator("nav")
          .evaluate((e) => (e.scrollTop = e.scrollHeight));
        assert.equal((await rail.boundingBox()).y, before.y);
        await rail.locator("nav").evaluate((e) => (e.scrollTop = 0));
      }

      await page.screenshot({
        path: output + `${restricted ? "employee-" : ""}conversation-${width}-${theme}.png`,
      });
      assert.deepEqual(errors, []);
      await page.close();
      console.log("PASS", width, theme);
    }
} finally {
  await browser.close();
  await vite.close();
}
