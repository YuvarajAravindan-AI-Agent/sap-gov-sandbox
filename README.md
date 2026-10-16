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
    npx cds watch                    # mocked users agent/agent, auditor/auditor

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
