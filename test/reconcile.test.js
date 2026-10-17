// Reconciliation against the system of record, and the self-describing export with its offline verifier.
const cds = require('@sap/cds')
const assert = require('node:assert')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')

;(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  process.chdir(__dirname + '/..')
  const model = cds.model = await cds.load('*')
  await cds.deploy(model).to('sqlite::memory:')
  const srv = await cds.serve('StockService').from(model, { at: '/stock' })
  const send = (event, data, headers = {}) => srv.tx({ user: cds.User.privileged, headers }, tx => tx.send({ event, data }))
  const call = async (e, d, h) => JSON.parse(await send(e, d, h))
  const lastRow = async () => (await cds.run(SELECT.from('gov.AuditLog').orderBy('seq desc').limit(1)))[0]

  // 1. Ledger agrees with the computed stock.
  let v = await call('validateOrderStock', { orderID: 1000001 })
  assert.strictEqual(v.reconciliation.status, 'MATCH'); assert.strictEqual(v.reconciliation.checked, 2)
  assert.strictEqual((await lastRow()).reconciliation, 'MATCH')
  console.log('MATCH: ledger agrees, audit row flagged MATCH')

  // 2. Someone books a movement in the system of record only: the answer is flagged, the verdict logic is untouched.
  await cds.run(UPDATE('gov.SystemOfRecordBalances').set({ balance: 9.1 }).where({ material_ID: 42 }))
  v = await call('validateOrderStock', { orderID: 1000001 })
  assert.strictEqual(v.reconciliation.status, 'MISMATCH')
  assert.deepStrictEqual(v.reconciliation.mismatches, [{ material: 42, computed: 8.8, record: 9.1, reason: 'differs' }])
  assert.strictEqual(v.lines.find(l => l.material === 42).shortBy, 1.2, 'the computed verdict is unchanged')
  const flagged = await lastRow(); assert.strictEqual(flagged.reconciliation, 'MISMATCH')
  assert.ok(JSON.parse(flagged.output).reconciliation.mismatches.length === 1, 'detail is in the audit row')
  console.log('MISMATCH: material 42 computed 8.8 vs record 9.1, flagged in the answer and the audit row')

  // 3. Missing ledger entry and unreachable ledger.
  await cds.run(DELETE.from('gov.SystemOfRecordBalances').where({ material_ID: 41 }))
  v = await call('validateOrderStock', { orderID: 1000001 })
  assert.ok(v.reconciliation.mismatches.some(m => m.material === 41 && m.reason === 'no record'))
  const reconcile = require('../srv/sor').reconcile
  const lines = v.lines
  cds.db.run = async () => { throw new Error('ledger down') }
  const out = await reconcile(lines)
  assert.strictEqual(out.status, 'UNAVAILABLE')
  delete cds.db.run
  console.log('no-record and UNAVAILABLE handled without failing the answer')

  // 4. The chain still verifies with the reconciliation field hashed in, and old v2-style rows still verify.
  assert.strictEqual(JSON.parse(await send('verifyAuditChain', {})).ok, true)

  // 5. Export, then verify offline with the standalone tool; then tamper and watch it fail.
  const text = await send('exportAudit', { fromSeq: 1, limit: 100 })
  const lines2 = text.split('\n').filter(Boolean)
  const header = JSON.parse(lines2[0])
  assert.strictEqual(header.format, 'gov-audit-export/1'); assert.strictEqual(header.anchoredAtGenesis, true)
  assert.strictEqual(header.rows, lines2.length - 1)
  assert.ok(header.hashedFields['3'].includes('reconciliation'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), file = path.join(dir, 'export.jsonl')
  fs.writeFileSync(file, text)
  const ok = spawnSync('node', ['tools/verify-export.js', file], { encoding: 'utf8' })
  assert.strictEqual(ok.status, 0, ok.stdout); console.log('offline verifier:', ok.stdout.trim())
  const exportRow = await lastRow(); assert.strictEqual(exportRow.tool, 'exportAudit', 'the export itself is audited')

  const tampered = lines2.map((l, i) => i === 3 ? l.replace('"outcome":"OK"', '"outcome":"ERROR"') : l).join('\n') + '\n'
  fs.writeFileSync(file, tampered)
  const bad = spawnSync('node', ['tools/verify-export.js', file], { encoding: 'utf8' })
  assert.strictEqual(bad.status, 1); assert.match(bad.stdout, /BROKEN at seq 3/); console.log('tampered export:', bad.stdout.trim())

  const partial = await send('exportAudit', { fromSeq: 3, limit: 2 })
  fs.writeFileSync(file, partial)
  const part = spawnSync('node', ['tools/verify-export.js', file], { encoding: 'utf8' })
  assert.strictEqual(part.status, 0, part.stdout); console.log('partial export:', part.stdout.trim())
  console.log('OK - reconciliation and export')
  await cds.disconnect()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
