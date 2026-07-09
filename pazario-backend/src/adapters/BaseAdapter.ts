// src/adapters/BaseAdapter.ts

import axios, { AxiosInstance, AxiosError } from 'axios'
import { logger } from '../utils/logger'

export interface Product {
  id: string
  title: string
  description: string
  price: number
  stock: number
  sku: string
  barcode?: string
  productMainId?: string
  images: string[]
  category?: string
  brand?: string
}

export interface PublishResult {
  success: boolean
  listingId?: string
  productId: string
  message: string
  errors?: string[]
}

export interface AdapterConfig {
  apiKey: string
  apiSecret?: string
  baseUrl: string
  timeout?: number
}

export abstract class BaseAdapter {
  protected client: AxiosInstance
  protected config: AdapterConfig
  protected marketplace: string

  constructor(config: AdapterConfig, marketplace: string) {
    this.config = config
    this.marketplace = marketplace

    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Pazar.io/1.0'
      }
    })

    this.setupInterceptors()
  }

  private setupInterceptors() {
    this.client.interceptors.response.use(
      response => response,
      (error: AxiosError) => {
        const msg = `${this.marketplace} API Error: ${error.message}`
        logger.error(msg)
        throw error
      }
    )
  }

  abstract authenticate(): Promise<void>
  abstract publishProduct(product: Product): Promise<PublishResult>
  abstract getProduct(productId: string): Promise<Product>
  abstract updatePrice(productId: string, price: number): Promise<PublishResult>
  abstract updateStock(productId: string, stock: number): Promise<PublishResult>
  abstract deleteProduct(productId: string): Promise<PublishResult>

  protected async retry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const delay = baseDelay * Math.pow(2, i)

        if (i < maxRetries - 1) {
          logger.warn(`Retrying ${this.marketplace} (attempt ${i + 2}/${maxRetries}) after ${delay}ms`)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.authenticate()
      logger.info(`${this.marketplace} health check: OK`)
      return true
    } catch (error) {
      logger.error(`${this.marketplace} health check failed`)
      return false
    }
  }
}
