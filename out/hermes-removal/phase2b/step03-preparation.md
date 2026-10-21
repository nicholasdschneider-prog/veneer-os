# Step 3 read-only preparation — not a final custody receipt

No task mutation, helper execution, customer/mailbox query or source edit occurred. These snapshots were taken while tasks remain live and must not be used as the final adoption delta.

The Direct task invokes services/ERVP_Orders_Bot_Direct_Shopify-silent.vbs → profiles/ervp-orders/scripts/run_production_owner_policy_cycle.cmd → C:/Users/nicho/ervp-vendor-automation/production_owner_policy_cycle.py. Static imports identify dometic_pending_reconciler, lippert_pending_reconciler, owner_policy_runtime and governance_outbox_worker. dometic_stale_pending_reconciler was not found among resolved exact imports; verify exact absence at final capture rather than execute the wrapper.

The task settings snapshot at 10:26:49 ET showed Direct Running, engine PID17540 and instance GUID in step03-task-settings.json. This is historical evidence only: never stop that PID or reuse it as a current identity. Both tasks have IgnoreNew and a 72-hour execution limit. All_Order_Review was Ready. Do not disable Direct until its actual live cycle and descendants drain.

Exact local stores discovered:

- Hermes profiles/ervp-orders/state/orders-bot/owner-policy-candidates.json: 78 retained candidates at preliminary capture.
- Same directory owner-policy-lane/owner-policy-lane.json: 393 groups, 192 processed slots; a historical pre-catchup JSON is separate retained history.
- Same directory commands.json: 843 retained commands.
- Preserved repo ervp-vendor-automation/state/vendor-order-runs.json: orders dictionary1803, fingerprints694, runs list0. These are stored container sizes, not a claim of 1803 pending orders.
- Preserved repo memory/dometic-pending-verification.json: pending list33 and active_pending_pos list33. Final active count/status still needs a safe projection, not an inferred claim from list lengths.
- Preserved repo state/vendor-governance.sqlite3: governance_outbox467 retained rows, workflows13, reply events16, audit255, lippert notification workflows203. These are all-row counts, not pending counts. Columns recorded in step03-lock-schema-prep-expanded.json. Final pending outbox projection must exclude payload_json, customer contacts and reply bodies.

The owner-policy LaneState.exclusive protocol creates owner-policy-lane/owner-policy-lane.lock as a directory and removes that same transient directory on release. Orders worker directory_lock uses state/orders-bot/owner.lock, command-state.lock and owner-recovery.lock. Read the exact current source-defined acquisition/release protocol before applying it; never remove someone else’s lock. The top production wrapper has no obvious full-cycle locking call in the bounded AST audit. A lane lock alone must not be claimed to cover prior reconciler or later outbox phases. Reconcile actual Windows task scheduler instance ownership and drain checks before final custody/disable; IgnoreNew does not prevent a new scheduled instance after the prior one exits.

Final custody must occur after both LTL observations pass and before Direct disable, with fresh instance/process identity checks and actual scheduler/state ownership. Preserve original files on PC and write a new PC-only custody snapshot plus sanitized delta for Sage: safe order/command/workflow IDs, statuses, pending counts, per-field fingerprints, file hashes/mtime and limitations. Do not export customer bodies, contacts, cookies, credentials or secrets. Do not invoke any business module to obtain this data. Capture readonly SQLite under the actual source-defined ownership/consistency rules.

All earlier disables are final and must not be repeated. Until Step 2 completes, Step 3 remains read-only preparation.
