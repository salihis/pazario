import axios from 'axios'
import { BaseAdapter, Product, PublishResult } from './BaseAdapter'
import { transformMarketplaceProduct } from '../services/MarketplacePayloadTransform'
import { logger } from '../utils/logger'

type PazaramaPublishProduct = Product & {
  categoryId?: string | number
  marketplaceAttributes?: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }>
}

interface PazaramaProductResponse {
  id?: string
  name?: string
  displayName?: string
  description?: string
  price?: number
  stockCount?: number
  stockCode?: string
  code?: string
  barcode?: string
  imageUrls?: string[]
  images?: string[]
  categoryName?: string
  brandName?: string
}

export type PazaramaBatchResult = {
  success?: boolean
  message?: string | null
  userMessage?: string | null
  data?: unknown
}

function extractAxiosMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosErr = error as Error & { response?: { data?: unknown } }
    const data = axiosErr.response?.data
    return typeof data === 'string' ? data : data ? JSON.stringify(data) : error.message
  }
  return String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function axiosStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined
  return (error as Error & { response?: { status?: number } }).response?.status
}

async function withPazaramaRateLimitRetry<T>(request: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await request()
    } catch (error) {
      lastError = error
      if (axiosStatus(error) !== 429 || attempt === attempts - 1) break
      await sleep((attempt + 1) * 10000)
    }
  }
  throw lastError
}

function extractToken(data: unknown): string {
  const payload = data as Record<string, unknown>
  const nested = payload?.data as Record<string, unknown> | undefined
  const token = payload?.access_token
    ?? payload?.accessToken
    ?? payload?.token
    ?? nested?.access_token
    ?? nested?.accessToken
    ?? nested?.token
  return typeof token === 'string' ? token : ''
}

function normalizeProducts(data: unknown): PazaramaProductResponse[] {
  const root = data as any
  const candidates = [
    root,
    root?.data,
    root?.data?.items,
    root?.data?.products,
    root?.items,
    root?.products,
    root?.result,
  ]
  for (const value of candidates) {
    if (Array.isArray(value)) return value
  }
  return []
}

function extractResponseErrors(data: unknown): string[] {
  const root = data as any
  const directCandidates = [
    root?.error,
    root?.data?.error,
    root?.result?.error,
  ]
  const candidates = [
    root?.errors,
    root?.data?.errors,
    root?.data?.error?.errors,
    root?.data?.items,
    root?.data?.products,
    root?.items,
    root?.products,
  ]
  const errors: string[] = []
  for (const candidate of directCandidates) {
    if (!candidate) continue
    if (typeof candidate === 'string') {
      errors.push(candidate)
      continue
    }
    if (candidate?.message) errors.push(String(candidate.message))
    if (candidate?.userMessage) errors.push(String(candidate.userMessage))
    if (candidate?.errorMessage) errors.push(String(candidate.errorMessage))
    if (Array.isArray(candidate?.errors)) errors.push(...candidate.errors.map(String))
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string') errors.push(item)
        else if (item?.message) errors.push(String(item.message))
        else if (item?.errorMessage) errors.push(String(item.errorMessage))
      }
    }
  }
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const item of candidate) {
      if (typeof item === 'string') errors.push(item)
      else if (item?.errorMessage) errors.push(String(item.errorMessage))
      else if (item?.message && (item?.success === false || item?.isSuccess === false)) errors.push(String(item.message))
      else if (Array.isArray(item?.errors)) errors.push(...item.errors.map(String))
    }
  }
  const message = root?.message ?? root?.userMessage ?? root?.data?.message ?? root?.data?.userMessage
  if (root?.success === false && message) errors.push(String(message))
  return Array.from(new Set(errors.filter(Boolean)))
}

function readNestedString(root: any, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current = root
    for (const key of path) current = current?.[key]
    if (current !== undefined && current !== null && String(current) !== '00000000-0000-0000-0000-000000000000') {
      const value = String(current).trim()
      if (value) return value
    }
  }
  return undefined
}

function extractPazaramaBatchId(data: unknown): string | undefined {
  const root = data as any
  return readNestedString(root, [
    ['batchRequestId'],
    ['batchId'],
    ['requestId'],
    ['id'],
    ['data', 'batchRequestId'],
    ['data', 'batchId'],
    ['data', 'requestId'],
    ['data', 'id'],
    ['result', 'batchRequestId'],
    ['result', 'batchId'],
    ['result', 'requestId'],
    ['result', 'id'],
    ['data', 'result', 'batchRequestId'],
    ['data', 'result', 'batchId'],
    ['data', 'result', 'requestId'],
    ['data', 'result', 'id'],
  ])
}

