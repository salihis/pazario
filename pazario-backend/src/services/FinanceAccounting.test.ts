import { describe, expect, it } from 'vitest'
import { allocateAccounting, calculateFinanceRow, normalizeFinanceTransactions, sumRows, type FinanceTransaction } from './FinanceAccounting'

const transaction = (changes: Partial<FinanceTransaction> = {}): FinanceTransaction => ({
  id: 'a', type: 'Payment', category: 'OrderBased', orderNumber: 'order', packageNumber: 'package',
  sku: 'hb-sku', amount: 98.1, isIncome: true, isInvoice: false, status: 'WillBePaid',
  paymentDate: null, dueDate: null, ...changes,
})
const item = { id: 'item', sku: 'merchant-sku', marketplaceProductId: null, order: { marketplaceOrderId: 'package' } }
const row = { quantity: 1, totalPrice: 98.1, manualPurchasePrice: 30, shippingFee: 0, serviceFee: 0, extraFees: 0,
  order: { status: 'DELIVERED', marketplace: 'HEPSIBURADA' } }
const fixture = [transaction(), transaction({ id: 'b', type: 'Commission', amount: -22.24, isIncome: false, isInvoice: true }),
  transaction({ id: 'c', type: 'ShipmentCostSharingExpense', amount: -50.4, isIncome: false, isInvoice: true }),
  transaction({ id: 'd', type: 'CampaignDiscount', amount: 10.9, isInvoice: true }),
  transaction({ id: 'e', type: 'Stoppage', amount: -0.82, isIncome: false }),
  transaction({ id: 'f', type: 'PaymentServiceCostReflection', amount: -0.78, isIncome: false })]

describe('marketplace accounting', () => {
  it('uses signed gross amounts, income support and manual unit purchase without duplicating fees', () => {
    const accounting = allocateAccounting([item], fixture).get(item.id)!
    const result = calculateFinanceRow({ ...row, shippingFee: 50.4, serviceFee: 22.24, extraFees: 1.6, accounting })
    expect(result).toMatchObject({ sales: 98.1, additionalIncome: 10.9, shipping: 50.4, service: 22.24, extra: 1.6, net: 34.76, profit: 4.76, paid: 0, pending: 34.76 })
  })
  it('does not confuse invoiced order fees with invoice-level summaries', () => {
    const accounting = allocateAccounting([item], [...fixture, transaction({ id: 'summary', category: 'InvoiceBased', amount: -100, isIncome: false })]).get(item.id)!
    expect(accounting.service).toBe(22.24)
    expect(calculateFinanceRow({ ...row, accounting }).profit).toBeNull()
  })
  it('deduplicates movements by id and updates payment status without adding cash twice', () => {
    const accounting = allocateAccounting([item], [transaction({ status: 'Paid' }), transaction({ status: 'Paid' })]).get(item.id)!
    expect(accounting.paid).toBe(98.1)
    expect(accounting.pending).toBe(0)
  })
  it('keeps unavailable fees null and the result provisional', () => {
    const result = calculateFinanceRow({ ...row, accounting: allocateAccounting([item], [transaction()]).get(item.id) })
    expect(result).toMatchObject({ shipping: null, service: null, extra: null, provisional: true, accountingStatus: 'PARTIAL' })
  })
  it('does not present a profit when purchase price is missing, including the summary', () => {
    const missing = { ...row, manualPurchasePrice: null }
    expect(calculateFinanceRow(missing).profit).toBeNull()
    expect(sumRows([row, missing]).profit).toBeNull()
  })
  it('keeps a zero manual purchase price and multiplies the unit price by quantity', () => {
    expect(calculateFinanceRow({ ...row, quantity: 2 }).purchase).toBe(60)
    expect(calculateFinanceRow({ ...row, manualPurchasePrice: 0 }).purchase).toBe(0)
  })
  it('retains raw manual fees without adding them to API fees', () => {
    const result = calculateFinanceRow({ ...row, shippingFee: 70, accounting: allocateAccounting([item], fixture).get(item.id) })
    expect(result.shipping).toBe(50.4)
    expect(result.manualFees.shipping).toBe(70)
  })
  it('does not silently discard a possibly additional manual extra cost', () => {
    const result = calculateFinanceRow({ ...row, extraFees: 29.9, accounting: allocateAccounting([item], fixture).get(item.id) })
    expect(result.accountingStatus).toBe('REVIEW')
    expect(result.profit).toBeNull()
  })
  it('does not guess the product for a multi-item package', () => {
    const allocations = allocateAccounting([item, { ...item, id: 'other' }], fixture)
    expect(allocations.get(item.id)?.sales).toBeNull()
    expect(calculateFinanceRow({ ...row, accounting: allocations.get(item.id) }).profit).toBeNull()
  })
  it('matches HB SKU and package separately and never distributes to the other package', () => {
    const allocations = allocateAccounting([{ ...item, marketplaceProductId: 'hb-sku' },
      { ...item, id: 'other', marketplaceProductId: 'hb-sku', order: { marketplaceOrderId: 'other-package' } }], fixture)
    expect(allocations.get('item')?.sales).toBe(98.1)
    expect(allocations.get('other')?.sales).toBeNull()
  })
  it('retains refunds and commission reversals as signed movements', () => {
    const accounting = allocateAccounting([item], [...fixture,
      transaction({ id: 'return', type: 'Return', amount: -98.1, isIncome: false }),
      transaction({ id: 'refund', type: 'CommissionRefund', amount: 22.24 }),
    ]).get(item.id)!
    const result = calculateFinanceRow({ ...row, order: { status: 'REFUNDED' }, accounting })
    expect(result.sales).toBe(0)
    expect(result.purchase).toBe(0)
    expect(result.service).toBe(0)
  })
  it('requires review for partial returns instead of assuming the purchase cost vanished', () => {
    const accounting = allocateAccounting([item], [...fixture, transaction({ id: 'return', type: 'Return', amount: -20, isIncome: false })]).get(item.id)!
    expect(calculateFinanceRow({ ...row, accounting }).profit).toBeNull()
  })
  it('rejects mixed currencies, malformed amounts and a different order', () => {
    const raw = { id: 'a', transactionType: 'Payment', orderNumber: 'order', status: 'Paid',
      isIncome: true, isInvoice: false, amount: { value: 100, currencyCode: '949' } }
    expect(normalizeFinanceTransactions([raw], 'order')).toHaveLength(1)
    expect(() => normalizeFinanceTransactions([raw], 'other')).toThrow()
    expect(() => normalizeFinanceTransactions([{ ...raw, amount: { value: 100, currencyCode: '840' } }], 'order')).toThrow()
    expect(() => normalizeFinanceTransactions([{ ...raw, amount: { value: '100', currencyCode: '949' } }], 'order')).toThrow()
    expect(() => normalizeFinanceTransactions([{ ...raw, isIncome: false }], 'order')).toThrow()
  })
})
