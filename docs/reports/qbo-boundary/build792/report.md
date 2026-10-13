# QBO immutable receipt replay correction

Exact stored receipt-ID/hash replay now returns idempotently within the existing SQLite IMMEDIATE transaction, after authentication and reservation correlation. It does not append a receipt, regress the terminal outcome, or grant refresh/operation entitlement. Changed payload with the same receipt ID still conflicts; new contradictory or changed terminal evidence still conflicts. UNKNOWN may resolve to a terminal outcome; FAILED_NO_RETRY remains a proven terminal failure, not an uncertain effect.

The focused regression covers UNKNOWN A, terminal B (both SUCCESS and FAILED_NO_RETRY), then exact replay A. It checks unchanged raw history, readback retaining both receipts, false entitlements, changed same-ID rejection and changed terminal-evidence rejection. Existing terminal conflict tests remain intact. All fixtures are offline; no QBO/helper/provider refresh or accounting effect was performed.

[Validation receipt](./validation.json) records checks and byte hashes. Deployment is pending an approved maintenance window; no production restart or live acceptance is claimed. BUILD785's unavailable authoritative adapters and helper acceptance remain unchanged. This repair adds no capability or setup path, so existing guide instructions remain accurate.

Changed implementation: [boundary.ts](/Users/archerclawdington/veneer-os/server/src/qbo/boundary.ts).
Regression tests: [qboBoundary.test.ts](/Users/archerclawdington/veneer-os/server/test/qboBoundary.test.ts).
