import { RequestHandler } from 'express'
import { z } from 'zod'
import { LocalSyncService } from '../../services/LocalSyncService'
import { ApiResponseBuilder } from '../../utils/apiResponse'

const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url(),
})

const productSchema = z.object({
  externalId: z.string().trim().optional(),
  sku: z.string().trim().optional(),
  barcode: z.string().trim().optional(),
  name: z.string().trim().optional(),
  title: z.string().trim().optional(),
  description: z.string().optional(),
  brand: z.string().trim().optional(),
  category: z.string().trim().optional(),
  categoryPath: z.string().trim().optional(),
  price: z.coerce.number().optional(),
  listPrice: z.coerce.number().optional(),
  currency: z.string().trim().optional(),
  stock: z.coerce.number().optional(),
  vatRate: z.coerce.number().optional(),
  imageUrls: z.array(z.string()).optional(),
  rawJson: z.unknown().optional(),
})

const bulkSchema = z.object({
  source: sourceSchema,
  products: z.array(productSchema).min(1).max(1000),
})

export const getLocalSyncStatus: RequestHandler = async (_req, res, next) => {
  try {
    const status = await LocalSyncService.getStatus()
    res.json(ApiResponseBuilder.success(status))
  } catch (error) {
    next(error)
  }
}

export const listLocalSyncXmlSources: RequestHandler = async (_req, res, next) => {
  try {
    const sources = await LocalSyncService.listXmlSources()
    res.json(ApiResponseBuilder.success(sources))
  } catch (error) {
    next(error)
  }
}

export const createLocalSyncXmlSource: RequestHandler = async (req, res, next) => {
  try {
    const parsed = sourceSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json(ApiResponseBuilder.validationError(parsed.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
      }))))
      return
    }

    const source = await LocalSyncService.upsertXmlSource(parsed.data)
    res.status(201).json(ApiResponseBuilder.success(source))
  } catch (error) {
    next(error)
  }
}

export const bulkSyncLocalProducts: RequestHandler = async (req, res, next) => {
  try {
    const parsed = bulkSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json(ApiResponseBuilder.validationError(parsed.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
      }))))
      return
    }

    const result = await LocalSyncService.syncProducts(parsed.data)
    res.json(ApiResponseBuilder.success(result))
  } catch (error) {
    next(error)
  }
}
