import { Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { notifyQueue, syncQueue } from '../queues'
import type { SyncJobData } from '../jobs'
import { OperationHistoryService } from '../../services/OperationHistoryService'

const prisma = new PrismaClient()
const operationService = new OperationHistoryService(prisma)

export const syncWorker = new Worker<SyncJobData>(
  'sync',
  async (job) => {
    const { sourceId, triggeredBy } = job.data
    const startedAt = new Date()
    let operationId = job.data.operationId

    if (sourceId === 'all') {
      const sources = await prisma.xmlSource.findMany({
        where: { active: true, autoSyncEnabled: true },
        select: { id: true },
      })

      for (const source of sources) {
        const operation = await operationService.createOperation({
          type: 'XML_SYNC',
          title: 'XML senkronizasyonu',
          queueName: 'sync',
          requestedBy: triggeredBy,
          sourceId: source.id,
          targetCount: 1,
          retryPayload: {
            queueName: 'sync',
            jobName: 'sync',
            data: { sourceId: source.id, triggeredBy },
          },
        })
        const queuedJob = await syncQueue.add('sync', {
          sourceId: source.id,
          triggeredBy,
          operationId: operation.id,
        })
        await prisma.operationHistory.update({
          where: { id: operation.id },
          data: { queueJobId: String(queuedJob.id) },
        })
      }

      await job.updateProgress(100)
      return { enqueued: sources.length }
    }

    if (!operationId) {
      const operation = await operationService.createOperation({
        type: 'XML_SYNC',
        title: 'XML senkronizasyonu',
        queueName: 'sync',
        queueJobId: String(job.id ?? ''),
        requestedBy: triggeredBy,
        sourceId,
        targetCount: 1,
        retryPayload: {
          queueName: 'sync',
          jobName: job.name || 'sync',
          data: { sourceId, triggeredBy },
        },
      })
      operationId = operation.id
    }
    await operationService.markRunning(operationId, { queueJobId: job.id })

    const syncJob = await prisma.syncJob.create({
      data: {
        sourceId,
        status: 'RUNNING',
        startedAt,
      },
    })
    await prisma.operationHistory.update({
      where: { id: operationId },
      data: { syncJobId: syncJob.id },
    })

    try {
      const source = await prisma.xmlSource.findUnique({ where: { id: sourceId } })
      if (!source || !source.active) {
        throw new Error(`XML kaynagi bulunamadi veya pasif: ${sourceId}`)
      }

      await job.updateProgress(10)

      const { MarketplacePipeline } = await import('../../MarketplacePipeline')
      const pipeline = new MarketplacePipeline(prisma)
      const result = await pipeline.run(syncJob.id)

      await job.updateProgress(100)

      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          totalProducts: result.totalFetched,
          changedProducts: result.changedProducts,
          publishedCount: result.published,
          failedCount: result.failed,
        },
      })

      const errorRate = result.totalFetched > 0
        ? result.failed / result.totalFetched
        : 0

      if (errorRate > 0.2) {
        await notifyQueue.add('sync-error-rate', {
          type: 'slack',
          message: `Sync hata orani yuksek: %${Math.round(errorRate * 100)} (${result.failed}/${result.totalFetched})`,
          level: 'warn',
        })
      }

      const status = result.failed > 0
        ? result.published > 0 || result.changedProducts > 0
          ? 'PARTIALLY_FAILED'
          : 'FAILED'
        : 'SUCCEEDED'

      await operationService.markFinished(operationId, status, {
        successCount: result.published,
        failedCount: result.failed,
        metadata: {
          totalFetched: result.totalFetched,
          changedProducts: result.changedProducts,
        },
      })

      return result
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: message,
        },
      })

      await notifyQueue.add('sync-failed', {
        type: 'slack',
        message: `Sync basarisiz: ${sourceId} - ${message}`,
        level: 'error',
      })

      await operationService.markFinished(operationId, 'FAILED', {
        errorMessage: message,
        failedCount: 1,
      })

      throw e
    }
  },
  {
    connection: redis,
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 60 * 1000,
    maxStalledCount: 2,
    concurrency: 1,
  }
)

syncWorker.on('failed', (job, err) => {
  process.stderr.write(`Sync job basarisiz: ${job?.id} - ${err.message}\n`)
})
