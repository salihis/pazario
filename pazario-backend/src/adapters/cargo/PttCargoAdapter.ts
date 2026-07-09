// src/adapters/cargo/PttCargoAdapter.ts

import { BaseCargoAdapter, ShipmentCreate, ShipmentResult, ShipmentTracking } from './BaseCargoAdapter'

export class PttCargoAdapter extends BaseCargoAdapter {
  constructor(apiKey: string) {
    super(apiKey, 'https://api.ptt.gov.tr/cargo/v1', 'PTT_KARGO')
  }

  /** PTT Kargo'da yeni kargo oluşturur */
  async createShipment(data: ShipmentCreate): Promise<ShipmentResult> {
    try {
      const response = await this.client.post('/shipments', {
        orderId: data.orderId,
        recipientName: data.recipientName,
        recipientPhone: data.recipientPhone,
        recipientFullAddress: data.recipientAddress,
        recipientCity: data.recipientCity,
        recipientPostalCode: data.recipientZip,
        weight: data.weight,
        desi: data.desi,
        itemCount: data.quantity,
      })

      return {
        success: true,
        trackingNumber: response.data.trackingNumber,
        shipmentId: response.data.shipmentId,
      }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create shipment',
      }
    }
  }

  /** PTT Kargo takip bilgisini getirir */
  async getTracking(trackingNumber: string): Promise<ShipmentTracking> {
    const response = await this.client.get(`/shipments/${trackingNumber}/track`)

    return {
      trackingNumber,
      status: response.data.status,
      lastUpdate: new Date(response.data.lastStatusTime),
      location: response.data.currentLocation,
      estimatedDelivery: response.data.estimatedDeliveryDate
        ? new Date(response.data.estimatedDeliveryDate)
        : undefined,
    }
  }

  /** PTT Kargo gönderisini iptal eder */
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
