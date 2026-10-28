// src/index.ts

import 'dotenv/config'
import './queue/workers'
import { env } from './config/env'
import express from 'express'
import { prisma } from './db'
import { setupScheduler } from './queue/scheduler'
import { logger, requestLogger } from './utils/logger'
import { errorHandler } from './utils/apiResponse'
import priceRoutes from './api/routes/price.routes'
import categoryRoutes from './api/routes/category.routes'
import orderRoutes from './api/routes/order.routes'
import attributeRoutes from './api/routes/attributes.routes'
import productRoutes from './api/routes/product.routes'
import sourceRoutes from './api/routes/source.routes'
import marketplaceRoutes from './api/routes/marketplace.routes'
import marketplaceCredentialRoutes from './api/routes/marketplaceCredential.routes'
import localSyncRoutes from './api/routes/localSync.routes'
import financeRoutes from './api/routes/finance.routes'
import authRoutes from './api/routes/auth.routes'
import operationRoutes from './api/routes/operation.routes'
import attributeRuleRoutes from './api/routes/attributeRule.routes'
import invoiceRoutes from './api/routes/invoice.routes'
import publicInvoiceRoutes from './api/routes/publicInvoice.routes'
import { requireAuth } from './api/middleware/auth.middleware'
import { mediaDirectory } from './api/controllers/productMedia.controller'

// ─── UYGULAMA ────────────────────────────────────────────────────────────────

const app = express()

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(requestLogger)

// CORS — Whitelist'le kısıtlı
const allowedOrigins = env.ALLOWED_ORIGINS.split(',')
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (allowedOrigins.includes(origin ?? '')) {
    res.setHeader('Access-Control-Allow-Origin', origin ?? '')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  next()
})

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/api', (_req, res) => {
  res.json({
    name: 'Pazar.io API',
    status: 'ok',
    endpoints: ['/health', '/api/products', '/api/sources', '/api/sync-jobs'],
  })
})

app.use('/api', authRoutes)
app.use('/api', localSyncRoutes)
app.use('/api', publicInvoiceRoutes)
app.use('/api/product-media', (req, res, next) => {
  if (!/^\/[a-f0-9-]{36}\.(jpg|png|mp4)$/.test(req.path)) { res.sendStatus(404); return }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
}, express.static(mediaDirectory(), { index: false, dotfiles: 'deny', maxAge: '1d' }))
app.use('/api', requireAuth)
app.use('/api', priceRoutes)
app.use('/api', categoryRoutes)
app.use('/api', orderRoutes)
app.use('/api', attributeRoutes)
app.use('/api', productRoutes)
app.use('/api', sourceRoutes)
app.use('/api', marketplaceRoutes)
app.use('/api', marketplaceCredentialRoutes)
app.use('/api', financeRoutes)
app.use('/api', operationRoutes)
app.use('/api', attributeRuleRoutes)
app.use('/api', invoiceRoutes)

// Health check
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  } catch {
    res.status(503).json({ status: 'error', message: 'DB bağlantısı yok' })
  }
})

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
    timestamp: new Date().toISOString(),
  })
})

// Error handler (en sonda olmalı)
app.use(errorHandler)

// ─── BAŞLAT ───────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  try {
    await prisma.$connect()
    logger.info('PostgreSQL bağlandı')

    await setupScheduler()
    logger.info('Scheduler başlatıldı')

    app.listen(env.PORT, () => {
      logger.info(`Pazar.io backend http://localhost:${env.PORT} adresinde çalışıyor`)
    })
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    logger.error(error.message)
    process.exit(1)
  }
}

bootstrap()
