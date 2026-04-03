// src/parser/XMLParser.ts

import { XMLParser as FastXMLParser } from 'fast-xml-parser'
import { createHash } from 'crypto'
import { Readable } from 'stream'

// ─── HATA SINIFI ─────────────────────────────────────────────────────────────

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

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

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

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const STREAM_THRESHOLD_BYTES = 50 * 1024 * 1024 // 50MB
const DEFAULT_CURRENCY = 'TRY'

// Türk fiyat formatı: "1.299,99 TL" veya "1299.99 TRY"
const TR_PRICE_REGEX = /^[\s]*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)[\s]*(TL|TRY|₺)?[\s]*$/i
const STANDARD_PRICE_REGEX = /^[\s]*([0-9]+(?:\.[0-9]{1,2})?)[\s]*(TL|TRY|USD|EUR|₺)?[\s]*$/i

// ─── YARDIMCI FONKSİYONLAR ───────────────────────────────────────────────────

/**
 * Türk fiyat formatını sayıya çevirir
 * "1.299,99 TL" → 1299.99
 * "1299.99 TRY" → 1299.99
 */
function parseTurkishPrice(raw: unknown): { price: number; currency: string } | null {
  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()

  // Türk formatı: nokta binlik ayraç, virgül ondalık
  const trMatch = str.match(/^([0-9]{1,3}(?:\.[0-9]{3})*),([0-9]{1,2})\s*(TL|TRY|₺)?$/i)
  if (trMatch) {
    const normalized = trMatch[1].replace(/\./g, '') + '.' + trMatch[2]
    return {
      price: parseFloat(normalized),
      currency: trMatch[3] ? 'TRY' : DEFAULT_CURRENCY,
    }
  }

  // Standart format: nokta ondalık
  const stdMatch = str.match(/^([0-9]+(?:\.[0-9]{1,2})?)\s*(TL|TRY|USD|EUR|₺)?$/i)
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

/**
 * MD5 hash üretir: id + price + stock + title
 */
function generateContentHash(id: string, price: number, stock: number, title: string): string {
  return createHash('md5')
    .update(`${id}|${price}|${stock}|${title}`)
    .digest('hex')
}

/**
 * XML string'ini temizler
 * - Null byte temizle
 * - Bare & → &amp;
 * - Encoding UTF-8 yap
 */
function sanitizeXml(xml: string): string {
  return xml
    .replace(/\x00/g, '')                                          // null byte
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);)/gi, '&amp;') // bare &
    .replace(/<\?xml[^?]*\?>/i, '<?xml version="1.0" encoding="UTF-8"?>')     // encoding
}

/**
 * Ham node'dan string değer çeker
 */
function str(val: unknown): string {
  if (val === null || val === undefined) return ''
  return String(val).trim()
}

/**
 * Ham node'dan image URL array'i çeker
 */
function extractImages(node: Record<string, unknown>): string[] {
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

  return []
}

