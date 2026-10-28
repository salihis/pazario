import 'dotenv/config'
import axios from 'axios'
import { Marketplace, PrismaClient } from '@prisma/client'
import { hepsiburadaOrderApiUrl, hepsiburadaUserAgent } from '../config/hepsiburada'
import { decryptJson } from '../services/FieldEncryptionService'

const prisma = new PrismaClient()

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function extractList(data: unknown): Record<string, unknown>[] {
  const root = data as Record<string, unknown> | undefined
  const candidates = [data, root?.items, root?.data, (root?.data as Record<string, unknown> | undefined)?.items]
  return (candidates.find(Array.isArray) ?? []) as Record<string, unknown>[]
}

function describeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => /(price|amount|total|value|currency|quantity)/i.test(key))
      .map(([key, nested]) => [key, typeof nested === 'object' ? '[object]' : nested]),
  )
}

function priceShape(source: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => /(price|amount|total|quantity|discount)/i.test(key))
      .map(([key, value]) => [key, describeValue(value)]),
  )
}

async function main() {
  const credential = await prisma.marketplaceCredential.findUnique({
    where: { marketplace: Marketplace.HEPSIBURADA },
  })
  if (!credential?.isActive) throw new Error('Aktif Hepsiburada API kaydi bulunamadi.')

  const credentials = decryptJson(credential.credentialsEncrypted)
  const merchantId = clean(credentials.merchantId || process.env.HB_MERCHANT_ID)
  const password = clean(credentials.serviceKey || credentials.password || process.env.HB_SERVICE_KEY || process.env.HB_PASSWORD)
  const userAgent = clean(credentials.userAgent || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME)
  if (!merchantId || !password || !userAgent) throw new Error('Hepsiburada API bilgileri eksik.')

  const response = await axios.get(
    hepsiburadaOrderApiUrl(`/packages/merchantid/${encodeURIComponent(merchantId)}`),
    {
      auth: { username: merchantId, password },
      params: { timespan: 30 * 24, offset: 0, limit: 10 },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': hepsiburadaUserAgent(userAgent),
      },
      timeout: 60000,
    },
  )

  const packages = extractList(response.data)
  const sample = packages[0] ?? {}
  const items = (sample.items ?? sample.orderItems ?? sample.orderLines ?? sample.lineItems ?? []) as Record<string, unknown>[]
  console.log(JSON.stringify({
    packageCount: packages.length,
    rootKeys: Object.keys(sample).sort(),
    rootPriceShape: priceShape(sample),
    itemKeys: Object.keys(items[0] ?? {}).sort(),
    itemPriceShape: priceShape(items[0] ?? {}),
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
