import { Request, Response } from 'express'
import { Marketplace, Prisma, PrismaClient } from '@prisma/client'
import axios from 'axios'
import { calculatePurchaseCost } from '../../services/PurchaseCostService'
import { allocateAccounting, calculateFinanceRow, sumRows, type FinanceTransaction } from '../../services/FinanceAccounting'
import { financeCredential, syncHepsiburadaFinance } from '../../services/HepsiburadaFinanceService'
export { sumRows, type FinanceRow } from '../../services/FinanceAccounting'

const prisma = new PrismaClient()
const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const TRENDYOL_FINANCE_BASE_URL = 'https://apigw.trendyol.com/integration/finance/che/sellers'

const toNumber = (value: unknown) => Number(value ?? 0)

const startOfDay = (date: Date) => {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)

const getProductPriceMap = async (productIds: string[]) => {
  if (productIds.length === 0) return new Map<string, number>()
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      price: true,
      source: {
        select: {
          priceIncludesVat: true,
          purchaseVatRate: true,
          purchaseExtraFee: true,
        },
      },
    },
  })
  return new Map(products.map(product => [product.id, calculatePurchaseCost(product.price, product.source)]))
}

const parseMoneyInput = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.replace(',', '.') : value
  const parsed = Number(normalized ?? 0)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Gecersiz tutar')
  }
  return Math.round(parsed * 100) / 100
}

const parseOptionalMoneyInput = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null
  return parseMoneyInput(value)
}

interface TrendyolCargoInvoiceItem {
  shipmentPackageType?: string
  parcelUniqueId?: number | string
  orderNumber?: string | number
  amount?: number
  desi?: number
}

interface TrendyolCargoInvoiceResponse {
  page?: number
  size?: number
  totalPages?: number
  totalElements?: number
  content?: TrendyolCargoInvoiceItem[]
}

function trendyolFinanceHeaders() {
  const apiKey = process.env.TY_API_KEY
  const apiSecret = process.env.TY_API_SECRET
  const sellerId = process.env.TY_SUPPLIER_ID
  if (!apiKey || !apiSecret || !sellerId) {
    throw new Error('Trendyol API bilgileri eksik')
  }

  const token = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')
  return {
    sellerId,
    headers: {
      Authorization: `Basic ${token}`,
      'User-Agent': `${sellerId} - SelfIntegration`,
      Accept: 'application/json',
    },
  }
}

async function fetchTrendyolCargoInvoicePage(invoiceSerialNumber: string, page: number, size: number) {
  const { sellerId, headers } = trendyolFinanceHeaders()
  const response = await axios.get<TrendyolCargoInvoiceResponse>(
    `${TRENDYOL_FINANCE_BASE_URL}/${sellerId}/cargo-invoice/${encodeURIComponent(invoiceSerialNumber)}/items`,
    { params: { page, size }, headers, timeout: 30000 }
  )
  return response.data
}

async function fetchAllTrendyolCargoInvoiceItems(invoiceSerialNumber: string, size: number) {
  const first = await fetchTrendyolCargoInvoicePage(invoiceSerialNumber, 0, size)
  const totalPages = Math.max(1, Number(first.totalPages ?? 1))
  const pages = [first]

  for (let page = 1; page < totalPages; page++) {
    pages.push(await fetchTrendyolCargoInvoicePage(invoiceSerialNumber, page, size))
  }

  return {
    pageCount: totalPages,
    totalElements: Number(first.totalElements ?? pages.reduce((sum, p) => sum + (p.content?.length ?? 0), 0)),
    items: pages.flatMap(page => page.content ?? []),
  }
}

