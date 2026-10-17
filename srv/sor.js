const cds = require('@sap/cds')

// Balances per material from the system of record, in integer thousandths. Today this reads a ledger table; against a
// real S/4HANA it would call the material ledger API through a BTP destination. Nothing else in the service changes.
async function ledgerBalances(materialIDs) {
  const ids = [...new Set(materialIDs)]
  if (!ids.length) return new Map()
  const rows = await SELECT.from('gov.SystemOfRecordBalances').where({ material_ID: { in: ids } })
  return new Map(rows.map(r => [r.material_ID, Math.round(Number(r.balance) * 1000)]))
}

// Compares what the service computed with what the system of record says. Never throws: an unreachable ledger is
// reported as UNAVAILABLE and must not block the answer.
async function reconcile(lines) {
  try {
    const record = await ledgerBalances(lines.map(l => l.material))
    const mismatches = []
    for (const l of lines) {
      const computed = Math.round(l.available * 1000), rec = record.get(l.material)
      if (rec === undefined) mismatches.push({ material: l.material, computed: l.available, record: null, reason: 'no record' })
      else if (rec !== computed) mismatches.push({ material: l.material, computed: l.available, record: rec / 1000, reason: 'differs' })
    }
    return { status: mismatches.length ? 'MISMATCH' : 'MATCH', source: 'gov.SystemOfRecordBalances', checked: lines.length, mismatches }
  } catch (e) {
    cds.log('reconcile').error('system of record unavailable', e.message)
    return { status: 'UNAVAILABLE', source: 'gov.SystemOfRecordBalances', checked: 0, mismatches: [] }
  }
}

module.exports = { reconcile }
