const cds = require('@sap/cds')
const { lookup, hasDestinationService } = require('./destination')

const DESTINATION = process.env.LEDGER_DESTINATION || 'GovLedgerService'

// Where the system of record lives, in order of preference:
//   LEDGER_URL (tests and local runs), the BTP destination GovLedgerService (Cloud Foundry), else the local ledger table
//   (development only). On Cloud Foundry the destination is always used, so the second read is a real network call to a
//   separate service with its own data and its own token check.
async function ledgerClient() {
  if (process.env.LEDGER_URL) return { base: process.env.LEDGER_URL, headers: {}, label: 'LEDGER_URL' }
  if (hasDestinationService()) return { ...(await lookup(DESTINATION)), label: `destination ${DESTINATION}` }
  return null
}

// Balances per material from the system of record, in integer thousandths (undefined = no record).
async function ledgerBalances(materialIDs, correlationID) {
  const ids = [...new Set(materialIDs)]
  if (!ids.length) return { balances: new Map(), source: 'none' }
  const client = await ledgerClient()
  if (!client) {
    const rows = await SELECT.from('gov.SystemOfRecordBalances').where({ material_ID: { in: ids } })
    return { balances: new Map(rows.map(r => [r.material_ID, Math.round(Number(r.balance) * 1000)])), source: 'gov.SystemOfRecordBalances (local table, development only)' }
  }
  const url = `${client.base.replace(/\/$/, '')}/ledger/balances?${ids.map(i => 'material=' + i).join('&')}`
  const r = await fetch(url, { headers: { ...client.headers, 'x-correlation-id': String(correlationID || '') }, signal: AbortSignal.timeout(6000) })
  if (!r.ok) throw new Error(`ledger responded ${r.status}`)
  const body = await r.json()
  return {
    balances: new Map(body.balances.filter(b => b.balance !== null).map(b => [b.material, Math.round(Number(b.balance) * 1000)])),
    source: `${body.source || 'ledger'} via ${client.label}`
  }
}

// Compares what the service computed with what the system of record says. Never throws: an unreachable ledger is
// reported as UNAVAILABLE and must not block the answer.
async function reconcile(lines, correlationID) {
  try {
    const { balances, source } = await ledgerBalances(lines.map(l => l.material), correlationID)
    const mismatches = []
    for (const l of lines) {
      const computed = Math.round(l.available * 1000), rec = balances.get(l.material)
      if (rec === undefined) mismatches.push({ material: l.material, computed: l.available, record: null, reason: 'no record' })
      else if (rec !== computed) mismatches.push({ material: l.material, computed: l.available, record: rec / 1000, reason: 'differs' })
    }
    return { status: mismatches.length ? 'MISMATCH' : 'MATCH', source, checked: lines.length, mismatches }
  } catch (e) {
    cds.log('reconcile').error('system of record unavailable', e.message)
    return { status: 'UNAVAILABLE', source: 'system of record', checked: 0, mismatches: [], reason: e.message }
  }
}

module.exports = { reconcile }
