// src/services/PublishService.ts

import { PrismaClient } from '@prisma/client'
import { CategoryAttributeService } from './CategoryAttributeService'
import { findApprovedCategoryMapping } from './CategoryMappingService'
import { applyXmlColorSizeOverrides } from './XmlAttributeOverrideService'
import { notifyQueue, publishQueue } from '../queue/queues'
import { MIN_MARKETPLACE_STOCK } from '../validators/ProductValidator'

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

// ─── SERVİS ───────────────────────────────────────────────────────────────────

export class PublishService {
  private readonly attrService: CategoryAttributeService

  constructor(private readonly prisma: PrismaClient) {
    this.attrService = new CategoryAttributeService(prisma)
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
    let submitted = 0

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
        if (!options.force && existingListing?.status === 'PUBLISHED' && existingListing.hashAtPublish === product.contentHash) {
          skipped.push({ productId, reason: 'Urun bu pazaryerinde zaten guncel olarak yayinda' })
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
        await publishQueue.add(`publish-${job.id}`, {
          productId,
          marketplace,
          publishJobId: job.id,
          force: Boolean(options.force),
        }, { priority: 1 })
      } catch (e) {
        skipped.push({
          productId,
          reason: e instanceof Error ? e.message : 'Bilinmeyen hata',
        })
      }
    }

    return { submitted, skipped, jobIds }
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
    contentHash: string
  ): Promise<void> {
    await this.prisma.marketplaceListing.upsert({
      where: { productId_marketplace: { productId, marketplace } },
      update: {
        status,
        publishedAt: new Date(),
        hashAtPublish: contentHash,
      },
      create: {
        productId,
        marketplace,
        status,
        publishedAt: new Date(),
        hashAtPublish: contentHash,
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
