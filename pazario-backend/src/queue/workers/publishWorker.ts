import { effectiveProductMedia } from '../../services/ProductMediaService'
import { Worker } from 'bullmq'
import { Marketplace, PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { notifyQueue } from '../queues'
import { logger } from '../../utils/logger'
import type { PublishJobData } from '../jobs'
import { TrendyolAdapter } from '../../adapters/TrendyolAdapter'
import { N11Adapter } from '../../adapters/N11Adapter'
import { PazaramaAdapter } from '../../adapters/PazaramaAdapter'
import { HepsiburadaAdapter } from '../../adapters/HepsiburadaAdapter'
import type { Product as AdapterProduct } from '../../adapters/BaseAdapter'
import { findApprovedCategoryMapping } from '../../services/CategoryMappingService'
import { applyXmlColorSizeOverrides } from '../../services/XmlAttributeOverrideService'
import { OperationHistoryService } from '../../services/OperationHistoryService'
import { decryptJson } from '../../services/FieldEncryptionService'
import { calculatePurchaseCost, type PurchaseCostSource } from '../../services/PurchaseCostService'
import { marketplaceBrandForSource, marketplaceUniqueBarcode } from '../../services/MarketplacePayloadTransform'

const prisma = new PrismaClient()
const operationService = new OperationHistoryService(prisma)
const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const MARKETPLACE_PUBLISH_DELAY_MS: Partial<Record<Marketplace, number>> = {
  N11: 3000,
  PAZARAMA: 30000,
}
const lastPublishAttemptAt = new Map<Marketplace, number>()

function normalizeMarketplace(value: string): Marketplace {
  const marketplace = value.toUpperCase() as Marketplace
  if (!MARKETPLACES.includes(marketplace)) throw new Error(`Gecersiz pazaryeri: ${value}`)
  return marketplace
}

async function calculateMarketplacePrice(product: {
  id: string
  price: unknown
  brand: string | null
  categoryRaw: string | null
  source?: PurchaseCostSource | null
}, marketplace: Marketplace) {
  const rules = await prisma.priceRule.findMany({
    where: { active: true, OR: [{ marketplace }, { marketplace: '*' }] },
    orderBy: { priority: 'asc' },
  })

  const basePrice = calculatePurchaseCost(product.price, product.source)
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null
  const matchesRange = (rule: { priceStart: unknown; priceEnd: unknown }) => {
    const start = rule.priceStart === null ? null : Number(rule.priceStart)
    const end = rule.priceEnd === null ? null : Number(rule.priceEnd)
    if (start !== null && basePrice < start) return false
    if (end !== null && basePrice >= end) return false
    return true
  }
  const scopedRules = rules.filter(matchesRange)
  const rule = scopedRules.find(r => r.scopeType === 'PRODUCT' && r.scopeValue === product.id)
    ?? scopedRules.find(r => r.scopeType === 'BRAND' && product.brand && r.scopeValue === product.brand)
    ?? scopedRules.find(r => r.scopeType === 'CATEGORY' && product.categoryRaw && r.scopeValue && product.categoryRaw.includes(r.scopeValue))
    ?? scopedRules.find(r => r.scopeType === 'MARKETPLACE' && r.marketplace === marketplace)
    ?? scopedRules.find(r => r.scopeType === 'GLOBAL')

  if (!rule) return null

  const ekTutar = Number(rule.ekTutar)
  const karOrani = Number(rule.karOrani)
  const kargo = Number(rule.kargo)
  const komisyonOrani = Number(rule.komisyonOrani)
  if (karOrani < 1 || komisyonOrani >= 1) return null

  const rawPrice = ((basePrice + ekTutar) * karOrani + kargo) / (1 - komisyonOrani)
  let finalPrice = Math.round(rawPrice * 100) / 100
  const globalSetting = await prisma.globalPriceSetting.findFirst()
  const minPrice = globalSetting ? Number(globalSetting.minPrice) : 50
  if (finalPrice < minPrice) finalPrice = minPrice
  return { finalPrice, ruleName: rule.name }
}

function cleanCredential(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text || text === '********') return ''
  return text
}

async function activeMarketplaceCredentials(marketplace: Marketplace): Promise<Record<string, string>> {
  const record = await prisma.marketplaceCredential.findUnique({ where: { marketplace } })
  if (!record?.isActive) return {}
  return decryptJson(record.credentialsEncrypted)
}

