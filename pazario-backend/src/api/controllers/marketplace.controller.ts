import { ListingStatus, Marketplace, Prisma, PrismaClient, Product } from '@prisma/client'
import axios, { AxiosError } from 'axios'

import { Request, Response } from 'express'
import { MIN_MARKETPLACE_STOCK } from '../../validators/ProductValidator'
import { marketplaceBarcode } from '../../services/MarketplacePayloadTransform'
import { roundUpToNinetyNine } from '../../services/PriceEngine'

const prisma = new PrismaClient()
const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const PAZARAMA_TOKEN_URL = 'https://isortagimgiris.pazarama.com/connect/token'
const PAZARAMA_PRODUCTS_URL = 'https://isortagimapi.pazarama.com/product/products'
const PAZARAMA_PRICE_STOCK_URL = 'https://isortagimapi.pazarama.com/product/updatePriceAndInventory-v2'
const TRENDYOL_PRODUCTS_URL = 'https://apigw.trendyol.com/integration/product/sellers'
const TRENDYOL_STOCK_URL = 'https://apigw.trendyol.com/integration/inventory/sellers'
const TRENDYOL_ARCHIVE_URL = 'https://apigw.trendyol.com/integration/product/sellers'
const N11_PRODUCTS_URL = 'https://api.n11.com/ms/product-query'
const N11_STOCK_URL = 'https://api.n11.com/ms/product/tasks/price-stock-update'

type MarketplaceProduct = {
  [key: string]: any
  id?: string | number | null
  productId?: string | number | null
  n11ProductId?: string | number | null
  productMainId?: string | number | null
  code?: string | null
  stockCode?: string | null
  productCode?: string | null
  productSellerCode?: string | null
  barcode?: string | null
  gtin?: string | null
  name?: string | null
  displayName?: string | null
  title?: string | null
  productName?: string | null
}

type ImportSummary = {
  marketplace: Marketplace
  fetched: number
  matched: number
  imported: number
  delisted: number
  fullScan: boolean
  unmatched: Array<{ code: string; stockCode: string; barcode: string; name: string }>
}

type UnmatchedMarketplaceProduct = {
  code: string
  stockCode: string
  barcode: string
  name: string
}

type StockUpdateItem = {
  productId: string
  externalListingId: string | null
  sku: string
  barcode: string | null
  marketplaceBarcode: string
  currentStock: number
  targetStock: number
  targetPrice: number | null
  hasCalculatedPrice: boolean
}

type MarketplaceUpdateMode = 'stock' | 'price' | 'stock-price'

type ProductMatchRecord = Pick<Product, 'id' | 'sku' | 'barcode' | 'externalId' | 'title' | 'contentHash'>

type ProductMatcher = {
  byKey: Map<string, ProductMatchRecord>
  byTitle: Map<string, ProductMatchRecord>
}

type LivePriceRule = {
  id: string
  name: string
  marketplace: string
  scopeType: string
  scopeValue: string | null
  priceStart: unknown
  priceEnd: unknown
  ekTutar: unknown
  karOrani: unknown
  kargo: unknown
  komisyonOrani: unknown
}

let pazaramaTokenCache: { token: string; expiresAt: number } | null = null

function cachePazaramaToken(token: string): string {
  pazaramaTokenCache = {
    token,
    expiresAt: Date.now() + 55 * 60 * 1000,
  }
  return token
}

function extractBearerToken(value: unknown): string {
  const raw = cleanKey(value)
  return raw.replace(/^Bearer\s+/i, '').trim()
}

function marketplaceFromQuery(req: Request): Marketplace {
  const marketplace = String(req.query.marketplace || req.body?.marketplace || 'TRENDYOL') as Marketplace
  return MARKETPLACES.includes(marketplace) ? marketplace : 'TRENDYOL'
}

function buildListingWhere(req: Request) {
  const marketplace = marketplaceFromQuery(req)
  const status = String(req.query.status || '')
  const sourceId = String(req.query.sourceId || '')
  const search = String(req.query.search || '').trim()

  const where: Record<string, unknown> = { marketplace }
  if (status) where.status = status
  if (sourceId || search) {
    where.product = {
      ...(sourceId ? { sourceId } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
              { barcode: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }
  }

  return where
}

function buildExternalListingWhere(req: Request) {
  const marketplace = marketplaceFromQuery(req)
  const status = String(req.query.status || '')
  const search = String(req.query.search || '').trim()

  const where: Prisma.MarketplaceExternalProductWhereInput = { marketplace }
  if (status) where.status = status as ListingStatus
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { stockCode: { contains: search, mode: 'insensitive' } },
      { barcode: { contains: search, mode: 'insensitive' } },
      { externalListingId: { contains: search, mode: 'insensitive' } },
    ]
  }

  return where
}

