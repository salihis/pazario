import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import axios from 'axios'
import { createHash } from 'crypto'
import { MIN_MARKETPLACE_STOCK } from '../../validators/ProductValidator'
import { findApprovedCategoryMapping } from '../../services/CategoryMappingService'
import { applyXmlColorSizeOverrides } from '../../services/XmlAttributeOverrideService'
import type { Prisma } from '@prisma/client'

const prisma = new PrismaClient()
const SOCIAL_BRAND_NAME = 'Berselya Underwear&Accessoires'
const MARKETPLACES = ['TRENDYOL', 'N11', 'PAZARAMA'] as const
type Marketplace = typeof MARKETPLACES[number]
type GroupedProduct = Prisma.ProductGetPayload<{
  include: {
    listings: {
      select: {
        marketplace: true
        status: true
        lastUpdatedAt: true
      }
    }
  }
}> & {
  variantParentKey: string
  variantColor: string
  variantTotal: number
  publishProductIds: string[]
  variantListingStatuses: Record<Marketplace, Array<{ status: string; lastUpdatedAt: Date | null }>>
}

type SocialProductType = 'JEWELRY' | 'UNDERWEAR' | 'OTHER'
type PublishCheckResult = Awaited<ReturnType<typeof buildMarketplacePublishCheck>> extends infer T ? NonNullable<T> : never

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
}

function productContentHash(product: { externalId: string; price: unknown; stock: number; title: string }): string {
  return createHash('md5')
    .update(`${product.externalId}|${Number(product.price)}|${product.stock}|${product.title}`)
    .digest('hex')
}

function detectSocialProductType(product: { title: string; categoryRaw: string | null; source: { name: string } | null }): SocialProductType {
  const text = normalizeText(`${product.source?.name ?? ''} ${product.categoryRaw ?? ''} ${product.title}`)
  const jewelryKeywords = [
    'taki',
    'bijuteri',
    'kolye',
    'kupe',
    'bileklik',
    'bilezik',
    'yuzuk',
    'halhal',
    'charm',
    'broÃƒâ€¦Ã…Â¸',
    'bros',
    'piercing',
  ]
  const underwearKeywords = [
    'ic giyim',
    'iÃƒÆ’Ã‚Â§ giyim',
    'gecelik',
    'babydoll',
    'jartiyer',
    'sutyen',
    'sÃƒÆ’Ã‚Â¼tyen',
    'kulot',
    'kÃƒÆ’Ã‚Â¼lot',
    'korse',
    'fantazi',
    'fantezi',
    'pijama',
    'takim',
    'takÃƒâ€Ã‚Â±m',
    'body',
    'plaj',
    'plaj giyim',
    'plaj elbisesi',
    'bikini',
    'mayo',
    'pareo',
    'tayt',
    'elbise',
  ]

  if (jewelryKeywords.some(keyword => text.includes(normalizeText(keyword)))) return 'JEWELRY'
  if (underwearKeywords.some(keyword => text.includes(normalizeText(keyword)))) return 'UNDERWEAR'
  return 'OTHER'
}

function socialSeoContext(productType: SocialProductType): string {
  if (productType === 'JEWELRY') {
    return 'TAKI: zarif, Ãƒâ€¦Ã…Â¸Ãƒâ€Ã‚Â±k, gÃƒÆ’Ã‚Â¼nlÃƒÆ’Ã‚Â¼k kombin, hediye, aksesuar odaklÃƒâ€Ã‚Â± SEO ÃƒÆ’Ã‚Â¼ret. Ãƒâ€Ã‚Â°ÃƒÆ’Ã‚Â§ giyim, gecelik, fantazi gibi kelimeleri kullanma.'
  }
  if (productType === 'UNDERWEAR') {
    return 'IC_GIYIM: Ãƒâ€¦Ã…Â¸Ãƒâ€Ã‚Â±k, rahat, zarif, kadÃƒâ€Ã‚Â±n iÃƒÆ’Ã‚Â§ giyim/gece giyim odaklÃƒâ€Ã‚Â± SEO ÃƒÆ’Ã‚Â¼ret. TakÃƒâ€Ã‚Â±, kolye, kÃƒÆ’Ã‚Â¼pe, bileklik gibi kelimeleri kullanma.'
  }
  return 'GENEL: ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼n kategorisine sadÃƒâ€Ã‚Â±k kal, ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼nde olmayan kullanÃƒâ€Ã‚Â±m alanÃƒâ€Ã‚Â± veya kategori ekleme.'
}