async function createAdapter(marketplace: Marketplace) {
  if (marketplace === 'TRENDYOL') {
    const credentials = await activeMarketplaceCredentials(marketplace)
    const apiKey = cleanCredential(credentials.apiKey || process.env.TY_API_KEY)
    const apiSecret = cleanCredential(credentials.apiSecret || process.env.TY_API_SECRET)
    const supplierId = cleanCredential(credentials.supplierId || process.env.TY_SUPPLIER_ID)
    if (!apiKey || !apiSecret || !supplierId) {
      throw new Error('Trendyol API bilgileri aktif pazaryeri ayarlarinda veya .env icinde tanimli olmali')
    }
    return new TrendyolAdapter(apiKey, apiSecret, supplierId)
  }

  if (marketplace === 'N11') {
    const credentials = await activeMarketplaceCredentials(marketplace)
    const appKey = cleanCredential(credentials.appKey || process.env.N11_APPKEY)
    const appSecret = cleanCredential(credentials.appSecret || process.env.N11_APPSECRET)
    const integrator = cleanCredential(credentials.integrator || process.env.N11_INTEGRATOR) || 'PazarioIntegration'
    if (!appKey || !appSecret) {
      throw new Error('N11 API bilgileri aktif pazaryeri ayarlarinda veya .env icinde tanimli olmali')
    }
    return new N11Adapter(appKey, appSecret, integrator)
  }

  if (marketplace === 'PAZARAMA') {
    const credentials = await activeMarketplaceCredentials(marketplace)
    const clientId = cleanCredential(credentials.clientId || process.env.PZ_CLIENT_ID)
    const clientSecret = cleanCredential(credentials.clientSecret || process.env.PZ_CLIENT_SECRET)
    if (!clientId || !clientSecret) {
      throw new Error('Pazarama API bilgileri aktif pazaryeri ayarlarinda veya .env icinde tanimli olmali')
    }
    return new PazaramaAdapter(clientId, clientSecret)
  }

  if (marketplace === 'HEPSIBURADA') {
    const credentials = await activeMarketplaceCredentials(marketplace)
    const merchantId = cleanCredential(credentials.merchantId || process.env.HB_MERCHANT_ID)
    const userAgent = cleanCredential(credentials.userAgent || credentials.developerUsername || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME)
    const serviceKey = cleanCredential(credentials.serviceKey || process.env.HB_SERVICE_KEY)
    const username = merchantId
    const password = cleanCredential(serviceKey || credentials.password || process.env.HB_PASSWORD)
    if (!merchantId || (!serviceKey && (!username || !password))) {
      throw new Error('Hepsiburada API bilgileri aktif pazaryeri ayarlarinda veya .env icinde tanimli olmali')
    }
    return new HepsiburadaAdapter(merchantId, serviceKey, username || merchantId, password || serviceKey, userAgent)
  }

  throw new Error(`${marketplace} icin gercek urun gonderimi henuz aktif degil`)
}

async function throttleMarketplacePublish(marketplace: Marketplace): Promise<void> {
  const delayMs = MARKETPLACE_PUBLISH_DELAY_MS[marketplace] ?? 0
  if (delayMs <= 0) return

  const now = Date.now()
  const lastAttemptAt = lastPublishAttemptAt.get(marketplace) ?? 0
  const waitMs = Math.max(0, delayMs - (now - lastAttemptAt))
  if (waitMs > 0) {
    logger.info({ marketplace, waitMs }, 'Pazaryeri gonderimi rate limit icin bekletiliyor')
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
  lastPublishAttemptAt.set(marketplace, Date.now())
}

async function waitForTrendyolBatch(adapter: TrendyolAdapter, batchRequestId: string) {
  const maxAttempts = Math.max(6, Number(process.env.TY_BATCH_WAIT_ATTEMPTS || '120'))
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 5000))
    const batch = await adapter.getBatchRequestResult(batchRequestId)
    if (batch.status !== 'COMPLETED') continue

    const failedReasons = (batch.items ?? [])
      .filter(item => item.status && item.status !== 'SUCCESS')
      .flatMap(item => item.failureReasons ?? [])

    if ((batch.failedItemCount ?? 0) > 0 || failedReasons.length > 0) {
      return {
        completed: true,
        success: false,
        message: failedReasons.join(' | ') || 'Trendyol batch tamamlandi ancak urun basarisiz',
      }
    }

    return { completed: true, success: true, message: 'Trendyol batch basarili' }
  }

  return { completed: false, success: false, message: 'Trendyol batch sonucu henuz tamamlanmadi' }
}

function n11TaskReasons(task: Awaited<ReturnType<N11Adapter['getTaskDetail']>>): string[] {
  const skuReasons = task.skus?.content?.flatMap(item => [
    ...(item.reasons ?? []),
    ...(item.sku?.reasons ?? []),
  ]) ?? []
  return Array.from(new Set(skuReasons.map(String).filter(Boolean)))
}

