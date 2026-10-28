// src/services/PublishService.ts

import { PrismaClient } from '@prisma/client'
import { CategoryAttributeService } from './CategoryAttributeService'
import { findApprovedCategoryMapping } from './CategoryMappingService'
import { applyXmlColorSizeOverrides } from './XmlAttributeOverrideService'
import { notifyQueue, publishQueue } from '../queue/queues'
import { MIN_MARKETPLACE_STOCK } from '../validators/ProductValidator'
import { OperationHistoryService } from './OperationHistoryService'
import { decryptJson } from './FieldEncryptionService'
import { TrendyolAdapter } from '../adapters/TrendyolAdapter'

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'

export interface SubmitResult {
  submitted: number
  skipped: { productId: string; reason: string }[]
  jobIds: string[]
}

export interface CompletenessResult {
  productId: string
  totalMandatory: number
  filledMandatory: number
  completenessPercent: number
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const POLLING_CONFIG: Record<Marketplace, { intervalSec: number; maxAttempts: number }> = {
  TRENDYOL:    { intervalSec: 10, maxAttempts: 12 },
  N11:         { intervalSec: 15, maxAttempts: 20 },
  HEPSIBURADA: { intervalSec: 20, maxAttempts: 15 },
  PAZARAMA:    { intervalSec: 0,  maxAttempts: 1  },
}
const RECENT_PUBLISH_GUARD_MINUTES = 30

type QueuedPublishItem = {
  productId: string
  publishJobId: string
  variantGroupKey: string
  canGroupAsVariant: boolean
}

function readProductAttribute(attributes: unknown, names: string[]): string | null {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null
  const wanted = new Set(names.map(name => name.toLocaleLowerCase('tr-TR')))
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (!wanted.has(key.toLocaleLowerCase('tr-TR'))) continue
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return null
}

function variantGroupKey(product: { sourceId: string; id: string; sku: string; attributes: unknown }) {
  const parent = readProductAttribute(product.attributes, ['variantParentSku', 'variantParentId'])
  return `${product.sourceId}:${parent || product.id}`
}

// ─── SERVİS ───────────────────────────────────────────────────────────────────

export class PublishService {
  private readonly attrService: CategoryAttributeService
  private readonly operationService: OperationHistoryService

  constructor(private readonly prisma: PrismaClient) {
    this.attrService = new CategoryAttributeService(prisma)
    this.operationService = new OperationHistoryService(prisma)
  }

