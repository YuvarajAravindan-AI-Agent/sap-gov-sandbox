// One-off, run as a Cloud Foundry task of the stock service: registers the ledger service as the subaccount destination
// GovLedgerService, authenticating with the stock service's own XSUAA client (its binding), so the credentials never leave
// the platform and are never typed or printed.
//   cf run-task sap-gov-sandbox-srv --command "node -e \"require('./srv/setup-destination').run('https://<ledger-host>')\""
async function run(ledgerUrl, name = 'GovLedgerService') {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}')
  const dest = vcap.destination?.[0]?.credentials, xs = vcap.xsuaa?.[0]?.credentials
  if (!dest || !xs) throw new Error('needs destination and xsuaa bindings')
  const tokenResp = await fetch(dest.url + '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${dest.clientid}:${dest.clientsecret}`).toString('base64') },
    body: 'grant_type=client_credentials'
  })
  if (!tokenResp.ok) throw new Error('destination token failed ' + tokenResp.status)
  const headers = { Authorization: 'Bearer ' + (await tokenResp.json()).access_token, 'Content-Type': 'application/json' }
  const body = {
    Name: name, Type: 'HTTP', URL: ledgerUrl, ProxyType: 'Internet', Authentication: 'OAuth2ClientCredentials',
    clientId: xs.clientid, clientSecret: xs.clientsecret, tokenServiceURL: xs.url + '/oauth/token', tokenServiceURLType: 'Dedicated',
    Description: 'Independent system-of-record ledger (sap-gov-ledger), read by the stock service for reconciliation'
  }
  const api = `${dest.uri}/destination-configuration/v1/subaccountDestinations`
  let r = await fetch(api, { method: 'POST', headers, body: JSON.stringify(body) })
  let action = 'created'
  if (r.status === 409) { r = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) }); action = 'updated' }
  const out = { destination: name, url: ledgerUrl, action, status: r.status }
  console.log('DESTSETUP ' + JSON.stringify(out))
  if (!r.ok) throw new Error('destination write failed ' + r.status)
  return out
}

module.exports = { run }
