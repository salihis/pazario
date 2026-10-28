// src/queue/scheduler.ts

import { syncQueue, orderFetchQueue, cargoQueue } from './queues'
import { prisma } from '../db'
import {
  importMarketplaceListings,
  MarketplaceSyncDeferredError,
  runMarketplaceSync,
} from '../api/controllers/marketplace.controller'
import { logger } from '../utils/logger'
import { OperationHistoryService } from '../services/OperationHistoryService'

const SUPPORTED_AUTO_SYNC_MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const SUPPORTED_STATUS_IMPORT_MARKETPLACES = ['TRENDYOL', 'N11', 'PAZARAMA'] as const
const MARKETPLACE_BATCH_DELAY_MS = 5 * 60 * 1000
const ISTANBUL_TIME_ZONE = 'Europe/Istanbul'
// Sunucu UTC calisir. Bu pattern Turkiye saatine gore 08:00, 11:00, 14:00, 17:00 ve 00:00 calisir.
const ORDER_FETCH_REPEAT_PATTERN = '0 5,8,11,14,21 * * *'
const MARKETPLACE_STATUS_IMPORT_TIME = process.env.MARKETPLACE_STATUS_IMPORT_TIME || '03:30'
const MARKETPLACE_STATUS_IMPORT_PAGE_SIZE = Math.min(
  Math.max(Number(process.env.MARKETPLACE_STATUS_IMPORT_PAGE_SIZE || '100'), 1),
  100
)
const MARKETPLACE_STATUS_IMPORT_MAX_PAGES = Math.min(
  Math.max(Number(process.env.MARKETPLACE_STATUS_IMPORT_MAX_PAGES || '1000'), 1),
  1000
)
const operationService = new OperationHistoryService(prisma)
let marketplaceSyncCheckRunning = false

function istanbulClock(date: Date): { dateKey: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? ''

  return {
    dateKey: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
    minute: Number(value('minute')),
  }
}

function sameLocalDate(a: Date, b: Date): boolean {
  return istanbulClock(a).dateKey === istanbulClock(b).dateKey
}

function shouldRunAt(now: Date, scheduleTime: string, lastRunAt: Date | null): boolean {
  const [hour, minute] = scheduleTime.split(':').map(Number)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) return false
  if (lastRunAt && sameLocalDate(now, lastRunAt)) return false

  const localNow = istanbulClock(now)
  return localNow.hour > hour || (localNow.hour === hour && localNow.minute >= minute)
}

function scheduledAtForToday(now: Date, scheduleTime: string): Date | null {
  const [hour, minute] = scheduleTime.split(':').map(Number)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) return null
  const { dateKey } = istanbulClock(now)
  return new Date(`${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`)
}

function istanbulDayBounds(now: Date): { start: Date; end: Date } {
  const { dateKey } = istanbulClock(now)
  const start = new Date(`${dateKey}T00:00:00+03:00`)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start, end }
}

function operationTypeForMarketplaceMode(mode: 'stock' | 'price' | 'stock-price') {
  if (mode === 'stock') return 'STOCK_UPDATE' as const
  if (mode === 'price') return 'PRICE_UPDATE' as const
  return 'STOCK_PRICE_UPDATE' as const
}

