// src/services/OrderFetchService.ts

import { OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import axios from 'axios'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { EmailService } from './EmailService'
import { logger } from '../utils/logger'
import { decryptJson } from './FieldEncryptionService'
import { hepsiburadaOrderApiUrl, hepsiburadaUserAgent } from '../config/hepsiburada'
import { OrderStateMachine } from './OrderStateMachine'
import { syncOrderItemsPreservingFinance } from './OrderItemSyncService'

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
  orderedAt: Date | null
  cargoCompany?: string | null
  trackingNumber?: string | null
  items: {
    marketplaceProductId: string | null
    sku: string | null
    title: string
    quantity: number
    unitPrice: number
    totalPrice: number
    discountAmount?: number
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
const OPEN_ORDER_REFRESH_DAYS = Number(process.env.ORDER_OPEN_REFRESH_DAYS || '30')
const OPEN_ORDER_STATUSES: OrderStatus[] = [
  'NEW',
  'PENDING_APPROVAL',
  'PREPARING',
  'LABEL_CREATED',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERY_FAILED',
  'CANCELLATION_REQUESTED',
  'RETURN_REQUESTED',
  'RETURN_APPROVED',
  'RETURN_REJECTED',
]
const MARKETPLACE_BARCODE_PREFIX = 'BRS'
const TRENDYOL_ORDER_URL = 'https://apigw.trendyol.com/integration/order/sellers'
const N11_ORDERS_URL = 'https://api.n11.com/rest/delivery/v1/shipmentPackages'
const PAZARAMA_TOKEN_URL = 'https://isortagimgiris.pazarama.com/connect/token'
const PAZARAMA_ORDERS_URL = 'https://isortagimapi.pazarama.com/order/getOrdersForApi'
const TRENDYOL_STREAM_PAGE_SIZE = 200
const TRENDYOL_STREAM_DELAY_MS = 5000

export interface PazaramaOrderRequest {
  pageSize: number
  pageNumber: number
  startDate: string
  endDate: string
}

function formatIstanbulMinute(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? ''

  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

export function buildPazaramaOrderRequest(
  startDate: Date,
  endDate: Date,
  page: number,
  pageSize = 50
): PazaramaOrderRequest {
  // Pazarama endDate'i dislayici yorumlar. Bir dakika eklemek ayni dakika
  // icinde olusan siparislerin bir sonraki cekime kalmasini engeller.
  const inclusiveEndDate = new Date(endDate.getTime() + 60 * 1000)
  return {
    pageSize,
    pageNumber: page + 1,
    startDate: formatIstanbulMinute(startDate),
    endDate: formatIstanbulMinute(inclusiveEndDate),
  }
}

type MarketplaceCredentialValues = Record<string, string>

function cleanCredential(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text) return text
  }
  return null
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (value === null || value === undefined || value === '') continue
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      const nested = Number(record.amount ?? record.value)
      if (Number.isFinite(nested)) return nested
    }
    const numberValue = Number(value)
    if (Number.isFinite(numberValue)) return numberValue
  }
  return 0
}

function roundedMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100
}

export function resolveMarketplaceDiscount(
  source: Record<string, unknown>,
  componentKeys: string[] = []
): number {
  const total = firstNumber(source, ['totalDiscount', 'totalDiscountAmount', 'discountAmount'])
  if (total > 0) return roundedMoney(total)

  const componentTotal = componentKeys.reduce((sum, key) => sum + firstNumber(source, [key]), 0)
  if (componentTotal > 0) return roundedMoney(componentTotal)

  const details = firstList(source, ['discountDetails', 'discounts', 'campaignDiscounts', 'promotions'])
  return roundedMoney(details.reduce((sum, detail) => {
    const detailTotal = firstNumber(detail, ['totalDiscount', 'discountAmount', 'lineItemDiscount'])
    if (detailTotal > 0) return sum + detailTotal
    const namedComponents = componentKeys.reduce((part, key) => part + firstNumber(detail, [key]), 0)
    const lineComponents = firstNumber(detail, ['lineItemDiscount']) + firstNumber(detail, ['lineItemTyDiscount'])
    return sum + namedComponents + lineComponents
  }, 0))
}

export function hepsiburadaMoneyValue(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const nested = Number(record.amount ?? record.value)
    return Number.isFinite(nested) ? nested : 0
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function firstDate(source: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const value = source[key]
    if (value === null || value === undefined || value === '') continue
    const numericValue = typeof value === 'number' ? value : Number(value)
    const date = Number.isFinite(numericValue) && String(value).trim() !== ''
      ? new Date(numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue)
      : new Date(String(value))
    if (!Number.isNaN(date.getTime())) return date
  }
  return null
}

function firstList(source: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) return value as Record<string, unknown>[]
  }
  return []
}

export function resolveHepsiburadaOrderNumber(source: Record<string, unknown>): string | null {
  const direct = firstString(source, ['orderNumber', 'OrderNumber'])
  if (direct) return direct

  const items = firstList(source, ['items', 'Items', 'orderItems', 'orderLines', 'lineItems'])
  for (const item of items) {
    const nested = firstString(item, ['orderNumber', 'OrderNumber'])
    if (nested) return nested
  }

  return null
}

