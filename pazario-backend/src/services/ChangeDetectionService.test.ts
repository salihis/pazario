import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChangeDetectionService } from '../services/ChangeDetectionService'
import { ParsedProduct } from '../parser/XMLParser'

// Mock Prisma
const mockPrisma = {
  product: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  },
  $transaction: vi.fn(async (cb: any) => {
    if (typeof cb === 'function') {
      return await cb(mockPrisma)
    }
    return []
  })
} as any

describe('ChangeDetectionService', () => {
  let service: ChangeDetectionService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new ChangeDetectionService(mockPrisma)
  })

  describe('detect', () => {
    it('should detect new products', async () => {
      const incomingProducts: ParsedProduct[] = [
        {
          id: 'new123',
          sku: 'NEW123',
          barcode: null,
          title: 'New Product',
          description: 'Description',
          brand: 'Brand',
          category: 'Category',
          price: 99.99,
          listPrice: null,
          currency: 'TRY',
          stock: 10,
          images: ['https://example.com/image.jpg'],
          attributes: {},
          contentHash: 'hash123'
        }
      ]

      mockPrisma.product.findMany.mockResolvedValue([])

      const result = await service.detect('source1', incomingProducts)

      expect(result.newProducts).toHaveLength(1)
      expect(result.changedProducts).toHaveLength(0)
      expect(result.unchangedIds).toHaveLength(0)
    })

    it('should detect changed products', async () => {
      const incomingProducts: ParsedProduct[] = [
        {
          id: 'existing123',
          sku: 'EXISTING123',
          barcode: null,
          title: 'Updated Product',
          description: 'Updated',
          brand: 'Brand',
          category: 'Category',
          price: 199.99,
          listPrice: null,
          currency: 'TRY',
          stock: 10,
          images: ['https://example.com/image.jpg'],
          attributes: {},
          contentHash: 'newhash'
        }
      ]

      mockPrisma.product.findMany.mockResolvedValue([
        {
          id: 'prod123',
          externalId: 'existing123',
          contentHash: 'oldhash'
        }
      ])

      const result = await service.detect('source1', incomingProducts)

      expect(result.changedProducts).toHaveLength(1)
      expect(result.changedProducts[0].existingId).toBe('prod123')
    })

    it('should detect unchanged products', async () => {
      const incomingProducts: ParsedProduct[] = [
        {
          id: 'existing123',
          sku: 'EXISTING123',
          barcode: null,
          title: 'Same Product',
          description: 'Same',
          brand: 'Brand',
          category: 'Category',
          price: 99.99,
          listPrice: null,
          currency: 'TRY',
          stock: 10,
          images: ['https://example.com/image.jpg'],
          attributes: {},
          contentHash: 'samehash'
        }
      ]

      mockPrisma.product.findMany.mockResolvedValue([
        {
          id: 'prod123',
          externalId: 'existing123',
          contentHash: 'samehash'
        }
      ])

      const result = await service.detect('source1', incomingProducts)

      expect(result.unchangedIds).toHaveLength(1)
      expect(result.unchangedIds[0]).toBe('prod123')
    })

    it('should handle large batch (1000 products)', async () => {
      const incomingProducts: ParsedProduct[] = Array(1000)
        .fill(null)
        .map((_, i) => ({
          id: `prod${i}`,
          sku: `SKU${i}`,
          barcode: null,
          title: `Product ${i}`,
          description: `Desc ${i}`,
          brand: 'Brand',
          category: 'Category',
          price: 99.99,
          listPrice: null,
          currency: 'TRY',
          stock: 10,
          images: ['https://example.com/image.jpg'],
          attributes: {},
          contentHash: `hash${i}`
        }))

      mockPrisma.product.findMany.mockResolvedValue([])

      const result = await service.detect('source1', incomingProducts)

      expect(result.newProducts).toHaveLength(1000)
    })
  })

  describe('applyChanges', () => {
    it('should handle detection results', async () => {
      const result = {
        newProducts: [],
        changedProducts: [],
        unchangedIds: [],
        deletedExternalIds: []
      }

      mockPrisma.$transaction.mockResolvedValue({
        created: 0,
        updated: 0,
        unchanged: 0
      })

      const stats = await service.applyChanges('source1', result, 'job123')

      expect(stats).toBeDefined()
    })
  })
})
