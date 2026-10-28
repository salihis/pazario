import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { planOrderItemSync, syncOrderItemsPreservingFinance } from './OrderItemSyncService'

const incoming = (sku = 'SKU-1') => ({
  sku, marketplaceProductId: 'product-1', title: 'Product', quantity: 1,
  unitPrice: 100, totalPrice: 90, discountAmount: 10,
  shippingFee: 0, serviceFee: 0, extraFees: 0, productId: null, sourceId: null,
})
const stored = (sku = 'SKU-1', id = 'item-1') => ({
  id, sku, marketplaceProductId: 'product-1', title: 'Product',
})

describe('order item reconciliation', () => {
  it('keeps row IDs across repeat imports', () => {
    expect(planOrderItemSync([stored()], [incoming()])[0].existingId).toBe('item-1')
  })
  it('matches reordered variants by SKU rather than shared product ID or array position', () => {
    const plan = planOrderItemSync([stored('S', 'small'), stored('L', 'large')], [incoming('L'), incoming('S')])
    expect(plan.map(row => row.existingId)).toEqual(['large', 'small'])
  })
  it('matches a uniquely identified line when one response omits the SKU', () => {
    expect(planOrderItemSync([stored()], [{ ...incoming(), sku: null }])[0].existingId).toBe('item-1')
  })
  it('does not move money to a different SKU sharing the same product ID', () => {
    expect(() => planOrderItemSync([stored('S')], [incoming('L')])).toThrow('eslesmedi')
  })
  it('allows new lines without deleting the old ones', () => {
    const plan = planOrderItemSync([stored()], [incoming(), { ...incoming('new'), marketplaceProductId: 'new' }])
    expect(plan.map(row => row.existingId)).toEqual(['item-1', undefined])
  })
  it('rejects incomplete API results', () => {
    expect(() => planOrderItemSync([stored(), stored('missing', 'item-2')], [incoming()])).toThrow('eslesmedi')
  })
  it('rejects ambiguous existing rows', () => {
    expect(() => planOrderItemSync([stored(), stored('SKU-1', 'item-2')], [incoming()])).toThrow('belirsiz')
  })
  it('rejects duplicate incoming rows before writing anything', () => {
    expect(() => planOrderItemSync([stored()], [incoming(), incoming()])).toThrow('tekrari')
  })
  it('matches an unkeyed row only by a unique exact title', () => {
    const old = { ...stored(), sku: null, marketplaceProductId: null }
    const next = { ...incoming(), sku: null, marketplaceProductId: null }
    expect(planOrderItemSync([old], [next])[0].existingId).toBe('item-1')
    expect(() => planOrderItemSync([old], [{ ...next, title: 'Other' }])).toThrow('eslesmedi')
  })
  it('preserves manual values, including zero, and does not reset source links', async () => {
    const old = { ...stored(), manualPurchasePrice: 0, shippingFee: 29.9, serviceFee: 10, extraFees: 5 }
    const update = vi.fn().mockResolvedValue(old)
    const create = vi.fn()
    const tx = { orderItem: { findMany: vi.fn().mockResolvedValue([old]), update, create } }
    await syncOrderItemsPreservingFinance(tx as unknown as Prisma.TransactionClient, 'order-1', [incoming()])
    const data = update.mock.calls[0][0].data
    for (const field of ['manualPurchasePrice', 'shippingFee', 'serviceFee', 'extraFees']) {
      expect(data).not.toHaveProperty(field)
    }
    expect(data.productId).toBeUndefined()
    expect(data.sourceId).toBeUndefined()
    expect(data).toMatchObject({ totalPrice: 90, discountAmount: 10 })
    expect(create).not.toHaveBeenCalled()
  })
  it('retains initial API fees on a genuinely new line', async () => {
    const create = vi.fn().mockResolvedValue({})
    const tx = { orderItem: { findMany: vi.fn().mockResolvedValue([]), create, update: vi.fn() } }
    await syncOrderItemsPreservingFinance(tx as unknown as Prisma.TransactionClient, 'order-1', [{ ...incoming(), shippingFee: 12 }])
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ orderId: 'order-1', shippingFee: 12 }) })
  })
})
