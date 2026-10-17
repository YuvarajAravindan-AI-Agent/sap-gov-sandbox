// Resolves a BTP destination, with a ready-to-use Authorization header, through the Destination service bound to this app.
const cache = new Map()

function destinationCredentials() {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}')
  return vcap.destination?.[0]?.credentials
}

async function lookup(name) {
  const hit = cache.get(name)
  if (hit && hit.exp > Date.now()) return hit.v
  const c = destinationCredentials()
  if (!c) throw new Error('no destination service binding')
  const t = await fetch(c.url + '/oauth/token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${c.clientid}:${c.clientsecret}`).toString('base64') },
    body: 'grant_type=client_credentials'
  })
  if (!t.ok) throw new Error(`destination service token failed (${t.status})`)
  const token = (await t.json()).access_token
  const r = await fetch(`${c.uri}/destination-configuration/v1/destinations/${encodeURIComponent(name)}`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`destination ${name} lookup failed (${r.status})`)
  const d = await r.json()
  const auth = (d.authTokens || [])[0]
  if (!auth || auth.error) throw new Error(`destination ${name}: no usable token (${auth && auth.error})`)
  const v = { base: d.destinationConfiguration.URL, headers: { Authorization: auth.http_header.value } }
  cache.set(name, { v, exp: Date.now() + 4 * 60 * 1000 })
  return v
}

module.exports = { lookup, hasDestinationService: () => Boolean(destinationCredentials()) }
