// src/api/controllers/price.controller.ts

import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { PriceEngine, roundUpToNinetyNine } from '../../services/PriceEngine'
import { calculatePurchaseCost } from '../../services/PurchaseCostService'
import { logger } from '../../utils/logger'
import { z } from 'zod'

const prisma = new PrismaClient()
const priceEngine = new PriceEngine(prisma)

// â”€â”€â”€ ÅEMALAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const createRuleSchema = z.object({
  name: z.string().min(1).max(150),
  marketplace: z.string().min(1).max(50),
  scopeType: z.enum(['GLOBAL', 'MARKETPLACE', 'CATEGORY', 'BRAND', 'PRODUCT']),
  scopeValue: z.string().max(500).optional(),
  priceStart: z.number().min(0).optional(),
  priceEnd: z.number().min(0).optional(),
  ekTutar: z.number().min(0).default(0),
  karOrani: z.number().min(1.0, 'Kar oranÄ± en az 1.0 olmalÄ±').max(9.9999),
  kargo: z.number().min(0).default(0),
  komisyonOrani: z.number().min(0).max(0.99, 'Komisyon oranÄ± en fazla 0.99 olabilir'),
  priority: z.number().int().positive(),
})

export const simulateSchema = z.object({
  basePrice: z.number().positive(),
  ekTutar: z.number().min(0),
  karOrani: z.number().min(1.0, 'Kar oranÄ± en az 1.0 olmalÄ±'),
  kargo: z.number().min(0),
  komisyonOrani: z.number().min(0).max(0.99, 'Komisyon oranÄ± en fazla 0.99 olabilir'),
})

// â”€â”€â”€ CONTROLLER FONKSÄ°YONLARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * GET /price-rules
 * Fiyat kurallarÄ±nÄ± listeler
 */
export async function getRules(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '25'))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (req.query.marketplace) where.marketplace = req.query.marketplace
    if (req.query.scopeType) where.scopeType = req.query.scopeType
    if (req.query.active !== undefined) where.active = req.query.active === 'true'

    const [data, total] = await Promise.all([
      prisma.priceRule.findMany({
        where,
        orderBy: { priority: 'asc' },
        skip,
        take: limit,
      }),
      prisma.priceRule.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasÄ±' })
  }
}

/**
 * POST /price-rules
 * Yeni fiyat kuralÄ± oluÅŸturur
 */
export async function createRule(req: Request, res: Response) {
  try {
    const rule = await prisma.priceRule.create({ data: req.body })
    res.status(201).json({ success: true, data: rule })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Kural oluÅŸturulamadÄ±' })
  }
}

/**
 * PUT /price-rules/:ruleId
 * Fiyat kuralÄ±nÄ± gÃ¼nceller
 */
export async function updateRule(req: Request, res: Response) {
  try {
    const rule = await prisma.priceRule.update({
      where: { id: req.params.ruleId },
      data: req.body,
    })
    res.json({ success: true, data: rule })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Kural bulunamadÄ±' })
  }
}

/**
 * DELETE /price-rules/:ruleId
 * Soft delete â€” active=false yapar
 */
export async function deleteRule(req: Request, res: Response) {
  try {
    await prisma.priceRule.update({
      where: { id: req.params.ruleId },
      data: { active: false },
    })
    res.json({ success: true })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Kural bulunamadÄ±' })
  }
}

/**
 * POST /price-rules/simulate
 * DB kaydÄ± oluÅŸturmadan fiyat simÃ¼le eder
 */