function socialRoute(productType: SocialProductType) {
  if (productType === 'JEWELRY') return 'jewelry'
  if (productType === 'UNDERWEAR') return 'underwear'
  return 'general'
}

function normalizeMarketplace(value: unknown): Marketplace | null {
  const marketplace = String(value ?? '').toUpperCase()
  return MARKETPLACES.includes(marketplace as Marketplace) ? marketplace as Marketplace : null
}

function readMinStockFilter(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return MIN_MARKETPLACE_STOCK
  return Math.floor(parsed)
}

function readProductAttribute(attributes: unknown, names: string[]): string | null {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null
  const wanted = new Set(names.map(name => normalizeText(name)))
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (!wanted.has(normalizeText(key))) continue
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return null
}

function getVariantParentKey(product: { id: string; sku: string; attributes: unknown }) {
  const parent = readProductAttribute(product.attributes, ['variantParentSku', 'variantParentId'])
  return parent || product.id
}

function getVariantColor(product: { attributes: unknown }) {
  return readProductAttribute(product.attributes, ['Renk', 'renk', 'color', 'Color', 'value1']) || 'Renk belirtilmemis'
}

function marketplaceStatusSummary(products: Array<{ listings?: Array<{ marketplace: string; status: string }> }>) {
  return Object.fromEntries(MARKETPLACES.map(marketplace => {
    const published = products.filter(product =>
      (product.listings ?? []).some(listing => listing.marketplace === marketplace && listing.status === 'PUBLISHED')
    ).length
    const pending = products.filter(product =>
      (product.listings ?? []).some(listing => listing.marketplace === marketplace && listing.status === 'PENDING')
    ).length
    const failed = products.filter(product =>
      (product.listings ?? []).some(listing => listing.marketplace === marketplace && listing.status === 'FAILED')
    ).length
    const missing = Math.max(0, products.length - published - pending - failed)
    return [marketplace, { published, pending, failed, missing }]
  }))
}

function listingStatusesByMarketplace(product: { listings?: Array<{ marketplace: string; status: string; lastUpdatedAt: Date | null }> }) {
  return Object.fromEntries(MARKETPLACES.map(marketplace => {
    const listing = (product.listings ?? []).find(item => item.marketplace === marketplace)
    return [marketplace, [{ status: listing?.status ?? 'MISSING', lastUpdatedAt: listing?.lastUpdatedAt ?? null }]]
  })) as Record<Marketplace, Array<{ status: string; lastUpdatedAt: Date | null }>>
}

function aggregateGroupedListingStatus(statuses: Array<{ status: string; lastUpdatedAt: Date | null }>) {
  if (!statuses.length || statuses.every(item => item.status === 'MISSING')) return null
  const nonMissing = statuses.filter(item => item.status !== 'MISSING')
  const latest = nonMissing.reduce<Date | null>((last, item) => {
    if (!item.lastUpdatedAt) return last
    return !last || item.lastUpdatedAt > last ? item.lastUpdatedAt : last
  }, null)

  if (nonMissing.length === statuses.length && nonMissing.every(item => item.status === 'PUBLISHED')) {
    return { status: 'PUBLISHED', lastUpdatedAt: latest }
  }
  if (nonMissing.some(item => item.status === 'PUBLISHED')) return { status: 'PENDING', lastUpdatedAt: latest }
  if (nonMissing.some(item => item.status === 'FAILED')) return { status: 'FAILED', lastUpdatedAt: latest }
  if (nonMissing.some(item => item.status === 'PENDING')) return { status: 'PENDING', lastUpdatedAt: latest }
  if (nonMissing.some(item => item.status === 'DELISTED')) return { status: 'DELISTED', lastUpdatedAt: latest }
  return null
}

function groupedListingsFromVariantStatuses(group: Pick<GroupedProduct, 'variantListingStatuses'>) {
  return MARKETPLACES.flatMap(marketplace => {
    const aggregate = aggregateGroupedListingStatus(group.variantListingStatuses[marketplace] ?? [])
    return aggregate ? [{ marketplace, ...aggregate }] : []
  })
}

