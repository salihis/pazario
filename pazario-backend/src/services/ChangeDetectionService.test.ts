import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChangeDetectionService } from '../services/ChangeDetectionService'
import type { ParsedProduct } from '../parser/XMLParser'
import type { PrismaClient } from '@prisma/client'

// ─── MOCK ────────────────────────────────────────────────────────────────────

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

const mockPrisma = {
  product: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(async (cb: (tx: TxClient) => Promise<unknown>) => {
    if (typeof cb === 'function') {
      return await cb(mockPrisma as unknown as TxClient)
    }
    return []
  }),
} as unknown as PrismaClient

// ─── YARDIMCI ────────────────────────────────────────────────────────────────

function makeProduct(overrides: Partial<ParsedProduct> = {}): ParsedProduct {
  return {
    id: 'prod1',
    sku: 'SKU1',
    barcode: null,
    title: 'Test Product',
    description: 'Description',
    brand: 'Brand',
    category: 'Category',
    price: 99.99,
    listPrice: null,
    currency: 'TRY',
    stock: 10,
    images: ['https://example.com/image.jpg'],
    attributes: {},
    contentHash: 'hash1',
    ...overrides,
  }
}

// ─── TESTLER ─────────────────────────────────────────────────────────────────

describe('ChangeDetectionService', () => {
  let service: ChangeDetectionService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new ChangeDetectionService(mockPrisma)
  })

  describe('detect()', () => {
    it('detects an image-only XML update', async () => {
      ;(mockPrisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'db1', externalId: 'prod1', contentHash: 'hash1', stock: 10, images: ['https://example.com/old.jpg'] },
      ])
      const result = await service.detect('source1', [makeProduct()])
      expect(result.changedProducts).toHaveLength(1)
    })
    it('never includes manual media in an XML update', async () => {
      await service.applyChanges('source1', { newProducts: [], changedProducts: [{ product: makeProduct(), existingId: 'db1' }], unchangedIds: [], deletedExternalIds: [] }, 'job')
      const update = (mockPrisma.product.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(update.data.images).toEqual(['https://example.com/image.jpg'])
      expect(update.data).not.toHaveProperty('manualMedia')
      expect(update.data).not.toHaveProperty('mediaVersion')
    })
    it('should detect new products', async () => {
      const incoming = [makeProduct({ id: 'new123', contentHash: 'hash123' })]
      ;(mockPrisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

      const result = await service.detect('source1', incoming)

      expect(result.newProducts).toHaveLength(1)
      expect(result.changedProducts).toHaveLength(0)
      expect(result.unchangedIds).toHaveLength(0)
    })

    it('should detect changed products when hash differs', async () => {
      const incoming = [makeProduct({ id: 'existing123', contentHash: 'newhash' })]
      ;(mockPrisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'prod123', externalId: 'existing123', contentHash: 'oldhash' },
      ])

      const result = await service.detect('source1', incoming)

      expect(result.changedProducts).toHaveLength(1)
      expect(result.changedProducts[0].existingId).toBe('prod123')
      expect(result.newProducts).toHaveLength(0)
    })

    it('should detect unchanged products when hash is same', async () => {
      const incoming = [makeProduct({ id: 'existing123', contentHash: 'samehash' })]
      ;(mockPrisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'prod123', externalId: 'existing123', contentHash: 'samehash' },
      ])

      const result = await service.detect('source1', incoming)

      expect(result.unchangedIds).toHaveLength(1)
      expect(result.unchangedIds[0]).toBe('prod123')
      expect(result.newProducts).toHaveLength(0)
      expect(result.changedProducts).toHaveLength(0)
    })

    it('should detect changed products when stored stock drifted from the XML stock', async () => {
      const incoming = [makeProduct({ id: 'existing123', contentHash: 'samehash', stock: 12 })]
      ;(mockPrisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'prod123', externalId: 'existing123', contentHash: 'samehash', stock: 0 },
      ])

      const result = await service.detect('source1', incoming)

      expect(result.changedProducts).toHaveLength(1)
      expect(result.changedProducts[0].existingId).toBe('prod123')
    })

    it('should detect deleted products (in DB but not in XML)', async () => {
      // XML'de sadece prod1 var, DB'de prod1 + prod2 var
      const incoming = [makeProduct({ id: 'prod1', contentHash: 'hash1' })]
      ;(mockPrisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'db-id-1', externalId: 'prod1', contentHash: 'hash1' },
        { id: 'db-id-2', externalId: 'prod2', contentHash: 'hash2' }, // XML'de yok
      ])

      const result = await service.detect('source1', incoming)

      expect(result.deletedExternalIds).toHaveLength(1)
      expect(result.deletedExternalIds[0]).toBe('prod2')
      // Mevcut ürün sadece DEĞİŞMEMİŞ olmalı
      expect(result.unchangedIds).toHaveLength(1)
    })

    it('should process large batch (1000 products) in under 2 seconds', async () => {
      const incoming = Array.from({ length: 1000 }, (_, i) =>
        makeProduct({ id: `prod${i}`, contentHash: `hash${i}` })
      )
      ;(mockPrisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

      const start = Date.now()
      const result = await service.detect('source1', incoming)
      const elapsed = Date.now() - start

      expect(result.newProducts).toHaveLength(1000)
      expect(elapsed).toBeLessThan(2000)
    })
  })

  describe('applyChanges()', () => {
    it('should return created and updated counts', async () => {
      ;(mockPrisma.product.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 })

      const detectionResult = {
        newProducts: [makeProduct({ id: 'n1' }), makeProduct({ id: 'n2' })],
        changedProducts: [],
        unchangedIds: [],
        deletedExternalIds: [],
      }

      const stats = await service.applyChanges('source1', detectionResult, 'job123')

      expect(stats.created).toBe(2)
      expect(stats.updated).toBe(0)
    })
  })
})
