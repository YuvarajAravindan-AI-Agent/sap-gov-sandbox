const cds = require('@sap/cds')
const { appendOwnTx } = require('./lib/audit')

// CAP rejects unauthenticated (401) and unauthorized (403) requests before any service handler runs,
// so those attempts are recorded here, once the response is finished, in their own transaction.
cds.on('bootstrap', app => {
  app.use('/stock', (req, res, next) => {
    res.on('finish', async () => {
      if (res.statusCode !== 401 && res.statusCode !== 403) return
      try {
        const url = (req.originalUrl || req.url || '').split('?')[0]
        const h = req.headers || {}
        await appendOwnTx({
          timestamp: new Date().toISOString(),
          correlationID: String(h['x-correlation-id'] || h['x-vcap-request-id'] || res.getHeader('x-correlation-id') || '').slice(0, 80),
          endUser: String(h['x-end-user'] || '').slice(0, 120) || null,
          caller: req.user?.id && req.user.id !== 'anonymous' ? req.user.id : 'unauthenticated',
          tool: `${req.method} ${decodeURIComponent(url)}`.slice(0, 60),
          input: JSON.stringify({ path: url }),
          output: JSON.stringify({ error: { code: String(res.statusCode), message: res.statusCode === 401 ? 'Unauthorized' : 'Forbidden' } }),
          outcome: 'DENIED',
          httpStatus: res.statusCode
        })
      } catch (e) {
        cds.log('audit').error('could not record denied request', e.message)
      }
    })
    next()
  })
})

module.exports = cds.server
