import { Marketplace, PrismaClient } from '@prisma/client'

type AttributeValue = { id: string; name: string }
type AttributeDefinition = {
  attributeId: string
  attributeName: string
  attributeType: string
  allowCustomValue: boolean
  values: unknown
}
type ProductForXmlAttributes = {
  id: string
  title: string
  categoryRaw: string | null
  attributes: unknown
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .toLowerCase()
}

function getAttributeValues(def: AttributeDefinition): AttributeValue[] {
  return Array.isArray(def.values) ? def.values as AttributeValue[] : []
}

function findAttributeValue(def: AttributeDefinition, names: string[]): AttributeValue | null {
  const values = getAttributeValues(def)
  const wanted = names.map(normalizeText)
  for (const name of wanted) {
    const exact = values.find(value => normalizeText(value.name) === name)
    if (exact) return exact
  }
  for (const name of wanted) {
    const partial = values.find(value => normalizeText(value.name).includes(name))
    if (partial) return partial
  }
  return null
}

function readXmlAttribute(product: ProductForXmlAttributes, names: string[]): string | null {
  if (!product.attributes || typeof product.attributes !== 'object' || Array.isArray(product.attributes)) {
    return null
  }

  const wanted = new Set(names.map(normalizeText))
  for (const [key, value] of Object.entries(product.attributes as Record<string, unknown>)) {
    if (!wanted.has(normalizeText(key))) continue
    const text = String(value ?? '').replace(/<[^>]*>/g, '').trim()
    if (text) return text
  }
  return null
}

function colorCandidates(rawColor: string): string[] {
  const normalized = normalizeText(rawColor)
  const candidates = [rawColor]
  const hints: Array<[string, string[]]> = [
    ['Siyah', ['siyah']],
    ['Beyaz', ['beyaz']],
    ['Gri', ['gri', 'fume']],
    ['Pembe', ['pembe', 'pudra']],
    ['Kirmizi', ['kirmizi']],
    ['Yesil', ['yesil']],
    ['Fusya', ['fusya']],
    ['Mavi', ['mavi', 'saks']],
    ['Mor', ['mor', 'lila']],
    ['Bej', ['bej', 'ten']],
    ['Ekru', ['ekru']],
    ['Krem', ['krem']],
    ['Bordo', ['bordo']],
    ['Lacivert', ['lacivert']],
    ['Sari', ['sari']],
    ['Kahverengi', ['kahverengi', 'brown']],
    ['Turkuaz', ['turkuaz']],
    ['Metalik', ['metalik']],
    ['Seffaf', ['seffaf', 'transparan']],
    ['Altin', ['altin', 'gold']],
    ['Gumus', ['gumus', 'silver']],
  ]
  for (const [name, terms] of hints) {
    if (terms.some(term => normalized.includes(term))) candidates.push(name)
  }
  if (new Set(candidates.slice(1)).size > 1) candidates.push('Cok Renkli')
  candidates.push('Cok Renkli')
  return Array.from(new Set(candidates.filter(Boolean)))
}

function sizeCandidates(rawSize: string): string[] {
  const cleaned = rawSize.replace(/\bbeden\b/gi, '').trim()
  const compact = cleaned.replace(/\s+/g, '').toUpperCase()
  const candidates = [cleaned, compact]
  if (/^STD|STANDART|STANDARD|TEK/.test(compact)) candidates.push('Standart', 'STD', 'Tek Ebat')
  if (compact === '2XL') candidates.push('XXL')
  if (compact === 'XXL') candidates.push('2XL')
  if (compact.includes('/')) candidates.push(compact.replace(/\//g, '-'), compact.replace(/\//g, ' / '))
  if (compact.includes('-')) candidates.push(compact.replace(/-/g, ' - '))
  return Array.from(new Set(candidates.filter(Boolean)))
}

export async function getXmlAttributeOverride(
  prisma: PrismaClient,
  product: ProductForXmlAttributes,
  marketplace: Marketplace,
  marketplaceCategoryId: string,
  attributeId: string
) {
  const def = await prisma.marketplaceCategoryAttribute.findUnique({
    where: {
      marketplace_categoryId_attributeId: {
        marketplace,
        categoryId: marketplaceCategoryId,
        attributeId,
      },
    },
  })
  if (!def) return null

  const attrName = normalizeText(def.attributeName)
  const rawColor = readXmlAttribute(product, ['renk'])
  const rawSize = readXmlAttribute(product, ['beden'])
  const rawValue = attrName.includes('web color') || attrName.includes('renk')
    ? rawColor
    : attrName.includes('beden')
      ? rawSize
      : null

  if (!rawValue) return null

  const typedDef = def as AttributeDefinition
  if (attrName.includes('web color')) {
    const value = findAttributeValue(typedDef, colorCandidates(rawValue))
    return value ? { attributeId, attributeName: def.attributeName, valueId: value.id, valueText: null } : null
  }
  if (attrName.includes('renk')) {
    const value = findAttributeValue(typedDef, colorCandidates(rawValue))
    if (value) return { attributeId, attributeName: def.attributeName, valueId: value.id, valueText: null }
    return { attributeId, attributeName: def.attributeName, valueId: null, valueText: rawValue }
  }
  if (attrName.includes('beden')) {
    const value = findAttributeValue(typedDef, sizeCandidates(rawValue))
    if (value) return { attributeId, attributeName: def.attributeName, valueId: value.id, valueText: null }
    return { attributeId, attributeName: def.attributeName, valueId: null, valueText: rawValue }
  }

  return null
}

export async function applyXmlColorSizeOverrides(
  prisma: PrismaClient,
  product: ProductForXmlAttributes,
  marketplace: Marketplace,
  marketplaceCategoryId: string
) {
  const defs = await prisma.marketplaceCategoryAttribute.findMany({
    where: {
      marketplace,
      categoryId: marketplaceCategoryId,
      OR: [
        { attributeName: { contains: 'Renk', mode: 'insensitive' } },
        { attributeName: { contains: 'Web Color', mode: 'insensitive' } },
        { attributeName: { contains: 'Beden', mode: 'insensitive' } },
      ],
    },
  })

  let applied = 0
  for (const def of defs) {
    const override = await getXmlAttributeOverride(prisma, product, marketplace, marketplaceCategoryId, def.attributeId)
    if (!override) continue
    await prisma.productAttribute.upsert({
      where: {
        productId_marketplace_attributeId: {
          productId: product.id,
          marketplace,
          attributeId: def.attributeId,
        },
      },
      update: {
        attributeName: def.attributeName,
        valueId: override.valueId,
        valueText: override.valueText,
        isInherited: true,
        savedBy: 'system:xml-color-size',
        savedAt: new Date(),
      },
      create: {
        productId: product.id,
        marketplace,
        attributeId: def.attributeId,
        attributeName: def.attributeName,
        valueId: override.valueId,
        valueText: override.valueText,
        isInherited: true,
        savedBy: 'system:xml-color-size',
      },
    })
    applied += 1
  }
  return applied
}
