// src/parser/XMLParser.ts

import { XMLParser as FastXMLParser } from 'fast-xml-parser'
import { createHash } from 'crypto'
import { Readable } from 'stream'

// â”€â”€â”€ HATA SINIFI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class XMLParseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = 'XMLParseError'
  }
}

// â”€â”€â”€ INTERFACE'LER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ParsedProduct {
  id: string
  sku: string
  barcode: string | null
  title: string
  description: string | null
  brand: string | null
  category: string | null
  price: number
  listPrice: number | null
  currency: string
  stock: number
  images: string[]
  attributes: Record<string, string>
  contentHash: string
}

export interface ParseError {
  type: 'ERROR' | 'WARN'
  code: string
  message: string
  raw?: unknown
}

export interface ParseResult {
  products: ParsedProduct[]
  meta: {
    totalNodes: number
    parsed: number
    failed: number
    durationMs: number
    feedType: 'RSS_SHOPPING' | 'ATOM' | 'CUSTOM_PRODUCTS' | 'CUSTOM_CATALOG' | 'CUSTOM_ITEMS' | 'UNKNOWN'
  }
  errors: ParseError[]
}

// â”€â”€â”€ SABÄ°TLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface XMLParseOptions {
  preferredPriceFields?: string[]
  generatedBarcodePrefix?: string
  deduplicateBySku?: boolean
}

export function buildParseOptionsForSource(source?: { name?: string | null; url?: string | null }): XMLParseOptions {
  const sourceKey = `${source?.name ?? ''} ${source?.url ?? ''}`
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')

  if (sourceKey.includes('ebijuteri')) {
    return { generatedBarcodePrefix: 'BRS1634', deduplicateBySku: true }
  }

  if (sourceKey.includes('lunalora')) {
    return { preferredPriceFields: ['price', 'sitePrice', 'realPrice', 'salePrice'] }
  }

  if (sourceKey.includes('xmltedarik') || sourceKey.includes('xml tedarik')) {
    return { preferredPriceFields: ['ListPrice', 'listPrice', 'g:list_price'] }
  }

  return {}
}

const STREAM_THRESHOLD_BYTES = 50 * 1024 * 1024 // 50MB
const DEFAULT_CURRENCY = 'TRY'

// TÃ¼rk fiyat formatÄ±: "1.299,99 TL" veya "1299.99 TRY"
const TR_PRICE_REGEX = /^[\s]*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)[\s]*(TL|TRY|â‚º)?[\s]*$/i
const STANDARD_PRICE_REGEX = /^[\s]*([0-9]+(?:\.[0-9]{1,2})?)[\s]*(TL|TRY|USD|EUR|â‚º)?[\s]*$/i

// â”€â”€â”€ YARDIMCI FONKSÄ°YONLAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * TÃ¼rk fiyat formatÄ±nÄ± sayÄ±ya Ã§evirir
 * "1.299,99 TL" â†’ 1299.99
 * "1299.99 TRY" â†’ 1299.99
 */
