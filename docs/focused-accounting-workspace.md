# Focused accounting workspace

A focused business member (Mackenzie, assigned Clara) uses the same Veneer app as everyone else. The
only difference is the navigation rail: Chats, Automations and Settings. Workspace, Bot guide, Todos,
Pages, Apps, Terminal and pinned Mini Apps are not offered, and any other address lands on Chats.
There is no separate screen to keep in step with the rest of the product; every chat feature
(Questions, Side chat, Listen, Reply, file previews, the assigned browser) is the shared one.

The Automations destination is a read-only list of routines belonging to accessible assigned bots,
with schedule, timezone, status and next run. It does not expose the general scheduler (the server
answers 403) or grant permission to run, edit or delete automations. A request to change a routine
goes through its owning bot and existing authorization. Settings shows Appearance only.

The focus configuration is reusable and enforced through conversation access checks, SQL list scopes,
direct chat routes and existing WebSocket authorization. In scope: the assigned bot chats, the
member's own side chats of those bots, and coordination threads those bots take part in. An empty bot
assignment stays closed. Removing membership or a registered bot removes its assignment. Hidden
navigation is a UX choice; the server scope is the boundary.

Focus narrows only the human view. A bot turn acting for the focused member (agent token or
coordination lane, marked `botSession`) keeps normal business-member reach. See `focusApplies` and
`canViewCoordinationPair`.

## Owner configuration

Use `manage_business_team` with `action: "focus"`, exact `team_id`, verified `user_id` and `email`,
explicit `conversation_ids`, and `enabled: true`. Requires an active full business member and active
shared bots owned by that business. Human owner or authenticated owner Platform Dev only.
Configuration writes an immutable business audit entry. `enabled: false` with an empty
`conversation_ids` list restores the normal view; it does not change membership or financial
authorization.

## Implementation files

- [Scope and automation service](/Users/archerclawdington/veneer-os/server/src/bots/focusedWorkspace.ts)
- [Conversation permissions](/Users/archerclawdington/veneer-os/server/src/conversations/access.ts)
- [Audited team configuration](/Users/archerclawdington/veneer-os/server/src/bots/teams.ts)
- [Server regression tests](/Users/archerclawdington/veneer-os/server/test/employeeWorkspace.test.ts)
- [App routing and the focused route allowlist](/Users/archerclawdington/veneer-os/web/src/App.tsx)
- [Navigation rail (`focused` prop)](/Users/archerclawdington/veneer-os/web/src/components/NavBar.tsx)
- [Read-only automations list](/Users/archerclawdington/veneer-os/web/src/screens/FocusedWorkspace.tsx)
- [Settings (`focused` prop)](/Users/archerclawdington/veneer-os/web/src/screens/Settings.tsx)
- [UI regression tests](/Users/archerclawdington/veneer-os/web/src/screens/FocusedWorkspace.test.tsx)
