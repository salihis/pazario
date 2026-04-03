// src/adapters/HepsiburadaAdapter.ts

import { BaseAdapter, Product, PublishResult, AdapterConfig } from './BaseAdapter'
import { logger } from '../utils/logger'

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
        timeout: 30000
      },
      'HEPSIBURADA'
    )
  }

  async authenticate(): Promise<void> {
    try {
      this.client.defaults.headers.common['X-Merchant-Id'] = this.merchantId
      this.client.defaults.headers.common['X-Service-Key'] = this.serviceKey

      logger.info('Hepsiburada adapter initialized')
    } catch (error) {
      throw new Error(`Hepsiburada initialization failed: ${error}`)
    }
  }

  async publishProduct(product: Product): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      const payload = {
        productTitle: product.title,
        productDescription: product.description,
        productSku: product.sku,
        barcode: product.barcode,
        sellingPrice: product.price,
        stockQuantity: product.stock,
        productImages: product.images.map((url, idx) => ({
          url,
          index: idx + 1
        })),
        categoryId: parseInt(product.category || '0')
      }

      try {
        const response = await this.client.post('/products', payload)

        return {
          success: response.status === 201 || response.status === 200,
          listingId: response.data?.productId,
          productId: product.id,
          message: 'Product published to Hepsiburada'
        }
      } catch (error: any) {
        return {
          success: false,
          productId: product.id,
          message: 'Failed to publish to Hepsiburada',
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
        id: data.productId,
        title: data.productTitle,
        description: data.productDescription,
        price: data.sellingPrice,
        stock: data.stockQuantity,
        sku: data.productSku,
        barcode: data.barcode,
        images: data.productImages?.map((img: any) => img.url) || [],
        category: data.categoryId?.toString()
      }
    })
  }

  async updatePrice(productId: string, price: number): Promise<PublishResult> {
    return this.retry(async () => {
      await this.authenticate()

      try {
        await this.client.patch(`/products/${productId}`, {
          sellingPrice: price
        })

        return {
          success: true,
          productId,
          message: 'Price updated on Hepsiburada'
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
          stockQuantity: stock
        })

        return {
          success: true,
          productId,
          message: 'Stock updated on Hepsiburada'
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
          message: 'Product deleted from Hepsiburada'
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
