import { BaseAdapter, Product, PublishResult } from './BaseAdapter'
import { transformMarketplaceProduct } from '../services/MarketplacePayloadTransform'

interface TrendyolBatchResponse {
  batchRequestId?: string
  id?: string
}

export interface TrendyolBatchResult {
  batchRequestId: string
  status: string
  items?: Array<{
    status?: string
    failureReasons?: string[]
  }>
  failedItemCount?: number
}

interface TrendyolImage {
  url: string
}

interface TrendyolAttribute {
  attributeId: string | number
  attributeValueId?: string | number
  customAttributeValue?: string
}

type TrendyolPublishProduct = Product & {
  categoryId?: string | number
  marketplaceAttributes?: TrendyolAttribute[]
}

function buildTrendyolProductPayload(product: TrendyolPublishProduct, includeStockAndPrice: boolean) {
  const publishProduct = transformMarketplaceProduct(product)
  const categoryId = Number(product.categoryId ?? product.category)
  if (!Number.isFinite(categoryId) || categoryId <= 0) {
    return {
      error: 'Onayli kategori eslesmesinde marketplaceCategoryId sayisal olmali.',
      payload: null,
    }
  }

  const brandId = requiredNumberEnv('TY_BRAND_ID')
  const cargoCompanyId = requiredNumberEnv('TY_CARGO_COMPANY_ID')
  const dimensionalWeight = Number(process.env.TY_DIMENSIONAL_WEIGHT || '1')
  const vatRate = Number(process.env.TY_VAT_RATE || '20')
  const stockCode = publishProduct.sku || publishProduct.id
  const productMainId = publishProduct.productMainId || stockCode
  const images: TrendyolImage[] = publishProduct.images.slice(0, 8).map(url => ({ url }))
  const item = {
    barcode: publishProduct.barcode,
    title: publishProduct.title.slice(0, 100),
    productMainId,
    brandId,
    categoryId,
    stockCode,
    dimensionalWeight,
    description: publishProduct.description || publishProduct.title,
    currencyType: 'TRY',
    vatRate,
    cargoCompanyId,
    images,
    attributes: (product.marketplaceAttributes ?? []).map(attr => ({
      attributeId: Number(attr.attributeId),
      attributeValueId: attr.attributeValueId ? Number(attr.attributeValueId) : undefined,
      customAttributeValue: attr.customAttributeValue,
    })).filter(attr => Number.isFinite(attr.attributeId) && (
      attr.attributeValueId === undefined || Number.isFinite(attr.attributeValueId)
    )),
    ...(includeStockAndPrice ? {
      quantity: publishProduct.stock,
      listPrice: publishProduct.price,
      salePrice: publishProduct.price,
    } : {}),
  }

  return { error: null, payload: { items: [item] } }
}

function buildTrendyolProductsPayload(products: TrendyolPublishProduct[], includeStockAndPrice: boolean) {
  const items = []
  for (const product of products) {
    const { payload, error } = buildTrendyolProductPayload(product, includeStockAndPrice)
    if (!payload) {
      return { error: `${product.sku || product.id}: ${error ?? 'Payload olusturulamadi'}`, payload: null }
    }
    items.push(payload.items[0])
  }
  return { error: null, payload: { items } }
}

function extractAxiosMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosErr = error as Error & { response?: { data?: unknown } }
    const data = axiosErr.response?.data
    return typeof data === 'string' ? data : data ? JSON.stringify(data) : error.message
  }
  return String(error)
}

