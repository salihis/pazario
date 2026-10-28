import 'dotenv/config'
import { prisma } from '../db'
import { OrderFetchService } from '../services/OrderFetchService'

const ORDER_NO = '844197853'

async function main() {
  const service = new OrderFetchService(prisma)
  const refreshed = await service.refreshPazaramaOrderByNumber(
    ORDER_NO,
    new Date('2026-07-20T00:00:00.000Z'),
    new Date('2026-08-03T00:00:00.000Z')
  )
  const order = await prisma.order.findFirst({
    where: {
      marketplace: 'PAZARAMA',
      OR: [
        { marketplaceOrderId: ORDER_NO },
        { marketplaceOrderNo: ORDER_NO },
      ],
    },
    select: {
      id: true,
      marketplaceOrderId: true,
      marketplaceOrderNo: true,
      status: true,
      totalAmount: true,
      currency: true,
      fetchedAt: true,
      items: {
        select: { sku: true, quantity: true, unitPrice: true, totalPrice: true },
      },
    },
  })
  console.log(JSON.stringify({ refreshed, order }, null, 2))
  if (!refreshed || !order || order.status !== 'DELIVERED' || Number(order.totalAmount) !== 179.97) process.exitCode = 1
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
