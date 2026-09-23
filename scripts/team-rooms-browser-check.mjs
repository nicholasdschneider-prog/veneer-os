// Isolated fixtures only: never contacts teammates, providers, or business systems.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {TeamMessages} from '/src/screens/TeamMessages.tsx';
import '/src/styles.css';
const h=React.createElement;function Fixture(){const [hash,setHash]=React.useState('#/messages');return h('main',{style:{height:'100dvh'}},h(TeamMessages,{roomId:hash.split('/')[2],onNavigate:setHash}));}ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));`;
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
const output = new URL("../docs/reports/team-messages/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
const people = [
    { key: "user:1", name: "Alex", kind: "human" },
    { key: "user:2", name: "Ali", kind: "human" },
    { key: "user:3", name: "Mackenzie Fixture", kind: "human" },
  ],
  bot = { key: "bot:support", name: "Support", kind: "bot" };
try {
  for (const width of [320, 375, 414, 768, 1280]) {
    const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let room = {
      id: "fixture",
      team_id: "team",
      kind: "group",
      name: "Customer Service",
      revision: 1,
      last_seq: 2,
      members: [...people, bot],
      self_key: "user:1",
      can_manage: true,
      can_send: true,
      unread: 1,
      next: null,
      messages: [
        {
          id: "one",
          seq: 1,
          author_key: "user:2",
          author_name: "Ali",
          text: "The replacement is ready. Can we review the next step here?",
          created_at: "2026-09-23 12:00:00",
          mentions: [],
          attachments: [],
        },
        {
          id: "two",
          seq: 2,
          author_key: "bot:support",
          author_name: "Support",
          text: "The customer requested a replacement. The $45 shipping cost still needs approval in Needs input. No customer message has been sent.",
          created_at: "2026-09-23 12:01:00",
          mentions: [],
          attachments: [],
        },
      ],
    };
    const sent = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
      let body = {};
      if (url.pathname === "/api/team-rooms/directory")
        body = {
          self_key: "user:1",
          teams: [
            {
              id: "team",
              name: "Fixture Business",
              can_create: true,
              people,
              bots: [bot],
            },
          ],
        };
      else if (url.pathname === "/api/team-rooms" && method === "GET")
        body = { rooms: [room] };
      else if (url.pathname === "/api/team-rooms" && method === "POST") {
        const p = request.postDataJSON();
        assert(p.members.length);
        body = { room };
      } else if (url.pathname.endsWith("/messages")) {
        const p = request.postDataJSON();
        sent.push(p);
        room = {
          ...room,
          last_seq: room.last_seq + 1,
          messages: [
            ...room.messages,
            {
              id: "sent" + sent.length,
              seq: room.last_seq + 1,
              author_key: "user:1",
              author_name: "Alex",
              text: p.text,
              attachments: (p.attachments ?? []).map((id) => ({
                id,
                name: "fixture.txt",
                url: "/api/team-rooms/fixture/files/file",
                size: 4,
              })),
              mentions: p.mentions,
              created_at: "2026-09-23 12:02:00",
            },
          ],
        };
        body = { id: "sent" + sent.length };
      } else if (url.pathname.endsWith("/seen")) body = { ok: true };
      else if (url.pathname.endsWith("/files"))
        body = {
          file: {
            id: "file",
            name: "fixture.txt",
            size: 4,
            url: "/api/team-rooms/fixture/files/file",
          },
        };
      else if (method === "PATCH") {
        const p = request.postDataJSON();
        room = {
          ...room,
          name: p.name ?? room.name,
          revision: room.revision + 1,
        };
        body = { ok: true };
      } else body = { room };
      await route.fulfill({ json: body });
    });
    await page.goto("http://127.0.0.1:3299/__fixture");
    await page.getByRole("button", { name: /Customer Service/ }).click();
    await page
      .getByText("The replacement is ready.", { exact: false })
      .waitFor();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("button", { name: "@Support · Bot", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("@Support summarize this case");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page
      .getByText("@Support summarize this case", { exact: true })
      .waitFor();
    assert.deepEqual(sent[0].mentions, ["bot:support"]);
    assert.equal(sent[0].everyone, false);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Thanks Ali");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .press("Control+Enter");
    await page.getByText("Thanks Ali", { exact: true }).waitFor();
    assert.deepEqual(sent[1].mentions, []);
    await page
      .getByRole("button", { name: /Customer Service.*Details/ })
      .click();
    await page.getByRole("button", { name: "Edit group", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Group name", exact: true })
      .fill("Customer care");
    await page.getByRole("button", { name: "Save group", exact: true }).click();
    await page
      .getByRole("heading", { name: "Customer care", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page
      .locator("[data-slot=dialog-overlay]")
      .waitFor({ state: "detached" });
    await page.screenshot({
      path: output + `room-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Back to messages", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New message", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "New group chat", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Group name", exact: true })
      .fill("Returns review");
    await page.getByLabel("Ali ·").count();
    await page
      .locator("label")
      .filter({ hasText: "Ali" })
      .locator("input")
      .check();
    await page
      .locator("label")
      .filter({ hasText: "Support" })
      .locator("input")
      .check();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: output + `picker-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await page.locator("input[type=file]").setInputFiles({
      name: "fixture.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("test"),
    });
    await page.getByRole("button", { name: "Remove fixture.txt" }).waitFor();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    assert.deepEqual(sent.at(-1).attachments, ["file"]);
    await page
      .getByRole("button", { name: "Attach files", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector('button[aria-label="Attach files"]').disabled,
    );
    await page.evaluate(
      () => (document.documentElement.dataset.colorMode = "light"),
    );
    await page.screenshot({
      path: output + `light-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    if (width === 375) {
      const attempts = [];
      await page.route("**/api/team-rooms/fixture/messages", async (route) => {
        attempts.push(route.request().postDataJSON());
        if (attempts.length === 1)
          return route.fulfill({
            status: 503,
            json: { error: "Fixture connection interrupted" },
          });
        return route.fallback();
      });
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Retry this once");
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Fixture connection interrupted" })
        .waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Message", exact: true })
          .inputValue(),
        "Retry this once",
      );
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await page.getByText("Retry this once", { exact: true }).waitFor();
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].request_key, attempts[1].request_key);
      await page.route("**/api/team-rooms/fixture?*", (route) =>
        route.fulfill({
          status: 404,
          json: { error: "Fixture membership removed" },
        }),
      );
      await page
        .getByRole("alert")
        .filter({ hasText: "Fixture membership removed" })
        .waitFor();
      assert.equal(
        await page
          .getByText("The replacement is ready.", { exact: false })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Message", exact: true })
          .count(),
        0,
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Passed team-room fixture ${width}px`);
  }
} finally {
  await browser.close();
  await vite.close();
}
