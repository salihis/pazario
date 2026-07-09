// src/api/routes/order.routes.ts

import { Router } from 'express'
import {
  getOrders,
  getOrderDetail,
  approveOrder,
  cancelOrder,
  markShipped,
  approveReturn,
  rejectReturn,
  markReturned,
  fetchOrders,
  getOrderStats,
  sendOrderEmail,
  testOrderEmailSettings,
} from '../controllers/order.controller'

const router = Router()

router.get('/orders/stats', getOrderStats)
router.post('/orders/email/test', testOrderEmailSettings)
router.get('/orders', getOrders)
router.get('/orders/:orderId', getOrderDetail)
router.post('/orders/:orderId/approve', approveOrder)
router.post('/orders/:orderId/cancel', cancelOrder)
router.post('/orders/:orderId/mark-shipped', markShipped)
router.post('/orders/:orderId/approve-return', approveReturn)
router.post('/orders/:orderId/reject-return', rejectReturn)
router.post('/orders/:orderId/mark-returned', markReturned)
router.post('/orders/:orderId/send-email', sendOrderEmail)
router.post('/orders/fetch', fetchOrders)

export default router
