# Chat links for agents

Claude and Codex can call `agents.get_chat_link` to retrieve the same URL as the chat menu's **Copy Link** action.

```json
{}
```

Omit the id for the current chat, or select another local chat:

```json
{ "conversationId": "EXACT_CHAT_ID" }
```

The result includes `url`, `conversationId`, `projectId`, and `title`. The tool retrieves a link; it sends no email and grants no access. A recipient must be able to sign in and view that chat. Use `list_conversations` first if the id is unknown. Remote instance-qualified ids are explicitly rejected; request the link from an agent on that instance.

The backend derives the hostname from `VP_APPS_PUBLIC_ORIGIN` and the project from the saved conversation. Request headers cannot change the hostname. Missing/loopback configuration returns a clear error instead of a broken local link. Retrieving a link does not mark a chat as read.

## Implementation and verification

- [Agent tool](server/src/mcp/chatLinkTool.ts) and [tool registration](server/src/mcp/agentToolsServer.ts).
- [Authorized HTTP route](server/src/routes/api.ts) and [URL formatting](server/src/conversations/shareUrl.ts).
- [Tests](server/test/chatLink.test.ts) compare against the actual web Copy Link helper and check access, archived/deleted chats, missing configuration and forged forwarded headers.
- [Live deployment check](scripts/verify-chat-tools.mjs) creates a temporary private chat, calls the real chat-link tool and browser URL reader, then removes its browser copy, agent token and chat. Run it on an updated client as the service user: `node scripts/verify-chat-tools.mjs` from its monorepo root.

The accompanying [browser reader guide](docs/browser-url-reader.md) covers scripted page reads without an AI turn.
