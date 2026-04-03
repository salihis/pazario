// src/index.ts

import 'dotenv/config'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { setupScheduler } from './queue/scheduler'
import { logger, requestLogger } from './utils/logger'
import { errorHandler } from './utils/apiResponse'
import priceRoutes from './api/routes/price.routes'
import categoryRoutes from './api/routes/category.routes'
import orderRoutes from './api/routes/order.routes'
import attributeRoutes from './api/routes/attributes.routes'
import productRoutes from './api/routes/product.routes'
import sourceRoutes from './api/routes/source.routes'

// ─── UYGULAMA ────────────────────────────────────────────────────────────────

const app = express()
const prisma = new PrismaClient()
const PORT = parseInt(process.env.PORT ?? '3000')

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(requestLogger)

// CORS — Whitelist'le kısıtlı
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5174,http://localhost:3456').split(',')
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (allowedOrigins.includes(origin || '')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  next()
})

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.use('/api', priceRoutes)
app.use('/api', categoryRoutes)
app.use('/api', orderRoutes)
app.use('/api', attributeRoutes)
app.use('/api', productRoutes)
app.use('/api', sourceRoutes)

// Health check
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  } catch (e) {
    res.status(503).json({ status: 'error', message: 'DB bağlantısı yok' })
  }
})

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
    timestamp: new Date().toISOString()
  })
})

// Error handler (must be last)
app.use(errorHandler)

// ─── BAŞLAT ───────────────────────────────────────────────────────────────────

async function bootstrap() {
  try {
    await prisma.$connect()
    logger.info('✅ PostgreSQL bağlandı')

    await setupScheduler()
    logger.info('✅ Scheduler başlatıldı')

    app.listen(PORT, () => {
      logger.info(`🚀 Pazar.io backend http://localhost:${PORT} adresinde çalışıyor`)
    })
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    logger.error(error.message)
    process.exit(1)
  }
}

bootstrap()