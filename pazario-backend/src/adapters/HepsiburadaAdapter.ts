// src/adapters/HepsiburadaAdapter.ts

import { BaseAdapter, Product, PublishResult } from './BaseAdapter'
import { transformMarketplaceProduct } from '../services/MarketplacePayloadTransform'
import { hepsiburadaListingApiUrl, hepsiburadaProductApiBaseUrl, hepsiburadaUserAgent } from '../config/hepsiburada'
import { openAsBlob } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type HepsiburadaImportStatus = {
  status?: string
  importStatus?: string
  trackingId?: string
  items?: unknown[]
  products?: unknown[]
  data?: unknown
}

type HepsiburadaListing = {
  listingId?: string
  hepsiburadaSku?: string
  merchantSku?: string
  price?: number
  availableStock?: number
  dispatchTime?: number
  maximumPurchasableQuantity?: number
}

type HepsiburadaListingUploadStatus = {
  id?: string
  status?: string
  total?: number
  errors?: unknown
  priceValidations?: unknown
}

export type HepsiburadaListingUpdate = {
  merchantSku: string
  hepsiburadaSku: string
  availableStock?: number
  price?: number
}

function extractAxiosMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosErr = error as Error & { response?: { data?: unknown; status?: number } }
    const data = axiosErr.response?.data
    const message = typeof data === 'string' ? data : data ? JSON.stringify(data) : error.message
    return axiosErr.response?.status ? `HTTP ${axiosErr.response.status}: ${message}` : message
  }
  return String(error)
}

function cleanSku(value: string): string {
  return value.toLocaleUpperCase('tr-TR').replace(/\s+/g, '')
}

function hepsiburadaDecimal(value: number): string {
  return value.toFixed(2).replace('.', ',')
}

function readTrackingId(data: unknown): string | undefined {
  const root = data as any
  const value = root?.trackingId
    ?? root?.data?.trackingId
    ?? root?.id
    ?? root?.data?.id
    ?? root?.result?.trackingId
  return value ? String(value) : undefined
}

function readListingUploadId(data: unknown): string | undefined {
  const root = data as any
  const value = root?.id ?? root?.data?.id ?? root?.uploadId ?? root?.data?.uploadId
  return value ? String(value) : undefined
}

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function productAttributes(product: Product & { marketplaceAttributes?: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }> }) {
  const attrs: Record<string, string | number> = {}
  for (const attr of product.marketplaceAttributes ?? []) {
    const key = String(attr.attributeId)
    const value = attr.customAttributeValue ?? attr.attributeValueId
    if (value !== undefined && value !== null && String(value).trim()) attrs[key] = value
  }
  return attrs
}

export class HepsiburadaAdapter extends BaseAdapter {
  constructor(
    private merchantId: string,
    private serviceKey: string,
    private username: string = merchantId,
    private password: string = serviceKey,
    private userAgent?: string
  ) {
    super(
      {
        apiKey: merchantId,
        apiSecret: serviceKey,
        baseUrl: hepsiburadaProductApiBaseUrl(),
        timeout: 60000,
      },
      'HEPSIBURADA'
    )
  }

  async authenticate(): Promise<void> {
    this.client.defaults.headers.common.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`
    this.client.defaults.headers.common['User-Agent'] = hepsiburadaUserAgent(this.userAgent)
    this.client.defaults.headers.common.Accept = 'application/json'
  }

  async publishProducts(products: Array<Product & { categoryId?: string; marketplaceAttributes?: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }> }>): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()
      const items = products.map(product => this.toImportItem(product))
      const filePath = await this.writeImportFile(items)
      const file = await openAsBlob(filePath, { type: 'application/json' })
      const form = new FormData()
      form.append('file', file, 'my_product.json')

      try {
        const response = await fetch(`${this.config.baseUrl}/products/import`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
            'User-Agent': hepsiburadaUserAgent(this.userAgent),
            Accept: 'application/json',
          },
          body: form,
        })
        const data = await response.json().catch(() => null)
        const trackingId = readTrackingId(data)
        return {
          success: response.ok,
          listingId: trackingId,
          productId: products[0]?.id ?? '',
          message: trackingId
            ? 'Hepsiburada urun importu kabul edildi.'
            : response.ok
              ? 'Hepsiburada urun importu kabul edildi ancak trackingId donmedi.'
              : 'Hepsiburada urun importu basarisiz',
          errors: response.ok ? undefined : [`HTTP ${response.status}: ${JSON.stringify(data)}`],
        }
      } catch (error: unknown) {
        return {
          success: false,
          productId: products[0]?.id ?? '',
          message: 'Hepsiburada urun importu basarisiz',
          errors: [extractAxiosMessage(error)],
        }
      } finally {
        await unlink(filePath).catch(() => undefined)
      }
    })
  }

  async publishProduct(product: Product & { categoryId?: string; marketplaceAttributes?: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }> }): Promise<PublishResult> {
    return this.publishProducts([product])
  }

  async getImportStatus(trackingId: string): Promise<HepsiburadaImportStatus> {
    await this.authenticate()
    const response = await fetch(`${this.config.baseUrl}/products/status/${encodeURIComponent(trackingId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
        'User-Agent': hepsiburadaUserAgent(this.userAgent),
        Accept: 'application/json',
      },
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
    }
    return data as HepsiburadaImportStatus
  }

