import 'dotenv/config'
import { Marketplace } from '@prisma/client'
import { HepsiburadaAdapter } from '../adapters/HepsiburadaAdapter'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { prisma } from '../db'
import { decryptJson } from '../services/FieldEncryptionService'

const TRACKING_ID = '84c90cb1-f949-4474-bd9a-2b2a7a243e69'
const MERCHANT_SKU = 'T64677-Siyah-XL'

function clean(value: unknown): string {
  const text = String(value ?? '').trim()
  return text === '********' ? '' : text
}

async function main() {
  if (hepsiburadaEnvironment() !== 'production') throw new Error('HB_ENVIRONMENT production olmali.')
  const credential = await prisma.marketplaceCredential.findUnique({ where: { marketplace: Marketplace.HEPSIBURADA } })
  if (!credential?.isActive) throw new Error('Aktif Hepsiburada bilgileri bulunamadi.')
  const values = decryptJson(credential.credentialsEncrypted)
  const merchantId = clean(values.merchantId || process.env.HB_MERCHANT_ID)
  const serviceKey = clean(values.serviceKey || values.password || process.env.HB_SERVICE_KEY || process.env.HB_PASSWORD)
  const userAgent = clean(values.userAgent || values.developerUsername || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME)
  const adapter = new HepsiburadaAdapter(merchantId, serviceKey, merchantId, serviceKey, userAgent)

  const importStatus = await adapter.getImportStatus(TRACKING_ID)
  const listings = await adapter.listListings(0, 100)
  const listing = listings.listings.find(item => String(item.merchantSku ?? '').trim() === MERCHANT_SKU) ?? null
  console.log(JSON.stringify({
    trackingId: TRACKING_ID,
    merchantSku: MERCHANT_SKU,
    importStatus,
    listingTotalCount: listings.totalCount,
    listing,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