function normalizeCargoInvoiceItems(items: TrendyolCargoInvoiceItem[]) {
  return items
    .map(item => ({
      shipmentPackageType: String(item.shipmentPackageType ?? ''),
      parcelUniqueId: item.parcelUniqueId ? String(item.parcelUniqueId) : null,
      orderNumber: item.orderNumber ? String(item.orderNumber) : null,
      amount: Number(item.amount ?? 0),
      desi: item.desi === undefined || item.desi === null ? null : Number(item.desi),
    }))
    .filter(item => item.orderNumber && Number.isFinite(item.amount))
}

async function applyTrendyolCargoAmounts(items: ReturnType<typeof normalizeCargoInvoiceItems>) {
  const byOrderNumber = new Map<string, number>()
  for (const item of items) {
    if (!item.orderNumber) continue
    byOrderNumber.set(item.orderNumber, (byOrderNumber.get(item.orderNumber) ?? 0) + item.amount)
  }

  let matchedOrders = 0
  let updatedItems = 0
  let appliedAmount = 0
  const unmatchedOrderNumbers: string[] = []

  for (const [orderNumber, shippingTotal] of byOrderNumber.entries()) {
    const order = await prisma.order.findFirst({
      where: { marketplace: 'TRENDYOL', marketplaceOrderNo: orderNumber },
      include: { items: true },
    })

    if (!order || order.items.length === 0) {
      unmatchedOrderNumbers.push(orderNumber)
      continue
    }

    matchedOrders++
    const salesTotal = order.items.reduce((sum, item) => sum + toNumber(item.totalPrice), 0)
    const evenShare = shippingTotal / order.items.length

    for (const item of order.items) {
      const share = salesTotal > 0
        ? shippingTotal * (toNumber(item.totalPrice) / salesTotal)
        : evenShare
      const roundedShare = Math.round(share * 100) / 100
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { shippingFee: roundedShare },
      })
      updatedItems++
    }

    appliedAmount += shippingTotal
  }

  return {
    matchedOrders,
    updatedItems,
    appliedAmount: Math.round(appliedAmount * 100) / 100,
    unmatchedOrderNumbers,
  }
}

const financeOrderSelect = {
  id: true, marketplace: true, marketplaceOrderNo: true, marketplaceOrderId: true,
  createdAt: true, orderedAt: true, status: true,
} satisfies Prisma.OrderSelect

function orderDateWhere(from: Date, to: Date): Prisma.OrderWhereInput {
  return { OR: [{ orderedAt: { gte: from, lte: to } }, { orderedAt: null, createdAt: { gte: from, lte: to } }] }
}

