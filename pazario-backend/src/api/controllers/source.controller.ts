import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { stat } from 'fs/promises'
import { fileURLToPath } from 'url'
import { XMLParser, buildParseOptionsForSource } from '../../parser/XMLParser'
import { logger } from '../../utils/logger'
import { fetchXml } from '../../utils/xmlFetch'
import { MIN_MARKETPLACE_STOCK } from '../../validators/ProductValidator'
import { purchaseCostSettingsFromBody } from '../../services/PurchaseCostService'

const prisma = new PrismaClient()
const parser = new XMLParser()
const LARGE_LOCAL_XML_BYTES = 50 * 1024 * 1024

function normalizeFetchTimeoutSec(value: unknown): number {
  const timeout = Number(value ?? 60)
  if (!Number.isFinite(timeout)) return 60
  return Math.min(Math.max(Math.trunc(timeout), 10), 600)
}

function normalizeAutoSyncTime(value: unknown): string {
  const time = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{2}:\d{2}$/.test(time)) return '03:00'
  const [hour, minute] = time.split(':').map(Number)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '03:00'
  return time
}

function normalizeCategoryIncludeKeywords(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .split(/[,\n;]/)
    .map(item => item.trim())
    .filter(Boolean)
    .join(', ')
  return normalized || null
}

function parseCategoryIncludeKeywords(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[,\n;]/)
    .map(item => normalizeCategoryFilterText(item.trim()))
    .filter(Boolean)
}

function normalizeCategoryFilterText(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
}

function filterProductsByCategory<T extends { category: string | null }>(products: T[], keywords: string | null | undefined): T[] {
  const terms = parseCategoryIncludeKeywords(keywords)
  if (terms.length === 0) return products
  return products.filter(product => {
    const category = normalizeCategoryFilterText(product.category ?? '')
    return terms.some(term => category.includes(term))
  })
}

async function getAllowedLocalXmlStats(url: string): Promise<{ filePath: string; size: number } | null> {
  if (!url.startsWith('file://')) return null
  const importDir = path.resolve(process.env.XML_IMPORT_DIR || path.join(process.cwd(), 'imports'))
  const filePath = path.resolve(fileURLToPath(url))
  const relativePath = path.relative(importDir, filePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`XML dosyasi izin verilen klasor disinda: ${filePath}`)
  }
  const info = await stat(filePath)
  return { filePath, size: info.size }
}

export async function getSources(req: Request, res: Response) {
  try {
    const data = await prisma.xmlSource.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { products: true } } },
    })
    res.json({ success: true, data })
  } catch (e) {
    logger.error({ err: e }, 'XML kaynaklari listelenemedi')
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Sunucu hatasi' })
  }
}

export async function createSource(req: Request, res: Response) {
  try {
    const { name, url, fallbackUrl, fetchTimeoutSec, categoryIncludeKeywords, autoSyncEnabled, autoSyncTime } = req.body
    if (!name || !url) {
      res.status(400).json({ success: false, error: 'name ve url zorunlu' })
      return
    }
    const source = await prisma.xmlSource.create({
      data: {
        name,
        url,
        fallbackUrl: typeof fallbackUrl === 'string' && fallbackUrl.trim() ? fallbackUrl.trim() : null,
        fetchTimeoutSec: normalizeFetchTimeoutSec(fetchTimeoutSec),
        categoryIncludeKeywords: normalizeCategoryIncludeKeywords(categoryIncludeKeywords),
        ...purchaseCostSettingsFromBody(req.body),
        autoSyncEnabled: autoSyncEnabled !== false,
        autoSyncTime: normalizeAutoSyncTime(autoSyncTime),
        active: true,
      },
    })
    res.status(201).json({ success: true, data: source })
  } catch (e) {
    logger.error({ err: e }, 'XML kaynak olusturulamadi')
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Kaynak olusturulamadi' })
  }
}

