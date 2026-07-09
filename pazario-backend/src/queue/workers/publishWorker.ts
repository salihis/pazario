import { Worker } from 'bullmq'
import { Marketplace, PrismaClient } from '@prisma/client'
import { redis } from '../../utils/redis'
import { notifyQueue } from '../queues'
import { logger } from '../../utils/logger'
import type { PublishJobData } from '../jobs'
import { TrendyolAdapter } from '../../adapters/TrendyolAdapter'
import { N11Adapter } from '../../adapters/N11Adapter'
import { PazaramaAdapter } from '../../adapters/PazaramaAdapter'
import type { Product as AdapterProduct } from '../../adapters/BaseAdapter'
import { findApprovedCategoryMapping } from '../../services/CategoryMappingService'
import { applyXmlColorSizeOverrides } from '../../services/XmlAttributeOverrideService'

const prisma = new PrismaClient()
const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

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
}, marketplace: Marketplace) {
  const rules = await prisma.priceRule.findMany({
    where: { active: true, OR: [{ marketplace }, { marketplace: '*' }] },
    orderBy: { priority: 'asc' },
  })

  const basePrice = Number(product.price)
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

function createAdapter(marketplace: Marketplace) {
  if (marketplace === 'TRENDYOL') {
    const apiKey = process.env.TY_API_KEY
    const apiSecret = process.env.TY_API_SECRET
    const supplierId = process.env.TY_SUPPLIER_ID
    if (!apiKey || !apiSecret || !supplierId) {
      throw new Error('TY_API_KEY, TY_API_SECRET ve TY_SUPPLIER_ID .env icinde tanimli olmali')
    }
    return new TrendyolAdapter(apiKey, apiSecret, supplierId)
  }

  if (marketplace === 'N11') {
    const appKey = process.env.N11_APPKEY
    const appSecret = process.env.N11_APPSECRET
    const integrator = process.env.N11_INTEGRATOR || 'PazarioIntegration'
    if (!appKey || !appSecret) {
      throw new Error('N11_APPKEY ve N11_APPSECRET .env icinde tanimli olmali')
    }
    return new N11Adapter(appKey, appSecret, integrator)
  }

  if (marketplace === 'PAZARAMA') {
    const clientId = process.env.PZ_CLIENT_ID
    const clientSecret = process.env.PZ_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new Error('PZ_CLIENT_ID ve PZ_CLIENT_SECRET .env icinde tanimli olmali')
    }
    return new PazaramaAdapter(clientId, clientSecret)
  }

  throw new Error(`${marketplace} icin gercek urun gonderimi henuz aktif degil`)
}

async function waitForTrendyolBatch(adapter: TrendyolAdapter, batchRequestId: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
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

  return { completed: false, success: true, message: 'Trendyol batch sonucu henuz tamamlanmadi' }
}

function n11TaskReasons(task: Awaited<ReturnType<N11Adapter['getTaskDetail']>>): string[] {
  const skuReasons = task.skus?.content?.flatMap(item => [
    ...(item.reasons ?? []),
    ...(item.sku?.reasons ?? []),
  ]) ?? []
  return Array.from(new Set(skuReasons.map(String).filter(Boolean)))
}

async function waitForN11Task(adapter: N11Adapter, taskId: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
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

  return { completed: false, success: true, message: 'N11 task sonucu henuz tamamlanmadi' }
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

async function waitForPazaramaBatch(adapter: PazaramaAdapter, batchRequestId: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
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

  return { completed: false, success: true, message: 'Pazarama batch sonucu henuz tamamlanmadi' }
}

async function buildAdapterProduct(productId: string, marketplace: Marketplace): Promise<AdapterProduct & {
  categoryId: string
  marketplaceAttributes: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }>
}> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { productAttributes: { where: { marketplace } } },
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
      const attributeId = marketplace === 'PAZARAMA' ? attr.attributeId : Number(attr.attributeId)
      const attributeValueId = attr.valueId
        ? marketplace === 'PAZARAMA' ? attr.valueId : Number(attr.valueId)
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

  return {
    id: product.id,
    title: product.title,
    description: product.description || product.title,
    price: price.finalPrice,
    stock: product.stock,
    sku: product.sku,
    barcode: product.barcode ?? product.sku,
    productMainId: typeof product.attributes === 'object' && product.attributes && !Array.isArray(product.attributes)
      ? String((product.attributes as Record<string, unknown>).variantParentSku || product.sku)
      : product.sku,
    images: product.images,
    category: categoryMapping.marketplaceCategoryId,
    categoryId: categoryMapping.marketplaceCategoryId,
    brand: product.brand ?? undefined,
    marketplaceAttributes,
  }
}

export const publishWorker = new Worker<PublishJobData>(
  'publish',
  async (job) => {
    const { productId, marketplace: marketplaceValue, publishJobId, force } = job.data
    const marketplace = normalizeMarketplace(marketplaceValue)
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
    const adapter = createAdapter(marketplace)
    const result = shouldUpdateExistingTrendyol && adapter instanceof TrendyolAdapter
      ? await adapter.updateProduct(adapterProduct)
      : await adapter.publishProduct(adapterProduct)

    if (!result.success) {
      const message = result.errors?.join(' | ') || result.message
      await prisma.marketplaceListing.update({
        where: { productId_marketplace: { productId, marketplace } },
        data: { status: 'FAILED', lastUpdatedAt: new Date() },
      })
      if (publishJobId) {
        await prisma.productPublishJob.update({
          where: { id: publishJobId },
          data: { status: 'FAILED', errorMessage: message, resolvedAt: new Date() },
        })
      }
      throw new Error(message)
    }

    let listingStatus: 'PENDING' | 'PUBLISHED' = 'PENDING'
    let jobStatus: 'SUBMITTED' | 'SUCCESS' = 'SUBMITTED'
    if (marketplace === 'TRENDYOL' && result.listingId) {
      const batch = await waitForTrendyolBatch(adapter as TrendyolAdapter, result.listingId)
      if (batch.completed && !batch.success) {
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
      const task = await waitForN11Task(adapter as N11Adapter, result.listingId)
      if (task.completed && !task.success) {
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
      const batch = await waitForPazaramaBatch(adapter as PazaramaAdapter, result.listingId)
      if (batch.completed && !batch.success) {
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

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { contentHash: true },
    })

    await prisma.marketplaceListing.update({
      where: { productId_marketplace: { productId, marketplace } },
      data: {
        status: listingStatus,
        externalListingId: result.listingId,
        publishedAt: listingStatus === 'PUBLISHED' ? new Date() : undefined,
        hashAtPublish: listingStatus === 'PUBLISHED' ? product?.contentHash : undefined,
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
          lastPolledAt: marketplace === 'N11' || marketplace === 'PAZARAMA' ? new Date() : undefined,
          resolvedAt: jobStatus === 'SUCCESS' ? new Date() : undefined,
        },
      })
    }

    logger.info({ productId, marketplace, batchRequestId: result.listingId }, 'Urun pazaryerine gonderildi')
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