function cleanKey(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeKey(value: unknown): string {
  return cleanKey(value).toLocaleUpperCase('tr-TR')
}

function matchesPriceRange(rule: Pick<LivePriceRule, 'priceStart' | 'priceEnd'>, basePrice: number): boolean {
  const start = rule.priceStart === null ? null : Number(rule.priceStart)
  const end = rule.priceEnd === null ? null : Number(rule.priceEnd)
  if (start !== null && basePrice < start) return false
  if (end !== null && basePrice >= end) return false
  return true
}

function resolveLiveMarketplacePrice(
  product: Pick<Product, 'id' | 'price' | 'brand' | 'categoryRaw'>,
  marketplace: Marketplace,
  rules: LivePriceRule[],
  minPrice: number
) {
  const basePrice = Number(product.price)
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null

  const scopedRules = rules.filter(rule => matchesPriceRange(rule, basePrice))
  const rule = scopedRules.find(r => r.scopeType === 'PRODUCT' && r.scopeValue === product.id)
    ?? scopedRules.find(r => r.scopeType === 'BRAND' && product.brand && r.scopeValue === product.brand)
    ?? scopedRules.find(r => r.scopeType === 'CATEGORY' && product.categoryRaw && r.scopeValue && product.categoryRaw.includes(r.scopeValue))
    ?? scopedRules.find(r => r.scopeType === 'MARKETPLACE' && r.marketplace === marketplace)
    ?? scopedRules.find(r => r.scopeType === 'GLOBAL')

  if (!rule) return null

  const ekTutar = Number(rule.ekTutar)
  const karOrani = Number(rule.karOrani)
  const kargo = Number(rule.kargo)
  const komisyonOrani = Number(rule.komisyonOrani)

  if (!Number.isFinite(karOrani) || karOrani < 1) return null
  if (!Number.isFinite(komisyonOrani) || komisyonOrani >= 1) return null

  const rawPrice = ((basePrice + ekTutar) * karOrani + kargo) / (1 - komisyonOrani)
  const roundedRawPrice = Math.round(rawPrice * 100) / 100
  const minPriceApplied = roundedRawPrice < minPrice
  const finalPrice = roundUpToNinetyNine(Math.max(roundedRawPrice, minPrice))

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    finalPrice,
    minPriceApplied,
  }
}

function marketplaceKeyVariants(value: unknown): string[] {
  const raw = normalizeKey(value)
  if (!raw) return []

  const withoutPim = raw.replace(/^PIM_/, '')
  const withoutSuffix = withoutPim.replace(/_V\d+$/i, '')
  const withoutBrs = withoutSuffix.replace(/^BRS/, '')

  return Array.from(new Set([
    raw,
    withoutPim,
    withoutSuffix,
    withoutBrs,
  ].filter(Boolean)))
}

function normalizeTitle(value: unknown): string {
  return cleanKey(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+-\s+[^-]+(?:\s+-\s+[^-]+)?$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleUpperCase('tr-TR')
}

function extractToken(data: unknown): string | null {
  const payload = data as Record<string, any>
  return (
    payload?.access_token ||
    payload?.accessToken ||
    payload?.data?.access_token ||
    payload?.data?.accessToken ||
    payload?.data?.token ||
    null
  )
}

function pazaramaMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as Record<string, unknown> | undefined
    return cleanKey(data?.userMessage || data?.message || error.message)
  }

  if (error instanceof Error) return error.message
  return 'Bilinmeyen hata'
}

function normalizeMarketplaceProducts(data: unknown): MarketplaceProduct[] {
  const root = data as any
  const candidates = [
    root,
    root?.data,
    root?.content,
    root?.data?.items,
    root?.data?.products,
    root?.data?.result,
    root?.data?.list,
    root?.data?.content,
    root?.items,
    root?.products,
    root?.result,
    root?.list,
  ]

  for (const value of candidates) {
    if (Array.isArray(value)) return value as MarketplaceProduct[]
  }

  return []
}

function firstCleanValue(item: MarketplaceProduct, keys: string[]): string {
  for (const key of keys) {
    const value = cleanKey(item[key])
    if (value) return value
  }
  return ''
}

function firstNumberValue(item: MarketplaceProduct, keys: string[]): number | null {
  for (const key of keys) {
    const raw = item[key]
    if (raw === null || raw === undefined || raw === '') continue
    const numberValue = Number(String(raw).replace(',', '.'))
    if (Number.isFinite(numberValue)) return numberValue
  }
  return null
}

function firstImageValue(item: MarketplaceProduct): string {
  const direct = firstCleanValue(item, ['imageUrl', 'image', 'mainImage', 'productImage', 'imagePath'])
  if (direct) return direct

  const images = item.images || item.imageUrls || item.pictures || item.productImages
  if (Array.isArray(images)) {
    for (const image of images) {
      if (typeof image === 'string' && cleanKey(image)) return cleanKey(image)
      if (image && typeof image === 'object') {
        const nested = firstCleanValue(image as MarketplaceProduct, ['url', 'imageUrl', 'image', 'path'])
        if (nested) return nested
      }
    }
  }

  return ''
}

function marketplaceListingKey(item: MarketplaceProduct): string {
  return firstCleanValue(item, [
    'stockCode',
    'barcode',
    'gtin',
    'productSellerCode',
    'productCode',
    'code',
    'id',
    'productId',
    'n11ProductId',
  ])
}

function marketplaceExternalStatus(item: MarketplaceProduct, stock: number | null = null): ListingStatus {
  const statusText = normalizeKey(item.status || item.productStatus || item.state)
  const saleStatusText = normalizeKey(item.saleStatus)
  const approved = item.approved ?? item.isApproved
  const onSale = item.onSale ?? item.saleable ?? item.isOnSale
  const archived = item.archived ?? item.isArchived

  if (statusText.includes('REJECT') || statusText.includes('FAIL') || statusText.includes('ERROR')) {
    return 'FAILED'
  }
  if (
    statusText.includes('INAPPROVAL') ||
    statusText.includes('INCATALOGAPPROVAL') ||
    statusText.includes('WAIT') ||
    statusText.includes('PENDING') ||
    statusText.includes('APPROVAL')
  ) {
    return 'PENDING'
  }
  if (statusText.includes('ACTIVE') && saleStatusText.includes('ON_SALE')) {
    return 'PUBLISHED'
  }
  if (statusText.includes('ACTIVE') && saleStatusText.includes('OUT_OF_STOCK')) {
    return 'DELISTED'
  }
  if (archived === true || statusText.includes('ARCHIVED') || statusText.includes('PASSIVE') || statusText.includes('DELIST')) {
    return 'DELISTED'
  }
  if (
    approved === false ||
    onSale === false ||
    saleStatusText.includes('WAIT') ||
    saleStatusText.includes('PENDING') ||
    saleStatusText.includes('APPROVAL') ||
    statusText.includes('WAIT') ||
    statusText.includes('PENDING') ||
    statusText.includes('APPROVAL')
  ) {
    return 'PENDING'
  }
  if (stock !== null && stock <= 0) {
    return 'DELISTED'
  }
  return 'PUBLISHED'
}

