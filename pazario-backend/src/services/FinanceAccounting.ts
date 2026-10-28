export type FinanceTransaction = {
  id: string
  type: string
  category: string
  orderNumber: string
  packageNumber: string
  sku: string
  amount: number
  isIncome: boolean
  isInvoice: boolean
  status: string
  paymentDate: string | null
  dueDate: string | null
}

export type AccountingItem = {
  id: string
  sku: string | null
  marketplaceProductId: string | null
  order: { marketplaceOrderId: string }
}

export type AccountingAmounts = {
  sales: number | null
  shipping: number | null
  service: number | null
  extra: number | null
  additionalIncome: number
  paid: number
  pending: number
  transactions: FinanceTransaction[]
  issues: string[]
}

type Bucket = 'sales' | 'shipping' | 'service' | 'extra' | 'additionalIncome'
const TYPES: Record<string, Bucket> = {
  Payment: 'sales', Return: 'sales',
  Commission: 'service', CommissionRefund: 'service', CommissionInvoiceRefund: 'service', CommissionCorrection: 'service',
  ShipmentCostSharingExpense: 'shipping', ShipmentCostSharingIncome: 'shipping',
  ReturnShipmentCostSharingExpense: 'shipping', CargoCostRefund: 'shipping',
  ProcessingFeeExpense: 'extra', ProcessingFeeExpenseRefund: 'extra',
  DeliveryProcessingFee: 'extra', DeliveryProcessingFeeRefund: 'extra', ReturnDeliveryProcessingFee: 'extra',
  PaymentServiceCostReflection: 'extra', PaymentServiceCostReflectionRefund: 'extra',
  Stoppage: 'extra', StoppageRefund: 'extra',
  CampaignDiscount: 'additionalIncome', CampaignDiscountRefund: 'additionalIncome',
}

export const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

// Keep only financial fields. No credentials, customer data or invoice URLs are persisted.
export function normalizeFinanceTransactions(values: unknown, orderNumber: string): FinanceTransaction[] {
  if (!Array.isArray(values)) throw new Error('Muhasebe yanit formati gecersiz')
  const unique = new Map<string, FinanceTransaction>()
  for (const raw of values) {
    if (!raw || typeof raw !== 'object') throw new Error('Muhasebe hareketi gecersiz')
    const r = raw as Record<string, any>
    const amount = r.amount
    if (!r.id || typeof r.transactionType !== 'string' || String(r.orderNumber) !== orderNumber
      || !amount || typeof amount.value !== 'number' || !Number.isFinite(amount.value)
      || !['949', 'TRY'].includes(String(amount.currencyCode))
      || typeof r.isIncome !== 'boolean' || typeof r.isInvoice !== 'boolean'
      || !['Paid', 'WillBePaid'].includes(r.status)) {
      throw new Error('Muhasebe hareketi kimlik, tutar, para birimi veya durum kontrolunden gecemedi')
    }
    if ((amount.value > 0 && !r.isIncome) || (amount.value < 0 && r.isIncome)) {
      throw new Error('Muhasebe hareketinin tutari ile gelir/gider yonu uyusmuyor')
    }
    const transaction: FinanceTransaction = {
      id: String(r.id), type: r.transactionType, category: String(r.transactionTypeCategory || ''),
      orderNumber, packageNumber: String(r.packageNumber || ''), sku: String(r.sku || ''),
      amount: roundMoney(amount.value), isIncome: r.isIncome, isInvoice: r.isInvoice,
      status: r.status, paymentDate: r.paymentDate || null, dueDate: r.dueDate || null,
    }
    const previous = unique.get(transaction.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(transaction)) throw new Error('Cakisan muhasebe hareketi')
    unique.set(transaction.id, transaction)
  }
  return [...unique.values()]
}

export function allocateAccounting(items: AccountingItem[], transactions: FinanceTransaction[]) {
  const result = new Map<string, AccountingAmounts>(items.map(item => [item.id, {
    sales: null, shipping: null, service: null, extra: null, additionalIncome: 0,
    paid: 0, pending: 0, transactions: [], issues: [],
  }]))
  const seen = new Set<string>()
  for (const t of transactions) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    const candidates = items.filter(i => !t.packageNumber || i.order.marketplaceOrderId === t.packageNumber)
    const matches = t.sku ? candidates.filter(i => i.marketplaceProductId === t.sku || i.sku === t.sku) : []
    // A single-item package is unambiguous even when HB SKU differs from merchant SKU.
    const target = matches.length === 1 ? matches[0] : candidates.length === 1 ? candidates[0] : null
    const bucket = TYPES[t.type]
    if (!target || !bucket || t.category !== 'OrderBased') {
      for (const item of items) result.get(item.id)!.issues.push(!target
        ? 'Urunle eslestirilemeyen muhasebe hareketi'
        : `Siniflandirilmamis hareket: ${t.type}`)
      continue
    }
    const totals = result.get(target.id)!
    totals.transactions.push(t)
    const signed = ['shipping', 'service', 'extra'].includes(bucket) ? -t.amount : t.amount
    totals[bucket] = roundMoney((totals[bucket] ?? 0) + signed)
    if (t.status === 'Paid') totals.paid = roundMoney(totals.paid + t.amount)
    else totals.pending = roundMoney(totals.pending + t.amount)
  }
  return result
}