export async function updateSource(req: Request, res: Response) {
  try {
    const data: {
      name?: string
      url?: string
      fallbackUrl?: string | null
      fetchTimeoutSec?: number
      categoryIncludeKeywords?: string | null
      active?: boolean
      autoSyncEnabled?: boolean
      autoSyncTime?: string
      priceIncludesVat?: boolean
      purchaseVatRate?: number
      purchaseExtraFee?: number
    } = {}

    if (typeof req.body.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim()
    if (typeof req.body.url === 'string' && req.body.url.trim()) data.url = req.body.url.trim()
    if (req.body.fallbackUrl !== undefined) data.fallbackUrl = typeof req.body.fallbackUrl === 'string' && req.body.fallbackUrl.trim() ? req.body.fallbackUrl.trim() : null
    if (req.body.fetchTimeoutSec !== undefined) data.fetchTimeoutSec = normalizeFetchTimeoutSec(req.body.fetchTimeoutSec)
    if (req.body.categoryIncludeKeywords !== undefined) data.categoryIncludeKeywords = normalizeCategoryIncludeKeywords(req.body.categoryIncludeKeywords)
    if (typeof req.body.active === 'boolean') data.active = req.body.active
    if (typeof req.body.autoSyncEnabled === 'boolean') data.autoSyncEnabled = req.body.autoSyncEnabled
    if (req.body.autoSyncTime !== undefined) data.autoSyncTime = normalizeAutoSyncTime(req.body.autoSyncTime)
    Object.assign(data, purchaseCostSettingsFromBody(req.body))

    const source = await prisma.xmlSource.update({
      where: { id: req.params.id },
      data,
    })
    res.json({ success: true, data: source })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Kaynak bulunamadi' })
  }
}

export async function deleteSource(req: Request, res: Response) {
  try {
    const source = await prisma.xmlSource.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        _count: {
          select: {
            products: true,
            orderItems: true,
          },
        },
      },
    })

    if (!source) {
      res.status(404).json({ success: false, error: 'Kaynak bulunamadi' })
      return
    }

    if (source._count.products > 0 || source._count.orderItems > 0) {
      res.status(409).json({
        success: false,
        error: `Bu kaynakta ${source._count.products} urun ve ${source._count.orderItems} siparis kalemi var. Veri kaybini onlemek icin once pasife alinabilir, tamamen silinemez.`,
      })
      return
    }

    await prisma.$transaction(async tx => {
      const syncJobs = await tx.syncJob.findMany({
        where: { sourceId: source.id },
        select: { id: true },
      })
      const syncJobIds = syncJobs.map(job => job.id)

      if (syncJobIds.length > 0) {
        await tx.marketplaceListing.updateMany({
          where: { lastSyncJobId: { in: syncJobIds } },
          data: { lastSyncJobId: null },
        })
        await tx.priceCalculation.deleteMany({ where: { syncJobId: { in: syncJobIds } } })
        await tx.publishError.deleteMany({ where: { jobId: { in: syncJobIds } } })
        await tx.syncJob.deleteMany({ where: { id: { in: syncJobIds } } })
      }

      await tx.categoryMapping.deleteMany({ where: { sourceId: source.id } })
      await tx.xmlSource.delete({ where: { id: source.id } })
    })

    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Kaynak silinemedi' })
  }
}