export async function simulatePrice(req: Request, res: Response) {
  try {
    const { basePrice, ekTutar, karOrani, kargo, komisyonOrani } = req.body

    const ara1BaseEk = basePrice + ekTutar
    const ara2Kar = ara1BaseEk * karOrani
    const ara3Kargo = ara2Kar + kargo
    const rawPrice = ara3Kargo / (1 - komisyonOrani)
    const roundedRawPrice = Math.round(rawPrice * 100) / 100

    // Global min fiyat kontrolÃ¼
    const globalSetting = await prisma.globalPriceSetting.findFirst()
    const minPrice = globalSetting ? Number(globalSetting.minPrice) : 0
    const minPriceApplied = roundedRawPrice < minPrice
    const finalPrice = roundUpToNinetyNine(Math.max(roundedRawPrice, minPrice))

    res.json({
      success: true,
      data: {
        ara1BaseEk: Math.round(ara1BaseEk * 100) / 100,
        ara2Kar: Math.round(ara2Kar * 100) / 100,
        ara3Kargo: Math.round(ara3Kargo * 100) / 100,
        rawPrice: Math.round(rawPrice * 100) / 100,
        finalPrice,
        minPriceApplied,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'SimÃ¼lasyon hatasÄ±' })
  }
}

/**
 * GET /price-rules/preview/:productId
 * ÃœrÃ¼n iÃ§in 4 pazaryeri fiyatÄ±nÄ± hesaplar
 */
export async function previewProductPrice(req: Request, res: Response) {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.productId },
      include: {
        source: {
          select: {
            priceIncludesVat: true,
            purchaseVatRate: true,
            purchaseExtraFee: true,
          },
        },
      },
    })
    if (!product) {
      res.status(404).json({ success: false, error: 'ÃœrÃ¼n bulunamadÄ±' })
      return
    }

    interface PricePreviewResult {
      marketplace: string
      ruleName: string | null
      finalPrice: number | null
      minApplied: boolean
      error?: string
    }

    const marketplaces = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA'] as const
    const results: PricePreviewResult[] = []

    const basePrice = calculatePurchaseCost(product.price, product.source)
    for (const mp of marketplaces) {
      try {
        const calc = await priceEngine.calculate({
          basePrice,
          marketplace: mp,
          productId: product.id,
          syncJobId: '00000000-0000-0000-0000-000000000000',
          brand: product.brand ?? undefined,
          category: product.categoryRaw ?? undefined,
        })
        results.push({
          marketplace: mp,
          ruleName: calc.ruleName,
          finalPrice: calc.finalPrice,
          minApplied: calc.minPriceApplied,
        })
      } catch (e) {
        results.push({
          marketplace: mp,
          ruleName: null,
          finalPrice: null,
          minApplied: false,
          error: e instanceof Error ? e.message : 'Hata',
        })
      }
    }

    res.json({
      success: true,
      data: {
        productId: product.id,
        basePrice,
        results,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasÄ±' })
  }
}

/**
 * GET /price-settings
 * Global minimum fiyat ayarÄ±nÄ± dÃ¶ndÃ¼rÃ¼r
 */
export async function getSettings(req: Request, res: Response) {
  try {
    const setting = await prisma.globalPriceSetting.findFirst()
    res.json({ success: true, data: setting ?? { minPrice: 50, currency: 'TRY' } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasÄ±' })
  }
}

/**
 * PUT /price-settings
 * Global minimum fiyatÄ± gÃ¼nceller
 */
export async function updateSettings(req: Request, res: Response) {
  try {
    const { minPrice } = req.body
    if (!minPrice || minPrice <= 0) {
      res.status(400).json({ success: false, error: 'GeÃ§ersiz minPrice' })
      return
    }

    const existing = await prisma.globalPriceSetting.findFirst()
    const setting = existing
      ? await prisma.globalPriceSetting.update({
          where: { id: existing.id },
          data: { minPrice },
        })
      : await prisma.globalPriceSetting.create({
          data: { minPrice, currency: 'TRY' },
        })

    // Arka planda: etkilenen listing'lerin hashAtPublish'ini sÄ±fÄ±rla
    // BÃ¶ylece bir sonraki sync'te yeniden fiyat hesaplanÄ±r
    prisma.marketplaceListing
      .updateMany({
        where: { hashAtPublish: { not: null } },
        data: { hashAtPublish: null },
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'hashAtPublish sÄ±fÄ±rlama hatasÄ±')
      })

    res.json({ success: true, data: setting ?? { minPrice: 50, currency: 'TRY' } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasÄ±' })
  }
}

/**
 * GET /price-calculations
 * Fiyat hesaplama audit loglarÄ±nÄ± listeler
 */
export async function getCalculations(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '25'))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (req.query.productId) where.productId = req.query.productId
    if (req.query.marketplace) where.marketplace = req.query.marketplace
    if (req.query.syncJobId) where.syncJobId = req.query.syncJobId

    const [data, total] = await Promise.all([
      prisma.priceCalculation.findMany({
        where,
        orderBy: { calculatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.priceCalculation.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasÄ±' })
  }
}
