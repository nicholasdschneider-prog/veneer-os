# BUILD445 — Separate scope-evidence credential

Provisioned `ervp/prd/OO_COMPOSE_SMS_SCOPE_EVIDENCE_CREDENTIAL` at 2026-09-29T01:36:19Z through the existing machine-authenticated Doppler operator profile. Fresh names-only checks found no previous scope/evidence credential; only the four existing composed transport/action references were present. No existing value was read, reused, replaced or overwritten.

SHA-256 commitment: `97f8ab6d780e0c78f216c6300ce9cd705cc4c48a7d67b76f5c889abe937b3125`.

The new value was generated from 48 random bytes in process memory and passed directly to Doppler stdin. Command arguments, files and logs contain no value. Verification consists of the successful write acknowledgement and subsequent exact names-only destination readback; no stored value was retrieved.

The intended ACL is solely `scope.action.read`, GET `/api/cs/composed-sms/scope/actions/:nativeActionId/:rootUuid`, without query, redirect, listing or fallback. It binds service principal `a56c2846-d4e1-4b5e-8287-7953c08998f0`, registration `e0f86977-b32e-4eb4-a995-c27746fafa81` revision1 and the unchanged source registration hash. The wrapper authenticates this service reader; source independently revalidates the durable original Tess executor. It never authenticates as Tess or grants other source routes.

Use-time grant expiry must be no later than **2026-10-28T00:14:26Z**, subject to earlier credential/custody/registration revocation. This is a grant enforcement cap, not intrinsic expiration of the random secret material.

Original custodian a4bc must issue final exact route and immutable technical snapshot issuance custody. Source owner ae5d remains the sole installation editor and must install the accepted exact-action ACL. Neither permission nor source installation is claimed by this provisioning receipt. The earlier unbound receipt is not widened. Native activation, positive sender evidence, guards and customer dispatch remain unavailable.

This was provision/report-only work: no application source, executable automation, schema or deployment configuration changed, so no application build/restart was performed. Final BUILD444 source and contract hashes were independently verified. No source/provider/customer probe, sender refresh, authority, claim, send or native registry activation occurred. Existing unrelated files were preserved.

[Complete nonsecret binding and verification receipt](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build445/provisioned.json)
