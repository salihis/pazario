import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PriceEngine,
  PriceRuleNotFoundError,
  InvalidRuleError,
  PriceCalculationError,
} from '../services/PriceEngine'
import type { PrismaClient } from '@prisma/client'

// â”€â”€â”€ MOCK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    name: 'Test Kural',
    marketplace: '*',
    scopeType: 'GLOBAL',
    scopeValue: null,
    ekTutar: 10,
    karOrani: 1.25,
    kargo: 15,
    komisyonOrani: 0.15,
    priority: 1,
    active: true,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const mockPrisma = {
  priceRule: {
    findMany: vi.fn(),
  },
  globalPriceSetting: {
    findFirst: vi.fn(),
  },
  priceCalculation: {
    create: vi.fn(),
  },
} as unknown as PrismaClient

describe('PriceEngine', () => {
  let engine: PriceEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new PriceEngine(mockPrisma)
    // VarsayÄ±lan: global min fiyat yok, audit log baÅŸarÄ±lÄ±
    ;(mockPrisma.globalPriceSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(mockPrisma.priceCalculation.create as ReturnType<typeof vi.fn>).mockResolvedValue({})
  })

  // â”€â”€â”€ FORMÃœL DOÄRULUÄU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('temel formÃ¼l: base=200, ek=10, kar=1.25, kargo=15, kom=0.15 â†’ 326.99', async () => {
    // ara1 = 200 + 10 = 210
    // ara2 = 210 * 1.25 = 262.5
    // ara3 = 262.5 + 15 = 277.5
    // raw  = 277.5 / 0.85 = 326.9905...
    // final = 326.99
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRule({ scopeType: 'GLOBAL', ekTutar: 10, karOrani: 1.25, kargo: 15, komisyonOrani: 0.15 }),
    ])

    const result = await engine.calculate({
      basePrice: 200,
      marketplace: 'TRENDYOL',
      productId: 'prod-1',
      syncJobId: 'job-1',
    })

    expect(result.ara1BaseEk).toBe(210)
    expect(result.ara2Kar).toBe(262.5)
    expect(result.ara3Kargo).toBe(277.5)
    expect(result.finalPrice).toBe(326.99)
  })

  it('komisyon bÃ¶lme ile hesaplanÄ±r â€” Ã§arpma deÄŸil (277.50 / 0.85 = 326.99, not 318.63)', async () => {
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRule({ scopeType: 'GLOBAL', ekTutar: 0, karOrani: 1.0, kargo: 0, komisyonOrani: 0.15 }),
    ])

    // base=277.5, ek=0, kar=1.0, kargo=0, kom=0.15
    // BÃ¶lme: 277.5 / 0.85 = 326.99
    // Ã‡arpma olsaydÄ±: 277.5 * 1.15 = 319.12 (yanlÄ±ÅŸ)
    const result = await engine.calculate({
      basePrice: 277.5,
      marketplace: 'TRENDYOL',
      productId: 'prod-1',
      syncJobId: 'job-1',
    })

    expect(result.finalPrice).toBe(326.99)
    expect(result.finalPrice).not.toBe(319.13)
  })

  // â”€â”€â”€ GLOBAL MÄ°N FÄ°YAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('finalPrice < globalMinPrice â†’ minPriceApplied=true, finalPrice=minPrice', async () => {
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRule({ scopeType: 'GLOBAL', ekTutar: 0, karOrani: 1.0, kargo: 0, komisyonOrani: 0 }),
    ])
    ;(mockPrisma.globalPriceSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      minPrice: 100,
      currency: 'TRY',
    })

    const result = await engine.calculate({
      basePrice: 50,
      marketplace: 'TRENDYOL',
      productId: 'prod-1',
      syncJobId: 'job-1',
    })

    expect(result.minPriceApplied).toBe(true)
    expect(result.finalPrice).toBe(100.99)
  })

  it('finalPrice >= globalMinPrice â†’ minPriceApplied=false', async () => {
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRule({ scopeType: 'GLOBAL', ekTutar: 0, karOrani: 1.0, kargo: 0, komisyonOrani: 0 }),
    ])
    ;(mockPrisma.globalPriceSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      minPrice: 50,
      currency: 'TRY',
    })

    const result = await engine.calculate({
      basePrice: 200,
      marketplace: 'TRENDYOL',
      productId: 'prod-1',
      syncJobId: 'job-1',
    })

    expect(result.minPriceApplied).toBe(false)
    expect(result.finalPrice).toBe(200.99)
  })

  // â”€â”€â”€ HATA DURUMLARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('kural bulunamazsa PriceRuleNotFoundError fÄ±rlatmalÄ±', async () => {
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    await expect(
      engine.calculate({ basePrice: 100, marketplace: 'TRENDYOL', productId: 'prod-1', syncJobId: 'job-1' })
    ).rejects.toBeInstanceOf(PriceRuleNotFoundError)
  })

  it('kar_orani < 1.0 â†’ InvalidRuleError fÄ±rlatmalÄ±', async () => {
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRule({ scopeType: 'GLOBAL', karOrani: 0.8 }),
    ])

    await expect(
      engine.calculate({ basePrice: 100, marketplace: 'TRENDYOL', productId: 'prod-1', syncJobId: 'job-1' })
    ).rejects.toBeInstanceOf(InvalidRuleError)
  })

  it('basePrice <= 0 â†’ PriceCalculationError fÄ±rlatmalÄ±', async () => {
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRule({ scopeType: 'GLOBAL' }),
    ])

    await expect(
      engine.calculate({ basePrice: 0, marketplace: 'TRENDYOL', productId: 'prod-1', syncJobId: 'job-1' })
    ).rejects.toBeInstanceOf(PriceCalculationError)
  })

  // â”€â”€â”€ KURAL SEÃ‡Ä°MÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('PRODUCT scope kurali GLOBAL scope kurala gore once secilmeli', async () => {
    const productRule = makeRule({
      id: 'rule-product',
      name: 'ÃœrÃ¼n KuralÄ±',
      scopeType: 'PRODUCT',
      scopeValue: 'prod-1',
      karOrani: 1.5,
      priority: 1,
    })
    const globalRule = makeRule({
      id: 'rule-global',
      name: 'Global Kural',
      scopeType: 'GLOBAL',
      karOrani: 1.1,
      priority: 2,
    })
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      productRule,
      globalRule,
    ])

    const result = await engine.calculate({
      basePrice: 100,
      marketplace: 'TRENDYOL',
      productId: 'prod-1',
      syncJobId: 'job-1',
    })

    expect(result.ruleId).toBe('rule-product')
    expect(result.karOrani).toBe(1.5)
  })

  it('BRAND scope kurali GLOBAL scope kurala gore once, PRODUCT scope kurala gore sonra secilmeli', async () => {
    const brandRule = makeRule({
      id: 'rule-brand',
      name: 'Marka KuralÄ±',
      scopeType: 'BRAND',
      scopeValue: 'TestMarka',
      karOrani: 1.3,
      priority: 2,
    })
    const globalRule = makeRule({
      id: 'rule-global',
      scopeType: 'GLOBAL',
      karOrani: 1.1,
      priority: 5,
    })
    ;(mockPrisma.priceRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      brandRule,
      globalRule,
    ])

    const result = await engine.calculate({
      basePrice: 100,
      marketplace: 'TRENDYOL',
      productId: 'other-prod',
      syncJobId: 'job-1',
      brand: 'TestMarka',
    })

    expect(result.ruleId).toBe('rule-brand')
  })

  // â”€â”€â”€ ERROR SINIFLARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('PriceRuleNotFoundError mesaj formatÄ± doÄŸru olmalÄ±', () => {
    const err = new PriceRuleNotFoundError('TRENDYOL', 'prod-1')
    expect(err.message).toContain('TRENDYOL')
    expect(err.name).toBe('PriceRuleNotFoundError')
  })

  it('InvalidRuleError doÄŸru mesajla oluÅŸturulmalÄ±', () => {
    const err = new InvalidRuleError('kar_orani geÃ§ersiz')
    expect(err.message).toBe('kar_orani geÃ§ersiz')
    expect(err.name).toBe('InvalidRuleError')
  })
})

