import 'dotenv/config'
import axios from 'axios'
import { Marketplace, PrismaClient } from '@prisma/client'
import { hepsiburadaOrderApiUrl, hepsiburadaUserAgent } from '../config/hepsiburada'
import { decryptJson } from '../services/FieldEncryptionService'
import { hepsiburadaMoneyValue } from '../services/OrderFetchService'

const prisma = new PrismaClient()
const PAGE_SIZE = 50
const PACKAGE_HISTORY_PAGE_SIZE = 10
const DAY_MS = 24 * 60 * 60 * 1000

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function extractList(data: unknown): Record<string, unknown>[] {
  const root = data as Record<string, unknown> | undefined
  const candidates = [data, root?.items, root?.data, (root?.data as Record<string, unknown> | undefined)?.items, root?.content]
  return (candidates.find(Array.isArray) ?? []) as Record<string, unknown>[]
}

function packageItems(value: Record<string, unknown>): Record<string, unknown>[] {
  const candidate = value.items ?? value.orderItems ?? value.orderLines ?? value.lineItems
  return Array.isArray(candidate) ? candidate as Record<string, unknown>[] : []
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

  const orders = await prisma.order.findMany({
    where: {
      marketplace: Marketplace.HEPSIBURADA,
      OR: [{ totalAmount: 0 }, { items: { some: { totalPrice: 0 } } }],
    },
    include: { items: true },
  })
  const wantedPackages = new Set(orders.map(order => order.marketplaceOrderId))
  const packagesByNumber = new Map<string, Record<string, unknown>>()
  const endpointErrors: string[] = []
  let scanned = 0

  const requestConfig = {
    auth: { username: merchantId, password },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': hepsiburadaUserAgent(userAgent),
    },
    timeout: 60000,
  }

  const capturePackages = (packages: Record<string, unknown>[]) => {
    scanned += packages.length
    for (const packageValue of packages) {
      const packageNumber = clean(packageValue.packageNumber ?? packageValue.PackageNumber)
      if (packageNumber && wantedPackages.has(packageNumber)) packagesByNumber.set(packageNumber, packageValue)
    }
  }

  const orderedDates = orders.map(order => order.orderedAt).filter((value): value is Date => Boolean(value))
  if (orderedDates.length > 0) {
    const firstDate = new Date(Math.min(...orderedDates.map(date => date.getTime())) - DAY_MS)
    const lastDate = new Date(Math.min(Date.now(), Math.max(...orderedDates.map(date => date.getTime())) + DAY_MS))
    for (let begin = firstDate; begin < lastDate; begin = new Date(begin.getTime() + DAY_MS)) {
      const end = new Date(Math.min(begin.getTime() + DAY_MS, lastDate.getTime()))
      for (let page = 0; page < 500; page += 1) {
        const response = await axios.get(
          hepsiburadaOrderApiUrl(`/packages/merchantid/${encodeURIComponent(merchantId)}`),
          {
            ...requestConfig,
            params: {
              begindate: begin.toISOString(),
              enddate: end.toISOString(),
              offset: page * PACKAGE_HISTORY_PAGE_SIZE,
              limit: PACKAGE_HISTORY_PAGE_SIZE,
            },
          },
        )
        const packages = extractList(response.data)
        capturePackages(packages)
        if (packages.length < PACKAGE_HISTORY_PAGE_SIZE) break
      }
    }
  }

  const paths = [
    { name: 'current', path: `/packages/merchantid/${encodeURIComponent(merchantId)}` },
    { name: 'shipped', path: `/packages/merchantid/${encodeURIComponent(merchantId)}/shipped` },
    { name: 'delivered', path: `/packages/merchantid/${encodeURIComponent(merchantId)}/delivered` },
    { name: 'undelivered', path: `/packages/merchantid/${encodeURIComponent(merchantId)}/undelivered` },
  ]

  for (const endpoint of paths) {
    for (let page = 0; page < 100; page += 1) {
      try {
        const response = await axios.get(hepsiburadaOrderApiUrl(endpoint.path), {
          ...requestConfig,
          params: { timespan: 30 * 24, offset: page * PAGE_SIZE, limit: PAGE_SIZE },
        })
        const packages = extractList(response.data)
        capturePackages(packages)
        if (packages.length < PAGE_SIZE) break
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status
        endpointErrors.push(`${endpoint.name}:${status ?? 'ERROR'}`)
        break
      }
    }
  }

  for (const order of orders) {
    const existingSource = packagesByNumber.get(order.marketplaceOrderId)
    const existingHasPrice = Boolean(existingSource) && (
      hepsiburadaMoneyValue(existingSource?.totalPrice) > 0
      || packageItems(existingSource as Record<string, unknown>).some(item =>
        hepsiburadaMoneyValue(item.price ?? item.unitPrice ?? item.totalPrice) > 0,
      )
    )
    if (existingHasPrice || !order.marketplaceOrderNo) continue
    try {
      const response = await axios.get(
        hepsiburadaOrderApiUrl(
          `/orders/merchantid/${encodeURIComponent(merchantId)}/ordernumber/${encodeURIComponent(order.marketplaceOrderNo)}`,
        ),
        requestConfig,
      )
      const responseRoot = response.data as Record<string, unknown> | Record<string, unknown>[]
      const detail = Array.isArray(responseRoot)
        ? { items: responseRoot }
        : ((responseRoot.data && typeof responseRoot.data === 'object' && !Array.isArray(responseRoot.data))
            ? responseRoot.data as Record<string, unknown>
            : responseRoot)
      packagesByNumber.set(order.marketplaceOrderId, detail)
      scanned += 1
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status
      endpointErrors.push(`detail:${status ?? 'ERROR'}`)
    }
  }

  let matchedOrders = 0
  let matchedItems = 0
  let updatedOrders = 0
  let updatedItems = 0
  for (const order of orders) {
    const source = packagesByNumber.get(order.marketplaceOrderId)
    if (!source) continue
    const sourceItems = packageItems(source)
    const sourceBySku = new Map<string, Record<string, unknown>>()
    const sourceByProduct = new Map<string, Record<string, unknown>>()
    for (const sourceItem of sourceItems) {
      const sku = clean(sourceItem.merchantSku)
      const productId = clean(sourceItem.hbSku)
      if (sku) sourceBySku.set(sku, sourceItem)
      if (productId) sourceByProduct.set(productId, sourceItem)
    }
    const orderTotal = hepsiburadaMoneyValue(source.totalPrice)
      || sourceItems.reduce((sum, item) => sum + hepsiburadaMoneyValue(item.totalPrice), 0)
    if (orderTotal <= 0) continue
    matchedOrders += 1

    const itemUpdates = order.items.flatMap((item, index) => {
      const sourceItem = (item.sku ? sourceBySku.get(item.sku) : undefined)
        ?? (item.marketplaceProductId ? sourceByProduct.get(item.marketplaceProductId) : undefined)
        ?? (sourceItems.length === order.items.length ? sourceItems[index] : undefined)
      if (!sourceItem) return []
      const unitPrice = hepsiburadaMoneyValue(sourceItem.price)
        || hepsiburadaMoneyValue(sourceItem.unitPrice)
        || hepsiburadaMoneyValue(sourceItem.merchantUnitPrice)
      const totalPrice = hepsiburadaMoneyValue(sourceItem.totalPrice) || unitPrice * item.quantity
      if (unitPrice <= 0 || totalPrice <= 0) return []
      matchedItems += 1
      return [{ id: item.id, unitPrice, totalPrice }]
    })

    if (apply) {
      await prisma.$transaction([
        prisma.order.update({ where: { id: order.id }, data: { totalAmount: orderTotal } }),
        ...itemUpdates.map(item => prisma.orderItem.update({
          where: { id: item.id },
          data: { unitPrice: item.unitPrice, totalPrice: item.totalPrice },
        })),
      ])
      updatedOrders += 1
      updatedItems += itemUpdates.length
    }
  }

  console.log(JSON.stringify({
    apply,
    missingOrders: orders.length,
    scanned,
    matchedOrders,
    matchedItems,
    updatedOrders,
    updatedItems,
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
