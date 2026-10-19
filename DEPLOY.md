# DEPLOY.md: rebuild the governed-agent sandbox from scratch

Three apps make up the system. Repos (all private, account YuvarajAravindan-AI-Agent):

| Repo | App on Cloud Foundry | Role |
|---|---|---|
| `sap-gov-sandbox` | `sap-gov-sandbox-srv` + `sap-gov-sandbox-db-deployer` | CAP stock service, HANA HDI container, XSUAA, audit chain |
| `sap-gov-ledger` | `sap-gov-ledger` | independent system-of-record stand-in for reconciliation |
| `sap-gov-agent` | `sap-gov-agent` | chat front end + LLM tool-calling agent |

Target: a BTP subaccount (the trial was org `06407a50trial`, space `dev`, region us10-001). The trial subaccount is deleted about 90 days after 2026-10-16, so rebuild means a new subaccount. No secret is ever typed into a command line or committed; the steps below keep them inside the platform.

## 0. Before the trial ends: save what only exists there
1. Start HANA `govsandbox` in HANA Cloud Central (free tier stops nightly).
2. Export the audit trail: call `GET /stock/exportAudit(fromSeq=1,limit=500)` with an `auditor` token (role collection `GovStockAuditor`), page by `fromSeq` until done. Save as `audit-export.jsonl`.
3. Verify it offline: `node tools/verify-export.js audit-export.jsonl` (exit 0 = chain intact).
4. Keep the file somewhere durable (private repo or Drive). It is evidence, not source, so it is not in git by default.

## 1. Subaccount prerequisites
- Entitlements: SAP HANA Cloud (free), HANA Schemas & HDI Containers `hdi-shared`, Authorization & Trust Management `application`, Destination `lite`, Cloud Foundry runtime.
- Enable Cloud Foundry, create space `dev`.
- Create a HANA Cloud instance `govsandbox` (free tier) and map it to the space.
- Create a Destination service instance named `gov-dest-admin` (plan `lite`) with a service key; `mta.yaml` binds to it as an existing service.
- Tools: Business Application Studio dev space (or any machine with `cf`, `mbt`, Node 22). There is no `cf` on the laptop, so BAS was used.

## 2. Stock service
    cf login -a https://api.cf.us10-001.hana.ondemand.com --sso     # user pastes the passcode
    cd sap-gov-sandbox
    npm ci && npx mbt build
    cf deploy mta_archives/sap-gov-sandbox_1.0.0.mtar -f

Then assign role collection `GovStockAuditor` (from `xs-security.json`) to the user in the cockpit.

Gotchas:
- `cds build` ships only `srv/` and `db/`. Runtime modules in any other folder cause a "Cannot find module" crash loop.
- Run local tests under Node 22 (`npm test`); Node 24 plus better-sqlite3 aborts.

## 3. Ledger app
    cd sap-gov-ledger && cf push        # manifest binds the same XSUAA instance sap-gov-sandbox-auth

`/health` is open; `/ledger/balances` needs a token with scope `agent`. Mismatch demo: `cf set-env sap-gov-ledger LEDGER_ADJUST '{"42":9.1}' && cf restart sap-gov-ledger`; restore with `cf unset-env ... LEDGER_ADJUST && cf restart ...`.

## 4. Destinations (created by code so secrets stay inside the platform)
    cf run-task sap-gov-sandbox-srv --name destsetup --command "node -e \"require('./srv/setup-destination').run('https://sap-gov-ledger.cfapps.us10-001.hana.ondemand.com')\""
    cf logs sap-gov-sandbox-srv --recent | grep DESTSETUP

This creates `GovLedgerService`. `GovStockService` (used by the agent) was originally created by hand in the cockpit from a service key (OAuth2 client credentials, token URL from the key). `run(url, name)` accepts a different name, so calling it with the stock service URL and `GovStockService` should work too, but that was not tested.

## 5. Legacy baseline (only when restoring old pre-chain rows)
Run `srv/baseline.js` once as a task (see `HANDOFF-v2.2.md` step 2). A fresh deployment has no legacy rows, so skip it.

## 6. Agent
    cd sap-gov-agent
    cf push                    # manifest binds gov-dest-admin
    cf set-env sap-gov-agent LLM_API_KEY <key from your password manager>
    cf set-env sap-gov-agent ACCESS_USER <chat gate user>
    cf set-env sap-gov-agent ACCESS_PASSWORD <chat gate password>
    cf restart sap-gov-agent

Do this from the BAS terminal interactively; never paste the key into a file or chat. Default LLM is DeepSeek (`LLM_BASE_URL`, `LLM_MODEL` in the manifest); any OpenAI-compatible endpoint works.

## 7. Verify
1. Chat: "Is order 1000001 ready to proceed?" Expect material 41 SUFFICIENT, material 42 SHORT by 1.2, reconciliation MATCH.
2. `GET /stock/verifyAuditChain()` returns `ok: true`.
3. Set `LEDGER_ADJUST` as in section 3 and ask again; the answer must say MISMATCH.

## Operating notes
- HANA free tier stops nightly and is deleted after 30 days stopped; start it before use.
- The database accepts connections from Cloud Foundry only, so read it through `cf run-task`.
- Free ERP access without a customer system: only the read-only S/4HANA sandbox on api.sap.com (personal API key). Replace the body of `ledgerBalances()` in `srv/sor.js` with a call through a destination to use it.
- Cost on pay-as-you-go: roughly 1.4 GB of CF memory at EUR 110.50 per GB-month is about EUR 150/month always-on (estimate from the Discovery Center, 2026-10-18).
