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
