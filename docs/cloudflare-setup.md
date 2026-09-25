# Putting Veneer OS behind Cloudflare Access

Veneer OS binds `127.0.0.1` only (`server/src/index.ts` → `server.listen(config.port, '127.0.0.1')`).
Nothing reaches it from the internet until you run a `cloudflared` tunnel on the Mac and put a
Cloudflare Access application in front of the hostname that tunnel serves.

A free Cloudflare plan is enough. Zero Trust's free tier covers up to 50 users.

## What the server actually checks

`server/src/identity/cloudflareAccess.ts` is the whole authentication story:

1. It reads the **`Cf-Access-Jwt-Assertion`** request header. Missing or empty → no identity → the
   API answers `403 {"ok":false,"error":"No identity"}`. This applies to every `/api` route *and*
   the WebSocket upgrade.
2. It verifies that JWT with `jose` against the JWKS at **`<team>/cdn-cgi/access/certs`**, requiring
   `alg: RS256`, `iss` equal to `<team>`, and `aud` equal to `VP_CF_AUD`. Expiry is enforced by
   `jwtVerify`.
3. It takes the **`email`** claim, trims it and lowercases it. No email claim → no identity.

Nothing else is trusted. There is no cookie, no session, no password.

| env var | value | where it comes from |
|---|---|---|
| `VP_IDENTITY` | `cloudflare` | the default; set it explicitly anyway. `dev` disables authentication entirely and must stay on loopback |
| `VP_CF_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` | Zero Trust → Settings → Custom Pages (or the URL of your Zero Trust login page). API: `auth_domain` from `GET /accounts/{account_id}/access/organizations` |
| `VP_CF_AUD` | the 64-hex **Application Audience (AUD) tag** | Zero Trust → Access → Applications → your app → Overview. API: `aud` in the create/list response |

`VP_CF_TEAM_DOMAIN` is normalized by `normalizeTeamDomain()`: a bare `acme` becomes
`https://acme.cloudflareaccess.com`, `acme.cloudflareaccess.com` becomes `https://acme.cloudflareaccess.com`,
and a full `https://…` URL is used as-is with trailing slashes stripped. Whatever you set must match
the `iss` claim Cloudflare mints, which is `https://<your-team>.cloudflareaccess.com`.

`loadConfig()` in `server/src/config.ts` **throws at startup** if `VP_IDENTITY=cloudflare` (including
by default) and either value is missing. `installer/env.mjs` `validateInstallEnv()` refuses to install
for the same reason. This fails closed on purpose.

---

## Dashboard walkthrough

### (a) Get a domain into Cloudflare

You need a zone Cloudflare controls. Either:

- Add an existing domain: Cloudflare dashboard → **Add a domain**, then repoint the registrar's
  nameservers at the two Cloudflare assigned you and wait for the zone to go **Active**; or
- Register one through Cloudflare Registrar, which is already active.

Pick the hostname Veneer will live at — a subdomain is fine and is the usual choice, e.g.
`veneer.example.com`. You do **not** create a DNS record by hand; the tunnel does that in step (c).

### (b) Create the Zero Trust team

Dashboard → **Zero Trust**. First visit asks you to choose a **team name**; the team domain is then
`<team-name>.cloudflareaccess.com`. That string is `VP_CF_TEAM_DOMAIN`.

While you are here, confirm the one-time PIN login method is on:
**Settings → Authentication → Login methods** should list **One-time PIN**. It is enabled by default
and needs no identity provider, which is why it is the right choice for a one-owner install.

### (c) Create the tunnel

**Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.** Name it (e.g. `veneer-os`) and
save. This creates a *dashboard-managed* tunnel: its ingress rules live in Cloudflare, not in a local
config file, which is what the launchd job below assumes.

On the install screen Cloudflare shows a run command containing a long token. You only need the token
itself. Put it on the Mac, alone on one line, unquoted:

