// src/MarketplacePipeline.ts

import { PrismaClient } from '@prisma/client'
import { XMLParser, buildParseOptionsForSource } from './parser/XMLParser'
import { ProductValidator } from './validators/ProductValidator'
import { ChangeDetectionService } from './services/ChangeDetectionService'
import { PriceEngine, type Marketplace } from './services/PriceEngine'
import { CategoryMappingService } from './services/CategoryMappingService'
import { publishQueue, notifyQueue } from './queue/queues'
import { fetchXml } from './utils/xmlFetch'
import { logger } from './utils/logger'

// â”€â”€â”€ INTERFACE'LER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PipelineResult {
  syncJobId: string
  totalFetched: number
  newProducts: number
  changedProducts: number
  unchanged: number
  published: number
  failed: number
  skippedValidation: number
  durationMs: number
}

// â”€â”€â”€ SABÄ°TLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'N11', 'PAZARAMA']
const PUBLISH_BATCH_SIZE = 100
const AUTO_PUBLISH_ON_SYNC = process.env.AUTO_PUBLISH_ON_SYNC === 'true'

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

function categoryMatchesFilter(category: string | null | undefined, keywords: string | null | undefined): boolean {
  const terms = parseCategoryIncludeKeywords(keywords)
  if (terms.length === 0) return true
  const normalizedCategory = normalizeCategoryFilterText(category ?? '')
  return terms.some(term => normalizedCategory.includes(term))
}
const ERROR_RATE_THRESHOLD = 0.2  // %20 hata â†’ Slack bildirimi

