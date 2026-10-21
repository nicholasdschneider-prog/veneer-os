# Hermes removal — Nick's decisions (2026-10-16, chat fce19860)

1. Brent OrderOps reply watch (cs-tim b2b5b67f02c0) and Brady shipment SMS reply watch (cs-tim 394f30773d39): **RETIRE**. No native rebuild. Both have returned HTTP 403 for weeks with no cursor; Avery keeps reference custody of the 44 CS task IDs only.
2. Inventory sync incident router (ervp-manager d68cb0c1ae05): **RETIRE**. Nick: Hermes is not used at all; Veneer coverage as it stands is sufficient.
3. Codex PC operator (chat bf7f4e6f) executing stops over Tailscale SSH once the stop plan is in: **APPROVED**. Tiered stop → observe → archive → uninstall, rollback kept at each step.

## Owner answers (2026-10-16, ~12:03Z)
- Sage: Dometic watches YES (adopted into four-daily task); All_Order_Review NO (scanner parity); Direct_Shopify NO (needs freeze/drain/handoff of reconcilers + governance outbox); BUILD808 credential fault recovered, end-to-end import still unproven; SHADOW lane: confirm shadow-only first.
- Archer: Martine YES; fourth mailbox archerclawdington@gmail.com NO (unbound) → Nick must drop or connect.
- Boris: one replacement build, five lanes (Trending, LTL metadata, returns watchdog, vendor-failure feed, every-order scanner), shadow → stop Windows writer → enable → observe; queue rejected his coordination turn, needs Nick-started turn (queued from this chat).
- PC operator: phase 1 complete (59117a6), 107-row stop plan; phase 2 GO sent for 9 cleared items; archive on PC disk requested.

## BUILD863 (2026-10-16 13:16Z)
- Five replacement lanes deployed to Railway in shadow (commits 24eb22e1, fc54a9f2, 599de6be). Report: /Users/archerclawdington/Projects/ERVP/Order Ops/output/build863/report.md. Boris acceptance requested (thread 425424e4). Per-lane live flip = `railway variables set --service orderops-web ORDEROPS_HERMES_LANE_<NAME>=live` after the PC operator stops the matching Windows job.

## 09:32 ET review (2026-10-16)
- PC operator: items 1–2 verified (completion mirror disabled 08:39; Brent/Brady + cs-tim gateway retired 08:51, clean at 09:28); item 3 (inventory router) disabled 09:28:55, observation pending; items 4–9 serial; PC archive ~72.5 GiB copied, unverified. Receipts: out/hermes-removal/phase2/README.md.
- Boris REJECTED cutover acceptance for all five lanes (13:21Z). Repair criteria: no mutation retries + independent readback; durable scheduler exclusion; durable alert attempt records; Trending low-data = control-only hidden_low_data + epoch 0 (Piper contract, out/piper/hermes-trending-acceptance-20261013); LTL lookback/completeness proof + separate readback; Returns preflight = POST /api/returns/lookup with content-type; failure feed process death from action events, gaps block delivery, seed legacy 526 ids, hold 5794a63b; scanner per-row freshness, Sage conflict rules, ledger continuity.
- enqueue_build for the repairs was REFUSED (needs a Nick-started turn). Lanes stay in shadow; Windows jobs for the five lanes stay HELD. Nick must say "queue the BUILD863 repairs" in this chat to proceed.

## 14:40 ET review (2026-10-16)
- Phase 2: items 1–6 and 8 verified; item 7 (Lippert SHADOW lane) SKIPPED, left enabled (no-unique-pending-output prerequisite not established); item 9 idle gateways: cs-mallory/jasmine/rae/ali/joe, cust-service, nick done, hermesops-2 observing, accounting-sharon / tripower-consulting / default remaining. Dashboard, auth sync, CS gateways retired.
- Archive: copy done, hashing in progress with 3,165 accumulated errors; NOT verified. supervisor.lock preserved separately.
- Boris: unchanged. BUILD863 repairs still await a Nick-started turn. No live flips.

## 17:40 ET review (2026-10-16)
- Phase 2 complete except item 7 (SHADOW lane, skipped) and the held business jobs. Item 9: ten idle gateways verified stopped; `default` profile retained because it aliases root where the held LTL cron lives.
- Archive hashing at 2.66M of 2.78M files, 3,217 errors, not verified; verdict and error list pending controller completion.
- Remaining on the PC: ervp-manager, ervp-orders, hermesops gateways (host the five held jobs), Brain backup, vault drift, SHADOW lane, Startup launchers for those. Nothing further until BUILD863 repairs (Nick-started turn) and Boris acceptance.

## 2026-10-17 12:05 ET check
- Phase 2 final report: out/hermes-removal/phase2/final-report.md. PC recovery baseline verified 00:41 ET (2,757,421 files, 468 SQLite OK, 0 errors after reconcile); credentials excluded; not a quiescent seal.
- Boris thread unchanged; BUILD863 repairs still await a Nick-started turn. Fourth-mailbox decision still open. No live flips, no further stops.

## 2026-10-21 — Nick: retire everything
- Nick (own turn): "Literally none of those are needed anymore or are covered already by Veneer." All seven held jobs RETIRE outright: Trending, both LTL mappers, All_Order_Review, Direct_Shopify policy cycle, vendor-failure alerts, returns watchdog, Archer material-alert (fourth mailbox DROPPED).
- BUILD863 repairs cancelled; ORDEROPS_HERMES_LANE_* set to off on Railway (--skip-deploys). Lane code stays inert.
- PC operator sent phase 2b GO (all remaining crons/tasks/gateways → zero Hermes processes), then quiescent archive seal, then phase-3 plan (tasks/launchers removed; data-root deletion needs Nick's confirmation via this chat).
- Boris, Sage (final policy-cycle delta to adopt read-only), Archer notified.
- 2026-10-21 (later, Nick traveling): "Delete it too" — phase-3 deletion of the Hermes data roots APPROVED in advance, gated only on a verified quiescent archive seal. Operator instructed (request_key hermes-pc-operator-phase3-delete-approved-20261021); keeps backups/, ervp-vendor-automation, orderops-src, Tailscale/SSH.

## 2026-10-21 15:50 ET check
- Phase 2b: steps 1–3 verified (all 9 crons + both Windows tasks disabled; Direct_Shopify/All_Order_Review drained and captured). Step 4: vault verified; Brain Backup disabled, 4h window released by coordinator. Step 5 (gateways) and step 6 (seal) released to proceed now.
- Sage delta forwarded (step03-sage-pending-delta.json: 94 unresolved rows, outbox 417 delivered/50 failed_ambiguous, 33 Dometic pending-active).
