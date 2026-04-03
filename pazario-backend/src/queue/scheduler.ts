// src/queue/scheduler.ts

import { syncQueue, orderFetchQueue, cargoQueue } from './queues'

/**
 * Cron job'larını tanımlar
 * BullMQ repeateable jobs kullanır
 */
export async function setupScheduler(): Promise<void> {
  // Gece 03:00 — XML sync
  await syncQueue.add(
    'scheduled-sync',
    { triggeredBy: 'cron', sourceId: 'all' },
    { repeat: { pattern: '0 3 * * *' } }
  )

  // Her 5 dakika — sipariş çekme
  await orderFetchQueue.add(
    'fetch-all',
    { marketplace: 'all' },
    { repeat: { pattern: '*/5 * * * *' } }
  )

  // Her 2 saat — kargo durum kontrolü
  await cargoQueue.add(
    'check-all-status',
    { orderId: 'all', action: 'check_status' },
    { repeat: { pattern: '0 */2 * * *' } }
  )

  process.stdout.write('✅ Scheduler başlatıldı\n')
}