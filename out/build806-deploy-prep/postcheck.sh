#!/bin/zsh
# Read-only BUILD806 combined-deploy pin/postcheck. Usage: postcheck.sh [db-path-or-uri] > pin-<label>.txt
# Never writes: opens the database read-only (or immutable URI). Safe before and after the restart.
D=${1:-$HOME/.local/share/veneer-pro/veneer-pro.db}
q() { sqlite3 -readonly -json "$D" "$1" 2>&1; }
pin() { local out; out=$(q "$2"); echo "## $1 sha256=$(print -r -- "$out" | shasum -a 256 | cut -c1-64)"; print -r -- "$out"; }
echo "# postcheck $(date -u +%FT%TZ) db=$D"
pin migrations-0176+ "select name, content_hash from migrations where name >= '0176' order by name"
pin new-schema-objects "select type, name, tbl_name from sqlite_master where tbl_name in ('purchase_interrupted_reviews','purchase_interrupted_dispositions') order by tbl_name, type, name"
for t in purchase_interrupted_reviews purchase_interrupted_dispositions; do pin "count:$t" "select count(*) n from $t"; done
pin run:7056b7cc "select * from scheduled_task_runs where id='7056b7cc-80d7-4504-b630-b11226b86eb3'"
pin task:9c72a42a "select * from scheduled_tasks where id='9c72a42a-40df-4477-9ba6-07f74ac08bf3'"
pin batch:551a9f86 "select * from purchase_event_batches where id='551a9f86-fbde-412d-80e2-ae3230a61390'"
pin worker-start:b5914b51 "select * from purchase_worker_starts where turn_id='b5914b51-41ce-4406-bd31-a3300a33ac4b'"
for x in 2080773d-b311-44a3-9b58-3e2eaa43664a ae219af0-50ce-4ed8-95e7-f7e43fa3fbe3; do
  pin "exclusion-receipts:${x[1,8]}" "select * from purchase_event_receipts where payload_json like '%$x%' or receipt_json like '%$x%' order by event_id"
  pin "exclusion-autoship:${x[1,8]}" "select * from autoship_candidate_events where payload_json like '%$x%' or receipt_json like '%$x%' order by event_id"
done
pin fk-violations "select count(*) n from pragma_foreign_key_check"
