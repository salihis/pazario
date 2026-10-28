import { Request, Response } from 'express'
import { AttributeRuleMatchType, Marketplace, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { AttributeRuleService } from '../../services/AttributeRuleService'
import { logger } from '../../utils/logger'
import type { AuthRequest } from '../middleware/auth.middleware'

const prisma = new PrismaClient()
const service = new AttributeRuleService(prisma)

const nullableText = z.string().trim().min(1).nullable().optional()

export const attributeRuleSchema = z.object({
  marketplace: z.enum(['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']),
  sourceId: z.string().uuid().nullable().optional(),
  sourceCategory: nullableText,
  marketplaceCategoryId: nullableText,
  name: z.string().trim().min(1).max(200),
  attributeId: z.string().trim().min(1).max(100),
  attributeName: z.string().trim().max(200).nullable().optional(),
  valueId: z.string().trim().max(100).nullable().optional(),
  valueText: z.string().trim().nullable().optional(),
  matchType: z.enum(['ALWAYS', 'TITLE_CONTAINS', 'BRAND_EQUALS', 'XML_ATTRIBUTE_EQUALS']).default('ALWAYS'),
  matchField: z.string().trim().max(200).nullable().optional(),
  matchValue: z.string().trim().nullable().optional(),
  confidence: z.number().min(0).max(1).default(1),
  priority: z.number().int().min(0).max(10000).default(100),
  isActive: z.boolean().default(true),
}).superRefine((value, context) => {
  if (!value.valueId && !value.valueText) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['valueId'], message: 'valueId veya valueText zorunlu' })
  }
  if (value.matchType !== 'ALWAYS' && !value.matchValue) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['matchValue'], message: 'Kosullu kural icin matchValue zorunlu' })
  }
  if (value.matchType === 'XML_ATTRIBUTE_EQUALS' && !value.matchField) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['matchField'], message: 'XML kurali icin matchField zorunlu' })
  }
})

export const attributeRuleRunSchema = z.object({
  overwrite: z.boolean().default(false),
  minConfidence: z.number().min(0).max(1).default(0.9),
  limit: z.number().int().min(1).max(2000).default(500),
})

export async function listAttributeRules(req: Request, res: Response) {
  const marketplace = req.query.marketplace as Marketplace | undefined
  const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined
  const sourceCategory = typeof req.query.sourceCategory === 'string' ? req.query.sourceCategory : undefined
  const data = await prisma.attributeRule.findMany({
    where: { marketplace, sourceId, sourceCategory },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  })
  res.json({ success: true, data })
}

export async function createAttributeRule(req: AuthRequest, res: Response) {
  const data = await prisma.attributeRule.create({
    data: {
      ...req.body,
      marketplace: req.body.marketplace as Marketplace,
      matchType: req.body.matchType as AttributeRuleMatchType,
      createdBy: req.user?.email ?? req.user?.id ?? 'admin',
    },
  })
  res.status(201).json({ success: true, data })
}

export async function updateAttributeRule(req: Request, res: Response) {
  try {
    const data = await prisma.attributeRule.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        marketplace: req.body.marketplace as Marketplace,
        matchType: req.body.matchType as AttributeRuleMatchType,
      },
    })
    res.json({ success: true, data })
  } catch {
    res.status(404).json({ success: false, error: 'Ozellik kurali bulunamadi' })
  }
}

export async function deleteAttributeRule(req: Request, res: Response) {
  try {
    await prisma.attributeRule.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch {
    res.status(404).json({ success: false, error: 'Ozellik kurali bulunamadi' })
  }
}

export async function previewMappingAttributeRules(req: Request, res: Response) {
  try {
    const data = await service.previewMapping(req.params.id, req.body)
    res.json({ success: true, data })
  } catch (error) {
    logger.error({ err: error, mappingId: req.params.id }, 'Ozellik kurali onizlemesi basarisiz')
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Onizleme basarisiz' })
  }
}

export async function applyMappingAttributeRules(req: Request, res: Response) {
  try {
    const data = await service.applyMapping(req.params.id, req.body)
    res.json({ success: true, data })
  } catch (error) {
    logger.error({ err: error, mappingId: req.params.id }, 'Ozellik kurallari uygulanamadi')
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Kurallar uygulanamadi' })
  }
}
