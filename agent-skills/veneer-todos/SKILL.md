---
name: veneer-todos
description: Manage native Veneer Todo lists with built-in agent tools. Use when the user asks to add something to a Todo or task list, review or search Todos, edit a Todo, move it to a category or project, add or remove its links, mark it complete, or reopen it.
---

# Manage Veneer Todos

Use the native `mcp__agents__list_todos`, `mcp__agents__read_todo`, `mcp__agents__create_todo`, and `mcp__agents__update_todo` tools. Never use browser automation to manage a Veneer Todo list.

## Create a Todo

1. Call `list_todos` first when the user names a category or project. Use the exact returned ID.
2. Default to Inbox by omitting `category_id` when the user gives no category.
3. Keep the title concise. Put supporting details in `notes` and supplied URLs in `links`.
4. Call `create_todo` once and report the created title and Todo ID.

## Read or change Todos

1. Call `list_todos` when the exact Todo ID is unknown.
2. If several Todos could match, show the short choices and ask the user which one they mean. Never edit by title alone.
3. Call `read_todo` before removing a link so you have its exact link ID.
4. Use `update_todo` with only the fields that must change. Omitted fields stay unchanged.
5. Use `links_add` and `link_ids_remove` for link changes. Do not rebuild or replace the full link list.
6. Use `action: "complete"` to mark done and `action: "reopen"` to restore it.

The native agent tools do not delete Todos or manage category structure. If the user asks to delete a Todo or category, explain that deletion must be confirmed and completed in the Todos screen. Do not use another tool or a browser to bypass this limit.