function summarizePazaramaResponse(data: unknown): string {
  const root = data as any
  const keys = root && typeof root === 'object' ? Object.keys(root).slice(0, 12) : []
  const dataKeys = root?.data && typeof root.data === 'object' ? Object.keys(root.data).slice(0, 12) : []
  const resultKeys = root?.result && typeof root.result === 'object' ? Object.keys(root.result).slice(0, 12) : []
  const rawBatchId = root?.batchRequestId
    ?? root?.data?.batchRequestId
    ?? root?.result?.batchRequestId
    ?? root?.data?.result?.batchRequestId
  const message = root?.userMessage ?? root?.message ?? root?.data?.userMessage ?? root?.data?.message ?? root?.result?.message
  const errors = extractResponseErrors(data).slice(0, 5)

  return [
    `keys=${keys.join(',') || '-'}`,
    dataKeys.length ? `dataKeys=${dataKeys.join(',')}` : '',
    resultKeys.length ? `resultKeys=${resultKeys.join(',')}` : '',
    rawBatchId !== undefined && rawBatchId !== null ? `batchRequestId=${String(rawBatchId).slice(0, 160) || '<empty>'}` : '',
    message ? `message=${String(message).slice(0, 300)}` : '',
    errors.length ? `errors=${errors.join(' | ').slice(0, 500)}` : '',
  ].filter(Boolean).join(' ; ')
}

function isAlreadyExistingProductMessage(message: string): boolean {
  const normalized = message.toLocaleLowerCase('tr-TR')
  return normalized.includes('ilgili satıcı için kaydı zaten mevcut')
    || normalized.includes('ilgili satici icin kaydi zaten mevcut')
    || normalized.includes('zaten mevcut')
}

function isDuplicateOperationMessage(message: string): boolean {
  const normalized = message.toLocaleLowerCase('tr-TR')
  return normalized.includes('tekrarlayan işlem') || normalized.includes('tekrarlayan islem')
}

function isAcceptedWithoutBatch(data: unknown, message: unknown, listingId: string | undefined, responseErrors: string[]): boolean {
  const root = data as any
  const normalizedMessage = String(message ?? '').toLocaleLowerCase('tr-TR')
  return !listingId
    && responseErrors.length === 0
    && root?.success !== false
    && normalizedMessage.includes('iletildi')
}

export class PazaramaAdapter extends BaseAdapter {
  private tokenCache: { token: string; expiresAt: number } | null = null

  constructor(
    private clientId: string,
    private clientSecret: string
  ) {
    super(
      {
        apiKey: clientId,
        apiSecret: clientSecret,
        baseUrl: 'https://isortagimapi.pazarama.com',
        timeout: 30000,
      },
      'PAZARAMA'
    )
  }