// â”€â”€â”€ PIPELINE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class MarketplacePipeline {
  private readonly parser: XMLParser
  private readonly validator: typeof ProductValidator
  private readonly changeDetector: ChangeDetectionService
  private readonly priceEngine: PriceEngine
  private readonly categoryMapper: CategoryMappingService
  private isShuttingDown = false

  constructor(private readonly prisma: PrismaClient) {
    this.parser = new XMLParser()
    this.validator = ProductValidator
    this.changeDetector = new ChangeDetectionService(prisma)
    this.priceEngine = new PriceEngine(prisma)
    this.categoryMapper = new CategoryMappingService(prisma)

    // Graceful shutdown
    process.on('SIGTERM', () => {
      process.stdout.write('SIGTERM alÄ±ndÄ± â€” aktif iÅŸlem tamamlanÄ±yor...\n')
      this.isShuttingDown = true
    })
  }

  /**
   * Pipeline'Ä± uÃ§tan uca Ã§alÄ±ÅŸtÄ±rÄ±r
   * syncJobId: mevcut sync_jobs kaydÄ±nÄ±n ID'si
   */
  async run(syncJobId: string): Promise<PipelineResult> {
    const startTime = Date.now()
    let totalFetched = 0
    let newProducts = 0
    let changedProducts = 0
    let unchanged = 0
    let published = 0
    let failed = 0
    let skippedValidation = 0

    try {
      // â”€â”€ 1. Sync job ve kaynak bilgisini Ã§ek â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const syncJob = await this.prisma.syncJob.findUnique({
        where: { id: syncJobId },
        include: { source: true },
      })
      if (!syncJob) throw new Error(`SyncJob bulunamadÄ±: ${syncJobId}`)

      const source = syncJob.source
      if (!source.active) throw new Error(`Kaynak pasif: ${source.id}`)

      // â”€â”€ 2. XML Ã§ek â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      let xmlContent: string
      try {
        xmlContent = await fetchXml(source.url, source.fetchTimeoutSec * 1000)
      } catch (error) {
        if (!source.fallbackUrl) throw error
        logger.warn(
          { err: error, sourceId: source.id, sourceName: source.name, fallbackUrl: source.fallbackUrl },
          'XML ana URL okunamadi, yedek kaynak deneniyor'
        )
        xmlContent = await fetchXml(source.fallbackUrl, source.fetchTimeoutSec * 1000)
      }

      // â”€â”€ 3. Parse et â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const parseResult = await this.parser.parse(xmlContent, buildParseOptionsForSource(source))
      const filteredProducts = parseResult.products.filter(product =>
        categoryMatchesFilter(product.category, source.categoryIncludeKeywords)
      )
      totalFetched = filteredProducts.length

      if (parseResult.errors.some(e => e.type === 'ERROR')) {
        throw new Error(`XML parse hatasÄ±: ${parseResult.errors[0].message}`)
      }

      // â”€â”€ 4. DeÄŸiÅŸim tespiti â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (this.isShuttingDown) return this.buildResult(syncJobId, startTime, { totalFetched, newProducts, changedProducts, unchanged, published, failed, skippedValidation })

      const changeResult = await this.changeDetector.detect(source.id, filteredProducts, {
        categoryIncludeKeywords: source.categoryIncludeKeywords,
      })
      newProducts = changeResult.newProducts.length
      changedProducts = changeResult.changedProducts.length
      unchanged = changeResult.unchangedIds.length

      // DeÄŸiÅŸen ve yeni Ã¼rÃ¼nleri DB'ye yaz
      await this.changeDetector.applyChanges(source.id, changeResult, syncJobId)

      // â”€â”€ 5. Ä°ÅŸlenecek Ã¼rÃ¼nler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const toProcess = [
        ...changeResult.newProducts,
        ...changeResult.changedProducts.map(c => c.product),
      ]

      // â”€â”€ 6. Her Ã¼rÃ¼n iÃ§in validate + fiyat + kategori + kuyruÄŸa al â”€â”€â”€â”€â”€â”€â”€â”€
      const publishJobs: { productId: string; marketplace: Marketplace; syncJobId: string }[] = []

      for (const product of toProcess) {
        if (this.isShuttingDown) break

        // DB'deki gerÃ§ek UUID'yi bul
        const dbProduct = await this.prisma.product.findUnique({
          where: { sourceId_externalId: { sourceId: source.id, externalId: product.id } },
          select: { id: true },
        })
        if (!dbProduct) continue

        // Validasyon
        const validationResults = this.validator.validateAll(product, MARKETPLACES)
        const validMarketplaces = MARKETPLACES.filter(
          mp => validationResults[mp]?.valid
        )

        if (validMarketplaces.length === 0) {
          skippedValidation++
          failed++

          // Hata kaydet
          await this.prisma.publishError.create({
            data: {
              jobId: syncJobId,
              productId: dbProduct.id,
              marketplace: 'ALL',
              errorType: 'VALIDATION',
              errorMessage: Object.entries(validationResults)
                .map(([mp, r]) => `${mp}: ${r.errors.join(', ')}`)
                .join(' | '),
            },
          })
          continue
        }

        // XML senkronizasyonu varsayilan olarak sadece DB'yi gunceller.
        // Pazaryerine gonderim urunler ekranindaki manuel kontrol/gonder akisi ile yapilir.
        if (!AUTO_PUBLISH_ON_SYNC) continue

        // GeÃ§erli pazaryerleri iÃ§in kuyruÄŸa al
        for (const mp of validMarketplaces) {
          const existingListing = await this.prisma.marketplaceListing.findUnique({
            where: { productId_marketplace: { productId: dbProduct.id, marketplace: mp } },
            select: { status: true, hashAtPublish: true },
          })
          if (existingListing?.status === 'PUBLISHED' && existingListing.hashAtPublish === product.contentHash) {
            continue
          }

          publishJobs.push({
            productId: dbProduct.id,
            marketplace: mp,
            syncJobId,
          })
          published++
        }
      }

      // â”€â”€ 7. Publish kuyruÄŸuna batch ekle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (AUTO_PUBLISH_ON_SYNC) {
        const chunks = this.chunkArray(publishJobs, PUBLISH_BATCH_SIZE)
        for (const chunk of chunks) {
          await Promise.all(
            chunk.map(job =>
              publishQueue.add(`publish-${job.productId}-${job.marketplace}`, job, { priority: 10 })
            )
          )
        }
      }

      // â”€â”€ 8. Hata oranÄ± kontrolÃ¼ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const errorRate = totalFetched > 0 ? failed / totalFetched : 0
      if (errorRate > ERROR_RATE_THRESHOLD) {
        await notifyQueue.add('high-error-rate', {
          type: 'slack',
          message: `âš ï¸ YÃ¼ksek hata oranÄ±: %${Math.round(errorRate * 100)} â€” Kaynak: ${source.name}`,
          level: 'warn',
        })
      }

      return this.buildResult(syncJobId, startTime, {
        totalFetched, newProducts, changedProducts,
        unchanged, published, failed, skippedValidation,
      })
    } catch (e) {
      // sync_jobs FAILED
      await this.prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: e instanceof Error ? e.message : String(e),
        },
      })
      throw e
    }
  }

  /**
   * PipelineResult objesi oluÅŸturur
   */
  private buildResult(
    syncJobId: string,
    startTime: number,
    counts: {
      totalFetched: number
      newProducts: number
      changedProducts: number
      unchanged: number
      published: number
      failed: number
      skippedValidation: number
    }
  ): PipelineResult {
    return {
      syncJobId,
      durationMs: Date.now() - startTime,
      ...counts,
    }
  }

  /**
   * Array'i belirli boyutta parÃ§alara bÃ¶ler
   */
  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }
}

