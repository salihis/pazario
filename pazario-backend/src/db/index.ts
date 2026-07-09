// src/db/index.ts

import { PrismaClient } from '@prisma/client'
import { InvalidTransitionError } from '../services/OrderStateMachine'

// ─── GEÇERLİ DURUM GEÇİŞLERİ ────────────────────────────────────────────────

/**
 * NEW→SHIPPED, NEW→COMPLETED gibi yasak doğrudan geçişleri tanımlar.
 * OrderStateMachine içindeki tam geçiş haritasıyla tutarlı.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
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

// ─── PRİSMA CLIENT ───────────────────────────────────────────────────────────

/** Uygulama genelinde paylaşılan tek Prisma client örneği */
export const prisma = new PrismaClient()

/**
 * Order.update çağrılarında status geçişini otomatik olarak doğrular.
 * Geçersiz status geçişinde InvalidTransitionError fırlatır.
 * NOT: OrderStateMachine.transition() SELECT FOR UPDATE kullanır;
 * bu middleware sade update çağrılarına karşı ek güvencedir.
 */
prisma.$use(async (params, next) => {
  if (params.model === 'Order' && params.action === 'update') {
    const newStatus: string | undefined = params.args?.data?.status

    if (newStatus) {
      // Mevcut durumu DB'den çek
      const current = await prisma.order.findUnique({
        where: params.args.where,
        select: { status: true },
      })

      if (current) {
        const fromStatus = current.status as string
        const allowed = VALID_TRANSITIONS[fromStatus] ?? []

        if (!allowed.includes(newStatus)) {
          throw new InvalidTransitionError(fromStatus, newStatus)
        }
      }
    }
  }

  return next(params)
})
