---
name: veneer-publish-page
description: Create and publish browser-viewable deliverables as Veneer pages with mcp__agents__publish_page. Use for pages, web pages, reports, one-pagers, presentations, dashboards, visualizations, demos, calculators, forms, games, and other content meant to open in a browser or be shared by URL. Default to a page even when it has client-side interaction. Use publish_app only when the user explicitly asks for an app or interactive tool that needs server-side behavior; otherwise ask before changing the output type.
---

# Publish a Veneer page

## Choose the output

- Use `mcp__agents__publish_page` by default for all browser-viewable deliverables.
- Keep dashboards, calculators, forms, games, filters, sorting, and other browser-only interaction in the page with inline JavaScript.
- Use `mcp__agents__publish_app` only when the user explicitly asks for an app or interactive tool that needs server-side behavior.
- If required behavior needs a server, private host resources, durable writes, or protected app routes, explain that a page cannot provide it and ask whether to make an app unless the user already asked for an interactive tool. Do not switch silently.
- Treat a separate published page as a deliverable, not as a change to the current project. Do not join the project build queue unless the user also asks to change project files.

## Build the page

1. Use the user's supplied content and make reasonable choices when the request is clear. Do not ask whether to publish after the user has asked for a page or browser-viewable deliverable.
2. Call `mcp__agents__project_settings` with no arguments before design work. Use its effective project or site appearance. A direct user design request overrides those settings. Do not hardcode another client's brand.
3. Create one complete, self-contained HTML document. Inline all CSS and JavaScript. Embed required assets or use durable absolute URLs; do not depend on local files.
4. Make the page responsive, accessible, and usable with touch, keyboard, and ordinary browser controls. Use clear document structure, visible focus, sufficient contrast, and useful page metadata.
5. Include requested client-side interaction in the same document. Do not reduce an interactive request to a static mock-up.

## Publish and verify

1. Call `mcp__agents__publish_page` with a short title and the complete document through `html` or `html_file`.
2. For an existing page, use its known `page_id`. Call `mcp__agents__list_pages` only when needed to find that ID. Pass `page_id` when publishing the update so the URL stays the same and the seven-day lifetime renews.
3. For a substantial or interactive page, open the returned URL and check the main content and important interaction. Correct and republish problems before completion.
4. Finish with the live URL and tell the user that the page expires seven days after its latest publish. Use only “page” or “published page” in user-facing text.

Do not stop after writing an HTML file or testing on localhost. Localhost is internal verification only; the request is complete only after a published URL is available to the user.
