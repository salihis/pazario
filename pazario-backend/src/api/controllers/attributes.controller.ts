// src/api/controllers/attributes.controller.ts

import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { CategoryAttributeService } from '../../services/CategoryAttributeService'
import { PublishService } from '../../services/PublishService'
import { findApprovedCategoryMapping } from '../../services/CategoryMappingService'
import { logger } from '../../utils/logger'

const prisma = new PrismaClient()
const attrService = new CategoryAttributeService(prisma)
const publishService = new PublishService(prisma)

type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'
type AttributeValue = { id: string; name: string }
type AttributeDefinition = {
  attributeId: string
  attributeName: string
  attributeType: string
  isMandatory: boolean
  allowCustomValue: boolean
  values: unknown
}
type InferredAttribute = {
  attributeId: string
  attributeName: string
  valueId?: string
  valueText?: string
}
type ProductForInference = {
  title: string
  categoryRaw: string | null
  attributes?: unknown
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u0131/g, 'i')
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

const COLOR_HINTS: Array<{ value: string; terms: string[] }> = [
  { value: 'Siyah', terms: ['siyah'] },
  { value: 'Beyaz', terms: ['beyaz'] },
  { value: 'Gri', terms: ['gri', 'füme', 'fume'] },
  { value: 'Pembe', terms: ['pembe', 'pudra'] },
  { value: 'Kırmızı', terms: ['kırmızı', 'kirmizi'] },
  { value: 'Yeşil', terms: ['yeşil', 'yesil'] },
  { value: 'Fuşya', terms: ['fuşya', 'fusya'] },
  { value: 'Mavi', terms: ['mavi'] },
  { value: 'Mor', terms: ['mor', 'lila'] },
  { value: 'Bej', terms: ['bej', 'ten'] },
  { value: 'Ekru', terms: ['ekru'] },
  { value: 'Krem', terms: ['krem'] },
  { value: 'Bordo', terms: ['bordo'] },
  { value: 'Lacivert', terms: ['lacivert'] },
  { value: 'Sarı', terms: ['sarı', 'sari'] },
  { value: 'Turuncu', terms: ['turuncu'] },
  { value: 'Kahverengi', terms: ['kahverengi', 'brown'] },
  { value: 'Turkuaz', terms: ['turkuaz'] },
  { value: 'Metalik', terms: ['metalik'] },
  { value: 'Seffaf', terms: ['seffaf', 'transparan'] },
  { value: 'Haki', terms: ['haki'] },
  { value: 'Altın', terms: ['altın', 'altin'] },
  { value: 'Gümüş', terms: ['gümüş', 'gumus'] },
]

function detectColors(text: string) {
  const normalized = normalizeText(text)
  const hits = COLOR_HINTS
    .filter(color => color.terms.some(term => normalized.includes(normalizeText(term))))
    .map(color => color.value)
  return Array.from(new Set(hits))
}

function isUnderwearProduct(product: ProductForInference): boolean {
  const text = normalizeText(`${product.title} ${product.categoryRaw ?? ''}`)
  return [
    'ic giyim',
    'gecelik',
    'babydoll',
    'jartiyer',
    'sutyen',
    'kulot',
    'pijama',
    'fantazi',
    'bustiyer',
    'korse',
    'kimono',
    'body',
  ].some(term => text.includes(term))
}

