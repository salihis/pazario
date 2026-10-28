import 'dotenv/config'
import { Marketplace } from '@prisma/client'
import { prisma } from '../db'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { PublishService } from '../services/PublishService'

const PRODUCT_ID = '46bc0707-3697-4b0d-9dad-529565793559'
const CATEGORY_ID = '60000735'
const CATEGORY_NAME = 'Gecelik'
const EXPECTED_SOURCE_CATEGORY = 'Fantazi Gecelik'

function readAttribute(attributes: unknown, names: string[]): string {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return ''
  const normalizedNames = new Set(names.map(name => name.toLocaleLowerCase('tr-TR')))
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (!normalizedNames.has(key.toLocaleLowerCase('tr-TR'))) continue
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  const marketplace = Marketplace.HEPSIBURADA
  const product = await prisma.product.findUnique({ where: { id: PRODUCT_ID } })
  if (!product) throw new Error(`Urun bulunamadi: ${PRODUCT_ID}`)
  if (product.categoryRaw !== EXPECTED_SOURCE_CATEGORY) {
    throw new Error(`Kaynak kategori degisti: ${product.categoryRaw ?? '-'}`)
  }
  if (!product.barcode || !/^\d{8,14}$/.test(product.barcode)) {
    throw new Error(`Hepsiburada icin gecersiz barkod: ${product.barcode ?? '-'}`)
  }
  if (product.stock <= 6 || product.images.length === 0) {
    throw new Error('Urun stogu veya gorseli canli test icin uygun degil.')
  }

  const marketplaceCategory = await prisma.marketplaceCategory.findUnique({
    where: {
      marketplace_categoryId: {
        marketplace,
        categoryId: CATEGORY_ID,
      },
    },
  })
  if (!marketplaceCategory?.isLeaf) throw new Error(`Canli yaprak kategori bulunamadi: ${CATEGORY_ID}`)

  const color = readAttribute(product.attributes, ['Renk', 'color', 'value1'])
  const size = readAttribute(product.attributes, ['Beden', 'size', 'value2'])
  if (!color || !size) throw new Error('Urun renk veya beden bilgisi eksik.')

  const attributes = [
    ['merchantSku', 'Satici Stok Kodu', product.sku],
    ['UrunAdi', 'Urun Adi', product.title],
    ['Barcode', 'Barkod', product.barcode],
    ['Marka', 'Marka', product.brand || 'NIMSE LOVE'],
    ['tax_vat_rate', 'KDV', '10'],
    ['Image1', 'Gorsel1', product.images[0]],
    ['cinsiyet', 'Cinsiyet', 'Kad\u0131n'],
    ['materyal', 'Materyal', 'T\u00fcl'],
    ['renk_variant_property', 'Renk', color],
    ['beden_variant_property', 'Beden', size],
  ] as const

  await prisma.$transaction(async tx => {
    await tx.categoryMapping.upsert({
      where: {
        sourceId_sourceCategory_marketplace: {
          sourceId: product.sourceId,
          sourceCategory: EXPECTED_SOURCE_CATEGORY,
          marketplace,
        },
      },
      update: {
        marketplaceCategoryId: CATEGORY_ID,
        marketplaceCategoryPath: CATEGORY_NAME,
        status: 'APPROVED',
        aiSuggested: false,
        approvedBy: 'admin:live-smoke',
        approvedAt: new Date(),
      },
      create: {
        sourceId: product.sourceId,
        sourceCategory: EXPECTED_SOURCE_CATEGORY,
        marketplace,
        marketplaceCategoryId: CATEGORY_ID,
        marketplaceCategoryPath: CATEGORY_NAME,
        status: 'APPROVED',
        aiSuggested: false,
        approvedBy: 'admin:live-smoke',
        approvedAt: new Date(),
      },
    })

    for (const [attributeId, attributeName, valueText] of attributes) {
      await tx.productAttribute.upsert({
        where: {
          productId_marketplace_attributeId: {
            productId: product.id,
            marketplace,
            attributeId,
          },
        },
        update: {
          attributeName,
          valueId: null,
          valueText,
          isInherited: true,
          savedBy: 'admin:live-smoke',
          savedAt: new Date(),
        },
        create: {
          productId: product.id,
          marketplace,
          attributeId,
          attributeName,
          valueText,
          isInherited: true,
          savedBy: 'admin:live-smoke',
        },
      })
    }

    await tx.marketplaceListing.upsert({
      where: { productId_marketplace: { productId: product.id, marketplace } },
      update: { status: 'PENDING', lastUpdatedAt: new Date() },
      create: { productId: product.id, marketplace, status: 'PENDING' },
    })
  })

  const service = new PublishService(prisma)
  const result = await service.submitProducts([product.id], marketplace, 'admin:live-smoke')
  console.log(JSON.stringify({
    product: {
      id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      title: product.title,
      categoryId: CATEGORY_ID,
      categoryName: CATEGORY_NAME,
      color,
      size,
    },
    result,
  }, null, 2))
  if (result.submitted !== 1) process.exitCode = 1
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