function marketplaceExternalData(item: MarketplaceProduct, marketplace: Marketplace, now: Date) {
  const listingKey = marketplaceListingKey(item)
  if (!listingKey) return null

  const stock = firstNumberValue(item, ['stockCount', 'quantity', 'stock', 'availableStock', 'saleStock'])
  const normalizedStock = stock === null ? null : Math.trunc(stock)
  const price = firstNumberValue(item, ['salePrice', 'price', 'listPrice', 'marketPrice', 'sellingPrice'])
  const raw = JSON.parse(JSON.stringify(item)) as Prisma.InputJsonValue

  return {
    where: { marketplace_listingKey: { marketplace, listingKey } },
    update: {
      externalListingId: externalListingId(item) || listingKey,
      stockCode: firstCleanValue(item, ['stockCode', 'productSellerCode', 'productCode', 'code']) || null,
      barcode: firstCleanValue(item, ['barcode', 'gtin']) || null,
      title: marketplaceItemName(item) || listingKey,
      brand: firstCleanValue(item, ['brandName', 'brand']) || null,
      categoryName: firstCleanValue(item, ['categoryName', 'category', 'categoryPath']) || null,
      imageUrl: firstImageValue(item) || null,
      price,
      stock: normalizedStock,
      status: marketplaceExternalStatus(item, normalizedStock),
      raw,
      lastSeenAt: now,
    },
    create: {
      marketplace,
      listingKey,
      externalListingId: externalListingId(item) || listingKey,
      stockCode: firstCleanValue(item, ['stockCode', 'productSellerCode', 'productCode', 'code']) || null,
      barcode: firstCleanValue(item, ['barcode', 'gtin']) || null,
      title: marketplaceItemName(item) || listingKey,
      brand: firstCleanValue(item, ['brandName', 'brand']) || null,
      categoryName: firstCleanValue(item, ['categoryName', 'category', 'categoryPath']) || null,
      imageUrl: firstImageValue(item) || null,
      price,
      stock: normalizedStock,
      status: marketplaceExternalStatus(item, normalizedStock),
      raw,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  }
}

async function getPazaramaAccessToken(providedToken?: string): Promise<string> {
  const manualToken = extractBearerToken(providedToken || process.env.PZ_ACCESS_TOKEN || process.env.PAZARAMA_ACCESS_TOKEN)
  if (manualToken) {
    return cachePazaramaToken(manualToken)
  }

  if (pazaramaTokenCache && Date.now() < pazaramaTokenCache.expiresAt) {
    return pazaramaTokenCache.token
  }

  const clientId = process.env.PZ_CLIENT_ID
  const clientSecret = process.env.PZ_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Pazarama API bilgileri eksik')
  }

  const attempts: Array<Record<string, string>> = [
    { grant_type: 'client_credentialsscope', scope: 'merchantgatewayapi.fullaccess' },
    { grant_type: 'client_credentials', scope: 'merchantgatewayapi.fullaccess' },
    { grant_type: 'client_credentials' },
  ]

  let lastMessage = 'Token alinamadi'
  for (const body of attempts) {
    try {
      const response = await axios.post(PAZARAMA_TOKEN_URL, new URLSearchParams(body).toString(), {
        auth: { username: clientId, password: clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
      })
      const token = extractToken(response.data)
      if (token) {
        return cachePazaramaToken(token)
      }

      const payload = response.data as Record<string, unknown>
      lastMessage = cleanKey(payload?.userMessage || payload?.message || 'Token cevabinda access token yok')
    } catch (error) {
      lastMessage = pazaramaMessage(error)
    }
  }

  throw new Error(lastMessage)
}

function marketplaceItemKeys(item: MarketplaceProduct): string[] {
  return [
    item.stockCode,
    item.code,
    item.productCode,
    item.productSellerCode,
    item.barcode,
    item.gtin,
    item.productMainId,
  ].flatMap(marketplaceKeyVariants)
}

function marketplaceItemRawKeys(item: MarketplaceProduct): string[] {
  return [
    item.stockCode,
    item.code,
    item.productCode,
    item.productSellerCode,
    item.barcode,
    item.gtin,
    item.productMainId,
  ].flatMap(marketplaceKeyVariants)
}

function marketplaceItemName(item: MarketplaceProduct): string {
  return cleanKey(item.displayName || item.name || item.title || item.productName)
}

function matchProduct(item: MarketplaceProduct, products: Product[]): Product | null {
  const keys = marketplaceItemKeys(item)
  return products.find(product => {
    const productKeys = [product.sku, product.barcode, product.externalId].flatMap(marketplaceKeyVariants)
    return keys.some(key => productKeys.includes(key))
  }) ?? null
}

function buildProductMatcher(products: ProductMatchRecord[]): ProductMatcher {
  const byKey = new Map<string, ProductMatchRecord>()
  const titleCounts = new Map<string, number>()
  const byTitle = new Map<string, ProductMatchRecord>()

  for (const product of products) {
    for (const key of [product.sku, product.barcode, product.externalId].flatMap(marketplaceKeyVariants)) {
      if (!byKey.has(key)) byKey.set(key, product)
    }

    const title = normalizeTitle(product.title)
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }

  for (const product of products) {
    const title = normalizeTitle(product.title)
    if (title && titleCounts.get(title) === 1) byTitle.set(title, product)
  }

  return { byKey, byTitle }
}

function matchProductFast(item: MarketplaceProduct, matcher: ProductMatcher): ProductMatchRecord | null {
  for (const key of marketplaceItemKeys(item)) {
    const product = matcher.byKey.get(key)
    if (product) return product
  }

  const title = normalizeTitle(marketplaceItemName(item))
  return title ? matcher.byTitle.get(title) ?? null : null
}

async function findProductByTitle(item: MarketplaceProduct): Promise<Product | null> {
  const marketplaceTitle = normalizeTitle(marketplaceItemName(item))
  if (!marketplaceTitle) return null

  const searchTerm = marketplaceItemName(item).split(/\s+/).slice(0, 3).join(' ')
  if (searchTerm.length < 6) return null

  const candidates = await prisma.product.findMany({
    where: { title: { contains: searchTerm, mode: 'insensitive' } },
    take: 30,
  })
  const matches = candidates.filter(product => {
    const productTitle = normalizeTitle(product.title)
    return productTitle && (marketplaceTitle.includes(productTitle) || productTitle.includes(marketplaceTitle))
  })

  return matches.length === 1 ? matches[0] : null
}

function externalListingId(item: MarketplaceProduct): string {
  return cleanKey(
    item.id ||
    item.productId ||
    item.code ||
    item.stockCode ||
    item.productCode ||
    item.productSellerCode ||
    item.n11ProductId ||
    item.barcode ||
    item.gtin
  )
}

function unmatchedProductSummary(item: MarketplaceProduct): UnmatchedMarketplaceProduct {
  return {
    code: cleanKey(item.code || item.productCode || item.productSellerCode),
    stockCode: cleanKey(item.stockCode),
    barcode: cleanKey(item.barcode || item.gtin),
    name: marketplaceItemName(item),
  }
}

function stockForMarketplace(stock: number): number {
  return stock > MIN_MARKETPLACE_STOCK ? stock : 0
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

function trendyolPayloadItem(item: StockUpdateItem, mode: MarketplaceUpdateMode) {
  return {
    barcode: item.marketplaceBarcode,
    ...(mode !== 'price' ? { quantity: item.targetStock } : {}),
    ...(mode !== 'stock' && item.targetPrice !== null ? { salePrice: item.targetPrice, listPrice: item.targetPrice } : {}),
  }
}

function n11PayloadItem(item: StockUpdateItem, mode: MarketplaceUpdateMode) {
  return {
    stockCode: item.externalListingId || item.marketplaceBarcode,
    ...(mode !== 'price' ? { quantity: item.targetStock } : {}),
    ...(mode !== 'stock' && item.targetPrice !== null ? { salePrice: item.targetPrice, listPrice: item.targetPrice } : {}),
  }
}

function pazaramaPriceStockPayloadItem(item: StockUpdateItem, mode: MarketplaceUpdateMode) {
  const code = item.externalListingId || item.marketplaceBarcode || item.sku
  const price = item.targetPrice ?? 0
  return {
    code,
    stockCount: mode === 'price' ? item.currentStock : item.targetStock,
    listPrice: price,
    salePrice: price,
  }
}

async function sendTrendyolUpdates(items: StockUpdateItem[], mode: MarketplaceUpdateMode) {
  const apiKey = process.env.TY_API_KEY
  const apiSecret = process.env.TY_API_SECRET
  const supplierId = process.env.TY_SUPPLIER_ID
  if (!apiKey || !apiSecret || !supplierId) throw new Error('Trendyol API bilgileri eksik')

  for (const chunk of chunkArray(items, 1000)) {
    await axios.post(
      `${TRENDYOL_STOCK_URL}/${supplierId}/products/price-and-inventory`,
      {
        items: chunk.map(item => trendyolPayloadItem(item, mode)),
      },
      {
        auth: { username: apiKey, password: apiSecret },
        headers: { 'User-Agent': `PazarioIntegration - ${supplierId}` },
        timeout: 60000,
      }
    )
  }
}

async function sendTrendyolArchive(barcodes: string[]) {
  const apiKey = process.env.TY_API_KEY
  const apiSecret = process.env.TY_API_SECRET
  const supplierId = process.env.TY_SUPPLIER_ID
  if (!apiKey || !apiSecret || !supplierId) throw new Error('Trendyol API bilgileri eksik')

  const results: Array<{ count: number; batchRequestId: string | null }> = []
  for (const chunk of chunkArray(barcodes, 1000)) {
    const response = await axios.put(
      `${TRENDYOL_ARCHIVE_URL}/${supplierId}/products/archive-state`,
      {
        items: chunk.map(barcode => ({ barcode, archived: true })),
      },
      {
        auth: { username: apiKey, password: apiSecret },
        headers: { 'User-Agent': `PazarioIntegration - ${supplierId}` },
        timeout: 60000,
      }
    )

    const payload = response.data as Record<string, any>
    results.push({
      count: chunk.length,
      batchRequestId: cleanKey(payload?.batchRequestId || payload?.data?.batchRequestId) || null,
    })
  }

  return results
}

async function sendN11Updates(items: StockUpdateItem[], mode: MarketplaceUpdateMode) {
  const appKey = process.env.N11_APPKEY
  const appSecret = process.env.N11_APPSECRET
  if (!appKey || !appSecret) throw new Error('N11 API bilgileri eksik')

  for (const chunk of chunkArray(items, 1000)) {
    await axios.post(
      N11_STOCK_URL,
      {
        payload: {
          integrator: 'PazarioIntegration',
          skus: chunk.map(item => n11PayloadItem(item, mode)),
        },
      },
      {
        headers: { appkey: appKey, appsecret: appSecret },
        timeout: 60000,
      }
    )
  }
}

async function sendPazaramaUpdates(items: StockUpdateItem[], mode: MarketplaceUpdateMode) {
  const token = await getPazaramaAccessToken()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }

  for (const chunk of chunkArray(items, 1000)) {
    const payloadItems = chunk
      .filter(item => item.targetPrice !== null && item.targetPrice > 0)
      .map(item => pazaramaPriceStockPayloadItem(item, mode))

    if (payloadItems.length === 0) continue

    const response = await axios.post(
      process.env.PZ_PRICE_STOCK_UPDATE_URL || PAZARAMA_PRICE_STOCK_URL,
      { items: payloadItems },
      { headers, timeout: 60000 }
    )
    const payload = response.data as Record<string, unknown>
    if (payload?.success === false) {
      const message = cleanKey(payload.userMessage || payload.message || 'Pazarama stok/fiyat guncelleme kabul edilmedi')
      throw new Error(message)
    }
  }
}

async function sendMarketplaceUpdates(marketplace: Marketplace, items: StockUpdateItem[], mode: MarketplaceUpdateMode) {
  if (marketplace === 'TRENDYOL') {
    await sendTrendyolUpdates(items, mode)
    return
  }
  if (marketplace === 'N11') {
    await sendN11Updates(items, mode)
    return
  }
  if (marketplace === 'PAZARAMA') {
    await sendPazaramaUpdates(items, mode)
    return
  }

  throw new Error(`${marketplace} stok/fiyat guncelleme API baglantisi henuz tanimli degil`)
}

async function updateExternalProductsAfterMarketplaceSync(
  marketplace: Marketplace,
  items: StockUpdateItem[],
  mode: MarketplaceUpdateMode
) {
  const now = new Date()

  for (const item of items) {
    const listingKeys = [
      item.externalListingId,
      item.marketplaceBarcode,
      item.sku,
      item.barcode,
    ].filter((value): value is string => Boolean(value))

    if (listingKeys.length === 0) continue

    const data: Prisma.MarketplaceExternalProductUpdateManyMutationInput = {
      lastSeenAt: now,
    }

    if (mode !== 'price') {
      data.stock = item.targetStock
      data.status = item.targetStock <= 0 ? 'DELISTED' : 'PUBLISHED'
    }

    if (mode !== 'stock' && item.targetPrice !== null) {
      data.price = item.targetPrice
    }

    await prisma.marketplaceExternalProduct.updateMany({
      where: {
        marketplace,
        OR: [
          { listingKey: { in: listingKeys } },
          { externalListingId: { in: listingKeys } },
          { stockCode: { in: listingKeys } },
          { barcode: { in: listingKeys } },
        ],
      },
      data,
    })
  }
}

function isMarketplaceUpdateMode(value: unknown): value is MarketplaceUpdateMode {
  return value === 'stock' || value === 'price' || value === 'stock-price'
}

async function fetchMarketplacePage(
  marketplace: Marketplace,
  page: number,
  pageSize: number,
  providedToken?: string
): Promise<MarketplaceProduct[]> {
  if (marketplace === 'PAZARAMA') {
    const token = await getPazaramaAccessToken(providedToken)
    const approvedResponse = await axios.get(PAZARAMA_PRODUCTS_URL, {
      params: { Approved: true, Size: pageSize, Page: page },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    })
    const approvedProducts = normalizeMarketplaceProducts(approvedResponse.data)
    if (approvedProducts.length > 0 || page > 1) return approvedProducts

    const response = await axios.get(PAZARAMA_PRODUCTS_URL, {
      params: { Size: pageSize, Page: page },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    })
    return normalizeMarketplaceProducts(response.data)
  }

  if (marketplace === 'TRENDYOL') {
    const apiKey = process.env.TY_API_KEY
    const apiSecret = process.env.TY_API_SECRET
    const supplierId = process.env.TY_SUPPLIER_ID
    if (!apiKey || !apiSecret || !supplierId) throw new Error('Trendyol API bilgileri eksik')

    const response = await axios.get(`${TRENDYOL_PRODUCTS_URL}/${supplierId}/products`, {
      auth: { username: apiKey, password: apiSecret },
      params: { page: page - 1, size: pageSize },
      headers: { 'User-Agent': `PazarioIntegration - ${supplierId}` },
      timeout: 60000,
    })
    return normalizeMarketplaceProducts(response.data)
  }

  if (marketplace === 'N11') {
    const appKey = process.env.N11_APPKEY
    const appSecret = process.env.N11_APPSECRET
    if (!appKey || !appSecret) throw new Error('N11 API bilgileri eksik')

    const response = await axios.get(N11_PRODUCTS_URL, {
      params: { page: page - 1, size: pageSize },
      headers: { appkey: appKey, appsecret: appSecret },
      timeout: 60000,
    })
    return normalizeMarketplaceProducts(response.data)
  }

  throw new Error(`${marketplace} icin pazaryeri importu desteklenmiyor`)
}

async function importMarketplaceListings(
  marketplace: Marketplace,
  pageSize: number,
  maxPages: number,
  providedToken?: string
): Promise<ImportSummary> {
  if (marketplace === 'HEPSIBURADA') {
    throw new Error('Hepsiburada importu bu islemde devre disi')
  }

  const now = new Date()
  let fetched = 0
  let matched = 0
  let imported = 0
  let fullScan = false
  let delisted = 0
  const matchedProductIds = new Set<string>()
  const seenExternalKeys = new Set<string>()
  const unmatched: ImportSummary['unmatched'] = []
  const matcher = buildProductMatcher(await prisma.product.findMany({
    select: {
      id: true,
      sku: true,
      barcode: true,
      externalId: true,
      title: true,
      contentHash: true,
    },
  }))

  for (let page = 1; page <= maxPages; page += 1) {
    const items = await fetchMarketplacePage(marketplace, page, pageSize, providedToken)
    if (items.length === 0) {
      fullScan = true
      break
    }

    fetched += items.length

    for (const item of items) {
      const externalData = marketplaceExternalData(item, marketplace, now)
      if (externalData) {
        await prisma.marketplaceExternalProduct.upsert(externalData)
        seenExternalKeys.add(externalData.create.listingKey)
      }

      const product = matchProductFast(item, matcher)
      if (!product) {
        if (unmatched.length < 20) {
          unmatched.push({
            code: cleanKey(item.code || item.productCode || item.productSellerCode),
            stockCode: cleanKey(item.stockCode),
            barcode: cleanKey(item.barcode || item.gtin),
            name: marketplaceItemName(item),
          })
        }
        continue
      }

      matched += 1
      matchedProductIds.add(product.id)
      const externalStatus = marketplaceExternalStatus(item)
      await prisma.marketplaceListing.upsert({
        where: { productId_marketplace: { productId: product.id, marketplace } },
        update: {
          status: externalStatus,
          externalListingId: externalListingId(item) || product.sku,
          publishedAt: externalStatus === 'PUBLISHED' ? now : null,
          lastUpdatedAt: now,
          hashAtPublish: externalStatus === 'PUBLISHED' ? product.contentHash : null,
        },
        create: {
          productId: product.id,
          marketplace,
          status: externalStatus,
          externalListingId: externalListingId(item) || product.sku,
          publishedAt: externalStatus === 'PUBLISHED' ? now : null,
          lastUpdatedAt: now,
          hashAtPublish: externalStatus === 'PUBLISHED' ? product.contentHash : null,
        },
      })
      imported += 1
    }

    if (items.length < pageSize) {
      fullScan = true
      break
    }
  }

  if (fullScan && matchedProductIds.size > 0) {
    const staleResult = await prisma.marketplaceListing.updateMany({
      where: {
        marketplace,
        status: 'PUBLISHED',
        productId: { notIn: Array.from(matchedProductIds) },
      },
      data: {
        status: 'DELISTED',
        lastUpdatedAt: now,
      },
    })
    delisted = staleResult.count
  }

  if (fullScan && seenExternalKeys.size > 0) {
    await prisma.marketplaceExternalProduct.updateMany({
      where: {
        marketplace,
        listingKey: { notIn: Array.from(seenExternalKeys) },
      },
      data: {
        status: 'DELISTED',
        lastSeenAt: now,
      },
    })
  }

  return { marketplace, fetched, matched, imported, delisted, fullScan, unmatched }
}

async function findUnmatchedMarketplaceListings(
  marketplace: Marketplace,
  pageSize: number,
  maxPages: number
) {
  if (marketplace !== 'TRENDYOL') {
    throw new Error('Su anda sadece Trendyol eslesmeyen urun kontrolu destekleniyor')
  }

  let fetched = 0
  let matched = 0
  const unmatched: UnmatchedMarketplaceProduct[] = []
  const localProducts = await prisma.product.findMany({
    select: { sku: true, barcode: true, externalId: true, title: true },
  })
  const localKeys = new Set(localProducts.flatMap(product => [
    product.sku,
    product.barcode,
    product.externalId,
  ].flatMap(marketplaceKeyVariants)))
  const localTitles = localProducts
    .map(product => normalizeTitle(product.title))
    .filter(Boolean)

  const hasUniqueTitleMatch = (item: MarketplaceProduct) => {
    const marketplaceTitle = normalizeTitle(marketplaceItemName(item))
    if (!marketplaceTitle) return false

    let count = 0
    for (const productTitle of localTitles) {
      if (marketplaceTitle.includes(productTitle) || productTitle.includes(marketplaceTitle)) {
        count += 1
        if (count > 1) return false
      }
    }

    return count === 1
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const items = await fetchMarketplacePage(marketplace, page, pageSize)
    if (items.length === 0) break

    fetched += items.length

    for (const item of items) {
      const hasKeyMatch = marketplaceItemKeys(item).some(key => localKeys.has(key))
      if (hasKeyMatch || hasUniqueTitleMatch(item)) {
        matched += 1
        continue
      }

      unmatched.push(unmatchedProductSummary(item))
    }

    if (items.length < pageSize) break
  }

  return { marketplace, fetched, matched, unmatchedCount: unmatched.length, unmatched }
}

export async function getMarketplaceListings(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '50'))
    const skip = (page - 1) * limit
    const where = buildExternalListingWhere(req)

    const [data, total] = await Promise.all([
      prisma.marketplaceExternalProduct.findMany({
        where,
        skip,
        take: limit,
        orderBy: { lastSeenAt: 'desc' },
      }),
      prisma.marketplaceExternalProduct.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Pazaryeri urunleri listelenemedi' })
  }
}

