// src/services/PriceEngine.ts

import { PrismaClient } from '@prisma/client'

// ─── HATA SINIFLARI ──────────────────────────────────────────────────────────

export class PriceCalculationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'PriceCalculationError'
  }
}

export class PriceRuleNotFoundError extends Error {
  constructor(marketplace: string, productId: string) {
    super(`No price rule found for marketplace=${marketplace}, productId=${productId}`)
    this.name = 'PriceRuleNotFoundError'
  }
}

export class InvalidRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRuleError'
  }
}

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'

export interface PriceInput {
  basePrice: number
  marketplace: Marketplace
  productId: string
  syncJobId: string
  brand?: string
  category?: string
}

export interface PriceCalculationResult {
  ruleId: string
  ruleName: string
  basePrice: number
  ekTutar: number
  karOrani: number
  kargo: number
  komisyonOrani: number
  ara1BaseEk: number
  ara2Kar: number
  ara3Kargo: number
  rawPrice: number
  minPriceApplied: boolean
  finalPrice: number
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const ROUND_FACTOR = 100 // 2 ondalık basamak için

export function roundUpToNinetyNine(price: number): number {
  const wholePart = Math.floor(price)
  const lowerCandidate = wholePart + 0.99
  if (price <= lowerCandidate + 1e-9) {
    return Number(lowerCandidate.toFixed(2))
  }
  return Number((wholePart + 1.99).toFixed(2))
}

// ─── FİYAT MOTORU ────────────────────────────────────────────────────────────

export class PriceEngine {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Tek ürün için fiyat hesaplar
   * Formül: ROUND(((base + ek) * kar + kargo) / (1 - komisyon), 2)
   */
  async calculate(input: PriceInput): Promise<PriceCalculationResult> {
    const { basePrice, marketplace, productId, syncJobId, brand, category } = input

    if (basePrice <= 0) {
      throw new PriceCalculationError(`Geçersiz base fiyat: ${basePrice}`)
    }

    // ── 1. Uygun kuralı bul (first-match-wins, priority ASC) ─────────────
    const rule = await this.findRule(marketplace, productId, basePrice, brand, category)
    if (!rule) {
      throw new PriceRuleNotFoundError(marketplace, productId)
    }

    // ── 2. Kural validasyonu ──────────────────────────────────────────────
    const karOrani = Number(rule.karOrani)
    const komisyonOrani = Number(rule.komisyonOrani)
    const ekTutar = Number(rule.ekTutar)
    const kargo = Number(rule.kargo)

    if (karOrani < 1.0) {
      throw new InvalidRuleError(`kar_orani 1.0'dan küçük olamaz: ${karOrani}`)
    }
    if (komisyonOrani >= 1.0) {
      throw new InvalidRuleError(`komisyon_orani 1.0'dan büyük/eşit olamaz: ${komisyonOrani}`)
    }

    // ── 3. Formül adım adım ───────────────────────────────────────────────
    const ara1BaseEk = basePrice + ekTutar
    const ara2Kar = ara1BaseEk * karOrani
    const ara3Kargo = ara2Kar + kargo
    const rawPrice = ara3Kargo / (1 - komisyonOrani)
    const roundedRawPrice = Math.round(rawPrice * ROUND_FACTOR) / ROUND_FACTOR
    let finalPrice = roundUpToNinetyNine(roundedRawPrice)

    if (finalPrice <= 0) {
      throw new PriceCalculationError(`Hesaplanan fiyat sıfır veya negatif: ${finalPrice}`)
    }

    // ── 4. Global minimum fiyat kontrolü ─────────────────────────────────
    let minPriceApplied = false
    const globalSetting = await this.prisma.globalPriceSetting.findFirst()
    if (globalSetting) {
      const minPrice = Number(globalSetting.minPrice)
      if (roundedRawPrice < minPrice) {
        minPriceApplied = true
      }
      if (finalPrice < minPrice) {
        finalPrice = roundUpToNinetyNine(minPrice)
      }
    }

    const result: PriceCalculationResult = {
      ruleId: rule.id,
      ruleName: rule.name,
      basePrice,
      ekTutar,
      karOrani,
      kargo,
      komisyonOrani,
      ara1BaseEk,
      ara2Kar,
      ara3Kargo,
      rawPrice: roundedRawPrice,
      minPriceApplied,
      finalPrice,
    }

    // ── 5. Audit log kaydet ───────────────────────────────────────────────
    await this.prisma.priceCalculation.create({
      data: {
        productId,
        marketplace,
        ruleId: rule.id,
        syncJobId,
        basePrice,
        ekTutar,
        karOrani,
        kargo,
        komisyonOrani,
        ara1BaseEk,
        ara2Kar,
        ara3Kargo,
        rawPrice: result.rawPrice,
        minPriceApplied,
        finalPrice,
      },
    })

    return result
  }