  async listListings(offset = 0, limit = 10): Promise<{ listings: HepsiburadaListing[]; totalCount: number }> {
    const response = await fetch(hepsiburadaListingApiUrl(`/listings/merchantid/${encodeURIComponent(this.merchantId)}?offset=${offset}&limit=${limit}`), {
      method: 'GET',
      headers: this.listingHeaders(),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
    }
    const root = data as any
    return {
      listings: Array.isArray(root?.listings) ? root.listings : [],
      totalCount: Number(root?.totalCount ?? 0),
    }
  }

  async getListingUploadStatus(type: 'inventory' | 'stock' | 'price', uploadId: string): Promise<HepsiburadaListingUploadStatus> {
    const endpoint = this.listingUploadEndpoint(type)
    const response = await fetch(hepsiburadaListingApiUrl(`/listings/merchantid/${encodeURIComponent(this.merchantId)}/${endpoint}/id/${encodeURIComponent(uploadId)}`), {
      method: 'GET',
      headers: this.listingHeaders(),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
    }
    return data as HepsiburadaListingUploadStatus
  }

  async getProduct(productId: string): Promise<Product> {
    await this.authenticate()
    const response = await this.client.get('/products/products-by-merchant-and-status', {
      params: {
        merchantId: this.merchantId,
        productStatus: 'MATCHED',
        merchantSku: productId,
        page: 0,
        size: 1,
        version: 1,
      },
    })
    const root = response.data as any
    const item = root?.data?.[0] ?? root?.items?.[0] ?? root?.products?.[0] ?? root?.content?.[0] ?? root?.[0]
    if (!item) throw new Error('Hepsiburada urunu bulunamadi')

    return {
      id: String(item?.hbSku ?? item?.merchantSku ?? productId),
      title: String(item?.productName ?? item?.UrunAdi ?? ''),
      description: String(item?.productDescription ?? item?.UrunAciklamasi ?? ''),
      price: Number(item?.price ?? item?.salePrice ?? 0),
      stock: Number(item?.stock ?? item?.availableStock ?? 0),
      sku: String(item?.merchantSku ?? productId),
      barcode: item?.barcode ?? item?.Barcode,
      images: [],
      category: item?.categoryId ? String(item.categoryId) : undefined,
      brand: item?.brand ?? item?.Marka,
    }
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    const listing = await this.findListing(productId)
    return this.uploadListingUpdate('price', [{
      merchantSku: listing.merchantSku,
      hepsiburadaSku: listing.hepsiburadaSku,
      price: hepsiburadaDecimal(price),
    }], productId, 'Hepsiburada fiyat guncelleme istegi kabul edildi.')
  }

  async updateStock(productId: string, stock: number): Promise<PublishResult> {
    const listing = await this.findListing(productId)
    return this.uploadListingUpdate('stock', [{
      merchantSku: listing.merchantSku,
      hepsiburadaSku: listing.hepsiburadaSku,
      availableStock: Math.max(0, Math.floor(stock)),
    }], productId, 'Hepsiburada stok guncelleme istegi kabul edildi.')
  }

  async updateListings(
    items: HepsiburadaListingUpdate[],
    mode: 'stock' | 'price' | 'stock-price'
  ): Promise<string[]> {
    const uploadIds: string[] = []
    for (let index = 0; index < items.length; index += 1000) {
      const chunk = items.slice(index, index + 1000)

      if (mode !== 'price') {
        const stockResult = await this.uploadListingUpdate(
          'stock',
          chunk.map(item => ({
            merchantSku: item.merchantSku,
            hepsiburadaSku: item.hepsiburadaSku,
            availableStock: Math.max(0, Math.floor(item.availableStock ?? 0)),
          })),
          chunk[0]?.merchantSku ?? '',
          'Hepsiburada toplu stok guncelleme istegi kabul edildi.'
        )
        if (!stockResult.success || !stockResult.listingId) {
          throw new Error(stockResult.errors?.join(' | ') || 'Hepsiburada stok upload ID donmedi.')
        }
        uploadIds.push(stockResult.listingId)
      }

      if (mode !== 'stock') {
        const priceItems = chunk.filter(item => item.price !== undefined && item.price > 0)
        if (priceItems.length > 0) {
          const priceResult = await this.uploadListingUpdate(
            'price',
            priceItems.map(item => ({
              merchantSku: item.merchantSku,
              hepsiburadaSku: item.hepsiburadaSku,
              price: hepsiburadaDecimal(item.price!),
            })),
            priceItems[0]?.merchantSku ?? '',
            'Hepsiburada toplu fiyat guncelleme istegi kabul edildi.'
          )
          if (!priceResult.success || !priceResult.listingId) {
            throw new Error(priceResult.errors?.join(' | ') || 'Hepsiburada fiyat upload ID donmedi.')
          }
          uploadIds.push(priceResult.listingId)
        }
      }
    }
    return uploadIds
  }

  async deleteProduct(productId: string): Promise<PublishResult> {
    return {
      success: false,
      productId,
      message: 'Hepsiburada urun silme/pasife alma endpointi ayri dogrulama bekliyor.',
    }
  }

  private async writeImportFile(items: ReturnType<HepsiburadaAdapter['toImportItem']>[]) {
    const directory = join(tmpdir(), 'pazario-hepsiburada')
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, `my_product_${Date.now()}_${Math.random().toString(16).slice(2)}.json`)
    await writeFile(filePath, JSON.stringify(items), 'utf8')
    return filePath
  }

  private listingHeaders() {
    return {
      Authorization: basicAuth(this.username, this.password),
      'User-Agent': hepsiburadaUserAgent(this.userAgent),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
  }

  private listingUploadEndpoint(type: 'inventory' | 'stock' | 'price') {
    if (type === 'inventory') return 'inventory-uploads'
    if (type === 'stock') return 'stock-uploads'
    return 'price-uploads'
  }

  private async findListing(productId: string): Promise<Required<Pick<HepsiburadaListing, 'merchantSku' | 'hepsiburadaSku'>>> {
    const target = cleanSku(productId)
    for (let offset = 0; offset < 10_000; offset += 100) {
      const result = await this.listListings(offset, 100)
      const listing = result.listings.find(item =>
        cleanSku(String(item.merchantSku ?? '')) === target ||
        cleanSku(String(item.hepsiburadaSku ?? '')) === target
      )
      if (listing?.merchantSku && listing?.hepsiburadaSku) {
        return {
          merchantSku: listing.merchantSku,
          hepsiburadaSku: listing.hepsiburadaSku,
        }
      }
      if (result.listings.length === 0 || offset + result.listings.length >= result.totalCount) break
    }
    throw new Error(`Hepsiburada listing bulunamadi: ${productId}`)
  }

  private async uploadListingUpdate(
    type: 'inventory' | 'stock' | 'price',
    payload: Array<Record<string, unknown>>,
    productId: string,
    successMessage: string
  ): Promise<PublishResult> {
    const endpoint = this.listingUploadEndpoint(type)
    const response = await fetch(hepsiburadaListingApiUrl(`/listings/merchantid/${encodeURIComponent(this.merchantId)}/${endpoint}`), {
      method: 'POST',
      headers: this.listingHeaders(),
      body: JSON.stringify(payload),
    })
    const data = await response.json().catch(() => null)
    const uploadId = readListingUploadId(data)
    return {
      success: response.ok,
      listingId: uploadId,
      productId,
      message: response.ok ? successMessage : 'Hepsiburada listeleme guncelleme basarisiz',
      errors: response.ok ? undefined : [`HTTP ${response.status}: ${JSON.stringify(data)}`],
    }
  }

  private toImportItem(product: Product & { categoryId?: string; marketplaceAttributes?: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }> }) {
    const publishProduct = transformMarketplaceProduct(product)
    const images = publishProduct.images.slice(0, 5)
    const primaryImage = images[0]
    const attrs = {
      GarantiSuresi: 24,
      tax_vat_rate: '20',
      kg: '1',
      ...(primaryImage ? { '00000MU': primaryImage } : {}),
      ...Object.fromEntries(Object.entries(productAttributes(product)).filter(([key]) => !/^(Image\d+|Video\d+|00000MU)$/i.test(key))),
      merchantSku: cleanSku(publishProduct.sku),
      VaryantGroupID: cleanSku(publishProduct.productMainId || publishProduct.sku),
      Barcode: publishProduct.barcode,
      UrunAdi: publishProduct.title,
      UrunAciklamasi: publishProduct.description,
      Marka: publishProduct.brand || 'Pazario',
      price: hepsiburadaDecimal(publishProduct.price),
      stock: String(publishProduct.stock),
      ...Object.fromEntries(images.map((url, index) => [`Image${index + 1}`, url])),
      ...(publishProduct.videos?.[0] ? { Video1: publishProduct.videos[0] } : {}),
    }

    return {
      categoryId: Number(product.categoryId || publishProduct.category || 0),
      merchant: this.merchantId,
      attributes: attrs,
    }
  }
}
