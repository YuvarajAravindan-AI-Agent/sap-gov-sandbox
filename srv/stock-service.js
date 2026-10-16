const cds = require('@sap/cds')

// Decimal-safe arithmetic: work in integer thousandths (columns are Decimal(13,3)).
const toMilli = n => Math.round(Number(n) * 1000)
const fromMilli = m => m / 1000

module.exports = class StockService extends cds.ApplicationService {
  init() {
    const { MaintenanceOrders, OrderOperations, OperationComponents, Materials, MaterialStockLevels, AuditLog } = cds.entities('gov')

    // Correlation: caller-supplied id wins, else the Cloud Foundry request id, else the CAP context id.
    const correlation = req => {
      const h = req.headers || {}
      return h['x-correlation-id'] || h['x-vcap-request-id'] || cds.context?.id || req.id || ''
    }
    const row = (req, tool, input, output, outcome, httpStatus) => ({
      timestamp: new Date().toISOString(),
      correlationID: String(correlation(req)).slice(0, 80),
      caller: req.user?.id || 'anonymous',
      tool,
      input: JSON.stringify(input),
      output: JSON.stringify(output),
      outcome,
      httpStatus
    })

    // Successful answers: the audit row joins the request transaction and commits with the answer it describes.
    const audit = (req, tool, input, output) =>
      INSERT.into(AuditLog).entries(row(req, tool, input, output, 'OK', 200))

    // Requests that fail inside a handler roll their transaction back, which would take an in-transaction audit row
    // with it. Record them after the rollback in their own transaction. Authentication and authorization failures
    // (401/403) never reach here; server.js records those.
    this.prepend(() => this.before('*', req => {
      req.on('failed', async err => {
        const status = Number(err.statusCode || err.status || err.code) || 500
        if (status === 401 || status === 403) return
        const tool = req.target?.name ? `${req.event} ${req.target.name}` : req.event
        try {
          await cds.tx(tx => tx.run(INSERT.into(AuditLog).entries(row(
            req, tool, { path: req.path, data: req.data },
            { error: { code: err.code, message: err.message } },
            'ERROR', status))))
        } catch (e) {
          cds.log('audit').error('could not record failed request', e.message)
        }
      })
    }))

    const respond = async (req, tool, input, output) => {
      await audit(req, tool, input, output)
      return JSON.stringify(output)
    }

    this.on('getMaintenanceOrderDetails', async req => {
      const { orderID } = req.data
      const row = await SELECT.one.from(MaintenanceOrders).where({ ID: orderID })
      if (!row) return req.reject(404, `Maintenance order ${orderID} not found`)
      return respond(req, 'getMaintenanceOrderDetails', { orderID }, row)
    })

    this.on('getOrderOperations', async req => {
      const { orderID } = req.data
      const rows = await SELECT.from(OrderOperations).where({ order_ID: orderID }).orderBy('ID')
      return respond(req, 'getOrderOperations', { orderID }, { value: rows, count: rows.length })
    })

    this.on('getOperationComponents', async req => {
      const { operationID } = req.data
      const rows = await SELECT.from(OperationComponents).where({ operation_ID: operationID })
      const value = rows.map(r => ({ material: r.material_ID, requiredQty: Number(r.requiredQty) }))
      return respond(req, 'getOperationComponents', { operationID }, { value, count: value.length })
    })

    this.on('getMaterialDetails', async req => {
      const { materialID } = req.data
      const mat = await SELECT.one.from(Materials).where({ ID: materialID })
      if (!mat) return req.reject(404, `Material ${materialID} not found`)
      const levels = await SELECT.from(MaterialStockLevels).where({ material_ID: materialID })
      const stockLevel = fromMilli(levels.reduce((s, l) => s + toMilli(l.quantity), 0))
      return respond(req, 'getMaterialDetails', { materialID }, { ...mat, stockLevel })
    })

    this.on('getMaterialStockLevels', async req => {
      const { materialID } = req.data
      const rows = await SELECT.from(MaterialStockLevels).where({ material_ID: materialID })
      const value = rows.map(r => ({ plant: r.plant, storageLocation: r.storageLocation, quantity: Number(r.quantity) }))
      return respond(req, 'getMaterialStockLevels', { materialID }, { value, count: value.length })
    })

    // Verdict for a whole order: for every component, required vs available, in code.
    this.on('validateOrderStock', async req => {
      const { orderID } = req.data
      const order = await SELECT.one.from(MaintenanceOrders).where({ ID: orderID })
      if (!order) return req.reject(404, `Maintenance order ${orderID} not found`)

      const ops = await SELECT.from(OrderOperations).where({ order_ID: orderID }).orderBy('ID')
      const lines = []
      for (const op of ops) {
        const comps = await SELECT.from(OperationComponents).where({ operation_ID: op.ID })
        for (const c of comps) {
          const levels = await SELECT.from(MaterialStockLevels).where({ material_ID: c.material_ID })
          const availableMilli = levels.reduce((s, l) => s + toMilli(l.quantity), 0)
          const requiredMilli = toMilli(c.requiredQty)
          const shortMilli = Math.max(0, requiredMilli - availableMilli)
          lines.push({
            operation: op.ID,
            material: c.material_ID,
            required: fromMilli(requiredMilli),
            available: fromMilli(availableMilli),
            status: shortMilli === 0 ? 'SUFFICIENT' : 'SHORT',
            shortBy: fromMilli(shortMilli),
            basis: levels.map(l => `${l.plant}/${l.storageLocation}=${Number(l.quantity)}`)
          })
        }
      }
      const verdict = lines.every(l => l.status === 'SUFFICIENT') ? 'ALL_COMPONENTS_AVAILABLE' : 'SHORTAGE'
      return respond(req, 'validateOrderStock', { orderID }, { orderID, verdict, lines })
    })

    return super.init()
  }
}
