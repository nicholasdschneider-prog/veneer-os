# Focused accounting workspace

A focused business member sees VeneerBots and Automations, starting with their assigned bots. Full native chat keeps the assigned browser, file previews, and durable project training. Existing business membership and financial approval rules still apply. Other users keep their current interface.

The Automations tab is a read-only view of routines belonging to accessible assigned bots, with schedule, timezone, status, and next run. It does not expose the general scheduler or grant permission to run, edit, or delete automations. A request to change a routine goes through its owning bot and existing authorization.

The focus configuration is reusable and enforced through conversation access checks, SQL list scopes, direct chat routes, and existing WebSocket authorization. An empty bot assignment stays closed. Removing membership or a registered bot removes its assignment. Hidden platform navigation is a UX choice; this is not a replacement for all existing platform API permissions.

Focus narrows only the human view. A bot turn acting for the focused member (agent token or coordination lane, marked `botSession`) keeps normal business-member reach: it can list, message, and coordinate with every bot in the same business team. The focused member can open coordination threads their assigned bot takes part in, but not the other bot's own chats. See `focusApplies` and `canViewCoordinationPair`.

## Owner configuration

Use `manage_business_team` with `action: "focus"`, exact `team_id`, verified `user_id` and `email`, explicit `conversation_ids`, and `enabled: true`. Requires an active full business member and active shared bots owned by that business. Human owner or authenticated owner Platform Dev only. Configuration writes an immutable business audit entry. `enabled: false` with an empty `conversation_ids` list restores the normal view; it does not change membership or financial authorization. Account-wide changes fail if another business owner has membership in scope.

Mackenzie's intended assignment is Clara. Sarah has no registered native bot here. Existing Clara browser/profile assignments and service connections are not modified.

## Validation

- TypeScript checks passed.
- Full server, web, browser-manager, and installer test suites passed.
- Regression coverage checks verified configuration, wrong-email/agent rejection, chat and routine scope, membership/bot revocation, training eligibility, API direct routes, and preservation of owner access.
- Isolated browser fixtures verified the two-tab navigation, bot landing, automation display, hidden Settings route fallback, and 390px mobile layout without horizontal overflow. These use fixture data, not Mackenzie's session.

## Implementation files

- [Database migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0123_focused_workspaces.sql)
- [Scope and automation service](/Users/archerclawdington/veneer-os/server/src/bots/focusedWorkspace.ts)
- [Audited team configuration](/Users/archerclawdington/veneer-os/server/src/bots/teams.ts)
- [Access-change notifications](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [Conversation permissions](/Users/archerclawdington/veneer-os/server/src/conversations/access.ts)
- [Native tool definition](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [Account and API routes](/Users/archerclawdington/veneer-os/server/src/routes/api.ts)
- [Server regression tests](/Users/archerclawdington/veneer-os/server/test/employeeWorkspace.test.ts)
- [App routing](/Users/archerclawdington/veneer-os/web/src/App.tsx)
- [Web API client](/Users/archerclawdington/veneer-os/web/src/lib/api.ts)
- [Account types](/Users/archerclawdington/veneer-os/web/src/lib/types.ts)
- [Focused workspace](/Users/archerclawdington/veneer-os/web/src/screens/FocusedWorkspace.tsx)
- [UI regression tests](/Users/archerclawdington/veneer-os/web/src/screens/FocusedWorkspace.test.tsx)