function parseTurkishPrice(raw: unknown): { price: number; currency: string } | null {
  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()

  // TÃ¼rk formatÄ±: nokta binlik ayraÃ§, virgÃ¼l ondalÄ±k
  const trMatch = str.match(/^([0-9]{1,3}(?:\.[0-9]{3})*),([0-9]{1,2})\s*(TL|TRY|â‚º)?$/i)
  if (trMatch) {
    const normalized = trMatch[1].replace(/\./g, '') + '.' + trMatch[2]
    return {
      price: parseFloat(normalized),
      currency: trMatch[3] ? 'TRY' : DEFAULT_CURRENCY,
    }
  }

  // Standart format: nokta ondalÄ±k
  const stdMatch = str.match(/^([0-9]+(?:\.[0-9]{1,2})?)\s*(TL|TRY|USD|EUR|â‚º)?$/i)
  if (stdMatch) {
    return {
      price: parseFloat(stdMatch[1]),
      currency: stdMatch[2] ? (stdMatch[2].toUpperCase() === 'TL' ? 'TRY' : stdMatch[2].toUpperCase()) : DEFAULT_CURRENCY,
    }
  }

  // Sadece rakam
  const num = parseFloat(str.replace(/[^0-9.]/g, ''))
  if (!isNaN(num)) return { price: num, currency: DEFAULT_CURRENCY }

  return null
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

function firstPositivePrice(...values: unknown[]): { price: number; currency: string } | null {
  for (const value of values) {
    const parsed = parseTurkishPrice(value)
    if (parsed && parsed.price > 0) return parsed
  }
  return null
}

function preferredPrice(node: Record<string, unknown>, fields: string[] | undefined): { price: number; currency: string } | null {
  if (!fields || fields.length === 0) return null
  return firstPositivePrice(...fields.map(field => node[field]))
}

/**
 * MD5 hash Ã¼retir: id + price + stock + title
 */
function generateContentHash(id: string, price: number, stock: number, title: string, sourceSpecificValue = ''): string {
  const base = `${id}|${price}|${stock}|${title}`
  return createHash('md5')
    .update(sourceSpecificValue ? `${base}|${sourceSpecificValue}` : base)
    .digest('hex')
}

function generatedBarcode(prefix: string | undefined, sku: string): string | null {
  if (!prefix) return null
  const normalizedSku = sku.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '')
  const value = `${prefix}${normalizedSku}`
  return normalizedSku && value.length <= 20 ? value : null
}

function productQualityScore(product: ParsedProduct): number {
  return (product.stock > 0 ? 1_000_000 : 0)
    + Object.keys(product.attributes).length * 100
    + product.images.length * 10
    + (product.description?.length ?? 0)
}

function finalizeProducts(
  products: ParsedProduct[],
  options: XMLParseOptions,
  errors: ParseError[],
): ParsedProduct[] {
  if (!options.deduplicateBySku) return products

  const bySku = new Map<string, ParsedProduct>()
  let duplicates = 0
  for (const product of products) {
    const existing = bySku.get(product.sku)
    if (!existing) {
      bySku.set(product.sku, product)
      continue
    }
    duplicates++
    if (productQualityScore(product) > productQualityScore(existing)) {
      bySku.set(product.sku, product)
    }
  }

  if (duplicates > 0) {
    errors.push({
      type: 'WARN',
      code: 'DUPLICATE_SKU',
      message: `${duplicates} tekrar eden stok kodu tekillestirildi; stoklu ve daha zengin kayit korundu`,
    })
  }
  return Array.from(bySku.values())
}

/**
 * XML string'ini temizler
 * - Null byte temizle
 * - Bare & â†’ &amp;
 * - Encoding UTF-8 yap
 */
function sanitizeXml(xml: string): string {
  return xml
    .replace(/\x00/g, '')                                          // null byte
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);)/gi, '&amp;') // bare &
    .replace(/<\?xml[^?]*\?>/i, '<?xml version="1.0" encoding="UTF-8"?>')     // encoding
}

/**
 * Ham node'dan string deÄŸer Ã§eker
 */
function str(val: unknown): string {
  if (val === null || val === undefined) return ''
  return String(val).trim()
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value)
    if (text) return text
  }
  return ''
}

/**
 * Ham node'dan image URL array'i Ã§eker
 */
function extractImages(node: Record<string, unknown>): string[] {
  const mainImage = str(node['AnaGorsel'])
  const otherImagesRoot = node['DigerGorseller'] as Record<string, unknown> | undefined
  const otherImages = asArray(otherImagesRoot?.['Gorsel'])
    .map(str)
    .filter(Boolean)
  if (mainImage || otherImages.length > 0) {
    return Array.from(new Set([mainImage, ...otherImages].filter(Boolean)))
  }

  const candidates = [
    node['g:image_link'], node['image_link'],
    node['image'], node['Image'], node['IMAGE'],
    node['gorsel'], node['Gorsel'],
  ]

  for (const c of candidates) {
    if (Array.isArray(c)) return c.map(String).filter(Boolean)
    if (typeof c === 'string' && c) return [c]
  }

  // additional_image_link
  const additional = node['g:additional_image_link'] || node['additional_image_link']
  if (additional) {
    if (Array.isArray(additional)) return additional.map(String)
    return [String(additional)]
  }

  const numberedImages = Object.entries(node)
    .filter(([key, value]) => /^image\d+$/i.test(key) && value)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => String(value))
  if (numberedImages.length > 0) return numberedImages

  const resim = node['resim'] as Record<string, unknown> | undefined
  if (resim && typeof resim === 'object') {
    return Object.entries(resim)
      .filter(([key, value]) => /^resim\d+$/i.test(key) && value)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([, value]) => String(value))
  }

  const resimler = node['Resimler'] as Record<string, unknown> | undefined
  const ticimaxImages = resimler?.['Resim']
  if (Array.isArray(ticimaxImages)) return ticimaxImages.map(String).filter(Boolean)
  if (typeof ticimaxImages === 'string' && ticimaxImages) return [ticimaxImages]

  return []
}