export async function testSource(req: Request, res: Response) {
  try {
    const { url } = req.body
    const fetchTimeoutSec = normalizeFetchTimeoutSec(req.body?.fetchTimeoutSec)
    const categoryIncludeKeywords = normalizeCategoryIncludeKeywords(req.body?.categoryIncludeKeywords)
    if (!url) {
      res.status(400).json({ success: false, error: 'url zorunlu' })
      return
    }

    const localXmlStats = await getAllowedLocalXmlStats(String(url))
    if (localXmlStats && localXmlStats.size > LARGE_LOCAL_XML_BYTES) {
      res.json({
        success: true,
        data: {
          feedType: 'LOCAL_FILE',
          totalProducts: 0,
          filteredProducts: 0,
          categoryFilter: categoryIncludeKeywords,
          parsed: 0,
          failed: 0,
          durationMs: 0,
          stockOk: 0,
          stockBlocked: 0,
          minStock: MIN_MARKETPLACE_STOCK,
          categoryCount: 0,
          missingBarcode: 0,
          missingImages: 0,
          variantProducts: 0,
          variantGroups: 0,
          turkishBroken: 0,
          turkishStatus: 'OK',
          largeFile: true,
          fileSizeMb: Math.round((localXmlStats.size / 1024 / 1024) * 10) / 10,
          message: 'Buyuk lokal XML dosyasi bulundu. Hizli test tamamlandi; tam parse senkronizasyon sirasinda arka planda yapilacak.',
          detectedFields: {
            id: false,
            title: false,
            sku: false,
            barcode: false,
            brand: false,
            category: false,
            price: false,
            listPrice: false,
            stock: false,
            images: false,
            color: false,
            size: false,
            variants: false,
          },
          sample: [],
          errors: [],
        },
      })
      return
    }

    const xml = await fetchXml(url, fetchTimeoutSec * 1000)
    const normalized = xml.trim()

    if (!normalized || normalized.length === 0) {
      throw new Error('Feed bos dondu')
    }

    if (/Just a moment|cf-browser-verification|cloudflare/i.test(normalized)) {
      throw new Error('XML linki Cloudflare/bot korumasi nedeniyle backend sunucusundan okunamiyor. Tedarikciden sunucu IP adresini izin listesine eklemesini isteyin veya yedek XML dosyasi/URL kullanin.')
    }

    if (/^(error|failed|unauthorized)/i.test(normalized) || /^<html/i.test(normalized)) {
      throw new Error(`Feed fetch hatasi: ${normalized.slice(0, 200)}`)
    }

    const result = await parser.parse(xml, buildParseOptionsForSource({ name: req.body?.name, url: String(url) }))
    const allProducts = result.products
    const products = filterProductsByCategory(allProducts, categoryIncludeKeywords)
    const stockOk = products.filter(product => product.stock > MIN_MARKETPLACE_STOCK).length
    const categoryCount = new Set(products.map(product => product.category).filter(Boolean)).size
    const missingBarcode = products.filter(product => !product.barcode).length
    const missingImages = products.filter(product => product.images.length === 0).length
    const variantParents = new Set(
      products
        .map(product => product.attributes?.variantParentSku || product.attributes?.variantParentId)
        .filter(Boolean)
    )
    const variants = products.filter(product => product.attributes?.variantParentSku || product.attributes?.variantParentId).length
    const brokenTurkishPattern = /\?{2,}|B\?y\?k|Kad\?n|Tak\?m|K\?rm\?z|Kost\?m|S\?tyen|\?ama|\?orap|G\?iyim/i
    const turkishBroken = products.filter(product =>
      brokenTurkishPattern.test(product.title)
      || brokenTurkishPattern.test(product.category ?? '')
      || brokenTurkishPattern.test(product.brand ?? '')
    ).length
    const firstProduct = products[0]
    const detectedFields = {
      id: Boolean(firstProduct?.id),
      title: Boolean(firstProduct?.title),
      sku: Boolean(firstProduct?.sku),
      barcode: products.some(product => Boolean(product.barcode)),
      brand: products.some(product => Boolean(product.brand)),
      category: products.some(product => Boolean(product.category)),
      price: products.some(product => product.price > 0),
      listPrice: products.some(product => product.listPrice !== null && product.listPrice > 0),
      stock: products.some(product => product.stock > 0),
      images: products.some(product => product.images.length > 0),
      color: products.some(product => Object.keys(product.attributes).some(key => /renk|color/i.test(key))),
      size: products.some(product => Object.keys(product.attributes).some(key => /beden|size/i.test(key))),
      variants: variants > 0,
    }

    res.json({
      success: true,
      data: {
        feedType: result.meta.feedType,
        totalProducts: result.meta.totalNodes,
        filteredProducts: products.length,
        categoryFilter: categoryIncludeKeywords,
        parsed: result.meta.parsed,
        failed: result.meta.failed,
        durationMs: result.meta.durationMs,
        stockOk,
        stockBlocked: Math.max(products.length - stockOk, 0),
        minStock: MIN_MARKETPLACE_STOCK,
        categoryCount,
        missingBarcode,
        missingImages,
        variantProducts: variants,
        variantGroups: variantParents.size,
        turkishBroken,
        turkishStatus: turkishBroken === 0 ? 'OK' : 'BROKEN',
        detectedFields,
        sample: products.slice(0, 10).map(p => ({
          id: p.id,
          sku: p.sku,
          barcode: p.barcode,
          title: p.title,
          brand: p.brand,
          category: p.category,
          price: p.price,
          listPrice: p.listPrice,
          stock: p.stock,
          images: p.images.length,
        })),
        errors: result.errors.slice(0, 5),
      },
    })
  } catch (e) {
    const err = e as { message?: string; code?: string }
    const status = (e as { response?: { status?: number; data?: unknown } }).response?.status
    const data = (e as { response?: { data?: unknown } }).response?.data
    const htmlText = Buffer.isBuffer(data) ? data.toString('utf8', 0, 500) : typeof data === 'string' ? data.slice(0, 500) : ''
    const cloudflareBlocked = status === 403 && /Just a moment|cf-browser-verification|cloudflare/i.test(htmlText)
    res.status(400).json({
      success: false,
      error: cloudflareBlocked
        ? 'XML linki Cloudflare/bot korumasi nedeniyle backend sunucusundan okunamiyor. Tedarikciden sunucu IP adresini izin listesine eklemesini isteyin veya yedek XML dosyasi/URL kullanin.'
        : err.message ?? 'Feed test edilemedi',
    })
  }
}