  /**
   * Seçili ürünleri pazaryerine gönderir
   * Zorunlu attribute eksikse ürünü atlar
   */
  async submitProducts(
    productIds: string[],
    marketplace: Marketplace,
    triggeredBy: string,
    options: { force?: boolean } = {}
  ): Promise<SubmitResult> {
    const skipped: { productId: string; reason: string }[] = []
    const jobIds: string[] = []
    const queuedItems: QueuedPublishItem[] = []
    let submitted = 0
    const marketplaceStateKnown = await this.hasMarketplaceState(marketplace)

    for (const productId of productIds) {
      try {
        // Ürünü çek
        const product = await this.prisma.product.findUnique({
          where: { id: productId },
          include: { productAttributes: { where: { marketplace } } },
        })
        if (!product) {
          skipped.push({ productId, reason: 'Ürün bulunamadı' })
          continue
        }

        if (product.stock <= MIN_MARKETPLACE_STOCK) {
          skipped.push({
            productId,
            reason: `Stok yetersiz: ${product.stock} (stok > ${MIN_MARKETPLACE_STOCK} olmali)`,
          })
          continue
        }

        const existingListing = await this.prisma.marketplaceListing.findUnique({
          where: { productId_marketplace: { productId, marketplace } },
          select: { status: true, hashAtPublish: true },
        })
        const isAlreadyPublished = existingListing?.status === 'PUBLISHED'
        if (!options.force && existingListing?.status === 'PENDING') {
          skipped.push({
            productId,
            reason: 'Urun pazaryeri incelemesinde veya batch sonucu bekliyor. Tekrar gonderim engellendi.',
          })
          continue
        }
        if (!options.force && existingListing?.status === 'PUBLISHED' && existingListing.hashAtPublish === product.contentHash) {
          skipped.push({ productId, reason: 'Urun bu pazaryerinde zaten guncel olarak yayinda' })
          continue
        }

        const recentPublishJob = await this.prisma.productPublishJob.findFirst({
          where: {
            productId,
            marketplace,
            OR: [
              { status: { in: ['QUEUED', 'SUBMITTED', 'POLLING'] } },
              {
                createdAt: {
                  gte: new Date(Date.now() - RECENT_PUBLISH_GUARD_MINUTES * 60 * 1000),
                },
              },
            ],
          },
          orderBy: { createdAt: 'desc' },
        })
        if (recentPublishJob) {
          skipped.push({
            productId,
            reason: `Bu urun icin son ${RECENT_PUBLISH_GUARD_MINUTES} dakika icinde ${marketplace} gonderim islemi var. Tekrarlayan islem engellendi.`,
          })
          continue
        }

        if (!marketplaceStateKnown && !existingListing) {
          skipped.push({
            productId,
            reason: 'Once Pazaryerleri ekraninda bu pazaryeri durumlarini kontrol edin. Eski yayinlar eslestirilmeden yeni yayin gonderimi engellendi.',
          })
          continue
        }

        const existingExternal = await this.findPublishedExternalMatch(marketplace, {
          sku: product.sku,
          barcode: product.barcode,
          externalId: product.externalId,
        })
        if (existingExternal && existingListing?.status !== 'PUBLISHED') {
          await this.prisma.marketplaceListing.upsert({
            where: { productId_marketplace: { productId, marketplace } },
            update: {
              status: 'PUBLISHED',
              externalListingId: existingExternal.externalListingId || existingExternal.listingKey,
              publishedAt: existingExternal.lastSeenAt,
              lastUpdatedAt: new Date(),
              hashAtPublish: product.contentHash,
            },
            create: {
              productId,
              marketplace,
              status: 'PUBLISHED',
              externalListingId: existingExternal.externalListingId || existingExternal.listingKey,
              publishedAt: existingExternal.lastSeenAt,
              lastUpdatedAt: new Date(),
              hashAtPublish: product.contentHash,
            },
          })
          skipped.push({
            productId,
            reason: 'Urun pazaryerinde zaten bulundu ve yayinda olarak eslestirildi',
          })
          continue
        }

        // Kategori ID'sini bul
        const categoryMapping = await findApprovedCategoryMapping(this.prisma, {
          sourceId: product.sourceId,
          sourceCategory: product.categoryRaw,
          marketplace,
        })

        if (!categoryMapping?.marketplaceCategoryId) {
          skipped.push({ productId, reason: 'Kategori eşleştirmesi yok' })
          continue
        }

        // Zorunlu attribute kontrolü
        await applyXmlColorSizeOverrides(this.prisma, product, marketplace, categoryMapping.marketplaceCategoryId)

        const { attributes } = await this.attrService.getAttributes(
          marketplace,
          categoryMapping.marketplaceCategoryId,
          productId
        )

        const missingMandatory = attributes.filter(
          a => a.isMandatory && !a.currentValue
        )

        if (missingMandatory.length > 0) {
          skipped.push({
            productId,
            reason: `Eksik zorunlu özellik: ${missingMandatory.map(a => a.attributeName).join(', ')}`,
          })
          continue
        }

        // Job oluştur
        const job = await this.prisma.productPublishJob.create({
          data: {
            productId,
            marketplace,
            status: 'QUEUED',
            triggeredBy,
            submittedAt: new Date(),
          },
        })

        jobIds.push(job.id)
        submitted++

        // Polling kuyruğuna al
        queuedItems.push({
          productId,
          publishJobId: job.id,
          variantGroupKey: variantGroupKey(product),
          canGroupAsVariant: !isAlreadyPublished,
        })
      } catch (e) {
        skipped.push({
          productId,
          reason: e instanceof Error ? e.message : 'Bilinmeyen hata',
        })
      }
    }

    const groups = queuedItems.reduce<Record<string, QueuedPublishItem[]>>((acc, item) => {
      const key = (marketplace === 'TRENDYOL' || marketplace === 'HEPSIBURADA') && item.canGroupAsVariant ? item.variantGroupKey : item.productId
      acc[key] = acc[key] ?? []
      acc[key].push(item)
      return acc
    }, {})

    for (const items of Object.values(groups)) {
      if ((marketplace === 'TRENDYOL' || marketplace === 'HEPSIBURADA') && items.length > 1) {
        const operation = await this.operationService.createOperation({
          type: 'VARIANT_UPDATE',
          title: `${marketplace} varyant grubu ${options.force ? 'guncelleme' : 'gonderim'} islemi`,
          marketplace,
          queueName: 'publish',
          requestedBy: triggeredBy,
          productPublishJobId: items[0].publishJobId,
          targetCount: items.length,
          retryPayload: {
            queueName: 'publish',
            jobName: `publish-variant-${items[0].publishJobId}`,
            data: {
              productId: items[0].productId,
              productIds: items.map(item => item.productId),
              marketplace,
              publishJobId: items[0].publishJobId,
              publishJobIds: items.map(item => item.publishJobId),
              force: Boolean(options.force),
            },
          },
        }, await this.operationItemsForPublish(items))
        const queueJob = await publishQueue.add(`publish-variant-${items[0].publishJobId}`, {
          productId: items[0].productId,
          productIds: items.map(item => item.productId),
          marketplace,
          publishJobId: items[0].publishJobId,
          publishJobIds: items.map(item => item.publishJobId),
          force: Boolean(options.force),
          operationId: operation.id,
        }, { priority: 1 })
        await this.prisma.operationHistory.update({
          where: { id: operation.id },
          data: { queueJobId: String(queueJob.id) },
        })
        continue
      }

      for (const item of items) {
        const operation = await this.operationService.createOperation({
          type: 'PRODUCT_PUBLISH',
          title: `${marketplace} urun ${options.force ? 'guncelleme' : 'gonderim'} islemi`,
          marketplace,
          queueName: 'publish',
          requestedBy: triggeredBy,
          productPublishJobId: item.publishJobId,
          targetCount: 1,
          retryPayload: {
            queueName: 'publish',
            jobName: `publish-${item.publishJobId}`,
            data: {
              productId: item.productId,
              marketplace,
              publishJobId: item.publishJobId,
              force: Boolean(options.force),
            },
          },
        }, await this.operationItemsForPublish([item]))
        const queueJob = await publishQueue.add(`publish-${item.publishJobId}`, {
          productId: item.productId,
          marketplace,
          publishJobId: item.publishJobId,
          force: Boolean(options.force),
          operationId: operation.id,
        }, { priority: 1 })
        await this.prisma.operationHistory.update({
          where: { id: operation.id },
          data: { queueJobId: String(queueJob.id) },
        })
      }
    }

    return { submitted, skipped, jobIds }
  }

