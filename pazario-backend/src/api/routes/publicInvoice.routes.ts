import { Router } from 'express'
import { servePublicInvoice } from '../controllers/invoice.controller'
const router = Router()
router.get('/public/invoices/:token.pdf', servePublicInvoice)
export default router