function readXmlAttribute(product: ProductForInference, names: string[]): string | null {
  if (!isUnderwearProduct(product) || !product.attributes || typeof product.attributes !== 'object' || Array.isArray(product.attributes)) {
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

function readAnyXmlAttribute(product: ProductForInference, names: string[]): string | null {
  if (!product.attributes || typeof product.attributes !== 'object' || Array.isArray(product.attributes)) {
    return null
  }

  const wanted = new Set(names.map(normalizeText))
  const attrs = product.attributes as Record<string, unknown>
  for (const [key, value] of Object.entries(attrs)) {
    if (!wanted.has(normalizeText(key))) continue
    const text = String(value ?? '').replace(/<[^>]*>/g, '').trim()
    if (text) return text
  }

  for (let index = 1; index <= 5; index++) {
    const name = attrs[`name${index}`] ?? attrs[`Name${index}`]
    const value = attrs[`value${index}`] ?? attrs[`Value${index}`]
    if (!wanted.has(normalizeText(name))) continue
    const text = String(value ?? '').replace(/<[^>]*>/g, '').trim()
    if (text) return text
  }
  return null
}

function readTitleSuffixColor(title: string): string | null {
  const parts = title.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const suffix = parts[parts.length - 1]
  if (!suffix || suffix.length > 40) return null
  const normalized = normalizeText(suffix)
  const colorLike = COLOR_HINTS.some(color => color.terms.some(term => normalized.includes(normalizeText(term))))
    || ['seffaf', 'transparan'].some(term => normalized.includes(term))
  return colorLike ? suffix : null
}

function shouldInferOptionalAttribute(attributeName: string): boolean {
  const text = normalizeText(attributeName)
  return [
    'uyumlu marka',
    'uyumlu model',
    'marka',
    'model',
    'kilif tipi',
    'materyal',
    'suya dayanikli',
    'renk',
    'web color',
    'beden',
  ].some(term => text.includes(term))
}

function splitAttributeValue(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[;,|]+/)
      .flatMap(part => part.split(/\s+\+\s+/))
      .map(part => part.trim())
      .filter(Boolean),
  ))
}

function inferColorFromXml(def: AttributeDefinition, rawColor: string): InferredAttribute | null {
  const parts = splitAttributeValue(rawColor)
  const detected = detectColors(rawColor)
  const candidates = [
    rawColor,
    ...parts,
    ...detected,
    detected.length > 1 ? 'Cok Renkli' : '',
    'Cok Renkli',
  ].filter(Boolean)

  const value = findAttributeValue(def, candidates)
  if (value) return { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name }
  if (def.allowCustomValue) {
    return { attributeId: def.attributeId, attributeName: def.attributeName, valueText: parts.join(' / ') || rawColor }
  }
  return null
}