export function hepsiburadaPackageTimespanHours(startDate: Date, endDate: Date): number {
  const elapsedHours = Math.ceil(Math.max(0, endDate.getTime() - startDate.getTime()) / (60 * 60 * 1000))
  return Math.min(Math.max(elapsedHours, 24), Math.max(OPEN_ORDER_REFRESH_DAYS, 1) * 24)
}

export function mergeHepsiburadaOrders(values: unknown[]): unknown[] {
  const packages = new Map<string, Record<string, unknown>>()
  const orders = new Map<string, Record<string, unknown>>()
  const packagedOrderNumbers = new Set<string>()

  for (const value of values) {
    const rawCurrent = value as Record<string, unknown>
    const orderNumber = resolveHepsiburadaOrderNumber(rawCurrent)
    const current = orderNumber && !firstString(rawCurrent, ['orderNumber', 'OrderNumber'])
      ? { ...rawCurrent, orderNumber }
      : rawCurrent
    const packageNumber = firstString(current, ['packageNumber', 'PackageNumber'])
    if (packageNumber) {
      packages.set(packageNumber, current)
      if (orderNumber) packagedOrderNumbers.add(orderNumber)
      continue
    }

    const key = orderNumber ?? firstString(current, ['id'])
    if (!key) continue

    const previous = orders.get(key)
    if (!previous) {
      orders.set(key, current)
      continue
    }

    const previousItems = firstList(previous, ['items', 'orderItems', 'orderLines', 'lineItems'])
    const currentItems = firstList(current, ['items', 'orderItems', 'orderLines', 'lineItems'])
    const allItems = [
      ...(previousItems.length > 0 ? previousItems : [previous]),
      ...(currentItems.length > 0 ? currentItems : [current]),
    ]
    const uniqueItems = new Map<string, Record<string, unknown>>()
    allItems.forEach((item, index) => {
      const itemKey = firstString(item, ['id', 'lineItemId', 'merchantSku', 'merchantSKU', 'sku']) ?? String(index)
      uniqueItems.set(itemKey, item)
    })

    orders.set(key, { ...previous, ...current, items: Array.from(uniqueItems.values()) })
  }

  // Paket cevabı aynı siparişin güncel halidir. Açık sipariş kaydını ayrıca döndürmek
  // mükerrer finans satırı oluşturur; farklı paket numaraları ise ayrı kalmalıdır.
  const unpackagedOrders = Array.from(orders.entries())
    .filter(([orderNumber]) => !packagedOrderNumbers.has(orderNumber))
    .map(([, order]) => order)

  const enrichedPackages = Array.from(packages.values()).map(current => {
    const orderNumber = resolveHepsiburadaOrderNumber(current)
    const paidOrder = orderNumber ? orders.get(orderNumber) : undefined
    if (!paidOrder) return current
    return {
      ...paidOrder,
      ...current,
      billingAddress: current.billingAddress ?? paidOrder.billingAddress ?? null,
      shippingAddress: current.shippingAddress ?? paidOrder.shippingAddress ?? null,
      customerName: current.customerName ?? paidOrder.customerName ?? null,
      recipientName: current.recipientName ?? paidOrder.recipientName ?? null,
    }
  })

  return [...enrichedPackages, ...unpackagedOrders]
}

function localizedNumber(value: string): number {
  const raw = value.trim().replace(/\s/g, '')
  if (!raw) return 0
  const comma = raw.lastIndexOf(',')
  const dot = raw.lastIndexOf('.')
  const normalized = comma > dot
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '')
  const numberValue = Number(normalized)
  return Number.isFinite(numberValue) ? numberValue : 0
}

export function parsePazaramaDiscountDescription(value: unknown): number {
  const text = String(value ?? '')
  let total = 0
  for (const match of text.matchAll(/-\s*([\d.,]+)\s*TL/gi)) {
    total += localizedNumber(match[1])
  }
  return Math.round(total * 100) / 100
}

function pazaramaStatusFromValue(value: unknown): OrderStatus {
  const status = normalizeStatusText(value)
  if (/(TESLIM|DELIVER)/.test(status) || status === '11') return 'DELIVERED'
  if (/(TAMAM|COMPLETE)/.test(status)) return 'COMPLETED'
  if (/(KARGO|SHIP)/.test(status) || status === '5') return 'SHIPPED'
  if (/(YOLDA|TRANSIT)/.test(status)) return 'IN_TRANSIT'
  if (/(IPTAL|CANCEL)/.test(status)) return 'CANCELLED'
  if (/(IADE|RETURN|REFUND)/.test(status)) return 'RETURN_REQUESTED'
  if (/(HAZIR|PREPAR|PICK|APPROV)/.test(status) || status === '12') return 'PREPARING'
  return 'NEW'
}

export function resolvePazaramaOrderStatus(raw: Record<string, unknown>, items: Record<string, unknown>[]): OrderStatus {
  const itemStatuses = items.map(item => pazaramaStatusFromValue(item['orderItemStatusName'] ?? item['orderItemStatus']))
  if (itemStatuses.length === 0) {
    return pazaramaStatusFromValue(raw['orderStatusName'] ?? raw['status'] ?? raw['orderStatus'])
  }
  return itemStatuses.reduce((leastAdvanced, status) =>
    statusRank(status) < statusRank(leastAdvanced) ? status : leastAdvanced
  )
}