async function waitForN11Task(adapter: N11Adapter, taskId: string) {
  const maxAttempts = Math.max(6, Number(process.env.N11_TASK_WAIT_ATTEMPTS || '120'))
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 5000))
    const task = await adapter.getTaskDetail(taskId)
    const taskStatus = String(task.status ?? '').toUpperCase()
    const skuStatuses = task.skus?.content?.map(item => String(item.status ?? '').toUpperCase()).filter(Boolean) ?? []
    const reasons = n11TaskReasons(task)

    if (taskStatus === 'REJECT') {
      return {
        completed: true,
        success: false,
        message: reasons.join(' | ') || 'N11 task reddedildi',
      }
    }

    if (taskStatus === 'PROCESSED') {
      const failed = skuStatuses.some(status => status && status !== 'SUCCESS')
      return {
        completed: true,
        success: !failed,
        message: failed
          ? reasons.join(' | ') || 'N11 task tamamlandi ancak urun basarisiz'
          : 'N11 task basarili',
      }
    }
  }

  return { completed: false, success: false, message: 'N11 task sonucu henuz tamamlanmadi' }
}

function pazaramaBatchErrors(batch: Awaited<ReturnType<PazaramaAdapter['getBatchResult']>>): string[] {
  const root = batch as any
  const candidates = [
    root?.errors,
    root?.data?.errors,
    root?.data?.error?.errors,
    root?.data?.items,
    root?.data?.products,
    root?.items,
    root?.products,
  ]
  const errors: string[] = []
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const item of candidate) {
      if (typeof item === 'string') errors.push(item)
      else if (item?.errorMessage) errors.push(String(item.errorMessage))
      else if (item?.message && (item?.success === false || item?.isSuccess === false || item?.status === 'FAILED')) errors.push(String(item.message))
      else if (Array.isArray(item?.errors)) errors.push(...item.errors.map(String))
    }
  }
  const message = root?.message ?? root?.userMessage ?? root?.data?.message ?? root?.data?.userMessage
  if (root?.success === false && message) errors.push(String(message))
  return Array.from(new Set(errors.filter(Boolean)))
}

function pazaramaResultIsExistingProduct(result: { message?: string }): boolean {
  const normalized = String(result.message ?? '').toLocaleLowerCase('tr-TR')
  return normalized.includes('zaten mevcut') || normalized.includes('yayinda olarak eslestirildi')
}

function pazaramaResultIsAcceptedWithoutBatch(result: { message?: string; listingId?: string }): boolean {
  const normalized = String(result.message ?? '').toLowerCase()
  return !result.listingId && normalized.includes('kabul edildi') && normalized.includes('batchrequest')
}

function hepsiburadaImportErrors(status: Awaited<ReturnType<HepsiburadaAdapter['getImportStatus']>>): string[] {
  const root = status as any
  const candidates = [
    root?.importMessages,
    root?.data?.importMessages,
    root?.data,
    root?.items,
    root?.products,
    root?.data?.items,
    root?.data?.products,
  ]
  const errors: string[] = []
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const item of candidate) {
      if (typeof item === 'string') errors.push(item)
      if (item?.message && (!item?.severity || String(item.severity).toUpperCase() === 'ERROR')) errors.push(String(item.message))
      if (Array.isArray(item?.importMessages)) {
        errors.push(...item.importMessages
          .filter((detail: any) => !detail?.severity || String(detail.severity).toUpperCase() === 'ERROR')
          .map((detail: any) => String(detail?.message ?? ''))
          .filter(Boolean))
      }
      if (Array.isArray(item?.rejectReasonsMessages)) {
        errors.push(...item.rejectReasonsMessages.map((detail: any) => String(detail?.message ?? detail ?? '')).filter(Boolean))
      }
      if (item?.taskDetails?.reason) errors.push(String(item.taskDetails.reason))
      if (Array.isArray(item?.taskDetails)) errors.push(...item.taskDetails.map((detail: any) => String(detail?.reason ?? detail?.message ?? '')).filter(Boolean))
      if (Array.isArray(item?.validationResults)) errors.push(...item.validationResults.map((detail: any) => `${detail?.attributeName ?? 'Alan'}: ${detail?.message ?? ''}`.trim()).filter(Boolean))
    }
  }
  const message = root?.message ?? root?.data?.message
  if (String(root?.status ?? root?.importStatus ?? '').toUpperCase() === 'FAILED' && message) errors.push(String(message))
  return Array.from(new Set(errors.filter(Boolean)))
}

