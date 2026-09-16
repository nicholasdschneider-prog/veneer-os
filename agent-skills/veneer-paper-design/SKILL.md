---
name: veneer-paper-design
description: Read and edit a Paper (paper.design) design file through the Paper connector's MCP tools. Use ONLY when the request explicitly names Paper — "in Paper", paper.design, the Paper app, or the user's Paper canvas, artboards, or design file. Do NOT use for generic design, UI, mockup, restyle, or "use the design skill" requests that never name Paper; other design skills cover those.
---

# Work in a Paper design file

The Paper connector exposes Paper Desktop's MCP tools (`get_basic_info`, `get_selection`, `get_tree_summary`, `get_jsx`, `get_screenshot`, `create_artboard`, `write_html`, `update_styles`, `set_text_content`, and others). They act on the file that is **currently open** in the user's Paper app.

## When not to use this

Paper is opt-in. Use this skill only when the request names Paper explicitly. A generic ask to design something, build UI, restyle a page, or "use the design skill" is NOT a Paper request — leave it to the other design skills and do not open or touch the Paper file. If it is genuinely ambiguous, ask in one line rather than guessing Paper.

## Before you touch anything

1. Call `get_guide` first. Paper's own server instructs you to load it before any other Paper tool.
2. Call `get_basic_info`. It names the file you are about to change, so you never edit the wrong one.
3. If no file is open, use `list_files` and `open_file` rather than giving up. Only stop if the tools themselves are unreachable, which means Paper Desktop is not running on the machine the connector points at. Say that in one line, do not retry in a loop, and do not fall back to browser automation.
4. Call `get_tree_summary`, `find_nodes`, or `get_selection` before editing existing content, so you change the node the user meant.

## Show your work after every change

After ANY write tool (`create_artboard`, `write_html`, `update_styles`, `set_text_content`, `move_nodes`, `duplicate_nodes`, `delete_nodes`, `rename_nodes`), call `get_screenshot` and present the image in your reply.

The user is often not looking at the Paper window, so an unseen edit is an invisible edit. One screenshot after a coherent batch of edits is right; a screenshot after every micro-tweak is noise.

## Use the file's own tokens

`get_tokens` returns the design tokens already defined in the file. Style new work from those, and use `create_tokens` / `set_tokens` rather than hardcoding values that duplicate an existing token.

## Match the surrounding work

When the request relates to a codebase you are working in, read that project's design system first (tokens, theme files, a Tailwind config, component source) and lift real values: colors, the type ramp, spacing, radii, control heights. Build new artboards from that vocabulary rather than inventing one. Say in one line what you matched.

## Handing a design to code

`get_jsx` returns the design as JSX, `export` produces assets, and `export_combined_pdf` produces a single document. Use those instead of re-describing a design from a screenshot when the user asks to implement or send it.

## Cost

Paper's free tier allows 100 MCP tool calls per week. Prefer one `get_tree_summary` over many `get_node_info` calls, and batch edits before screenshotting.