```sh
mkdir -p ~/.config/veneer-pro
printf '%s' '<tunnel token>' > ~/.config/veneer-pro/cloudflared-token
chmod 600 ~/.config/veneer-pro/cloudflared-token
```

That exact path is hardcoded in `installer/install-darwin.mjs`
(`~/.config/veneer-pro/cloudflared-token`) and rendered into
`deploy/launchd/com.veneer.pro.cloudflared.plist`, which runs:

```
<cloudflared> tunnel --no-autoupdate --protocol http2 run --token-file ~/.config/veneer-pro/cloudflared-token
```

The tunnel is pinned to HTTP/2 rather than the default QUIC. On this Mac's Wi-Fi, QUIC connections
repeatedly failed with `timeout: no recent network activity` and did not all re-register, which left
remote users on a Cloudflare error page (2026-09-25). The log should show `protocol=http2` on every
`Registered tunnel connection` line.

The installer looks for the `cloudflared` binary at exactly three paths, in order:

```
~/.local/bin/cloudflared
/opt/homebrew/bin/cloudflared
/usr/local/bin/cloudflared
```

`brew install cloudflared` on Apple Silicon lands in `/opt/homebrew/bin`. If the binary is anywhere
else, symlink it into one of those three paths — there is no environment override.

Then, on the tunnel's **Public Hostname** tab, add a public hostname:

| field | value |
|---|---|
| Subdomain | `veneer` (or whatever you chose) |
| Domain | `example.com` |
| Type | `HTTP` |
| URL | `localhost:3100` |

Cloudflare creates the proxied CNAME to `<tunnel-id>.cfargotunnel.com` for you. Port `3100` is the
`PORT` default in `server/src/config.ts`; change both together if you change it.

### (d) Create the Access application

**Zero Trust → Access → Applications → Add an application → Self-hosted.**

| field | value |
|---|---|
| Application name | `Veneer OS` |
| Session duration | 24 hours is a reasonable default |
| Public hostname | `veneer.example.com` — the same hostname as the tunnel, path empty |

Save, then open the application's **Overview** tab and copy the **Application Audience (AUD) Tag**
(64 hex characters). That is `VP_CF_AUD`.

The AUD is per-application. If you ever delete and recreate the application, the tag changes and
every request 403s until you update the env file and restart.

### (e) Access policy: allow the owner

On the application, add a policy:

| field | value |
|---|---|
| Policy name | `Owner` |
| Action | `Allow` |
| Include | selector **Emails** → your email address |

With one-time PIN enabled, that email receives a 6-digit code at login; no IdP is required.

**Adding people later.** Add their address to the same policy's *Emails* include list (or add a
second Allow policy). Passing Access is only half of it: the first time a newly allowed email hits
`GET /api/me`, `server/src/routes/api.ts` auto-provisions them as a **`member` with status
`pending`**, and they see the "Waiting for approval" screen. Every other route rejects them with
`403 Account pending approval`. An admin approves them in the app at
**Settings → People & access** (`#/settings/people`), where roles can also be changed and accounts
disabled. So the allow-list is Cloudflare's, and the approval is Veneer's — both are required.

### (f) Write the env file

```sh
mkdir -p ~/.config/veneer-pro
cat >> ~/.config/veneer-pro/env <<'EOF'
VP_IDENTITY=cloudflare
VP_CF_TEAM_DOMAIN=your-team.cloudflareaccess.com
VP_CF_AUD=<64-hex AUD tag>
VP_APPS_PUBLIC_ORIGIN=https://veneer.example.com
EOF
chmod 600 ~/.config/veneer-pro/env
```

`VP_APPS_PUBLIC_ORIGIN` is optional but worth setting now: without it, links an agent hands you fall
back to `http://127.0.0.1:$PORT`, which is useless on a phone.

Then install (or re-install) and restart:

```sh
node installer/install-darwin.mjs
npm run restart
```

The installer **silently skips** `com.veneer.pro.cloudflared` if either the binary or the token file
is missing — it prints one line, `[install] skipped com.veneer.pro.cloudflared (cloudflared or its
token file is missing)`, and carries on. If your hostname does not answer, check for that line first.