async function waitForHepsiburadaImport(adapter: HepsiburadaAdapter, trackingId: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 10000))
    const result = await adapter.getImportStatus(trackingId)
    const root = result as any
    const firstItem = Array.isArray(root?.data) ? root.data[0] : null
    const status = String(root?.status ?? root?.importStatus ?? root?.data?.status ?? root?.data?.importStatus ?? firstItem?.importStatus ?? '').toUpperCase()
    const productStatus = String(firstItem?.productStatus ?? root?.productStatus ?? root?.data?.productStatus ?? '').toLocaleUpperCase('tr-TR')
    const hbSku = String(firstItem?.hbSku ?? root?.hbSku ?? root?.data?.hbSku ?? '').trim()
    const errors = hepsiburadaImportErrors(result)

    if (status.includes('FAILED') || errors.length > 0) {
      return {
        completed: true,
        success: false,
        message: errors.join(' | ') || 'Hepsiburada import basarisiz',
      }
    }

    if (status.includes('SUCCESS') || status.includes('DONE') || status.includes('COMPLETED')) {
      const catalogCompleted = Boolean(hbSku) || ['MATCHED', 'APPROVED', 'PUBLISHED', 'ACTIVE'].some(value => productStatus.includes(value))
      if (catalogCompleted) return { completed: true, success: true, message: 'Hepsiburada katalog urunu onaylandi' }
      return {
        completed: false,
        success: true,
        pendingReview: true,
        message: `Hepsiburada importu kabul edildi; katalog durumu: ${firstItem?.productStatus ?? 'beklemede'}`,
      }
    }
  }

  return { completed: false, success: true, message: 'Hepsiburada import sonucu henuz tamamlanmadi' }
}

async function waitForPazaramaBatch(adapter: PazaramaAdapter, batchRequestId: string) {
  const maxAttempts = Math.max(4, Number(process.env.PZ_BATCH_WAIT_ATTEMPTS || '40'))
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 15000))
    const batch = await adapter.getBatchResult(batchRequestId)
    const root = batch as any
    const status = String(root?.status ?? root?.data?.status ?? root?.data?.batchStatus ?? '').toUpperCase()
    const errors = pazaramaBatchErrors(batch)

    if (root?.success === false || errors.length > 0 || ['FAILED', 'ERROR', 'REJECTED'].includes(status)) {
      return {
        completed: true,
        success: false,
        message: errors.join(' | ') || root?.userMessage || root?.message || 'Pazarama batch basarisiz',
      }
    }

    if (root?.success === true || ['COMPLETED', 'SUCCESS', 'PROCESSED', 'DONE'].includes(status)) {
      return { completed: true, success: true, message: 'Pazarama batch basarili' }
    }
  }

  return { completed: false, success: false, message: 'Pazarama batch sonucu henuz tamamlanmadi' }
}

async function buildAdapterProduct(productId: string, marketplace: Marketplace): Promise<AdapterProduct & {
  categoryId: string
  marketplaceAttributes: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }>
}> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      productAttributes: { where: { marketplace } },
      source: {
        select: {
          priceIncludesVat: true,
          purchaseVatRate: true,
          purchaseExtraFee: true,
          name: true,
        },
      },
    },
  })
  if (!product) throw new Error(`Urun bulunamadi: ${productId}`)

  const categoryMapping = await findApprovedCategoryMapping(prisma, {
    sourceId: product.sourceId,
    sourceCategory: product.categoryRaw,
    marketplace,
  })
  if (!categoryMapping?.marketplaceCategoryId) throw new Error('Onayli kategori eslesmesi yok')

  const price = await calculateMarketplacePrice(product, marketplace)
  if (!price?.finalPrice) throw new Error('Hesaplanmis pazaryeri fiyati yok')

  await applyXmlColorSizeOverrides(prisma, product, marketplace, categoryMapping.marketplaceCategoryId)
  const productAttributes = await prisma.productAttribute.findMany({
    where: { productId, marketplace },
  })

  const marketplaceAttributes = productAttributes
    .map(attr => {
      const usesStringAttributeIds = marketplace === 'PAZARAMA' || marketplace === 'HEPSIBURADA'
      const attributeId = usesStringAttributeIds ? attr.attributeId : Number(attr.attributeId)
      const attributeValueId = attr.valueId
        ? usesStringAttributeIds ? attr.valueId : Number(attr.valueId)
        : undefined
      if (typeof attributeId === 'number' && !Number.isFinite(attributeId)) return null
      if (attributeValueId && Number.isFinite(attributeValueId)) {
        return { attributeId, attributeValueId }
      }
      if (typeof attributeValueId === 'string') {
        return { attributeId, attributeValueId }
      }
      if (attr.valueText) {
        return { attributeId, customAttributeValue: attr.valueText }
      }
      return null
    })
    .filter(Boolean) as Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }>

  let barcode = product.barcode ?? product.sku
  if (marketplace === 'HEPSIBURADA' && product.barcode) {
    const duplicateBarcode = await prisma.product.findFirst({
      where: {
        barcode: product.barcode,
        id: { not: product.id },
      },
      select: { id: true },
    })
    if (duplicateBarcode) barcode = marketplaceUniqueBarcode(product.sku, product.id)
  }

  return {
    id: product.id,
    title: product.title,
    description: product.description || product.title,
    price: price.finalPrice,
    stock: product.stock,
    sku: product.sku,
    barcode,
    productMainId: typeof product.attributes === 'object' && product.attributes && !Array.isArray(product.attributes)
      ? String((product.attributes as Record<string, unknown>).variantParentSku || product.sku)
      : product.sku,
    ...effectiveProductMedia(product),
    category: categoryMapping.marketplaceCategoryId,
    categoryId: categoryMapping.marketplaceCategoryId,
    brand: product.brand ?? undefined,
    marketplaceBrand: marketplaceBrandForSource(product.source?.name),
    marketplaceAttributes,
  }
}

