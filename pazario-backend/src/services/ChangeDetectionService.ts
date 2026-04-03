// src/services/ChangeDetectionService.ts

import { PrismaClient } from '@prisma/client'
import type { ParsedProduct } from '../parser/XMLParser'

// ─── HATA SINIFI ─────────────────────────────────────────────────────────────

export class ChangeDetectionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'ChangeDetectionError'
  }
}

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export interface ChangeDetectionResult {
  newProducts: ParsedProduct[]
  changedProducts: Array<{ product: ParsedProduct; existingId: string }>
  unchangedIds: string[]
  deletedExternalIds: string[]
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 500

// ─── SERVİS ───────────────────────────────────────────────────────────────────

export class ChangeDetectionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Gelen ürünleri DB'deki mevcut ürünlerle karşılaştırır
   * Tek sorguda tüm hash'leri çeker — N+1 sorgu yok
   */
  async detect(
    sourceId: string,
    incomingProducts: ParsedProduct[]
  ): Promise<ChangeDetectionResult> {
    try {
      // ── 1. DB'den tüm hash'leri tek sorguda çek ──────────────────────────
      const existingRows = await this.prisma.product.findMany({
        where: { sourceId },
        select: {
          id: true,
          externalId: true,
          contentHash: true,
        },
      })

      // externalId → { id, contentHash } map'i
      const existingMap = new Map<string, { id: string; contentHash: string }>(
        existingRows.map(r => [r.externalId, { id: r.id, contentHash: r.contentHash }])
      )

      // ── 2. Gelen ürünleri sınıflandır ────────────────────────────────────
      const newProducts: ParsedProduct[] = []
      const changedProducts: Array<{ product: ParsedProduct; existingId: string }> = []
      const unchangedIds: string[] = []
      const seenExternalIds = new Set<string>()

      for (const product of incomingProducts) {
        seenExternalIds.add(product.id)
        const existing = existingMap.get(product.id)

        if (!existing) {
          // DB'de yok → YENİ
          newProducts.push(product)
        } else if (existing.contentHash !== product.contentHash) {
          // Hash farklı → DEĞİŞMİŞ
          changedProducts.push({ product, existingId: existing.id })
        } else {
          // Hash aynı → DEĞİŞMEMİŞ
          unchangedIds.push(existing.id)
        }
      }

      // ── 3. DB'de var ama XML'de yok → SİLİNMİŞ ──────────────────────────
      const deletedExternalIds = existingRows
        .filter(r => !seenExternalIds.has(r.externalId))
        .map(r => r.externalId)

      // ── 4. Değişmeyenlerin lastSeenAt'ini batch güncelle ─────────────────
      await this.updateLastSeenBatch(unchangedIds)

      return {
        newProducts,
        changedProducts,
        unchangedIds,
        deletedExternalIds,
      }
    } catch (e) {
      throw new ChangeDetectionError(
        `Değişim tespiti başarısız: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
  }

  /**
   * Değişmeyen ürünlerin lastSeenAt alanını batch olarak günceller
   * Batch size: 500 (yapılandırılabilir)
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
   * Yeni ve değişen ürünleri DB'ye batch upsert ile yazar
   * Prisma transaction içinde çalışır
   */
  async applyChanges(
    sourceId: string,
    result: ChangeDetectionResult,
    syncJobId: string
  ): Promise<{ created: number; updated: number }> {
    let created = 0
    let updated = 0

    const now = new Date()

    // ── Yeni ürünler — batch createMany ──────────────────────────────────
    const newChunks = this.chunkArray(result.newProducts, BATCH_SIZE)
    for (const chunk of newChunks) {
      await this.prisma.$transaction(async (tx) => {
        for (const product of chunk) {
          await tx.product.create({
            data: {
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
            },
          })
          created++
        }
      })
    }

    // ── Değişen ürünler — batch updateMany ───────────────────────────────
    const changedChunks = this.chunkArray(result.changedProducts, BATCH_SIZE)
    for (const chunk of changedChunks) {
      await this.prisma.$transaction(async (tx) => {
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
      })
    }

    return { created, updated }
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