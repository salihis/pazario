import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { writeFile } from 'node:fs/promises'
const mocks = vi.hoisted(() => ({
  product: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  marketplaceListing: { updateMany: vi.fn() }, $queryRaw: vi.fn(),
}))
vi.mock('@prisma/client', async original => {
  const module = await original<typeof import('@prisma/client')>()
  return { ...module, PrismaClient: class {
    product = mocks.product
    marketplaceListing = mocks.marketplaceListing
    $queryRaw = mocks.$queryRaw
    $transaction = (fn: any) => fn(this)
  } }
})
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn(), statfs: vi.fn().mockResolvedValue({ bavail: 1000000, bsize: 4096 }) }))
import { getProductMedia, saveProductMedia, uploadProductMedia } from './productMedia.controller'
const id = '11111111-1111-4111-8111-111111111111'
const product = { id, sourceId: 'source', title: 'Product', sku: 'SKU', images: ['https://example.com/xml.jpg'], manualMedia: null, mediaVersion: 0 }
const app = express()
app.use(express.json())
app.get('/products/:id/media', getProductMedia)
app.put('/products/:id/media', saveProductMedia)
app.post('/products/:id/media/upload', express.raw({ type: ['image/jpeg', 'image/png', 'video/mp4'], limit: '40mb' }), uploadProductMedia)

describe('product media endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.product.findUnique.mockResolvedValue(product)
    mocks.product.findMany.mockResolvedValue([product])
  })
  it('returns XML images and an edit version', async () => {
    const r = await request(app).get(`/products/${id}/media`)
    expect(r.status).toBe(200)
    expect(r.body.data.version).toBe(0)
    expect(r.body.data.xmlImages).toEqual(product.images)
  })
  it('saves only manual fields and invalidates the publish hash without publishing', async () => {
    const r = await request(app).put(`/products/${id}/media`).send({ images: ['https://example.com/manual.png'], videos: [], version: 0 })
    expect(r.status).toBe(200)
    expect(mocks.product.update.mock.calls[0][0].data).not.toHaveProperty('images')
    expect(mocks.product.update.mock.calls[0][0].data.manualMedia.addedImages).toEqual(['https://example.com/manual.png'])
    expect(mocks.marketplaceListing.updateMany.mock.calls[0][0].data).toEqual({ hashAtPublish: null })
  })
  it('rejects stale edits instead of overwriting them', async () => {
    const r = await request(app).put(`/products/${id}/media`).send({ images: [], videos: [], version: 3 })
    expect(r.status).toBe(409)
    expect(mocks.product.update).not.toHaveBeenCalled()
  })
  it('rejects grouped updates that include a different source or missing product', async () => {
    const r = await request(app).put(`/products/${id}/media`).send({ images: [], videos: [], version: 0, productIds: ['22222222-2222-4222-8222-222222222222'] })
    expect(r.status).toBe(409)
    expect(mocks.product.update).not.toHaveBeenCalled()
  })
  it('rejects invalid video URLs with a validation error', async () => {
    const r = await request(app).put(`/products/${id}/media`).send({ images: [], videos: ['invalid'], version: 0 })
    expect(r.status).toBe(400)
    expect(mocks.product.update).not.toHaveBeenCalled()
  })
  it('rejects disguised HTML uploads', async () => {
    const r = await request(app).post(`/products/${id}/media/upload`).set('Content-Type', 'image/jpeg').send(Buffer.from('<html>'))
    expect(r.status).toBe(400)
  })
  it('stores a valid upload separately without attaching it before Save', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://pazario.tr')
    try {
      const buffer = Buffer.from([137,80,78,71,13,10,26,10])
      const r = await request(app).post(`/products/${id}/media/upload`).set('Content-Type', 'image/png').send(buffer)
      expect(r.status).toBe(201)
      expect(r.body.data.url).toMatch(/^https:\/\/pazario\.tr\/api\/product-media\/[a-f0-9-]+\.png$/)
      expect(writeFile).toHaveBeenCalledWith(expect.any(String), buffer, { flag: 'wx', mode: 0o644 })
      expect(mocks.product.update).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })
})
