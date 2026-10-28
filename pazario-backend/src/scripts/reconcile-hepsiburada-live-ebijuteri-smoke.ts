import 'dotenv/config'
import { Marketplace } from '@prisma/client'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { prisma } from '../db'

const PRODUCT_ID = 'b6b4cc74-a37c-4caf-8802-21bd618cee8c'
const PUBLISH_JOB_ID = 'fec1f613-03ca-4f02-bac6-624830158b72'
const OPERATION_ID = '252fef23-b4ce-4657-aad9-eb32404d25e8'
const HB_SKU = 'HBCV0000H2FL40'
const TRACKING_ID = 'faa7dfc4-2f0e-4d16-ad45-fc440cf9df12'

async function main() {
  if (hepsiburadaEnvironment() !== 'production') throw new Error('HB_ENVIRONMENT production olmali.')
  const marketplace = Marketplace.HEPSIBURADA
  const now = new Date()

  const [product, publishJob, operation] = await Promise.all([
    prisma.product.findUnique({ where: { id: PRODUCT_ID } }),
    prisma.productPublishJob.findUnique({ where: { id: PUBLISH_JOB_ID } }),
    prisma.operationHistory.findUnique({ where: { id: OPERATION_ID } }),
  ])
  if (!product || !publishJob || !operation) throw new Error('Uzlastirma kayitlarindan biri bulunamadi.')
  if (publishJob.externalJobId !== TRACKING_ID) throw new Error('Tracking ID beklenen kayitla uyusmuyor.')

  await prisma.$transaction(async tx => {
    await tx.marketplaceListing.update({
      where: { productId_marketplace: { productId: PRODUCT_ID, marketplace } },
      data: {
        status: 'PUBLISHED',
        externalListingId: HB_SKU,
        publishedAt: now,
        lastUpdatedAt: now,
      },
    })
    await tx.productPublishJob.update({
      where: { id: PUBLISH_JOB_ID },
      data: {
        status: 'SUCCESS',
        errorMessage: null,
        lastPolledAt: now,
        resolvedAt: now,
      },
    })
    await tx.operationHistory.update({
      where: { id: OPERATION_ID },
      data: {
        status: 'SUCCEEDED',
        externalBatchId: TRACKING_ID,
        successCount: 1,
        failedCount: 0,
        errorMessage: null,
        finishedAt: now,
        metadata: { trackingId: TRACKING_ID, hepsiburadaSku: HB_SKU, productStatus: 'Satışa Hazır' },
      },
    })
    await tx.operationItem.updateMany({
      where: { operationId: OPERATION_ID, productId: PRODUCT_ID },
      data: {
        status: 'SUCCEEDED',
        externalListingId: HB_SKU,
        externalBatchId: TRACKING_ID,
        errorMessage: null,
        finishedAt: now,
      },
    })
  })

  console.log(JSON.stringify({
    status: 'SUCCEEDED',
    productId: PRODUCT_ID,
    merchantSku: product.sku,
    hepsiburadaSku: HB_SKU,
    trackingId: TRACKING_ID,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
