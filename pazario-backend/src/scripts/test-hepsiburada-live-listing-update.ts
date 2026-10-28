import 'dotenv/config'
import { Marketplace } from '@prisma/client'
import { HepsiburadaAdapter } from '../adapters/HepsiburadaAdapter'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { prisma } from '../db'
import { decryptJson } from '../services/FieldEncryptionService'
import { OperationHistoryService } from '../services/OperationHistoryService'

const PRODUCT_ID = '46bc0707-3697-4b0d-9dad-529565793559'
const EXPECTED_PRICE = 804.5

function clean(value: unknown): string {
  const text = String(value ?? '').trim()
  return text === '********' ? '' : text
}

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  const marketplace = Marketplace.HEPSIBURADA
  const [credential, product] = await Promise.all([
    prisma.marketplaceCredential.findUnique({ where: { marketplace } }),
    prisma.product.findUnique({ where: { id: PRODUCT_ID } }),
  ])
  if (!credential?.isActive) throw new Error('Aktif Hepsiburada bilgileri bulunamadi.')
  if (!product) throw new Error(`Urun bulunamadi: ${PRODUCT_ID}`)

  const values = decryptJson(credential.credentialsEncrypted)
  const merchantId = clean(values.merchantId || process.env.HB_MERCHANT_ID)
  const serviceKey = clean(values.serviceKey || values.password || process.env.HB_SERVICE_KEY || process.env.HB_PASSWORD)
  const userAgent = clean(values.userAgent || values.developerUsername || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME)
  if (!merchantId || !serviceKey || !userAgent) throw new Error('Hepsiburada canli API bilgileri eksik.')

  const adapter = new HepsiburadaAdapter(merchantId, serviceKey, merchantId, serviceKey, userAgent)
  let matchedListing: Record<string, unknown> | null = null
  let totalCount = 0
  for (let attempt = 0; attempt < 12 && !matchedListing; attempt += 1) {
    const result = await adapter.listListings(0, 100)
    totalCount = result.totalCount
    matchedListing = result.listings.find(listing =>
      String(listing.merchantSku ?? '').trim() === product.sku
    ) as Record<string, unknown> | undefined ?? null
    if (!matchedListing && attempt < 11) await new Promise(resolve => setTimeout(resolve, 10000))
  }
  if (!matchedListing) {
    console.log(JSON.stringify({
      status: 'WAITING_LISTING',
      merchantSku: product.sku,
      totalCount,
      message: 'Katalog importu basarili ancak urun listeleme envanterine henuz yansimadi.',
    }, null, 2))
    return
  }

  const operationService = new OperationHistoryService(prisma)
  const operation = await operationService.createOperation({
    type: 'STOCK_PRICE_UPDATE',
    title: 'HEPSIBURADA canli stok ve fiyat testi',
    marketplace,
    requestedBy: 'admin:live-smoke',
    targetCount: 1,
    metadata: { stock: product.stock, price: EXPECTED_PRICE },
  }, [{ productId: product.id, sku: product.sku, barcode: product.barcode }])
  await operationService.markRunning(operation.id)
  await operationService.updateItemsByProductIds(operation.id, [product.id], 'RUNNING')

  try {
    const stockResult = await adapter.updateStock(product.sku, product.stock)
    const priceResult = await adapter.updatePrice(product.sku, EXPECTED_PRICE)
    if (!stockResult.success || !stockResult.listingId || !priceResult.success || !priceResult.listingId) {
      const message = [...(stockResult.errors ?? []), ...(priceResult.errors ?? [])].join(' | ') || 'Upload ID alinamadi.'
      throw new Error(message)
    }

    await operationService.markWaitingMarketplace(operation.id, `${stockResult.listingId}|${priceResult.listingId}`, 'Stok ve fiyat upload sonucu bekleniyor')
    await new Promise(resolve => setTimeout(resolve, 5000))
    const [stockStatus, priceStatus] = await Promise.all([
      adapter.getListingUploadStatus('stock', stockResult.listingId),
      adapter.getListingUploadStatus('price', priceResult.listingId),
    ])
    const statusText = JSON.stringify({ stockStatus, priceStatus }).toUpperCase()
    const failed = statusText.includes('FAILED') || statusText.includes('ERROR')
    await operationService.updateItemsByProductIds(operation.id, [product.id], failed ? 'FAILED' : 'SUCCEEDED', {
      externalListingId: String(matchedListing.hepsiburadaSku ?? ''),
      externalBatchId: `${stockResult.listingId}|${priceResult.listingId}`,
      errorMessage: failed ? 'Hepsiburada listing upload sonucu hata iceriyor.' : null,
    })
    await operationService.markFinished(operation.id, failed ? 'FAILED' : 'SUCCEEDED', {
      externalBatchId: `${stockResult.listingId}|${priceResult.listingId}`,
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
  .finally(async () => prisma.$disconnect())
