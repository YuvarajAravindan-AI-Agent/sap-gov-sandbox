// Tamper-evident audit trail: every row carries seq, prevHash and hash (SHA-256 over the row's fields plus the previous
// row's hash). Editing, inserting or deleting a row afterwards breaks the chain, and verify() says where.
const crypto = require('node:crypto')
const cds = require('@sap/cds')
const pkg = require('../package.json')

const SCHEMA_VERSION = 2
const RULE_VERSION = `${pkg.name}@${pkg.version}`
const GENESIS = 'GENESIS'
const LOCK_TIMEOUT_MS = 15000

const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const iso = v => (v == null ? null : new Date(v).toISOString())
const dataVersion = data => sha(JSON.stringify(data ?? null))

// Canonical form: a fixed-order array, so field order or whitespace can never change a hash.
const canonical = (r, seq, prevHash) => JSON.stringify([
  seq, prevHash, iso(r.timestamp), r.correlationID, r.outcome, r.httpStatus, r.caller, r.endUser ?? null,
  r.tool, r.input, r.output, r.dataVersion ?? null, r.ruleVersion ?? null, iso(r.asOf), r.schemaVersion
])

// One writer at a time, held until the writer's transaction has finished, so each row sees the committed previous row.
let tail = Promise.resolve()
function acquire() {
  let release
  const next = new Promise(r => { release = r })
  const prev = tail
  tail = prev.then(() => next)
  return prev.then(() => {
    const timer = setTimeout(release, LOCK_TIMEOUT_MS)
    return () => { clearTimeout(timer); release() }
  })
}

async function link(tx, entry) {
  const last = await tx.run(SELECT.one.from('gov.AuditLog').columns('seq', 'hash').where('seq is not null').orderBy('seq desc'))
  const seq = (last?.seq || 0) + 1
  const prevHash = last?.hash || GENESIS
  const row = { ...entry, schemaVersion: SCHEMA_VERSION, ruleVersion: entry.ruleVersion ?? RULE_VERSION, timestamp: iso(entry.timestamp), asOf: iso(entry.asOf || entry.timestamp) }
  row.seq = seq
  row.prevHash = prevHash
  row.hash = sha(canonical(row, seq, prevHash))
  return tx.run(INSERT.into('gov.AuditLog').entries(row))
}

// Inside a request: the row commits together with the answer it describes; the lock is held until the request is done.
async function appendInRequest(req, entry) {
  const release = await acquire()
  let once = false
  req._auditRelease = () => { if (!once) { once = true; release() } }
  req.on('done', req._auditRelease)
  try { return await link(cds.db, entry) } catch (e) { req._auditRelease(); throw e }
}

// Outside a request (failed or denied calls): its own transaction.
async function appendOwnTx(entry) {
  const release = await acquire()
  try { return await cds.tx(tx => link(tx, entry)) } finally { release() }
}

// Recompute the whole chain. Rows written before the chain existed (seq null) are reported but not checked.
async function verify() {
  const rows = await cds.run(SELECT.from('gov.AuditLog').where('seq is not null').orderBy('seq'))
  const legacy = (await cds.run(SELECT.one.from('gov.AuditLog').columns('count(*) as n').where('seq is null'))).n
  let expectSeq = 1, prevHash = GENESIS
  for (const r of rows) {
    if (r.seq !== expectSeq) return { ok: false, rows: rows.length, legacyUnchained: legacy, firstBadSeq: expectSeq, reason: `missing row: expected seq ${expectSeq}, found ${r.seq}` }
    if (r.prevHash !== prevHash) return { ok: false, rows: rows.length, legacyUnchained: legacy, firstBadSeq: r.seq, reason: 'prevHash does not match the previous row' }
    if (sha(canonical(r, r.seq, r.prevHash)) !== r.hash) return { ok: false, rows: rows.length, legacyUnchained: legacy, firstBadSeq: r.seq, reason: 'row content does not match its hash' }
    prevHash = r.hash; expectSeq++
  }
  return { ok: true, rows: rows.length, legacyUnchained: legacy, headSeq: rows.length ? rows[rows.length - 1].seq : 0, headHash: prevHash === GENESIS ? null : prevHash }
}

module.exports = { appendInRequest, appendOwnTx, verify, dataVersion, SCHEMA_VERSION, RULE_VERSION }
