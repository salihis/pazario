// src/queue/queues.ts

import { Queue } from 'bullmq'
import { redis } from '../utils/redis'

/** XML senkronizasyon kuyruğu — concurrency: 1 */
export const syncQueue = new Queue('sync', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
})

/** Pazaryeri yayın kuyruğu — concurrency: 4 */
export const publishQueue = new Queue('publish', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 200,
    removeOnFail: 1000,
  },
})

/** Kargo işlemleri kuyruğu */
export const cargoQueue = new Queue('cargo', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
})

/** Sipariş çekme kuyruğu — her 5 dakikada bir */
export const orderFetchQueue = new Queue('order-fetch', {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  },
})

/** Bildirim kuyruğu — Slack / email */
export const notifyQueue = new Queue('notify', {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: 50,
    removeOnFail: 100,
  },
})