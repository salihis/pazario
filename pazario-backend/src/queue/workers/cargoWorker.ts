// src/queue/workers/cargoWorker.ts

import { Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { notifyQueue } from '../queues'
import type { CargoJobData } from '../jobs'

const prisma = new PrismaClient()

export const cargoWorker = new Worker<CargoJobData>(
  'cargo',
  async (job) => {
    const { orderId, action } = job.data

    switch (action) {
      case 'create_label': {
        // CargoService.createLabel(orderId) çağrılır
        // Placeholder implementasyon
        const order = await prisma.order.findUnique({ where: { id: orderId } })
        if (!order) throw new Error(`Sipariş bulunamadı: ${orderId}`)
        break
      }
      case 'notify_marketplace': {
        // Pazaryerine takip no bildir
        break
      }
      case 'check_status': {
        // Kargo durumu güncelle
        const shipment = await prisma.shipment.findUnique({ where: { orderId } })
        if (shipment) {
          await prisma.shipment.update({
            where: { orderId },
            data: { lastCheckedAt: new Date() },
          })
        }
        break
      }
    }
  },
  { connection: redis, concurrency: 2 }
)

cargoWorker.on('failed', async (job, err) => {
  await notifyQueue.add('cargo-failed', {
    type: 'slack',
    message: `❌ Kargo işlemi başarısız: ${job?.data.orderId} / ${job?.data.action} — ${err.message}`,
    level: 'error',
  }).catch(() => {})
})