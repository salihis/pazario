import { BaseAdapter, Product, PublishResult } from './BaseAdapter'
import { logger } from '../utils/logger'
import { transformMarketplaceProduct } from '../services/MarketplacePayloadTransform'

type N11PublishProduct = Product & {
  categoryId?: string | number
  marketplaceAttributes?: Array<{ attributeId: string | number; attributeValueId?: string | number; customAttributeValue?: string }>
}

interface N11Product {
  productId: string
  productName: string
  productDesc: string
  price: number
  currencyCode: string
  stockCode: string
  stockQuantity: number
  barcode: string
  images: string[]
  categoryId: string
  brandName: string
}

export type N11TaskSkuStatus = {
  itemCode?: string
  stockCode?: string
  status?: string
  reasons?: string[]
  sku?: { reasons?: string[] }
}

export type N11TaskDetail = {
  taskId: number | string
  status?: string
  skus?: {
    content?: N11TaskSkuStatus[]
  }
}

function extractAxiosMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosErr = error as Error & { response?: { data?: unknown } }
    const data = axiosErr.response?.data
    const status = axiosErr.response && 'status' in axiosErr.response ? `HTTP ${axiosErr.response.status}` : ''
    const detail = typeof data === 'string' ? data : data ? JSON.stringify(data) : error.message
    return [status, detail].filter(Boolean).join(' - ')
  }
  return String(error)
}

function extractReasons(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const data = value as { reasons?: unknown; message?: unknown; error?: unknown }
  const reasons = Array.isArray(data.reasons) ? data.reasons.map(String).filter(Boolean) : []
  const message = typeof data.message === 'string' ? [data.message] : []
  const error = typeof data.error === 'string' ? [data.error] : []
  return [...reasons, ...message, ...error]
}

export class N11Adapter extends BaseAdapter {
  constructor(
    private appKey: string,
    private appSecret: string,
    private integrator: string = 'PazarioIntegration'
  ) {
    super(
      {
        apiKey: appKey,
        apiSecret: appSecret,
        baseUrl: 'https://api.n11.com',
        timeout: 30000,
      },
      'N11'
    )
  }

  async authenticate(): Promise<void> {
    try {
      this.client.defaults.headers.common.appkey = this.appKey
      this.client.defaults.headers.common.appsecret = this.appSecret
      logger.info('N11 adapter initialized')
    } catch (error) {
      throw new Error(`N11 initialization failed: ${error}`)
    }
  }

  async publishProduct(product: N11PublishProduct): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()
      const publishProduct = transformMarketplaceProduct(product)
      const categoryId = Number(product.categoryId ?? product.category)
      if (!Number.isFinite(categoryId) || categoryId <= 0) {
        return {
          success: false,
          productId: product.id,
          message: 'N11 kategori ID eksik',
          errors: ['Onayli kategori eslesmesinde marketplaceCategoryId sayisal olmali.'],
        }
      }

      const preparingDay = Number(process.env.N11_PREPARING_DAY || '3')
      const shipmentTemplate = process.env.N11_SHIPMENT_TEMPLATE || '1'
      const vatRate = Number(process.env.N11_VAT_RATE || process.env.TY_VAT_RATE || '20')
      const stockCode = publishProduct.sku || publishProduct.id
      const productMainId = publishProduct.productMainId || stockCode

      const payload = {
        payload: {
          integrator: this.integrator,
          skus: [
            {
              title: publishProduct.title,
              description: publishProduct.description || publishProduct.title,
              categoryId,
              currencyType: 'TL',
              productMainId,
              preparingDay,
              shipmentTemplate,
              stockCode,
              catalogId: null,
              barcode: publishProduct.barcode || null,
              quantity: publishProduct.stock,
              images: publishProduct.images.slice(0, 8).map((url, index) => ({ url, order: index })),
              attributes: (product.marketplaceAttributes ?? []).map(attr => ({
                id: Number(attr.attributeId),
                valueId: attr.attributeValueId ? Number(attr.attributeValueId) : null,
                customValue: attr.customAttributeValue ?? null,
              })).filter(attr => Number.isFinite(attr.id) && (attr.valueId === null || Number.isFinite(attr.valueId))),
              salePrice: publishProduct.price,
              listPrice: publishProduct.price,
              vatRate,
            },
          ],
        },
      }

      try {
        const response = await this.client.post('/ms/product/tasks/product-create', payload)
        const taskId = response.data?.id ? String(response.data.id) : undefined
        const reasons = extractReasons(response.data)
        if (String(response.data?.status ?? '').toUpperCase() === 'REJECT') {
          return {
            success: false,
            productId: product.id,
            message: 'N11 urun gonderimi reddedildi',
            errors: reasons.length > 0 ? reasons : ['N11 product-create REJECT dondu.'],
          }
        }
        if (!taskId) {
          return {
            success: false,
            productId: product.id,
            message: 'N11 task ID donmedi',
            errors: reasons.length > 0 ? reasons : [JSON.stringify(response.data ?? {})],
          }
        }
        return {
          success: true,
          listingId: taskId,
          productId: product.id,
          message: `N11 product-create task olusturuldu: ${taskId}`,
        }
      } catch (error: unknown) {
        const detail = extractAxiosMessage(error)
        return {
          success: false,
          productId: product.id,
          message: 'N11 urun gonderimi basarisiz',
          errors: [`${stockCode}: ${detail}`],
        }
      }
    }, 1)
  }

  async getTaskDetail(taskId: string | number): Promise<N11TaskDetail> {
    return this.retry(async () => {
      await this.authenticate()
      const numericTaskId = Number(taskId)
      const response = await this.client.post<N11TaskDetail>(
        '/ms/product/task-details/page-query',
        {
          taskId: Number.isFinite(numericTaskId) ? numericTaskId : taskId,
          pageable: { page: 0, size: 1000 },
        }
      )
      return response.data
    }, 1)
  }

  async getProduct(productId: string): Promise<Product> {
    return this.retry(async () => {
      await this.authenticate()

      const response = await this.client.get<N11Product | { content?: N11Product[] }>(
        '/ms/product-query',
        { params: { id: productId } }
      )
      const data = Array.isArray((response.data as { content?: N11Product[] }).content)
        ? (response.data as { content: N11Product[] }).content[0]
        : response.data as N11Product
      if (!data) throw new Error(`N11 urun bulunamadi: ${productId}`)

      return {
        id: data.productId,
        title: data.productName,
        description: data.productDesc,
        price: data.price,
        stock: data.stockQuantity,
        sku: data.stockCode,
        barcode: data.barcode,
        images: data.images,
        category: data.categoryId,
        brand: data.brandName,
      }
    })
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return { success: false, productId, message: `N11 fiyat guncelleme marketplace controller ile yapiliyor: ${price}` }
  }

  async updateStock(productId: string, stock: number): Promise<PublishResult> {
    return { success: false, productId, message: `N11 stok guncelleme marketplace controller ile yapiliyor: ${stock}` }
  }

  async deleteProduct(productId: string): Promise<PublishResult> {
    return { success: false, productId, message: 'N11 urun silme bu adapterde etkin degil' }
  }
}
