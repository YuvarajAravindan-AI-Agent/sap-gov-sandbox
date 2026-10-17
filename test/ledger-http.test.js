// The second read goes over the network to a separate service; failures must not break the answer.
const cds = require('@sap/cds')
const assert = require('node:assert')
const http = require('node:http')

;(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  process.chdir(__dirname + '/..')
  cds.model = await cds.load('*')
  await cds.deploy(cds.model).to('sqlite::memory:')
  const { reconcile } = require('../srv/sor')
  const lines = [{ material: 41, available: 500 }, { material: 42, available: 8.8 }]

  let seen = [], mode = 'ok'
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, cid: req.headers['x-correlation-id'], auth: req.headers.authorization })
    if (mode === 'down') { res.statusCode = 503; return res.end('{}') }
    const b = { 41: 500, 42: mode === 'drift' ? 9.1 : 8.8 }
    const ids = new URL(req.url, 'http://x').searchParams.getAll('material').map(Number)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ source: 'sap-gov-ledger', balances: ids.map(m => ({ material: m, balance: b[m] ?? null, asOf: 'x' })) }))
  }).listen(0)
  process.env.LEDGER_URL = `http://localhost:${server.address().port}`

  let r = await reconcile(lines, 'conv-test-1')
  assert.strictEqual(r.status, 'MATCH'); assert.match(r.source, /sap-gov-ledger via LEDGER_URL/)
  assert.strictEqual(seen[0].cid, 'conv-test-1', 'the correlation id travels to the ledger')
  assert.match(seen[0].url, /material=41&material=42/)

  mode = 'drift'; r = await reconcile(lines, 'c')
  assert.strictEqual(r.status, 'MISMATCH'); assert.deepStrictEqual(r.mismatches, [{ material: 42, computed: 8.8, record: 9.1, reason: 'differs' }])

  mode = 'down'; r = await reconcile(lines, 'c')
  assert.strictEqual(r.status, 'UNAVAILABLE'); assert.match(r.reason, /503/)

  server.close(); r = await reconcile(lines, 'c')
  assert.strictEqual(r.status, 'UNAVAILABLE', 'a stopped ledger is UNAVAILABLE, not an exception')
  console.log('OK - ledger over HTTP: MATCH, MISMATCH, 503 and unreachable -> UNAVAILABLE')
  await cds.disconnect()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