/**
 * Ham node'dan attributes Ã§Ä±karÄ±r
 */
function extractAttributes(node: Record<string, unknown>): Record<string, string> {
  const skip = new Set([
    'id', 'sku', 'barcode', 'title', 'description', 'brand',
    'category', 'price', 'listPrice', 'stock', 'image',
    'g:id', 'g:title', 'g:description', 'g:brand', 'g:price',
    'g:image_link', 'g:condition', 'g:availability',
  ])
  const attrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(node)) {
    if (!skip.has(k) && typeof v !== 'object' && v !== undefined && v !== null) {
      attrs[k] = String(v)
    }
  }

  const filtreler = node['filtreler'] as Record<string, unknown> | undefined
  const filtre = filtreler?.['filtre']
  const filters = Array.isArray(filtre) ? filtre : filtre ? [filtre] : []
  for (const item of filters) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = str(record['name'])
    const value = str(record['value'])
    if (name && value) attrs[name] = value
  }

  const optionAttrs = node['EkSecenekOzellik'] as Record<string, unknown> | undefined
  const optionValues = optionAttrs?.['Ozellik']
  const options = Array.isArray(optionValues) ? optionValues : optionValues ? [optionValues] : []
  for (const item of options) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = firstNonEmpty(record['@_Tanim'], record['Tanim'])
    const value = firstNonEmpty(record['@_Deger'], record['Deger'], record['#text'])
    if (name && value) attrs[name] = value
  }

  return attrs
}

function expandTicimaxProducts(items: unknown): unknown[] {
  const products = asArray(items)
  const expanded: unknown[] = []

  for (const item of products) {
    if (!item || typeof item !== 'object') {
      expanded.push(item)
      continue
    }

    const product = item as Record<string, unknown>
    const baseId = str(product['UrunKartiID'] ?? product['UrunKodu'] ?? product['id'] ?? product['ID'] ?? product['ProductId'] ?? product['productId'])
    const baseSku = str(product['StokKodu'] ?? product['StockCode'] ?? product['stockCode'] ?? product['sku'] ?? product['SKU'] ?? baseId)
    const optionsRoot = product['UrunSecenek'] as Record<string, unknown> | undefined
    const rawOptions = optionsRoot?.['Secenek']
    const options = Array.isArray(rawOptions) ? rawOptions : rawOptions ? [rawOptions] : []

    const variantsRoot = product['Varyantlar'] as Record<string, unknown> | undefined
    const rawVariants = variantsRoot?.['Varyant']
    const variants = asArray(rawVariants).filter(variant => variant && typeof variant === 'object')

    if (options.length === 0 && variants.length > 0) {
      variants.forEach((rawVariant, index) => {
        const variant = rawVariant as Record<string, unknown>
        const variantBarcode = firstNonEmpty(variant['Barkod'], variant['Barcode'], variant['barcode'])
        const variantSku = firstNonEmpty(
          variant['StokKodu'],
          variant['SKU'],
          variant['sku'],
          variantBarcode,
          `${baseSku}-${index + 1}`,
        )
        const variantId = firstNonEmpty(
          variant['ID'],
          variant['id'],
          variantBarcode ? `${baseId}-${variantBarcode}` : '',
          `${baseId}-${index + 1}`,
        )

        expanded.push({
          ...product,
          ...variant,
          id: variantId,
          sku: variantSku,
          barcode: variantBarcode,
          stock: variant['Stok'] ?? variant['ToplamStok'] ?? product['ToplamStok'],
          BayiFiyat: variant['BayiFiyat'] ?? product['BayiFiyat'],
          PerakendeFiyat: variant['PerakendeFiyat'] ?? product['PerakendeFiyat'],
          Varyantlar: undefined,
          variantParentId: baseId,
          variantParentSku: baseSku,
        })
      })
      continue
    }

    if (options.length === 0) {
      expanded.push(product)
      continue
    }

    for (const option of options) {
      if (!option || typeof option !== 'object') continue
      expanded.push({
        ...product,
        ...(option as Record<string, unknown>),
        UrunSecenek: undefined,
        variantParentId: baseId,
        variantParentSku: baseSku,
      })
    }
  }

  return expanded
}

