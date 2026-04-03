// src/adapters/TrendyolAdapter.ts

import { BaseAdapter, Product, PublishResult, AdapterConfig } from './BaseAdapter'
import { logger } from '../utils/logger'

interface TrendyolAuthResponse {
  accessToken: string
  tokenType: string
  expiresIn: number
}

interface TrendyolProduct {
  productId: string
  title: string
  description: string
  price: number
  currencyCode: string
  stockCode: string
  stockQuantity: number
  barcode: string
  images: Array<{ url: string; rank: number }>
  categoryId: number
  brandId: number
}

export class TrendyolAdapter extends BaseAdapter {
  private accessToken: string = ''
  private tokenExpiresAt: number = 0

  constructor(
    private apiKey: string,
    private apiSecret: string,
    private supplierId: string
  ) {
    super(
      {
        apiKey: apiKey,
        apiSecret: apiSecret,
        baseUrl: 'https://api.trendyol.com/sapigw',
        timeout: 30000
      },
      'TRENDYOL'
    )
  }

  async authenticate(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return // Token still valid
    }

    try {
      const response = await this.client.post<TrendyolAuthResponse>('/v2/oauth/authorize', {
        apiKey: this.apiKey,
        apiSecret: this.apiSecret
      })

      this.accessToken = response.data.accessToken
      this.tokenExpiresAt = Date.now() + response.data.expiresIn * 1000

      this.client.defaults.headers.common['Authorization'] = `Bearer ${this.accessToken}`
      logger.info('Trendyol authentication successful')
    } catch (error) {
      throw new Error(`Trendyol authentication failed: ${error}`)
    }
  }

  async publishProduct(product: Product): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const payload = {
        productTitle: product.title,
        productDescription: product.description,
        productCode: product.sku,
        barcode: product.barcode,
        salePrice: product.price,
        currencyCode: 'TRY',
        stockCode: `${this.supplierId}-${product.id}`,
        quantity: product.stock,
        categoryId: 12345, // Map from product.category (example)
        images: product.images.map((url, idx) => ({
          url,
          rank: idx
        }))
      }

      try {
        const response = await this.client.post('/v2/products', payload)

        return {
          success: true,
          listingId: response.data.id,
          productId: product.id,
          message: 'Product published to Trendyol'
        }
      } catch (error: any) {
        return {
          success: false,
          productId: product.id,
          message: 'Failed to publish product to Trendyol',
          errors: [error?.response?.data?.message || error?.message]
        }
      }
    })
  }

  async getProduct(productId: string): Promise<Product> {
    return this.retry(async () => {
      await this.authenticate()

      const response = await this.client.get<TrendyolProduct>(`/v2/products/${productId}`)
      const data = response.data

      return {
        id: data.productId,
        title: data.title,
        description: data.description,
        price: data.price,
        stock: data.stockQuantity,
        sku: data.stockCode,
        barcode: data.barcode,
        images: data.images.map(img => img.url),
        category: data.categoryId.toString(),
        brand: data.brandId.toString()
      }
    })
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.put(`/v2/products/${productId}/price`, {
          salePrice: price,
          currencyCode: 'TRY'
        })

        return {
          success: true,
          productId,
          message: 'Price updated on Trendyol'
        }
      } catch (error: any) {
        return {
          success: false,
          productId,
          message: 'Failed to update price',
          errors: [error?.message]
        }
      }
    })
  }

  async updateStock(productId: string, stock: number): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.put(`/v2/products/${productId}/stock`, {
          quantity: stock
        })

        return {
          success: true,
          productId,
          message: 'Stock updated on Trendyol'
        }
      } catch (error: any) {
        return {
          success: false,
          productId,
          message: 'Failed to update stock',
          errors: [error?.message]
        }
      }
    })
  }

  async deleteProduct(productId: string): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.delete(`/v2/products/${productId}`)

        return {
          success: true,
          productId,
          message: 'Product deleted from Trendyol'
        }
      } catch (error: any) {
        return {
          success: false,
          productId,
          message: 'Failed to delete product',
          errors: [error?.message]
        }
      }
    })
  }
}
