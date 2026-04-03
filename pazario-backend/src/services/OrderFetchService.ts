// src/services/OrderFetchService.ts

import { PrismaClient } from '@prisma/client'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

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
  items: {
    marketplaceProductId: string | null
    sku: string | null
    title: string
    quantity: number
    unitPrice: number
    totalPrice: number
    vatRate: number | null
  }[]
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const INITIAL_FETCH_DAYS = 7

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

// ─── SERVİS ───────────────────────────────────────────────────────────────────

export class OrderFetchService {
  private readonly encryptionKey: string

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
    const marketplaces: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

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
        ?? new Date(Date.now() - INITIAL_FETCH_DAYS * 24 * 60 * 60 * 1000)

      // Sayfalı çekme
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
    return []
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
    const items = (raw['orderItems'] as Record<string, unknown>[]) ?? []
    return {
      marketplace: 'PAZARAMA',
      marketplaceOrderId: String(raw['orderNumber'] ?? raw['id']),
      marketplaceOrderNo: raw['orderNumber'] ? String(raw['orderNumber']) : null,
      customerName: raw['customerFullName'] ? String(raw['customerFullName']) : null,
      customerPhone: raw['customerPhone'] ? String(raw['customerPhone']) : null,
      shippingAddress: raw['shippingAddress'] as object ?? null,
      billingAddress: null,
      totalAmount: Number(raw['orderAmount'] ?? 0),
      currency: 'TRY',
      items: items.map(i => ({
        marketplaceProductId: i['productCode'] ? String(i['productCode']) : null,
        sku: i['merchantProductCode'] ? String(i['merchantProductCode']) : null,
        title: String(i['productName'] ?? ''),
        quantity: Number(i['quantity'] ?? 1),
        unitPrice: Number(i['unitPrice'] ?? 0),
        totalPrice: Number(i['totalPrice'] ?? 0),
        vatRate: null,
      })),
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
    if (existing) return false

    // KVKK şifreleme
    const encryptField = (val: string | null) =>
      val ? encrypt(val, this.encryptionKey) : null

    await this.prisma.order.create({
      data: {
        marketplace: order.marketplace,
        marketplaceOrderId: order.marketplaceOrderId,
        marketplaceOrderNo: order.marketplaceOrderNo,
        status: 'NEW',
        customerName: encryptField(order.customerName),
        customerPhone: encryptField(order.customerPhone),
        shippingAddress: order.shippingAddress
          ? JSON.parse(encrypt(JSON.stringify(order.shippingAddress), this.encryptionKey))
          : null,
        billingAddress: order.billingAddress
          ? JSON.parse(encrypt(JSON.stringify(order.billingAddress), this.encryptionKey))
          : null,
        totalAmount: order.totalAmount,
        currency: order.currency,
        fetchedAt: new Date(),
        items: {
          create: order.items,
        },
      },
    })

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
        ? JSON.parse(decrypt(JSON.stringify(order.shippingAddress), this.encryptionKey))
        : null,
      billingAddress: order.billingAddress
        ? JSON.parse(decrypt(JSON.stringify(order.billingAddress), this.encryptionKey))
        : null,
    }
  }
}