# Native correction preflight — BUILD451

This is semantic review of native human context only. It supplies no approval, authority, draft, source fact, or dispatch readiness. Every inspect/review result has `execute:false`, `ready:false`, and `authority:false`. No records are inserted or updated; no migration is required. BUILD450 and every historical approval, consumption, draft and transport contract remain unchanged.

## Supported original-owner workflow

`inspect_correction_preflight` calls `POST /api/bots/composed-sms/correction-preflight/inspect` with this strict input:

```ts
{
  decision_id: string,
  expected_version: positiveInteger,
  original_source_id: string,
  correction_source_kind: 'direct_message' | 'result_reply',
  correction_source_id: string
}
```

The original source is the immutable consumed lineage, not the new correction. The exact correction ID comes from the original owner's evidence; no case-specific ID is invented. Draft, executor, recipient, account, source URL and credential inputs are not accepted. The preflight neither selects nor expands those scopes. It requires no draft to exist, even an old lineage draft.

A single native SQLite read transaction verifies the active registered decision owner, current author access, original authenticated source/consumption/answer/proposal hashes, and exact current version. It returns all bounded native direct messages, result replies with original anchors, decision discussion and decision events, plus original and current proposals. Current evidence ACLs apply to historical proposal snapshots too. Different case IDs are not interpreted as aliases.

The deterministic inspection hash binds the exact correction, complete native context, immutable original lineage, current proposal/version/state/answer/handling revision, owner and author. Later human messages are returned for interpretation; their mere presence is not automatic supersession. Nonhuman correction sources are rejected. Quoted content inside a genuine human message still requires semantic classification; it is not automatically consent.

Each surface is capped at 500 rows and the complete context/proposals at 120,000 UTF-8 bytes. Exceeding either fails closed without partial/excerpt review. Coverage explicitly excludes external source facts, attachment/media contents and provider/credential evidence. “Complete” means the supported native text surfaces, not external evidence completeness.

`review_correction_preflight` calls `POST /api/bots/composed-sms/correction-preflight/review` with the same input plus:

```ts
{
  inspection_hash: sha256,
  reviewed_full_context: true,
  correction: {kind, id, text}, // exact complete correction text
  interpretation: 'compose_and_send_direction' | 'wording_edit_only' |
    'status_only' | 'quoted_or_reported' | 'conditional' | 'ambiguous',
  explanation: string,
  later_context: [{
    citation: {kind, id, text}, // every later human message, exact complete text
    classification: 'status_only' | 'substantive_supersession' | 'ambiguous',
    explanation: string
  }]
}
```

Citation kind is `direct_message`, `result_reply`, or `decision_discussion`. Every later human message, including conservatively equal timestamps, must have exactly one full citation. Missing, duplicate, forged or excerpted citations fail. The server re-reads the complete current native snapshot and rejects any changed inspection hash. Revoked owner/author access or changed decision revision cannot reuse a prior review.

The original owner supplies accountable semantic interpretation, not keywords or a machine inference from “send.” A later status question supplies no consent and does not by itself supersede. A substantive correction yields `substantively_superseded`; ambiguous/conditional context yields `unresolved`. Other non-compose-and-send interpretations yield `not_compose_and_send_direction`. Even `direction_retained_for_semantic_review` is only an owner assessment: all authority/readiness flags remain false.

The returned review includes the authenticated reviewer identity, complete submitted assessment, inspection hash and deterministic review hash. It is **not persisted** and is not accepted by any authority or transport API. Identical stateless retries return identical assessments; there is no action key or business effect to retry. New context requires a new inspection. No revoked review can confer authority because none is created.

## Case and source boundaries

Original Grant's existing assessment request remains with source owner ae5d6289. No duplicate Grant request, borrowed identity, business interpretation or live case read is performed by the builder. The actual semantic result must precede any transport continuation.

BUILD450 still requires its own exact corrected draft/source evidence and retains its own supersession rules. This new preflight does not bypass or amend those gates. The future correction service projection remains an unaccepted proposal requiring exact binding fields, vectors, authenticated historical action-digest lineage and a scoped amendment. No transport work or source job belongs to this build.

Sender evidence is expired; actual dispatcher identity, scope completeness and recipient timezone remain separate and untested. Source closure is intentionally incomplete for correspondence/freeform; this preflight does not prove unrelatedness or request duplicate consent.
