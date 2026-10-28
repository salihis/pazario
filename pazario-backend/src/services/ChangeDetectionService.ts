// src/services/ChangeDetectionService.ts

import { PrismaClient } from '@prisma/client'
import type { ParsedProduct } from '../parser/XMLParser'

// â”€â”€â”€ HATA SINIFI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class ChangeDetectionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'ChangeDetectionError'
  }
}

// â”€â”€â”€ INTERFACE'LER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ChangeDetectionResult {
  newProducts: ParsedProduct[]
  changedProducts: Array<{ product: ParsedProduct; existingId: string }>
  unchangedIds: string[]
  deletedExternalIds: string[]
}

// â”€â”€â”€ SABÄ°TLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const BATCH_SIZE = 500

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

// â”€â”€â”€ SERVÄ°S â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class ChangeDetectionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Gelen Ã¼rÃ¼nleri DB'deki mevcut Ã¼rÃ¼nlerle karÅŸÄ±laÅŸtÄ±rÄ±r
   * Tek sorguda tÃ¼m hash'leri Ã§eker â€” N+1 sorgu yok
   */
  async detect(
    sourceId: string,
    incomingProducts: ParsedProduct[],
    options: { categoryIncludeKeywords?: string | null } = {}
  ): Promise<ChangeDetectionResult> {
    try {
      // â”€â”€ 1. DB'den tÃ¼m hash'leri tek sorguda Ã§ek â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const existingRows = await this.prisma.product.findMany({
        where: { sourceId },
        select: {
          id: true,
          externalId: true,
          contentHash: true,
          stock: true,
          categoryRaw: true,
          images: true,
        },
      })
      const existingRowsInScope = existingRows.filter(row =>
        categoryMatchesFilter(row.categoryRaw, options.categoryIncludeKeywords)
      )

      // externalId â†’ { id, contentHash } map'i
      const existingMap = new Map<string, { id: string; contentHash: string; stock: number; images: string[] }>(
        existingRowsInScope.map(r => [r.externalId, { id: r.id, contentHash: r.contentHash, stock: r.stock, images: r.images }])
      )

      // â”€â”€ 2. Gelen Ã¼rÃ¼nleri sÄ±nÄ±flandÄ±r â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const newProducts: ParsedProduct[] = []
      const changedProducts: Array<{ product: ParsedProduct; existingId: string }> = []
      const unchangedIds: string[] = []
      const seenExternalIds = new Set<string>()

      for (const product of incomingProducts) {
        seenExternalIds.add(product.id)
        const existing = existingMap.get(product.id)

        if (!existing) {
          // DB'de yok â†’ YENÄ°
          newProducts.push(product)
        } else if (
          existing.contentHash !== product.contentHash
          || (typeof existing.stock === 'number' && existing.stock !== product.stock)
          || (Array.isArray(existing.images) && JSON.stringify(existing.images) !== JSON.stringify(product.images))
        ) {
          // Hash farklÄ± â†’ DEÄÄ°ÅMÄ°Å
          changedProducts.push({ product, existingId: existing.id })
        } else {
          // Hash aynÄ± â†’ DEÄÄ°ÅMEMÄ°Å
          unchangedIds.push(existing.id)
        }
      }

      // â”€â”€ 3. DB'de var ama XML'de yok â†’ SÄ°LÄ°NMÄ°Å â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const deletedExternalIds = existingRowsInScope
        .filter(r => !seenExternalIds.has(r.externalId))
        .map(r => r.externalId)

      // â”€â”€ 4. DeÄŸiÅŸmeyenlerin lastSeenAt'ini batch gÃ¼ncelle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      await this.updateLastSeenBatch(unchangedIds)

      return {
        newProducts,
        changedProducts,
        unchangedIds,
        deletedExternalIds,
      }
    } catch (e) {
      throw new ChangeDetectionError(
        `DeÄŸiÅŸim tespiti baÅŸarÄ±sÄ±z: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
  }

  /**
   * DeÄŸiÅŸmeyen Ã¼rÃ¼nlerin lastSeenAt alanÄ±nÄ± batch olarak gÃ¼nceller
   * Batch size: 500 (yapÄ±landÄ±rÄ±labilir)
   */
  private async updateLastSeenBatch(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return

    const now = new Date()
    const chunks = this.chunkArray(productIds, BATCH_SIZE)

    for (const chunk of chunks) {
      await this.prisma.product.updateMany({
        where: { id: { in: chunk } },
        data: { lastSeenAt: now },
      })
    }
  }

  /**
   * Yeni ve deÄŸiÅŸen Ã¼rÃ¼nleri DB'ye batch upsert ile yazar
   * Prisma transaction iÃ§inde Ã§alÄ±ÅŸÄ±r
   */
  async applyChanges(
    sourceId: string,
    result: ChangeDetectionResult,
    syncJobId: string
  ): Promise<{ created: number; updated: number }> {
    let created = 0
    let updated = 0

    const now = new Date()

    // â”€â”€ Yeni Ã¼rÃ¼nler â€” createMany ile batch insert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const newChunks = this.chunkArray(result.newProducts, BATCH_SIZE)
    for (const chunk of newChunks) {
      const insertResult = await this.prisma.product.createMany({
        data: chunk.map((product) => ({
          sourceId,
          externalId: product.id,
          sku: product.sku,
          barcode: product.barcode,
          title: product.title,
          description: product.description,
          brand: product.brand,
          categoryRaw: product.category,
          price: product.price,
          listPrice: product.listPrice,
          currency: product.currency,
          stock: product.stock,
          images: product.images,
          attributes: product.attributes,
          contentHash: product.contentHash,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      })
      created += insertResult.count
    }

    // â”€â”€ DeÄŸiÅŸen Ã¼rÃ¼nler â€” batch updateMany â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const changedChunks = this.chunkArray(result.changedProducts, BATCH_SIZE)
    for (const chunk of changedChunks) {
      await this.prisma.$transaction(
        async (tx) => {
          for (const { product, existingId } of chunk) {
            await tx.product.update({
              where: { id: existingId },
              data: {
                sku: product.sku,
                barcode: product.barcode,
                title: product.title,
                description: product.description,
                brand: product.brand,
                categoryRaw: product.category,
                price: product.price,
                listPrice: product.listPrice,
                currency: product.currency,
                stock: product.stock,
                images: product.images,
                attributes: product.attributes,
                contentHash: product.contentHash,
                lastSeenAt: now,
              },
            })
            updated++
          }
        },
        { maxWait: 10000, timeout: 60000 }
      )
    }

    const deletedChunks = this.chunkArray(result.deletedExternalIds, BATCH_SIZE)
    for (const chunk of deletedChunks) {
      const updateResult = await this.prisma.product.updateMany({
        where: {
          sourceId,
          externalId: { in: chunk },
          stock: { not: 0 },
        },
        data: {
          stock: 0,
          lastSeenAt: now,
        },
      })
      updated += updateResult.count
    }

    return { created, updated }
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

