import { Request, Response } from 'express'
import { Marketplace, Prisma, PrismaClient } from '@prisma/client'
import axios from 'axios'

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

type FinanceRow = {
  productId?: string | null
  quantity: number
  totalPrice: unknown
  shippingFee: unknown
  serviceFee: unknown
  extraFees: unknown
}

const getProductPriceMap = async (productIds: string[]) => {
  if (productIds.length === 0) return new Map<string, number>()
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, price: true },
  })
  return new Map(products.map(product => [product.id, toNumber(product.price)]))
}

const sumRows = (rows: FinanceRow[], productPriceById = new Map<string, number>()) => {
  const sales = rows.reduce((sum, row) => sum + toNumber(row.totalPrice), 0)
  const purchase = rows.reduce((sum, row) => {
    if (!row.productId) return sum
    const unitPurchasePrice = productPriceById.get(row.productId)
    return unitPurchasePrice === undefined ? sum : sum + unitPurchasePrice * row.quantity
  }, 0)
  const missingPurchase = rows.filter(row => row.productId && !productPriceById.has(row.productId)).length
  const shipping = rows.reduce((sum, row) => sum + toNumber(row.shippingFee), 0)
  const service = rows.reduce((sum, row) => sum + toNumber(row.serviceFee), 0)
  const extra = rows.reduce((sum, row) => sum + toNumber(row.extraFees), 0)
  return {
    orders: rows.length,
    sales,
    purchase,
    shipping,
    service,
    extra,
    net: sales - shipping - service - extra,
    profit: sales - purchase - shipping - service - extra,
    missingPurchase,
  }
}

const parseMoneyInput = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.replace(',', '.') : value
  const parsed = Number(normalized ?? 0)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Gecersiz tutar')
  }
  return Math.round(parsed * 100) / 100
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

export async function getFinanceOverview(req: Request, res: Response) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10))
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '50'), 10)))
    const marketplaceParam = req.query.marketplace ? String(req.query.marketplace) : undefined
    const marketplace = MARKETPLACES.includes(marketplaceParam as Marketplace)
      ? marketplaceParam as Marketplace
      : undefined
    const sourceId = req.query.sourceId ? String(req.query.sourceId) : undefined
    const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : startOfMonth(new Date())
    const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : new Date()
    endDate.setHours(23, 59, 59, 999)

    const where: Prisma.OrderItemWhereInput = {
      order: {
        createdAt: { gte: startDate, lte: endDate },
        ...(marketplace ? { marketplace } : {}),
      },
      ...(sourceId ? { sourceId } : {}),
    }

    const scopedOrderWhere = (from: Date, to: Date): Prisma.OrderItemWhereInput => ({
      ...where,
      order: {
        createdAt: { gte: from, lte: to },
        ...(marketplace ? { marketplace } : {}),
      },
    })

    const [items, total, allRangeItems, todayItems, weekItems, monthItems] = await Promise.all([
      prisma.orderItem.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { order: { createdAt: 'desc' } },
        include: {
          order: {
            select: {
              id: true,
              marketplace: true,
              marketplaceOrderNo: true,
              marketplaceOrderId: true,
              createdAt: true,
              status: true,
            },
          },
          source: { select: { id: true, name: true, url: true } },
        },
      }),
      prisma.orderItem.count({ where }),
      prisma.orderItem.findMany({ where, select: { productId: true, quantity: true, totalPrice: true, shippingFee: true, serviceFee: true, extraFees: true } }),
      prisma.orderItem.findMany({
        where: scopedOrderWhere(startOfDay(new Date()), new Date()),
        select: { productId: true, quantity: true, totalPrice: true, shippingFee: true, serviceFee: true, extraFees: true },
      }),
      prisma.orderItem.findMany({
        where: scopedOrderWhere(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), new Date()),
        select: { productId: true, quantity: true, totalPrice: true, shippingFee: true, serviceFee: true, extraFees: true },
      }),
      prisma.orderItem.findMany({
        where: scopedOrderWhere(startOfMonth(new Date()), new Date()),
        select: { productId: true, quantity: true, totalPrice: true, shippingFee: true, serviceFee: true, extraFees: true },
      }),
    ])

    const productIds = Array.from(new Set([
      ...items.map(item => item.productId),
      ...allRangeItems.map(item => item.productId),
      ...todayItems.map(item => item.productId),
      ...weekItems.map(item => item.productId),
      ...monthItems.map(item => item.productId),
    ].filter(Boolean))) as string[]
    const productPriceById = await getProductPriceMap(productIds)

    res.json({
      success: true,
      data: {
        items: items.map(item => {
          const sales = toNumber(item.totalPrice)
          const unitPurchasePrice = item.productId ? productPriceById.get(item.productId) ?? null : null
          const purchase = unitPurchasePrice === null ? null : unitPurchasePrice * item.quantity
          const shipping = toNumber(item.shippingFee)
          const service = toNumber(item.serviceFee)
          const extra = toNumber(item.extraFees)
          return {
            id: item.id,
            orderId: item.orderId,
            orderNo: item.order.marketplaceOrderNo ?? item.order.marketplaceOrderId,
            orderDate: item.order.createdAt,
            orderStatus: item.order.status,
            marketplace: item.order.marketplace,
            productId: item.productId,
            sourceId: item.sourceId,
            sourceName: item.source?.name ?? 'Eslesmedi',
            sku: item.sku,
            title: item.title,
            quantity: item.quantity,
            unitPrice: toNumber(item.unitPrice),
            unitPurchasePrice,
            purchase,
            sales,
            shipping,
            service,
            extra,
            net: sales - shipping - service - extra,
            grossProfit: purchase === null ? null : sales - purchase,
            profit: purchase === null ? null : sales - purchase - shipping - service - extra,
          }
        }),
        summary: {
          selectedRange: sumRows(allRangeItems, productPriceById),
          today: sumRows(todayItems, productPriceById),
          week: sumRows(weekItems, productPriceById),
          month: sumRows(monthItems, productPriceById),
        },
        meta: { total, page, limit },
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Finans verisi alinamadi' })
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

    const updated = await prisma.orderItem.update({
      where: { id: itemId },
      data: { shippingFee, serviceFee, extraFees },
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
