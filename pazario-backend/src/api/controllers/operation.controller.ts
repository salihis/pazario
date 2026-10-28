import { OperationStatus, OperationType, Marketplace, PrismaClient } from '@prisma/client'
import { Request, Response } from 'express'
import { z } from 'zod'
import { OperationHistoryService } from '../../services/OperationHistoryService'
import type { AuthRequest } from '../middleware/auth.middleware'

const prisma = new PrismaClient()
const service = new OperationHistoryService(prisma)

const operationTypes: OperationType[] = [
  'PRODUCT_PUBLISH',
  'VARIANT_UPDATE',
  'STOCK_UPDATE',
  'PRICE_UPDATE',
  'STOCK_PRICE_UPDATE',
  'XML_SYNC',
  'ORDER_FETCH',
  'MARKETPLACE_IMPORT',
]

const operationStatuses: OperationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'PARTIALLY_FAILED',
  'WAITING_MARKETPLACE',
  'RETRYING',
]

const marketplaces: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(operationTypes as [OperationType, ...OperationType[]]).optional(),
  status: z.enum(operationStatuses as [OperationStatus, ...OperationStatus[]]).optional(),
  marketplace: z.enum(marketplaces as [Marketplace, ...Marketplace[]]).optional(),
})

export async function listOperations(req: Request, res: Response) {
  const parsed = listSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Gecersiz filtre', errors: parsed.error.flatten() })
    return
  }

  try {
    const result = await service.listOperations(parsed.data)
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Operasyon gecmisi alinamadi' })
  }
}

export async function getOperation(req: Request, res: Response) {
  try {
    const operation = await service.getOperation(String(req.params.id || ''))
    if (!operation) {
      res.status(404).json({ success: false, error: 'Operasyon bulunamadi' })
      return
    }
    res.json({ success: true, data: operation })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Operasyon detayi alinamadi' })
  }
}

export async function retryOperation(req: AuthRequest, res: Response) {
  try {
    const operation = await service.retryOperation(String(req.params.id || ''), req.user?.email ?? req.user?.id)
    res.status(202).json({ success: true, data: operation })
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Operasyon tekrar denenemedi',
    })
  }
}
