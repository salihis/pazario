import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { simulatePrice, previewProductPrice, createRuleSchema, simulateSchema } from './price.controller'
import { validateBody } from '../middleware/validate'

// â”€â”€â”€ MOCK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// PrismaClient'Ä± mock'la â€” controller modÃ¼lÃ¼ yÃ¼klendiÄŸinde Ã§alÄ±ÅŸÄ±r
vi.mock('@prisma/client', () => {
  const mockPrisma = {
    priceRule: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    globalPriceSetting: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    priceCalculation: { findMany: vi.fn(), count: vi.fn() },
    marketplaceListing: { updateMany: vi.fn() },
    product: { findUnique: vi.fn() },
  }
  return {
    PrismaClient: vi.fn(() => mockPrisma),
  }
})

// â”€â”€â”€ TEST APP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildApp() {
  const app = express()
  app.use(express.json())

  // Auth bypass: test iÃ§in user inject et
  app.use((req, _res, next) => {
    ;(req as express.Request & { user: unknown }).user = {
      id: 'test-user',
      email: 'test@test.com',
      role: 'ADMIN',
    }
    next()
  })

  app.post('/price-rules/simulate', validateBody(simulateSchema), simulatePrice)
  app.get('/price-rules/preview/:productId', previewProductPrice)

  return app
}

const app = buildApp()

// â”€â”€â”€ TESTLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('PriceController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('POST /price-rules/simulate', () => {
    it('doÄŸru hesaplama dÃ¶ndÃ¼rmeli: base=200, ek=10, kar=1.25, kargo=15, kom=0.15 â†’ 326.99', async () => {
      const res = await request(app)
        .post('/price-rules/simulate')
        .send({ basePrice: 200, ekTutar: 10, karOrani: 1.25, kargo: 15, komisyonOrani: 0.15 })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.finalPrice).toBe(326.99)
      expect(res.body.data.ara1BaseEk).toBe(210)
      expect(res.body.data.ara2Kar).toBe(262.5)
      expect(res.body.data.ara3Kargo).toBe(277.5)
    })

    it('karOrani < 1 â†’ 400 Bad Request', async () => {
      const res = await request(app)
        .post('/price-rules/simulate')
        .send({ basePrice: 100, ekTutar: 0, karOrani: 0.8, kargo: 0, komisyonOrani: 0.15 })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('komisyonOrani > 0.99 â†’ 400 Bad Request', async () => {
      const res = await request(app)
        .post('/price-rules/simulate')
        .send({ basePrice: 100, ekTutar: 0, karOrani: 1.2, kargo: 0, komisyonOrani: 1.0 })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('zorunlu alan eksikse â†’ 400 Bad Request', async () => {
      const res = await request(app)
        .post('/price-rules/simulate')
        .send({ basePrice: 100 }) // diÄŸer alanlar eksik

      expect(res.status).toBe(400)
    })
  })

  describe('GET /price-rules/preview/:productId', () => {
    it('Ã¼rÃ¼n bulunamazsa 404 dÃ¶nmeli', async () => {
      const { PrismaClient } = await import('@prisma/client')
      const mockInstance = new PrismaClient() as unknown as {
        product: { findUnique: ReturnType<typeof vi.fn> }
      }
      mockInstance.product.findUnique.mockResolvedValue(null)

      const res = await request(app).get('/price-rules/preview/nonexistent-id')

      expect(res.status).toBe(404)
    })
  })
})