export type FinanceRow = {
  productId?: string | null
  manualPurchasePrice?: unknown | null
  quantity: number
  totalPrice: unknown
  shippingFee: unknown
  serviceFee: unknown
  extraFees: unknown
  order?: { status?: string; marketplace?: string }
  accounting?: AccountingAmounts
  accountingSyncedAt?: Date | null
  accountingError?: string | null
}

const NON_REVENUE = new Set(['CANCELLED', 'CANCELLATION_REQUESTED', 'RETURN_REQUESTED', 'RETURN_APPROVED', 'REFUNDED', 'DELIVERY_FAILED'])

export function calculateFinanceRow(row: FinanceRow, prices = new Map<string, number>()) {
  const revenue = !NON_REVENUE.has(row.order?.status || '')
  const manualPurchasePrice = row.manualPurchasePrice == null ? null : Number(row.manualPurchasePrice)
  const xmlPrice = row.productId ? prices.get(row.productId) ?? null : null
  const unitPurchasePrice = manualPurchasePrice ?? xmlPrice
  const a = row.accounting
  const issues = [...(a?.issues ?? [])]
  const apiSales = a?.sales
  // Return requests and partial refunds do not prove that goods have returned to stock.
  const returnUncertain = ['RETURN_REQUESTED', 'RETURN_APPROVED', 'CANCELLATION_REQUESTED', 'DELIVERY_FAILED'].includes(row.order?.status || '')
    || Boolean(a?.transactions.some(t => t.type === 'Return') && apiSales !== 0)
  if (returnUncertain) issues.push('Iade ve alis maliyeti kontrolu gerekli')
  const purchase = returnUncertain ? null : !revenue && (apiSales == null || apiSales === 0) ? 0
    : unitPurchasePrice === null ? null : roundMoney(unitPurchasePrice * row.quantity)
  const manualFees = { shipping: Number(row.shippingFee), service: Number(row.serviceFee), extra: Number(row.extraFees) }
  // API category totals replace, never add to, legacy/manual totals of the same category.
  const shipping = a?.shipping ?? (manualFees.shipping !== 0 ? manualFees.shipping : null)
  const service = a?.service ?? (manualFees.service !== 0 ? manualFees.service : null)
  // A partial set of extra fees (e.g. only withholding) cannot replace a manual total safely.
  const extraConflict = a?.extra != null && manualFees.extra !== 0 && a.extra !== manualFees.extra
  if (extraConflict) issues.push('Manuel ek ucret ile muhasebe toplami farkli')
  const extra = a?.extra ?? (manualFees.extra !== 0 ? manualFees.extra : null)
  const sales = apiSales ?? (revenue ? Number(row.totalPrice) : 0)
  const additionalIncome = a?.additionalIncome ?? 0
  const net = roundMoney(sales + additionalIncome - (shipping ?? 0) - (service ?? 0) - (extra ?? 0))
  const profit = purchase === null || issues.length ? null : roundMoney(net - purchase)
  const missing = [shipping === null && 'Kargo', service === null && 'Komisyon', extra === null && 'Ek ucret'].filter(Boolean)
  if (row.accountingError) issues.push('Son muhasebe sorgusu basarisiz; onceki kayitlar korunuyor')
  return {
    sales, originalSales: Number(row.totalPrice), additionalIncome, shipping, service, extra,
    purchase, unitPurchasePrice, manualPurchasePrice,
    purchasePriceSource: manualPurchasePrice !== null ? 'MANUAL' : xmlPrice !== null ? 'XML' : 'MISSING',
    manualFees, net, grossProfit: purchase === null ? null : roundMoney(sales + additionalIncome - purchase), profit,
    isRevenueOrder: revenue, provisional: true,
    accountingStatus: issues.length ? 'REVIEW' : !a?.transactions.length ? 'WAITING' : missing.length ? 'PARTIAL' : 'RECORDED',
    missingFees: missing, issues: [...new Set(issues)],
    accountingSyncedAt: row.accountingSyncedAt ?? null,
    paid: a?.transactions.length ? a.paid : null,
    pending: a?.transactions.length ? a.pending : null,
    transactions: a?.transactions ?? [],
  }
}

export function sumRows(rows: FinanceRow[], prices = new Map<string, number>()) {
  const values = rows.map(row => calculateFinanceRow(row, prices))
  const sum = (key: 'sales' | 'purchase' | 'shipping' | 'service' | 'extra' | 'additionalIncome' | 'net' | 'profit' | 'paid' | 'pending') =>
    roundMoney(values.reduce((total, row) => total + (row[key] ?? 0), 0))
  const missingPurchase = values.filter(v => v.purchase === null).length
  return { orders: rows.length, sales: sum('sales'), purchase: sum('purchase'), shipping: sum('shipping'),
    service: sum('service'), extra: sum('extra'), additionalIncome: sum('additionalIncome'), net: sum('net'),
    profit: values.some(v => v.profit === null) ? null : sum('profit'), missingPurchase,
    provisional: values.length > 0, incomplete: values.filter(v => v.accountingStatus !== 'RECORDED').length,
    paid: sum('paid'), pending: sum('pending'),
  }
}
