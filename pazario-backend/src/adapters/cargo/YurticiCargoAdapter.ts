// src/adapters/cargo/YurticiCargoAdapter.ts

import { BaseCargoAdapter, ShipmentCreate, ShipmentResult, ShipmentTracking } from './BaseCargoAdapter'

export class YurticiCargoAdapter extends BaseCargoAdapter {
  constructor(apiKey: string) {
    super(apiKey, 'https://api.yurticikargo.com/v1', 'YURTICI_KARGO')
  }

  /** Yurtiçi Kargo'da yeni kargo oluşturur */
  async createShipment(data: ShipmentCreate): Promise<ShipmentResult> {
    try {
      const response = await this.client.post('/consignments', {
        orderId: data.orderId,
        receiverName: data.recipientName,
        receiverPhone: data.recipientPhone,
        receiverAddress: data.recipientAddress,
        receiverCity: data.recipientCity,
        receiverPostalCode: data.recipientZip,
        weight: data.weight,
        desi: data.desi,
        pieceCount: data.quantity,
      })

      return {
        success: true,
        trackingNumber: response.data.trackingNumber,
        shipmentId: response.data.consignmentId,
      }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create shipment',
      }
    }
  }

  /** Yurtiçi Kargo takip bilgisini getirir */
  async getTracking(trackingNumber: string): Promise<ShipmentTracking> {
    const response = await this.client.get(`/consignments/${trackingNumber}/tracking`)

    return {
      trackingNumber,
      status: response.data.status,
      lastUpdate: new Date(response.data.lastStatusDate),
      location: response.data.lastLocation,
      estimatedDelivery: response.data.estimatedDeliveryDate
        ? new Date(response.data.estimatedDeliveryDate)
        : undefined,
    }
  }

  /** Yurtiçi Kargo gönderisini iptal eder */
  async cancelShipment(trackingNumber: string): Promise<ShipmentResult> {
    try {
      await this.client.post(`/consignments/${trackingNumber}/cancel`)
      return { success: true, trackingNumber }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel shipment',
      }
    }
  }
}
