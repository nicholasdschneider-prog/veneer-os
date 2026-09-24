# ERVP Shopify Admin login recovery

Verified source review: September 24, 2026, Veneer build queue #280.

## Current outcome

Unattended ERVP Admin access and saved-session reuse are **not yet verified**.
No Shopify settings were changed during this investigation. No credentials were
read outside the protected browser tools.

The original passkey stall and the remaining MFA failure are different issues:

| Evidence | Finding |
| --- | --- |
| September 18 platform chat `f14e5ad5-8686-480b-8d0f-43445126010d` | Commit `a3ec90b` implemented an empty virtual authenticator on temporary working copies, with tests. That chat initially left runtime adoption pending. |
| September 18, 18:07Z Boris checkpoint in `9bb5b47e-b9c9-43c0-a83b-7dc485166c0f` | Reports manager/runner adoption at 18:04Z and successful email → alternate method → password → authentication-app prompt. `fill_totp` rejected the stored value as not a TOTP seed. SMS fallback could not read Messages because of macOS Full Disk Access. |
| September 23, 21:17Z checkpoint in `d254c025-e786-4549-9da9-c2011e437332` | Again reports successful email/password, invalid TOTP seed format, and the SMS permission blocker. No profile promotion reported. |
| September 24, this investigation | Current source retains the passkey fix, TOTP validation, generation fencing, and per-request browser proxy token resolution. The browser tools list only Veneer's Default profile. Selecting the exact ERVP profile returns `Browser profile not found in this project.` This is a project boundary, not a new Shopify login reproduction. |

The September 18 BORIS-008 file still describes the pre-fix stall. Use the later
dated checkpoints above when interpreting it. Historical observations do not
prove the credential or session's current state; a fresh ERVP-scoped run is
required. There is no evidence yet warranting another WebAuthn or TOTP parser
change. Never convert an invalid seed into a guessed code or weaken validation.

## Correct scope and login procedure

Use an ERVP-project chat (`e8e0efc6-2f5f-4666-8588-ede17529bc9c`), not a Veneer
platform chat. Browser profile authorization is project-scoped. Do not copy
profile files, impersonate another chat, or modify project bindings to get
around a rejected selection.

1. List profiles and select **ERVP — Nick**,
   `d21f7d37-71ac-46d5-8ba7-cd0a424a8d3d`. Open an isolated working copy at
   `https://elkhart-rv-parts.myshopify.com/admin`.
2. Read the current page. If it already reaches the correct store's Admin,
   record that observed result without forcing a logout.
3. If login is required, use `fill_secret` for `SHOPIFY_LOGIN_EMAIL`, then the
   supported alternate/password method and `SHOPIFY_LOGIN_PASSWORD`. The
   historical Doppler location is project `ervp`, config `prd`; confirm the
   connected scope through supported tools. Never print or type the values.
4. At the authenticator prompt, use `fill_totp` with `SHOPIFY_LOGIN_TOTP`.
   It accepts a base32 authenticator key or `otpauth://totp/…` URI, not a password,
   recovery code, or a transient six-digit code. The tool generates the code
   privately and waits for the next interval when fewer than three seconds
   remain.
5. If the tool reports an invalid seed, stop authentication attempts. Correct
   the existing seed through `request_secret` in the authorized Doppler scope
   using the account owner's existing authenticator setup material. Never ask
   for it in chat. Do not reset MFA or alter Shopify account settings under this
   read-only task. Check existing credential requests before creating another.
6. After successful login, confirm the correct store's Admin with read-only
   navigation. Call `update_profile` explicitly to persist the login. Do not
   promote a working copy parked at a password/MFA prompt. If a newer profile
   generation exists, respect the conflict and reopen from that generation;
   never overwrite it by copying files.
7. Stop the working copy, open a fresh copy of the saved ERVP profile, and
   confirm the correct Admin page opens without another login. Record the
   profile update result and fresh-copy outcome separately. Only this proves
   saved-session reuse; an API call or the first authenticated tab does not.

## Expiry and re-login

Saving a profile persists browser state; it does not guarantee permanent
Shopify authorization. There is no verified fixed Shopify session lifetime in
this investigation. On any later redirect to login, follow the procedure above
and refresh the profile only after authenticating successfully. A revoked
session or unusable second factor needs supported credential recovery, not a
browser restart loop. No scheduled keep-alive or automatic re-login worker was
added by this work.

Temporary working-copy cleanup is separate: the manager defaults to deleting
idle temporary copies after 30 minutes unless their control connection remains
open. Explicit stop discards unsaved changes. Saved profile generations remain
the source for later copies. See [browser manager lifecycle](../browser-manager/README.md).

The seven-hour BORIS-001 failure was a third, separate problem: Codex persisted
an expired MCP token in `mcp-remote`. Commit `7e366b8` replaced that browser
transport with a proxy that reads the current per-conversation token for every
request. Current proxy tests verify rotation between requests. This is not a
Shopify cookie refresh and does not fix MFA. The prior continuous-runtime
greater-than-seven-hour acceptance remained unproven in the September 18
incident; this investigation does not claim to have performed it.

BORIS-007 / commit `348bb18` added protected email-code entry for sites that
actually offer that method. It does not turn Shopify's authenticator challenge
into an email challenge. This task authorizes password/TOTP verification only.

## Validation and pending acceptance

September 24 targeted server checks: 71 tests passed across TOTP, protected
credential tools, browser proxy, and profile resolution. All 29 targeted
browser-manager/WebAuthn tests also passed, including profile promotion,
generation conflicts, passkey blocking, and the saved-profile opt-out. Tests ran with Node 24
explicitly because the shell's Node 22 could not load `libsimdjson.30.dylib`.
No runtime source change or service restart was needed for this documentation.

Pending: ERVP-scoped fresh reproduction, current protected TOTP result,
successful Admin login, profile promotion, and second-copy reuse. This chat's
memory tool reports that memory is not configured; this file preserves the
findings without claiming a memory update succeeded.
