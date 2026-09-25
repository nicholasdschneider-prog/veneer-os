# Owner scope handoff — BUILD343

This is compatible with BUILD340's strict source `POST /api/cs/routine/scope-evidence` body. Source schemas, configuration and source endpoint execution remain with the original OrderOps custodian. Preparation supplies data, not scope classification or business authority.

## Genuine owner preparation

The actual current owner uses `/#/routine-scope-review` after enrolled source setup. The existing owner-only list/review APIs enforce original decision ACLs. Review now returns the original proposal in the same database snapshot as its version/hash/event tuple; no separate read can mismatch the displayed scope.

`POST /api/bot-communication/routine-messages/hold-scopes/handoffs`:

```json
{
  "trust_id":"actual enrolled trust",
  "decision_id":"exact reviewed decision",
  "decision_version":1,
  "proposal_hash":"64hex",
  "event_revision":0,
  "expected_handoff_id":null,
  "request_key":"stable owner request UUID",
  "roots":[{
    "canonical_case":"actual source conversation UUID",
    "source_reference":"https://registered-source/api/cs/conversations/actual-source-UUID"
  }],
  "confirmation":"source-locators-only-not-scope-classification"
}
```

References must be record URLs on the enrolled source origin with their selected UUID as a path segment; credentials/query/fragment are rejected. UUIDs are 1–100 unique roots. These references document owner-selected lookup provenance, not verified relationship facts or a completeness certification. No roots are derived from native prose. Source projection must establish all relationships; the owner later verifies that the full projection covers the original obligation.

Creation is immediate/transactional, checks exact current owner/trust/executor/decision ACL/version/hash/event and optimistic previous handoff ID. It appends an immutable revision, generates one stable source request UUID, and stores the owner input hash. Identical current requests return the same handoff; changed inputs or stale expected revisions fail. No decision/approval, source registry or customer record is changed.

`POST .../hold-scopes/handoffs/revoke` with `{trust_id,handoff_id,reason}` appends an immutable revocation. Current owner can revoke after trust/policy revocation. Superseding a revoked handoff requires a new explicit owner preparation and expected prior ID; it does not reactivate prior evidence or approval.

## Exact authenticated source transfer

The owner review exposes the handoff ID and this exact compatible `source_request`:

```json
{
  "requestKey":"native-generated stable source UUID",
  "roots":["exact selected source UUID"],
  "decision":{"id":"native decision ID","version":1,"proposal_hash":"64hex","event_revision":0}
}
```

Give this bounded request to the original source custodian for the named executor. Only that executor, through its own authenticated source connection, submits this object **unchanged** to the existing source `POST /api/cs/routine/scope-evidence`. No source bearer may be forwarded to native; no Platform bot may use Avery's credential. The source's own registered dedicated service posts the resulting evidence back to native. This completes the authenticated owner→immutable native handoff→own source projection→native matching chain without adding fields to BUILD340's strict body.

The dedicated service may additionally read `GET /api/routine-message/verifier/scope-handoffs/:id` for one exact known ID. There is **no list/inventory endpoint**. It validates current dedicated identity, trust, owner, original decision ACL and exact tuple, returning the source request and account/principal/executor/digest binding, revision and `execute:false`. It omits native proposal text, inventory, user identity and private owner reference URLs. Unknown IDs return404; revoked/superseded/changed records fail. A GET never exports source records or sends anything. It is not a permission to retry a lost source observation.

For a decision with an owner handoff, native accepts the **first** projection only with its exact source request UUID, matching decision tuple and closure containing **every** selected root. Accepted evidence receives a separate immutable handoff link. A caller cannot establish a different root set by supplying a guessed category or native tuple. The source's authenticated complete closure is still required and its local registry remains preparation data.

After that first observation, BUILD340's explicit fresh observations may use new UUIDs while matching the same current handoff tuple and containing all selected roots. Every such observation is linked to the same handoff. Existing no-handoff manually reviewed scope records retain their prior semantics; no historical approvals are rewritten.

## Owner classification and execution coverage

After receiving the source projection, the owner refreshes the selected decision, reviews every case/customer/alias/order and the original full obligation, then uses the existing `/hold-scopes/bind` endpoint. `case_set` requires latest exact source evidence linked to the current handoff (when one exists). `unknown`/`business_wide` stay blocking. Owner classification is explicit and separate from handoff preparation and all customer approvals.

The scope hash includes the handoff ID for linked observations. A new revision therefore requires new source observation and new owner classification, even if selected roots happen to be identical. Revocation or supersession invalidates linked evidence and coverage. Native context revisions also include handoff/revocation audits; capture, acceptance, reservation and first dispatch all recompute coverage within their existing transactions. Decision/event drift, incomplete roots, stale proof, changed ownership/trust or unknown effects deny. Cross-connection tests cover revocation racing first dispatch. Original decision events/approvals are untouched.

Lost owner mutation response: use existing owner review to read the latest handoff/binding; never blindly resubmit under a new key. Lost source observation response: use source `GET /api/cs/routine/scope-evidence/:requestKey`; it remains receipt-only/UNKNOWN and never causes a resend. Identity observations are not customer sends. Actual customer delivery still requires source eligibility/lease/material gates, first dedicated dispatch and actual Gmail SENT/native readback.

## Rollout custody

Platform ships0125 through the native build/restart loop. Original source custodian owns pinned0085→0092 adoption and ten pre-enrollment runtime values; actual POLICY_ID/TRUST_ID follow genuine owner enrollment. Final source adapter digest, enrollment/custody and runtime receipts must be reviewed before `preparedRoutineRegistration.source` becomes non-null. There is no policy/trust enrollment or case handoff created by this release.
