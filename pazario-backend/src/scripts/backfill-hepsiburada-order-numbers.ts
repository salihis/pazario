import 'dotenv/config'
import axios from 'axios'
import { Marketplace, PrismaClient } from '@prisma/client'
import { hepsiburadaOrderApiUrl, hepsiburadaUserAgent } from '../config/hepsiburada'
import { decryptJson } from '../services/FieldEncryptionService'
import { resolveHepsiburadaOrderNumber } from '../services/OrderFetchService'

const prisma = new PrismaClient()
const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 10

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function extractList(data: unknown): Record<string, unknown>[] {
  const root = data as Record<string, unknown> | undefined
  const candidates = [
    data,
    root?.items,
    root?.data,
    (root?.data as Record<string, unknown> | undefined)?.items,
    root?.content,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as Record<string, unknown>[]
  }
  return []
}

async function main() {
  const apply = process.argv.includes('--apply')
  const credential = await prisma.marketplaceCredential.findUnique({
    where: { marketplace: Marketplace.HEPSIBURADA },
  })
  if (!credential?.isActive) throw new Error('Aktif Hepsiburada API kaydi bulunamadi.')

  const credentials = decryptJson(credential.credentialsEncrypted)
  const merchantId = clean(credentials.merchantId || process.env.HB_MERCHANT_ID)
  const password = clean(credentials.serviceKey || credentials.password || process.env.HB_SERVICE_KEY || process.env.HB_PASSWORD)
  const userAgent = clean(credentials.userAgent || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME)
  if (!merchantId || !password || !userAgent) throw new Error('Hepsiburada API bilgileri eksik.')

  const missingOrders = await prisma.order.findMany({
    where: {
      marketplace: Marketplace.HEPSIBURADA,
      marketplaceOrderNo: null,
      orderedAt: { not: null },
    },
    select: { marketplaceOrderId: true, orderedAt: true },
    orderBy: { orderedAt: 'asc' },
  })
  if (missingOrders.length === 0) {
    console.log(JSON.stringify({ apply, missing: 0, scanned: 0, resolved: 0, matched: 0, updated: 0 }))
    return
  }

  const wantedPackages = new Set(missingOrders.map(order => order.marketplaceOrderId))
  const firstDate = missingOrders[0].orderedAt as Date
  const lastDate = missingOrders[missingOrders.length - 1].orderedAt as Date
  const rangeStart = new Date(firstDate.getTime() - DAY_MS)
  const rangeEnd = new Date(Math.min(Date.now(), lastDate.getTime() + DAY_MS))
  const resolved = new Map<string, string>()
  let scanned = 0
  const endpointErrors: string[] = []

  const requestConfig = {
    auth: { username: merchantId, password },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': hepsiburadaUserAgent(userAgent),
    },
    timeout: 60000,
  }

  for (let begin = rangeStart; begin < rangeEnd; begin = new Date(begin.getTime() + DAY_MS)) {
    const end = new Date(Math.min(begin.getTime() + DAY_MS, rangeEnd.getTime()))
    for (let page = 0; page < 500; page += 1) {
      const response = await axios.get(
        hepsiburadaOrderApiUrl(`/packages/merchantid/${encodeURIComponent(merchantId)}`),
        {
          ...requestConfig,
          params: {
            begindate: begin.toISOString(),
            enddate: end.toISOString(),
            offset: page * PAGE_SIZE,
            limit: PAGE_SIZE,
          },
        },
      )
      const packages = extractList(response.data)
      scanned += packages.length
      for (const packageValue of packages) {
        const packageNumber = clean(packageValue.packageNumber)
        const orderNumber = resolveHepsiburadaOrderNumber(packageValue)
        if (packageNumber && orderNumber && wantedPackages.has(packageNumber)) {
          resolved.set(packageNumber, orderNumber)
        }
      }
      if (packages.length < PAGE_SIZE) break
    }
  }

  const statusPaths = [
    { name: 'shipped', path: `/packages/merchantid/${encodeURIComponent(merchantId)}/shipped` },
    { name: 'delivered', path: `/packages/merchantid/${encodeURIComponent(merchantId)}/delivered` },
    { name: 'undelivered', path: `/packages/merchantid/${encodeURIComponent(merchantId)}/undelivered` },
    { name: 'cancelled', path: `/orders/merchantid/${encodeURIComponent(merchantId)}/cancelled` },
  ]
  for (const status of statusPaths) {
    for (let page = 0; page < 100; page += 1) {
      try {
        const response = await axios.get(
          hepsiburadaOrderApiUrl(status.path),
          {
            ...requestConfig,
            params: {
              timespan: 30 * 24,
              offset: page * 50,
              limit: 50,
            },
          },
        )
        const packages = extractList(response.data)
        scanned += packages.length
        for (const packageValue of packages) {
          const packageNumber = clean(packageValue.packageNumber ?? packageValue.PackageNumber)
          const orderNumber = resolveHepsiburadaOrderNumber(packageValue)
          if (packageNumber && orderNumber && wantedPackages.has(packageNumber)) {
            resolved.set(packageNumber, orderNumber)
          }
        }
        if (packages.length < 50) break
      } catch (error) {
        const response = (error as { response?: { status?: number } }).response
        endpointErrors.push(`${status.name}:${response?.status ?? 'ERROR'}`)
        break
      }
    }
  }

  let updated = 0
  if (apply) {
    for (const [packageNumber, orderNumber] of resolved.entries()) {
      const result = await prisma.order.updateMany({
        where: {
          marketplace: Marketplace.HEPSIBURADA,
          marketplaceOrderId: packageNumber,
          marketplaceOrderNo: null,
        },
        data: { marketplaceOrderNo: orderNumber },
      })
      updated += result.count
    }
  }

  console.log(JSON.stringify({
    apply,
    missing: missingOrders.length,
    scanned,
    resolved: resolved.size,
    matched: resolved.size,
    updated,
    endpointErrors,
  }))
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
