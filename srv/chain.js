// The hash chain, with no CAP dependency, so the same code verifies a live trail and an exported file.
const crypto = require('node:crypto')

const GENESIS = 'GENESIS'
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const iso = v => (v == null ? null : new Date(v).toISOString())

// Hashed fields per schema version, in order. A row is hashed as the JSON array of these values (timestamps as ISO-8601 UTC).
const V2 = ['seq', 'prevHash', 'timestamp', 'correlationID', 'outcome', 'httpStatus', 'caller', 'endUser',
  'tool', 'input', 'output', 'dataVersion', 'ruleVersion', 'asOf', 'schemaVersion']
const FIELDS = { 2: V2, 3: [...V2, 'reconciliation'] }
const TIME = new Set(['timestamp', 'asOf'])

const canonical = r => JSON.stringify(FIELDS[r.schemaVersion].map(f => TIME.has(f) ? iso(r[f]) : (r[f] ?? null)))
const hashRow = r => sha(canonical(r))

// rows must be sorted by seq. Without a start, the first row has to follow GENESIS.
function verifyRows(rows, start = {}) {
  let expectSeq = start.seq ?? 1, prevHash = start.prevHash ?? GENESIS
  for (const r of rows) {
    const bad = reason => ({ ok: false, rows: rows.length, firstBadSeq: r.seq ?? expectSeq, reason })
    if (!FIELDS[r.schemaVersion]) return bad(`unknown schemaVersion ${r.schemaVersion}`)
    if (r.seq !== expectSeq) return { ok: false, rows: rows.length, firstBadSeq: expectSeq, reason: `missing row: expected seq ${expectSeq}, found ${r.seq}` }
    if (r.prevHash !== prevHash) return bad('prevHash does not match the previous row')
    if (hashRow(r) !== r.hash) return bad('row content does not match its hash')
    prevHash = r.hash; expectSeq++
  }
  return { ok: true, rows: rows.length, headSeq: rows.length ? rows[rows.length - 1].seq : 0, headHash: rows.length ? prevHash : null }
}

module.exports = { GENESIS, FIELDS, sha, iso, canonical, hashRow, verifyRows }