function inferSizeFromXml(def: AttributeDefinition, rawSize: string): InferredAttribute | null {
  const cleaned = rawSize.replace(/\bbeden\b/gi, '').trim()
  const compact = cleaned.replace(/\s+/g, '').toUpperCase()
  const candidates = [cleaned, compact]

  if (/^STD|STANDART|STANDARD|TEK/.test(compact)) candidates.push('Standart', 'STD', 'Tek Ebat')
  if (compact === '2XL') candidates.push('XXL')
  if (compact === 'XXL') candidates.push('2XL')
  if (compact === '3XL') candidates.push('XXXL')
  if (compact === '4XL') candidates.push('XXXXL')
  if (compact === '5XL') candidates.push('XXXXXL')
  if (compact.includes('/')) {
    candidates.push(compact.replace(/\//g, '-'), compact.replace(/\//g, ' / '))
  }

  const value = findAttributeValue(def, candidates)
  if (value) {
    return { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name }
  }

  if (def.allowCustomValue && cleaned) {
    return { attributeId: def.attributeId, attributeName: def.attributeName, valueText: cleaned }
  }
  return null
}

function inferAttributeValue(def: AttributeDefinition, product: ProductForInference): InferredAttribute | null {
  const attrName = normalizeText(def.attributeName)
  const text = `${product.title} ${product.categoryRaw ?? ''}`
  const normalized = normalizeText(text)
  const normalizedTitle = normalizeText(product.title)
  const normalizedCategory = normalizeText(product.categoryRaw)
  const xmlColor = readXmlAttribute(product, ['renk'])
  const xmlSize = readXmlAttribute(product, ['beden'])
  const xmlAnyColor = readAnyXmlAttribute(product, ['renk', 'color', 'web color']) ?? xmlColor ?? readTitleSuffixColor(product.title)
  const xmlBrand = readAnyXmlAttribute(product, ['marka', 'brand'])
  const xmlModel = readAnyXmlAttribute(product, ['model', 'uyumlu model'])

  if (attrName.includes('uyumlu marka')) {
    const candidates = [
      xmlBrand,
      normalized.includes('apple') ? 'Apple' : '',
      normalized.includes('samsung') ? 'Samsung' : '',
      normalized.includes('xiaomi') ? 'Xiaomi' : '',
      normalized.includes('huawei') ? 'Huawei' : '',
      normalized.includes('oppo') ? 'Oppo' : '',
      normalized.includes('realme') ? 'Realme' : '',
    ].filter(Boolean) as string[]
    const value = findAttributeValue(def, candidates)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('uyumlu model')) {
    const candidates = [
      xmlModel,
      xmlBrand && xmlModel ? `${xmlBrand} ${xmlModel}` : '',
      xmlBrand && xmlModel ? `${xmlBrand} - ${xmlModel}` : '',
    ].filter(Boolean) as string[]
    const value = findAttributeValue(def, candidates)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName === 'marka' && xmlBrand) {
    const value = findAttributeValue(def, [xmlBrand])
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName === 'model' && xmlModel) {
    const value = findAttributeValue(def, [xmlModel, xmlBrand ? `${xmlBrand} ${xmlModel}` : ''].filter(Boolean))
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('kilif tipi')) {
    const preferred = normalized.includes('arka kilif') || normalized.includes('silikon') || normalized.includes('lensli')
      ? ['Arka Kılıf', 'Arka Kilif']
      : ['Arka Kılıf', 'Arka Kilif']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('suya dayanikli')) {
    const value = findAttributeValue(def, ['Hayır', 'Hayir', 'Yok'])
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('cinsiyet')) {
    if (normalized.includes('erkek')) {
      const value = findAttributeValue(def, ['Erkek'])
      return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
    }
    if (normalized.includes('unisex')) {
      const value = findAttributeValue(def, ['Unisex'])
      return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
    }
    if (normalized.includes('kadin') || normalized.includes('bayan') || normalized.includes('kiz')) {
      const value = findAttributeValue(def, ['Kadın / Kız', 'Kadın', 'Bayan'])
      return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
    }
  }

  if (attrName.includes('yas grubu')) {
    const preferred = normalized.includes('bebek')
      ? ['Bebek', 'Bebek & Çocuk']
      : normalized.includes('cocuk')
        ? ['Çocuk', 'Bebek & Çocuk']
        : normalized.includes('genc')
          ? ['Genç']
          : ['Yetişkin']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('mensei')) {
    const value = findAttributeValue(def, ['TR', 'Türkiye', 'Turkey'])
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('materyal')) {
    const materialSource = normalizedTitle || normalizedCategory
    const preferred = materialSource.includes('altin')
      ? ['Altin', 'Altin Kaplama']
      : materialSource.includes('gumus')
        ? ['Gumus', 'Gumus Kaplama']
        : materialSource.includes('celik')
          ? ['Celik', 'Paslanmaz Celik']
          : materialSource.includes('zirkon')
            ? ['Zirkon Tas']
            : /\binci\b/.test(materialSource)
              ? ['Kultur Incisi', 'Tatli Su Incisi']
              : /\btas\b/.test(materialSource)
                ? ['Tas', 'Dogal Tas']
                : ['Belirtilmemis', 'Metal', 'Pamuk', 'Polyester']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('tas cinsi')) {
    const preferred = /\bzirkon\b/.test(normalized)
      ? ['Zirkon']
      : /\binci\b/.test(normalized)
        ? ['Inci']
        : /\bkristal\b/.test(normalized)
          ? ['Kristal']
          : /\bboncuk\b/.test(normalized)
            ? ['Boncuk']
            : normalized.includes('dogal tas')
              ? ['Dogal Tas']
              : ['Yok']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('kumas tipi')) {
    const preferred = normalized.includes('mikrofiber')
      ? ['Mikrofiber']
      : normalized.includes('file')
        ? ['File']
        : normalized.includes('deri')
          ? ['Suni Deri']
          : normalized.includes('triko')
            ? ['Triko']
            : normalized.includes('dokuma')
              ? ['Dokuma']
              : ['Orme', 'Mikrofiber', 'Belirtilmemis']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('web color')) {
    if (xmlAnyColor) {
      const inferred = inferColorFromXml(def, xmlAnyColor)
      if (inferred) return inferred
    }
    const colors = detectColors(text)
    const preferred = colors.length > 1 ? ['Çok Renkli'] : [colors[0], 'Çok Renkli'].filter(Boolean)
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName === 'renk' || attrName.includes('renk')) {
    if (xmlAnyColor) {
      const inferred = inferColorFromXml(def, xmlAnyColor)
      if (inferred) return inferred
    }
    const colors = detectColors(text)
    if (colors.length > 0 && def.allowCustomValue) {
      return { attributeId: def.attributeId, attributeName: def.attributeName, valueText: colors.join(' / ') }
    }
    const value = findAttributeValue(def, colors.length > 1 ? ['Çok Renkli'] : [colors[0], 'Çok Renkli'].filter(Boolean))
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('beden')) {
    if (xmlSize) {
      const inferred = inferSizeFromXml(def, xmlSize)
      if (inferred) return inferred
    }
    const candidates: string[] = []
    const title = product.title
    if (/\b(5xl|xxxxx?l)\b/i.test(title)) candidates.push('5XL')
    if (/\b(4xl|xxxxl)\b/i.test(title)) candidates.push('4XL')
    if (/\b(3xl|xxxl)\b/i.test(title)) candidates.push('3XL')
    if (/\b(2xl|xxl)\b/i.test(title)) candidates.push('XXL')
    if (/\bxl\b/i.test(title)) candidates.push('XL')
    if (/\bl\b/i.test(title)) candidates.push('L')
    if (/\bm\b/i.test(title)) candidates.push('M')
    if (/\bs\b/i.test(title)) candidates.push('S')
    if (normalized.includes('standart') || normalized.includes('standard')) candidates.push('Standart')
    candidates.push('Standart', 'STD', 'Tek Ebat')
    const value = findAttributeValue(def, candidates)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('kumas tipi')) {
    const preferred = normalized.includes('mikrofiber')
      ? ['Mikrofiber']
      : normalized.includes('file')
        ? ['File']
        : normalized.includes('deri')
          ? ['Suni Deri']
          : normalized.includes('triko')
            ? ['Triko']
            : normalized.includes('dokuma')
              ? ['Dokuma']
              : ['Örme', 'Mikrofiber', 'Belirtilmemiş']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('materyal')) {
    const preferred = normalized.includes('celik') || normalized.includes('çelik')
      ? ['Çelik', 'Paslanmaz Çelik']
      : normalized.includes('gumus') || normalized.includes('gümüş')
        ? ['Gümüş', 'Gümüş Kaplama']
        : normalized.includes('altin') || normalized.includes('altın')
          ? ['Altın', 'Altın Kaplama']
          : normalized.includes('zirkon')
            ? ['Zirkon Taş']
            : normalized.includes('inci')
              ? ['Kültür İncisi', 'Tatlı Su İncisi']
              : normalized.includes('tas') || normalized.includes('taş')
                ? ['Taş', 'Doğal Taş']
                : ['Belirtilmemiş', 'Metal', 'Pamuk', 'Polyester']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  if (attrName.includes('tas cinsi')) {
    const preferred = normalized.includes('zirkon')
      ? ['Zirkon']
      : normalized.includes('inci')
        ? ['İnci']
        : normalized.includes('kristal')
          ? ['Kristal']
          : normalized.includes('boncuk')
            ? ['Boncuk']
            : normalized.includes('dogal tas') || normalized.includes('doğal taş')
              ? ['Doğal Taş']
              : ['Yok']
    const value = findAttributeValue(def, preferred)
    return value ? { attributeId: def.attributeId, attributeName: def.attributeName, valueId: value.id, valueText: value.name } : null
  }

  return null
}

// ─── ÖZELLIK ENDPOINT'LERİ ───────────────────────────────────────────────────

/**
 * GET /category-attributes/:marketplace/:categoryId
 */
export async function getCategoryAttributes(req: Request, res: Response) {
  try {
    const { marketplace, categoryId } = req.params
    const productId = req.query.productId as string | undefined

    const result = await attrService.getAttributes(
      marketplace as Marketplace,
      categoryId,
      productId
    )

    res.set('Cache-Control', 'max-age=3600')
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /category-attributes/:marketplace/:categoryId/refresh
 */
export async function refreshCategoryAttributes(req: Request, res: Response) {
  try {
    const { marketplace, categoryId } = req.params
    attrService.refreshFromAPI(marketplace as Marketplace, categoryId).catch((err: unknown) => {
      logger.error({ err, marketplace, categoryId }, 'refreshFromAPI arka plan hatası')
    })
    res.status(202).json({ success: true, message: 'Yenileniyor...' })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /category-attributes/:marketplace/sync-approved
 */
export async function syncApprovedCategoryAttributes(req: Request, res: Response) {
  try {
    const { marketplace } = req.params
    const { sourceId, limit = 250 } = req.body as { sourceId?: string; limit?: number }

    if (marketplace === 'HEPSIBURADA') {
      res.status(400).json({ success: false, error: 'Hepsiburada su an kapsam disi' })
      return
    }

    const mappings = await prisma.categoryMapping.findMany({
      where: {
        marketplace: marketplace as Marketplace,
        status: 'APPROVED',
        marketplaceCategoryId: { not: null },
        sourceId: sourceId || undefined,
      },
      select: { marketplaceCategoryId: true },
      take: Math.max(1, Math.min(Number(limit) || 250, 1000)),
    })

    const categoryIds = Array.from(
      new Set(mappings.map(m => m.marketplaceCategoryId).filter(Boolean) as string[])
    )

    let synced = 0
    let attributes = 0
    const failed: string[] = []

    for (const categoryId of categoryIds) {
      const count = await attrService.refreshFromAPI(marketplace as Marketplace, categoryId)
      if (count > 0) {
        synced++
        attributes += count
      } else {
        failed.push(categoryId)
      }
    }

    res.json({
      success: true,
      data: {
        marketplace,
        scannedMappings: mappings.length,
        categoryCount: categoryIds.length,
        synced,
        failed: failed.length,
        failedCategoryIds: failed.slice(0, 20),
        attributes,
      },
    })
  } catch (e) {
    logger.error({ err: e }, 'Onayli kategori ozellikleri senkronize edilemedi')
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

/**
 * GET /products/:productId/attributes/:marketplace
 */
export async function getProductAttributes(req: Request, res: Response) {
  try {
    const { productId, marketplace } = req.params
    const attrs = await prisma.productAttribute.findMany({
      where: { productId, marketplace: marketplace as Marketplace },
    })
    res.json({ success: true, data: attrs })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /products/:productId/attribute-schema/:marketplace
 */
export async function getProductAttributeSchema(req: Request, res: Response) {
  try {
    const { productId, marketplace } = req.params
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        title: true,
        sourceId: true,
        categoryRaw: true,
      },
    })

    if (!product) {
      res.status(404).json({ success: false, error: 'Urun bulunamadi' })
      return
    }

    const mapping = await findApprovedCategoryMapping(prisma, {
      sourceId: product.sourceId,
      sourceCategory: product.categoryRaw,
      marketplace: marketplace as Marketplace,
    })

    if (!mapping?.marketplaceCategoryId) {
      res.status(404).json({
        success: false,
        error: 'Bu urun kategorisi icin onayli pazaryeri kategori eslesmesi yok',
      })
      return
    }

    const result = await attrService.getAttributes(
      marketplace as Marketplace,
      mapping.marketplaceCategoryId,
      productId
    )

    res.json({
      success: true,
      data: {
        product,
        mapping,
        ...result,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}
/**
 * PUT /products/:productId/attributes/:marketplace
 */
export async function saveProductAttributes(req: Request, res: Response) {
  try {
    const { productId, marketplace } = req.params
    const { attributes } = req.body as {
      attributes: { attributeId: string; valueId?: string; valueText?: string }[]
    }

    if (!Array.isArray(attributes)) {
      res.status(400).json({ success: false, error: 'attributes dizisi zorunlu' })
      return
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { sourceId: true, categoryRaw: true },
    })
    if (!product) {
      res.status(404).json({ success: false, error: 'Urun bulunamadi' })
      return
    }

    const mapping = await findApprovedCategoryMapping(prisma, {
      sourceId: product.sourceId,
      sourceCategory: product.categoryRaw,
      marketplace: marketplace as Marketplace,
    })
    if (!mapping?.marketplaceCategoryId) {
      res.status(400).json({ success: false, error: 'Onayli kategori eslesmesi yok' })
      return
    }

    // Validasyon
    const attrDefs = await prisma.marketplaceCategoryAttribute.findMany({
      where: {
        marketplace: marketplace as Marketplace,
        categoryId: mapping.marketplaceCategoryId,
        attributeId: { in: attributes.map(a => a.attributeId) },
      },
    })

    const errors: { attributeId: string; error: string }[] = []
    for (const attr of attributes) {
      const def = attrDefs.find(d => d.attributeId === attr.attributeId)
      if (!def) continue
      const value = attr.valueText ?? attr.valueId ?? null
      const validation = attrService.validateValue(
        {
          attributeId: def.attributeId,
          attributeName: def.attributeName,
          attributeType: def.attributeType as 'dropdown',
          isMandatory: def.isMandatory,
          allowCustomValue: def.allowCustomValue,
          values: (def.values as { id: string; name: string }[]) ?? [],
          validationRules: (def.validationRules as object) ?? {},
          displayOrder: def.displayOrder,
        },
        value
      )
      if (!validation.isValid) {
        errors.push({ attributeId: attr.attributeId, error: validation.error ?? 'Geçersiz' })
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ success: false, errors })
      return
    }

    // Upsert
    let saved = 0
    let updated = 0

    for (const attr of attributes) {
      const def = attrDefs.find(d => d.attributeId === attr.attributeId)
      const existing = await prisma.productAttribute.findUnique({
        where: {
          productId_marketplace_attributeId: {
            productId,
            marketplace: marketplace as Marketplace,
            attributeId: attr.attributeId,
          },
        },
      })

      if (existing) {
        await prisma.productAttribute.update({
          where: { id: existing.id },
          data: { valueId: attr.valueId ?? null, valueText: attr.valueText ?? null },
        })
        updated++
      } else {
        await prisma.productAttribute.create({
          data: {
            productId,
            marketplace: marketplace as Marketplace,
            attributeId: attr.attributeId,
            attributeName: def?.attributeName ?? null,
            valueId: attr.valueId ?? null,
            valueText: attr.valueText ?? null,
          },
        })
        saved++
      }
    }

    res.json({ success: true, saved, updated })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /products/attributes/bulk-apply
 */
export async function bulkApplyAttributes(req: Request, res: Response) {
  try {
    const { productIds, marketplace, attributes } = req.body as {
      productIds: string[]
      marketplace: Marketplace
      attributes: { attributeId: string; valueId?: string; valueText?: string }[]
    }

    if (!Array.isArray(productIds) || !Array.isArray(attributes)) {
      res.status(400).json({ success: false, error: 'productIds ve attributes zorunlu' })
      return
    }

    let applied = 0
    const attrDefs = await prisma.marketplaceCategoryAttribute.findMany({
      where: {
        marketplace,
        attributeId: { in: attributes.map(attr => attr.attributeId) },
      },
      select: { attributeId: true, attributeName: true },
    })
    for (const productId of productIds) {
      for (const attr of attributes) {
        const def = attrDefs.find(item => item.attributeId === attr.attributeId)
        await prisma.productAttribute.upsert({
          where: {
            productId_marketplace_attributeId: {
              productId,
              marketplace,
              attributeId: attr.attributeId,
            },
          },
          update: {
            attributeName: def?.attributeName ?? undefined,
            valueId: attr.valueId ?? null,
            valueText: attr.valueText ?? null,
            isInherited: true,
            savedBy: 'admin:bulk-apply',
            savedAt: new Date(),
          },
          create: {
            productId,
            marketplace,
            attributeId: attr.attributeId,
            attributeName: def?.attributeName ?? null,
            valueId: attr.valueId ?? null,
            valueText: attr.valueText ?? null,
            isInherited: true,
            savedBy: 'admin:bulk-apply',
          },
        })
      }
      applied++
    }

    res.json({ success: true, applied, products: productIds })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /products/attributes/auto-fill
 */
export async function autoFillMissingAttributes(req: Request, res: Response) {
  try {
    const { productIds, marketplace, overwrite = false } = req.body as {
      productIds: string[]
      marketplace: Marketplace
      overwrite?: boolean
    }

    if (!Array.isArray(productIds) || !marketplace) {
      res.status(400).json({ success: false, error: 'productIds ve marketplace zorunlu' })
      return
    }

    const uniqueProductIds = Array.from(new Set(productIds.map(String).filter(Boolean))).slice(0, 500)
    let scanned = 0
    let updatedProducts = 0
    let filled = 0
    const unresolved: Array<{ productId: string; sku: string; attributeId: string; attributeName: string }> = []
    const skipped: Array<{ productId: string; reason: string }> = []

    for (const productId of uniqueProductIds) {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, sku: true, title: true, sourceId: true, categoryRaw: true, attributes: true },
      })
      if (!product) {
        skipped.push({ productId, reason: 'Urun bulunamadi' })
        continue
      }

      const mapping = await findApprovedCategoryMapping(prisma, {
        sourceId: product.sourceId,
        sourceCategory: product.categoryRaw,
        marketplace,
      })
      if (!mapping?.marketplaceCategoryId) {
        skipped.push({ productId, reason: 'Onayli kategori eslesmesi yok' })
        continue
      }

      scanned++
      const attrDefs = (await prisma.marketplaceCategoryAttribute.findMany({
        where: {
          marketplace,
          categoryId: mapping.marketplaceCategoryId,
        },
      })).filter(def => def.isMandatory || shouldInferOptionalAttribute(def.attributeName))
      const existingAttrs = await prisma.productAttribute.findMany({
        where: { productId, marketplace },
      })
      const existingByAttributeId = new Map(existingAttrs.map(attr => [attr.attributeId, attr]))
      let productFilled = 0

      for (const def of attrDefs) {
        const existing = existingByAttributeId.get(def.attributeId)
        const hasValue = Boolean(existing?.valueId || existing?.valueText)
        if (hasValue && !overwrite) continue

        const inferred = inferAttributeValue(def as AttributeDefinition, product)
        if (!inferred) {
          if (unresolved.length < 100) {
            unresolved.push({
              productId,
              sku: product.sku,
              attributeId: def.attributeId,
              attributeName: def.attributeName,
            })
          }
          continue
        }

        await prisma.productAttribute.upsert({
          where: {
            productId_marketplace_attributeId: {
              productId,
              marketplace,
              attributeId: def.attributeId,
            },
          },
          update: {
            valueId: inferred.valueId ?? null,
            valueText: inferred.valueText ?? null,
            attributeName: def.attributeName,
            isInherited: true,
            savedBy: 'system:auto-fill-xml-title-category',
            savedAt: new Date(),
          },
          create: {
            productId,
            marketplace,
            attributeId: def.attributeId,
            attributeName: def.attributeName,
            valueId: inferred.valueId ?? null,
            valueText: inferred.valueText ?? null,
            isInherited: true,
            savedBy: 'system:auto-fill-xml-title-category',
          },
        })
        productFilled++
        filled++
      }

      if (productFilled > 0) updatedProducts++
    }

    res.json({
      success: true,
      data: {
        marketplace,
        requested: uniqueProductIds.length,
        scanned,
        updatedProducts,
        filled,
        unresolved,
        skipped,
      },
    })
  } catch (e) {
    logger.error({ err: e }, 'Eksik ozellikler otomatik tamamlanamadi')
    res.status(500).json({ success: false, error: 'Eksik ozellikler otomatik tamamlanamadi' })
  }
}

/**
 * GET /products/attributes/completeness
 */
export async function getCompleteness(req: Request, res: Response) {
  try {
    const marketplace = req.query.marketplace as Marketplace
    const productIds = req.query['productIds[]'] as string | string[]
    const ids = Array.isArray(productIds) ? productIds : [productIds].filter(Boolean)

    if (!marketplace || ids.length === 0) {
      res.status(400).json({ success: false, error: 'marketplace ve productIds zorunlu' })
      return
    }

    const results = await publishService.getCompleteness(ids, marketplace)
    res.json({ success: true, data: results })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

// ─── GÖNDERİM ENDPOINT'LERİ ──────────────────────────────────────────────────

/**
 * POST /publish/submit
 */
export async function submitPublish(req: Request, res: Response) {
  try {
    const { productIds, marketplace, force } = req.body as {
      productIds: string[]
      marketplace: Marketplace
      force?: boolean
    }

    if (!Array.isArray(productIds) || !marketplace) {
      res.status(400).json({ success: false, error: 'productIds ve marketplace zorunlu' })
      return
    }

    const result = await publishService.submitProducts(productIds, marketplace, 'admin', { force: Boolean(force) })
    res.status(202).json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /publish/jobs
 */
export async function getPublishJobs(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '25'))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (req.query.status) where.status = req.query.status
    if (req.query.marketplace) where.marketplace = req.query.marketplace
    if (req.query.productId) where.productId = req.query.productId

    const [data, total] = await Promise.all([
      prisma.productPublishJob.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { product: { select: { title: true, sku: true } } },
      }),
      prisma.productPublishJob.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /publish/jobs/:jobId
 */
export async function getPublishJob(req: Request, res: Response) {
  try {
    const job = await prisma.productPublishJob.findUnique({
      where: { id: req.params.jobId },
      include: { product: true },
    })
    if (!job) { res.status(404).json({ success: false, error: 'Job bulunamadı' }); return }
    res.json({ success: true, data: job })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * POST /publish/jobs/:jobId/retry
 */
export async function retryPublishJob(req: Request, res: Response) {
  try {
    await prisma.productPublishJob.update({
      where: { id: req.params.jobId },
      data: { status: 'QUEUED', attemptCount: 0, errorMessage: null },
    })
    res.status(202).json({ success: true })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Job bulunamadı' })
  }
}

/**
 * POST /publish/jobs/retry-failed
 */
export async function retryAllFailed(req: Request, res: Response) {
  try {
    const result = await prisma.productPublishJob.updateMany({
      where: { status: 'FAILED' },
      data: { status: 'QUEUED', attemptCount: 0, errorMessage: null },
    })
    res.status(202).json({ success: true, queued: result.count })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /publish/status/:productId/:marketplace
 */
export async function getPublishStatus(req: Request, res: Response) {
  try {
    const { productId, marketplace } = req.params

    const lastJob = await prisma.productPublishJob.findFirst({
      where: { productId, marketplace: marketplace as Marketplace },
      orderBy: { createdAt: 'desc' },
    })

    const completeness = await publishService.getCompleteness(
      [productId],
      marketplace as Marketplace
    )

    res.json({
      success: true,
      data: {
        status: lastJob?.status ?? null,
        completenessPercent: completeness[0]?.completenessPercent ?? 0,
        lastJobId: lastJob?.id ?? null,
        resolvedAt: lastJob?.resolvedAt ?? null,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

