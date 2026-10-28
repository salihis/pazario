import { describe, expect, it, vi } from 'vitest'
vi.mock('../../services/HepsiburadaFinanceService', () => ({ financeCredential: vi.fn(), syncHepsiburadaFinance: vi.fn() }))

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    product = { findMany: vi.fn() }
  },
}))

import { sumRows, type FinanceRow } from './finance.controller'

const row = (overrides: Partial<FinanceRow> = {}): FinanceRow => ({
  productId: 'product-1',
  manualPurchasePrice: null,
  quantity: 2,
  totalPrice: 500,
  shippingFee: 20,
  serviceFee: 30,
  extraFees: 10,
  order: { status: 'DELIVERED' },
  ...overrides,
})

describe('finance purchase cost calculation', () => {
  it('uses a manual unit purchase price before the XML product price', () => {
    const result = sumRows([row({ manualPurchasePrice: 100 })], new Map([['product-1', 80]]))

    expect(result.purchase).toBe(200)
    expect(result.profit).toBe(240)
    expect(result.missingPurchase).toBe(0)
  })

  it('accepts a manual purchase price for an unmatched order item', () => {
    const result = sumRows([row({ productId: null, manualPurchasePrice: 125 })])

    expect(result.purchase).toBe(250)
    expect(result.missingPurchase).toBe(0)
  })

  it('falls back to the XML product price when the manual value is cleared', () => {
    const result = sumRows([row()], new Map([['product-1', 80]]))

    expect(result.purchase).toBe(160)
    expect(result.missingPurchase).toBe(0)
  })

  it('does not charge purchase cost again for a refunded order', () => {
    const result = sumRows([row({ manualPurchasePrice: 100, order: { status: 'REFUNDED' } })])

    expect(result.sales).toBe(0)
    expect(result.purchase).toBe(0)
    expect(result.profit).toBe(-60)
  })
})
