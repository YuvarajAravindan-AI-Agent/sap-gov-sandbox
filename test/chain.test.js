// Audit v2: rows carry data version / as-of / rule version / end user, and the hash chain detects edits and deletions.
const cds = require('@sap/cds')
const assert = require('node:assert')

;(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  process.chdir(__dirname + '/..')
  const model = cds.model = await cds.load('*')
  await cds.deploy(model).to('sqlite::memory:')
  const srv = await cds.serve('StockService').from(model, { at: '/stock' })
  // Managed transactions, like real requests: they commit when the handler finishes.
  const send = (event, data, headers = {}) => srv.tx({ user: cds.User.privileged, headers }, tx => tx.send({ event, data }))
  const verify = async () => JSON.parse(await send('verifyAuditChain', {}))

  await send('validateOrderStock', { orderID: 1000001 }, { 'x-correlation-id': 'conv-a', 'x-end-user': 'analyst1' })
  await send('getMaterialDetails', { materialID: 41 }, { 'x-correlation-id': 'conv-a' })
  await send('getMaterialDetails', { materialID: 999 }, { 'x-correlation-id': 'conv-b' }).catch(() => {})   // 404 -> ERROR row
  await Promise.all(Array.from({ length: 12 }, (_, i) => send('getMaterialStockLevels', { materialID: 41 + (i % 2) }, { 'x-correlation-id': 'conv-p' + i })))

  let v = await verify()
  assert.strictEqual(v.ok, true, JSON.stringify(v))
  assert.strictEqual(v.rows, 15)
  console.log('chain ok:', v.rows, 'rows, head', v.headHash.slice(0, 12))

  const rows = await cds.run(SELECT.from('gov.AuditLog').orderBy('seq'))
  assert.deepStrictEqual(rows.map(r => r.seq), rows.map((_, i) => i + 1), 'seq is gapless')
  const first = rows[0]
  assert.match(first.dataVersion, /^[0-9a-f]{64}$/); assert.ok(first.asOf); assert.strictEqual(first.endUser, 'analyst1')
  assert.strictEqual(first.ruleVersion, 'sap-gov-sandbox@2.0.0'); assert.strictEqual(first.schemaVersion, 2)
  assert.strictEqual(rows[1].dataVersion === first.dataVersion, false)
  const same = rows.filter(r => r.tool === 'getMaterialStockLevels' && /41/.test(r.input))
  assert.ok(same.length > 1 && same.every(r => r.dataVersion === same[0].dataVersion), 'same data read -> same data version')
  assert.ok(rows.find(r => r.outcome === 'ERROR' && r.httpStatus === 404), 'failed call is chained too')
  console.log('fields ok: dataVersion, asOf, endUser, ruleVersion, schemaVersion, gapless seq, same data -> same dataVersion')

  // Tamper 1: edit an answer after the fact.
  const victim = rows[3]
  await cds.run(UPDATE('gov.AuditLog').set({ output: '{"tampered":true}' }).where({ ID: victim.ID }))
  v = await verify(); assert.strictEqual(v.ok, false); assert.strictEqual(v.firstBadSeq, victim.seq)
  console.log('edit detected at seq', v.firstBadSeq, '-', v.reason)
  await cds.run(UPDATE('gov.AuditLog').set({ output: victim.output }).where({ ID: victim.ID }))
  assert.strictEqual((await verify()).ok, true, 'restoring the original repairs the chain')

  // Tamper 2: delete a row.
  const gone = rows[6]
  await cds.run(DELETE.from('gov.AuditLog').where({ ID: gone.ID }))
  v = await verify(); assert.strictEqual(v.ok, false); assert.strictEqual(v.firstBadSeq, gone.seq)
  console.log('deletion detected at seq', v.firstBadSeq, '-', v.reason)
  console.log('OK - audit v2')
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
