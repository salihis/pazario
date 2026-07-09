// src/queue/scheduler.ts

import { syncQueue, orderFetchQueue, cargoQueue } from './queues'
import { prisma } from '../db'
import { runMarketplaceSync } from '../api/controllers/marketplace.controller'
import { logger } from '../utils/logger'

const SUPPORTED_AUTO_SYNC_MARKETPLACES = ['TRENDYOL', 'N11', 'PAZARAMA']

function sameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function shouldRunAt(now: Date, scheduleTime: string, lastRunAt: Date | null): boolean {
  const [hour, minute] = scheduleTime.split(':').map(Number)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  if (lastRunAt && sameLocalDate(now, lastRunAt)) return false

  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)
}

function scheduledAtForToday(now: Date, scheduleTime: string): Date | null {
  const [hour, minute] = scheduleTime.split(':').map(Number)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  const scheduledAt = new Date(now)
  scheduledAt.setHours(hour, minute, 0, 0)
  return scheduledAt
}

async function runScheduledMarketplaceSyncs(): Promise<void> {
  const now = new Date()
  const settings = await prisma.marketplaceSyncSetting.findMany({
    where: { enabled: true },
  })

  for (const setting of settings) {
    if (!shouldRunAt(now, setting.scheduleTime, setting.lastRunAt)) continue
    const mode = setting.mode === 'stock' || setting.mode === 'price' || setting.mode === 'stock-price'
      ? setting.mode
      : 'stock-price'

    try {
      if (!SUPPORTED_AUTO_SYNC_MARKETPLACES.includes(setting.marketplace)) {
        await prisma.marketplaceSyncSetting.update({
          where: { marketplace: setting.marketplace },
          data: { lastRunAt: new Date() },
        })
        logger.warn({ marketplace: setting.marketplace }, 'Otomatik saat ayari kayitli, ancak stok/fiyat endpointi henuz dogrulanmadi')
        continue
      }

      const result = await runMarketplaceSync(setting.marketplace, mode, false, setting.limit)
      await prisma.marketplaceSyncSetting.update({
        where: { marketplace: setting.marketplace },
        data: { lastRunAt: new Date() },
      })
      logger.info({ result }, `${setting.marketplace} otomatik stok/fiyat guncellemesi tamamlandi`)
    } catch (error) {
      logger.error({ err: error, marketplace: setting.marketplace }, 'Otomatik pazaryeri guncellemesi basarisiz')
      await prisma.marketplaceSyncSetting.update({
        where: { marketplace: setting.marketplace },
        data: { lastRunAt: new Date() },
      }).catch(() => undefined)
    }
  }
}

async function runScheduledXmlSourceSyncs(): Promise<void> {
  const now = new Date()
  const sources = await prisma.xmlSource.findMany({
    where: {
      active: true,
      autoSyncEnabled: true,
    },
    select: {
      id: true,
      name: true,
      autoSyncTime: true,
      lastAutoSyncAt: true,
      createdAt: true,
    },
  })

  for (const source of sources) {
    const scheduleTime = source.autoSyncTime || '03:00'
    const scheduledAt = scheduledAtForToday(now, scheduleTime)
    if (scheduledAt && !source.lastAutoSyncAt && source.createdAt > scheduledAt) continue
    if (!shouldRunAt(now, scheduleTime, source.lastAutoSyncAt)) continue

    try {
      await syncQueue.add(
        'sync',
        { triggeredBy: 'cron', sourceId: source.id },
        { jobId: `xml-auto-${source.id}-${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}` }
      )
      await prisma.xmlSource.update({
        where: { id: source.id },
        data: { lastAutoSyncAt: now },
      })
      logger.info({ sourceId: source.id, sourceName: source.name }, 'XML kaynagi otomatik senkron kuyruguna alindi')
    } catch (error) {
      logger.error({ err: error, sourceId: source.id }, 'XML kaynagi otomatik senkron kuyruguna alinamadi')
    }
  }
}

async function removeLegacyXmlRepeatJob(): Promise<void> {
  const repeatableJobs = await syncQueue.getRepeatableJobs()
  for (const repeatableJob of repeatableJobs) {
    if (repeatableJob.name === 'scheduled-sync') {
      await syncQueue.removeRepeatableByKey(repeatableJob.key)
      logger.info({ repeatKey: repeatableJob.key }, 'Eski toplu XML repeat job temizlendi')
    }
  }
}

/**
 * Cron job'larÄ±nÄ± tanÄ±mlar
 * BullMQ repeateable jobs kullanÄ±r
 */
export async function setupScheduler(): Promise<void> {
  await removeLegacyXmlRepeatJob()

  // Her 5 dakika â€” sipariÅŸ Ã§ekme
  await orderFetchQueue.add(
    'fetch-all',
    { marketplace: 'all' },
    { repeat: { pattern: '*/5 * * * *' } }
  )

  // Her 2 saat â€” kargo durum kontrolÃ¼
  await cargoQueue.add(
    'check-all-status',
    { orderId: 'all', action: 'check_status' },
    { repeat: { pattern: '0 */2 * * *' } }
  )


  setInterval(() => {
    runScheduledMarketplaceSyncs().catch(error => {
      logger.error({ err: error }, 'Otomatik pazaryeri guncelleme kontrolu basarisiz')
    })
  }, 60 * 1000)

  setInterval(() => {
    runScheduledXmlSourceSyncs().catch(error => {
      logger.error({ err: error }, 'Otomatik XML kaynak guncelleme kontrolu basarisiz')
    })
  }, 60 * 1000)

  runScheduledXmlSourceSyncs().catch(error => {
    logger.error({ err: error }, 'Ilk otomatik XML kaynak guncelleme kontrolu basarisiz')
  })

  process.stdout.write('âœ… Scheduler baÅŸlatÄ±ldÄ±\n')
}