### (g) Verify

```sh
# 1. The edge answers with an Access login, not your app.
curl -sI https://veneer.example.com | head -1
#    302/303 to <team>.cloudflareaccess.com — good. 502/530 means the tunnel is down;
#    a direct 200 with app HTML means the Access application is not matching the hostname.

# 2. The tunnel process is up and connected.
launchctl print gui/$(id -u)/com.veneer.pro.cloudflared | head
tail -f ~/Library/Logs/veneer-pro/veneer-pro-cloudflared.log   # look for "Registered tunnel connection"

# 3. The app itself is listening on loopback.
curl -sS http://127.0.0.1:3100/healthz
```

Now open `https://veneer.example.com` in a browser, enter your email, paste the emailed code. The
first authenticated visitor against an empty database gets the **setup screen** and is written to
the `users` table as `owner`. From then on `GET /api/me` returns your user object and the app loads.

If login succeeds but the app shows an error, the JWT was rejected. The reason is logged, once per
request, by the server — not shown to the browser:

```sh
grep cf-access ~/Library/Logs/veneer-pro/veneer-pro.log | tail
# "[cf-access] JWT rejected: unexpected \"aud\" claim value"  → VP_CF_AUD is wrong
# "[cf-access] JWT rejected: unexpected \"iss\" claim value"  → VP_CF_TEAM_DOMAIN is wrong
```

---

## The same thing over the API

For scripting. Create an **Account API Token** (dashboard → My Profile → API Tokens → Create Token →
Custom token) with these permissions:

| scope | permission | needed for |
|---|---|---|
| Account | Cloudflare Tunnel — Edit | create the tunnel, read its token, set ingress |
| Account | Access: Apps and Policies — Edit | create the Access application and policy |
| Account | Access: Organizations, Identity Providers, and Groups — Read | read the team's `auth_domain` |
| Zone | DNS — Edit | the CNAME, if you do not let the dashboard create it |

```sh
export CF_API_TOKEN='<token>'
export ACCOUNT_ID='<account id>'      # dashboard sidebar, or GET /accounts
export ZONE_ID='<zone id>'            # zone Overview page, or GET /zones?name=example.com
export HOSTNAME='veneer.example.com'
export OWNER_EMAIL='you@example.com'
api() { curl -sS -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
```

**Team domain (`VP_CF_TEAM_DOMAIN`):**

```sh
api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/organizations" \
  | jq -r '.result.auth_domain'          # -> your-team.cloudflareaccess.com
```

**Tunnel + token:**

```sh
TUNNEL=$(api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel" \
  --data '{"name":"veneer-os","config_src":"cloudflare"}')
TUNNEL_ID=$(echo "$TUNNEL" | jq -r '.result.id')

api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  | jq -r '.result' | tr -d '\n' > ~/.config/veneer-pro/cloudflared-token
chmod 600 ~/.config/veneer-pro/cloudflared-token
```

**Ingress (the public hostname → loopback mapping):**

```sh
api -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  --data "{\"config\":{\"ingress\":[
    {\"hostname\":\"$HOSTNAME\",\"service\":\"http://localhost:3100\"},
    {\"service\":\"http_status:404\"}]}}"
```

**DNS CNAME, proxied:**

```sh
api -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  --data "{\"type\":\"CNAME\",\"name\":\"$HOSTNAME\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}"
```

**Access application (`VP_CF_AUD` is `.result.aud`):**

```sh
APP=$(api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  --data "{\"name\":\"Veneer OS\",\"domain\":\"$HOSTNAME\",\"type\":\"self_hosted\",\"session_duration\":\"24h\"}")
APP_ID=$(echo "$APP" | jq -r '.result.id')
echo "$APP" | jq -r '.result.aud'        # -> VP_CF_AUD
```

**Allow policy:**

