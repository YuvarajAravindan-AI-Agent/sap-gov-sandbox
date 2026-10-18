# Handoff: SAP governed-agent sandbox, audit v2.2 (written 2026-10-17)

## State
- Repos (all LOCAL commits only, nothing pushed): `~/Projects/sap-gov-sandbox` (f474eb0 = v2.2), `~/Projects/sap-gov-agent` (d3a09de), `~/Projects/sap-gov-ledger` (new, 1 commit), video project `~/Projects/sap-agents-video` + Contabo `/opt/ai-digest/sap-agents`.
- BTP trial (org 06407a50trial, space dev, us10-001). Live and verified: stock service v2.1 (audit chain, export, reconciliation vs table), chat agent, destination GovStockService, role GovStockAuditor (assigned).
- Posted on LinkedIn: https://lnkd.in/p/gs4gSxpC (+2 replies posted).
- Business Application Studio dev space `govsandbox_dev` is RUNNING (stop it when done). cf login there is valid for now; if expired run `cf login -a https://api.cf.us10-001.hana.ondemand.com --sso` (user pastes the passcode from https://login.cf.us10-001.hana.ondemand.com/passcode).
- HANA free tier stops nightly: start `govsandbox` in HANA Cloud Central before testing.

## In flight when the session moved
1. `sap-gov-ledger` app is DEPLOYED and running (https://sap-gov-ledger.cfapps.us10-001.hana.ondemand.com , /health open, /ledger/balances needs a token with scope `agent`).
2. A terminal in BAS was running `mbt build && cf deploy mta_archives/sap-gov-sandbox_1.0.0.mtar -f` in ~/projects/sap-gov-sandbox (v2.2 code: srv/baseline.js, destination.js, sor.js, setup-destination.js, mta.yaml binds gov-dest-admin). CHECK it finished: `cf apps` (srv must be started) and `cf logs sap-gov-sandbox-srv --recent | tail`.

## Remaining steps
1. Create the destination (secrets stay inside the platform):
   `cf run-task sap-gov-sandbox-srv --name destsetup --command "node -e \"require('./srv/setup-destination').run('https://sap-gov-ledger.cfapps.us10-001.hana.ondemand.com')\""` then read `cf logs sap-gov-sandbox-srv --recent | grep DESTSETUP`.
2. Run the legacy baseline once: task with `node -e "const cds=require('@sap/cds');(async()=>{cds.model=await cds.load('*');await cds.connect.to('db');console.log('BASELINE '+JSON.stringify(await require('./srv/baseline').baselineLegacy()));process.exit(0)})()"` ; expect backfilled=6 rows (null outcome/status), 21 legacy rows attested, chain ok with legacyBaseline.covered=true.
3. Chat test (user must do it: the gate password): "Is order 1000001 ready to proceed?" -> reconciliation MATCH, source mentions sap-gov-ledger via destination GovLedgerService.
4. Live mismatch demo against the ledger app: `cf set-env sap-gov-ledger LEDGER_ADJUST '{"42":9.1}' && cf restart sap-gov-ledger`, ask the chat (agent says MISMATCH, material 42 8.8 vs 9.1), then restore: `cf unset-env sap-gov-ledger LEDGER_ADJUST && cf restart sap-gov-ledger`.
5. Screenshots for the video: chat mismatch (earlier one exists: user screenshot of conv-7a84a52c), cockpit destination GovLedgerService, CF apps list incl. sap-gov-ledger, BAS terminal outputs (baseline + chain verify), offline `node tools/verify-export.js` output.
6. Video: a follow-up (~3 min) covering (1) live mismatch demo, (2) legacy baseline, (3) independent ledger via destination, plus export/verify. Reuse ~/Projects/sap-agents-video (SAP blue/gold Fiori look, user asked for SAP colours); register style variant in Contabo style registry. Render on Contabo (ffmpeg), LinkedIn copy under 10 MB.
7. LinkedIn: draft text, user approves, type it into the composer (built-in browser pane works; type line by line, last chars of multi-line chunks get dropped); the USER attaches the video and clicks Post.

## Gotchas
- Run local tests under Node 22 (`nvm`), Node 24 + better-sqlite3 aborts.
- cds build ships only srv/ and db/: keep runtime modules under srv/.
- In the BAS terminal click inside the terminal before typing; file transfer is base64 chunks with per-chunk sha checks (see memory note sap-btp-governed-stock-sandbox).
- Never print/type secrets; use run-task scripts that read VCAP.
