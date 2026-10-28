// src/queue/jobs.ts

export type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'

export interface SyncJobData {
  sourceId: string
  triggeredBy: 'cron' | 'manual'
  userId?: string
  operationId?: string
}

export interface PublishJobData {
  productId: string
  productIds?: string[]
  marketplace: Marketplace
  publishJobId?: string
  publishJobIds?: string[]
  syncJobId?: string
  force?: boolean
  operationId?: string
}

export interface CargoJobData {
  orderId: string
  action: 'create_label' | 'notify_marketplace' | 'check_status'
}

export interface OrderFetchJobData {
  marketplace: Marketplace | 'all'
  operationId?: string
}

export interface NotifyJobData {
  type: 'slack' | 'email'
  message: string
  level: 'info' | 'warn' | 'error'
}
