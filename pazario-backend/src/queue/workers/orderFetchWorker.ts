// src/queue/workers/orderFetchWorker.ts

import { Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { OrderFetchService } from '../../services/OrderFetchService'
import type { OrderFetchJobData } from '../jobs'
import { OperationHistoryService } from '../../services/OperationHistoryService'

const prisma = new PrismaClient()
const fetchService = new OrderFetchService(prisma)
const operationService = new OperationHistoryService(prisma)

export const orderFetchWorker = new Worker<OrderFetchJobData>(
  'order-fetch',
  async (job) => {
    const { marketplace } = job.data
    let operationId = job.data.operationId
    if (!operationId) {
      const operation = await operationService.createOperation({
        type: 'ORDER_FETCH',
        title: `${marketplace} siparis cekme`,
        marketplace: marketplace === 'all' ? undefined : marketplace,
        queueName: 'order-fetch',
        queueJobId: String(job.id ?? ''),
        targetCount: 1,
        retryPayload: {
          queueName: 'order-fetch',
          jobName: job.name || 'fetch',
          data: { marketplace },
        },
      })
      operationId = operation.id
    }
    await operationService.markRunning(operationId, { queueJobId: job.id })

    try {
      const result = marketplace === 'all'
        ? await fetchService.fetchAll()
        : await fetchService.fetchFromMarketplace(marketplace)

      const totalNew = typeof result === 'object' && result !== null && 'totalNew' in result
        ? Number((result as { totalNew?: unknown }).totalNew ?? 0)
        : typeof result === 'object' && result !== null && 'newOrders' in result
          ? Number((result as { newOrders?: unknown }).newOrders ?? 0)
          : 0
      await operationService.markFinished(operationId, 'SUCCEEDED', {
        successCount: totalNew,
        metadata: result as object,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await operationService.markFinished(operationId, 'FAILED', {
        errorMessage: message,
        failedCount: 1,
      })
      throw error
    }
  },
  {
    connection: redis,
    concurrency: 1,
  }
)
