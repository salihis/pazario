import 'dotenv/config'
import { Marketplace } from '@prisma/client'
import { prisma } from '../db'
import { hepsiburadaEnvironment } from '../config/hepsiburada'

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  const marketplace = Marketplace.HEPSIBURADA
  if (process.env.HB_SOURCE_SAMPLES) {
    const sources = await prisma.xmlSource.findMany({
      where: { name: { contains: process.env.HB_SOURCE_SAMPLES, mode: 'insensitive' } },
      select: {
        id: true,
        name: true,
        priceIncludesVat: true,
        purchaseVatRate: true,
        purchaseExtraFee: true,
      },
    })
    if (process.env.HB_SOURCE_SETTINGS_ONLY === 'true') {
      console.log(JSON.stringify({ query: process.env.HB_SOURCE_SAMPLES, sources }, null, 2))
      return
    }
    const products = sources.length > 0
      ? await prisma.product.findMany({
          where: { sourceId: { in: sources.map(source => source.id) }, stock: { gt: 6 }, images: { isEmpty: false } },
          take: 40,
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            sourceId: true,
            categoryRaw: true,
            sku: true,
            barcode: true,
            title: true,
            brand: true,
            stock: true,
            price: true,
            images: true,
            attributes: true,
          },
        })
      : []
    console.log(JSON.stringify({ query: process.env.HB_SOURCE_SAMPLES, sources, products }, null, 2))
    return
  }
  if (process.env.HB_SMOKE_STATUS === 'true') {
    const productId = '46bc0707-3697-4b0d-9dad-529565793559'
    const [listing, jobs, operations, attributes, mapping, priceRules, globalPriceSetting] = await Promise.all([
      prisma.marketplaceListing.findUnique({ where: { productId_marketplace: { productId, marketplace } } }),
      prisma.productPublishJob.findMany({ where: { productId, marketplace }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.operationHistory.findMany({ where: { marketplace, items: { some: { productId } } }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.productAttribute.findMany({ where: { productId, marketplace }, orderBy: { attributeId: 'asc' } }),
      prisma.categoryMapping.findFirst({ where: { marketplace, sourceId: '4f3c39b1-7eeb-43d3-a594-c6d7a69f1c31', sourceCategory: 'Fantazi Gecelik' } }),
      prisma.priceRule.findMany({ where: { active: true }, orderBy: [{ marketplace: 'asc' }, { priority: 'asc' }] }),
      prisma.globalPriceSetting.findFirst(),
    ])
    console.log(JSON.stringify({ listing, jobs, operations, attributes, mapping, priceRules, globalPriceSetting }, null, 2))
    return
  }
  if (process.env.HB_CATEGORY_SEARCH) {
    const categories = await prisma.marketplaceCategory.findMany({
      where: {
        marketplace,
        categoryName: { contains: process.env.HB_CATEGORY_SEARCH, mode: 'insensitive' },
      },
      orderBy: { categoryName: 'asc' },
      take: 100,
    })
    console.log(JSON.stringify({ query: process.env.HB_CATEGORY_SEARCH, categories }, null, 2))
    return
  }
  if (process.env.HB_NUMERIC_BARCODE_SAMPLES === 'true') {
    const sourceSearch = process.env.HB_SOURCE_SEARCH?.trim()
    const products = await prisma.product.findMany({
      where: {
        ...(sourceSearch ? { source: { name: { contains: sourceSearch, mode: 'insensitive' } } } : {}),
        categoryRaw: { not: null },
        stock: { gt: 6 },
        barcode: { not: null },
        images: { isEmpty: false },
        listings: { none: { marketplace } },
      },
      take: 3000,
      include: { source: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
    })
    const samples = products
      .filter(product => /^\d{8,14}$/.test(product.barcode ?? ''))
      .slice(0, 30)
      .map(product => ({
        id: product.id,
        sourceId: product.sourceId,
        source: product.source.name,
        categoryRaw: product.categoryRaw,
        sku: product.sku,
        barcode: product.barcode,
        title: product.title,
        brand: product.brand,
        stock: product.stock,
        price: product.price.toString(),
        imageCount: product.images.length,
        attributes: product.attributes,
      }))
    console.log(JSON.stringify({ sourceSearch: sourceSearch || null, scanned: products.length, samples }, null, 2))
    return
  }
  const mappings = await prisma.categoryMapping.findMany({
    where: {
      marketplace,
      status: 'APPROVED',
      marketplaceCategoryId: { not: null },
    },
    include: { source: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  })

  const candidates: Array<Record<string, unknown>> = []
  for (const mapping of mappings) {
    if (!mapping.marketplaceCategoryId) continue
    const category = await prisma.marketplaceCategory.findUnique({
      where: {
        marketplace_categoryId: {
          marketplace,
          categoryId: mapping.marketplaceCategoryId,
        },
      },
    })
    if (!category) continue

    const product = await prisma.product.findFirst({
      where: {
        sourceId: mapping.sourceId,
        categoryRaw: mapping.sourceCategory,
        stock: { gt: 0 },
        barcode: { not: null },
        images: { isEmpty: false },
        listings: { none: { marketplace } },
      },
      orderBy: { updatedAt: 'desc' },
    })
    if (!product) continue

    candidates.push({
      mappingId: mapping.id,
      source: mapping.source.name,
      sourceCategory: mapping.sourceCategory,
      marketplaceCategoryId: mapping.marketplaceCategoryId,
      marketplaceCategoryPath: category.categoryPath,
      product: {
        id: product.id,
        sku: product.sku,
        title: product.title,
        brand: product.brand,
        barcode: product.barcode,
        stock: product.stock,
        price: product.price.toString(),
        imageCount: product.images.length,
      },
    })
    if (candidates.length >= 10) break
  }

  const sampleProducts = candidates.length === 0
    ? await prisma.product.findMany({
        where: {
          categoryRaw: { not: null },
          stock: { gt: 0 },
          barcode: { not: null },
          images: { isEmpty: false },
        },
        take: 500,
        include: { source: { select: { name: true } } },
      })
    : []
  const unmappedSamples = Array.from(
    new Map(sampleProducts.map(product => [`${product.sourceId}:${product.categoryRaw}`, product])).values()
  ).slice(0, 30)
  const categoryMatches = []
  for (const product of unmappedSamples.slice(0, 12)) {
    const leafName = String(product.categoryRaw ?? '').split('>>>').pop()?.trim() ?? ''
    if (!leafName) continue
    const matches = await prisma.marketplaceCategory.findMany({
      where: {
        marketplace,
        categoryName: { contains: leafName, mode: 'insensitive' },
      },
      select: { categoryId: true, categoryName: true, categoryPath: true },
      take: 8,
    })
    categoryMatches.push({
      sourceCategory: product.categoryRaw,
      productId: product.id,
      matches,
    })
  }
  const selectedProduct = await prisma.product.findUnique({
    where: { id: '01bbc794-45c8-45a5-a9d0-a7f44e60477d' },
    include: {
      productAttributes: { where: { marketplace } },
    },
  })
  const selectedProductOutput = selectedProduct ? {
    id: selectedProduct.id,
    sku: selectedProduct.sku,
    title: selectedProduct.title,
    brand: selectedProduct.brand,
    barcode: selectedProduct.barcode,
    stock: selectedProduct.stock,
    price: selectedProduct.price.toString(),
    images: selectedProduct.images,
    categoryRaw: selectedProduct.categoryRaw,
    sourceId: selectedProduct.sourceId,
    rawAttributes: selectedProduct.attributes,
    marketplaceAttributes: selectedProduct.productAttributes.map(attribute => ({
      id: attribute.attributeId,
      name: attribute.attributeName,
      valueId: attribute.valueId,
      valueText: attribute.valueText,
    })),
  } : null

  if (process.env.HB_SELECTED_ONLY === 'true') {
    console.log(JSON.stringify({ selectedProduct: selectedProductOutput }, null, 2))
    return
  }

  console.log(JSON.stringify({
    approvedMappings: mappings.length,
    liveCandidates: candidates.length,
    candidates,
    unmappedSamples: unmappedSamples.map(product => ({
      source: product.source.name,
      sourceId: product.sourceId,
      sourceCategory: product.categoryRaw,
      productId: product.id,
      sku: product.sku,
      title: product.title,
      brand: product.brand,
      stock: product.stock,
      imageCount: product.images.length,
    })),
    categoryMatches,
    selectedProduct: selectedProductOutput,
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
  .finally(async () => prisma.$disconnect())