async function calculateMarketplacePrice(product: {
  id: string
  price: unknown
  brand: string | null
  categoryRaw: string | null
}, marketplace: Marketplace) {
  const rules = await prisma.priceRule.findMany({
    where: {
      active: true,
      OR: [{ marketplace }, { marketplace: '*' }],
    },
    orderBy: { priority: 'asc' },
  })

  const basePrice = Number(product.price)
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null
  const matchesRange = (rule: { priceStart: unknown; priceEnd: unknown }) => {
    const start = rule.priceStart === null ? null : Number(rule.priceStart)
    const end = rule.priceEnd === null ? null : Number(rule.priceEnd)
    if (start !== null && basePrice < start) return false
    if (end !== null && basePrice >= end) return false
    return true
  }
  const scopedRules = rules.filter(matchesRange)
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
  if (karOrani < 1 || komisyonOrani >= 1) return null

  const rawPrice = ((basePrice + ekTutar) * karOrani + kargo) / (1 - komisyonOrani)
  let finalPrice = Math.round(rawPrice * 100) / 100
  const globalSetting = await prisma.globalPriceSetting.findFirst()
  const minPrice = globalSetting ? Number(globalSetting.minPrice) : 50
  const minPriceApplied = finalPrice < minPrice
  if (minPriceApplied) finalPrice = minPrice

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    finalPrice,
    minPriceApplied,
  }
}

export async function getProducts(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '25'))
    const search = req.query.search as string | undefined
    const category = req.query.category as string | undefined
    const sourceId = req.query.sourceId as string | undefined
    const stockFilter = String(req.query.stockFilter || 'marketplace')
    const minStock = readMinStockFilter(req.query.minStock)

    const where: Prisma.ProductWhereInput = {
      ...(sourceId ? { sourceId } : {}),
      ...(category ? { categoryRaw: category } : {}),
      ...(stockFilter === 'marketplace' ? { stock: { gt: minStock } } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { sku: { contains: search, mode: 'insensitive' as const } },
              { barcode: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const totalProducts = await prisma.product.count({ where })
    const shouldGroupVariants = totalProducts <= 20000

    if (!shouldGroupVariants) {
      const skip = (page - 1) * limit
      const [data, total] = await Promise.all([
        prisma.product.findMany({
          where,
          skip,
          take: limit,
          orderBy: { updatedAt: 'desc' },
          include: {
            listings: {
              select: {
                marketplace: true,
                status: true,
                lastUpdatedAt: true,
              },
            },
          },
        }),
        prisma.product.count({ where }),
      ])
      res.json({
        success: true,
        data,
        meta: {
          total,
          rawTotal: total,
          groupedTotal: total,
          page,
          limit,
          grouped: false,
          marketplaceStatus: marketplaceStatusSummary(data),
        },
      })
      return
    }

    const allProducts = await prisma.product.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        listings: {
          select: {
            marketplace: true,
            status: true,
            lastUpdatedAt: true,
          },
        },
      },
    })

    const grouped = Array.from(allProducts.reduce((groups, product) => {
      const parentKey = getVariantParentKey(product)
      const color = getVariantColor(product)
      const groupKey = `${product.sourceId}:${parentKey}:${normalizeText(color)}`
      const current = groups.get(groupKey)

      if (!current) {
        groups.set(groupKey, {
          ...product,
          variantParentKey: parentKey,
          variantColor: color,
          variantTotal: 1,
          publishProductIds: [product.id],
          variantListingStatuses: listingStatusesByMarketplace(product),
        })
        return groups
      }

      current.variantTotal += 1
      current.publishProductIds.push(product.id)
      current.stock += product.stock
      if (product.updatedAt > current.updatedAt) current.updatedAt = product.updatedAt
      const productListingStatuses = listingStatusesByMarketplace(product)
      for (const marketplace of MARKETPLACES) {
        current.variantListingStatuses[marketplace].push(...productListingStatuses[marketplace])
      }
      return groups
    }, new Map<string, GroupedProduct>()).values())

    const groupedData = grouped.map(group => {
      const { variantListingStatuses, ...product } = group
      return {
        ...product,
        listings: groupedListingsFromVariantStatuses({ variantListingStatuses }),
      }
    })

    const skip = (page - 1) * limit
    const data = groupedData.slice(skip, skip + limit)

    res.json({
      success: true,
      data,
      meta: {
        total: groupedData.length,
        rawTotal: totalProducts,
        groupedTotal: groupedData.length,
        page,
        limit,
        grouped: true,
        marketplaceStatus: marketplaceStatusSummary(groupedData),
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

export async function getProductsOldUnused(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '25'))
    const skip = (page - 1) * limit
    const search = req.query.search as string | undefined
    const category = req.query.category as string | undefined
    const sourceId = req.query.sourceId as string | undefined
    const stockFilter = String(req.query.stockFilter || 'marketplace')
    const minStock = readMinStockFilter(req.query.minStock)

    const where: Prisma.ProductWhereInput = {
      ...(sourceId ? { sourceId } : {}),
      ...(category ? { categoryRaw: category } : {}),
      ...(stockFilter === 'marketplace' ? { stock: { gt: minStock } } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { sku: { contains: search, mode: 'insensitive' as const } },
              { barcode: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const [data, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          listings: {
            select: {
              marketplace: true,
              status: true,
              lastUpdatedAt: true,
            },
          },
        },
      }),
      prisma.product.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

export async function updateProduct(req: Request, res: Response) {
  try {
    const productId = String(req.params.id || '')
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined

    if (!productId) {
      res.status(400).json({ success: false, error: 'Urun id zorunlu' })
      return
    }
    if (title !== undefined && (title.length < 3 || title.length > 500)) {
      res.status(400).json({ success: false, error: 'Urun adi 3-500 karakter arasinda olmali' })
      return
    }

    const current = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, externalId: true, price: true, stock: true, title: true },
    })

    if (!current) {
      res.status(404).json({ success: false, error: 'Urun bulunamadi' })
      return
    }

    const nextTitle = title ?? current.title
    const updated = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(title !== undefined ? { title: nextTitle } : {}),
        contentHash: productContentHash({ ...current, title: nextTitle }),
      },
      select: { id: true, sku: true, title: true, updatedAt: true },
    })

    res.json({ success: true, data: updated })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Urun guncellenemedi' })
  }
}