function variantValue(variant: Record<string, unknown>, index: number): string {
  return firstNonEmpty(
    variant[`value${index}`],
    variant[`Value${index}`],
    variant[`VariantValue${index}`],
    variant[`deger${index}`],
    variant[`Deger${index}`],
    variant[`optionValue${index}`],
    variant[`OptionValue${index}`]
  )
}

function variantName(variant: Record<string, unknown>, index: number): string {
  return firstNonEmpty(
    variant[`name${index}`],
    variant[`Name${index}`],
    variant[`VariantName${index}`],
    variant[`secenek${index}`],
    variant[`Secenek${index}`],
    variant[`optionName${index}`],
    variant[`OptionName${index}`]
  )
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .toLowerCase()
}

function looksLikeSize(value: string): boolean {
  const compact = value.trim().replace(/\s+/g, '').toUpperCase()
  return /^(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|6XL|S\/M|M\/L|L\/XL|XL\/XXL|L-XL|S-M|STD|STANDART|TEK|TEKEBAT)$/.test(compact)
}

function inferColorFromTitle(title: string): string | null {
  const parts = title.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const suffix = parts[parts.length - 1]
  if (!suffix || suffix.length > 40) return null
  const normalized = normalizeKey(suffix)
  const colorTerms = [
    'siyah',
    'beyaz',
    'seffaf',
    'transparan',
    'gri',
    'pembe',
    'kirmizi',
    'yesil',
    'mavi',
    'mor',
    'bej',
    'krem',
    'lacivert',
    'sari',
    'turuncu',
    'kahverengi',
    'altin',
    'gumus',
  ]
  return colorTerms.some(term => normalized.includes(term)) ? suffix : null
}

function expandVariantProducts(items: unknown): unknown[] {
  const products = asArray(items)
  const expanded: unknown[] = []

  for (const item of products) {
    if (!item || typeof item !== 'object') {
      expanded.push(item)
      continue
    }

    const product = item as Record<string, unknown>
    const variantsRoot = (product['variants'] ?? product['Variants']) as Record<string, unknown> | undefined
    const variants = asArray(variantsRoot?.['variant'] ?? variantsRoot?.['Variant']).filter(variant => variant && typeof variant === 'object')

    if (variants.length === 0) {
      expanded.push(product)
      continue
    }

    const baseId = str(product['id'] ?? product['ID'] ?? product['ProductId'] ?? product['productId'] ?? product['ProductCode'])
    const baseSku = str(product['productCode'] ?? product['ProductCode'] ?? product['sku'] ?? product['SKU'] ?? product['StockCode'] ?? product['stockCode'] ?? baseId)

    for (const rawVariant of variants) {
      const variant = rawVariant as Record<string, unknown>
      const optionAttributes: Record<string, string> = {}
      for (const index of [1, 2, 3]) {
        const name = variantName(variant, index)
        const value = variantValue(variant, index)
        if (name && value) optionAttributes[name] = value
      }

      const optionEntries = Object.entries(optionAttributes)
      if (
        optionEntries.length === 1
        && normalizeKey(optionEntries[0][0]) === 'renk'
        && looksLikeSize(optionEntries[0][1])
      ) {
        delete optionAttributes[optionEntries[0][0]]
        optionAttributes.Beden = optionEntries[0][1]
      }

      const optionSuffix = Object.values(optionAttributes).join('-').replace(/\s+/g, '')
      const variantBarcode = str(variant['barcode'] ?? variant['Barcode'] ?? variant['Barkod'])
      const variantSku = firstNonEmpty(
        variant['sku'],
        variant['SKU'],
        variant['VariantCode'],
        variant['stockCode'],
        variant['StockCode'],
        optionSuffix ? `${baseSku}-${optionSuffix}` : '',
        variantBarcode,
        baseSku
      )
      const variantId = firstNonEmpty(
        variant['id'],
        variant['ID'],
        variant['VaryasyonID'],
        variant['VariantCode'],
        variantBarcode ? `${baseId}-${variantBarcode}` : '',
        optionSuffix ? `${baseId}-${optionSuffix}` : ''
      )

      expanded.push({
        ...product,
        ...variant,
        id: variantId,
        productCode: variantSku,
        sku: variantSku,
        barcode: variantBarcode || product['barcode'],
        quantity: variant['quantity'] ?? variant['Quantity'] ?? variant['VariantQuantity'] ?? variant['stock'] ?? variant['Stock'] ?? product['quantity'] ?? product['Quantity'],
        price: variant['price'] ?? variant['Price'] ?? variant['VariantPrice'] ?? product['price'] ?? product['Price'],
        variants: undefined,
        Variants: undefined,
        variantParentId: baseId,
        variantParentSku: baseSku,
        variantAttributes: optionAttributes,
        ...optionAttributes,
      })
    }
  }

  return expanded
}