export async function getFinanceOverview(req: Request, res: Response) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50))
    const marketplace = MARKETPLACES.includes(req.query.marketplace as Marketplace) ? req.query.marketplace as Marketplace : undefined
    const sourceId = req.query.sourceId ? String(req.query.sourceId) : undefined
    const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : startOfMonth(new Date())
    const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : new Date()
    endDate.setHours(23, 59, 59, 999)
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate > endDate) {
      res.status(400).json({ success: false, error: 'Gecersiz tarih araligi' })
      return
    }
    const now = new Date()
    const weekStart = new Date(now.getTime() - 7 * 86400000)
    const monthStart = startOfMonth(now)
    const earliest = new Date(Math.min(startDate.getTime(), weekStart.getTime(), monthStart.getTime()))
    const latest = new Date(Math.max(endDate.getTime(), now.getTime()))
    const rows = await prisma.orderItem.findMany({
      where: {
        order: { ...orderDateWhere(earliest, latest), ...(marketplace ? { marketplace } : {}) },
        ...(sourceId ? { sourceId } : {}),
      },
      include: {
        order: { select: financeOrderSelect },
        source: { select: { id: true, name: true } },
      },
    })
    const orderNumbers = [...new Set(rows.filter(r => r.order.marketplace === 'HEPSIBURADA')
      .map(r => r.order.marketplaceOrderNo).filter((v): v is string => Boolean(v)))]
    const credential = orderNumbers.length ? await financeCredential(prisma).catch(() => null) : null
    const snapshots = credential ? await prisma.marketplaceFinanceSnapshot.findMany({
      where: { marketplace: 'HEPSIBURADA', environment: credential.environment,
        merchantId: credential.merchantId, orderNumber: { in: orderNumbers } },
    }) : []
    // Include all siblings, even outside the selected XML source, to prevent double allocation.
    const siblings = snapshots.length ? await prisma.orderItem.findMany({
      where: { order: { marketplace: 'HEPSIBURADA', marketplaceOrderNo: { in: snapshots.map(s => s.orderNumber) } } },
      include: { order: { select: financeOrderSelect } },
    }) : []
    const accountingByItem = new Map<string, ReturnType<typeof allocateAccounting> extends Map<string, infer V> ? V : never>()
    const snapshotByOrder = new Map(snapshots.map(s => [s.orderNumber, s]))
    for (const snapshot of snapshots) {
      const allocations = allocateAccounting(
        siblings.filter(i => i.order.marketplaceOrderNo === snapshot.orderNumber),
        snapshot.transactions as unknown as FinanceTransaction[],
      )
      for (const [id, value] of allocations) accountingByItem.set(id, value)
    }
    const enriched = rows.map(row => {
      const snapshot = row.order.marketplace === 'HEPSIBURADA'
        ? snapshotByOrder.get(row.order.marketplaceOrderNo || '') : undefined
      return { ...row, accounting: accountingByItem.get(row.id),
        accountingSyncedAt: snapshot?.syncedAt, accountingError: snapshot?.lastError }
    })
    const prices = await getProductPriceMap([...new Set(rows.map(r => r.productId).filter((v): v is string => Boolean(v)))])
    const inRange = (from: Date, to: Date) => enriched.filter(r => {
      const date = r.order.orderedAt ?? r.order.createdAt
      return date >= from && date <= to
    })
    const selected = inRange(startDate, endDate).sort((a, b) =>
      (b.order.orderedAt ?? b.order.createdAt).getTime() - (a.order.orderedAt ?? a.order.createdAt).getTime()
      || a.id.localeCompare(b.id))
    res.json({ success: true, data: {
      items: selected.slice((page - 1) * limit, page * limit).map(item => ({
        id: item.id, orderId: item.orderId,
        orderNo: item.order.marketplaceOrderNo ?? item.order.marketplaceOrderId,
        orderDate: item.order.orderedAt ?? item.order.createdAt, orderStatus: item.order.status,
        marketplace: item.order.marketplace, productId: item.productId, sourceId: item.sourceId,
        sourceName: item.source?.name ?? 'Eslesmedi', sku: item.sku, title: item.title,
        quantity: item.quantity, unitPrice: toNumber(item.unitPrice),
        ...calculateFinanceRow(item, prices),
      })),
      syncTargets: [...new Map(selected.filter(r => r.order.marketplace === 'HEPSIBURADA' && r.order.marketplaceOrderNo)
        .map(r => [r.order.marketplaceOrderNo, { orderId: r.orderId, orderNumber: r.order.marketplaceOrderNo }])).values()],
      summary: {
        selectedRange: sumRows(selected, prices),
        today: sumRows(inRange(startOfDay(now), now), prices),
        week: sumRows(inRange(weekStart, now), prices),
        month: sumRows(inRange(monthStart, now), prices),
      },
      meta: { total: selected.length, page, limit },
    } })
  } catch {
    res.status(500).json({ success: false, error: 'Finans verisi alinamadi' })
  }
}

export async function syncFinanceOrder(req: Request, res: Response) {
  const orderId = String(req.params.orderId || '')
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
    res.status(400).json({ success: false, error: 'Gecersiz siparis kimligi' })
    return
  }
  try {
    const data = await syncHepsiburadaFinance(prisma, orderId)
    res.json({ success: true, data })
  } catch (error) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : 'Muhasebe guncellenemedi' })
  }
}

