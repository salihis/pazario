// src/queue/workers/publishWorker.ts

import { Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { notifyQueue } from '../queues'
import type { PublishJobData } from '../jobs'

const prisma = new PrismaClient()

export const publishWorker = new Worker<PublishJobData>(
  'publish',
  async (job) => {
    const { productId, marketplace, syncJobId } = job.data

    const product = await prisma.product.findUnique({ where: { id: productId } })
    if (!product) throw new Error(`Ürün bulunamadı: ${productId}`)

    // Marketplace listing güncelle
    await prisma.marketplaceListing.upsert({
      where: { productId_marketplace: { productId, marketplace } },
      create: {
        productId,
        marketplace: marketplace as 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA',
        status: 'PENDING',
        lastSyncJobId: syncJobId,
      },
      update: {
        status: 'PENDING',
        lastSyncJobId: syncJobId,
      },
    })

    // Gerçek adaptör çağrısı burada yapılır
    // Adaptörler DI ile inject edilmeli
    // Placeholder: listing PUBLISHED yap
    await prisma.marketplaceListing.update({
      where: { productId_marketplace: { productId, marketplace } },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        hashAtPublish: product.contentHash,
      },
    })
  },
  {
    connection: redis,
    concurrency: 4,
  }
)

publishWorker.on('failed', async (job, err) => {
  if (!job) return
  const { productId, marketplace } = job.data

  await prisma.marketplaceListing.update({
    where: { productId_marketplace: { productId, marketplace } },
    data: { status: 'FAILED' },
  }).catch(() => {})

  await notifyQueue.add('publish-failed', {
    type: 'slack',
    message: `❌ Publish başarısız: ${productId} / ${marketplace} — ${err.message}`,
    level: 'error',
  })
})