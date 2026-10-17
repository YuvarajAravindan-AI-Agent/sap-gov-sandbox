// One-off, idempotent: brings the audit rows written before the hash chain into the trail's protection.
//   1. fills empty outcome/httpStatus on those rows (the earliest version only wrote rows for successful calls, so a
//      missing outcome means OK/200; a row whose output carries an error keeps that error)
//   2. writes ONE chained row holding a digest of all those rows, so any later change to them is detected by verify()
// The old rows themselves are not given sequence numbers: re-sequencing them would pretend they were chained when written.
const cds = require('@sap/cds')
const { legacyDigest, LEGACY_FIELDS } = require('./chain')
const { appendOwnTx, verify } = require('./audit')

const RULE = 'rows from before v1.1 were written only for successful calls: missing outcome/httpStatus -> OK/200 unless the output carries an error'

async function baselineLegacy() {
  const existing = await cds.run(SELECT.one.from('gov.AuditLog').where({ tool: 'baselineLegacy' }).and('seq is not null'))
  if (existing) return { already: true, seq: existing.seq, ...JSON.parse(existing.output) }

  const before = await cds.run(SELECT.from('gov.AuditLog').where('seq is null').orderBy('timestamp', 'ID'))
  const changed = []
  await cds.tx(async tx => {
    for (const r of before) {
      if (r.outcome != null && r.httpStatus != null) continue
      let err = null
      try { err = JSON.parse(r.output)?.error } catch {}
      const set = err
        ? { outcome: r.outcome ?? 'ERROR', httpStatus: r.httpStatus ?? (Number(err.code) || 500) }
        : { outcome: r.outcome ?? 'OK', httpStatus: r.httpStatus ?? 200 }
      await tx.run(UPDATE('gov.AuditLog').set(set).where({ ID: r.ID }))
      changed.push(r.ID)
    }
  })
  const after = await cds.run(SELECT.from('gov.AuditLog').where('seq is null').orderBy('timestamp', 'ID'))
  const attestation = {
    legacyRows: after.length, legacyDigest: legacyDigest(after), digestFields: LEGACY_FIELDS,
    backfilled: { count: changed.length, ids: changed, rule: RULE }
  }
  await appendOwnTx({
    timestamp: new Date().toISOString(), correlationID: 'baseline-legacy', caller: 'system', tool: 'baselineLegacy',
    input: JSON.stringify({ legacyRows: after.length }), output: JSON.stringify(attestation), outcome: 'OK', httpStatus: 200
  })
  return { already: false, ...attestation, verify: await verify() }
}

module.exports = { baselineLegacy }