  /**
   * Birden fazla ürün × pazaryeri için batch hesaplama
   */
  async calculateBatch(
    inputs: PriceInput[]
  ): Promise<Map<string, PriceCalculationResult>> {
    const results = new Map<string, PriceCalculationResult>()

    await Promise.allSettled(
      inputs.map(async (input) => {
        try {
          const result = await this.calculate(input)
          const key = `${input.productId}:${input.marketplace}`
          results.set(key, result)
        } catch (e) {
          // Hata loglama — bireysel hata tüm batch'i durdurmasın
          const key = `${input.productId}:${input.marketplace}`
          results.set(key, this.errorResult(e))
        }
      })
    )

    return results
  }

  /**
   * Kural seçimi: PRODUCT > BRAND > CATEGORY > MARKETPLACE > GLOBAL
   * first-match-wins, priority ASC
   */
  private async findRule(
    marketplace: string,
    productId: string,
    basePrice: number,
    brand?: string,
    category?: string
  ) {
    // Tüm aktif kuralları priority sırasıyla çek
    const rules = await this.prisma.priceRule.findMany({
      where: {
        active: true,
        OR: [
          { marketplace },
          { marketplace: '*' },
        ],
      },
      orderBy: { priority: 'asc' },
    })

    const matchesRange = (rule: { priceStart: unknown; priceEnd: unknown }) => {
      const start = rule.priceStart === null ? null : Number(rule.priceStart)
      const end = rule.priceEnd === null ? null : Number(rule.priceEnd)
      if (start !== null && basePrice < start) return false
      if (end !== null && basePrice >= end) return false
      return true
    }

    const scopedRules = rules.filter(matchesRange)

    // PRODUCT scope
    const productRule = scopedRules.find(
      r => r.scopeType === 'PRODUCT' && r.scopeValue === productId
    )
    if (productRule) return productRule

    // BRAND scope
    if (brand) {
      const brandRule = scopedRules.find(
        r => r.scopeType === 'BRAND' && r.scopeValue === brand
      )
      if (brandRule) return brandRule
    }

    // CATEGORY scope (LIKE '%value%')
    if (category) {
      const categoryRule = scopedRules.find(
        r => r.scopeType === 'CATEGORY' &&
          r.scopeValue &&
          category.includes(r.scopeValue)
      )
      if (categoryRule) return categoryRule
    }

    // MARKETPLACE scope
    const marketplaceRule = scopedRules.find(
      r => r.scopeType === 'MARKETPLACE' && r.marketplace === marketplace
    )
    if (marketplaceRule) return marketplaceRule

    // GLOBAL scope
    const globalRule = scopedRules.find(r => r.scopeType === 'GLOBAL')
    return globalRule ?? null
  }

  /**
   * Hata durumunda dönecek boş sonuç
   */
  private errorResult(e: unknown): PriceCalculationResult {
    return {
      ruleId: '',
      ruleName: 'ERROR',
      basePrice: 0,
      ekTutar: 0,
      karOrani: 1,
      kargo: 0,
      komisyonOrani: 0,
      ara1BaseEk: 0,
      ara2Kar: 0,
      ara3Kargo: 0,
      rawPrice: 0,
      minPriceApplied: false,
      finalPrice: 0,
    }
  }
}
