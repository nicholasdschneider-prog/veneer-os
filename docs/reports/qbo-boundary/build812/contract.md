# QBO execution identity and phase chronology correction

October 13, 2026. BUILD812 is a staged native-only correction to
[BUILD804](../build804/contract.md), preserving BUILD792 exact replay.
No schema versions, hash domains, routes, stored receipt meanings or migrations change.
Production admission remains unavailable.

## Execution identity

The server-owned helper descriptor UID must equal the effective execution UID,
as obtained from process.geteuid(), before preparation succeeds (before reservation),
again when freezing launch bytes and immediately before spawn. Missing, throwing,
invalid or mismatched OS identity denies with QBO_HELPER_PROCESS_UNAVAILABLE.
The helper inherits the current process identity; there is no UID switching.
The injectable identity reader is a server-side offline test seam, not request input.
File ownership/hash/permission checks remain independently mandatory.

## Chronology and failure

Each new phase, including transport-ended, captures one clock sample and validates
it against the previous immutable phase. That same sample supplies recordedAt and
event authorization/expiry/observation checks. Invalid or regressed clocks cannot
append a phase, clamp a time or fabricate a terminal receipt.

A clock-faulted invocation refuses further new online events even if time recovers.
Finalization leaves its durable phase open. A finalization-only clock failure also
leaves the last phase untouched. This retains the grant fence and permanent effect
reservation; it does not replace the original private transport failure with a
timestamp error. Existing sanitization still withholds raw child diagnostics.
Later reads/replays return no entitlement, and cannot restart a command.
Authenticated receipt-only reconciliation remains the only evidence advancement
path; it must pass the clock check and never grants refresh/dispatch permission.
An exact already-stored receipt replay needs no new timestamp and stays idempotent.

## Bill observation

An accepted read-bill result must prove exactly one immutable transition from
dispatch not-started to started for the same invocation, reservation and provider
request hash. capturedAt must be at least that transition's recordedAt and at most
the single current phase sample. Reservation time is not a fallback. Missing,
ambiguous or foreign dispatch proof denies QBO_BILL_DISPATCH_PROOF_REQUIRED;
out-of-window or mismatched results deny QBO_BILL_RESULT_MISMATCH.
This applies equally to later UNKNOWN receipt-only reconciliation.
Observation expiry remains min(original capturedAt + 15 seconds, original
reservation expiry). No receipt or observation is rewritten.

## Unresolved prerequisites and ownership

The unconditional 30-second SIGKILL can interrupt rotated-token persistence and
remains unresolved. Frozen runtime/dependency closure and independently sanctioned
parent custody are not established by these checks or synthetic tests.
Authoritative assignment, accounting-policy and existing-grant adapters remain
absent. Boris owns later canonical helper adaptation only after acceptance of the
corrected interface; Clara owns accounting acceptance. No ERVP edits or helper
adaptation were queued in this build. No new enrollment, grant or consent is sought.
Deployment requires explicit human-approved maintenance and drained turns.