export function resolveHepsiburadaStatus(value: unknown, isPackage = false): OrderStatus {
  const status = normalizeStatusText(value)
  if (status === 'UNPACKED') return 'NEW'
  if (status === 'OPEN') return isPackage ? 'PREPARING' : 'NEW'
  if (['PACKAGED', 'PACKAGE', 'READY_TO_SHIP', 'READYTOSHIP'].includes(status)) return 'PREPARING'
  if (['INVOICED', 'LABEL_CREATED'].includes(status)) return 'LABEL_CREATED'
  if (status === 'SHIPPED') return 'SHIPPED'
  if (['INTRANSIT', 'IN_TRANSIT'].includes(status)) return 'IN_TRANSIT'
  if (status === 'DELIVERED') return 'DELIVERED'
  if (status === 'COMPLETED') return 'COMPLETED'
  if (['CANCELLED', 'CANCELED', 'CANCELLEDBYMERCHANT', 'CANCELLEDBYCUSTOMER', 'CANCELLEDBYSAP'].includes(status)) return 'CANCELLED'
  if (['RETURNED', 'REFUNDED'].includes(status)) return 'REFUNDED'
  if (['RETURN_REQUESTED', 'CLAIMCREATED'].includes(status)) return 'RETURN_REQUESTED'
  return 'NEW'
}

function deriveEncryptionKey(rawKey: string): Buffer {
  const trimmed = rawKey.trim()
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  return createHash('sha256').update(trimmed).digest()
}

// ─── ŞİFRELEME YARDIMCIları ──────────────────────────────────────────────────

/**
 * AES-256-GCM ile şifreler — KVKK uyumu
 */
