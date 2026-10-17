// Real server, real auth path (mocked users): successful, not-found, denied and unauthenticated calls.
const { spawn } = require('node:child_process')
const assert = require('node:assert')
const PORT = 4710
const base = `http://localhost:${PORT}/stock/`
const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') })

;(async () => {
  const srv = spawn('npx', ['cds-serve', '--port', String(PORT)], { cwd: __dirname + '/..', stdio: 'ignore', detached: true, env: { ...process.env, NODE_ENV: 'development' } })
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base); break } catch { await new Promise(r => setTimeout(r, 500)) } }
    const get = (p, h) => fetch(base + p, { headers: h })
    const agent = basic('agent', 'agent'), auditor = basic('auditor', 'auditor')

    assert.strictEqual((await get('getMaterialDetails(materialID=41)', { ...agent, 'x-correlation-id': 'conv-123' })).status, 200)
    assert.strictEqual((await get('getMaterialDetails(materialID=999)', agent)).status, 404)       // not found -> ERROR row
    assert.strictEqual((await get('getMaterialDetails(materialID=41)', auditor)).status, 403)      // wrong scope -> DENIED row
    assert.strictEqual((await get('getMaterialDetails(materialID=41)')).status, 401)                // no credentials -> 401
    assert.strictEqual((await get('AuditLog', agent)).status, 403)                                   // agents cannot read the trail
    await new Promise(r => setTimeout(r, 500))

    const res = await get('AuditLog?$orderby=timestamp', auditor)
    if (res.status !== 200) console.log('AuditLog read failed', res.status, await res.text()); assert.strictEqual(res.status, 200)
    const rows = (await res.json()).value
    const brief = rows.map(r => `${r.tool}|${r.caller}|${r.outcome}/${r.httpStatus}|${r.correlationID.slice(0, 8)}`)
    console.log(brief.join('\n'))
    const find = (o, c) => rows.find(r => r.outcome === o && r.httpStatus === c)
    assert.ok(rows.find(r => r.outcome === 'OK' && r.correlationID === 'conv-123'), 'caller correlation id kept')
    assert.ok(find('ERROR', 404), '404 audited')
    assert.ok(rows.find(r => r.outcome === 'DENIED' && r.httpStatus === 403 && r.caller === 'auditor'), '403 audited with caller')
    assert.ok(rows.find(r => r.outcome === 'DENIED' && r.caller === 'agent' && /AuditLog/.test(r.tool)), 'agent reading AuditLog audited')
    assert.ok(rows.find(r => r.outcome === 'DENIED' && r.httpStatus === 401 && r.caller === 'unauthenticated'), '401 audited')
    assert.ok(rows.every(r => r.correlationID), 'every row has a correlation id')
    const chain = JSON.parse((await (await get('verifyAuditChain()', auditor)).json()).value)
    assert.ok(chain.ok && chain.rows >= 5, 'chain intact across success, 404, 403 and 401 rows: ' + JSON.stringify(chain))
    assert.strictEqual((await get('verifyAuditChain()', agent)).status, 403, 'agents cannot run the chain check')
    console.log('OK - success, not-found and denied calls all audited, plus denied (403) and unauthenticated (401)')
  } finally { try { process.kill(-srv.pid) } catch {} }
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