// â”€â”€â”€ PARSER SINIFI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class XMLParser {
  private readonly parser: FastXMLParser

  constructor() {
    this.parser = new FastXMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: true,
      removeNSPrefix: true,       // Google namespace temizleme
      isArray: (name) => {        // Bu elementler her zaman array
        return ['item', 'product', 'offer', 'entry', 'Product', 'Item', 'Urun', 'Secenek', 'variant', 'Resim', 'Ozellik'].includes(name)
      },
      htmlEntities: true,
      processEntities: {
        enabled: true,
        maxEntitySize: 10000,
        maxExpansionDepth: 10,
        maxTotalExpansions: 1000000,
        maxExpandedLength: 100000000,
      },
      trimValues: true,
    })
  }

  /**
   * XML string'i parse eder, normalize edilmiÅŸ Ã¼rÃ¼n listesi dÃ¶ndÃ¼rÃ¼r
   */
  async parse(xml: string, options: XMLParseOptions = {}): Promise<ParseResult> {
    const startTime = Date.now()
    const errors: ParseError[] = []

    if (!xml || xml.trim().length === 0) {
      return {
        products: [],
        meta: { totalNodes: 0, parsed: 0, failed: 0, durationMs: 0, feedType: 'UNKNOWN' },
        errors: [{ type: 'WARN', code: 'EMPTY_FEED', message: 'XML boÅŸ veya iÃ§erik yok' }],
      }
    }

    // Large <products><product> feeds must be parsed product-by-product.
    // Parsing the full XML into one JS object can exceed the heap on small cloud instances.
    if (Buffer.byteLength(xml, 'utf8') > STREAM_THRESHOLD_BYTES) {
      if (/<products[\s>]/i.test(xml) && /<product[\s>]/i.test(xml)) {
        return this.parseLargeProductBlocks(xml, options)
      }
      return this.parseStream(Readable.from([xml]), options)
    }

    const sanitized = sanitizeXml(xml)

    let parsed: Record<string, unknown>
    try {
      parsed = this.parser.parse(sanitized) as Record<string, unknown>
    } catch (e) {
      throw new XMLParseError(
        `XML parse hatasÄ±: ${e instanceof Error ? e.message : String(e)}`,
        'PARSE_FAILED',
        e
      )
    }

    const { nodes, feedType } = this.extractNodes(parsed)

    if (nodes.length === 0) {
      errors.push({ type: 'WARN', code: 'EMPTY_FEED', message: 'Feed\'de Ã¼rÃ¼n bulunamadÄ±' })
    }

    const products: ParsedProduct[] = []
    let failed = 0

    for (const node of nodes) {
      try {
        const product = this.normalizeNode(node as Record<string, unknown>, options)
        if (product) {
          products.push(product)
        } else {
          failed++
          errors.push({ type: 'WARN', code: 'NORMALIZE_SKIP', message: 'ÃœrÃ¼n normalize edilemedi', raw: node })
        }
      } catch (e) {
        failed++
        errors.push({ type: 'ERROR', code: 'NODE_PARSE_ERROR', message: String(e), raw: node })
      }
    }

    const finalizedProducts = finalizeProducts(products, options, errors)
    return {
      products: finalizedProducts,
      meta: {
        totalNodes: nodes.length,
        parsed: finalizedProducts.length,
        failed,
        durationMs: Date.now() - startTime,
        feedType,
      },
      errors,
    }
  }

  /**
   * 50MB+ dosyalar iÃ§in stream parse
   */
  async parseStream(stream: Readable, options: XMLParseOptions = {}): Promise<ParseResult> {
    const startTime = Date.now()
    const errors: ParseError[] = []
    const chunks: string[] = []
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    }

    const xml = chunks.join('')
    if (!xml || xml.trim().length === 0) {
      return {
        products: [],
        meta: { totalNodes: 0, parsed: 0, failed: 0, durationMs: 0, feedType: 'UNKNOWN' },
        errors: [{ type: 'WARN', code: 'EMPTY_FEED', message: 'XML boÅŸ veya iÃ§erik yok' }],
      }
    }

    const sanitized = sanitizeXml(xml)

    let parsed: Record<string, unknown>
    try {
      parsed = this.parser.parse(sanitized) as Record<string, unknown>
    } catch (e) {
      throw new XMLParseError(
        `XML parse hatasÄ±: ${e instanceof Error ? e.message : String(e)}`,
        'PARSE_FAILED',
        e
      )
    }

    const { nodes, feedType } = this.extractNodes(parsed)

    if (nodes.length === 0) {
      errors.push({ type: 'WARN', code: 'EMPTY_FEED', message: "Feed de urun bulunamadi" })
    }

    const products: ParsedProduct[] = []
    let failed = 0

    for (const node of nodes) {
      try {
        const product = this.normalizeNode(node as Record<string, unknown>, options)
        if (product) {
          products.push(product)
        } else {
          failed++
          errors.push({ type: 'WARN', code: 'NORMALIZE_SKIP', message: 'ÃœrÃ¼n normalize edilemedi', raw: node })
        }
      } catch (e) {
        failed++
        errors.push({ type: 'ERROR', code: 'NODE_PARSE_ERROR', message: String(e), raw: node })
      }
    }

    const finalizedProducts = finalizeProducts(products, options, errors)
    return {
      products: finalizedProducts,
      meta: {
        totalNodes: nodes.length,
        parsed: finalizedProducts.length,
        failed,
        durationMs: Date.now() - startTime,
        feedType,
      },
      errors,
    }
  }

  private async parseLargeProductBlocks(xml: string, options: XMLParseOptions = {}): Promise<ParseResult> {
    const startTime = Date.now()
    const errors: ParseError[] = []
    const products: ParsedProduct[] = []
    let totalNodes = 0
    let failed = 0
    const productRegex = /<product\b[^>]*>[\s\S]*?<\/product>/gi

    for (const match of xml.matchAll(productRegex)) {
      totalNodes++

      try {
        const blockXml = sanitizeXml(`<products>${match[0]}</products>`)
        const parsed = this.parser.parse(blockXml) as Record<string, unknown>
        const { nodes } = this.extractNodes(parsed)

        if (nodes.length === 0) {
          failed++
          errors.push({
            type: 'WARN',
            code: 'NORMALIZE_SKIP',
            message: `Urun normalize edilemedi: product block ${totalNodes}`,
          })
          continue
        }

        for (const node of nodes) {
          try {
            const product = this.normalizeNode(node as Record<string, unknown>, options)
            if (product) {
              products.push(product)
            } else {
              failed++
              errors.push({
                type: 'WARN',
                code: 'NORMALIZE_SKIP',
                message: `Urun normalize edilemedi: product block ${totalNodes}`,
              })
            }
          } catch (e) {
            failed++
            errors.push({
              type: 'ERROR',
              code: 'NODE_PARSE_ERROR',
              message: `Product block ${totalNodes}: ${e instanceof Error ? e.message : String(e)}`,
            })
          }
        }
      } catch (e) {
        failed++
        errors.push({
          type: 'ERROR',
          code: 'NODE_PARSE_ERROR',
          message: `Product block ${totalNodes}: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    }

    if (totalNodes === 0) {
      errors.push({ type: 'WARN', code: 'EMPTY_FEED', message: "Feed de urun bulunamadi" })
    }

    const finalizedProducts = finalizeProducts(products, options, errors)
    return {
      products: finalizedProducts,
      meta: {
        totalNodes,
        parsed: finalizedProducts.length,
        failed,
        durationMs: Date.now() - startTime,
        feedType: 'CUSTOM_PRODUCTS',
      },
      errors,
    }
  }

  /**
   * Parse edilmiÅŸ obje iÃ§inden Ã¼rÃ¼n node'larÄ±nÄ± Ã§Ä±karÄ±r
   * Desteklenen formatlar sÄ±rayla denenir
   */
  private extractNodes(
    parsed: Record<string, unknown>
  ): { nodes: unknown[]; feedType: ParseResult['meta']['feedType'] } {
    // 1. Google Shopping RSS: rss.channel.item[]
    const rss = parsed['rss'] as Record<string, unknown> | undefined
    if (rss?.['channel']) {
      const channel = rss['channel'] as Record<string, unknown>
      if (Array.isArray(channel['item'])) {
        return { nodes: channel['item'], feedType: 'RSS_SHOPPING' }
      }
    }

    // 2. Atom feed: feed.entry[]
    const feed = parsed['feed'] as Record<string, unknown> | undefined
    if (feed && Array.isArray(feed['entry'])) {
      return { nodes: feed['entry'], feedType: 'ATOM' }
    }

    // 3. <products><product>[]
    const products = parsed['products'] as Record<string, unknown> | undefined
    if (products?.['product']) {
      const items = products['product']
      return { nodes: expandVariantProducts(items), feedType: 'CUSTOM_PRODUCTS' }
    }

    // 4. <catalog><item>[]
    const catalog = parsed['catalog'] as Record<string, unknown> | undefined
    if (catalog?.['item']) {
      const items = catalog['item']
      return { nodes: Array.isArray(items) ? items : [items], feedType: 'CUSTOM_CATALOG' }
    }

    // 5. <items><product>[]
    const itemsRoot = parsed['items'] as Record<string, unknown> | undefined
    if (itemsRoot?.['product']) {
      const items = itemsRoot['product']
      return { nodes: expandVariantProducts(items), feedType: 'CUSTOM_ITEMS' }
    }

    // 6. <Urunler><Urun>[]
    const urunler = parsed['Urunler'] as Record<string, unknown> | undefined
    if (urunler?.['Urun']) {
      const items = urunler['Urun']
      return { nodes: expandTicimaxProducts(items), feedType: 'CUSTOM_PRODUCTS' }
    }

    // 7. <Root><Urunler><Urun>[]
    const root = parsed['Root'] as Record<string, unknown> | undefined
    const rootUrunler = root?.['Urunler'] as Record<string, unknown> | undefined
    if (rootUrunler?.['Urun']) {
      return { nodes: expandTicimaxProducts(rootUrunler['Urun']), feedType: 'CUSTOM_PRODUCTS' }
    }

    // 8. Root array fallback
    for (const val of Object.values(parsed)) {
      if (Array.isArray(val) && val.length > 0) {
        return { nodes: val, feedType: 'UNKNOWN' }
      }
    }

    return { nodes: [], feedType: 'UNKNOWN' }
  }

  /**
   * Ham XML node'unu ParsedProduct'a normalize eder
   */
  private normalizeNode(node: Record<string, unknown>, options: XMLParseOptions = {}): ParsedProduct | null {
    // ID
    const id = str(node['g:id'] ?? node['id'] ?? node['ID'] ?? node['ProductId'] ?? node['productId'] ?? node['ProductCode'] ?? node['product_id'] ?? node['VaryasyonID'] ?? node['UrunKartiID'] ?? node['UrunKodu'])
    if (!id) return null

    // Title
    const title = str(node['g:title'] ?? node['title'] ?? node['Title'] ?? node['TITLE'] ?? node['name'] ?? node['Name'] ?? node['ProductName'] ?? node['adi'] ?? node['Ad'] ?? node['UrunAdi'])
    if (!title) return null

    // SKU
    const sku = str(node['sku'] ?? node['SKU'] ?? node['StockCode'] ?? node['stockCode'] ?? node['productCode'] ?? node['ProductCode'] ?? node['stok_kodu'] ?? node['StokKodu'] ?? node['g:mpn'] ?? id)

    // Barcode
    const rawBarcode = str(node['barcode'] ?? node['Barcode'] ?? node['Barkod'] ?? node['g:gtin'] ?? node['gtin'] ?? node['EAN'])
    const barcode = rawBarcode && rawBarcode.length <= 20
      ? rawBarcode
      : generatedBarcode(options.generatedBarcodePrefix, sku)

    // Price
    const fiyat = node['fiyat'] as Record<string, unknown> | undefined
    const defaultPriceResult = firstPositivePrice(
      node['g:list_price'],
      node['listPrice'],
      node['ListPrice'],
      node['list_price'],
      node['g:price'],
      node['price'],
      node['sitePrice'],
      node['realPrice'],
      node['Price'],
      node['PRICE'],
      node['salePrice'],
      node['IndirimliFiyat'],
      node['BayiFiyat'],
      node['ToptanFiyat'],
      node['PerakendeFiyat'],
      node['SatisFiyati'],
      fiyat?.['bayi_fiyati'],
      fiyat?.['son_kullanici']
    )
    const priceResult = preferredPrice(node, options.preferredPriceFields) ?? defaultPriceResult
    if (!priceResult) return null

    // List Price
    const rawListPrice = node['g:list_price'] ?? node['listPrice'] ?? node['ListPrice'] ?? node['list_price'] ?? node['PerakendeFiyat'] ?? node['SatisFiyati'] ?? fiyat?.['son_kullanici']
    const listPriceResult = parseTurkishPrice(rawListPrice)

    // Stock
    const rawStock = node['stock'] ?? node['Stock'] ?? node['quantity'] ?? node['Quantity'] ?? node['stockCount'] ?? node['miktar'] ?? node['Stok'] ?? node['StokAdedi'] ?? node['ToplamStok']
    const stock = rawStock !== undefined ? parseInt(String(rawStock), 10) : 0

    // Currency
    const currency = str(node['currency'] ?? node['Currency'] ?? node['ParaBirimiKodu'] ?? node['ParaBirimi'] ?? fiyat?.['para_birimi'] ?? priceResult.currency).toUpperCase()
      .replace('TL', 'TRY') || DEFAULT_CURRENCY

    // Description
    const description = firstNonEmpty(
      node['g:description'],
      node['description'],
      node['Description'],
      node['DESCRIPTION'],
      node['detail'],
      node['aciklama'],
      node['Aciklama'],
      node['KisaAciklama'],
      node['OnYazi']
    ) || null

    // Brand
    const brand = str(node['g:brand'] ?? node['brand'] ?? node['Brand'] ?? node['BRAND'] ?? node['manufacturer'] ?? node['marka'] ?? node['Marka']) || null

    // Category
    const category = str(
      node['g:product_type'] ?? node['Categories'] ?? node['category'] ?? node['Category'] ?? node['categoryName'] ?? node['kategori'] ?? node['AnaKategori'] ?? node['KategoriTree'] ?? node['Kategori'] ?? node['g:google_product_category']
    ) || null

    // Images
    const images = extractImages(node)

    // Attributes
    const attributes = extractAttributes(node)
    if (!attributes.Renk && !attributes.renk && !attributes.Color && !attributes.color) {
      const titleColor = inferColorFromTitle(title)
      if (titleColor) {
        attributes.Renk = titleColor
        attributes.renk = titleColor
      }
    }

    // Content Hash
    const contentHash = generateContentHash(
      id,
      priceResult.price,
      stock,
      title,
      options.generatedBarcodePrefix ? barcode ?? '' : ''
    )

    return {
      id,
      sku,
      barcode,
      title,
      description,
      brand,
      category,
      price: priceResult.price,
      listPrice: listPriceResult?.price ?? null,
      currency,
      stock: isNaN(stock) ? 0 : stock,
      images,
      attributes,
      contentHash,
    }
  }
}