export async function syncSource(req: Request, res: Response) {
  try {
    const source = await prisma.xmlSource.findUnique({
      where: { id: req.params.id },
    })
    if (!source) {
      res.status(404).json({ success: false, error: 'Kaynak bulunamadi' })
      return
    }

    const syncJob = await prisma.syncJob.create({
      data: { sourceId: source.id, status: 'PENDING' },
    })

    runSync(source.id, syncJob.id).catch((err: unknown) => {
      logger.error({ err }, 'runSync arka plan hatası')
    })

    res.status(202).json({ success: true, data: { syncJobId: syncJob.id } })
  } catch (e) {
    logger.error({ err: e, sourceId: req.params.id }, 'XML kaynak senkronizasyonu baslatilamadi')
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Sunucu hatasi' })
  }
}

async function runSync(sourceId: string, syncJobId: string) {
  const { MarketplacePipeline } = await import('../../MarketplacePipeline')
  const pipeline = new MarketplacePipeline(prisma)

  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: { status: 'RUNNING', startedAt: new Date() },
  })

  try {
    const result = await pipeline.run(syncJobId)
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: 'DONE',
        finishedAt: new Date(),
        totalProducts: result.totalFetched,
        changedProducts: result.changedProducts,
        publishedCount: result.published,
        failedCount: result.failed,
      },
    })
  } catch (e) {
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    })
  }
}

export async function getSyncJobs(req: Request, res: Response) {
  try {
    const sourceId = req.query.sourceId as string | undefined
    const where = sourceId ? { sourceId } : {}
    const data = await prisma.syncJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    res.json({ success: true, data })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

// ─── XML UPLOAD (Direct XML content) ───────────────────────────────────────

export async function uploadXML(req: Request, res: Response) {
  try {
    const { xml, name } = req.body

    if (!xml || !name) {
      res.status(400).json({
        success: false,
        error: 'xml ve name alanları zorunlu',
        code: 'BAD_REQUEST'
      })
      return
    }

    if (typeof xml !== 'string') {
      res.status(400).json({
        success: false,
        error: 'xml string olmalı',
        code: 'BAD_REQUEST'
      })
      return
    }

    // Create a temporary source for direct XML upload
    const source = await prisma.xmlSource.create({
      data: {
        name: `${name} (Direct Upload)`,
        url: 'data:text/xml;base64,' + Buffer.from(xml).toString('base64'),
        active: true,
        fetchTimeoutSec: 30,
      },
    })

    // Create sync job
    const syncJob = await prisma.syncJob.create({
      data: {
        sourceId: source.id,
        status: 'PENDING',
      },
    })

    // Queue the sync job (process it)
    const { syncQueue } = await import('../../queue/queues')
    await syncQueue.add('sync', { sourceId: source.id, syncJobId: syncJob.id })

    res.status(201).json({
      success: true,
      data: {
        sourceId: source.id,
        syncJobId: syncJob.id,
        message: 'XML uploaded successfully - sync job queued'
      }
    })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    res.status(500).json({
      success: false,
      error,
      code: 'UPLOAD_ERROR'
    })
  }
}
