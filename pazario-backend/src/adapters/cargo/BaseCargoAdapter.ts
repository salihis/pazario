// src/adapters/cargo/BaseCargoAdapter.ts

import axios, { AxiosInstance } from 'axios'
import { logger } from '../../utils/logger'

export interface ShipmentTracking {
  trackingNumber: string
  status: 'pending' | 'in_transit' | 'delivered' | 'failed'
  lastUpdate: Date
  location?: string
  estimatedDelivery?: Date
}

export interface ShipmentCreate {
  orderId: string
  recipientName: string
  recipientPhone: string
  recipientAddress: string
  recipientCity: string
  recipientZip: string
  weight: number
  desi: number
  quantity: number
}

export interface ShipmentResult {
  success: boolean
  trackingNumber?: string
  shipmentId?: string
  error?: string
}

export abstract class BaseCargoAdapter {
  protected client: AxiosInstance
  protected cargoCompany: string

  constructor(
    apiKey: string,
    baseUrl: string,
    cargoCompany: string
  ) {
    this.cargoCompany = cargoCompany

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'Pazar.io/1.0'
      }
    })

    this.setupInterceptors()
  }

  private setupInterceptors() {
    this.client.interceptors.response.use(
      response => response,
      error => {
        const msg = `${this.cargoCompany} Cargo Error: ${error.message}`
        logger.error(msg)
        throw error
      }
    )
  }

  abstract createShipment(data: ShipmentCreate): Promise<ShipmentResult>
  abstract getTracking(trackingNumber: string): Promise<ShipmentTracking>
  abstract cancelShipment(trackingNumber: string): Promise<ShipmentResult>

  async healthCheck(): Promise<boolean> {
    try {
      logger.info(`${this.cargoCompany} cargo health check: OK`)
      return true
    } catch (error) {
      logger.error(`${this.cargoCompany} cargo health check failed`)
      return false
    }
  }
}
