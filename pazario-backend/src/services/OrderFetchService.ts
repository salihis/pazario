// src/services/OrderFetchService.ts

import { OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import axios from 'axios'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { EmailService } from './EmailService'
import { logger } from '../utils/logger'

// ─── HATA SINIFLARI ──────────────────────────────────────────────────────────

export class OrderFetchError extends Error {
  constructor(
    message: string,
    public readonly marketplace: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = 'OrderFetchError'
  }
}

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'

interface FetchSummaryItem {
  marketplace: Marketplace
  fetched: number
  newOrders: number
  errors: string[]
}

export interface FetchSummary {
  results: FetchSummaryItem[]
  totalNew: number
  durationMs: number
}

interface NormalizedOrder {
  marketplace: Marketplace
  marketplaceOrderId: string
  marketplaceOrderNo: string | null
  customerName: string | null
  customerPhone: string | null
  shippingAddress: object | null
  billingAddress: object | null
  totalAmount: number
  currency: string
  status: OrderStatus
  cargoCompany?: string | null
  trackingNumber?: string | null
  items: {
    marketplaceProductId: string | null
    sku: string | null
    title: string
    quantity: number
    unitPrice: number
    totalPrice: number
    shippingFee?: number
    serviceFee?: number
    extraFees?: number
    vatRate: number | null
  }[]
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const INITIAL_FETCH_DAYS = 7
const FETCH_OVERLAP_HOURS = Number(process.env.ORDER_FETCH_OVERLAP_HOURS || '72')
const MARKETPLACE_BARCODE_PREFIX = 'BRS'
const TRENDYOL_ORDER_URL = 'https://apigw.trendyol.com/integration/order/sellers'
const PAZARAMA_TOKEN_URL = 'https://isortagimgiris.pazarama.com/connect/token'
const TRENDYOL_STREAM_PAGE_SIZE = 200
const TRENDYOL_STREAM_DELAY_MS = 5000

// ─── ŞİFRELEME YARDIMCIları ──────────────────────────────────────────────────

/**
 * AES-256-GCM ile şifreler — KVKK uyumu
 */
function encrypt(text: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * AES-256-GCM ile şifre çözer
 */
function decrypt(encryptedText: string, keyHex: string): string {
  const [ivHex, tagHex, dataHex] = encryptedText.split(':')
  const key = Buffer.from(keyHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const data = Buffer.from(dataHex, 'hex')
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(data) + decipher.final('utf8')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── SERVİS ───────────────────────────────────────────────────────────────────

export class OrderFetchService {
  private readonly encryptionKey: string
  private readonly emailService = new EmailService()
  private pazaramaTokenCache: { token: string; expiresAt: number } | null = null

  constructor(private readonly prisma: PrismaClient) {
    const key = process.env.FIELD_ENCRYPTION_KEY
    if (!key) throw new Error('FIELD_ENCRYPTION_KEY tanımlı değil')
    this.encryptionKey = key
  }

  /**
   * Tüm pazaryerlerinden sipariş çeker
   * Promise.allSettled — bir hata diğerlerini durdurmaz
   */
  async fetchAll(): Promise<FetchSummary> {
    const startTime = Date.now()
    const marketplaces: Marketplace[] = ['TRENDYOL', 'N11', 'PAZARAMA']

    const settled = await Promise.allSettled(
      marketplaces.map(mp => this.fetchFromMarketplace(mp))
    )

    const results: FetchSummaryItem[] = settled.map((result, i) => {
      if (result.status === 'fulfilled') return result.value
      return {
        marketplace: marketplaces[i],
        fetched: 0,
        newOrders: 0,
        errors: [result.reason?.message ?? 'Bilinmeyen hata'],
      }
    })

    return {
      results,
      totalNew: results.reduce((acc, r) => acc + r.newOrders, 0),
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Tek pazaryerinden sipariş çeker
   */
  async fetchFromMarketplace(marketplace: Marketplace): Promise<FetchSummaryItem> {
    const errors: string[] = []
    let fetched = 0
    let newOrders = 0

    try {
      // Son başarılı fetch zamanını bul
      const lastLog = await this.prisma.orderFetchLog.findFirst({
        where: { marketplace, status: 'SUCCESS' },
        orderBy: { createdAt: 'desc' },
      })

      const endDate = new Date()
      const startDate = lastLog?.lastFetchedAt
        ? new Date(lastLog.lastFetchedAt.getTime() - Math.max(FETCH_OVERLAP_HOURS, 1) * 60 * 60 * 1000)
        : new Date(Date.now() - INITIAL_FETCH_DAYS * 24 * 60 * 60 * 1000)

      // Sayfalı çekme
      const rawOrders = marketplace === 'TRENDYOL'
        ? await this.fetchTrendyolOrdersStream(startDate, endDate)
        : await this.fetchPagedOrders(marketplace, startDate, endDate)

      fetched = rawOrders.length

      // Her siparişi normalize et ve kaydet
      for (const raw of rawOrders) {
        try {
          const normalized = this.normalizeOrder(raw, marketplace)
          const isNew = await this.createOrder(normalized)
          if (isNew) newOrders++
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e))
        }
      }

      // Başarı logu
      await this.prisma.orderFetchLog.create({
        data: {
          marketplace,
          status: 'SUCCESS',
          fetchedCount: fetched,
          lastFetchedAt: endDate,
        },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(msg)

      await this.prisma.orderFetchLog.create({
        data: {
          marketplace,
          status: 'FAILED',
          fetchedCount: 0,
          errorMessage: msg,
          lastFetchedAt: new Date(),
        },
      })
    }

    return { marketplace, fetched, newOrders, errors }
  }

  /**
   * Sayfalı veri çekme — her pazaryeri için ayrı implementasyon
   */
  private async fetchPage(
    marketplace: Marketplace,
    startDate: Date,
    endDate: Date,
    page: number
  ): Promise<unknown> {
    // Gerçek implementasyonda adapter kullanılır
    // Burada placeholder — adapter inject edilmeli
    switch (marketplace) {
      case 'TRENDYOL':
        return this.fetchTrendyolOrders(startDate, endDate, page)
      case 'N11':
        return this.fetchN11Orders(startDate, endDate, page)
      case 'PAZARAMA':
        return this.fetchPazaramaOrders(startDate, endDate, page)
      case 'HEPSIBURADA':
        throw new OrderFetchError('Hepsiburada siparis entegrasyonu devre disi', marketplace)
    }
  }

  private extractList(data: unknown): unknown[] {
    const root = data as any
    const candidates = [
      root,
      root?.content,
      root?.data,
      root?.data?.content,
      root?.data?.items,
      root?.data?.orders,
      root?.items,
      root?.orders,
      root?.result,
      root?.result?.items,
      root?.result?.orders,
    ]

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }

  private async fetchPagedOrders(marketplace: Marketplace, startDate: Date, endDate: Date): Promise<unknown[]> {
    let page = 0
    let hasMore = true
    const rawOrders: unknown[] = []

    while (hasMore) {
      const pageOrders = await this.fetchPage(marketplace, startDate, endDate, page)
      if (!pageOrders || (pageOrders as unknown[]).length === 0) {
        hasMore = false
      } else {
        rawOrders.push(...(pageOrders as unknown[]))
        page++
        if ((pageOrders as unknown[]).length < 50) hasMore = false
      }
    }

    return rawOrders
  }

  private async fetchTrendyolOrders(startDate: Date, endDate: Date, page: number): Promise<unknown[]> {
    const apiKey = process.env.TY_API_KEY
    const apiSecret = process.env.TY_API_SECRET
    const supplierId = process.env.TY_SUPPLIER_ID
    if (!apiKey || !apiSecret || !supplierId) {
      throw new OrderFetchError('Trendyol API bilgileri eksik', 'TRENDYOL')
    }

    const response = await axios.get(`${TRENDYOL_ORDER_URL}/${supplierId}/orders`, {
      auth: { username: apiKey, password: apiSecret },
      params: {
        startDate: startDate.getTime(),
        endDate: endDate.getTime(),
        orderByField: 'PackageLastModifiedDate',
        orderByDirection: 'DESC',
        page,
        size: 50,
      },
      headers: { 'User-Agent': `PazarioIntegration - ${supplierId}` },
      timeout: 60000,
    })

    return this.extractList(response.data)
  }

  private async fetchTrendyolOrdersStream(startDate: Date, endDate: Date): Promise<unknown[]> {
    const apiKey = process.env.TY_API_KEY
    const apiSecret = process.env.TY_API_SECRET
    const supplierId = process.env.TY_SUPPLIER_ID
    if (!apiKey || !apiSecret || !supplierId) {
      throw new OrderFetchError('Trendyol API bilgileri eksik', 'TRENDYOL')
    }

    const rawOrders: unknown[] = []
    let nextCursor: string | undefined
    let hasMore = true
    let requestCount = 0

    while (hasMore) {
      const response = await axios.get(`${TRENDYOL_ORDER_URL}/${supplierId}/orders/stream`, {
        auth: { username: apiKey, password: apiSecret },
        params: {
          size: TRENDYOL_STREAM_PAGE_SIZE,
          lastModifiedStartDate: startDate.getTime(),
          lastModifiedEndDate: endDate.getTime(),
          ...(nextCursor ? { nextCursor } : {}),
        },
        headers: { 'User-Agent': `PazarioIntegration - ${supplierId}` },
        timeout: 60000,
      })

      const payload = response.data as Record<string, unknown>
      rawOrders.push(...this.extractList(payload))
      hasMore = Boolean(payload?.hasMore)
      nextCursor = typeof payload?.nextCursor === 'string' ? payload.nextCursor : undefined
      requestCount++

      if (hasMore && !nextCursor) {
        throw new OrderFetchError('Trendyol stream cevabinda hasMore=true ancak nextCursor yok', 'TRENDYOL')
      }
      if (requestCount > 500) {
        throw new OrderFetchError('Trendyol stream sayfa limiti asildi', 'TRENDYOL')
      }
      if (hasMore) await sleep(TRENDYOL_STREAM_DELAY_MS)
    }

    return rawOrders
  }

  private async fetchN11Orders(startDate: Date, endDate: Date, page: number): Promise<unknown[]> {
    const url = process.env.N11_ORDERS_URL
    const appKey = process.env.N11_APPKEY
    const appSecret = process.env.N11_APPSECRET
    if (!url) throw new OrderFetchError('N11 siparis listeleme endpointi N11_ORDERS_URL ile tanimli degil', 'N11')
    if (!appKey || !appSecret) throw new OrderFetchError('N11 API bilgileri eksik', 'N11')

    const response = await axios.get(url, {
      params: { page, size: 50, startDate: startDate.getTime(), endDate: endDate.getTime() },
      headers: { appkey: appKey, appsecret: appSecret },
      timeout: 60000,
    })
    return this.extractList(response.data)
  }

  private async getPazaramaAccessToken(): Promise<string> {
    if (this.pazaramaTokenCache && Date.now() < this.pazaramaTokenCache.expiresAt) {
      return this.pazaramaTokenCache.token
    }

    const clientId = process.env.PZ_CLIENT_ID
    const clientSecret = process.env.PZ_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new OrderFetchError('Pazarama API bilgileri eksik', 'PAZARAMA')

    const attempts: Array<Record<string, string>> = [
      { grant_type: 'client_credentialsscope', scope: 'merchantgatewayapi.fullaccess' },
      { grant_type: 'client_credentials', scope: 'merchantgatewayapi.fullaccess' },
      { grant_type: 'client_credentials' },
    ]

    let lastMessage = 'Pazarama token alinamadi'
    for (const body of attempts) {
      try {
        const response = await axios.post(PAZARAMA_TOKEN_URL, new URLSearchParams(body).toString(), {
          auth: { username: clientId, password: clientSecret },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30000,
        })
        const payload = response.data as any
        const token = payload?.access_token || payload?.accessToken || payload?.data?.access_token || payload?.data?.accessToken || payload?.data?.token
        if (token) {
          this.pazaramaTokenCache = { token, expiresAt: Date.now() + 55 * 60 * 1000 }
          return token
        }
        lastMessage = String(payload?.userMessage || payload?.message || lastMessage)
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error)
      }
    }

    throw new OrderFetchError(lastMessage, 'PAZARAMA')
  }

  private async fetchPazaramaOrders(startDate: Date, endDate: Date, page: number): Promise<unknown[]> {
    const url = process.env.PZ_ORDERS_URL
    if (!url) throw new OrderFetchError('Pazarama siparis listeleme endpointi PZ_ORDERS_URL ile tanimli degil', 'PAZARAMA')
    const token = await this.getPazaramaAccessToken()

    const response = await axios.post(url, {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      page: page + 1,
      size: 50,
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    })
    return this.extractList(response.data)
  }

  /**
   * Ham sipariş verisini normalize eder
   */
  private normalizeOrder(raw: unknown, marketplace: Marketplace): NormalizedOrder {
    const r = raw as Record<string, unknown>

    switch (marketplace) {
      case 'TRENDYOL': return this.normalizeTrendyolOrder(r)
      case 'HEPSIBURADA': return this.normalizeHepsiburadaOrder(r)
      case 'N11': return this.normalizeN11Order(r)
      case 'PAZARAMA': return this.normalizePazaramaOrder(r)
    }
  }

  private normalizeTrendyolOrder(raw: Record<string, unknown>): NormalizedOrder {
    const lines = (raw['lines'] as Record<string, unknown>[]) ?? []
    return {
      marketplace: 'TRENDYOL',
      marketplaceOrderId: String(raw['shipmentPackageId'] ?? raw['id']),
      marketplaceOrderNo: raw['orderNumber'] ? String(raw['orderNumber']) : null,
      customerName: raw['customerFirstName']
        ? `${raw['customerFirstName']} ${raw['customerLastName'] ?? ''}`.trim()
        : null,
      customerPhone: raw['customerPhone'] ? String(raw['customerPhone']) : null,
      shippingAddress: raw['shipmentAddress'] as object ?? null,
      billingAddress: raw['invoiceAddress'] as object ?? null,
      totalAmount: Number(raw['totalPrice'] ?? 0),
      currency: 'TRY',
      status: this.mapTrendyolStatus(raw['status'] ?? raw['packageStatus']),
      trackingNumber: raw['cargoTrackingNumber'] ? String(raw['cargoTrackingNumber']) : null,
      cargoCompany: raw['cargoProviderName'] ? String(raw['cargoProviderName']) : null,
      items: lines.map(l => ({
        marketplaceProductId: l['productId'] ? String(l['productId']) : null,
        sku: l['merchantSku'] ? String(l['merchantSku']) : null,
        title: String(l['productName'] ?? ''),
        quantity: Number(l['quantity'] ?? 1),
        unitPrice: Number(l['price'] ?? 0),
        totalPrice: Number(l['price'] ?? 0) * Number(l['quantity'] ?? 1),
        vatRate: Number(l['vatBaseAmount'] ?? 20),
      })),
    }
  }

  private normalizeHepsiburadaOrder(raw: Record<string, unknown>): NormalizedOrder {
    const lines = (raw['orderLines'] as Record<string, unknown>[]) ?? []
    return {
      marketplace: 'HEPSIBURADA',
      marketplaceOrderId: String(raw['id'] ?? raw['orderNumber']),
      marketplaceOrderNo: raw['orderNumber'] ? String(raw['orderNumber']) : null,
      customerName: raw['customerName'] ? String(raw['customerName']) : null,
      customerPhone: null,
      shippingAddress: raw['shippingAddress'] as object ?? null,
      billingAddress: raw['billingAddress'] as object ?? null,
      totalAmount: Number(raw['totalPrice'] ?? 0),
      currency: 'TRY',
      status: this.mapGenericStatus(raw['status']),
      items: lines.map(l => ({
        marketplaceProductId: l['productId'] ? String(l['productId']) : null,
        sku: l['merchantSku'] ? String(l['merchantSku']) : null,
        title: String(l['productName'] ?? ''),
        quantity: Number(l['quantity'] ?? 1),
        unitPrice: Number(l['price'] ?? 0),
        totalPrice: Number(l['price'] ?? 0) * Number(l['quantity'] ?? 1),
        vatRate: null,
      })),
    }
  }

  private normalizeN11Order(raw: Record<string, unknown>): NormalizedOrder {
    const items = (raw['orderItems'] as Record<string, unknown>[]) ?? []
    return {
      marketplace: 'N11',
      marketplaceOrderId: String(raw['id'] ?? raw['orderNumber']),
      marketplaceOrderNo: raw['orderNumber'] ? String(raw['orderNumber']) : null,
      customerName: raw['customerName'] ? String(raw['customerName']) : null,
      customerPhone: raw['customerPhone'] ? String(raw['customerPhone']) : null,
      shippingAddress: raw['deliveryAddress'] as object ?? null,
      billingAddress: raw['billingAddress'] as object ?? null,
      totalAmount: Number(raw['totalAmount'] ?? 0),
      currency: 'TRY',
      status: this.mapGenericStatus(raw['status'] ?? raw['orderStatus']),
      trackingNumber: raw['trackingNumber'] ? String(raw['trackingNumber']) : null,
      cargoCompany: raw['cargoCompany'] ? String(raw['cargoCompany']) : null,
      items: items.map(i => ({
        marketplaceProductId: i['productId'] ? String(i['productId']) : null,
        sku: i['sellerStockCode'] ? String(i['sellerStockCode']) : null,
        title: String(i['productName'] ?? ''),
        quantity: Number(i['quantity'] ?? 1),
        unitPrice: Number(i['unitPrice'] ?? 0),
        totalPrice: Number(i['totalAmount'] ?? 0),
        vatRate: Number(i['vatRate'] ?? 20),
      })),
    }
  }

  private normalizePazaramaOrder(raw: Record<string, unknown>): NormalizedOrder {
    const items = ((raw['items'] ?? raw['orderItems']) as Record<string, unknown>[]) ?? []
    const moneyValue = (value: unknown): number => {
      if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
        return Number((value as Record<string, unknown>)['value'] ?? 0)
      }
      return Number(value ?? 0)
    }
    return {
      marketplace: 'PAZARAMA',
      marketplaceOrderId: String(raw['orderId'] ?? raw['orderNumber'] ?? raw['id']),
      marketplaceOrderNo: raw['orderNumber'] ? String(raw['orderNumber']) : null,
      customerName: raw['customerName'] ? String(raw['customerName']) : (raw['customerFullName'] ? String(raw['customerFullName']) : null),
      customerPhone: raw['customerPhone'] ? String(raw['customerPhone']) : null,
      shippingAddress: (raw['shipmentAddress'] ?? raw['shippingAddress']) as object ?? null,
      billingAddress: raw['billingAddress'] as object ?? null,
      totalAmount: Number(raw['orderAmount'] ?? 0),
      currency: String(raw['currency'] ?? 'TRY'),
      status: this.mapGenericStatus(raw['status'] ?? raw['orderStatus']),
      trackingNumber: items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['trackingNumber'])
        ? String((items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['trackingNumber'])?.['cargo'] as Record<string, unknown>)['trackingNumber'])
        : null,
      cargoCompany: items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['companyName'])
        ? String((items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['companyName'])?.['cargo'] as Record<string, unknown>)['companyName'])
        : null,
      items: items.map(i => {
        const product = (i['product'] as Record<string, unknown>) ?? {}
        const unitPrice = moneyValue(i['salePrice'] ?? i['unitPrice'] ?? i['listPrice'])
        const totalPrice = moneyValue(i['totalPrice']) || unitPrice * Number(i['quantity'] ?? 1)
        return {
        marketplaceProductId: product['productId'] ? String(product['productId']) : (product['code'] ? String(product['code']) : null),
        sku: product['stockCode'] ? String(product['stockCode']) : (i['merchantProductCode'] ? String(i['merchantProductCode']) : null),
        title: String(product['name'] ?? product['title'] ?? i['productName'] ?? ''),
        quantity: Number(i['quantity'] ?? 1),
        unitPrice,
        totalPrice,
        vatRate: product['vatRate'] ? Number(product['vatRate']) : null,
      }}),
    }
  }

  private mapTrendyolStatus(value: unknown): OrderStatus {
    const status = normalizeStatusText(value)
    if (['DELIVERED'].includes(status)) return 'DELIVERED'
    if (['COMPLETED'].includes(status)) return 'COMPLETED'
    if (['SHIPPED'].includes(status)) return 'SHIPPED'
    if (['IN_TRANSIT', 'INTRANSIT', 'AT_COLLECTION_POINT'].includes(status)) return 'IN_TRANSIT'
    if (['UNDELIVERED', 'UN_DELIVERED', 'DELIVERY_FAILED'].includes(status)) return 'DELIVERY_FAILED'
    if (['CANCELLED', 'CANCELED'].includes(status)) return 'CANCELLED'
    if (['RETURNED', 'REFUNDED'].includes(status)) return 'REFUNDED'
    if (['RETURN_REQUESTED'].includes(status)) return 'RETURN_REQUESTED'
    if (['INVOICED'].includes(status)) return 'LABEL_CREATED'
    if (['PICKING', 'CREATED', 'READY_TO_SHIP'].includes(status)) return 'PREPARING'
    if (['AWAITING', 'WAITING', 'PENDING_APPROVAL'].includes(status)) return 'PENDING_APPROVAL'
    return 'NEW'
  }

  private mapGenericStatus(value: unknown): OrderStatus {
    const status = normalizeStatusText(value)
    if (/(TESLIM|DELIVER)/.test(status)) return 'DELIVERED'
    if (/(TAMAM|COMPLETE)/.test(status)) return 'COMPLETED'
    if (/(KARGO|SHIP)/.test(status)) return 'SHIPPED'
    if (/(YOLDA|TRANSIT)/.test(status)) return 'IN_TRANSIT'
    if (/(IPTAL|CANCEL)/.test(status)) return 'CANCELLED'
    if (/(IADE|RETURN|REFUND)/.test(status)) return 'RETURN_REQUESTED'
    if (/(HAZIR|PREPAR|PICK|APPROV)/.test(status)) return 'PREPARING'
    return 'NEW'
  }

  private normalizeSku(value: string | null): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    return trimmed.startsWith(MARKETPLACE_BARCODE_PREFIX)
      ? trimmed.slice(MARKETPLACE_BARCODE_PREFIX.length)
      : trimmed
  }

  private async findProductForOrderItem(item: NormalizedOrder['items'][number], marketplace: Marketplace) {
    const sku = this.normalizeSku(item.sku)
    const marketplaceProductId = this.normalizeSku(item.marketplaceProductId)
    const candidates = Array.from(new Set([sku, marketplaceProductId].filter(Boolean))) as string[]

    for (const value of candidates) {
      const bySkuOrBarcode = await this.prisma.product.findFirst({
        where: {
          OR: [
            { sku: value },
            { barcode: value },
            { barcode: `${MARKETPLACE_BARCODE_PREFIX}${value}` },
          ],
        },
        select: { id: true, sourceId: true, source: { select: { name: true } } },
      })
      if (bySkuOrBarcode) return bySkuOrBarcode

      const byListing = await this.prisma.marketplaceListing.findFirst({
        where: { marketplace, externalListingId: value },
        select: { productId: true, product: { select: { sourceId: true, source: { select: { name: true } } } } },
      })
      if (byListing?.productId) return { id: byListing.productId, sourceId: byListing.product.sourceId, source: byListing.product.source }
    }

    return null
  }

  private async prepareOrderItems(order: NormalizedOrder) {
    const prepared = []
    for (const item of order.items) {
      const product = await this.findProductForOrderItem(item, order.marketplace)
      prepared.push({
        marketplaceProductId: item.marketplaceProductId,
        sku: item.sku,
        title: item.title,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        shippingFee: item.shippingFee ?? 0,
        serviceFee: item.serviceFee ?? 0,
        extraFees: item.extraFees ?? 0,
        vatRate: item.vatRate,
        productId: product?.id ?? null,
        sourceId: product?.sourceId ?? null,
      })
    }
    return prepared
  }

  private async notifyNewOrder(order: NormalizedOrder): Promise<void> {
    if (!process.env.ORDER_NOTIFICATION_EMAIL) return

    try {
      const sourceNames = await Promise.all(order.items.map(async item => {
        const product = await this.findProductForOrderItem(item, order.marketplace)
        return product?.source?.name ?? null
      }))

      await this.emailService.sendNewOrderNotification({
        to: process.env.ORDER_NOTIFICATION_EMAIL,
        orderNo: order.marketplaceOrderNo || order.marketplaceOrderId,
        marketplace: order.marketplace,
        customerName: order.customerName,
        totalAmount: order.totalAmount,
        currency: order.currency,
        trackingNumber: order.trackingNumber,
        cargoCompany: order.cargoCompany,
        items: order.items.map((item, index) => ({
          title: item.title,
          quantity: item.quantity,
          totalPrice: item.totalPrice,
          sourceName: sourceNames[index],
        })),
      })
    } catch (error) {
      logger.error({ err: error, marketplace: order.marketplace, orderNo: order.marketplaceOrderNo }, 'Yeni siparis e-posta bildirimi gonderilemedi')
    }
  }

  /**
   * Siparişi DB'ye kaydeder
   * Duplikat önleme: marketplaceOrderId unique
   * KVKK: müşteri alanları AES şifreli
   */
  async createOrder(order: NormalizedOrder): Promise<boolean> {
    // Duplikat kontrol
    const existing = await this.prisma.order.findUnique({
      where: { marketplaceOrderId: order.marketplaceOrderId },
    })
    if (existing) {
      const incomingStatus = order.status
      const nextStatus = shouldApplyExternalStatus(existing.status, incomingStatus)
        ? incomingStatus
        : existing.status

      await this.prisma.$transaction(async tx => {
        await tx.order.update({
          where: { id: existing.id },
          data: {
            status: nextStatus,
            totalAmount: order.totalAmount,
            currency: order.currency,
            cargoCompany: order.cargoCompany ?? existing.cargoCompany,
            trackingNumber: order.trackingNumber ?? existing.trackingNumber,
            fetchedAt: new Date(),
          },
        })

        if (nextStatus !== existing.status) {
          await tx.orderStatusLog.create({
            data: {
              orderId: existing.id,
              fromStatus: existing.status,
              toStatus: nextStatus,
              changedBy: 'marketplace-sync',
              note: `${order.marketplace} siparis durum senkronizasyonu`,
            },
          })
        }
      })
      return false
    }

    // KVKK şifreleme
    const encryptField = (val: string | null) =>
      val ? encrypt(val, this.encryptionKey) : null

    const items = await this.prepareOrderItems(order)

    await this.prisma.order.create({
      data: {
        marketplace: order.marketplace,
        marketplaceOrderId: order.marketplaceOrderId,
        marketplaceOrderNo: order.marketplaceOrderNo,
        status: order.status,
        customerName: encryptField(order.customerName),
        customerPhone: encryptField(order.customerPhone),
        shippingAddress: order.shippingAddress
          ? encrypt(JSON.stringify(order.shippingAddress), this.encryptionKey)
          : Prisma.JsonNull,
        billingAddress: order.billingAddress
          ? encrypt(JSON.stringify(order.billingAddress), this.encryptionKey)
          : Prisma.JsonNull,
        totalAmount: order.totalAmount,
        currency: order.currency,
        cargoCompany: order.cargoCompany ?? null,
        trackingNumber: order.trackingNumber ?? null,
        fetchedAt: new Date(),
        items: {
          create: items,
        },
      },
    })

    await this.notifyNewOrder(order)

    return true
  }

  /**
   * Şifrelenmiş müşteri bilgilerini çözer
   */
  decryptOrderFields(order: {
    customerName: string | null
    customerPhone: string | null
    shippingAddress: unknown
    billingAddress: unknown
  }) {
    return {
      customerName: order.customerName
        ? decrypt(order.customerName, this.encryptionKey)
        : null,
      customerPhone: order.customerPhone
        ? decrypt(order.customerPhone, this.encryptionKey)
        : null,
      shippingAddress: order.shippingAddress
        ? JSON.parse(decrypt(typeof order.shippingAddress === 'string' ? order.shippingAddress : JSON.stringify(order.shippingAddress), this.encryptionKey))
        : null,
      billingAddress: order.billingAddress
        ? JSON.parse(decrypt(typeof order.billingAddress === 'string' ? order.billingAddress : JSON.stringify(order.billingAddress), this.encryptionKey))
        : null,
    }
  }
}

function normalizeStatusText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleUpperCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function statusRank(status: OrderStatus): number {
  const ranks: Record<OrderStatus, number> = {
    NEW: 0,
    PENDING_APPROVAL: 1,
    PREPARING: 2,
    LABEL_CREATED: 3,
    SHIPPED: 4,
    IN_TRANSIT: 5,
    DELIVERED: 6,
    COMPLETED: 7,
    DELIVERY_FAILED: 6,
    CANCELLATION_REQUESTED: 6,
    CANCELLED: 7,
    RETURN_REQUESTED: 8,
    RETURN_APPROVED: 9,
    RETURN_REJECTED: 10,
    REFUNDED: 11,
  }
  return ranks[status] ?? 0
}

function shouldApplyExternalStatus(current: OrderStatus, incoming: OrderStatus): boolean {
  if (current === incoming) return false
  if (['CANCELLED', 'REFUNDED', 'RETURN_REQUESTED', 'RETURN_APPROVED', 'RETURN_REJECTED'].includes(incoming)) return true
  if (['CANCELLED', 'REFUNDED'].includes(current)) return false
  return statusRank(incoming) >= statusRank(current)
}
