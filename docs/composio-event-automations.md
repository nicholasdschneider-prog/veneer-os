# Composio event automations

Veneer receives Composio trigger deliveries at:

```text
POST https://<veneer-origin>/webhooks/composio
```

This route intentionally does not use Veneer's Cloudflare Access identity. It
verifies Composio's signed raw request body with `COMPOSIO_WEBHOOK_SECRET`,
normalizes only recipe-approved fields, commits the event to SQLite, and
returns `202`. The separate runner claims the durable event and starts the
automation chat.

## Production setup

1. Create or update the Composio project webhook subscription to the URL above,
   using V3 payloads and the `composio.trigger.message` event.
2. Put the returned webhook secret in Doppler as
   `COMPOSIO_WEBHOOK_SECRET`. Never put it in the repository or SQLite.
3. Add a Cloudflare Access Bypass policy scoped **only** to
   `/webhooks/composio`, or use a separate ingress hostname routed to the same
   tunnel. All other Veneer paths remain Access-protected.
4. Restart both Veneer services after adding the environment value.

Invalid signatures, timestamps older than Composio's default five-minute
tolerance, unknown trigger instances, wrong connected accounts, and malformed
payloads cannot start an agent.

## Current recipe

`slack.dm.received` maps to Composio
`SLACK_CHANNEL_MESSAGE_RECEIVED` with `message_type: direct`. Composio requires
one `D…` conversation ID per trigger instance. Veneer currently exposes a
word-count filter and stores only the DM text, sender ID/name, channel ID,
timestamp, and connected-account ID.

The sample automation runs only when the DM contains more than four words and
uses this fixed instruction:

> Analyze this and give me a recommended response.

It does not send or update any Slack message.
