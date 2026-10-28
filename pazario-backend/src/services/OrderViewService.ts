import { OrderStatus, Prisma } from '@prisma/client'

export const NEW_ORDER_WINDOW_MS = 24 * 60 * 60 * 1000

export const ORDER_TAB_STATUSES: Record<string, OrderStatus[]> = {
  NEW: ['NEW'],
  PREPARING: ['PENDING_APPROVAL', 'PREPARING', 'LABEL_CREATED'],
  SHIPPED: ['SHIPPED', 'IN_TRANSIT'],
  DELIVERED: ['DELIVERED', 'COMPLETED'],
  CANCELLED: [
    'DELIVERY_FAILED',
    'CANCELLATION_REQUESTED',
    'CANCELLED',
    'RETURN_REQUESTED',
    'RETURN_APPROVED',
    'RETURN_REJECTED',
    'REFUNDED',
  ],
}

export function orderTabWhere(status: string, now = new Date()): Prisma.OrderWhereInput {
  const statuses = ORDER_TAB_STATUSES[status]
  if (!statuses) return { status: status as OrderStatus }
  if (status === 'NEW') {
    const since = new Date(now.getTime() - NEW_ORDER_WINDOW_MS)
    return { OR: [
      { orderedAt: { gte: since } },
      { orderedAt: null, createdAt: { gte: since } },
    ] }
  }
  return { status: { in: statuses } }
}
