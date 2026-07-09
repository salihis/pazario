// src/adapters/HepsiburadaAdapter.ts

import { BaseAdapter, Product, PublishResult } from './BaseAdapter'
import { logger } from '../utils/logger'
import { transformMarketplaceProduct } from '../services/MarketplacePayloadTransform'

interface HepsiburadaProductImage {
  url: string
  index: number
}

interface HepsiburadaProductResponse {
  productId: string
  productTitle: string
  productDescription: string
  sellingPrice: number
  stockQuantity: number
  productSku: string
  barcode: string
  productImages: HepsiburadaProductImage[]
  categoryId: number
}

/** Axios hata yanıtından mesaj çıkarır */
function extractAxiosMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosErr = error as Error & { response?: { data?: { message?: string } } }
    return axiosErr.response?.data?.message ?? error.message
  }
  return String(error)
}

export class HepsiburadaAdapter extends BaseAdapter {
  constructor(
    private merchantId: string,
    private serviceKey: string
  ) {
    super(
      {
        apiKey: merchantId,
        apiSecret: serviceKey,
        baseUrl: 'https://api.hepsiburada.com/api/v1',
        timeout: 30000,
      },
      'HEPSIBURADA'
    )
  }

  /** Hepsiburada auth header'larını ayarlar */
  async authenticate(): Promise<void> {
    try {
      this.client.defaults.headers.common['X-Merchant-Id'] = this.merchantId
      this.client.defaults.headers.common['X-Service-Key'] = this.serviceKey
      logger.info('Hepsiburada adapter initialized')
    } catch (error) {
      throw new Error(`Hepsiburada initialization failed: ${error}`)
    }
  }

  /** Ürünü Hepsiburada'ya yayımlar */
  async publishProduct(product: Product): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()
      const publishProduct = transformMarketplaceProduct(product)

      const payload = {
        productTitle: publishProduct.title,
        productDescription: publishProduct.description,
        productSku: publishProduct.sku,
        barcode: publishProduct.barcode,
        brand: publishProduct.brand,
        sellingPrice: publishProduct.price,
        stockQuantity: publishProduct.stock,
        productImages: publishProduct.images.map((url, idx) => ({ url, index: idx + 1 })),
        categoryId: parseInt(publishProduct.category || '0'),
      }

      try {
        const response = await this.client.post('/products', payload)
        return {
          success: response.status === 201 || response.status === 200,
          listingId: response.data?.productId,
          productId: product.id,
          message: 'Product published to Hepsiburada',
        }
      } catch (error: unknown) {
        return {
          success: false,
          productId: product.id,
          message: 'Failed to publish to Hepsiburada',
          errors: [extractAxiosMessage(error)],
        }
      }
    })
  }

  /** Hepsiburada'dan ürün getirir */
  async getProduct(productId: string): Promise<Product> {
    return this.retry(async () => {
      await this.authenticate()

      const response = await this.client.get<HepsiburadaProductResponse>(`/products/${productId}`)
      const data = response.data

      return {
        id: data.productId,
        title: data.productTitle,
        description: data.productDescription,
        price: data.sellingPrice,
        stock: data.stockQuantity,
        sku: data.productSku,
        barcode: data.barcode,
        images: data.productImages?.map((img) => img.url) ?? [],
        category: data.categoryId?.toString(),
      }
    })
  }

  /** Hepsiburada'da ürün fiyatını günceller */
  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.patch(`/products/${productId}`, { sellingPrice: price })
        return { success: true, productId, message: 'Price updated on Hepsiburada' }
      } catch (error: unknown) {
        return {
          success: false,
          productId,
          message: 'Failed to update price',
          errors: [extractAxiosMessage(error)],
        }
      }
    })
  }

  /** Hepsiburada'da ürün stok sayısını günceller */
  async updateStock(productId: string, stock: number): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.patch(`/products/${productId}`, { stockQuantity: stock })
        return { success: true, productId, message: 'Stock updated on Hepsiburada' }
      } catch (error: unknown) {
        return {
          success: false,
          productId,
          message: 'Failed to update stock',
          errors: [extractAxiosMessage(error)],
        }
      }
    })
  }

  /** Hepsiburada'dan ürünü siler */
  async deleteProduct(productId: string): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.delete(`/products/${productId}`)
        return { success: true, productId, message: 'Product deleted from Hepsiburada' }
      } catch (error: unknown) {
        return {
          success: false,
          productId,
          message: 'Failed to delete product',
          errors: [extractAxiosMessage(error)],
        }
      }
    })
  }
}