export async function getMarketplaceStats(req: Request, res: Response) {
  try {
    const marketplace = marketplaceFromQuery(req)

    const [pending, published, failed, delisted, total] = await Promise.all([
      prisma.marketplaceExternalProduct.count({ where: { marketplace, status: 'PENDING' } }),
      prisma.marketplaceExternalProduct.count({ where: { marketplace, status: 'PUBLISHED' } }),
      prisma.marketplaceExternalProduct.count({ where: { marketplace, status: 'FAILED' } }),
      prisma.marketplaceExternalProduct.count({ where: { marketplace, status: 'DELISTED' } }),
      prisma.marketplaceExternalProduct.count({ where: { marketplace } }),
    ])

    res.json({ success: true, data: { pending, published, failed, delisted, total } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Pazaryeri istatistikleri alinamadi' })
  }
}

export async function importPazaramaListings(req: Request, res: Response) {
  req.params.marketplace = 'PAZARAMA'
  return importMarketplaceListingsController(req, res)
}

export async function importMarketplaceListingsController(req: Request, res: Response) {
  try {
    const requestedMarketplace = String(req.params.marketplace || req.body?.marketplace || '').toUpperCase() as Marketplace
    if (!MARKETPLACES.includes(requestedMarketplace)) {
      res.status(400).json({ success: false, error: 'Gecersiz pazaryeri' })
      return
    }
    if (requestedMarketplace === 'HEPSIBURADA') {
      res.status(400).json({ success: false, error: 'Hepsiburada importu devre disi' })
      return
    }

    const pageSize = Math.min(Math.max(parseInt(String(req.body?.size || '100')), 1), 100)
    const maxPages = Math.min(Math.max(parseInt(String(req.body?.maxPages || '200')), 1), 1000)
    const bearerToken = extractBearerToken(req.headers.authorization || req.body?.token || req.body?.accessToken)
    const result = await importMarketplaceListings(requestedMarketplace, pageSize, maxPages, bearerToken)

    res.status(201).json({
      success: true,
      data: result,
    })
  } catch (error) {
    const status = axios.isAxiosError(error) ? (error as AxiosError).response?.status : undefined
    res.status(502).json({
      success: false,
      error: 'Pazaryeri urun listeleme API hatasi',
      detail: pazaramaMessage(error),
      status,
    })
  }
}

export async function getUnmatchedMarketplaceListings(req: Request, res: Response) {
  try {
    const marketplace = marketplaceFromQuery(req)
    const pageSize = Math.min(Math.max(parseInt(String(req.query.size || '100')), 1), 100)
    const maxPages = Math.min(Math.max(parseInt(String(req.query.maxPages || '20')), 1), 1000)
    const result = await findUnmatchedMarketplaceListings(marketplace, pageSize, maxPages)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    const status = axios.isAxiosError(error) ? (error as AxiosError).response?.status : undefined
    res.status(status || 502).json({
      success: false,
      error: 'Eslesmeyen pazaryeri urunleri alinamadi',
      detail: pazaramaMessage(error),
      status,
    })
  }
}

export async function archiveUnmatchedTrendyolListings(req: Request, res: Response) {
  try {
    const marketplace = marketplaceFromQuery(req)
    if (marketplace !== 'TRENDYOL') {
      res.status(400).json({ success: false, error: 'Arsivleme su anda sadece Trendyol icin tanimli' })
      return
    }

    const barcodes: string[] = Array.isArray(req.body?.barcodes)
      ? Array.from(new Set(req.body.barcodes.map((value: unknown) => cleanKey(value)).filter(Boolean)))
      : []

    if (barcodes.length === 0) {
      res.status(400).json({ success: false, error: 'Arsivlenecek barkod secilmedi' })
      return
    }
    if (barcodes.length > 1000) {
      res.status(400).json({ success: false, error: 'Tek istekte en fazla 1000 barkod arsivlenebilir' })
      return
    }

    const results = await sendTrendyolArchive(barcodes)

    res.json({
      success: true,
      data: {
        marketplace,
        archivedRequested: barcodes.length,
        batches: results,
      },
    })
  } catch (error) {
    const status = axios.isAxiosError(error) ? (error as AxiosError).response?.status : undefined
    res.status(status || 502).json({
      success: false,
      error: 'Trendyol arsivleme hatasi',
      detail: pazaramaMessage(error),
      status,
    })
  }
}

export async function runMarketplaceSync(
  marketplace: Marketplace,
  mode: MarketplaceUpdateMode,
  dryRun: boolean,
  limit: number
) {
  if (marketplace === 'HEPSIBURADA') {
    throw new Error(`${marketplace} stok/fiyat guncelleme endpointi henuz dogrulanmadi`)
  }

  const safeLimit = Math.min(Math.max(limit, 1), 1000)
  const activeRules = await prisma.priceRule.findMany({
    where: {
      active: true,
      OR: [{ marketplace }, { marketplace: '*' }],
    },
    orderBy: { priority: 'asc' },
  })
  const globalSetting = await prisma.globalPriceSetting.findFirst()
  const minPrice = globalSetting ? Number(globalSetting.minPrice) : 50

  const listings = await prisma.marketplaceListing.findMany({
    where: { marketplace, status: 'PUBLISHED' },
    take: safeLimit,
    orderBy: { lastUpdatedAt: 'desc' },
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          barcode: true,
          stock: true,
          price: true,
          brand: true,
          categoryRaw: true,
          priceCalculations: {
            where: { marketplace },
            orderBy: { calculatedAt: 'desc' },
            take: 1,
            select: { finalPrice: true },
          },
        },
      },
    },
  })

  const items = listings
    .map(listing => {
      const livePrice = resolveLiveMarketplacePrice(
        listing.product,
        marketplace,
        activeRules,
        minPrice
      )
      const calculatedPrice = livePrice?.finalPrice ?? listing.product.priceCalculations[0]?.finalPrice
      const hasCalculatedPrice = calculatedPrice !== undefined && calculatedPrice !== null
      const targetPrice = hasCalculatedPrice ? Number(calculatedPrice) : null
      return {
        productId: listing.productId,
        externalListingId: listing.externalListingId,
        sku: listing.product.sku,
        barcode: listing.product.barcode,
        marketplaceBarcode: marketplaceBarcode(listing.product.barcode, listing.product.sku),
        currentStock: listing.product.stock,
        targetStock: hasCalculatedPrice ? stockForMarketplace(listing.product.stock) : 0,
        targetPrice,
        hasCalculatedPrice,
      }
    })
    .filter(item => item.marketplaceBarcode)

  const updateItems = mode === 'stock'
    ? items
    : mode === 'price'
      ? items.filter(item => item.hasCalculatedPrice)
      : items

  if (!dryRun && updateItems.length > 0) {
    await sendMarketplaceUpdates(marketplace, updateItems, mode)
    await updateExternalProductsAfterMarketplaceSync(marketplace, updateItems, mode)
    await prisma.marketplaceListing.updateMany({
      where: { productId: { in: updateItems.map(item => item.productId) }, marketplace },
      data: { lastUpdatedAt: new Date() },
    })
  }

  return {
    marketplace,
    mode,
    dryRun,
    scanned: listings.length,
    prepared: updateItems.length,
    skippedNoPrice: items.filter(item => !item.hasCalculatedPrice).length,
    zeroStock: updateItems.filter(item => item.targetStock === 0).length,
    updated: dryRun ? 0 : updateItems.length,
    sample: items.slice(0, 20),
  }
}

