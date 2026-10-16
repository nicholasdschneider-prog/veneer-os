# Veneer Ticket Mirror principal (build #868, 2026-10-16)

- OrderOps principal: `veneer:ca80d9c1-3ca0-489f-ac45-b87ac7a1603a`, display name "Veneer Ticket Mirror (read-only)", integration veneer.
- Credential fingerprint (SHA-256 prefix OrderOps keeps): `c3d89115da56`. The raw credential lives only in Doppler ervp/prd as `ORDEROPS_TICKET_MIRROR_BOT_CREDENTIAL` (id in `ORDEROPS_TICKET_MIRROR_BOT_ID`); never printed.
- Verified: `GET /api/cs/leases/capability` returned 200, authorized, same principalId.
- OrderOps grants enrolled Veneer principals `orderops:full`; Veneer's poller (server/src/csTickets/poll.ts) enforces a GET-only path allowlist in code, pinned by a test. It is never used for leases, assignment, status or sends.
- Revoke: OrderOps bot-principal revocation for this principalId, then delete the two Doppler secrets.
