// src/adapters/N11Adapter.ts

import { BaseAdapter, Product, PublishResult, AdapterConfig } from './BaseAdapter'
import { logger } from '../utils/logger'

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

export class N11Adapter extends BaseAdapter {
  private sellerNick: string

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
        timeout: 30000
      },
      'N11'
    )

    this.sellerNick = integrator
  }

  async authenticate(): Promise<void> {
    try {
      // N11 REST API uses Basic Auth or OAuth token
      // For demonstration, we'll use app key/secret in header
      this.client.defaults.headers.common['X-APP-KEY'] = this.appKey
      this.client.defaults.headers.common['X-APP-SECRET'] = this.appSecret

      logger.info('N11 adapter initialized')
    } catch (error) {
      throw new Error(`N11 initialization failed: ${error}`)
    }
  }

  async publishProduct(product: Product): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const payload = {
        product: {
          title: product.title,
          description: product.description,
          sku: product.sku,
          barcode: product.barcode,
          price: product.price,
          currency: 'TRY',
          quantity: product.stock,
          images: product.images,
          category: product.category || 'Genel'
        }
      }

      try {
        const response = await this.client.post('/rest/products', payload)

        return {
          success: response.status === 201,
          listingId: response.data?.productId,
          productId: product.id,
          message: 'Product published to N11'
        }
      } catch (error: any) {
        return {
          success: false,
          productId: product.id,
          message: 'Failed to publish product to N11',
          errors: [error?.response?.data?.message || error?.message]
        }
      }
    })
  }

  async getProduct(productId: string): Promise<Product> {
    return this.retry(async () => {
      await this.authenticate()

      const response = await this.client.get<N11Product>(`/rest/products/${productId}`)
      const data = response.data

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
        brand: data.brandName
      }
    })
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.patch(`/rest/products/${productId}`, {
          price: price,
          currency: 'TRY'
        })

        return {
          success: true,
          productId,
          message: 'Price updated on N11'
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
        await this.client.patch(`/rest/products/${productId}`, {
          quantity: stock
        })

        return {
          success: true,
          productId,
          message: 'Stock updated on N11'
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
        await this.client.delete(`/rest/products/${productId}`)

        return {
          success: true,
          productId,
          message: 'Product deleted from N11'
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
