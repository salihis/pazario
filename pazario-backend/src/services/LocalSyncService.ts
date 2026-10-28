import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../db'

export interface LocalSyncProductInput {
  externalId?: string
  sku?: string
  barcode?: string
  name?: string
  title?: string
  description?: string
  brand?: string
  category?: string
  categoryPath?: string
  price?: number
  listPrice?: number
  currency?: string
  stock?: number
  vatRate?: number
  imageUrls?: string[]
  rawJson?: unknown
}

export interface LocalSyncSourceInput {
  name: string
  url: string
}

export interface LocalSyncBulkInput {
  source: LocalSyncSourceInput
  products: LocalSyncProductInput[]
}

function normalizeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeMoney(value: unknown): Prisma.Decimal {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return new Prisma.Decimal(Math.max(0, number).toFixed(2))
}

function normalizeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

function safeBarcode(value: unknown): string | null {
  const barcode = normalizeText(value)
  return barcode && barcode.length <= 20 ? barcode : null
}

function contentHash(data: Record<string, unknown>): string {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex')
}

export class LocalSyncService {
  static async upsertXmlSource(input: LocalSyncSourceInput) {
    const existing = await prisma.xmlSource.findFirst({ where: { url: input.url } })
    if (existing) {
      return prisma.xmlSource.update({
        where: { id: existing.id },
        data: { name: input.name, active: true },
      })
    }

    return prisma.xmlSource.create({
      data: {
        name: input.name,
        url: input.url,
        active: true,
        autoSyncEnabled: false,
      },
    })
  }

  static async listXmlSources() {
    return prisma.xmlSource.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        url: true,
        active: true,
        createdAt: true,
        _count: { select: { products: true } },
      },
    })
  }

  static async getStatus() {
    const [state, sourceCount, productCount] = await Promise.all([
      prisma.localSyncState.findUnique({ where: { id: 'default' } }),
      prisma.xmlSource.count(),
      prisma.product.count(),
    ])

    return {
      state: state ?? {
        id: 'default',
        lastSeenAt: null,
        lastSyncAt: null,
        totalProducts: productCount,
        pendingProducts: 0,
        syncedProducts: 0,
        failedProducts: 0,
        lastError: null,
        updatedAt: null,
      },
      sourceCount,
      productCount,
    }
  }

  static async syncProducts(input: LocalSyncBulkInput) {
    const source = await this.upsertXmlSource(input.source)
    const results: Array<{ externalId: string; sku: string; productId?: string; action?: string; error?: string }> = []
    let syncedProducts = 0
    let failedProducts = 0

    for (const item of input.products) {
      const externalId = normalizeText(item.externalId || item.sku || item.barcode)
      const sku = normalizeText(item.sku || item.barcode || externalId)
      const title = normalizeText(item.title || item.name || sku)

      try {
        if (!externalId || !sku || !title) {
          throw new Error('externalId, sku veya title eksik')
        }

        const barcode = safeBarcode(item.barcode)
        const categoryRaw = normalizeText(item.categoryPath || item.category) || null
        const images = Array.isArray(item.imageUrls)
          ? item.imageUrls.filter(url => typeof url === 'string' && url.trim()).map(url => url.trim())
          : []
        const hashInput = {
          sku,
          barcode,
          title,
          description: item.description ?? null,
          brand: item.brand ?? null,
          categoryRaw,
          price: item.price ?? 0,
          listPrice: item.listPrice ?? null,
          currency: item.currency || 'TRY',
          stock: item.stock ?? 0,
          images,
          vatRate: item.vatRate ?? null,
        }
        const data = {
          sourceId: source.id,
          externalId,
          sku,
          barcode,
          title,
          description: normalizeText(item.description) || null,
          brand: normalizeText(item.brand) || null,
          categoryRaw,
          price: normalizeMoney(item.price),
          listPrice: item.listPrice === undefined ? null : normalizeMoney(item.listPrice),
          currency: normalizeText(item.currency, 'TRY').slice(0, 3).toUpperCase(),
          stock: normalizeInt(item.stock),
          images,
          attributes: {
            vatRate: item.vatRate ?? null,
            localAgent: true,
            rawJson: item.rawJson ?? null,
          } as Prisma.InputJsonValue,
          contentHash: contentHash(hashInput),
          lastSeenAt: new Date(),
        }

        const existing = await prisma.product.findFirst({
          where: {
            sourceId: source.id,
            OR: [
              { externalId },
              { sku },
              ...(barcode ? [{ barcode }] : []),
            ],
          },
        })

        const product = existing
          ? await prisma.product.update({ where: { id: existing.id }, data })
          : await prisma.product.create({ data })

        syncedProducts += 1
        results.push({ externalId, sku, productId: product.id, action: existing ? 'updated' : 'created' })
      } catch (error) {
        failedProducts += 1
        results.push({
          externalId,
          sku,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await prisma.localSyncState.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
        totalProducts: input.products.length,
        pendingProducts: 0,
        syncedProducts,
        failedProducts,
        lastError: failedProducts > 0 ? `${failedProducts} urun senkronize edilemedi` : null,
      },
      update: {
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
        totalProducts: input.products.length,
        pendingProducts: 0,
        syncedProducts,
        failedProducts,
        lastError: failedProducts > 0 ? `${failedProducts} urun senkronize edilemedi` : null,
      },
    })

    return { source, total: input.products.length, syncedProducts, failedProducts, results }
  }
}