```sh
api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" \
  --data "{\"name\":\"Owner\",\"decision\":\"allow\",\"include\":[{\"email\":{\"email\":\"$OWNER_EMAIL\"}}]}"
```

To add someone later, `PUT` the policy with the extended `include` array, then approve them in
**Settings → People & access** once they have signed in once.

**AutoShip verifier application (option A, optional).** A second self-hosted application on the
same hostname, scoped to the verifier path, with a Service Auth policy for exactly one service
token. Its `aud` becomes `VP_AUTOSHIP_VERIFIER_CF_AUD` and the token's client id becomes
`VP_AUTOSHIP_VERIFIER_CLIENT_ID`; the client secret goes straight into the OrderOps Doppler config
and is never displayed. The owner application above is not changed.

```sh
TOKEN=$(api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/service_tokens" \
  --data '{"name":"orderops-autoship-verifier","duration":"8760h"}')
echo "$TOKEN" | jq -r '.result.client_id'      # -> VP_AUTOSHIP_VERIFIER_CLIENT_ID
# .result.client_secret -> Doppler ervp/prd AUTOSHIP_VERIFIER_CF_ACCESS_CLIENT_SECRET (pipe, never print)
VAPP=$(api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  --data "{\"name\":\"Veneer AutoShip Verifier\",\"domain\":\"$HOSTNAME/api/autoship/verifier\",\"type\":\"self_hosted\",\"session_duration\":\"0s\"}")
VAPP_ID=$(echo "$VAPP" | jq -r '.result.id')
echo "$VAPP" | jq -r '.result.aud'              # -> VP_AUTOSHIP_VERIFIER_CF_AUD
api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps/$VAPP_ID/policies" \
  --data "{\"name\":\"OrderOps verifier\",\"decision\":\"non_identity\",\"include\":[{\"service_token\":{\"token_id\":\"$(echo "$TOKEN" | jq -r '.result.id')\"}}]}"
```

Rotate by creating a new token, updating the policy include and the Doppler keys, then deleting
the old token. Deleting the application or token revokes the verifier entirely.

---

## Optional Cloudflare pieces, later

None of this is needed to log in. Each is off until fully configured; see the README's
**Environment → Publishing** table for exact defaults.

- **Published pages (R2).** `VP_PAGES_CF_ACCOUNT_ID`, `VP_PAGES_CF_API_TOKEN` (R2 Storage Write),
  `VP_PAGES_BUCKET` (default `veneer-pages`), `VP_PAGES_PUBLIC_BASE`. Create an R2 bucket, attach a
  public hostname to it, and set the public base to that origin. Publishing stays disabled unless
  the account id, the token and the public base are all present.

  **Live on this install (2026-09-16):** bucket `veneer-pages`, custom domain
  `https://pages.nicksworld.dev` (R2 custom domain on the `nicksworld.dev` zone), 7-day expiry
  lifecycle rule on the `p/` prefix (the server creates and keeps it). `VP_PAGES_CF_ACCOUNT_ID` and
  `VP_PAGES_PUBLIC_BASE` are in `~/.config/veneer-pro/env`; the scoped token (Cloudflare token name
  `veneer-pages-r2`, Workers R2 Storage Write) is the Doppler secret `VP_PAGES_CF_API_TOKEN` in
  `main/prd`, which the web service reads at boot. Agents get the `publish_page` / `list_pages`
  tools plus the `veneer-publish-page` skill automatically once these are set; a restart is needed
  after changing them.
- **Cloudflare-hosted Mini Apps (Workers).** `VP_APPS_CF_ACCOUNT_ID`, `VP_APPS_CF_API_TOKEN`
  (Workers Scripts Write + Workers Routes Write + R2 Storage Write), `VP_APPS_CF_ZONE_ID`,
  `VP_APPS_PUBLIC_ORIGIN`. One isolated Worker and route per app; the Workers token is deliberately
  separate from the Pages one because it needs broader scope. The Pages keys fall back to the
  `VP_APPS_*` account id and token when unset.
