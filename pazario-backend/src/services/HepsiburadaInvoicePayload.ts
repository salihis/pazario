export type HepsiburadaInvoicePayloadInput = {
  marketplaceOrderId: string
  marketplaceOrderNo?: string | null
  issuedAt: Date
  publicUrl: string
}

export function buildHepsiburadaInvoicePayload(input: HepsiburadaInvoicePayloadInput) {
  const arrangementDate = input.issuedAt.toISOString()
  const orderNumber = input.marketplaceOrderNo || input.marketplaceOrderId

  return {
    arrangementDate,
    invoiceLink: input.publicUrl,
    invoices: [{
      arrangementDate,
      contentType: 'pdf',
      invoiceLink: input.publicUrl,
      orderNumber,
    }],
  }
}
