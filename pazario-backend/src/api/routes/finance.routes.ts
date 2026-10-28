import { Router } from 'express'
import {
  getFinanceOverview,
  getTrendyolCargoInvoiceItems,
  importTrendyolCargoInvoiceItems,
  updateFinanceItemFees,
  syncFinanceOrder,
} from '../controllers/finance.controller'

const router = Router()

router.get('/finance/overview', getFinanceOverview)
router.post('/finance/hepsiburada/orders/:orderId/sync', syncFinanceOrder)
router.put('/finance/items/:itemId/fees', updateFinanceItemFees)
router.get('/finance/trendyol/cargo-invoice/:invoiceSerialNumber/items', getTrendyolCargoInvoiceItems)
router.post('/finance/trendyol/cargo-invoice/:invoiceSerialNumber/import', importTrendyolCargoInvoiceItems)

export default router