/**
 * Ham node'dan attributes çıkarır
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
  return attrs
}

// ─── PARSER SINIFI ────────────────────────────────────────────────────────────

export class XMLParser {
  private readonly parser: FastXMLParser

  constructor() {
    this.parser = new FastXMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: true,
      removeNSPrefix: true,       // Google namespace temizleme
      isArray: (name) => {        // Bu elementler her zaman array
        return ['item', 'product', 'offer', 'entry', 'Product', 'Item'].includes(name)
      },
      htmlEntities: true,
      trimValues: true,
    })
  }

  /**
   * XML string'i parse eder, normalize edilmiş ürün listesi döndürür
   */
  async parse(xml: string): Promise<ParseResult> {
    const startTime = Date.now()
    const errors: ParseError[] = []

    if (!xml || xml.trim().length === 0) {
      return {
        products: [],
        meta: { totalNodes: 0, parsed: 0, failed: 0, durationMs: 0, feedType: 'UNKNOWN' },
        errors: [{ type: 'WARN', code: 'EMPTY_FEED', message: 'XML boş veya içerik yok' }],
      }
    }

    // 50MB üstü stream moduna geç
    if (Buffer.byteLength(xml, 'utf8') > STREAM_THRESHOLD_BYTES) {
      return this.parseStream(Readable.from([xml]))
    }

    const sanitized = sanitizeXml(xml)

    let parsed: Record<string, unknown>
    try {
      parsed = this.parser.parse(sanitized) as Record<string, unknown>
    } catch (e) {
      throw new XMLParseError(
        `XML parse hatası: ${e instanceof Error ? e.message : String(e)}`,
        'PARSE_FAILED',
        e
      )
    }

    const { nodes, feedType } = this.extractNodes(parsed)

    if (nodes.length === 0) {
      errors.push({ type: 'WARN', code: 'EMPTY_FEED', message: 'Feed\'de ürün bulunamadı' })
    }

    const products: ParsedProduct[] = []
    let failed = 0

    for (const node of nodes) {
      try {
        const product = this.normalizeNode(node as Record<string, unknown>)
        if (product) {
          products.push(product)
        } else {
          failed++
          errors.push({ type: 'WARN', code: 'NORMALIZE_SKIP', message: 'Ürün normalize edilemedi', raw: node })
        }
      } catch (e) {
        failed++
        errors.push({ type: 'ERROR', code: 'NODE_PARSE_ERROR', message: String(e), raw: node })
      }
    }

    return {
      products,
      meta: {
        totalNodes: nodes.length,
        parsed: products.length,
        failed,
        durationMs: Date.now() - startTime,
        feedType,
      },
      errors,
    }
  }

  /**
   * 50MB+ dosyalar için stream parse
   */
  async parseStream(stream: Readable): Promise<ParseResult> {
    const chunks: string[] = []
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    }
    return this.parse(chunks.join(''))
  }

  /**
   * Parse edilmiş obje içinden ürün node'larını çıkarır
   * Desteklenen formatlar sırayla denenir
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
      return { nodes: Array.isArray(items) ? items : [items], feedType: 'CUSTOM_PRODUCTS' }
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
      return { nodes: Array.isArray(items) ? items : [items], feedType: 'CUSTOM_ITEMS' }
    }

    // 6. Root array fallback
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
  private normalizeNode(node: Record<string, unknown>): ParsedProduct | null {
    // ID
    const id = str(node['g:id'] ?? node['id'] ?? node['ID'] ?? node['ProductId'] ?? node['productId'])
    if (!id) return null

    // Title
    const title = str(node['g:title'] ?? node['title'] ?? node['Title'] ?? node['TITLE'] ?? node['name'] ?? node['Name'])
    if (!title) return null

    // SKU
    const sku = str(node['sku'] ?? node['SKU'] ?? node['StockCode'] ?? node['stockCode'] ?? node['g:mpn'] ?? id)

    // Barcode
    const barcode = str(node['barcode'] ?? node['Barcode'] ?? node['g:gtin'] ?? node['gtin'] ?? node['EAN']) || null

    // Price
    const rawPrice = node['g:price'] ?? node['price'] ?? node['Price'] ?? node['PRICE'] ?? node['salePrice']
    const priceResult = parseTurkishPrice(rawPrice)
    if (!priceResult || priceResult.price <= 0) return null

    // List Price
    const rawListPrice = node['g:list_price'] ?? node['listPrice'] ?? node['ListPrice'] ?? node['list_price']
    const listPriceResult = parseTurkishPrice(rawListPrice)

    // Stock
    const rawStock = node['stock'] ?? node['Stock'] ?? node['quantity'] ?? node['Quantity'] ?? node['stockCount']
    const stock = rawStock !== undefined ? parseInt(String(rawStock), 10) : 0

    // Currency
    const currency = str(node['currency'] ?? node['Currency'] ?? priceResult.currency).toUpperCase()
      .replace('TL', 'TRY') || DEFAULT_CURRENCY

    // Description
    const description = str(
      node['g:description'] ?? node['description'] ?? node['Description'] ?? node['DESCRIPTION']
    ) || null

    // Brand
    const brand = str(node['g:brand'] ?? node['brand'] ?? node['Brand'] ?? node['BRAND'] ?? node['manufacturer']) || null

    // Category
    const category = str(
      node['g:product_type'] ?? node['category'] ?? node['Category'] ?? node['categoryName'] ?? node['g:google_product_category']
    ) || null

    // Images
    const images = extractImages(node)

    // Attributes
    const attributes = extractAttributes(node)

    // Content Hash
    const contentHash = generateContentHash(id, priceResult.price, stock, title)

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