async function runScheduledMarketplaceSyncs(): Promise<void> {
  if (marketplaceSyncCheckRunning) {
    logger.info('Onceki otomatik pazaryeri guncelleme kontrolu devam ediyor; bu tur atlandi')
    return
  }

  marketplaceSyncCheckRunning = true
  try {
    const now = new Date()
    const settings = await prisma.marketplaceSyncSetting.findMany({
      where: { enabled: true },
    })

    for (const setting of settings) {
    const hasBatchToday = Boolean(setting.batchStartedAt && sameLocalDate(now, setting.batchStartedAt))
    const nextBatchAt = hasBatchToday ? setting.batchNextRunAt : null
    if (nextBatchAt && nextBatchAt > now) continue
    if (!hasBatchToday && !shouldRunAt(now, setting.scheduleTime, setting.lastRunAt)) continue

    const mode = setting.mode === 'stock' || setting.mode === 'price' || setting.mode === 'stock-price'
      ? setting.mode
      : 'stock-price'
    const batchStartedAt = hasBatchToday && setting.batchStartedAt ? setting.batchStartedAt : now
    const safeLimit = Math.min(Math.max(setting.limit, 1), 1000)
    let operationId: string | null = null

    try {
      if (!SUPPORTED_AUTO_SYNC_MARKETPLACES.includes(setting.marketplace)) {
        await prisma.marketplaceSyncSetting.update({
          where: { marketplace: setting.marketplace },
          data: { lastRunAt: now, batchStartedAt: null, batchNextRunAt: null },
        })
        logger.warn({ marketplace: setting.marketplace }, 'Otomatik saat ayari kayitli, ancak stok/fiyat endpointi henuz dogrulanmadi')
        continue
      }

      const operation = await operationService.createOperation({
        type: operationTypeForMarketplaceMode(mode),
        title: `${setting.marketplace} otomatik ${mode} guncelleme`,
        marketplace: setting.marketplace,
        requestedBy: 'scheduler',
        targetCount: safeLimit,
        metadata: {
          mode,
          scheduled: true,
          limit: safeLimit,
          batchStartedAt: batchStartedAt.toISOString(),
          continuationBatch: hasBatchToday,
        },
      })
      operationId = operation.id
      await operationService.markRunning(operationId)

      const result = await runMarketplaceSync(setting.marketplace, mode, false, safeLimit, {
        updatedBefore: batchStartedAt,
      })
      const hasMoreBatches = result.scanned >= safeLimit
      const nextRunAt = new Date(now.getTime() + MARKETPLACE_BATCH_DELAY_MS)

      await prisma.marketplaceSyncSetting.update({
        where: { marketplace: setting.marketplace },
        data: hasMoreBatches
          ? {
              batchStartedAt,
              batchNextRunAt: nextRunAt,
            }
          : {
              lastRunAt: now,
              batchStartedAt: null,
              batchNextRunAt: null,
            },
      })
      await operationService.markFinished(
        operationId,
        result.updated < result.prepared ? 'PARTIALLY_FAILED' : 'SUCCEEDED',
        {
          successCount: result.updated,
          failedCount: Math.max(result.prepared - result.updated, 0),
          skippedCount: Math.max(result.scanned - result.prepared, 0),
          metadata: {
            ...result,
            mode,
            scheduled: true,
            hasMoreBatches,
            nextRunAt: hasMoreBatches ? nextRunAt.toISOString() : null,
          },
        }
      )
      logger.info(
        {
          result,
          batchStartedAt,
          nextRunAt: hasMoreBatches ? nextRunAt : null,
        },
        hasMoreBatches
          ? `${setting.marketplace} otomatik stok/fiyat paketi tamamlandi, devam paketi planlandi`
          : `${setting.marketplace} otomatik stok/fiyat guncellemesi tamamlandi`
      )
    } catch (error) {
      if (error instanceof MarketplaceSyncDeferredError) {
        const retryAt = new Date(Date.now() + error.retryAfterMs)
        if (operationId) {
          await operationService.markWaitingMarketplace(operationId, null, error.message).catch(() => undefined)
        }
        await prisma.marketplaceSyncSetting.update({
          where: { marketplace: setting.marketplace },
          data: {
            batchStartedAt,
            batchNextRunAt: retryAt,
          },
        }).catch(() => undefined)
        logger.warn(
          { marketplace: setting.marketplace, retryAt, reason: error.message },
          'Pazaryeri onceki paketi isliyor; otomatik devam paketi ertelendi',
        )
        continue
      }
      if (operationId) {
        await operationService.markFinished(operationId, 'FAILED', {
          errorMessage: error instanceof Error ? error.message : String(error),
          failedCount: safeLimit,
        }).catch(() => undefined)
      }
      logger.error({ err: error, marketplace: setting.marketplace }, 'Otomatik pazaryeri guncellemesi basarisiz')
      await prisma.marketplaceSyncSetting.update({
        where: { marketplace: setting.marketplace },
        data: { lastRunAt: now, batchStartedAt: null, batchNextRunAt: null },
      }).catch(() => undefined)
    }
    }
  } finally {
    marketplaceSyncCheckRunning = false
  }
}