export const publishWorker = new Worker<PublishJobData>(
  'publish',
  async (job) => {
    const { productId, productIds, marketplace: marketplaceValue, publishJobId, publishJobIds, syncJobId, force, operationId } = job.data
    const marketplace = normalizeMarketplace(marketplaceValue)
    const groupProductIds = Array.from(new Set(productIds ?? []))
    if (operationId) {
      await operationService.markRunning(operationId, { queueJobId: job.id })
      await operationService.updateItemsByProductIds(operationId, groupProductIds.length > 0 ? groupProductIds : [productId], 'RUNNING')
    }
    try {
    if ((marketplace === 'TRENDYOL' || marketplace === 'HEPSIBURADA') && groupProductIds.length > 1) {
      const adapter = await createAdapter(marketplace)
      if (!(adapter instanceof TrendyolAdapter) && !(adapter instanceof HepsiburadaAdapter)) throw new Error(`${marketplace} adapter olusturulamadi`)

      await Promise.all(groupProductIds.map(id =>
        prisma.marketplaceListing.upsert({
          where: { productId_marketplace: { productId: id, marketplace } },
          create: { productId: id, marketplace, status: 'PENDING' },
          update: { status: 'PENDING', lastUpdatedAt: new Date() },
        })
      ))

      if (publishJobIds?.length) {
        await prisma.productPublishJob.updateMany({
          where: { id: { in: publishJobIds } },
          data: { status: 'QUEUED', submittedAt: new Date() },
        })
      }

      const adapterProducts = await Promise.all(groupProductIds.map(id => buildAdapterProduct(id, marketplace)))
      const result = adapter instanceof TrendyolAdapter && force
        ? await adapter.updateProducts(adapterProducts)
        : await adapter.publishProducts(adapterProducts)

      if (!result.success) {
        const message = result.errors?.join(' | ') || result.message
        if (operationId) {
          await operationService.updateItemsByProductIds(operationId, groupProductIds, 'FAILED', { errorMessage: message })
          await operationService.markFinished(operationId, 'FAILED', {
            errorMessage: message,
            failedCount: groupProductIds.length,
          })
        }
        await prisma.marketplaceListing.updateMany({
          where: { productId: { in: groupProductIds }, marketplace },
          data: { status: 'FAILED', lastUpdatedAt: new Date() },
        })
        if (publishJobIds?.length) {
          await prisma.productPublishJob.updateMany({
            where: { id: { in: publishJobIds } },
            data: { status: 'FAILED', errorMessage: message, resolvedAt: new Date() },
          })
        }
        throw new Error(message)
      }

      let listingStatus: 'PENDING' | 'PUBLISHED' = 'PENDING'
      let jobStatus: 'SUBMITTED' | 'POLLING' | 'SUCCESS' = 'SUBMITTED'
      if (result.listingId) {
        if (operationId) {
          await operationService.markWaitingMarketplace(operationId, result.listingId, 'Marketplace batch sonucu bekleniyor')
          await operationService.updateItemsByProductIds(operationId, groupProductIds, 'RUNNING', { externalBatchId: result.listingId })
        }
        const batch = adapter instanceof TrendyolAdapter
          ? await waitForTrendyolBatch(adapter, result.listingId)
          : await waitForHepsiburadaImport(adapter as HepsiburadaAdapter, result.listingId)
        if (batch.completed && !batch.success) {
          if (operationId) {
            await operationService.updateItemsByProductIds(operationId, groupProductIds, 'FAILED', {
              externalBatchId: result.listingId,
              errorMessage: batch.message,
            })
            await operationService.markFinished(operationId, 'FAILED', {
              externalBatchId: result.listingId,
              errorMessage: batch.message,
              failedCount: groupProductIds.length,
            })
          }
          await prisma.marketplaceListing.updateMany({
            where: { productId: { in: groupProductIds }, marketplace },
            data: { status: 'FAILED', lastUpdatedAt: new Date() },
          })
          if (publishJobIds?.length) {
            await prisma.productPublishJob.updateMany({
              where: { id: { in: publishJobIds } },
              data: { status: 'FAILED', errorMessage: batch.message, resolvedAt: new Date() },
            })
          }
          throw new Error(batch.message)
        }
        if (batch.completed && batch.success) {
          listingStatus = 'PUBLISHED'
          jobStatus = 'SUCCESS'
        } else if (marketplace === 'HEPSIBURADA') {
          jobStatus = 'POLLING'
        }
      }

      const products = await prisma.product.findMany({
        where: { id: { in: groupProductIds } },
        select: { id: true, contentHash: true },
      })
      const contentHashById = new Map(products.map(product => [product.id, product.contentHash]))
      await Promise.all(groupProductIds.map(id =>
        prisma.marketplaceListing.update({
          where: { productId_marketplace: { productId: id, marketplace } },
          data: {
            status: listingStatus,
            externalListingId: result.listingId,
            publishedAt: listingStatus === 'PUBLISHED' ? new Date() : null,
            hashAtPublish: listingStatus === 'PUBLISHED' ? contentHashById.get(id) : null,
            lastUpdatedAt: new Date(),
          },
        })
      ))
      if (publishJobIds?.length) {
        await prisma.productPublishJob.updateMany({
          where: { id: { in: publishJobIds } },
          data: {
            status: jobStatus,
            externalJobId: result.listingId,
            submittedAt: new Date(),
            resolvedAt: jobStatus === 'SUCCESS' ? new Date() : undefined,
          },
        })
      }
      if (operationId) {
        await operationService.updateItemsByProductIds(operationId, groupProductIds, listingStatus === 'PUBLISHED' ? 'SUCCEEDED' : 'RUNNING', {
          externalListingId: result.listingId,
          externalBatchId: result.listingId,
        })
        if (listingStatus === 'PUBLISHED') {
          await operationService.markFinished(operationId, 'SUCCEEDED', {
            externalBatchId: result.listingId,
            successCount: groupProductIds.length,
            failedCount: 0,
          })
        } else {
          await operationService.markWaitingMarketplace(operationId, result.listingId, 'Hepsiburada katalog incelemesi bekleniyor')
        }
      }

      logger.info({ productIds: groupProductIds, marketplace, batchRequestId: result.listingId }, 'Varyant grubu pazaryerine tek batch gonderildi')
      return
    }
    const existingListing = await prisma.marketplaceListing.findUnique({
      where: { productId_marketplace: { productId, marketplace } },
      select: { status: true },
    })
    const shouldUpdateExistingTrendyol = Boolean(force && marketplace === 'TRENDYOL' && existingListing?.status === 'PUBLISHED')

    await prisma.marketplaceListing.upsert({
      where: { productId_marketplace: { productId, marketplace } },
      create: { productId, marketplace, status: 'PENDING' },
      update: { status: 'PENDING', lastUpdatedAt: new Date() },
    })

    if (publishJobId) {
      await prisma.productPublishJob.update({
        where: { id: publishJobId },
        data: { status: 'QUEUED', submittedAt: new Date() },
      })
    }

    const adapterProduct = await buildAdapterProduct(productId, marketplace)
    const adapter = await createAdapter(marketplace)
    await throttleMarketplacePublish(marketplace)
    const result = shouldUpdateExistingTrendyol && adapter instanceof TrendyolAdapter
      ? await adapter.updateProduct(adapterProduct)
      : await adapter.publishProduct(adapterProduct)

    if (!result.success) {
      const message = result.errors?.join(' | ') || result.message
      if (operationId) {
        await operationService.updateItemsByProductIds(operationId, [productId], 'FAILED', { errorMessage: message })
        await operationService.markFinished(operationId, 'FAILED', {
          errorMessage: message,
          failedCount: 1,
        })
      }
      await prisma.marketplaceListing.update({
        where: { productId_marketplace: { productId, marketplace } },
        data: { status: 'FAILED', lastUpdatedAt: new Date() },
      })
      if (syncJobId) {
        await prisma.publishError.create({
          data: {
            jobId: syncJobId,
            productId,
            marketplace,
            errorType: 'API',
            errorMessage: message,
          },
        })
      }
      if (publishJobId) {
        await prisma.productPublishJob.update({
          where: { id: publishJobId },
          data: { status: 'FAILED', errorMessage: message, resolvedAt: new Date() },
        })
      }
      throw new Error(message)
    }

    let listingStatus: 'PENDING' | 'PUBLISHED' = 'PENDING'
    let jobStatus: 'SUBMITTED' | 'POLLING' | 'SUCCESS' = 'SUBMITTED'
    if (marketplace === 'TRENDYOL' && result.listingId) {
      if (operationId) await operationService.markWaitingMarketplace(operationId, result.listingId, 'Trendyol batch sonucu bekleniyor')
      const batch = await waitForTrendyolBatch(adapter as TrendyolAdapter, result.listingId)
      if (batch.completed && !batch.success) {
        if (operationId) {
          await operationService.updateItemsByProductIds(operationId, [productId], 'FAILED', {
            externalBatchId: result.listingId,
            errorMessage: batch.message,
          })
          await operationService.markFinished(operationId, 'FAILED', {
            externalBatchId: result.listingId,
            errorMessage: batch.message,
            failedCount: 1,
          })
        }
        await prisma.marketplaceListing.update({
          where: { productId_marketplace: { productId, marketplace } },
          data: { status: 'FAILED', lastUpdatedAt: new Date() },
        })
        if (publishJobId) {
          await prisma.productPublishJob.update({
            where: { id: publishJobId },
            data: { status: 'FAILED', errorMessage: batch.message, resolvedAt: new Date() },
          })
        }
        throw new Error(batch.message)
      }
      if (batch.completed && batch.success) {
        listingStatus = 'PUBLISHED'
        jobStatus = 'SUCCESS'
      }
    }
    if (marketplace === 'N11' && result.listingId) {
      if (operationId) await operationService.markWaitingMarketplace(operationId, result.listingId, 'N11 task sonucu bekleniyor')
      const task = await waitForN11Task(adapter as N11Adapter, result.listingId)
      if (task.completed && !task.success) {
        if (operationId) {
          await operationService.updateItemsByProductIds(operationId, [productId], 'FAILED', {
            externalBatchId: result.listingId,
            errorMessage: task.message,
          })
          await operationService.markFinished(operationId, 'FAILED', {
            externalBatchId: result.listingId,
            errorMessage: task.message,
            failedCount: 1,
          })
        }
        await prisma.marketplaceListing.update({
          where: { productId_marketplace: { productId, marketplace } },
          data: { status: 'FAILED', lastUpdatedAt: new Date() },
        })
        if (publishJobId) {
          await prisma.productPublishJob.update({
            where: { id: publishJobId },
            data: { status: 'FAILED', errorMessage: task.message, resolvedAt: new Date(), lastPolledAt: new Date() },
          })
        }
        throw new Error(task.message)
      }
      if (task.completed && task.success) {
        listingStatus = 'PUBLISHED'
        jobStatus = 'SUCCESS'
      }
    }
    if (marketplace === 'PAZARAMA' && result.listingId) {
      if (pazaramaResultIsExistingProduct(result)) {
        listingStatus = 'PUBLISHED'
        jobStatus = 'SUCCESS'
      } else {
        if (operationId) await operationService.markWaitingMarketplace(operationId, result.listingId, 'Pazarama batch sonucu bekleniyor')
        const batch = await waitForPazaramaBatch(adapter as PazaramaAdapter, result.listingId)
        if (batch.completed && !batch.success) {
          if (operationId) {
            await operationService.updateItemsByProductIds(operationId, [productId], 'FAILED', {
              externalBatchId: result.listingId,
              errorMessage: batch.message,
            })
            await operationService.markFinished(operationId, 'FAILED', {
              externalBatchId: result.listingId,
              errorMessage: batch.message,
              failedCount: 1,
            })
          }
          await prisma.marketplaceListing.update({
            where: { productId_marketplace: { productId, marketplace } },
            data: { status: 'FAILED', lastUpdatedAt: new Date() },
          })
          if (publishJobId) {
            await prisma.productPublishJob.update({
              where: { id: publishJobId },
              data: { status: 'FAILED', errorMessage: batch.message, resolvedAt: new Date(), lastPolledAt: new Date() },
            })
          }
          throw new Error(batch.message)
        }
        if (batch.completed && batch.success) {
          listingStatus = 'PUBLISHED'
          jobStatus = 'SUCCESS'
        }
      }
    }
    if (marketplace === 'HEPSIBURADA' && result.listingId) {
      if (operationId) await operationService.markWaitingMarketplace(operationId, result.listingId, 'Hepsiburada import sonucu bekleniyor')
      const importResult = await waitForHepsiburadaImport(adapter as HepsiburadaAdapter, result.listingId)
      if (importResult.completed && !importResult.success) {
        if (operationId) {
          await operationService.updateItemsByProductIds(operationId, [productId], 'FAILED', {
            externalBatchId: result.listingId,
            errorMessage: importResult.message,
          })
          await operationService.markFinished(operationId, 'FAILED', {
            externalBatchId: result.listingId,
            errorMessage: importResult.message,
            failedCount: 1,
          })
        }
        await prisma.marketplaceListing.update({
          where: { productId_marketplace: { productId, marketplace } },
          data: { status: 'FAILED', lastUpdatedAt: new Date() },
        })
        if (publishJobId) {
          await prisma.productPublishJob.update({
            where: { id: publishJobId },
            data: { status: 'FAILED', errorMessage: importResult.message, resolvedAt: new Date(), lastPolledAt: new Date() },
          })
        }
        throw new Error(importResult.message)
      }
      if (importResult.completed && importResult.success) {
        listingStatus = 'PUBLISHED'
        jobStatus = 'SUCCESS'
      } else {
        jobStatus = 'POLLING'
      }
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { contentHash: true },
    })

    await prisma.marketplaceListing.update({
      where: { productId_marketplace: { productId, marketplace } },
      data: {
        status: listingStatus,
        externalListingId: result.listingId,
        publishedAt: listingStatus === 'PUBLISHED' ? new Date() : null,
        hashAtPublish: listingStatus === 'PUBLISHED' ? product?.contentHash : null,
        lastUpdatedAt: new Date(),
      },
    })
    if (publishJobId) {
      await prisma.productPublishJob.update({
        where: { id: publishJobId },
        data: {
          status: jobStatus,
          externalJobId: result.listingId,
          submittedAt: new Date(),
          lastPolledAt: marketplace === 'N11' || marketplace === 'PAZARAMA' || marketplace === 'HEPSIBURADA' ? new Date() : undefined,
          resolvedAt: jobStatus === 'SUCCESS' ? new Date() : undefined,
        },
      })
    }
    if (operationId) {
      const pazaramaAcceptedWithoutBatch = marketplace === 'PAZARAMA' && pazaramaResultIsAcceptedWithoutBatch(result)
      await operationService.updateItemsByProductIds(operationId, [productId], listingStatus === 'PUBLISHED' || pazaramaAcceptedWithoutBatch ? 'SUCCEEDED' : 'RUNNING', {
        externalListingId: result.listingId,
        externalBatchId: result.listingId,
      })
      if (listingStatus === 'PUBLISHED' || pazaramaAcceptedWithoutBatch) {
        await operationService.markFinished(operationId, 'SUCCEEDED', {
          externalBatchId: result.listingId,
          successCount: 1,
          failedCount: 0,
        })
      } else {
        const waitingMessage = marketplace === 'HEPSIBURADA'
          ? 'Hepsiburada katalog incelemesi bekleniyor'
          : `${marketplace} batch/task sonucu bekleniyor`
        await operationService.markWaitingMarketplace(operationId, result.listingId, waitingMessage)
      }
    }

    logger.info({ productId, marketplace, batchRequestId: result.listingId }, 'Urun pazaryerine gonderildi')
    } catch (error) {
      if (operationId) {
        const targetProductIds = groupProductIds.length > 0 ? groupProductIds : [productId]
        const message = error instanceof Error ? error.message : String(error)
        await operationService.updateItemsByProductIds(operationId, targetProductIds, 'FAILED', { errorMessage: message })
        await operationService.markFinished(operationId, 'FAILED', {
          errorMessage: message,
          failedCount: targetProductIds.length,
        })
      }
      throw error
    }
  },
  {
    connection: redis,
    concurrency: 1,
    lockDuration: 300000,
    stalledInterval: 60000,
    maxStalledCount: 2,
  }
)

publishWorker.on('failed', async (job, err) => {
  if (!job) return
  const { productId, marketplace } = job.data

  await notifyQueue.add('publish-failed', {
    type: 'slack',
    message: `Publish basarisiz: ${productId} / ${marketplace} - ${err.message}`,
    level: 'error',
  })
})
