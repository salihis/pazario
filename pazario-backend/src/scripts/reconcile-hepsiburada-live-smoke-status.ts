import 'dotenv/config'
import { Marketplace } from '@prisma/client'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { prisma } from '../db'

const PRODUCT_ID = '46bc0707-3697-4b0d-9dad-529565793559'
const PUBLISH_JOB_ID = '3e358755-96ef-49b2-86a8-da2b0473f74d'
const RETRY_OPERATION_ID = '1de1cf3d-d6bf-4ae9-9075-ef9f1a34273a'
const TRACKING_ID = '84c90cb1-f949-4474-bd9a-2b2a7a243e69'

async function main() {
  if (hepsiburadaEnvironment() !== 'production') throw new Error('HB_ENVIRONMENT production olmali.')
  const marketplace = Marketplace.HEPSIBURADA
  const product = await prisma.product.findUnique({ where: { id: PRODUCT_ID } })
  if (!product) throw new Error(`Urun bulunamadi: ${PRODUCT_ID}`)

  await prisma.$transaction(async tx => {
    await tx.marketplaceListing.update({
      where: { productId_marketplace: { productId: PRODUCT_ID, marketplace } },
      data: {
        status: 'PENDING',
        externalListingId: TRACKING_ID,
        publishedAt: null,
        hashAtPublish: null,
        lastUpdatedAt: new Date(),
      },
    })
    await tx.productPublishJob.update({
      where: { id: PUBLISH_JOB_ID },
      data: {
        status: 'POLLING',
        externalJobId: TRACKING_ID,
        errorMessage: null,
        lastPolledAt: new Date(),
        resolvedAt: null,
      },
    })
    await tx.operationHistory.update({
      where: { id: RETRY_OPERATION_ID },
      data: {
        status: 'WAITING_MARKETPLACE',
        externalBatchId: TRACKING_ID,
        successCount: 0,
        failedCount: 0,
        errorMessage: 'Hepsiburada katalog incelemesi bekleniyor',
        finishedAt: null,
      },
    })
    const existingItem = await tx.operationItem.findFirst({
      where: { operationId: RETRY_OPERATION_ID, productId: PRODUCT_ID },
    })
    if (!existingItem) {
      await tx.operationItem.create({
        data: {
          operationId: RETRY_OPERATION_ID,
          productId: PRODUCT_ID,
          sku: product.sku,
          barcode: product.barcode,
          status: 'RUNNING',
          externalBatchId: TRACKING_ID,
          startedAt: new Date(),
        },
      })
    }
  })

  console.log(JSON.stringify({
    status: 'WAITING_MARKETPLACE',
    productId: PRODUCT_ID,
    merchantSku: product.sku,
    trackingId: TRACKING_ID,
    productStatus: 'Incelenecek',
  }, null, 2))
}

main()
  .catch(error => {
    console.error(JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