async function syncMarketplaceValues(req: Request, res: Response, mode: MarketplaceUpdateMode) {
  try {
    const marketplace = marketplaceFromQuery(req)
    const dryRun = req.body?.dryRun !== false
    const limit = Math.min(Math.max(parseInt(String(req.body?.limit || '100')), 1), 1000)
    const result = await runMarketplaceSync(marketplace, mode, dryRun, limit)

    res.json({ success: true, data: result })
  } catch (error) {
    const status = axios.isAxiosError(error) ? (error as AxiosError).response?.status : undefined
    res.status(502).json({
      success: false,
      error: 'Pazaryeri stok/fiyat guncelleme hatasi',
      detail: pazaramaMessage(error),
      status,
    })
  }
}

export async function syncMarketplaceStock(req: Request, res: Response) {
  return syncMarketplaceValues(req, res, 'stock')
}

export async function syncMarketplacePrice(req: Request, res: Response) {
  return syncMarketplaceValues(req, res, 'price')
}

export async function syncMarketplaceStockAndPrice(req: Request, res: Response) {
  return syncMarketplaceValues(req, res, 'stock-price')
}

export async function getMarketplaceSyncSettings(_req: Request, res: Response) {
  try {
    const existing = await prisma.marketplaceSyncSetting.findMany()
    const byMarketplace = new Map(existing.map(setting => [setting.marketplace, setting]))
    const defaults = MARKETPLACES
      .map(marketplace => byMarketplace.get(marketplace) ?? {
        id: null,
        marketplace,
        enabled: false,
        mode: 'stock-price',
        scheduleTime: '03:00',
        limit: 1000,
        lastRunAt: null,
        updatedAt: null,
      })

    res.json({ success: true, data: defaults })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Pazaryeri guncelleme ayarlari alinamadi' })
  }
}

