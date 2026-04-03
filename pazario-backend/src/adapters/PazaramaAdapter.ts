// src/adapters/PazaramaAdapter.ts

import { BaseAdapter, Product, PublishResult, AdapterConfig } from './BaseAdapter'
import { logger } from '../utils/logger'

export class PazaramaAdapter extends BaseAdapter {
  constructor(
    private clientId: string,
    private clientSecret: string
  ) {
    super(
      {
        apiKey: clientId,
        apiSecret: clientSecret,
        baseUrl: 'https://api.pazarama.com/v1',
        timeout: 30000
      },
      'PAZARAMA'
    )
  }

  async authenticate(): Promise<void> {
    try {
      this.client.defaults.headers.common['X-Client-Id'] = this.clientId
      this.client.defaults.headers.common['X-Client-Secret'] = this.clientSecret

      logger.info('Pazarama adapter initialized')
    } catch (error) {
      throw new Error(`Pazarama initialization failed: ${error}`)
    }
  }

  async publishProduct(product: Product): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const payload = {
        title: product.title,
        description: product.description,
        sku: product.sku,
        barcode: product.barcode,
        price: product.price,
        quantity: product.stock,
        imageUrls: product.images,
        categoryName: product.category
      }

      try {
        const response = await this.client.post('/products', payload)

        return {
          success: response.status === 201 || response.status === 200,
          listingId: response.data?.id,
          productId: product.id,
          message: 'Product published to Pazarama'
        }
      } catch (error: any) {
        return {
          success: false,
          productId: product.id,
          message: 'Failed to publish to Pazarama',
          errors: [error?.response?.data?.message || error?.message]
        }
      }
    })
  }

  async getProduct(productId: string): Promise<Product> {
    return this.retry(async () => {
      await this.authenticate()

      const response = await this.client.get(`/products/${productId}`)
      const data = response.data

      return {
        id: data.id,
        title: data.title,
        description: data.description,
        price: data.price,
        stock: data.quantity,
        sku: data.sku,
        barcode: data.barcode,
        images: data.imageUrls || [],
        category: data.categoryName
      }
    })
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.patch(`/products/${productId}`, {
          price: price
        })

        return {
          success: true,
          productId,
          message: 'Price updated on Pazarama'
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
        await this.client.patch(`/products/${productId}`, {
          quantity: stock
        })

        return {
          success: true,
          productId,
          message: 'Stock updated on Pazarama'
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
        await this.client.delete(`/products/${productId}`)

        return {
          success: true,
          productId,
          message: 'Product deleted from Pazarama'
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
