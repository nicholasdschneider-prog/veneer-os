# Delegated browser login recovery

A full business teammate may use a registered bot's explicitly assigned browser. Login grants additionally allow server-side password/authenticator entry and, optionally, saving that working copy back to its assigned profile. They do not allow secret retrieval, unrelated profiles, account creation, or business transactions.

The chat/profile owner creates or revokes grants through the authenticated browser API. Plain members cannot grant themselves access. Each grant records the project, conversation, assigned profile, exact Doppler project/config/name, password or TOTP purpose, exact HTTPS login origins, and save permission. Browser fills recheck live team/bot/profile/grant access inside the serialized command lane. A single page evaluation checks the current top-level origin, unique visible input, password input type, and form action before filling. Embedded frames are refused; navigate to the approved login site itself. Advanced capture must be off. Credential values and codes are redacted and never returned by the tool.

Owner setup:

1. Assign a dedicated business-account profile to the bot.
2. Collect that account's password and optional authenticator seed through `request_secret`. Do not use another employee's login without explicit authorization. Do not put passwords or one-time codes in chat.
3. `PUT /api/veneer-browser/conversations/<id>/login-grants` with JSON fields `profileId`, `secretProject`, `secretConfig`, `secretName`, `kind` (`password` or `totp`), `origins` (exact HTTPS origins), and optional `allowSave`. Repeat for the authenticator seed. This stores names and policy only.
4. `GET` the same endpoint lists active grants. `DELETE .../login-grants/<grantId>` revokes one. Both changes are audited.
5. In a member's bot turn, `fill_secret`/`fill_totp` are listed only when the corresponding grant exists. Their descriptions include the approved secret names and origins. Use a CSS input selector, not an `@ref`; click Submit separately after filling. No SMS database or shared-email-code access is granted by this feature.
6. After verifying the signed-in account, call `update_profile` to retain refreshed sessions. Shared-profile generation conflicts remain protected. Session expiry, CAPTCHA, passkeys, or a provider's required human approval can still require human action.

For supported business operations, prefer an authorized API integration over browser login. A browser login grant does not grant API-token access. Existing Shopify API credentials and another account's stored Shopify login are separate from Clara's accounting login.

Implementation: [grant policy](../server/src/veneerBrowser/loginGrants.ts), [migration](../server/src/db/migrations/0102_browser_login_grants.sql), [owner routes](../server/src/routes/veneerBrowser.ts), [browser manager](../server/src/veneerBrowser/manager.ts), [MCP tools](../server/src/veneerBrowser/mcp.ts).

Regression tests: [grant policy and routes](../server/test/browserLoginGrants.test.ts), [manager](../server/test/veneerBrowser.test.ts), [credential tools](../server/test/veneerBrowserSecretTools.test.ts).
