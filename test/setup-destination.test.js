// The destination script writes the right shape and never prints the client secret.
const assert = require('node:assert')
process.env.VCAP_SERVICES = JSON.stringify({
  destination: [{ credentials: { url: 'https://auth.example', uri: 'https://dest.example', clientid: 'dc', clientsecret: 'dsecret' } }],
  xsuaa: [{ credentials: { url: 'https://xs.example', clientid: 'xc', clientsecret: 'XSECRET-NOT-TO-LOG' } }]
})
;(async () => {
  const calls = [], logs = []
  global.fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method, body: o.body })
    if (url.endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) }
    return { ok: true, status: calls.filter(c => c.url.includes('subaccountDestinations')).length === 1 && o.method === 'POST' ? 201 : 200 }
  }
  const log = console.log; console.log = (...a) => logs.push(a.join(' '))
  const out = await require('../srv/setup-destination').run('https://ledger.example')
  console.log = log
  assert.deepStrictEqual(out, { destination: 'GovLedgerService', url: 'https://ledger.example', action: 'created', status: 201 })
  const written = JSON.parse(calls.at(-1).body)
  assert.strictEqual(written.Authentication, 'OAuth2ClientCredentials'); assert.strictEqual(written.tokenServiceURL, 'https://xs.example/oauth/token')
  assert.strictEqual(written.clientSecret, 'XSECRET-NOT-TO-LOG')
  assert.ok(!logs.join('\n').includes('XSECRET'), 'secret is never printed')
  console.log('OK - destination payload and no secret in the output')
})().catch(e => { console.error(e); process.exit(1) })
