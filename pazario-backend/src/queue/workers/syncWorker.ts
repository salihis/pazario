// src/queue/workers/syncWorker.ts

import { Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { publishQueue, notifyQueue, syncQueue } from '../queues'
import type { SyncJobData } from '../jobs'

const prisma = new PrismaClient()
const PUBLISH_BATCH_SIZE = 100

export const syncWorker = new Worker<SyncJobData>(
  'sync',
  async (job) => {
    const { sourceId, triggeredBy } = job.data
    const startedAt = new Date()

    if (sourceId === 'all') {
      const sources = await prisma.xmlSource.findMany({
        where: { active: true, autoSyncEnabled: true },
        select: { id: true },
      })

      for (const source of sources) {
        await syncQueue.add('sync', {
          sourceId: source.id,
          triggeredBy,
        })
      }

      await job.updateProgress(100)
      return { enqueued: sources.length }
    }

    // sync_jobs kaydını RUNNING yap
    const syncJob = await prisma.syncJob.create({
      data: {
        sourceId,
        status: 'RUNNING',
        startedAt,
      },
    })

    try {
      // XML kaynağını çek
      const source = await prisma.xmlSource.findUnique({ where: { id: sourceId } })
      if (!source || !source.active) {
        throw new Error(`XML kaynağı bulunamadı veya pasif: ${sourceId}`)
      }

      await job.updateProgress(10)

      // Pipeline çalıştır
      const { MarketplacePipeline } = await import('../../MarketplacePipeline')
      const pipeline = new MarketplacePipeline(prisma)
      const result = await pipeline.run(syncJob.id)

      await job.updateProgress(100)

      // sync_jobs DONE
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

      // Hata oranı %20 üstü → Slack bildirimi
      const errorRate = result.totalFetched > 0
        ? result.failed / result.totalFetched
        : 0

      if (errorRate > 0.2) {
        await notifyQueue.add('sync-error-rate', {
          type: 'slack',
          message: `⚠️ Sync hata oranı yüksek: %${Math.round(errorRate * 100)} (${result.failed}/${result.totalFetched})`,
          level: 'warn',
        })
      }

      return result
    } catch (e) {
      // sync_jobs FAILED
      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: e instanceof Error ? e.message : String(e),
        },
      })

      await notifyQueue.add('sync-failed', {
        type: 'slack',
        message: `❌ Sync başarısız: ${sourceId} — ${e instanceof Error ? e.message : String(e)}`,
        level: 'error',
      })

      throw e
    }
  },
  {
    connection: redis,
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 60 * 1000,
    maxStalledCount: 2,
    concurrency: 1, // aynı anda sadece bir sync
  }
)

syncWorker.on('failed', (job, err) => {
  process.stderr.write(`Sync job başarısız: ${job?.id} — ${err.message}\n`)
})
