// src/adapters/cargo/SuratCargoAdapter.ts

import { BaseCargoAdapter, ShipmentCreate, ShipmentResult, ShipmentTracking } from './BaseCargoAdapter'

export class SuratCargoAdapter extends BaseCargoAdapter {
  constructor(apiKey: string) {
    super(apiKey, 'https://api.suratkargi.com.tr/v2', 'SURAT_KARGO')
  }

  /** Sürat Kargo'da yeni kargo oluşturur */
  async createShipment(data: ShipmentCreate): Promise<ShipmentResult> {
    try {
      const response = await this.client.post('/shipments', {
        orderId: data.orderId,
        deliveryName: data.recipientName,
        deliveryPhone: data.recipientPhone,
        deliveryAddress: data.recipientAddress,
        deliveryCity: data.recipientCity,
        deliveryPostCode: data.recipientZip,
        weight: data.weight,
        desi: data.desi,
        packageCount: data.quantity,
      })

      return {
        success: true,
        trackingNumber: response.data.trackingNo,
        shipmentId: response.data.shipmentId,
      }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create shipment',
      }
    }
  }

  /** Sürat Kargo takip bilgisini getirir */
  async getTracking(trackingNumber: string): Promise<ShipmentTracking> {
    const response = await this.client.get(`/shipments/${trackingNumber}`)

    return {
      trackingNumber,
      status: response.data.status,
      lastUpdate: new Date(response.data.lastUpdate),
      location: response.data.currentLocation,
      estimatedDelivery: response.data.estimatedDelivery
        ? new Date(response.data.estimatedDelivery)
        : undefined,
    }
  }

  /** Sürat Kargo gönderisini iptal eder */
  async cancelShipment(trackingNumber: string): Promise<ShipmentResult> {
    try {
      await this.client.delete(`/shipments/${trackingNumber}`)
      return { success: true, trackingNumber }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel shipment',
      }
    }
  }
}