  async authenticate(): Promise<void> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      this.client.defaults.headers.common.Authorization = `Bearer ${this.tokenCache.token}`
      return
    }

    const attempts: Array<Record<string, string>> = [
      { grant_type: 'client_credentialsscope', scope: 'merchantgatewayapi.fullaccess' },
      { grant_type: 'client_credentials', scope: 'merchantgatewayapi.fullaccess' },
      { grant_type: 'client_credentials' },
    ]

    let lastMessage = 'Pazarama token alinamadi'
    for (const body of attempts) {
      try {
        const response = await axios.post(
          'https://isortagimgiris.pazarama.com/connect/token',
          new URLSearchParams(body).toString(),
          {
            auth: { username: this.clientId, password: this.clientSecret },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000,
          }
        )
        const token = extractToken(response.data)
        if (token) {
          this.tokenCache = { token, expiresAt: Date.now() + 55 * 60 * 1000 }
          this.client.defaults.headers.common.Authorization = `Bearer ${token}`
          return
        }
        lastMessage = 'Pazarama token cevabinda access token yok'
      } catch (error) {
        lastMessage = extractAxiosMessage(error)
      }
    }

    throw new Error(lastMessage)
  }

  async publishProduct(product: PazaramaPublishProduct): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()
      const publishPath = process.env.PZ_PRODUCT_CREATE_PATH || process.env.PZ_PRODUCT_CREATE_URL || '/product/create'

      const publishProduct = transformMarketplaceProduct(product)
      const categoryId = product.categoryId ?? product.category
      const brandId = process.env.PZ_BRAND_ID
      if (!brandId) {
        return {
          success: false,
          productId: product.id,
          message: 'Pazarama marka ID eksik',
          errors: ['PZ_BRAND_ID .env icinde tanimlanmali. Pazarama urun ekleme brandId ile calisiyor.'],
        }
      }

      const payload = {
        products: [
          {
            displayName: publishProduct.title,
            name: publishProduct.title,
            description: publishProduct.description || publishProduct.title,
            code: publishProduct.barcode,
            stockCode: publishProduct.sku,
            brandId,
            brandName: publishProduct.brand,
            categoryId,
            groupCode: publishProduct.productMainId || publishProduct.sku,
            salePrice: publishProduct.price,
            listPrice: publishProduct.price,
            stockCount: publishProduct.stock,
            vatRate: Number(process.env.PZ_VAT_RATE || process.env.TY_VAT_RATE || '20'),
            images: publishProduct.images.slice(0, 10).map((url, index) => ({ imageUrl: url, sortOrder: index })),
            attributes: (product.marketplaceAttributes ?? []).map(attr => ({
              attributeId: String(attr.attributeId),
              attributeValueId: attr.attributeValueId ? String(attr.attributeValueId) : attr.customAttributeValue,
            })),
            productSellerInfoImageUrl: '',
            productCommercialAdditionalInfo: { securityDescription: '' },
            productCommercials: [],
            securityDescriptionIdList: [],
          },
        ],
      }

      try {
        const response = await withPazaramaRateLimitRetry(() => this.client.post(publishPath, payload))
        const listingId = extractPazaramaBatchId(response.data)
        const responseErrors = extractResponseErrors(response.data)
        const responseSummary = summarizePazaramaResponse(response.data)
        const existingProductMessage = responseErrors.find(isAlreadyExistingProductMessage)
        const message = response.data?.userMessage || response.data?.message
        if (existingProductMessage) {
          return {
            success: true,
            listingId: publishProduct.barcode || publishProduct.sku,
            productId: product.id,
            message: `Pazarama urunu zaten mevcut, yayinda olarak eslestirildi: ${publishProduct.barcode || publishProduct.sku}`,
          }
        }
        const duplicateOperationMessage = responseErrors.find(isDuplicateOperationMessage)
        if (duplicateOperationMessage) {
          return {
            success: false,
            productId: product.id,
            message: 'Pazarama tekrarlayan islem reddi',
            errors: ['Pazarama ayni urun icin yakin zamanda gonderim aldigi icin tekrar islemi reddetti. Bir sure bekleyip tekrar deneyin.'],
          }
        }
        const success = response.data?.success !== false
          && response.status >= 200
          && response.status < 300
          && (Boolean(listingId) || isAcceptedWithoutBatch(response.data, message, listingId, responseErrors))
          && responseErrors.length === 0
        if (!listingId || responseErrors.length > 0) {
          logger.warn(
            { productId: product.id, sku: publishProduct.sku, barcode: publishProduct.barcode, responseSummary },
            'Pazarama urun ekleme cevabi batch id veya validasyon hatasi iceriyor'
          )
        }
        return {
          success,
          listingId,
          productId: product.id,
          message: listingId
            ? `Pazarama urun gonderimi kabul edildi: ${listingId}`
            : success
              ? 'Pazarama urun gonderimi kabul edildi, batchRequestId donmedi; pazaryeri onay sureci bekleniyor.'
              : message || 'Pazarama batchRequestId donmedi',
          errors: responseErrors.length > 0
            ? responseErrors
            : listingId || success ? undefined : [`Pazarama urun ekleme cevabinda batchRequestId yok. ${responseSummary}`],
        }
      } catch (error: unknown) {
        if (axiosStatus(error) === 429) {
          return {
            success: false,
            productId: product.id,
            message: 'Pazarama rate limit',
            errors: ['Pazarama API 429 rate limit dondu. Gonderim yavaslatildi; bir sure bekleyip daha kucuk paketle tekrar deneyin.'],
          }
        }
        return {
          success: false,
          productId: product.id,
          message: 'Pazarama urun gonderimi basarisiz',
          errors: [extractAxiosMessage(error)],
        }
      }
    }, 1)
  }

  async getBatchResult(batchRequestId: string): Promise<PazaramaBatchResult> {
    return this.retry(async () => {
      await this.authenticate()
      const response = await withPazaramaRateLimitRetry(() => this.client.get('/product/getProductBatchResult', {
        params: { BatchRequestId: batchRequestId },
      }))
      return response.data
    }, 1)
  }

  async getProduct(productId: string): Promise<Product> {
    return this.retry(async () => {
      await this.authenticate()

      const response = await this.client.get('/product/products', {
        params: { Code: productId, StockCode: productId, Size: 1, Page: 1 },
      })
      const data = normalizeProducts(response.data)[0]
      if (!data) throw new Error(`Pazarama urun bulunamadi: ${productId}`)

      return {
        id: String(data.id ?? data.code ?? productId),
        title: data.displayName || data.name || productId,
        description: data.description || data.displayName || data.name || productId,
        price: Number(data.price ?? 0),
        stock: Number(data.stockCount ?? 0),
        sku: data.stockCode || data.code || productId,
        barcode: data.barcode,
        images: data.imageUrls ?? data.images ?? [],
        category: data.categoryName,
        brand: data.brandName,
      }
    })
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return { success: false, productId, message: `Pazarama fiyat guncelleme endpointi henuz dogrulanmadi: ${price}` }
  }

  async updateStock(productId: string, stock: number): Promise<PublishResult> {
    return { success: false, productId, message: `Pazarama stok guncelleme endpointi henuz dogrulanmadi: ${stock}` }
  }

  async deleteProduct(productId: string): Promise<PublishResult> {
    return { success: false, productId, message: 'Pazarama urun silme bu adapterde etkin degil' }
  }
}
