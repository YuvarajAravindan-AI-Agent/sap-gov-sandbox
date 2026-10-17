#!/usr/bin/env node
// Verifies an audit export (JSON Lines from exportAudit) with no SAP system and no dependencies beyond Node.
//   node tools/verify-export.js audit-export.jsonl
// Exit code 0 = chain intact, 1 = broken or unreadable.
const fs = require('node:fs')
const { verifyRows, GENESIS } = require('../srv/chain')

const file = process.argv[2]
if (!file) { console.error('usage: verify-export.js <export.jsonl>'); process.exit(2) }
try {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const header = lines.find(l => l.type === 'header'), rows = lines.filter(l => l.type === 'row')
  if (!header || header.format !== 'gov-audit-export/1') throw new Error('not a gov-audit-export/1 file')
  if (rows.length !== header.rows) throw new Error(`header says ${header.rows} rows, file has ${rows.length}`)
  const start = rows.length ? { seq: rows[0].seq, prevHash: header.anchoredAtGenesis ? GENESIS : rows[0].prevHash } : {}
  const res = verifyRows(rows, start)
  if (res.ok) console.log(`OK  ${res.rows} rows, seq ${rows[0]?.seq}..${res.headSeq}, ${header.anchoredAtGenesis ? 'anchored at genesis' : 'continuity before the first row not checked'}, head ${String(res.headHash).slice(0, 12)}`)
  else console.log(`BROKEN at seq ${res.firstBadSeq}: ${res.reason}`)
  process.exit(res.ok ? 0 : 1)
} catch (e) { console.log('UNREADABLE: ' + e.message); process.exit(1) }
