import 'dotenv/config'
import { prisma } from '../db'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { importMarketplaceListings } from '../api/controllers/marketplace.controller'

async function main() {
  if (hepsiburadaEnvironment() !== 'production') throw new Error('HB_ENVIRONMENT production olmali.')
  const before = await prisma.marketplaceExternalProduct.count({ where: { marketplace: 'HEPSIBURADA' } })
  const result = await importMarketplaceListings('HEPSIBURADA', 100, 100)
  const latest = await prisma.marketplaceExternalProduct.aggregate({
    where: { marketplace: 'HEPSIBURADA' },
    _max: { lastSeenAt: true },
  })
  const snapshotWhere = latest._max.lastSeenAt ? { lastSeenAt: latest._max.lastSeenAt } : {}
  const [storedAfter, current, published, delisted, failed, pending] = await Promise.all([
    prisma.marketplaceExternalProduct.count({ where: { marketplace: 'HEPSIBURADA' } }),
    prisma.marketplaceExternalProduct.count({ where: { marketplace: 'HEPSIBURADA', ...snapshotWhere } }),
    prisma.marketplaceExternalProduct.count({ where: { marketplace: 'HEPSIBURADA', status: 'PUBLISHED', ...snapshotWhere } }),
    prisma.marketplaceExternalProduct.count({ where: { marketplace: 'HEPSIBURADA', status: 'DELISTED', ...snapshotWhere } }),
    prisma.marketplaceExternalProduct.count({ where: { marketplace: 'HEPSIBURADA', status: 'FAILED', ...snapshotWhere } }),
    prisma.marketplaceExternalProduct.count({ where: { marketplace: 'HEPSIBURADA', status: 'PENDING', ...snapshotWhere } }),
  ])
  console.log(JSON.stringify({ storedBefore: before, result, storedAfter, current, stats: { published, delisted, failed, pending } }, null, 2))
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