async function runScheduledMarketplaceStatusImports(): Promise<void> {
  const now = new Date()
  if (!shouldRunAt(now, MARKETPLACE_STATUS_IMPORT_TIME, await lastScheduledMarketplaceImportAt(now))) return

  const activeCredentials = await prisma.marketplaceCredential.findMany({
    where: {
      isActive: true,
      marketplace: { in: [...SUPPORTED_STATUS_IMPORT_MARKETPLACES] },
    },
    select: { marketplace: true },
  })
  const marketplaces = activeCredentials
    .map(item => item.marketplace)
    .filter((marketplace): marketplace is typeof SUPPORTED_STATUS_IMPORT_MARKETPLACES[number] =>
      SUPPORTED_STATUS_IMPORT_MARKETPLACES.includes(marketplace as typeof SUPPORTED_STATUS_IMPORT_MARKETPLACES[number])
    )

  if (marketplaces.length === 0) {
    logger.info('Gece pazaryeri durum kontrolu atlandi: aktif pazaryeri API bilgisi yok')
    await createMarketplaceImportSkipOperation(now)
    return
  }

  for (const marketplace of marketplaces) {
    let operationId: string | null = null
    try {
      const operation = await operationService.createOperation({
        type: 'MARKETPLACE_IMPORT',
        title: `${marketplace} gece pazaryeri durum kontrolu`,
        marketplace,
        requestedBy: 'scheduler',
        targetCount: MARKETPLACE_STATUS_IMPORT_PAGE_SIZE * MARKETPLACE_STATUS_IMPORT_MAX_PAGES,
        metadata: {
          scheduled: true,
          scheduleTime: MARKETPLACE_STATUS_IMPORT_TIME,
          pageSize: MARKETPLACE_STATUS_IMPORT_PAGE_SIZE,
          maxPages: MARKETPLACE_STATUS_IMPORT_MAX_PAGES,
        },
      })
      operationId = operation.id
      await operationService.markRunning(operationId)

      const result = await importMarketplaceListings(
        marketplace,
        MARKETPLACE_STATUS_IMPORT_PAGE_SIZE,
        MARKETPLACE_STATUS_IMPORT_MAX_PAGES
      )

      await operationService.markFinished(operationId, 'SUCCEEDED', {
        successCount: result.imported,
        skippedCount: Math.max(result.fetched - result.matched, 0),
        metadata: {
          ...result,
          scheduled: true,
          scheduleTime: MARKETPLACE_STATUS_IMPORT_TIME,
        },
      })
      logger.info({ marketplace, result }, 'Gece pazaryeri durum kontrolu tamamlandi')
    } catch (error) {
      if (operationId) {
        await operationService.markFinished(operationId, 'FAILED', {
          errorMessage: error instanceof Error ? error.message : String(error),
          failedCount: 1,
        }).catch(() => undefined)
      }
      logger.error({ err: error, marketplace }, 'Gece pazaryeri durum kontrolu basarisiz')
    }
  }
}

async function lastScheduledMarketplaceImportAt(now: Date): Promise<Date | null> {
  const { start, end } = istanbulDayBounds(now)
  const operation = await prisma.operationHistory.findFirst({
    where: {
      type: 'MARKETPLACE_IMPORT',
      requestedBy: 'scheduler',
      createdAt: { gte: start, lt: end },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  return operation?.createdAt ?? null
}

async function createMarketplaceImportSkipOperation(now: Date): Promise<void> {
  const existing = await lastScheduledMarketplaceImportAt(now)
  if (existing) return
  const operation = await operationService.createOperation({
    type: 'MARKETPLACE_IMPORT',
    title: 'Gece pazaryeri durum kontrolu atlandi',
    requestedBy: 'scheduler',
    targetCount: 0,
    metadata: {
      scheduled: true,
      scheduleTime: MARKETPLACE_STATUS_IMPORT_TIME,
      skippedReason: 'Aktif pazaryeri API bilgisi yok',
    },
  })
  await operationService.markFinished(operation.id, 'SUCCEEDED', {
    skippedCount: 1,
    metadata: {
      scheduled: true,
      scheduleTime: MARKETPLACE_STATUS_IMPORT_TIME,
      skippedReason: 'Aktif pazaryeri API bilgisi yok',
    },
  })
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

async function removeLegacyOrderFetchRepeatJobs(): Promise<void> {
  const repeatableJobs = await orderFetchQueue.getRepeatableJobs()
  for (const repeatableJob of repeatableJobs) {
    if (repeatableJob.name === 'fetch-all' && repeatableJob.pattern !== ORDER_FETCH_REPEAT_PATTERN) {
      await orderFetchQueue.removeRepeatableByKey(repeatableJob.key)
      logger.info({ repeatKey: repeatableJob.key }, 'Eski siparis cekme repeat job temizlendi')
    }
  }
}

/**
 * Cron job'larÄ±nÄ± tanÄ±mlar
 * BullMQ repeateable jobs kullanÄ±r
 */
export async function setupScheduler(): Promise<void> {
  await removeLegacyXmlRepeatJob()
  await removeLegacyOrderFetchRepeatJobs()

  // Turkiye saatine gore 08:00, 11:00, 14:00, 17:00 ve 00:00 — siparis cekme
  await orderFetchQueue.add(
    'fetch-all',
    { marketplace: 'all' },
    { repeat: { pattern: ORDER_FETCH_REPEAT_PATTERN } }
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
    runScheduledMarketplaceStatusImports().catch(error => {
      logger.error({ err: error }, 'Gece pazaryeri durum kontrolu basarisiz')
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

  runScheduledMarketplaceSyncs().catch(error => {
    logger.error({ err: error }, 'Ilk otomatik pazaryeri guncelleme kontrolu basarisiz')
  })

  runScheduledMarketplaceStatusImports().catch(error => {
    logger.error({ err: error }, 'Ilk gece pazaryeri durum kontrolu basarisiz')
  })

  process.stdout.write('âœ… Scheduler baÅŸlatÄ±ldÄ±\n')
}