export async function updateMarketplaceSyncSetting(req: Request, res: Response) {
  try {
    const marketplace = String(req.params.marketplace || '').toUpperCase() as Marketplace
    if (!MARKETPLACES.includes(marketplace)) {
      res.status(400).json({ success: false, error: 'Gecersiz pazaryeri' })
      return
    }

    const mode = isMarketplaceUpdateMode(req.body?.mode) ? req.body.mode : 'stock-price'
    const scheduleTime = cleanKey(req.body?.scheduleTime || '03:00')
    if (!/^\d{2}:\d{2}$/.test(scheduleTime)) {
      res.status(400).json({ success: false, error: 'Saat formati HH:mm olmali' })
      return
    }
    const now = new Date()
    const [hour, minute] = scheduleTime.split(':').map(Number)
    const scheduledToday = new Date(now)
    scheduledToday.setHours(hour, minute, 0, 0)
    const preventImmediateRun = Boolean(req.body?.enabled) && scheduledToday <= now

    const setting = await prisma.marketplaceSyncSetting.upsert({
      where: { marketplace },
      create: {
        marketplace,
        enabled: Boolean(req.body?.enabled),
        mode,
        scheduleTime,
        limit: Math.min(Math.max(parseInt(String(req.body?.limit || '1000')), 1), 1000),
        lastRunAt: preventImmediateRun ? now : null,
      },
      update: {
        enabled: Boolean(req.body?.enabled),
        mode,
        scheduleTime,
        limit: Math.min(Math.max(parseInt(String(req.body?.limit || '1000')), 1), 1000),
        ...(preventImmediateRun ? { lastRunAt: now } : {}),
      },
    })

    res.json({ success: true, data: setting })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Pazaryeri guncelleme ayari kaydedilemedi' })
  }
}

export async function markExistingMarketplaceProducts(req: Request, res: Response) {
  try {
    const marketplace = marketplaceFromQuery(req)
    const status = (String(req.body.status || 'PUBLISHED') as ListingStatus)
    const productIds = Array.isArray(req.body.productIds)
      ? req.body.productIds.map(String).filter(Boolean)
      : []

    if (productIds.length === 0) {
      res.status(400).json({
        success: false,
        error: 'productIds zorunlu. Tum DB urunleri pazaryerinde yayinda varsayilamaz.',
      })
      return
    }

    // Only explicitly provided product IDs can be marked. This prevents treating
    // supplier XML products as if they were already live on the marketplace.
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, contentHash: true },
    })

    const result = await prisma.marketplaceListing.createMany({
      data: products.map(product => ({
        productId: product.id,
        marketplace,
        status,
        externalListingId: product.sku,
        publishedAt: status === 'PUBLISHED' ? new Date() : null,
        lastUpdatedAt: new Date(),
        hashAtPublish: product.contentHash,
      })),
      skipDuplicates: true,
    })

    res.status(201).json({
      success: true,
      data: {
        marketplace,
        created: result.count,
        scanned: products.length,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Pazaryeri urunleri isaretlenemedi' })
  }
}
