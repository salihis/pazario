// src/queue/workers/orderFetchWorker.ts

import { Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { OrderFetchService } from '../../services/OrderFetchService'
import type { OrderFetchJobData } from '../jobs'

const prisma = new PrismaClient()
const fetchService = new OrderFetchService(prisma)

export const orderFetchWorker = new Worker<OrderFetchJobData>(
  'order-fetch',
  async (job) => {
    const { marketplace } = job.data

    if (marketplace === 'all') {
      return fetchService.fetchAll()
    }

    return fetchService.fetchFromMarketplace(marketplace)
  },
  {
    connection: redis,
    concurrency: 1,
  }
)