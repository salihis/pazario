import { describe, expect, it } from 'vitest'
import { buildHepsiburadaInvoicePayload } from './HepsiburadaInvoicePayload'

describe('buildHepsiburadaInvoicePayload', () => {
  it('uses the package order number and only supported invoice fields', () => {
    const payload = buildHepsiburadaInvoicePayload({
      marketplaceOrderId: '5507024410',
      marketplaceOrderNo: '4750043174',
      issuedAt: new Date('2026-08-17T20:00:52.000Z'),
      publicUrl: 'https://pazario.tr/api/public/invoices/token.pdf',
    })

    expect(payload).toEqual({
      arrangementDate: '2026-08-17T20:00:52.000Z',
      invoiceLink: 'https://pazario.tr/api/public/invoices/token.pdf',
      invoices: [{
        arrangementDate: '2026-08-17T20:00:52.000Z',
        contentType: 'pdf',
        invoiceLink: 'https://pazario.tr/api/public/invoices/token.pdf',
        orderNumber: '4750043174',
      }],
    })
    expect(payload.invoices[0]).not.toHaveProperty('invoiceNumber')
  })
})