export async function updateFinanceItemFees(req: Request, res: Response) {
  try {
    const itemId = String(req.params.itemId || '').trim()
    if (!itemId) {
      res.status(400).json({ success: false, error: 'itemId zorunlu' })
      return
    }

    const shippingFee = parseMoneyInput(req.body?.shipping)
    const serviceFee = parseMoneyInput(req.body?.service)
    const extraFees = parseMoneyInput(req.body?.extra)
    const hasManualPurchasePrice = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      'manualPurchasePrice',
    )
    const manualPurchasePrice = hasManualPurchasePrice
      ? parseOptionalMoneyInput(req.body?.manualPurchasePrice)
      : undefined

    const updated = await prisma.orderItem.update({
      where: { id: itemId },
      data: {
        shippingFee,
        serviceFee,
        extraFees,
        ...(hasManualPurchasePrice ? { manualPurchasePrice } : {}),
      },
      include: {
        order: {
          select: {
            marketplaceOrderNo: true,
            marketplaceOrderId: true,
          },
        },
      },
    })

    res.json({
      success: true,
      data: {
        id: updated.id,
        orderNo: updated.order.marketplaceOrderNo ?? updated.order.marketplaceOrderId,
        shipping: toNumber(updated.shippingFee),
        service: toNumber(updated.serviceFee),
        extra: toNumber(updated.extraFees),
        manualPurchasePrice: updated.manualPurchasePrice === null
          ? null
          : toNumber(updated.manualPurchasePrice),
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Finans kalemi guncellenemedi'
    res.status(400).json({ success: false, error: message })
  }
}

export async function getTrendyolCargoInvoiceItems(req: Request, res: Response) {
  try {
    const invoiceSerialNumber = String(req.params.invoiceSerialNumber || '').trim()
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10))
    const size = Math.min(500, Math.max(1, parseInt(String(req.query.size || '500'), 10)))

    if (!invoiceSerialNumber) {
      res.status(400).json({ success: false, error: 'invoiceSerialNumber zorunlu' })
      return
    }

    const data = await fetchTrendyolCargoInvoicePage(invoiceSerialNumber, page, size)
    const items = normalizeCargoInvoiceItems(data.content ?? [])

    res.json({
      success: true,
      data: {
        invoiceSerialNumber,
        page: data.page ?? page,
        size: data.size ?? size,
        totalPages: data.totalPages ?? 1,
        totalElements: data.totalElements ?? items.length,
        items,
        summary: {
          count: items.length,
          amount: Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
        },
      },
    })
  } catch (e) {
    const detail = axios.isAxiosError(e) ? e.response?.data || e.message : e instanceof Error ? e.message : String(e)
    res.status(502).json({ success: false, error: 'Trendyol kargo faturasi alinamadi', detail })
  }
}

export async function importTrendyolCargoInvoiceItems(req: Request, res: Response) {
  try {
    const invoiceSerialNumber = String(req.params.invoiceSerialNumber || '').trim()
    const size = Math.min(500, Math.max(1, parseInt(String(req.body?.size || req.query.size || '500'), 10)))

    if (!invoiceSerialNumber) {
      res.status(400).json({ success: false, error: 'invoiceSerialNumber zorunlu' })
      return
    }

    const fetched = await fetchAllTrendyolCargoInvoiceItems(invoiceSerialNumber, size)
    const items = normalizeCargoInvoiceItems(fetched.items)
    const applied = await applyTrendyolCargoAmounts(items)

    res.json({
      success: true,
      data: {
        invoiceSerialNumber,
        pageCount: fetched.pageCount,
        totalElements: fetched.totalElements,
        importedItems: items.length,
        invoiceAmount: Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
        ...applied,
      },
    })
  } catch (e) {
    const detail = axios.isAxiosError(e) ? e.response?.data || e.message : e instanceof Error ? e.message : String(e)
    res.status(502).json({ success: false, error: 'Trendyol kargo faturasi finans kayitlarina islenemedi', detail })
  }
}