export async function getProductCategories(req: Request, res: Response) {
  try {
    const sourceId = req.query.sourceId as string | undefined
    const stockFilter = String(req.query.stockFilter || 'marketplace')
    const minStock = readMinStockFilter(req.query.minStock)
    const groups = await prisma.product.groupBy({
      by: ['categoryRaw'],
      where: {
        categoryRaw: { not: null },
        ...(sourceId ? { sourceId } : {}),
        ...(stockFilter === 'marketplace' ? { stock: { gt: minStock } } : {}),
      },
      _count: { _all: true },
      orderBy: { categoryRaw: 'asc' },
    })

    res.json({
      success: true,
      data: groups
        .filter(group => group.categoryRaw)
        .map(group => ({
          category: group.categoryRaw,
          count: group._count._all,
        })),
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Kategori listesi alinamadi' })
  }
}



async function buildMarketplacePublishCheck(productId: string, marketplace: Marketplace) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      source: { select: { id: true, name: true } },
      productAttributes: { where: { marketplace } },
    },
  })

  if (!product) return null

  const checks: Array<{ key: string; ok: boolean; message: string }> = []
  const listing = await prisma.marketplaceListing.findUnique({
    where: { productId_marketplace: { productId, marketplace } },
  })
  const categoryMapping = await findApprovedCategoryMapping(prisma, {
    sourceId: product.sourceId,
    sourceCategory: product.categoryRaw,
    marketplace,
  })
  const price = await calculateMarketplacePrice(product, marketplace)
  const alreadyPublished = listing?.status === 'PUBLISHED'

  checks.push({
    key: 'stock',
    ok: product.stock > MIN_MARKETPLACE_STOCK,
    message: product.stock > MIN_MARKETPLACE_STOCK
      ? `Stok uygun: ${product.stock}`
      : `Stok yetersiz: ${product.stock}. Stok > ${MIN_MARKETPLACE_STOCK} olmali.`,
  })
  checks.push({
    key: 'existing_listing',
    ok: true,
    message: alreadyPublished
      ? 'Bu urun bu pazaryerinde zaten yayinda gorunuyor.'
      : 'Bu urun icin yayinda pazaryeri kaydi yok.',
  })
  checks.push({
    key: 'category_mapping',
    ok: Boolean(categoryMapping?.marketplaceCategoryId),
    message: categoryMapping?.marketplaceCategoryId
      ? `Kategori eslesmesi var: ${categoryMapping.marketplaceCategoryPath ?? categoryMapping.marketplaceCategoryId}`
      : 'Onayli kategori eslesmesi yok.',
  })
  checks.push({
    key: 'price',
    ok: Boolean(price?.finalPrice && price.finalPrice > 0),
    message: price?.finalPrice
      ? `Hesaplanmis pazaryeri fiyati: ${price.finalPrice.toFixed(2)} TL (${price.ruleName})`
      : 'Aktif fiyat kurali veya hesaplanabilir fiyat yok.',
  })

  let missingMandatory: string[] = []
  if (categoryMapping?.marketplaceCategoryId) {
    await applyXmlColorSizeOverrides(prisma, product, marketplace, categoryMapping.marketplaceCategoryId)
    const refreshedAttrs = await prisma.productAttribute.findMany({
      where: { productId, marketplace },
    })
    const mandatoryAttrs = await prisma.marketplaceCategoryAttribute.findMany({
      where: { marketplace, categoryId: categoryMapping.marketplaceCategoryId, isMandatory: true },
    })
    const filled = new Set(
      refreshedAttrs
        .filter(attr => attr.valueId || attr.valueText)
        .map(attr => attr.attributeId)
    )
    missingMandatory = mandatoryAttrs
      .filter(attr => !filled.has(attr.attributeId))
      .map(attr => attr.attributeName)
  }

  checks.push({
    key: 'mandatory_attributes',
    ok: missingMandatory.length === 0,
    message: missingMandatory.length === 0
      ? 'Zorunlu ozellikler tamam.'
      : `Eksik zorunlu ozellik: ${missingMandatory.slice(0, 8).join(', ')}`,
  })

  const canPublish = !alreadyPublished && checks.every(check => check.ok)

  return {
    productId: product.id,
    sku: product.sku,
    title: product.title,
    imageUrl: product.images?.[0] ?? null,
    categoryRaw: product.categoryRaw,
    sourceId: product.sourceId,
    sourceName: product.source?.name ?? null,
    variantParentKey: getVariantParentKey(product),
    variantColor: getVariantColor(product),
    publishProductIds: canPublish ? [product.id] : [],
    variantTotal: 1,
    readyVariantCount: canPublish ? 1 : 0,
    blockedVariantCount: canPublish ? 0 : 1,
    marketplace,
    canPublish,
    purchasePrice: Number(product.price),
    calculatedPrice: price,
    existingListingStatus: listing?.status ?? null,
    checks,
  }
}export async function checkProductMarketplacePublish(req: Request, res: Response) {
  try {
    const productId = String(req.params.id || '')
    const marketplace = normalizeMarketplace(req.body?.marketplace || req.query.marketplace)
    if (!marketplace) {
      res.status(400).json({ success: false, error: 'Gecersiz pazaryeri' })
      return
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        source: { select: { id: true, name: true } },
        productAttributes: { where: { marketplace } },
      },
    })

    if (!product) {
      res.status(404).json({ success: false, error: 'Urun bulunamadi' })
      return
    }

    const checks: Array<{ key: string; ok: boolean; message: string }> = []
    const listing = await prisma.marketplaceListing.findUnique({
      where: { productId_marketplace: { productId, marketplace } },
    })
    const categoryMapping = await findApprovedCategoryMapping(prisma, {
      sourceId: product.sourceId,
      sourceCategory: product.categoryRaw,
      marketplace,
    })
    const price = await calculateMarketplacePrice(product, marketplace)
    const alreadyPublished = listing?.status === 'PUBLISHED'

    checks.push({
      key: 'stock',
      ok: product.stock > MIN_MARKETPLACE_STOCK,
      message: product.stock > MIN_MARKETPLACE_STOCK
        ? `Stok uygun: ${product.stock}`
        : `Stok yetersiz: ${product.stock}. Stok > ${MIN_MARKETPLACE_STOCK} olmali.`,
    })
    checks.push({
      key: 'existing_listing',
      ok: true,
      message: alreadyPublished
        ? 'Bu urun bu pazaryerinde zaten yayinda gorunuyor.'
        : 'Bu urun icin yayinda pazaryeri kaydi yok.',
    })
    checks.push({
      key: 'category_mapping',
      ok: Boolean(categoryMapping?.marketplaceCategoryId),
      message: categoryMapping?.marketplaceCategoryId
        ? `Kategori eslesmesi var: ${categoryMapping.marketplaceCategoryPath ?? categoryMapping.marketplaceCategoryId}`
        : 'Onayli kategori eslesmesi yok.',
    })
    checks.push({
      key: 'price',
      ok: Boolean(price?.finalPrice && price.finalPrice > 0),
      message: price?.finalPrice
        ? `Hesaplanmis pazaryeri fiyati: ${price.finalPrice.toFixed(2)} TL (${price.ruleName})`
        : 'Aktif fiyat kurali veya hesaplanabilir fiyat yok.',
    })

    let missingMandatory: string[] = []
    if (categoryMapping?.marketplaceCategoryId) {
      await applyXmlColorSizeOverrides(prisma, product, marketplace, categoryMapping.marketplaceCategoryId)
      const refreshedAttrs = await prisma.productAttribute.findMany({
        where: { productId, marketplace },
      })
      const mandatoryAttrs = await prisma.marketplaceCategoryAttribute.findMany({
        where: { marketplace, categoryId: categoryMapping.marketplaceCategoryId, isMandatory: true },
      })
      const filled = new Set(
        refreshedAttrs
          .filter(attr => attr.valueId || attr.valueText)
          .map(attr => attr.attributeId)
      )
      missingMandatory = mandatoryAttrs
        .filter(attr => !filled.has(attr.attributeId))
        .map(attr => attr.attributeName)
    }

    checks.push({
      key: 'mandatory_attributes',
      ok: missingMandatory.length === 0,
      message: missingMandatory.length === 0
        ? 'Zorunlu ozellikler tamam.'
        : `Eksik zorunlu ozellik: ${missingMandatory.slice(0, 8).join(', ')}`,
    })

    const canPublish = !alreadyPublished && checks.every(check => check.ok)
    res.json({
      success: true,
      data: {
        productId: product.id,
        sku: product.sku,
        title: product.title,
        imageUrl: product.images?.[0] ?? null,
        categoryRaw: product.categoryRaw,
        sourceId: product.sourceId,
        sourceName: product.source?.name ?? null,
        variantParentKey: getVariantParentKey(product),
        variantColor: getVariantColor(product),
        publishProductIds: canPublish ? [product.id] : [],
        variantTotal: 1,
        readyVariantCount: canPublish ? 1 : 0,
        blockedVariantCount: canPublish ? 0 : 1,
        marketplace,
        canPublish,
        purchasePrice: Number(product.price),
        calculatedPrice: price,
        existingListingStatus: listing?.status ?? null,
        checks,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Gonderim kontrolu yapilamadi' })
  }
}


export async function bulkCheckProductMarketplacePublish(req: Request, res: Response) {
  try {
    const marketplace = normalizeMarketplace(req.body?.marketplace || req.query.marketplace)
    if (!marketplace) {
      res.status(400).json({ success: false, error: 'Gecersiz pazaryeri' })
      return
    }

    const productIds: string[] = Array.isArray(req.body?.productIds)
      ? Array.from(new Set<string>(req.body.productIds.map(String).filter(Boolean))).slice(0, 2000)
      : []

    if (productIds.length === 0) {
      res.status(400).json({ success: false, error: 'productIds zorunlu' })
      return
    }

    const results = []
    let hiddenStockInsufficient = 0
    for (const productId of productIds) {
      const result = await buildMarketplacePublishCheck(productId, marketplace)
      if (!result) continue
      const stockCheck = result.checks.find(check => check.key === 'stock')
      if (stockCheck && !stockCheck.ok) {
        hiddenStockInsufficient += 1
        continue
      }
      results.push(result)
    }

    const groupedResults = Array.from(results.reduce((groups, result) => {
      const groupKey = `${result.sourceId}:${result.variantParentKey}:${normalizeText(result.variantColor)}`
      const current = groups.get(groupKey)
      if (!current) {
        groups.set(groupKey, {
          ...result,
          publishProductIds: result.canPublish ? [result.productId] : [],
          variantTotal: 1,
          readyVariantCount: result.canPublish ? 1 : 0,
          blockedVariantCount: result.canPublish ? 0 : 1,
        })
        return groups
      }

      current.variantTotal += 1
      if (result.canPublish) {
        current.readyVariantCount += 1
        current.publishProductIds.push(result.productId)
      } else {
        current.blockedVariantCount += 1
      }
      current.canPublish = current.publishProductIds.length > 0
      current.checks = current.canPublish
        ? [
            { key: 'variant_group', ok: true, message: `${current.readyVariantCount}/${current.variantTotal} varyant gonderime hazir.` },
          ]
        : current.checks
      return groups
    }, new Map<string, typeof results[number]>()).values())

    const reasonCounts: Record<string, number> = {}
    for (const result of groupedResults) {
      for (const check of result.checks) {
        if (!check.ok) reasonCounts[check.key] = (reasonCounts[check.key] ?? 0) + 1
      }
    }

    res.json({
      success: true,
      data: {
        marketplace,
        checked: groupedResults.length,
        requested: productIds.length,
        hiddenStockInsufficient,
        ready: groupedResults.filter(result => result.canPublish).length,
        blocked: groupedResults.filter(result => !result.canPublish).length,
        reasonCounts,
        results: groupedResults,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Toplu gonderim kontrolu yapilamadi' })
  }
}

export async function publishProductToSocial(req: Request, res: Response) {
  try {
    const webhookUrl = process.env.MAKE_SOCIAL_WEBHOOK_URL
    if (!webhookUrl) {
      res.status(500).json({ success: false, error: 'Make webhook URL tanimli degil' })
      return
    }

    const productId = String(req.params.id || '')
    const targets = Array.isArray(req.body?.targets)
      ? req.body.targets.map(String).filter(Boolean)
      : ['pinterest', 'instagram']

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { source: { select: { id: true, name: true } } },
    })

    if (!product) {
      res.status(404).json({ success: false, error: 'Urun bulunamadi' })
      return
    }

    const imageUrl = product.images[0] || null
    if (!imageUrl) {
      res.status(400).json({ success: false, error: 'Sosyal medya gonderimi icin urun gorseli yok' })
      return
    }

    const productUrlTemplate = process.env.STORE_PRODUCT_URL_TEMPLATE || ''
    const productUrl = productUrlTemplate
      ? productUrlTemplate
          .replace('{id}', product.id)
          .replace('{sku}', encodeURIComponent(product.sku))
          .replace('{externalId}', encodeURIComponent(product.externalId))
      : null
    const productType = detectSocialProductType(product)

    const payload = {
      event: 'pazario.social_publish',
      product_id: product.id,
      source_id: product.sourceId,
      source_name: product.source?.name ?? null,
      external_id: product.externalId,
      sku: product.sku,
      barcode: product.barcode,
      title: product.title,
      description: product.description,
      category: product.categoryRaw,
      product_type: productType,
      social_route: socialRoute(productType),
      category_group: socialRoute(productType),
      seo_context: socialSeoContext(productType),
      brand: SOCIAL_BRAND_NAME,
      original_brand: product.brand,
      price: Number(product.price),
      list_price: product.listPrice === null ? null : Number(product.listPrice),
      currency: product.currency,
      stock: product.stock,
      image_url: imageUrl,
      file_url: imageUrl,
      photo_url: imageUrl,
      media_url: imageUrl,
      images: product.images,
      product_url: productUrl,
      publish_to_pinterest: targets.includes('pinterest'),
      publish_to_instagram: targets.includes('instagram'),
      targets,
      requested_at: new Date().toISOString(),
    }

    const response = await axios.post(webhookUrl, payload, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    })

    res.json({
      success: true,
      data: {
        productId: product.id,
        sku: product.sku,
        targets,
        productType,
        socialRoute: socialRoute(productType),
        makeStatus: response.status,
        makeResponse: response.data,
      },
    })
  } catch (error) {
    const detail = axios.isAxiosError(error)
      ? error.response?.data || error.message
      : error instanceof Error
        ? error.message
        : 'Bilinmeyen hata'
    const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail)
    const userMessage = detailText.includes('There is no scenario listening for this webhook')
      ? 'Make senaryosu webhook dinlemiyor. Make ekraninda senaryoyu Run once ile beklemeye alin veya senaryoyu aktif hale getirin.'
      : 'Make webhook gonderimi basarisiz'

    res.status(502).json({
      success: false,
      error: userMessage,
      detail,
    })
  }
}
