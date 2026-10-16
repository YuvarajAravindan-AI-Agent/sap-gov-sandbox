// Boots the service on in-memory SQLite and checks the arithmetic the agent got wrong.
const cds = require('@sap/cds')
const assert = require('node:assert')

;(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  process.chdir(__dirname + '/..')
  const model = cds.model = await cds.load('*')
  await cds.deploy(model).to('sqlite::memory:')
  const srv = await cds.serve('StockService').from(model, { at: '/stock' })
  const tx = srv.tx({ user: cds.User.privileged })
  const call = async (fn, data) => JSON.parse(await tx.send({ event: fn, data }))

  const v = await call('validateOrderStock', { orderID: 1000001 })
  const seal = v.lines.find(l => l.material === 41)
  const grease = v.lines.find(l => l.material === 42)

  assert.deepStrictEqual([seal.required, seal.available, seal.status, seal.shortBy], [1.7, 500, 'SUFFICIENT', 0])
  assert.deepStrictEqual([grease.required, grease.available, grease.status, grease.shortBy], [10, 8.8, 'SHORT', 1.2])
  assert.strictEqual(v.verdict, 'SHORTAGE')

  const m = await call('getMaterialDetails', { materialID: 41 })
  assert.strictEqual(m.stockLevel, 500)

  const log = await cds.run(SELECT.from('gov.AuditLog'))
  assert.ok(log.length >= 2, 'audit rows written')
  assert.ok(log.every(r => r.outcome === 'OK' && r.httpStatus === 200 && r.correlationID))
  console.log('OK - material 41: 1.7 required vs 500 available = SUFFICIENT; material 42: 10 vs 8.8 = SHORT by 1.2')
  console.log('audit rows:', log.map(r => `${r.tool}:${r.outcome}/${r.httpStatus}`).join(', '))
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
