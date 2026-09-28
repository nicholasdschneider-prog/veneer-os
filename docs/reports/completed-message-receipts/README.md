# Receipt-only reconciliation after decision completion

BUILD418 separates recording an already-sent delegated message from authorization to send it. A completed decision remains completed. No customer/provider operation, reclaim, requeue, approval reopening or financial action is implemented.

## Root causes and repair

The delivery service reused `bound(..., true)`, whose proof and RUNNING checks reject `verified_completed`. The receipt HTTP route also parsed `delivery_proof` but omitted it from the service call. Both defects are repaired.

Only a `sent` receipt can use completed-state validation. Public inspect/delegate/accept/claim checks remain unchanged and continue rejecting completed decisions. The receipt path revalidates current actor/access, active users/bots, original approver authority, original human approval event, unchanged preapproval snapshot/version/proposal hash, exact scope/hash, immutable delegation and draft. Revocation still blocks it.

For a completed decision there must be exactly one immutable accepted event and one claimed event, in that order. Both must belong to the current original named executor; the accepted draft/hash and claimed draft/key/send-check hash must match the actual draft and delegation. A draft marked sending without that durable evidence is insufficient. The positive provider proof must still match account, recipients, canonical case, payload hash and `veneer-message:<draft ID>` idempotency key. Conflicting or reused provider receipts fail.

The existing immediate receipt transaction commits the provider proof, immutable sent event and draft state/receipt together. Identical retries remain idempotent, including a receipt first recorded while running and retried after completion. Concurrent conflicting proofs produce one success and one conflict. A failed validation produces no partial proof or sent state.

## Live reference and evidence boundary

User-supplied/native retained checkpoint (2026-09-28T16:41:38.578014Z): decision `0ab8477b-128c-4558-8293-711a41dd602d` v1 completed; draft `598a4e22-806f-4e12-8aa9-ed1eab8be6c1` sending; delegation `1aa0373a-8463-437d-a73a-93094468b0b4`; owner/executor Avery `170ab267-448c-4b13-97f4-5f24db2f3652`. The supplied Gmail/OrderOps delivery identifiers and body-readback note are not independent provider verification by Platform Dev. No production decision, draft, claim, receipt or provider action was used as a test.

## Original-Avery-only next step after deployment

1. Avery retains the original claim key privately. Do not copy it to coordination, issue another claim, generate a new key or resend.
2. Using her own retained verified provider readback, confirm the exact approved account `help@elkhartrvparts.com`, original recipient array, case `CS2Z22`, exact body/attachments, actual provider name/message ID, scope hash `8e0ce8c72b5325e7c6ffb21ca9513edae344897bcdf2d71b61ee729fa1851c8e`, and idempotency key `veneer-message:598a4e22-806f-4e12-8aa9-ed1eab8be6c1`. No inference from a completion note or queued action is sufficient.
3. As the original executor, call existing `record_message_delivery` with this draft ID, the original retained claim key, `state: sent`, a concrete receipt string and complete verified `delivery_proof`. Platform Dev must not call on her behalf. The server validates all bindings and persists only the receipt/audit.
4. Return the successful native tool result and own supported `list_message_drafts` readback showing this exact draft `sent` with its receipt, with no claim key disclosed. On an uncertain response retry only the identical receipt call/readback; never retry the external send. Conflicting/revoked/stale/missing-claim evidence remains blocked.

The remaining operational evidence is Avery's actual receipt-recording result and native readback. Until supplied, deployment does not mean this production draft has been reconciled or that Platform independently verified customer delivery.

## Verification

Offline SQL/service/HTTP tests cover same-owner and cross-bot completion, unchanged decision/history, closed pre-send operations, wrong actor/key/scope, missing/ambiguous/mismatched durable claims, changed proposal/version, revoked authorization, proof omission, identical retries, backend proof conflicts and concurrent receipt writes. Shared guide tests cover restricted employee access and fresh/resumed agent instructions. No migration/configuration change is required.

Root typecheck, 73 scoped tests, full npm test and production build passed before restart. Full totals: 2,634 server tests (five existing skips), 907 web tests, 42 browser-manager tests and 29 installer tests. Vite retained its existing large-chunk warning. Runtime verification follows deployment.

## Changed files

- [messageDelegation.ts](/Users/archerclawdington/veneer-os/server/src/bots/messageDelegation.ts)
- [communicationRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts)
- [messageDelegation.test.ts](/Users/archerclawdington/veneer-os/server/test/messageDelegation.test.ts)
- [botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Transport contract](/Users/archerclawdington/veneer-os/docs/reports/approved-message-delegation/contract.md)

Employee guide: `/#/bot-guide?feature=approved-message-delegation`.
