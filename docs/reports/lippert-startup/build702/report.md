# Build 702 — out-of-credits startup failure reconciliation (Oct 11, 2026)

Authority: Nick, 2026-10-11 09:13 ET, relayed by Assistant chat bcca343a (coordination 8ba6b138).

- Cause: run fc435b2b (Oct 8) failed with Claude's synthetic 429 "You're out of usage credits…"; batch 59c6b494 stayed blocked (WORKER_OUTCOME_UNRESOLVED). The startup reconciler only matched "You've hit/reached your … limit", so the task-wide fence could not be cleared. The scheduler reports that fence as `already_running`.
- Fix (ca17a37): purchaseStartup.ts also accepts `/^You're out of (?:usage )?credits\b/i`; every metadata/archive/run.error check still applies. Deleting a run referenced by purchase batches/worker starts now returns 409 PURCHASE_RUN_RETAINED instead of a 500 FK error.
- Not done: distinct run-now refusal codes (still `already_running` for fences/holds/no hints).
- Validation: typecheck; server suite 292 files / 3,873 passed, 15 skipped; build; `npm run restart` (web, runner, then app-runner/term/browser-manager), healthy.
- Reconcile: [inspect](./inspect.json) and [reconcile](./reconcile.json) HTTP 200, hash 6b280b13…87ac8, disposition recorded 13:49:36Z. Fence query returns 0 rows; decision holds dispatch_blocked=false.
- Effect: the 13:45Z cron slot launched run 7c3cc617 at 13:49:37Z, linked to pending batch a97e8438 (pre-cleared by the Assistant chat).
- Order #100122463 (ae219af0) stays permanently excluded from automatic work. Shopify shows PAID/UNFULFILLED, tags Dropship Submitted + vendor-preparing, Furrion 2021123948 ×2.
