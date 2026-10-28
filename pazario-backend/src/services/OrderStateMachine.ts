// src/services/OrderStateMachine.ts

import { PrismaClient } from '@prisma/client'

// ─── HATA SINIFLARI ──────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Geçersiz durum geçişi: ${from} → ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

export class InsufficientStockError extends Error {
  constructor(productId: string, requested: number, available: number) {
    super(`Yetersiz stok: productId=${productId}, istenen=${requested}, mevcut=${available}`)
    this.name = 'InsufficientStockError'
  }
}

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'NEW'
  | 'PENDING_APPROVAL'
  | 'PREPARING'
  | 'LABEL_CREATED'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'DELIVERY_FAILED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLED'
  | 'RETURN_REQUESTED'
  | 'RETURN_APPROVED'
  | 'RETURN_REJECTED'
  | 'REFUNDED'

export interface TransitionOptions {
  changedBy: string
  note?: string
}

// ─── GEÇERLİ DURUM GEÇİŞLERİ ────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  NEW:                    ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL:       ['PREPARING', 'CANCELLED'],
  PREPARING:              ['LABEL_CREATED', 'CANCELLED'],
  LABEL_CREATED:          ['SHIPPED'],
  SHIPPED:                ['IN_TRANSIT'],
  IN_TRANSIT:             ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERED:              ['COMPLETED', 'RETURN_REQUESTED'],
  COMPLETED:              [],
  DELIVERY_FAILED:        ['SHIPPED', 'CANCELLED'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'PENDING_APPROVAL'],
  CANCELLED:              [],
  RETURN_REQUESTED:       ['RETURN_APPROVED', 'RETURN_REJECTED'],
  RETURN_APPROVED:        ['REFUNDED'],
  RETURN_REJECTED:        ['COMPLETED'],
  REFUNDED:               [],
}

export function findValidTransitionPath(from: OrderStatus, to: OrderStatus): OrderStatus[] | null {
  if (from === to) return []
  const queue: Array<{ status: OrderStatus; path: OrderStatus[] }> = [{ status: from, path: [] }]
  const visited = new Set<OrderStatus>([from])
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of VALID_TRANSITIONS[current.status] ?? []) {
      if (visited.has(next)) continue
      const path = [...current.path, next]
      if (next === to) return path
      visited.add(next)
      queue.push({ status: next, path })
    }
  }
  return null
}

// ─── DURUM MAKİNESİ ───────────────────────────────────────────────────────────

export class OrderStateMachine {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Durum geçişi yapar
   * SELECT FOR UPDATE ile race condition önlenir
   * Prisma transaction içinde çalışır
   */
  async transition(
    orderId: string,
    toStatus: OrderStatus,
    options: TransitionOptions
  ): Promise<void> {
    await this.transitionStep(orderId, toStatus, options, true)
  }

  async syncExternalStatus(orderId: string, toStatus: OrderStatus, marketplace: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } })
    if (!order) throw new Error(`Siparis bulunamadi: ${orderId}`)
    const path = findValidTransitionPath(order.status as OrderStatus, toStatus)
    if (path === null) throw new InvalidTransitionError(order.status, toStatus)
    for (const status of path) {
      await this.transitionStep(orderId, status, {
        changedBy: 'marketplace-sync',
        note: `${marketplace} harici durum yakalama senkronizasyonu`,
      }, false)
    }
  }

  private async transitionStep(
    orderId: string,
    toStatus: OrderStatus,
    options: TransitionOptions,
    triggerSideEffects: boolean
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // SELECT FOR UPDATE — eş zamanlı güncelleme engeli
      const orders = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
      `

      const order = orders[0]
      if (!order) throw new Error(`Sipariş bulunamadı: ${orderId}`)

      const fromStatus = order.status as OrderStatus

      // Geçiş validasyonu
      const allowed = VALID_TRANSITIONS[fromStatus] ?? []
      if (!allowed.includes(toStatus)) {
        throw new InvalidTransitionError(fromStatus, toStatus)
      }

      // Durumu güncelle
      await tx.order.update({
        where: { id: orderId },
        data: { status: toStatus },
      })

      // Log yaz
      await tx.orderStatusLog.create({
        data: {
          orderId,
          fromStatus,
          toStatus,
          changedBy: options.changedBy,
          note: options.note ?? null,
        },
      })

      // Yan etkileri tetikle
      if (triggerSideEffects) await this.triggerSideEffect(tx, toStatus, orderId)
    })
  }

  /**
   * Durum bazlı yan etkiler
   */
  private async triggerSideEffect(
    tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
    status: OrderStatus,
    orderId: string
  ): Promise<void> {
    switch (status) {
      case 'PREPARING': {
        // Stok düş
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: true },
        })
        if (order?.items) {
          for (const item of order.items) {
            if (item.productId) {
              await this.decreaseStock(tx, item.productId, item.quantity)
            }
          }
        }
        break
      }

      case 'CANCELLED':
      case 'REFUNDED': {
        // Stok geri ekle — sadece PREPARING sonrası iptal
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: true, statusLogs: { orderBy: { createdAt: 'asc' } } },
        })
        // PREPARING geçmişi var mı kontrol et
        const wasPreparing = order?.statusLogs.some(l => l.toStatus === 'PREPARING')
        if (wasPreparing && order?.items) {
          for (const item of order.items) {
            if (item.productId) {
              await this.increaseStock(tx, item.productId, item.quantity)
            }
          }
        }
        break
      }

      default:
        break
    }
  }

  /**
   * Stok düşür — SELECT FOR UPDATE ile kilitli
   */
  async decreaseStock(
    tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
    productId: string,
    quantity: number
  ): Promise<void> {
    const products = await tx.$queryRaw<{ id: string; stock: number }[]>`
      SELECT id, stock FROM products WHERE id = ${productId}::uuid FOR UPDATE
    `
    const product = products[0]
    if (!product) throw new Error(`Ürün bulunamadı: ${productId}`)

    if (product.stock - quantity < 0) {
      throw new InsufficientStockError(productId, quantity, product.stock)
    }

    await tx.product.update({
      where: { id: productId },
      data: { stock: { decrement: quantity } },
    })
  }

  /**
   * Stok geri ekle
   */
  async increaseStock(
    tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
    productId: string,
    quantity: number
  ): Promise<void> {
    await tx.product.update({
      where: { id: productId },
      data: { stock: { increment: quantity } },
    })
  }

  /**
   * Geçişin geçerli olup olmadığını kontrol eder
   */
  isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
    return (VALID_TRANSITIONS[from] ?? []).includes(to)
  }

  /**
   * Mevcut durumdan yapılabilecek geçişleri döndürür
   */
  getAvailableTransitions(from: OrderStatus): OrderStatus[] {
    return VALID_TRANSITIONS[from] ?? []
  }
}
