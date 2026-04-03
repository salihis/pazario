// src/MarketplacePipeline.ts

import { PrismaClient } from '@prisma/client'
import { XMLParser } from './parser/XMLParser'
import { ProductValidator } from './validators/ProductValidator'
import { ChangeDetectionService } from './services/ChangeDetectionService'
import { PriceEngine, type Marketplace } from './services/PriceEngine'
import { CategoryMappingService } from './services/CategoryMappingService'
import { publishQueue, notifyQueue } from './queue/queues'

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

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

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const PUBLISH_BATCH_SIZE = 100
const ERROR_RATE_THRESHOLD = 0.2  // %20 hata → Slack bildirimi

// ─── PIPELINE ────────────────────────────────────────────────────────────────

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
      process.stdout.write('SIGTERM alındı — aktif işlem tamamlanıyor...\n')
      this.isShuttingDown = true
    })
  }

  /**
   * Pipeline'ı uçtan uca çalıştırır
   * syncJobId: mevcut sync_jobs kaydının ID'si
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
      // ── 1. Sync job ve kaynak bilgisini çek ──────────────────────────────
      const syncJob = await this.prisma.syncJob.findUnique({
        where: { id: syncJobId },
        include: { source: true },
      })
      if (!syncJob) throw new Error(`SyncJob bulunamadı: ${syncJobId}`)

      const source = syncJob.source
      if (!source.active) throw new Error(`Kaynak pasif: ${source.id}`)

      // ── 2. XML çek ───────────────────────────────────────────────────────
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        source.fetchTimeoutSec * 1000
      )

      let xmlContent: string
      try {
        const response = await fetch(source.url, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${source.url}`)
        xmlContent = await response.text()
      } finally {
        clearTimeout(timeout)
      }

      // ── 3. Parse et ──────────────────────────────────────────────────────
      const parseResult = await this.parser.parse(xmlContent)
      totalFetched = parseResult.products.length

      if (parseResult.errors.some(e => e.type === 'ERROR')) {
        throw new Error(`XML parse hatası: ${parseResult.errors[0].message}`)
      }

      // ── 4. Değişim tespiti ───────────────────────────────────────────────
      if (this.isShuttingDown) return this.buildResult(syncJobId, startTime, { totalFetched, newProducts, changedProducts, unchanged, published, failed, skippedValidation })

      const changeResult = await this.changeDetector.detect(source.id, parseResult.products)
      newProducts = changeResult.newProducts.length
      changedProducts = changeResult.changedProducts.length
      unchanged = changeResult.unchangedIds.length

      // Değişen ve yeni ürünleri DB'ye yaz
      await this.changeDetector.applyChanges(source.id, changeResult, syncJobId)

      // ── 5. İşlenecek ürünler ─────────────────────────────────────────────
      const toProcess = [
        ...changeResult.newProducts,
        ...changeResult.changedProducts.map(c => c.product),
      ]

      // ── 6. Her ürün için validate + fiyat + kategori + kuyruğa al ────────
      const publishJobs: { productId: string; marketplace: Marketplace; syncJobId: string }[] = []

      for (const product of toProcess) {
        if (this.isShuttingDown) break

        // DB'deki gerçek UUID'yi bul
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

        // Geçerli pazaryerleri için kuyruğa al
        for (const mp of validMarketplaces) {
          publishJobs.push({
            productId: dbProduct.id,
            marketplace: mp,
            syncJobId,
          })
          published++
        }
      }

      // ── 7. Publish kuyruğuna batch ekle ──────────────────────────────────
      const chunks = this.chunkArray(publishJobs, PUBLISH_BATCH_SIZE)
      for (const chunk of chunks) {
        await Promise.all(
          chunk.map(job =>
            publishQueue.add(`publish-${job.productId}-${job.marketplace}`, job)
          )
        )
      }

      // ── 8. Hata oranı kontrolü ───────────────────────────────────────────
      const errorRate = totalFetched > 0 ? failed / totalFetched : 0
      if (errorRate > ERROR_RATE_THRESHOLD) {
        await notifyQueue.add('high-error-rate', {
          type: 'slack',
          message: `⚠️ Yüksek hata oranı: %${Math.round(errorRate * 100)} — Kaynak: ${source.name}`,
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
   * PipelineResult objesi oluşturur
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
   * Array'i belirli boyutta parçalara böler
   */
  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }
}