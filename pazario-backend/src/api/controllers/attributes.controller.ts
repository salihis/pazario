// src/api/controllers/attributes.controller.ts

import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { CategoryAttributeService } from '../../services/CategoryAttributeService'
import { PublishService } from '../../services/PublishService'

const prisma = new PrismaClient()
const attrService = new CategoryAttributeService(prisma)
const publishService = new PublishService(prisma)

type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'

// ─── ÖZELLIK ENDPOINT'LERİ ───────────────────────────────────────────────────

/**
 * GET /category-attributes/:marketplace/:categoryId
 */
export async function getCategoryAttributes(req: Request, res: Response) {
  try {
    const { marketplace, categoryId } = req.params
    const productId = req.query.productId as string | undefined

    const result = await attrService.getAttributes(
      marketplace as Marketplace,
      categoryId,
      productId
    )

    res.set('Cache-Control', 'max-age=3600')
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /category-attributes/:marketplace/:categoryId/refresh
 */
export async function refreshCategoryAttributes(req: Request, res: Response) {
  try {
    const { marketplace, categoryId } = req.params
    attrService.refreshFromAPI(marketplace as Marketplace, categoryId).catch(() => {})
    res.status(202).json({ success: true, message: 'Yenileniyor...' })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /products/:productId/attributes/:marketplace
 */
export async function getProductAttributes(req: Request, res: Response) {
  try {
    const { productId, marketplace } = req.params
    const attrs = await prisma.productAttribute.findMany({
      where: { productId, marketplace: marketplace as Marketplace },
    })
    res.json({ success: true, data: attrs })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * PUT /products/:productId/attributes/:marketplace
 */
export async function saveProductAttributes(req: Request, res: Response) {
  try {
    const { productId, marketplace } = req.params
    const { attributes } = req.body as {
      attributes: { attributeId: string; valueId?: string; valueText?: string }[]
    }

    if (!Array.isArray(attributes)) {
      res.status(400).json({ success: false, error: 'attributes dizisi zorunlu' })
      return
    }

    // Validasyon
    const attrDefs = await prisma.marketplaceCategoryAttribute.findMany({
      where: {
        marketplace: marketplace as Marketplace,
        attributeId: { in: attributes.map(a => a.attributeId) },
      },
    })

    const errors: { attributeId: string; error: string }[] = []
    for (const attr of attributes) {
      const def = attrDefs.find(d => d.attributeId === attr.attributeId)
      if (!def) continue
      const value = attr.valueText ?? attr.valueId ?? null
      const validation = attrService.validateValue(
        {
          attributeId: def.attributeId,
          attributeName: def.attributeName,
          attributeType: def.attributeType as 'dropdown',
          isMandatory: def.isMandatory,
          allowCustomValue: def.allowCustomValue,
          values: (def.values as { id: string; name: string }[]) ?? [],
          validationRules: (def.validationRules as object) ?? {},
          displayOrder: def.displayOrder,
        },
        value
      )
      if (!validation.isValid) {
        errors.push({ attributeId: attr.attributeId, error: validation.error ?? 'Geçersiz' })
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ success: false, errors })
      return
    }

    // Upsert
    let saved = 0
    let updated = 0

    for (const attr of attributes) {
      const def = attrDefs.find(d => d.attributeId === attr.attributeId)
      const existing = await prisma.productAttribute.findUnique({
        where: {
          productId_marketplace_attributeId: {
            productId,
            marketplace: marketplace as Marketplace,
            attributeId: attr.attributeId,
          },
        },
      })

      if (existing) {
        await prisma.productAttribute.update({
          where: { id: existing.id },
          data: { valueId: attr.valueId ?? null, valueText: attr.valueText ?? null },
        })
        updated++
      } else {
        await prisma.productAttribute.create({
          data: {
            productId,
            marketplace: marketplace as Marketplace,
            attributeId: attr.attributeId,
            attributeName: def?.attributeName ?? null,
            valueId: attr.valueId ?? null,
            valueText: attr.valueText ?? null,
          },
        })
        saved++
      }
    }

    res.json({ success: true, saved, updated })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /products/attributes/bulk-apply
 */
export async function bulkApplyAttributes(req: Request, res: Response) {
  try {
    const { productIds, marketplace, attributes } = req.body as {
      productIds: string[]
      marketplace: Marketplace
      attributes: { attributeId: string; valueId?: string; valueText?: string }[]
    }

    if (!Array.isArray(productIds) || !Array.isArray(attributes)) {
      res.status(400).json({ success: false, error: 'productIds ve attributes zorunlu' })
      return
    }

    let applied = 0
    for (const productId of productIds) {
      for (const attr of attributes) {
        await prisma.productAttribute.upsert({
          where: {
            productId_marketplace_attributeId: {
              productId,
              marketplace,
              attributeId: attr.attributeId,
            },
          },
          update: {
            valueId: attr.valueId ?? null,
            valueText: attr.valueText ?? null,
            isInherited: true,
          },
          create: {
            productId,
            marketplace,
            attributeId: attr.attributeId,
            valueId: attr.valueId ?? null,
            valueText: attr.valueText ?? null,
            isInherited: true,
          },
        })
      }
      applied++
    }

    res.json({ success: true, applied, products: productIds })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /products/attributes/completeness
 */
export async function getCompleteness(req: Request, res: Response) {
  try {
    const marketplace = req.query.marketplace as Marketplace
    const productIds = req.query['productIds[]'] as string | string[]
    const ids = Array.isArray(productIds) ? productIds : [productIds].filter(Boolean)

    if (!marketplace || ids.length === 0) {
      res.status(400).json({ success: false, error: 'marketplace ve productIds zorunlu' })
      return
    }

    const results = await publishService.getCompleteness(ids, marketplace)
    res.json({ success: true, data: results })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

// ─── GÖNDERİM ENDPOINT'LERİ ──────────────────────────────────────────────────

/**
 * POST /publish/submit
 */
export async function submitPublish(req: Request, res: Response) {
  try {
    const { productIds, marketplace } = req.body as {
      productIds: string[]
      marketplace: Marketplace
    }

    if (!Array.isArray(productIds) || !marketplace) {
      res.status(400).json({ success: false, error: 'productIds ve marketplace zorunlu' })
      return
    }

    const result = await publishService.submitProducts(productIds, marketplace, 'admin')
    res.status(202).json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /publish/jobs
 */
export async function getPublishJobs(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '25'))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (req.query.status) where.status = req.query.status
    if (req.query.marketplace) where.marketplace = req.query.marketplace
    if (req.query.productId) where.productId = req.query.productId

    const [data, total] = await Promise.all([
      prisma.productPublishJob.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { product: { select: { title: true, sku: true } } },
      }),
      prisma.productPublishJob.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /publish/jobs/:jobId
 */
export async function getPublishJob(req: Request, res: Response) {
  try {
    const job = await prisma.productPublishJob.findUnique({
      where: { id: req.params.jobId },
      include: { product: true },
    })
    if (!job) { res.status(404).json({ success: false, error: 'Job bulunamadı' }); return }
    res.json({ success: true, data: job })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /publish/jobs/:jobId/retry
 */
export async function retryPublishJob(req: Request, res: Response) {
  try {
    await prisma.productPublishJob.update({
      where: { id: req.params.jobId },
      data: { status: 'QUEUED', attemptCount: 0, errorMessage: null },
    })
    res.status(202).json({ success: true })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Job bulunamadı' })
  }
}

/**
 * POST /publish/jobs/retry-failed
 */
export async function retryAllFailed(req: Request, res: Response) {
  try {
    const result = await prisma.productPublishJob.updateMany({
      where: { status: 'FAILED' },
      data: { status: 'QUEUED', attemptCount: 0, errorMessage: null },
    })
    res.status(202).json({ success: true, queued: result.count })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /publish/status/:productId/:marketplace
 */
export async function getPublishStatus(req: Request, res: Response) {
  try {
    const { productId, marketplace } = req.params

    const lastJob = await prisma.productPublishJob.findFirst({
      where: { productId, marketplace: marketplace as Marketplace },
      orderBy: { createdAt: 'desc' },
    })

    const completeness = await publishService.getCompleteness(
      [productId],
      marketplace as Marketplace
    )

    res.json({
      success: true,
      data: {
        status: lastJob?.status ?? null,
        completenessPercent: completeness[0]?.completenessPercent ?? 0,
        lastJobId: lastJob?.id ?? null,
        resolvedAt: lastJob?.resolvedAt ?? null,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}