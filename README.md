# sap-gov-sandbox

Governed maintenance stock validation on SAP BTP (CAP + SAP HANA Cloud).
Replaces the LLM-does-the-arithmetic step that produced "short by 1.2 units" for material 41
(required 1.7, available 500). Lookups and arithmetic run in code; every call lands in `gov.AuditLog`.

## Service (`/stock`, scope `agent`)
| Function | Joule skill it replaces |
|---|---|
| `getMaintenanceOrderDetails(orderID)` | GetMaintenanceOrderDetails |
| `getOrderOperations(orderID)` | GetOrderOperations |
| `getOperationComponents(operationID)` | GetOperationComponents |
| `getMaterialDetails(materialID)` | GetMaterialDetails |
| `getMaterialStockLevels(materialID)` | GetMaterialStockLevels |
| `validateOrderStock(orderID)` | the agent's reasoning step, now deterministic |

`AuditLog` is readable with scope `auditor`.

## Sample data (db/data)
Order 1000001: material 41 needs 1.7 vs 500 available (SUFFICIENT); material 42 needs 10 vs 8.8 (SHORT by 1.2).

## Run locally
    npm install && npm test          # arithmetic + audit test on in-memory SQLite
    npx cds watch                    # local mock users agent/agent, auditor/auditor (development only, not real credentials)

## Deploy to the BTP trial (from the BAS dev space terminal)
    cf login --sso                   # org 06407a50trial, space dev
    npm install && npx mbt build
    cf deploy mta_archives/sap-gov-sandbox_1.0.0.mtar

The HDI container binds to the free-tier HANA instance `govsandbox` (already mapped to space `dev`).
Free-tier HANA stops nightly; restart it in HANA Cloud Central before use. Seed CSVs redeploy with the db module.

## Operating notes (trial account)
- **Start HANA first.** The free-tier SAP HANA Cloud instance `govsandbox` stops every night and is deleted after 30 days stopped.
  Restart it in HANA Cloud Central before using the service or the chat agent, otherwise lookups fail.
- **Audit trail.** Every call is recorded in `gov.AuditLog` (outcome OK / ERROR / DENIED, HTTP status, caller, correlation id).
  Read it with the `auditor` scope (role collection `GovStockAuditor`) via `GET /stock/AuditLog`.
- **Correlation.** Send `x-correlation-id` per conversation; without it the Cloud Foundry request id is used.
- **Network.** The database accepts connections from Cloud Foundry only, so read it from inside CF
  (for example `cf run-task sap-gov-sandbox-srv`) rather than from a laptop.


## Audit trail v2 (2.0.0)

Every audit row now also records `endUser` (who the agent asked on behalf of; sent in the `x-end-user` header, asserted by the caller and not authenticated), `dataVersion` (SHA-256 of the exact rows the answer was computed from), `asOf`, `ruleVersion` and `schemaVersion`.
Rows are chained: `seq`, `prevHash` and `hash` (SHA-256 over the row plus the previous hash). `GET /stock/verifyAuditChain()` (auditor role) recomputes the chain and reports the first edited or missing row.

Limits: this detects tampering, it does not prevent it (a database administrator can still change rows; use HANA audit policies or an external anchor for that). One writer holds the chain at a time, which is fine for one CF instance and trial volume. Rows written before v2 have no `seq` and are reported as `legacyUnchained`.

## Audit v2.1: export and reconciliation

**Export.** `GET /stock/exportAudit(fromSeq=1,limit=500)` (auditor role) returns the trail as JSON Lines: a header that says how to verify (`hashedFields` per schema version, algorithm, genesis, head hash), then one line per row. The export is itself an audited call. Verify a file anywhere, with no SAP system and no dependencies:

    node tools/verify-export.js audit-export.jsonl

It exits 0 when the chain is intact, 1 when it is broken (and prints the first bad `seq`). A file that starts after seq 1 is checked for internal consistency only; the header says so.

**Reconciliation.** After `validateOrderStock` computes its verdict, `srv/sor.js` reads the same materials from an independent source (`gov.SystemOfRecordBalances`, standing in for the S/4HANA material ledger) and compares. The answer carries `reconciliation: {status, mismatches}` and the audit row carries `reconciliation = MATCH | MISMATCH | UNAVAILABLE`, hashed into the chain. A mismatch does not change the verdict and does not block the answer; it is a flag for a human. `UNAVAILABLE` means the ledger could not be read.

Limits: the ledger here is a table in the same HANA database, so this shows the pattern and not independence of infrastructure. Against a real S/4HANA, replace the body of `ledgerBalances()` with a call to the material ledger API through a BTP destination.

Tests: run `npm test` under Node 22 (the Cloud Foundry runtime line). `better-sqlite3` 11 (the local test database inside `@cap-js/sqlite`) aborts intermittently on Node 24 with `Assertion failed: (env) != nullptr` while garbage-collecting; that is a test-driver problem and does not occur on HANA. After switching Node versions, delete `node_modules` and run `npm install`.

## Audit v2.2: legacy baseline and an independent ledger

**Legacy baseline.** Rows written before the hash chain have no `seq`. They are not re-sequenced (that would pretend they were chained when written). `srv/baseline.js` (idempotent, run once as a Cloud Foundry task) fills their empty `outcome`/`httpStatus` (the earliest version only wrote rows for successful calls, so a missing outcome means OK/200; a row whose output carries an error keeps it) and writes ONE chained row, `baselineLegacy`, holding a digest of all of them. `verifyAuditChain()` recomputes that digest; editing a legacy row afterwards reports `legacy rows changed since the baseline`. The attestation proves the rows have not changed since the baseline, not that they were original when first written. Exports carry the baseline in their header.

**Independent ledger.** On Cloud Foundry the reconciliation read is a network call to a separate app, `sap-gov-ledger` (repo `sap-gov-ledger`: own data, own token check via the same XSUAA, `agent` scope), resolved through the BTP destination `GovLedgerService` (OAuth2 client credentials, created by `srv/setup-destination.js` from the service's own binding, so no secret is typed or printed). If the ledger or destination is unavailable the answer still returns, flagged `UNAVAILABLE`. Locally and in tests the reader falls back to `LEDGER_URL` or the local table. To simulate a booking made only in the system of record: `cf set-env sap-gov-ledger LEDGER_ADJUST '{"42":9.1}'` and `cf restart sap-gov-ledger`; unset to restore.

Limit: the ledger shares the identity provider (XSUAA instance) with the stock service. It is a separate app and data store, not a separate trust domain.
