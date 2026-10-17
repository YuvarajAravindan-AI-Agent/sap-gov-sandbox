// Rows from before the hash chain: backfill their empty fields, attest them with one chained row, detect later edits.
const cds = require('@sap/cds')
const assert = require('node:assert')

;(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  process.chdir(__dirname + '/..')
  const model = cds.model = await cds.load('*')
  await cds.deploy(model).to('sqlite::memory:')
  const srv = await cds.serve('StockService').from(model, { at: '/stock' })
  const send = (event, data) => srv.tx({ user: cds.User.privileged }, tx => tx.send({ event, data }))
  const { baselineLegacy } = require('../srv/baseline')

  // Rows as the first version wrote them: no seq/hash, and no outcome or status on the earliest ones.
  const legacy = [
    { timestamp: '2026-10-16T12:30:10.000Z', correlationID: 'a', caller: 'system', tool: 'validateOrderStock', input: '{"orderID":1000001}', output: '{"verdict":"SHORTAGE"}' },
    { timestamp: '2026-10-16T12:30:11.000Z', correlationID: 'b', caller: 'system', tool: 'getMaterialDetails', input: '{"materialID":41}', output: '{"ID":41}' },
    { timestamp: '2026-10-16T12:30:12.000Z', correlationID: 'c', caller: 'system', tool: 'getMaterialDetails', input: '{"materialID":9}', output: '{"error":{"code":"404","message":"x"}}' },
    { timestamp: '2026-10-16T12:30:13.000Z', correlationID: 'd', caller: 'unauthenticated', tool: 'GET /stock/', input: '{}', output: '{}', outcome: 'DENIED', httpStatus: 401 }
  ]
  await cds.run(INSERT.into('gov.AuditLog').entries(legacy))
  await send('getMaterialDetails', { materialID: 41 })   // a chained row after the legacy ones

  let v = JSON.parse(await send('verifyAuditChain', {}))
  assert.strictEqual(v.ok, true); assert.strictEqual(v.legacyUnchained, 4); assert.strictEqual(v.legacyBaseline, undefined)

  const r = await baselineLegacy()
  assert.strictEqual(r.already, false); assert.strictEqual(r.legacyRows, 4); assert.strictEqual(r.backfilled.count, 3)
  const rows = await cds.run(SELECT.from('gov.AuditLog').where('seq is null').orderBy('timestamp'))
  assert.deepStrictEqual(rows.map(x => [x.outcome, x.httpStatus]), [['OK', 200], ['OK', 200], ['ERROR', 404], ['DENIED', 401]])
  console.log('backfilled', r.backfilled.count, 'rows; attested', r.legacyRows, 'rows with digest', r.legacyDigest.slice(0, 12))

  v = JSON.parse(await send('verifyAuditChain', {}))
  assert.strictEqual(v.ok, true); assert.strictEqual(v.legacyBaseline.covered, true); assert.strictEqual(v.legacyBaseline.rows, 4)

  const again = await baselineLegacy()
  assert.strictEqual(again.already, true, 'running it twice changes nothing')
  assert.strictEqual((await cds.run(SELECT.from('gov.AuditLog').where({ tool: 'baselineLegacy' }))).length, 1)

  // Editing a legacy row afterwards is now detectable.
  await cds.run(UPDATE('gov.AuditLog').set({ output: '{"verdict":"ALL_COMPONENTS_AVAILABLE"}' }).where({ correlationID: 'a' }))
  v = JSON.parse(await send('verifyAuditChain', {}))
  assert.strictEqual(v.ok, false); assert.match(v.reason, /legacy rows changed/)
  console.log('edit to a legacy row detected:', v.reason)

  const exp = await send('exportAudit', { fromSeq: 1, limit: 50 })
  const header = JSON.parse(exp.split('\n')[0])
  assert.strictEqual(header.legacyBaseline.legacyRows, 4)
  console.log('OK - baseline')
  await cds.disconnect()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
