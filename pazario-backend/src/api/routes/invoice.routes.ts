import express, { Router } from 'express'
import { downloadApprovedInvoice, downloadDraftPdf, getInvoiceProfile, listInvoices, saveInvoiceDraft, sendApprovedInvoice, updateInvoiceProfile, uploadApprovedInvoice } from '../controllers/invoice.controller'

const router = Router()
router.get('/invoices/profile', getInvoiceProfile)
router.put('/invoices/profile', updateInvoiceProfile)
router.get('/invoices', listInvoices)
router.post('/orders/:orderId/invoice/draft', saveInvoiceDraft)
router.get('/orders/:orderId/invoice/draft.pdf', downloadDraftPdf)
router.put('/orders/:orderId/invoice/approved-file', express.raw({ type: 'application/pdf', limit: '10mb' }), uploadApprovedInvoice)
router.get('/invoices/:invoiceId/approved.pdf', downloadApprovedInvoice)
router.post('/invoices/:invoiceId/send-marketplace', sendApprovedInvoice)
export default router