  private async operationItemsForPublish(items: QueuedPublishItem[]) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: items.map(item => item.productId) } },
      select: { id: true, sku: true, barcode: true },
    })
    const byId = new Map(products.map(product => [product.id, product]))
    return items.map(item => {
      const product = byId.get(item.productId)
      return {
        productId: item.productId,
        sku: product?.sku,
        barcode: product?.barcode,
        variantGroupKey: item.variantGroupKey,
      }
    })
  }

  private async hasMarketplaceState(marketplace: Marketplace): Promise<boolean> {
    const [externalCount, listingCount] = await Promise.all([
      this.prisma.marketplaceExternalProduct.count({ where: { marketplace } }),
      this.prisma.marketplaceListing.count({ where: { marketplace } }),
    ])

    return externalCount > 0 || listingCount > 0
  }

  private async findPublishedExternalMatch(
    marketplace: Marketplace,
    product: { sku: string; barcode: string | null; externalId: string }
  ) {
    const keys = Array.from(new Set([
      product.sku,
      product.barcode,
      product.externalId,
      product.sku ? `BRS${product.sku}` : '',
      product.barcode ? `BRS${product.barcode}` : '',
      product.externalId ? `BRS${product.externalId}` : '',
    ].map(value => String(value ?? '').trim()).filter(Boolean)))

    if (keys.length === 0) return null

    return this.prisma.marketplaceExternalProduct.findFirst({
      where: {
        marketplace,
        status: 'PUBLISHED',
        OR: [
          { listingKey: { in: keys } },
          { externalListingId: { in: keys } },
          { stockCode: { in: keys } },
          { barcode: { in: keys } },
        ],
      },
      orderBy: { lastSeenAt: 'desc' },
    })
  }

  /**
   * Job durumunu sorgular ve günceller
   */
  async pollJobStatus(jobId: string): Promise<void> {
    const job = await this.prisma.productPublishJob.findUnique({
      where: { id: jobId },
      include: { product: true },
    })

    if (!job || !['SUBMITTED', 'POLLING', 'QUEUED'].includes(job.status)) return

    const config = POLLING_CONFIG[job.marketplace as Marketplace]

    // Max deneme aşıldı
    if (job.attemptCount >= config.maxAttempts) {
      await this.prisma.productPublishJob.update({
        where: { id: jobId },
        data: { status: 'POLLING_TIMEOUT', resolvedAt: new Date() },
      })

      await notifyQueue.add('polling-timeout', {
        type: 'slack',
        message: `⏱ Polling timeout: ${job.productId} / ${job.marketplace}`,
        level: 'warn',
      })
      return
    }

    try {
      // Pazarama sonucu worker/adaptor tarafinda batch sonucuyla kontrol edilir.
      if (job.marketplace === 'PAZARAMA') {
        await this.prisma.productPublishJob.update({
          where: { id: jobId },
          data: {
            status: job.externalJobId ? 'POLLING' : 'SUBMITTED',
            attemptCount: { increment: 1 },
            lastPolledAt: new Date(),
          },
        })
        return
      }

      // Diğer pazaryerleri: externalJobId ile sorgula
      if (!job.externalJobId) {
        await this.prisma.productPublishJob.update({
          where: { id: jobId },
          data: {
            status: 'POLLING',
            attemptCount: { increment: 1 },
            lastPolledAt: new Date(),
          },
        })
        return
      }

      // Simüle edilmiş polling — gerçek adapter çağrısı burada
      if (job.marketplace === 'TRENDYOL') {
        const record = await this.prisma.marketplaceCredential.findUnique({
          where: { marketplace: 'TRENDYOL' },
        })
        const credentials = record?.isActive ? decryptJson(record.credentialsEncrypted) : {}
        const apiKey = String(credentials.apiKey || process.env.TY_API_KEY || '').trim()
        const apiSecret = String(credentials.apiSecret || process.env.TY_API_SECRET || '').trim()
        const supplierId = String(credentials.supplierId || process.env.TY_SUPPLIER_ID || '').trim()
        if (!apiKey || !apiSecret || !supplierId) throw new Error('Trendyol API bilgileri eksik')

        const batch = await new TrendyolAdapter(apiKey, apiSecret, supplierId)
          .getBatchRequestResult(job.externalJobId)
        if (batch.status !== 'COMPLETED') {
          await this.prisma.productPublishJob.update({
            where: { id: jobId },
            data: {
              status: 'POLLING',
              attemptCount: { increment: 1 },
              lastPolledAt: new Date(),
            },
          })
          return
        }

        const failureReasons = (batch.items ?? [])
          .filter(item => item.status && item.status !== 'SUCCESS')
          .flatMap(item => item.failureReasons ?? [])
        const failed = (batch.failedItemCount ?? 0) > 0 || failureReasons.length > 0
        if (failed) {
          await this.prisma.productPublishJob.update({
            where: { id: jobId },
            data: {
              status: 'FAILED',
              errorMessage: failureReasons.join(' | ') || 'Trendyol batch tamamlandi ancak urun basarisiz',
              resolvedAt: new Date(),
              attemptCount: { increment: 1 },
              lastPolledAt: new Date(),
            },
          })
          await this.updateListing(job.productId, 'TRENDYOL', 'FAILED')
          return
        }

        await this.prisma.productPublishJob.update({
          where: { id: jobId },
          data: {
            status: 'SUCCESS',
            errorMessage: null,
            resolvedAt: new Date(),
            attemptCount: { increment: 1 },
            lastPolledAt: new Date(),
          },
        })
        await this.updateListing(job.productId, 'TRENDYOL', 'PUBLISHED', job.product.contentHash)
        return
      }

      const isSuccess = true // adapter.getStatus(job.externalJobId)

      if (isSuccess) {
        await this.prisma.productPublishJob.update({
          where: { id: jobId },
          data: {
            status: 'SUCCESS',
            resolvedAt: new Date(),
            attemptCount: { increment: 1 },
            lastPolledAt: new Date(),
          },
        })
        await this.updateListing(job.productId, job.marketplace as Marketplace, 'PUBLISHED', job.product.contentHash)
      } else {
        await this.prisma.productPublishJob.update({
          where: { id: jobId },
          data: {
            status: 'POLLING',
            attemptCount: { increment: 1 },
            lastPolledAt: new Date(),
          },
        })
      }
    } catch (e) {
      await this.prisma.productPublishJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: e instanceof Error ? e.message : String(e),
          resolvedAt: new Date(),
        },
      })
    }
  }

  /**
   * Ürünlerin doluluk oranını hesaplar
   */
  async getCompleteness(
    productIds: string[],
    marketplace: Marketplace
  ): Promise<CompletenessResult[]> {
    const results: CompletenessResult[] = []

    for (const productId of productIds) {
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
      })
      if (!product) continue

      const categoryMapping = await findApprovedCategoryMapping(this.prisma, {
        sourceId: product.sourceId,
        sourceCategory: product.categoryRaw,
        marketplace,
      })

      if (!categoryMapping?.marketplaceCategoryId) {
        results.push({ productId, totalMandatory: 0, filledMandatory: 0, completenessPercent: 0 })
        continue
      }

      const mandatoryAttrs = await this.prisma.marketplaceCategoryAttribute.findMany({
        where: { marketplace, categoryId: categoryMapping.marketplaceCategoryId, isMandatory: true },
      })

      const filledAttrs = await this.prisma.productAttribute.findMany({
        where: {
          productId,
          marketplace,
          attributeId: { in: mandatoryAttrs.map(a => a.attributeId) },
          OR: [{ valueId: { not: null } }, { valueText: { not: null } }],
        },
      })

      const totalMandatory = mandatoryAttrs.length
      const filledMandatory = filledAttrs.length
      const completenessPercent = totalMandatory > 0
        ? Math.round((filledMandatory / totalMandatory) * 100)
        : 100

      results.push({ productId, totalMandatory, filledMandatory, completenessPercent })
    }

    return results
  }

  /**
   * Marketplace listing günceller
   */
  private async updateListing(
    productId: string,
    marketplace: Marketplace,
    status: 'PUBLISHED' | 'FAILED',
    contentHash?: string
  ): Promise<void> {
    const published = status === 'PUBLISHED'
    await this.prisma.marketplaceListing.upsert({
      where: { productId_marketplace: { productId, marketplace } },
      update: {
        status,
        publishedAt: published ? new Date() : null,
        hashAtPublish: published ? contentHash : null,
      },
      create: {
        productId,
        marketplace,
        status,
        publishedAt: published ? new Date() : null,
        hashAtPublish: published ? contentHash : null,
      },
    })
  }

  /**
   * Polling job'ı zamanlar
   */
  private async schedulePolling(jobId: string, marketplace: Marketplace): Promise<void> {
    const config = POLLING_CONFIG[marketplace]
    if (config.intervalSec === 0) {
      // Pazarama: hemen kontrol et
      await this.pollJobStatus(jobId)
    }
    // Diğerleri: BullMQ worker tarafından periyodik çağrılır
  }
}
