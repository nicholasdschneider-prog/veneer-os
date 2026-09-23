// Isolated fixtures only: never contacts teammates, providers, or business systems.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {BotConversationRail} from '/src/components/BotConversationRail.tsx';
import {TeamMessages} from '/src/screens/TeamMessages.tsx';
import '/src/styles.css';
const h=React.createElement;function Fixture(){const [hash,setHash]=React.useState('#/bots');const restricted=new URLSearchParams(location.search).has('restricted');return h('main',{style:{height:'100dvh'}},hash.startsWith('#/messages/')?h(TeamMessages,{roomId:hash.split('/')[2].split('?')[0],fromBots:true,restricted,onNavigate:setHash}):h(BotConversationRail,{restricted,onNavigate:setHash}));}ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));`;
const vite = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  server: {
    host: "127.0.0.1",
    port: 3299,
    strictPort: true,
    preTransformRequests: false,
  },
  plugins: [
    {
      name: "fixture",
      configureServer(s) {
        s.middlewares.use("/__fixture", async (req, res) => {
          res.setHeader(
            "Content-Type",
            req.url?.includes("entry") ? "application/javascript" : "text/html",
          );
          res.end(
            req.url?.includes("entry")
              ? source
              : await s.transformIndexHtml(
                  "/__fixture",
                  '<html data-color-mode="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>',
                ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const output = new URL("../docs/reports/inline-groups/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
const people = [
  { key: "user:1", name: "Alex", kind: "human" },
  { key: "user:2", name: "Ali", kind: "human" },
];
const bots = ["Fila", "Daisy"].map((name) => ({
  key: "bot:" + name,
  name,
  kind: "bot",
}));
try {
  for (const width of [320, 375, 414, 768, 1280])
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let created = null,
        huddleCalls = 0;
      const old = {
        id: "old",
        kind: "group",
        team_id: "team",
        name: "Operations",
        updated_at: "2026-09-22 10:00:00",
        members: [...people, ...bots],
        unread: 2,
        last_message: { text: "Actual shared context" },
      };
      const huddle = {
        id: "coord",
        goal: "Resolve supplier issue",
        status: "open",
        status_note: "Waiting for evidence",
        lead: { conversation_id: "Fila", name: "Fila" },
        owner: { conversation_id: "Daisy", name: "Daisy" },
        member_count: 3,
        open_action_count: 1,
        updated_at: "2026-09-21",
        my_unread: 0,
      };
      await page.addInitScript(() =>
        localStorage.setItem("veneer:selected-business", "team"),
      );
      await page.route("**/api/**", async (route) => {
        const req = route.request(),
          u = new URL(req.url());
        let body = {};
        if (u.pathname === "/api/bots")
          body = {
            bots: bots.map((b, i) => ({
              conversation_id: b.name,
              name: b.name,
              state: "idle",
              questions: 0,
              updated_at: i ? "2026-09-20" : "2026-09-23",
              can_manage: false,
            })),
            teams: [{ id: "team", name: "Fixture Business" }],
          };
        else if (u.pathname === "/api/huddles") {
          huddleCalls++;
          body = { huddles: [huddle] };
        } else if (u.pathname === "/api/team-rooms/directory")
          body = {
            self_key: "user:1",
            teams: [
              {
                id: "team",
                name: "Fixture Business",
                can_create: true,
                people,
                bots,
              },
            ],
          };
        else if (u.pathname === "/api/team-rooms" && req.method() === "POST") {
          const p = req.postDataJSON();
          assert.deepEqual(p.members, ["bot:Fila", "bot:Daisy"]);
          created = {
            id: "new",
            team_id: "team",
            kind: "group",
            name: p.name,
            updated_at: "2026-09-24",
            members: [people[0], ...bots],
            revision: 1,
            last_seq: 0,
            unread: 0,
            can_manage: true,
            can_send: true,
            messages: [],
            next: null,
            self_key: "user:1",
          };
          body = { room: created };
        } else if (u.pathname === "/api/team-rooms")
          body = {
            rooms: [
              old,
              ...(created ? [created] : []),
              {
                ...old,
                id: "other",
                team_id: "other",
                name: "Other business group",
              },
            ],
          };
        else if (req.method() === "PATCH") {
          const p = req.postDataJSON();
          assert.equal(p.expected_revision, created.revision);
          created = {
            ...created,
            name: p.name ?? created.name,
            revision: created.revision + 1,
          };
          body = { ok: true };
        } else if (u.pathname.endsWith("/seen")) body = { ok: true };
        else if (u.pathname === "/api/team-rooms/new") body = { room: created };
        else
          throw new Error(
            "Unexpected fixture request " + req.method() + " " + u.pathname,
          );
        await route.fulfill({ json: body });
      });
      await page.goto("http://127.0.0.1:3299/__fixture");
      await page.evaluate(
        (t) => document.documentElement.setAttribute("data-color-mode", t),
        theme,
      );
      await page.getByRole("button", { name: /Operations/ }).waitFor();
      assert.equal(await page.getByText("Other business group").count(), 0);
      assert.equal(
        await page
          .getByRole("button", { name: "Huddles", exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: /Resolve supplier issue/ })
        .waitFor();
      await page.getByLabel("2 unread messages").waitFor();
      const order = await page
        .locator('nav[aria-label="Bots"] > *')
        .allTextContents();
      assert(
        order.findIndex((x) => x.includes("Operations")) <
          order.findIndex((x) => x.includes("Resolve supplier")),
      );
      await page.screenshot({ path: output + `list-${width}-${theme}.png` });
      await page
        .getByRole("button", { name: "New group chat", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add Fila (bot)", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add Daisy (bot)", exact: true })
        .click();
      await page.getByRole("button", { name: "Remove Daisy" }).click();
      await page
        .getByRole("button", { name: "Add Daisy (bot)", exact: true })
        .click();
      await page.screenshot({ path: output + `picker-${width}-${theme}.png` });
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Back to members" }).click();
      await page.getByRole("button", { name: "Remove Fila" }).waitFor();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.screenshot({ path: output + `name-${width}-${theme}.png` });
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page
        .locator("header")
        .getByRole("button", { name: /Fila, Daisy.*members/ })
        .click();
      await page
        .getByRole("button", { name: "Rename group", exact: true })
        .waitFor();
      await page.waitForTimeout(200);
      await page.screenshot({ path: output + `info-${width}-${theme}.png` });
      await page
        .getByRole("button", { name: "Rename group", exact: true })
        .click();
      await page
        .getByLabel("Group name", { exact: true })
        .fill("Customer Service");
      await page
        .getByRole("button", { name: "Save group", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add member", exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Back to bots" }).click();
      await page.getByRole("button", { name: /Customer Service/ }).waitFor();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.deepEqual(errors, []);
      assert(huddleCalls > 0);
      await page.goto("http://127.0.0.1:3299/__fixture?restricted=1");
      const before = huddleCalls;
      await page.getByRole("button", { name: /Operations/ }).waitFor();
      assert.equal(huddleCalls, before);
      assert.equal(
        await page
          .getByRole("button", { name: /Resolve supplier issue/ })
          .count(),
        0,
      );
      await page.close();
      console.log("PASS", width, theme);
    }
} finally {
  await browser.close();
  await vite.close();
}
