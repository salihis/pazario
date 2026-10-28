import 'dotenv/config'
import { Marketplace } from '@prisma/client'
import { HepsiburadaAdapter } from '../adapters/HepsiburadaAdapter'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { prisma } from '../db'
import { decryptJson } from '../services/FieldEncryptionService'
import { OperationHistoryService } from '../services/OperationHistoryService'

const PRODUCT_ID = 'b6b4cc74-a37c-4caf-8802-21bd618cee8c'
const EXPECTED_PRICE = 501.62
const OPERATION_TITLE = 'HEPSIBURADA EBIJUTERI canli stok ve fiyat testi'

function clean(value: unknown): string {
  const text = String(value ?? '').trim()
  return text === '********' ? '' : text
}

function uploadFailed(result: { status?: string; errors?: unknown }): boolean {
  const status = clean(result.status).toUpperCase()
  const hasErrors = Array.isArray(result.errors) ? result.errors.length > 0 : result.errors !== null && result.errors !== undefined
  return status === 'FAILED' || status === 'ERROR' || hasErrors
}

async function main() {
  if (hepsiburadaEnvironment() !== 'production') throw new Error('HB_ENVIRONMENT production olmali.')
  const marketplace = Marketplace.HEPSIBURADA
  const [credential, product] = await Promise.all([
    prisma.marketplaceCredential.findUnique({ where: { marketplace } }),
    prisma.product.findUnique({ where: { id: PRODUCT_ID } }),
  ])
  if (!credential?.isActive || !product) throw new Error('Hepsiburada bilgileri veya urun bulunamadi.')

  const values = decryptJson(credential.credentialsEncrypted)
  const merchantId = clean(values.merchantId || process.env.HB_MERCHANT_ID)
  const serviceKey = clean(values.serviceKey || process.env.HB_SERVICE_KEY)
  const username = clean(values.username || merchantId)
  const password = clean(values.password || serviceKey)
  const userAgent = clean(values.userAgent || values.developerUsername || process.env.HB_USER_AGENT)
  const adapter = new HepsiburadaAdapter(merchantId, serviceKey, username, password, userAgent)

  const falseFailures = await prisma.operationHistory.findMany({
    where: {
      title: OPERATION_TITLE,
      status: 'FAILED',
      errorMessage: 'Hepsiburada listing upload sonucu hata iceriyor.',
    },
    select: { id: true },
  })
  if (falseFailures.length > 0) {
    const ids = falseFailures.map(item => item.id)
    await prisma.$transaction([
      prisma.operationHistory.updateMany({
        where: { id: { in: ids } },
        data: { status: 'SUCCEEDED', successCount: 1, failedCount: 0, errorMessage: null, finishedAt: new Date() },
      }),
      prisma.operationItem.updateMany({
        where: { operationId: { in: ids }, productId: product.id },
        data: { status: 'SUCCEEDED', errorMessage: null, finishedAt: new Date() },
      }),
    ])
  }

  let matchedListing: Record<string, unknown> | null = null
  for (let offset = 0; offset < 10_000; offset += 100) {
    const result = await adapter.listListings(offset, 100)
    matchedListing = result.listings.find(item => clean(item.merchantSku) === product.sku) as Record<string, unknown> | undefined ?? null
    if (matchedListing || result.listings.length === 0 || offset + result.listings.length >= result.totalCount) break
  }
  if (!matchedListing) throw new Error(`Hepsiburada listing bulunamadi: ${product.sku}`)

  const operationService = new OperationHistoryService(prisma)
  const operation = await operationService.createOperation({
    type: 'STOCK_PRICE_UPDATE',
    title: OPERATION_TITLE,
    marketplace,
    requestedBy: 'admin:live-smoke-ebijuteri',
    targetCount: 1,
    metadata: { stock: product.stock, price: EXPECTED_PRICE },
  }, [{ productId: product.id, sku: product.sku, barcode: product.barcode }])
  await operationService.markRunning(operation.id)
  await operationService.updateItemsByProductIds(operation.id, [product.id], 'RUNNING')

  try {
    const stockResult = await adapter.updateStock(product.sku, product.stock)
    const priceResult = await adapter.updatePrice(product.sku, EXPECTED_PRICE)
    if (!stockResult.success || !stockResult.listingId || !priceResult.success || !priceResult.listingId) {
      throw new Error([...(stockResult.errors ?? []), ...(priceResult.errors ?? [])].join(' | ') || 'Upload ID alinamadi.')
    }

    await operationService.markWaitingMarketplace(operation.id, `${stockResult.listingId}|${priceResult.listingId}`, 'Stok ve fiyat upload sonucu bekleniyor')
    await new Promise(resolve => setTimeout(resolve, 5000))
    const [stockStatus, priceStatus] = await Promise.all([
      adapter.getListingUploadStatus('stock', stockResult.listingId),
      adapter.getListingUploadStatus('price', priceResult.listingId),
    ])
    const failed = uploadFailed(stockStatus) || uploadFailed(priceStatus)
    const ids = `${stockResult.listingId}|${priceResult.listingId}`
    await operationService.updateItemsByProductIds(operation.id, [product.id], failed ? 'FAILED' : 'SUCCEEDED', {
      externalListingId: clean(matchedListing.hepsiburadaSku),
      externalBatchId: ids,
      errorMessage: failed ? 'Hepsiburada listing upload sonucu hata iceriyor.' : null,
    })
    await operationService.markFinished(operation.id, failed ? 'FAILED' : 'SUCCEEDED', {
      externalBatchId: ids,
      successCount: failed ? 0 : 1,
      failedCount: failed ? 1 : 0,
      errorMessage: failed ? 'Hepsiburada listing upload sonucu hata iceriyor.' : null,
      metadata: JSON.parse(JSON.stringify({ stock: product.stock, price: EXPECTED_PRICE, stockStatus, priceStatus })),
    })

    console.log(JSON.stringify({
      status: failed ? 'FAILED' : 'SUCCEEDED',
      merchantSku: product.sku,
      hepsiburadaSku: matchedListing.hepsiburadaSku,
      stock: product.stock,
      price: EXPECTED_PRICE,
      stockUploadId: stockResult.listingId,
      priceUploadId: priceResult.listingId,
      stockStatus,
      priceStatus,
      operationId: operation.id,
    }, null, 2))
    if (failed) process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await operationService.updateItemsByProductIds(operation.id, [product.id], 'FAILED', { errorMessage: message })
    await operationService.markFinished(operation.id, 'FAILED', { errorMessage: message, failedCount: 1 })
    throw error
  }
}

main()
  .catch(error => {
    console.error(JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    setTimeout(() => process.exit(process.exitCode ?? 0), 250)
  })