function encrypt(text: string, keyHex: string): string {
  const key = deriveEncryptionKey(keyHex)
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
  const key = deriveEncryptionKey(keyHex)
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
  private readonly orderStateMachine: OrderStateMachine
  private pazaramaTokenCache: { token: string; expiresAt: number } | null = null

  constructor(private readonly prisma: PrismaClient) {
    const key = process.env.FIELD_ENCRYPTION_KEY
    if (!key) throw new Error('FIELD_ENCRYPTION_KEY tanımlı değil')
    this.encryptionKey = key
    this.orderStateMachine = new OrderStateMachine(prisma)
  }

  private async activeMarketplaceCredentials(marketplace: Marketplace): Promise<MarketplaceCredentialValues> {
    const record = await this.prisma.marketplaceCredential.findUnique({ where: { marketplace } })
    if (!record?.isActive) return {}
    return decryptJson(record.credentialsEncrypted)
  }

  private async trendyolApiCredentials() {
    const credentials = await this.activeMarketplaceCredentials('TRENDYOL')
    return {
      supplierId: cleanCredential(credentials.supplierId || process.env.TY_SUPPLIER_ID),
      apiKey: cleanCredential(credentials.apiKey || process.env.TY_API_KEY),
      apiSecret: cleanCredential(credentials.apiSecret || process.env.TY_API_SECRET),
    }
  }

  private async n11ApiCredentials() {
    const credentials = await this.activeMarketplaceCredentials('N11')
    return {
      appKey: cleanCredential(credentials.appKey || process.env.N11_APPKEY),
      appSecret: cleanCredential(credentials.appSecret || process.env.N11_APPSECRET),
    }
  }

  private async pazaramaApiCredentials() {
    const credentials = await this.activeMarketplaceCredentials('PAZARAMA')
    return {
      clientId: cleanCredential(credentials.clientId || process.env.PZ_CLIENT_ID),
      clientSecret: cleanCredential(credentials.clientSecret || process.env.PZ_CLIENT_SECRET),
    }
  }

  private async hepsiburadaApiCredentials() {
    const credentials = await this.activeMarketplaceCredentials('HEPSIBURADA')
    const merchantId = cleanCredential(credentials.merchantId || process.env.HB_MERCHANT_ID)
    const serviceKey = cleanCredential(credentials.serviceKey || process.env.HB_SERVICE_KEY)
    return {
      merchantId,
      username: merchantId,
      password: cleanCredential(serviceKey || credentials.password || process.env.HB_PASSWORD),
      userAgent: cleanCredential(credentials.userAgent || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME),
    }
  }

  /**
   * Tüm pazaryerlerinden sipariş çeker
   * Promise.allSettled — bir hata diğerlerini durdurmaz
   */
  async fetchAll(): Promise<FetchSummary> {
    const startTime = Date.now()
    const marketplaces: Marketplace[] = ['TRENDYOL', 'N11', 'PAZARAMA', 'HEPSIBURADA']

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
  async fetchFromMarketplace(
    marketplace: Marketplace,
    options: { notifyNewOrders?: boolean } = {},
  ): Promise<FetchSummaryItem> {
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
      const incrementalStartDate = lastLog?.lastFetchedAt
        ? new Date(lastLog.lastFetchedAt.getTime() - Math.max(FETCH_OVERLAP_HOURS, 1) * 60 * 60 * 1000)
        : new Date(Date.now() - INITIAL_FETCH_DAYS * 24 * 60 * 60 * 1000)
      const startDate = await this.orderFetchStartDate(marketplace, incrementalStartDate, endDate)

      // Sayfalı çekme
      const rawOrders = marketplace === 'TRENDYOL'
        ? await this.fetchTrendyolOrdersStream(startDate, endDate)
        : marketplace === 'HEPSIBURADA'
          ? await this.fetchHepsiburadaOrdersStream(startDate, endDate)
          : await this.fetchPagedOrders(marketplace, startDate, endDate)

      fetched = rawOrders.length

      // Her siparişi normalize et ve kaydet
      for (const raw of rawOrders) {
        try {
          const normalized = this.normalizeOrder(raw, marketplace)
          const isNew = await this.createOrder(normalized, options.notifyNewOrders ?? true)
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

  async refreshPazaramaOrderByNumber(orderNumber: string, startDate: Date, endDate: Date): Promise<boolean> {
    for (let page = 0; page < 20; page += 1) {
      const orders = await this.fetchPazaramaOrders(startDate, endDate, page)
      const raw = orders.find(value => {
        const order = value as Record<string, unknown>
        return String(order['orderNumber'] ?? order['orderId'] ?? order['id']) === orderNumber
      })
      if (raw) {
        await this.createOrder(this.normalizePazaramaOrder(raw as Record<string, unknown>))
        return true
      }
      if (orders.length < 50) break
    }
    return false
  }

  private async orderFetchStartDate(marketplace: Marketplace, incrementalStartDate: Date, endDate: Date): Promise<Date> {
    const oldestOpenOrder = await this.prisma.order.findFirst({
      where: {
        marketplace,
        status: { in: OPEN_ORDER_STATUSES },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })

    if (!oldestOpenOrder) return incrementalStartDate

    const maxLookbackStart = new Date(endDate.getTime() - Math.max(OPEN_ORDER_REFRESH_DAYS, 1) * 24 * 60 * 60 * 1000)
    const oldestOpenStart = new Date(oldestOpenOrder.createdAt.getTime() - 24 * 60 * 60 * 1000)
    const boundedOpenStart = oldestOpenStart < maxLookbackStart ? maxLookbackStart : oldestOpenStart

    return boundedOpenStart < incrementalStartDate ? boundedOpenStart : incrementalStartDate
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
        return this.fetchHepsiburadaOrders(startDate, endDate, page)
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
    const { apiKey, apiSecret, supplierId } = await this.trendyolApiCredentials()
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
    const { apiKey, apiSecret, supplierId } = await this.trendyolApiCredentials()
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
    const url = cleanCredential(process.env.N11_ORDERS_URL) || N11_ORDERS_URL
    const { appKey, appSecret } = await this.n11ApiCredentials()
    if (!appKey || !appSecret) throw new OrderFetchError('N11 API bilgileri eksik', 'N11')

    const response = await axios.get(url, {
      params: {
        page,
        size: 50,
        startDate: startDate.getTime(),
        endDate: endDate.getTime(),
        orderByField: true,
        orderByDirection: 'DESC',
      },
      headers: { appkey: appKey, appsecret: appSecret },
      timeout: 60000,
    })
    return this.extractList(response.data)
  }

  private async getPazaramaAccessToken(): Promise<string> {
    if (this.pazaramaTokenCache && Date.now() < this.pazaramaTokenCache.expiresAt) {
      return this.pazaramaTokenCache.token
    }

    const { clientId, clientSecret } = await this.pazaramaApiCredentials()
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
    const url = cleanCredential(process.env.PZ_ORDERS_URL) || PAZARAMA_ORDERS_URL
    const token = await this.getPazaramaAccessToken()

    const response = await axios.post(url, buildPazaramaOrderRequest(startDate, endDate, page), {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    })
    return this.extractList(response.data)
  }

  private async fetchHepsiburadaOrders(startDate: Date, endDate: Date, page: number): Promise<unknown[]> {
    const { merchantId, username, password, userAgent } = await this.hepsiburadaApiCredentials()
    if (!merchantId || !username || !password || !userAgent) {
      throw new OrderFetchError('Hepsiburada API bilgileri eksik', 'HEPSIBURADA')
    }

    const limit = 50
    const response = await axios.get(hepsiburadaOrderApiUrl(`/orders/merchantid/${encodeURIComponent(merchantId)}`), {
      auth: { username, password },
      params: {
        offset: page * limit,
        limit,
      },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': hepsiburadaUserAgent(userAgent),
      },
      timeout: 60000,
    })

    return this.extractList(response.data)
  }

  private async fetchHepsiburadaOrdersStream(startDate: Date, endDate: Date): Promise<unknown[]> {
    const { merchantId, username, password, userAgent } = await this.hepsiburadaApiCredentials()
    if (!merchantId || !username || !password || !userAgent) {
      throw new OrderFetchError('Hepsiburada API bilgileri eksik', 'HEPSIBURADA')
    }

    const authConfig = {
      auth: { username, password },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': hepsiburadaUserAgent(userAgent),
      },
      timeout: 60000,
    }
    const results: unknown[] = []

    // Bu endpoint yalnızca henüz paketlenmemiş Open/Unpacked kalemleri döndürür.
    for (let page = 0; page < 100; page += 1) {
      const pageItems = await this.fetchHepsiburadaOrders(startDate, endDate, page)
      results.push(...pageItems)
      if (pageItems.length < 50) break
    }

    // Otomatik paketleme açık mağazalarda siparişler yukarıdaki listeden hızla çıkar.
    // Canlı OMS tarih aralığına boş cevap verebildiği için resmi son-24-saat parametresi kullanılır.
    const packageLimit = 10
    const packageTimespan = hepsiburadaPackageTimespanHours(startDate, endDate)
    for (let page = 0; page < 500; page += 1) {
      const response = await axios.get(
        hepsiburadaOrderApiUrl(`/packages/merchantid/${encodeURIComponent(merchantId)}`),
        {
          ...authConfig,
          params: {
            offset: page * packageLimit,
            limit: packageLimit,
            timespan: packageTimespan,
          },
        }
      )
      const packages = this.extractList(response.data)
      results.push(...packages)
      if (packages.length < packageLimit) break
    }

    // Paketler kargoya verildiğinde veya teslim edildiğinde aktif paket listesinden
    // hızla çıkar. Bu akışlar okunmazsa başarılı fetch kaydına rağmen sipariş atlanır.
    const packageStatusPaths = ['shipped', 'delivered', 'undelivered'] as const
    const statusPageLimit = 50
    const statusTimespan = Math.min(packageTimespan, 7 * 24)
    const detailCache = new Map<string, Record<string, unknown>>()
    for (const status of packageStatusPaths) {
      for (let page = 0; page < 100; page += 1) {
        try {
          const response = await axios.get(
            hepsiburadaOrderApiUrl(`/packages/merchantid/${encodeURIComponent(merchantId)}/${status}`),
            {
              ...authConfig,
              params: {
                offset: page * statusPageLimit,
                limit: statusPageLimit,
                timespan: statusTimespan,
              },
            }
          )
          const packages = this.extractList(response.data)
          for (const packageValue of packages) {
            const rawPackage = packageValue as Record<string, unknown>
            const packageNumber = firstString(rawPackage, ['packageNumber', 'PackageNumber'])
            const orderNumber = resolveHepsiburadaOrderNumber(rawPackage)
            const canonicalPackage = {
              ...rawPackage,
              ...(packageNumber ? { packageNumber } : {}),
              ...(orderNumber ? { orderNumber } : {}),
              status: firstString(rawPackage, ['status', 'Status'])
                ?? (status === 'shipped' ? 'Shipped' : status === 'delivered' ? 'Delivered' : 'Undelivered'),
              barcode: firstString(rawPackage, ['barcode', 'Barcode']),
            }

            if (!orderNumber) {
              results.push(canonicalPackage)
              continue
            }

            try {
              let detail = detailCache.get(orderNumber)
              if (!detail) {
                const detailResponse = await axios.get(
                  hepsiburadaOrderApiUrl(
                    `/orders/merchantid/${encodeURIComponent(merchantId)}/ordernumber/${encodeURIComponent(orderNumber)}`
                  ),
                  authConfig
                )
                const detailRoot = detailResponse.data as Record<string, unknown> | Record<string, unknown>[]
                detail = Array.isArray(detailRoot)
                  ? { items: detailRoot }
                  : (detailRoot.data && typeof detailRoot.data === 'object' && !Array.isArray(detailRoot.data))
                    ? detailRoot.data as Record<string, unknown>
                    : detailRoot
                detailCache.set(orderNumber, detail)
              }
              results.push({
                ...detail,
                ...canonicalPackage,
                items: firstList(detail, ['items', 'Items', 'orderItems', 'orderLines', 'lineItems']),
                packageNumber,
                orderNumber,
              })
            } catch (error) {
              logger.warn(
                { err: error, marketplace: 'HEPSIBURADA', orderNumber, packageNumber },
                'Hepsiburada siparis detayi okunamadi'
              )
              results.push(canonicalPackage)
            }
          }
          if (packages.length < statusPageLimit) break
        } catch (error) {
          logger.warn(
            {
              err: error,
              marketplace: 'HEPSIBURADA',
              packageStatus: status,
            },
            'Hepsiburada paket durum akisi okunamadi'
          )
          break
        }
      }
    }

    return mergeHepsiburadaOrders(results)
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
    const normalizedItems = lines.map(l => {
      const quantity = firstNumber(l, ['quantity']) || 1
      const netUnitPrice = firstNumber(l, ['price', 'unitPrice'])
      const totalPrice = firstNumber(l, ['amount', 'totalPrice', 'lineTotal']) || netUnitPrice * quantity
      const discountAmount = resolveMarketplaceDiscount(l, ['discount', 'tyDiscount', 'merchantDiscount', 'platformDiscount', 'campaignDiscount'])
      const unitPrice = firstNumber(l, ['listPrice', 'originalPrice']) || roundedMoney((totalPrice + discountAmount) / quantity)
      return {
        marketplaceProductId: l['productId'] ? String(l['productId']) : null,
        sku: l['merchantSku'] ? String(l['merchantSku']) : null,
        title: String(l['productName'] ?? ''), quantity, unitPrice, totalPrice, discountAmount,
        vatRate: Number(l['vatBaseAmount'] ?? 20),
      }
    })
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
      orderedAt: firstDate(raw, ['orderDate', 'packageCreationDate', 'createdDate', 'createdAt']),
      trackingNumber: raw['cargoTrackingNumber'] ? String(raw['cargoTrackingNumber']) : null,
      cargoCompany: raw['cargoProviderName'] ? String(raw['cargoProviderName']) : null,
      items: normalizedItems,
    }
  }

  private normalizeHepsiburadaOrder(raw: Record<string, unknown>): NormalizedOrder {
    const lines = firstList(raw, ['orderLines', 'items', 'Items', 'lineItems', 'orderItems'])
    const shippingAddress = (raw['shippingAddress'] ?? raw['deliveryAddress']) as Record<string, unknown> | undefined
    const invoice = raw['invoice'] as Record<string, unknown> | undefined
    const billingAddress = (raw['billingAddress'] ?? invoice?.['address']) as Record<string, unknown> | undefined
    const normalizedItems = (lines.length > 0 ? lines : [raw]).map(l => {
      const quantity = firstNumber(l, ['quantity', 'count']) || 1
      const netUnitPrice = firstNumber(l, ['unitPrice', 'price', 'hbUnitPrice', 'merchantUnitPrice', 'totalPrice'])
      const totalPrice = firstNumber(l, ['totalPrice', 'amount', 'lineTotal']) || netUnitPrice * quantity
      const explicitDiscount = ['merchantDiscount', 'campaignDiscount', 'hbDiscount', 'platformDiscount', 'sellerDiscount']
        .reduce((sum, key) => {
          const value = l[key]
          if (!value || typeof value !== 'object') return sum + firstNumber(l, [key])
          const record = value as Record<string, unknown>
          return sum + hepsiburadaMoneyValue(record.totalPrice ?? record.unitPrice ?? record)
        }, 0)
      const discountAmount = roundedMoney(
        explicitDiscount || Math.max(0, netUnitPrice * quantity - totalPrice)
      )
      const unitPrice = firstNumber(l, ['listPrice', 'originalPrice'])
        || roundedMoney((totalPrice + discountAmount) / quantity)
      return {
        marketplaceProductId: firstString(l, ['sku', 'hbSku', 'hepsiburadaSku', 'productId']),
        sku: firstString(l, ['merchantSku', 'merchantSKU', 'stockCode']),
        title: firstString(l, ['name', 'productName', 'title']) ?? '',
        quantity,
        unitPrice,
        totalPrice,
        discountAmount,
        vatRate: firstNumber(l, ['vatRate', 'taxVatRate']) || null,
      }
    })
    const itemTotal = normalizedItems.reduce((sum, item) => sum + item.totalPrice, 0)
    const customer = raw['customer'] as Record<string, unknown> | undefined
    const recipientName = firstString(raw, ['recipientName', 'customerName'])
      ?? (customer ? firstString(customer, ['name', 'fullName', 'customerName']) : null)
      ?? firstString(lines[0] ?? {}, ['customerName', 'recipientName'])
      ?? (shippingAddress ? firstString(shippingAddress, ['recipientName', 'name', 'fullName']) : null)
    const packageNumber = firstString(raw, ['packageNumber', 'PackageNumber'])
    return {
      marketplace: 'HEPSIBURADA',
      // Paket numarası pazaryeri kaydının tekil kimliğidir; sipariş numarası ayrıca gösterilir.
      marketplaceOrderId: String(packageNumber ?? raw['orderNumber'] ?? raw['OrderNumber'] ?? raw['id'] ?? raw['Id']),
      marketplaceOrderNo: resolveHepsiburadaOrderNumber(raw),
      customerName: recipientName,
      customerPhone: firstString(raw, ['phoneNumber', 'customerPhone', 'phone'])
        ?? (shippingAddress ? firstString(shippingAddress, ['phoneNumber', 'phone']) : null),
      shippingAddress: (shippingAddress ?? raw['shippingAddressDetail'] ?? null) as object | null,
      billingAddress: (raw['billingAddress'] ?? billingAddress ?? null) as object | null,
      totalAmount: firstNumber(raw, ['totalPrice', 'totalAmount', 'orderAmount']) || itemTotal,
      currency: 'TRY',
      status: this.mapHepsiburadaStatus(raw['status'] ?? raw['Status'], Boolean(packageNumber)),
      orderedAt: firstDate(raw, ['orderDate', 'OrderDate', 'purchaseDate', 'createdDate', 'createdAt', 'packageDate']),
      trackingNumber: firstString(raw, ['barcode', 'Barcode', 'trackingInfoCode', 'trackingNumber']),
      cargoCompany: firstString(raw, ['cargoCompany', 'cargoCompanyName'])
        ?? firstString(lines[0] ?? {}, ['cargoCompany', 'cargoCompanyName']),
      items: normalizedItems,
    }
  }

  private normalizeN11Order(raw: Record<string, unknown>): NormalizedOrder {
    const items = firstList(raw, ['orderItems', 'items', 'lines', 'shipmentPackageItems', 'products'])
    const customer = (raw['customer'] ?? raw['buyer'] ?? raw['recipient']) as Record<string, unknown> | undefined
    const customerName = firstString(raw, ['customerName', 'buyerName', 'recipientName', 'fullName', 'customerFullName'])
      ?? (customer ? firstString(customer, ['name', 'fullName', 'customerName']) : null)
    const customerPhone = firstString(raw, ['customerPhone', 'phone', 'gsm', 'mobilePhone'])
      ?? (customer ? firstString(customer, ['phone', 'gsm', 'mobilePhone']) : null)
    const normalizedItems = items.map(i => {
      const product = (i['product'] ?? i['productInfo']) as Record<string, unknown> | undefined
      const quantity = firstNumber(i, ['quantity', 'count', 'piece']) || 1
      const netUnitPrice = firstNumber(i, ['unitPrice', 'price', 'salePrice', 'productPrice', 'sellerPrice'])
      const totalPrice = firstNumber(i, ['totalPrice', 'lineTotal', 'amount', 'totalAmount']) || netUnitPrice * quantity
      const discountAmount = resolveMarketplaceDiscount(i, ['sellerDiscount', 'platformDiscount', 'campaignDiscount', 'n11Discount', 'couponDiscount'])
      const unitPrice = firstNumber(i, ['listPrice', 'originalPrice']) || roundedMoney((totalPrice + discountAmount) / quantity)
      return {
        marketplaceProductId: firstString(i, ['productId', 'productCode', 'n11ProductId'])
          ?? (product ? firstString(product, ['id', 'productId', 'productCode']) : null),
        sku: firstString(i, ['sellerStockCode', 'sellerSku', 'stockCode', 'sku', 'merchantSku']),
        title: firstString(i, ['productName', 'title', 'name'])
          ?? (product ? firstString(product, ['name', 'title', 'productName']) : null)
          ?? '',
        quantity,
        unitPrice,
        totalPrice,
        discountAmount,
        vatRate: firstNumber(i, ['vatRate', 'vat']) || 20,
      }
    })
    const itemTotal = normalizedItems.reduce((sum, item) => sum + item.totalPrice, 0)
    return {
      marketplace: 'N11',
      marketplaceOrderId: String(raw['id'] ?? raw['orderId'] ?? raw['orderNumber'] ?? raw['packageId']),
      marketplaceOrderNo: firstString(raw, ['orderNumber', 'orderNo']),
      customerName,
      customerPhone,
      shippingAddress: (raw['deliveryAddress'] ?? raw['shippingAddress'] ?? raw['shipmentAddress']) as object ?? null,
      billingAddress: raw['billingAddress'] as object ?? null,
      totalAmount: itemTotal || firstNumber(raw, ['totalPrice', 'orderAmount', 'amount', 'price', 'totalAmount']),
      currency: 'TRY',
      status: this.mapN11Status(raw),
      orderedAt: firstDate(raw, ['orderDate', 'createdDate', 'createDate', 'createdAt'])
        ?? firstDate((firstList(raw, ['packageHistories'])[0] ?? {}), ['createdDate']),
      trackingNumber: firstString(raw, ['trackingNumber', 'cargoTrackingNumber', 'shipmentTrackingNumber']),
      cargoCompany: firstString(raw, ['cargoCompany', 'cargoCompanyName', 'shipmentCompany']),
      items: normalizedItems,
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
    const grossOrderAmount = moneyValue(raw['orderAmount'])
    const directDiscount = moneyValue(raw['discountAmount'])
    const discountDescription = raw['discountDescription'] ?? items.find(item => item['discountDescription'])?.['discountDescription']
    const descriptionDiscount = parsePazaramaDiscountDescription(discountDescription)
    const discount = directDiscount > 0 ? directDiscount : descriptionDiscount
    const netOrderAmount = Math.max(0, Math.round((grossOrderAmount - discount) * 100) / 100)
    const grossItems = items.map(i => {
      const product = (i['product'] as Record<string, unknown>) ?? {}
      const quantity = Number(i['quantity'] ?? 1)
      const unitPrice = moneyValue(i['salePrice'] ?? i['unitPrice'] ?? i['listPrice'])
      const totalPrice = moneyValue(i['totalPrice']) || unitPrice * quantity
      return { i, product, quantity, unitPrice, totalPrice }
    })
    const grossItemTotal = grossItems.reduce((sum, item) => sum + item.totalPrice, 0)
    const itemScale = discount > 0 && grossItemTotal > 0 ? netOrderAmount / grossItemTotal : 1

    return {
      marketplace: 'PAZARAMA',
      marketplaceOrderId: String(raw['orderId'] ?? raw['orderNumber'] ?? raw['id']),
      marketplaceOrderNo: raw['orderNumber'] ? String(raw['orderNumber']) : null,
      customerName: raw['customerName'] ? String(raw['customerName']) : (raw['customerFullName'] ? String(raw['customerFullName']) : null),
      customerPhone: raw['customerPhone'] ? String(raw['customerPhone']) : null,
      shippingAddress: (raw['shipmentAddress'] ?? raw['shippingAddress']) as object ?? null,
      billingAddress: raw['billingAddress'] as object ?? null,
      totalAmount: netOrderAmount,
      currency: String(raw['currency'] ?? 'TRY'),
      status: resolvePazaramaOrderStatus(raw, items),
      orderedAt: firstDate(raw, ['orderDate', 'createdDate', 'createDate', 'createdAt']),
      trackingNumber: items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['trackingNumber'])
        ? String((items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['trackingNumber'])?.['cargo'] as Record<string, unknown>)['trackingNumber'])
        : null,
      cargoCompany: items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['companyName'])
        ? String((items.find(i => (i['cargo'] as Record<string, unknown> | undefined)?.['companyName'])?.['cargo'] as Record<string, unknown>)['companyName'])
        : null,
      items: grossItems.map(({ i, product, quantity, unitPrice, totalPrice }) => {
        const netTotalPrice = Math.round(totalPrice * itemScale * 100) / 100
        return {
        marketplaceProductId: product['productId'] ? String(product['productId']) : (product['code'] ? String(product['code']) : null),
        sku: product['stockCode'] ? String(product['stockCode']) : (i['merchantProductCode'] ? String(i['merchantProductCode']) : null),
        title: String(product['name'] ?? product['title'] ?? i['productName'] ?? ''),
        quantity,
        unitPrice,
        totalPrice: netTotalPrice,
        discountAmount: roundedMoney(totalPrice - netTotalPrice),
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

  private mapN11Status(raw: Record<string, unknown>): OrderStatus {
    return resolveN11ShipmentStatus(raw)
  }

  private mapHepsiburadaStatus(value: unknown, isPackage = false): OrderStatus {
    return resolveHepsiburadaStatus(value, isPackage)
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
        discountAmount: item.discountAmount ?? 0,
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
  async createOrder(order: NormalizedOrder, notifyNewOrder = true): Promise<boolean> {
    const encryptField = (val: string | null) =>
      val ? encrypt(val, this.encryptionKey) : null
    // Duplikat kontrol
    const existing = await this.prisma.order.findUnique({
      where: { marketplaceOrderId: order.marketplaceOrderId },
    })
    if (existing) {
      const incomingStatus = order.status
      const nextStatus = shouldApplyExternalStatus(existing.status, incomingStatus)
        ? incomingStatus
        : existing.status
      const items = await this.prepareOrderItems(order)

      await this.prisma.$transaction(async tx => {
        await tx.order.update({
          where: { id: existing.id },
          data: {
            marketplaceOrderNo: order.marketplaceOrderNo ?? existing.marketplaceOrderNo,
            totalAmount: order.totalAmount,
            currency: order.currency,
            cargoCompany: order.cargoCompany ?? existing.cargoCompany,
            trackingNumber: order.trackingNumber ?? existing.trackingNumber,
            orderedAt: order.orderedAt ?? existing.orderedAt,
            customerName: order.customerName ? encryptField(order.customerName) : existing.customerName,
            customerPhone: order.customerPhone ? encryptField(order.customerPhone) : existing.customerPhone,
            shippingAddress: order.shippingAddress
              ? encrypt(JSON.stringify(order.shippingAddress), this.encryptionKey)
              : existing.shippingAddress ?? Prisma.JsonNull,
            billingAddress: order.billingAddress
              ? encrypt(JSON.stringify(order.billingAddress), this.encryptionKey)
              : existing.billingAddress ?? Prisma.JsonNull,
            fetchedAt: new Date(),
          },
        })

        if (items.length > 0) {
          await syncOrderItemsPreservingFinance(tx, existing.id, items)
        }

      })
      if (nextStatus !== existing.status) {
        await this.orderStateMachine.syncExternalStatus(existing.id, nextStatus, order.marketplace)
      }
      return false
    }

    // KVKK şifreleme
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
        orderedAt: order.orderedAt,
        fetchedAt: new Date(),
        items: {
          create: items,
        },
      },
    })

    if (notifyNewOrder) {
      await this.notifyNewOrder(order)
    }

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

export function resolveN11ShipmentStatus(raw: Record<string, unknown>): OrderStatus {
  const histories = firstList(raw, ['packageHistories'])
  const latestHistory = histories.length > 0 ? histories[histories.length - 1] : undefined
  const lineStatus = firstList(raw, ['lines', 'orderItems', 'items'])
    .map(item => item['orderItemLineItemStatusName'] ?? item['status'])
    .find(Boolean)
  const value = raw['shipmentPackageStatus']
    ?? raw['packageStatus']
    ?? raw['status']
    ?? raw['orderStatus']
    ?? latestHistory?.['status']
    ?? lineStatus
  const status = normalizeStatusText(value)
  if (status === 'CREATED' || status === 'UNPACKED') return 'NEW'
  if (status === 'PICKING') return 'PREPARING'
  if (status === 'SHIPPED') return 'SHIPPED'
  if (status === 'DELIVERED') return 'DELIVERED'
  if (status === 'CANCELLED' || status === 'UNSUPPLIED' || status === 'UN_SUPPLIED') return 'CANCELLED'
  return 'NEW'
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
