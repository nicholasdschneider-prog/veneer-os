# Prospective completed-case custody — BUILD485

Native issuer/verifier implementation for the existing BUILD484 dependency. Source interface agreed with Boris; operational integration remains unavailable. No production trust, enrollment, authority, claim or transfer was created by this build.

## Exact scope

An authenticated current human-owner instruction plus the original enrolled reviewer’s complete semantic/context and prior-effect review can produce a new, prospective, immutable authority. It binds exact source case/version, foreign completion event/hash/chronology, genuinely enrolled historical and destination principals, business/account/runtime, native context, source material and expiry. The only proposed source mutation is an insert into a separate prospective custody ledger. Historical cases, assignments, completion records, null closure timestamps and old approvals remain unchanged. This does not itself authorize reopening, leases, sending or financial effects.

Dedicated CF/service/reader trust is separate from all existing grants. An actual human owner must prepare and confirm technical enrollment against authenticated source evidence. Review and service calls require current actor/enrollment access. Source projections are evidence, not consent. Missing or oversized native context, unsupported decision discussion, ambiguous instructions or unresolved effects block issuance. Status and quoted/bot text do not supply authority. The server authenticates the context; the named original reviewer supplies accountable semantics, without a keyword classifier.

The source must persist PREPARED then REDEEMING before redeeming. Native authenticates the original persisted intent, reserves once in an immediate transaction, and returns custodyEntitlement:true only on the first successful association (execute remains false). Claim-before-revoke is irreversible; revoke-before-claim denies. Read/replay/UNKNOWN/expiry and even authenticated terminal rollback never free the action. UNKNOWN can retain a null claim ID after a lost response; reconciliation finds the actual native claim without another attempt. Terminal receipts require detailed authenticated source audit proof. There is no distributed atomicity or post-claim revocation guarantee.

Native uniqueness conservatively covers case ID + original completion event across registration replacements, and source request uniqueness within registration. A new draft/key/registration cannot escape a retained authority or reservation. Source must implement its own transactional uniqueness and effect guards; native fixtures are not source PostgreSQL coverage.

## Contract and artifacts

- [Frozen agreement](agreement.json)
- [Exact routes, schemas and failure contract](contract.md)
- [Parser-validated synthetic golden vectors](golden.json)
- [One concrete human technical enrollment workflow and missing evidence](setup.md)
- [Implementation byte manifest](implementation-manifest.json)
- [Changed files](changed-files.md)

## Remaining operational prerequisites

Boris owns the source evidence/intent producers and custody consumer, including actual source uniqueness, rollback and UNKNOWN reconciliation tests and acceptance receipt. The rightful source custodian must establish dedicated service/reader custody, real historical-principal evidence and current Nora source authorization. Platform owns subsequent protected configuration. The actual human business owner confirms the one technical enrollment after those facts exist. Henry owns the genuine human instruction, prior no-parallel/effect review; Nora remains the sole business executor and must complete the pending own-identity Stage1 acceptance.

The retained references for 119926 and 120292 are observations, not builder-verified current cases. No live case, provider, credential, lease or customer probes were performed. Foreign attribution, null closure times and event-after-case unbound chronology were deliberately preserved. No duplicate Dometic business approval was requested.

## Validation

The final root suite passed: installer 29; server 3138 passed/5 skipped in 254 files; web 931 in 137 files; browser-manager 49. Focused release tests passed 133 across six files, plus the isolated WebSocket test. Typecheck passed. Employee-guide access and refreshed instructions for resumed chats are covered by the focused guide/workflow tests.

Validation exposed an identical-issuance race, now reconciled transactionally. Two test-only synchronization fixes were also needed: purchase-timing samples its verifier clock after SQLite writes the human answer; the WebSocket history test waits for the observed frame instead of sleeping 20 ms. No purchase-timing or WebSocket application behavior changed. Earlier failed runs were not used to authorize restart.

Root build passed (Vite reported its nonfatal large-chunk warning). See [validation receipt](validation.json). Runtime verification follows the implementation commit.
