// src/adapters/cargo/ArasCargoAdapter.ts

import { BaseCargoAdapter, ShipmentCreate, ShipmentResult, ShipmentTracking } from './BaseCargoAdapter'

export class ArasCargoAdapter extends BaseCargoAdapter {
  constructor(apiKey: string) {
    super(apiKey, 'https://api.arascargo.com.tr/v1', 'ARAS_KARGO')
  }

  /** Aras Kargo'da yeni kargo oluşturur */
  async createShipment(data: ShipmentCreate): Promise<ShipmentResult> {
    try {
      const response = await this.client.post('/shipments', {
        orderId: data.orderId,
        recipientName: data.recipientName,
        recipientPhone: data.recipientPhone,
        recipientAddress: data.recipientAddress,
        recipientCity: data.recipientCity,
        recipientZip: data.recipientZip,
        weight: data.weight,
        desi: data.desi,
        quantity: data.quantity,
      })

      return {
        success: true,
        trackingNumber: response.data.trackingNumber,
        shipmentId: response.data.id,
      }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create shipment',
      }
    }
  }

  /** Aras Kargo takip bilgisini getirir */
  async getTracking(trackingNumber: string): Promise<ShipmentTracking> {
    const response = await this.client.get(`/shipments/${trackingNumber}/tracking`)

    return {
      trackingNumber,
      status: response.data.status,
      lastUpdate: new Date(response.data.lastUpdate),
      location: response.data.location,
      estimatedDelivery: response.data.estimatedDelivery
        ? new Date(response.data.estimatedDelivery)
        : undefined,
    }
  }

  /** Aras Kargo gönderisini iptal eder */
  async cancelShipment(trackingNumber: string): Promise<ShipmentResult> {
    try {
      await this.client.post(`/shipments/${trackingNumber}/cancel`)
      return { success: true, trackingNumber }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel shipment',
      }
    }
  }
}
