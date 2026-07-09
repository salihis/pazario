// src/api/controllers/order.controller.ts

import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { OrderStateMachine } from '../../services/OrderStateMachine'
import { OrderFetchService } from '../../services/OrderFetchService'
import { EmailService } from '../../services/EmailService'
import { logger } from '../../utils/logger'

const prisma = new PrismaClient()
const stateMachine = new OrderStateMachine(prisma)
const fetchService = new OrderFetchService(prisma)
const emailService = new EmailService()

function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '****'
  return `${digits.slice(0, 2)}**-***-**${digits.slice(-2)}`
}

function prepareOrderForResponse(order: Record<string, unknown>) {
  try {
    const decrypted = fetchService.decryptOrderFields(order as {
      customerName: string | null
      customerPhone: string | null
      shippingAddress: unknown
      billingAddress: unknown
    })
    return {
      ...order,
      customerName: decrypted.customerName,
      customerPhone: maskPhone(decrypted.customerPhone),
      shippingAddress: decrypted.shippingAddress,
      billingAddress: decrypted.billingAddress,
    }
  } catch {
    return { ...order, customerName: '***', customerPhone: '***' }
  }
}

export async function getOrders(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '25'))
    const skip = (page - 1) * limit
    const where: Record<string, unknown> = {}
    if (req.query.status) where.status = req.query.status
    if (req.query.marketplace) where.marketplace = req.query.marketplace
    if (req.query.search) {
      where.OR = [
        { marketplaceOrderId: { contains: String(req.query.search) } },
        { marketplaceOrderNo: { contains: String(req.query.search) } },
      ]
    }
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { items: { include: { source: { select: { id: true, name: true } } } } },
      }),
      prisma.order.count({ where }),
    ])
    const data = orders.map(o => prepareOrderForResponse(o as unknown as Record<string, unknown>))
    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function getOrderDetail(req: Request, res: Response) {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      include: {
        items: { include: { source: { select: { id: true, name: true } } } },
        statusLogs: { orderBy: { createdAt: 'asc' } },
        invoice: true,
        shipment: true,
      },
    })
    if (!order) { res.status(404).json({ success: false, error: 'Sipariş bulunamadı' }); return }
    res.json({ success: true, data: prepareOrderForResponse(order as unknown as Record<string, unknown>) })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function approveOrder(req: Request, res: Response) {
  try {
    await stateMachine.transition(req.params.orderId, 'PENDING_APPROVAL', { changedBy: 'admin' })
    await stateMachine.transition(req.params.orderId, 'PREPARING', { changedBy: 'admin' })
    const order = await prisma.order.findUnique({ where: { id: req.params.orderId } })
    res.json({ success: true, data: order })
  } catch (e) {
    if ((e as Error).name === 'InvalidTransitionError') {
      res.status(409).json({ success: false, error: (e as Error).message }); return
    }
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function cancelOrder(req: Request, res: Response) {
  try {
    await stateMachine.transition(req.params.orderId, 'CANCELLED', { changedBy: 'admin', note: req.body.reason })
    res.json({ success: true })
  } catch (e) {
    if ((e as Error).name === 'InvalidTransitionError') {
      res.status(409).json({ success: false, error: (e as Error).message }); return
    }
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function markShipped(req: Request, res: Response) {
  try {
    const { trackingNumber, cargoCompany } = req.body
    if (!trackingNumber || !cargoCompany) {
      res.status(400).json({ success: false, error: 'trackingNumber ve cargoCompany zorunlu' }); return
    }
    await stateMachine.transition(req.params.orderId, 'SHIPPED', { changedBy: 'admin', note: `Takip: ${trackingNumber}` })
    await prisma.order.update({ where: { id: req.params.orderId }, data: { trackingNumber, cargoCompany } })
    res.json({ success: true })
  } catch (e) {
    if ((e as Error).name === 'InvalidTransitionError') {
      res.status(409).json({ success: false, error: (e as Error).message }); return
    }
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function approveReturn(req: Request, res: Response) {
  try {
    await stateMachine.transition(req.params.orderId, 'RETURN_APPROVED', { changedBy: 'admin' })
    res.json({ success: true })
  } catch (e) {
    if ((e as Error).name === 'InvalidTransitionError') {
      res.status(409).json({ success: false, error: (e as Error).message }); return
    }
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function rejectReturn(req: Request, res: Response) {
  try {
    await stateMachine.transition(req.params.orderId, 'RETURN_REJECTED', { changedBy: 'admin', note: req.body.reason })
    res.json({ success: true })
  } catch (e) {
    if ((e as Error).name === 'InvalidTransitionError') {
      res.status(409).json({ success: false, error: (e as Error).message }); return
    }
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function markReturned(req: Request, res: Response) {
  try {
    await stateMachine.transition(req.params.orderId, 'REFUNDED', { changedBy: 'admin', note: `Durum: ${req.body.condition ?? 'GOOD'}` })
    res.json({ success: true })
  } catch (e) {
    if ((e as Error).name === 'InvalidTransitionError') {
      res.status(409).json({ success: false, error: (e as Error).message }); return
    }
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function fetchOrders(req: Request, res: Response) {
  try {
    const wait = String(req.query.wait || req.body?.wait || '').toLowerCase() === 'true'
    if (wait) {
      const result = await fetchService.fetchAll()
      res.json({ success: true, data: result })
      return
    }

    fetchService.fetchAll().catch((err: unknown) => {
      logger.error({ err }, 'fetchAll arka plan hatası')
    })
    res.status(202).json({ success: true, message: 'Sipariş çekme başlatıldı' })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function getOrderStats(req: Request, res: Response) {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const [todayNew, pendingApproval, pendingReturn, total, byStatusRows, byMarketplaceRows, lastFetchLogs] = await Promise.all([
      prisma.order.count({ where: { status: 'NEW', createdAt: { gte: today } } }),
      prisma.order.count({ where: { status: 'PENDING_APPROVAL' } }),
      prisma.order.count({ where: { status: 'RETURN_REQUESTED' } }),
      prisma.order.count(),
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.order.groupBy({ by: ['marketplace'], _count: { _all: true } }),
      prisma.orderFetchLog.findMany({ orderBy: { createdAt: 'desc' }, take: 12 }),
    ])
    const byStatus = Object.fromEntries(byStatusRows.map(row => [row.status, row._count._all]))
    const byMarketplace = Object.fromEntries(byMarketplaceRows.map(row => [row.marketplace, row._count._all]))
    res.json({ success: true, data: { todayNew, pendingApproval, pendingReturn, total, byStatus, byMarketplace, lastFetchLogs } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

export async function testOrderEmailSettings(_req: Request, res: Response) {
  try {
    await emailService.verify()
    res.json({ success: true, message: 'SMTP baglantisi dogrulandi' })
  } catch (e) {
    res.status(502).json({ success: false, error: e instanceof Error ? e.message : 'SMTP dogrulanamadi' })
  }
}

export async function sendOrderEmail(req: Request, res: Response) {
  try {
    const to = String(req.body?.to || '').trim()
    if (!to || !to.includes('@')) {
      res.status(400).json({ success: false, error: 'Gecerli alici e-posta adresi zorunlu' })
      return
    }

    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      include: { items: true },
    })
    if (!order) {
      res.status(404).json({ success: false, error: 'Siparis bulunamadi' })
      return
    }

    const decrypted = prepareOrderForResponse(order as unknown as Record<string, unknown>) as any
    const result = await emailService.sendOrderEmail({
      to,
      orderNo: order.marketplaceOrderNo || order.marketplaceOrderId,
      marketplace: order.marketplace,
      customerName: decrypted.customerName || null,
      totalAmount: order.totalAmount,
      currency: order.currency,
      trackingNumber: order.trackingNumber,
      cargoCompany: order.cargoCompany,
      items: order.items.map(item => ({
        title: item.title,
        quantity: item.quantity,
        totalPrice: item.totalPrice,
      })),
    })

    res.json({ success: true, data: result })
  } catch (e) {
    res.status(502).json({ success: false, error: e instanceof Error ? e.message : 'E-posta gonderilemedi' })
  }
}
