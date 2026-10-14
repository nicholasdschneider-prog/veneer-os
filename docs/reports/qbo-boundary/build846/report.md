# Retire the native QBO caller boundary

BUILD846 continues skipped BUILD841 on BUILD845 commit 3cd9067. Nick explicitly revived it and approved a restart window in chat 615e0081-3142-4333-adda-d177c1709608 at 2026-10-14 18:10Z. The original issue's corrected scope supersedes the stale Clara-only title: Anna and Clara use the same existing canonical helper, grant and qbo.lock without added bot attribution.

Removed native assignment admission, phase chronology, frozen helper identity/transport, operation reservation and receipt reconciliation implementation, its router mount, and its dedicated tests. No replacement mechanism was added. BUILD845 removals and owner-only build gate remain intact. Immutable migrations 0177 and 0179 and historical reports remain unchanged; no database records were deleted.

Updated the [catalog](../../../../server/src/featureGuide/catalog.ts), [guide](../../../bot-feature-guide.md) and existing [guide tests](../../../../server/test/botFeatureGuide.test.ts). Removed the mount from [bot routes](../../../../server/src/bots/routes.ts). Deleted the six retired server/src/qbo modules and two dedicated test files. Retired QBO postcheck requirements in the [old deployment report](../../../../out/build806-deploy-prep/REPORT.md) and removed their checks from [postcheck.sh](../../../../out/build806-deploy-prep/postcheck.sh). Historical report statements are not current acceptance requirements.

The ERVP helper was read, not edited or executed. Its existing lane, refresh and company checks have no native boundary dependency. Boris confirmed matching installed/canonical script copies and the existing ready configuration; this is supplied evidence, not a fresh provider test.

## One post-deployment check

Boris owns coordination in 39fa0f8e-da03-4abf-9d3f-eeaa3ce03174. Clara alone is to run exactly once after deployment:

    cd /Users/archerclawdington/Projects/ERVP/.agents/skills/clara-quickbooks-payables
    python3 scripts/qbo_auth_healthcheck.py

Read the script independently: it acquires the existing exclusive lane, refreshes and persists the rotated token, verifies company identity and runs SELECT Id FROM Bill MAXRESULTS 1. This is read-only for QBO accounting data, not a no-write credential operation. Do not retry a BLOCKED/uncertain result. No new enrollment, grant, token file, helper build or accounting effect is introduced.

## Validation

Sequential host-lock validation passed: focused guide 32; root typecheck; full installer 93, server 3253 passed/17 skipped (277 files), web 1013 (145 files), browser manager 55; root build and diff check. Standard Vite chunk-size warning only. See [validation receipt](./validation.json). Full/restricted employee and resumed-agent guide coverage passed. No QBO/provider/helper execution was used as a test.

Deployment and the one Clara check are separate from these offline results; see the final runtime receipt.

## Runtime disposition

Removal commit **8f01f0637cc99f2cf669468eb7c517fce621706b** is pushed to origin main.
The sanctioned web-only restart under Nick's approved window exited 1: **four active turns**.
No service was signaled or restarted, and no force flag/watcher was used.
The preflight also reported the existing web plist serves checkout dist in place; no installer
or deployment configuration was changed. A build is not a verified runtime deployment.

[Runtime receipt](./runtime.json) records the refusal. Existing maintenance owner
615e0081-3142-4333-adda-d177c1709608 received the exact commit and drain blocker.
Boris issue d35f83ea-2120-44ef-94c2-21a0358c4ea6 received the staged receipt and must
wait for actual deployment before coordinating the one Clara check. No QBO probe
has run. Completion of the requested deployment/check remains pending; removal
and offline validation are complete.
