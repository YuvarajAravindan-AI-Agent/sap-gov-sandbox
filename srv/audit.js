// Tamper-evident audit trail: every row carries seq, prevHash and hash (SHA-256 over the row's fields plus the previous
// row's hash). Editing, inserting or deleting a row afterwards breaks the chain, and verify() says where.
const crypto = require('node:crypto')
const cds = require('@sap/cds')
const pkg = require('../package.json')
const { GENESIS, FIELDS, sha, iso, hashRow, verifyRows, legacyDigest } = require('./chain')

const SCHEMA_VERSION = 3
const RULE_VERSION = `${pkg.name}@${pkg.version}`
const LOCK_TIMEOUT_MS = 15000

const dataVersion = data => sha(JSON.stringify(data ?? null))

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
  const row = { ...entry, reconciliation: entry.reconciliation ?? null, schemaVersion: SCHEMA_VERSION, ruleVersion: entry.ruleVersion ?? RULE_VERSION, timestamp: iso(entry.timestamp), asOf: iso(entry.asOf || entry.timestamp) }
  row.seq = seq
  row.prevHash = prevHash
  row.hash = hashRow(row)
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

const legacyRows = () => cds.run(SELECT.from('gov.AuditLog').where('seq is null').orderBy('timestamp', 'ID'))

// Recompute the whole chain. Rows written before the chain existed (seq null) are covered by a baseline row, if one
// has been written (srv/baseline.js): its digest of those rows is recomputed here.
async function verify() {
  const rows = await cds.run(SELECT.from('gov.AuditLog').where('seq is not null').orderBy('seq'))
  const legacy = await legacyRows()
  const res = { ...verifyRows(rows), legacyUnchained: legacy.length }
  const base = rows.find(r => r.tool === 'baselineLegacy')
  if (res.ok && base) {
    const attested = JSON.parse(base.output)
    const covered = legacy.length === attested.legacyRows && legacyDigest(legacy) === attested.legacyDigest
    res.legacyBaseline = { seq: base.seq, rows: attested.legacyRows, covered }
    if (!covered) return { ...res, ok: false, firstBadSeq: base.seq, reason: 'legacy rows changed since the baseline' }
  }
  return res
}

// A self-describing export (JSON Lines): one header line that says how to verify, then one line per row.
// Verify it anywhere with tools/verify-export.js, with no SAP system.
async function exportRows(fromSeq = 1, limit = 500) {
  const from = Math.max(1, Number(fromSeq) || 1), max = Math.min(2000, Math.max(1, Number(limit) || 500))
  const rows = await cds.run(SELECT.from('gov.AuditLog').where('seq >=', from).orderBy('seq').limit(max))
  const head = await cds.run(SELECT.one.from('gov.AuditLog').columns('seq', 'hash').where('seq is not null').orderBy('seq desc'))
  const base = await cds.run(SELECT.one.from('gov.AuditLog').where({ tool: 'baselineLegacy' }).and('seq is not null').orderBy('seq'))
  const header = {
    type: 'header', format: 'gov-audit-export/1', exportedAt: new Date().toISOString(), service: RULE_VERSION,
    fromSeq: from, rows: rows.length, headSeq: head?.seq ?? 0, headHash: head?.hash ?? null,
    anchoredAtGenesis: from === 1,
    legacyBaseline: base ? { seq: base.seq, ...JSON.parse(base.output) } : null, algorithm: 'sha256', genesis: GENESIS, hashedFields: FIELDS,
    howToVerify: 'For each row: hash = sha256 of JSON.stringify([...hashedFields[row.schemaVersion] values]), timestamps as ISO-8601 UTC, missing as null; row.prevHash must equal the previous row hash (GENESIS for seq 1); seq must be gapless.'
  }
  const lines = [header, ...rows.map(r => ({ type: 'row', ...r, timestamp: iso(r.timestamp), asOf: iso(r.asOf) }))]
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

module.exports = { appendInRequest, appendOwnTx, verify, exportRows, dataVersion, SCHEMA_VERSION, RULE_VERSION }
