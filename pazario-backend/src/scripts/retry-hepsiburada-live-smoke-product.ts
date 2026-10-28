import 'dotenv/config'
import { prisma } from '../db'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { OperationHistoryService } from '../services/OperationHistoryService'

const PRODUCT_ID = '46bc0707-3697-4b0d-9dad-529565793559'
const FAILED_OPERATION_ID = '49e38696-3270-45c7-813f-5363c2368d90'

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  const product = await prisma.product.findUnique({ where: { id: PRODUCT_ID } })
  if (!product) throw new Error(`Urun bulunamadi: ${PRODUCT_ID}`)

  let rule = await prisma.priceRule.findFirst({
    where: {
      marketplace: 'HEPSIBURADA',
      scopeType: 'PRODUCT',
      scopeValue: PRODUCT_ID,
      active: true,
    },
  })
  if (!rule) {
    rule = await prisma.priceRule.create({
      data: {
        name: 'HEPSIBURADA_LIVE_SMOKE_PRODUCT',
        marketplace: 'HEPSIBURADA',
        scopeType: 'PRODUCT',
        scopeValue: PRODUCT_ID,
        ekTutar: 25,
        karOrani: 1.3,
        kargo: 110,
        komisyonOrani: 0.25,
        priority: 0,
        active: true,
        createdBy: 'admin:live-smoke',
      },
    })
  }

  const basePrice = Number(product.price)
  const expectedPrice = Math.round((((basePrice + 25) * 1.3 + 110) / (1 - 0.25)) * 100) / 100
  const operationService = new OperationHistoryService(prisma)
  const retry = await operationService.retryOperation(FAILED_OPERATION_ID, 'admin:live-smoke')
  console.log(JSON.stringify({
    rule: {
      id: rule.id,
      name: rule.name,
      scopeType: rule.scopeType,
      scopeValue: rule.scopeValue,
    },
    basePrice,
    expectedPrice,
    retryOperationId: retry.id,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(JSON.stringify({
      status: 'FAILED',
      message: error instanceof Error ? error.message : String(error),
    }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    setTimeout(() => process.exit(process.exitCode ?? 0), 250)
  })