function requiredNumberEnv(name: string): number {
  const value = Number(process.env[name])
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} .env icinde tanimli olmali`)
  }
  return value
}

export class TrendyolAdapter extends BaseAdapter {
  constructor(
    private apiKey: string,
    private apiSecret: string,
    private supplierId: string
  ) {
    super(
      {
        apiKey,
        apiSecret,
        baseUrl: 'https://apigw.trendyol.com/integration/product',
        timeout: 30000,
      },
      'TRENDYOL'
    )
  }

  async authenticate(): Promise<void> {
    const token = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64')
    this.client.defaults.headers.common.Authorization = `Basic ${token}`
    this.client.defaults.headers.common['User-Agent'] = `${this.supplierId} - SelfIntegration`
  }

  async publishProduct(product: TrendyolPublishProduct): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const { payload, error } = buildTrendyolProductPayload(product, true)
      if (!payload) {
        return {
          success: false,
          productId: product.id,
          message: 'Trendyol kategori ID eksik',
          errors: [error ?? 'Kategori ID eksik'],
        }
      }

      try {
        const response = await this.client.post<TrendyolBatchResponse>(
          `/sellers/${this.supplierId}/v2/products`,
          payload
        )
        const batchRequestId = response.data?.batchRequestId ?? response.data?.id
        return {
          success: Boolean(batchRequestId),
          listingId: batchRequestId,
          productId: product.id,
          message: batchRequestId
            ? `Trendyol batch olusturuldu: ${batchRequestId}`
            : 'Trendyol batch cevabinda id yok',
        }
      } catch (error: unknown) {
        return {
          success: false,
          productId: product.id,
          message: 'Trendyol urun gonderimi basarisiz',
          errors: [extractAxiosMessage(error)],
        }
      }
    }, 1)
  }

  async publishProducts(products: TrendyolPublishProduct[]): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const { payload, error } = buildTrendyolProductsPayload(products, true)
      const firstProduct = products[0]
      if (!payload || !firstProduct) {
        return {
          success: false,
          productId: firstProduct?.id ?? 'bulk',
          message: 'Trendyol kategori ID eksik',
          errors: [error ?? 'Kategori ID eksik'],
        }
      }

      try {
        const response = await this.client.post<TrendyolBatchResponse>(
          `/sellers/${this.supplierId}/v2/products`,
          payload
        )
        const batchRequestId = response.data?.batchRequestId ?? response.data?.id
        return {
          success: Boolean(batchRequestId),
          listingId: batchRequestId,
          productId: firstProduct.id,
          message: batchRequestId
            ? `Trendyol varyant batch olusturuldu: ${batchRequestId}`
            : 'Trendyol batch cevabinda id yok',
        }
      } catch (error: unknown) {
        return {
          success: false,
          productId: firstProduct.id,
          message: 'Trendyol varyant grup gonderimi basarisiz',
          errors: [extractAxiosMessage(error)],
        }
      }
    }, 1)
  }

  async updateProduct(product: TrendyolPublishProduct): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const { payload, error } = buildTrendyolProductPayload(product, false)
      if (!payload) {
        return {
          success: false,
          productId: product.id,
          message: 'Trendyol kategori ID eksik',
          errors: [error ?? 'Kategori ID eksik'],
        }
      }

      try {
        const response = await this.client.put<TrendyolBatchResponse>(
          `/sellers/${this.supplierId}/products`,
          payload
        )
        const batchRequestId = response.data?.batchRequestId ?? response.data?.id
        return {
          success: Boolean(batchRequestId),
          listingId: batchRequestId,
          productId: product.id,
          message: batchRequestId
            ? `Trendyol updateProduct batch olusturuldu: ${batchRequestId}`
            : 'Trendyol updateProduct cevabinda id yok',
        }
      } catch (error: unknown) {
        return {
          success: false,
          productId: product.id,
          message: 'Trendyol urun bilgisi guncelleme basarisiz',
          errors: [extractAxiosMessage(error)],
        }
      }
    }, 1)
  }

  async updateProducts(products: TrendyolPublishProduct[]): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const { payload, error } = buildTrendyolProductsPayload(products, false)
      const firstProduct = products[0]
      if (!payload || !firstProduct) {
        return {
          success: false,
          productId: firstProduct?.id ?? 'bulk',
          message: 'Trendyol kategori ID eksik',
          errors: [error ?? 'Kategori ID eksik'],
        }
      }

      try {
        const response = await this.client.put<TrendyolBatchResponse>(
          `/sellers/${this.supplierId}/products`,
          payload
        )
        const batchRequestId = response.data?.batchRequestId ?? response.data?.id
        return {
          success: Boolean(batchRequestId),
          listingId: batchRequestId,
          productId: firstProduct.id,
          message: batchRequestId
            ? `Trendyol varyant update batch olusturuldu: ${batchRequestId}`
            : 'Trendyol updateProduct cevabinda id yok',
        }
      } catch (error: unknown) {
        return {
          success: false,
          productId: firstProduct.id,
          message: 'Trendyol varyant grup guncelleme basarisiz',
          errors: [extractAxiosMessage(error)],
        }
      }
    }, 1)
  }

  async getProduct(productId: string): Promise<Product> {
    throw new Error(`Trendyol getProduct henuz bu adapterde kullanilmiyor: ${productId}`)
  }

  async getBatchRequestResult(batchRequestId: string): Promise<TrendyolBatchResult> {
    await this.authenticate()
    const response = await this.client.get<TrendyolBatchResult>(
      `/sellers/${this.supplierId}/products/batch-requests/${batchRequestId}`
    )
    return response.data
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return { success: false, productId, message: `Trendyol fiyat guncelleme bu adapterde ayri servisle yapiliyor: ${price}` }
  }

  async updateStock(productId: string, stock: number): Promise<PublishResult> {
    return { success: false, productId, message: `Trendyol stok guncelleme bu adapterde ayri servisle yapiliyor: ${stock}` }
  }

  async deleteProduct(productId: string): Promise<PublishResult> {
    return { success: false, productId, message: 'Trendyol urun silme bu adapterde etkin degil' }
  }
}
