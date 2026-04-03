// src/api/controllers/category.controller.ts

import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * GET /category-mappings/pending
 * Onay bekleyen kategori eşleştirmelerini listeler
 */
export async function getPendingMappings(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '50'))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = { status: 'PENDING' }
    if (req.query.marketplace) where.marketplace = req.query.marketplace

    const [data, total] = await Promise.all([
      prisma.categoryMapping.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { source: { select: { name: true } } },
      }),
      prisma.categoryMapping.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * PUT /category-mappings/:id/approve
 * AI önerilerinden birini seçerek onaylar
 */
export async function approveMapping(req: Request, res: Response) {
  try {
    const { suggestionIndex } = req.body
    if (suggestionIndex === undefined || ![0, 1, 2].includes(suggestionIndex)) {
      res.status(400).json({ success: false, error: 'Geçersiz suggestionIndex (0, 1 veya 2 olmalı)' })
      return
    }

    const mapping = await prisma.categoryMapping.findUnique({
      where: { id: req.params.id },
    })
    if (!mapping) {
      res.status(404).json({ success: false, error: 'Eşleştirme bulunamadı' })
      return
    }

    const suggestions = mapping.allSuggestions as {
      categoryId: string
      categoryPath: string
      confidence: number
    }[] | null

    if (!suggestions || !suggestions[suggestionIndex]) {
      res.status(400).json({ success: false, error: 'Öneri bulunamadı' })
      return
    }

    const selected = suggestions[suggestionIndex]

    const updated = await prisma.categoryMapping.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        marketplaceCategoryId: selected.categoryId,
        marketplaceCategoryPath: selected.categoryPath,
        approvedBy: 'admin',
        approvedAt: new Date(),
      },
    })

    res.json({ success: true, data: updated })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * PUT /category-mappings/:id/approve-manual
 * Manuel kategori seçimi ile onaylar
 */
export async function approveManual(req: Request, res: Response) {
  try {
    const { marketplaceCategoryId, marketplaceCategoryPath } = req.body
    if (!marketplaceCategoryId) {
      res.status(400).json({ success: false, error: 'marketplaceCategoryId zorunlu' })
      return
    }

    const updated = await prisma.categoryMapping.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        marketplaceCategoryId,
        marketplaceCategoryPath: marketplaceCategoryPath ?? null,
        aiSuggested: false,
        approvedBy: 'admin',
        approvedAt: new Date(),
      },
    })

    res.json({ success: true, data: updated })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Eşleştirme bulunamadı' })
  }
}

/**
 * PUT /category-mappings/:id/reject
 * Eşleştirmeyi reddeder
 */
export async function rejectMapping(req: Request, res: Response) {
  try {
    const updated = await prisma.categoryMapping.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED' },
    })
    res.json({ success: true, data: updated })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Eşleştirme bulunamadı' })
  }
}

/**
 * POST /category-mappings/bulk-approve
 * Toplu onay — transaction içinde
 */
export async function bulkApprove(req: Request, res: Response) {
  const { items } = req.body as {
    items: { id: string; suggestionIndex: number }[]
  }

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, error: 'items dizisi boş olamaz' })
    return
  }

  let approved = 0
  const errors: { id: string; error: string }[] = []

  try {
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        try {
          const mapping = await tx.categoryMapping.findUnique({
            where: { id: item.id },
          })
          if (!mapping) throw new Error('Bulunamadı')

          const suggestions = mapping.allSuggestions as {
            categoryId: string; categoryPath: string
          }[] | null
          const selected = suggestions?.[item.suggestionIndex]
          if (!selected) throw new Error('Öneri yok')

          await tx.categoryMapping.update({
            where: { id: item.id },
            data: {
              status: 'APPROVED',
              marketplaceCategoryId: selected.categoryId,
              marketplaceCategoryPath: selected.categoryPath,
              approvedBy: 'admin',
              approvedAt: new Date(),
            },
          })
          approved++
        } catch (e) {
          errors.push({ id: item.id, error: e instanceof Error ? e.message : 'Hata' })
          throw e // transaction rollback
        }
      }
    })
  } catch (e) {
    res.status(400).json({ success: false, approved: 0, failed: items.length, errors })
    return
  }

  res.json({ success: true, approved, failed: errors.length, errors })
}

/**
 * GET /marketplace-categories/:marketplace/search
 * Pazaryeri kategori ağacında arama
 */
export async function searchCategories(req: Request, res: Response) {
  try {
    const { marketplace } = req.params
    const q = String(req.query.q || '')
    const isLeaf = req.query.isLeaf === 'true'
    const limit = parseInt(String(req.query.limit || '20'))

    const where: Record<string, unknown> = { marketplace }
    if (q) {
      where.OR = [
        { categoryName: { contains: q, mode: 'insensitive' } },
        { categoryPath: { contains: q, mode: 'insensitive' } },
      ]
    }
    if (req.query.isLeaf !== undefined) where.isLeaf = isLeaf

    const results = await prisma.marketplaceCategory.findMany({
      where,
      take: limit,
      select: { categoryId: true, categoryPath: true, categoryName: true },
    })

    res.json({ success: true, data: results })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /category-stats
 * Kategori eşleştirme istatistikleri
 */
export async function getCategoryStats(req: Request, res: Response) {
  try {
    const [pending, approved, rejected, total] = await Promise.all([
      prisma.categoryMapping.count({ where: { status: 'PENDING' } }),
      prisma.categoryMapping.count({ where: { status: 'APPROVED' } }),
      prisma.categoryMapping.count({ where: { status: 'REJECTED' } }),
      prisma.categoryMapping.count(),
    ])

    res.json({ success: true, data: { pending, approved, rejected, total } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}