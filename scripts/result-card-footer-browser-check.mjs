// Render the production row in both React and frozen HTML. No live API or audio.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import ReactDOMServer from '/node_modules/.vite/deps/react-dom_server.js';
const {renderToStaticMarkup}=ReactDOMServer;
import {ChatRow} from '/src/screens/Chat.tsx';
import '/src/styles.css';
const h=React.createElement,at='2026-09-23T11:35:00Z';
const item={kind:'assistant',key:'result',turnId:'fixture-turn',at,markdown:'The replacement is ready for review. **The $45 shipping cost needs your approval.**\\n\\nNo customer message has been sent.'};
window.clicks=[];
function Fixture(){return h('main',{className:'conversation-surface bg-background text-foreground',style:{maxWidth:720,minHeight:'100dvh',margin:'auto',padding:12},onClick:e=>{const b=e.target.closest('button');if(b)window.clicks.push({...b.dataset});}},
h('p',{className:'mb-2 text-xs text-muted-foreground'},'Live result'),h('section',{'data-fixture':'live'},h(ChatRow,{item,live:true,collapsePrompt:false})),
h('p',{className:'mt-5 mb-2 text-xs text-muted-foreground'},'Historical result'),h('section',{'data-fixture':'frozen',dangerouslySetInnerHTML:{__html:renderToStaticMarkup(h(ChatRow,{item:{...item,key:'old',turnId:'old-turn',markdown:'Ready.'},live:false,collapsePrompt:false}))}}));}
ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));`;
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
      name: "footer-fixture",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/src/screens/Chat.tsx"))
          return code + "\nexport {ChatRow};";
      },
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
const output = new URL("../docs/reports/result-card-footer/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
try {
  for (const width of [320, 375, 414, 768, 1280]) {
    const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.error(m.text());
    });
    await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
    await page.goto("http://127.0.0.1:3299/__fixture");
    await page.locator("[data-result-thread]").first().waitFor();
    await page
      .getByText("No customer message has been sent.", { exact: true })
      .waitFor();
    for (const fixture of ["live", "frozen"]) {
      const row = page.locator(`[data-fixture=${fixture}]`);
      assert.equal(
        await row
          .locator("[data-slot=bubble-content] [data-result-thread]")
          .count(),
        1,
      );
      assert.equal(await row.locator("[data-message-quote] button").count(), 0);
      assert.equal(
        await row.locator("[data-slot=bubble-content] button").count(),
        5,
      );
      for (const button of await row
        .locator("[data-slot=bubble-content] button")
        .all()) {
        const b = await button.boundingBox(),
          card = await row.locator("[data-slot=bubble-content]").boundingBox();
        assert(
          b.height >= 44,
          JSON.stringify({ fixture, width, b, card, check: "height" }),
        );
        assert(
          b.x >= card.x && b.x + b.width <= card.x + card.width + 1,
          JSON.stringify({ fixture, width, b, card, check: "horizontal" }),
        );
        assert(
          b.y >= card.y && b.y + b.height <= card.y + card.height + 1,
          JSON.stringify({ fixture, width, b, card, check: "vertical" }),
        );
        await button.click();
      }
    }
    assert.equal((await page.evaluate(() => window.clicks)).length, 10);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page
      .locator("[data-result-thread]")
      .first()
      .evaluate((b) => {
        b.textContent = "12 replies · New";
        b.dataset.unread = "true";
      });
    await page
      .locator("[data-result-reaction]")
      .first()
      .evaluate((b) => {
        b.textContent = "👍 12";
        b.setAttribute("aria-pressed", "true");
      });
    await page.keyboard.press("Tab");
    await page.locator("[data-result-thread]").first().focus();
    assert.notEqual(
      await page
        .locator("[data-result-thread]")
        .first()
        .evaluate((b) => getComputedStyle(b).outlineStyle),
      "none",
    );
    for (const button of await page
      .locator("[data-slot=bubble-content] button")
      .all()) {
      const b = await button.boundingBox(),
        card = await button
          .locator('xpath=ancestor::*[@data-slot="bubble-content"]')
          .boundingBox();
      assert(b.width >= 44 && b.height >= 44);
      assert(
        b.x >= card.x &&
          b.x + b.width <= card.x + card.width + 1 &&
          b.y + b.height <= card.y + card.height + 1,
      );
    }
    await page.screenshot({
      path: output + `dark-${width}.png`,
      animations: "disabled",
      fullPage: true,
    });
    await page.evaluate(
      () => (document.documentElement.dataset.colorMode = "light"),
    );
    await page.screenshot({
      path: output + `light-${width}.png`,
      animations: "disabled",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await page.close();
    console.log("Passed live/frozen footer " + width + "px");
  }
} finally {
  await browser.close();
  await vite.close();
}
