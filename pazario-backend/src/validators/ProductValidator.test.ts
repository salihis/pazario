import { describe, it, expect } from 'vitest'
import { ProductValidator } from '../validators/ProductValidator'
import { ParsedProduct } from '../parser/XMLParser'

describe('ProductValidator', () => {
  const validProduct: ParsedProduct = {
    id: '123',
    sku: 'TEST123',
    barcode: '1234567890123',
    title: 'Test Product',
    description: 'This is a test product description with more than 50 characters',
    brand: 'Test Brand',
    category: 'Electronics',
    price: 99.99,
    listPrice: 129.99,
    currency: 'TRY',
    stock: 10,
    images: ['https://example.com/image1.jpg', 'https://example.com/image2.jpg'],
    attributes: { color: 'red', size: 'M' },
    contentHash: 'abc123'
  }

  it('should validate valid product for all marketplaces', () => {
    const result = ProductValidator.validateAll(validProduct, ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA'])

    expect(result.TRENDYOL.valid).toBe(true)
    expect(result.HEPSIBURADA.valid).toBe(true)
    expect(result.N11.valid).toBe(true)
    expect(result.PAZARAMA.valid).toBe(true)
  })

  it('should use BRS-prefixed SKU when barcode is missing for Trendyol', () => {
    const product = { ...validProduct, barcode: null }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(true)
  })

  it('should reject negative price', () => {
    const product = { ...validProduct, price: -10 }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('negative') || e.includes('Price'))).toBe(true)
  })

  it('should reject title too long for Trendyol', () => {
    const product = { ...validProduct, title: 'A'.repeat(260) }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Title too long')
  })

  it('should reject product with stock below marketplace threshold', () => {
    const product = { ...validProduct, stock: 0 }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Insufficient stock')
  })

  it('should reject product with stock equal to marketplace threshold', () => {
    const product = { ...validProduct, stock: 6 }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('must be > 6')
  })

  it('should warn for very high price', () => {
    const product = { ...validProduct, price: 1500000 }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('very high')
  })

  it('should reject invalid barcode format for Pazarama', () => {
    const product = { ...validProduct, barcode: 'invalid barcode' }

    const result = ProductValidator.validate(product, 'PAZARAMA')

    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('should accept BRS-prefixed marketplace barcode for Pazarama', () => {
    const product = { ...validProduct, barcode: 'BRSABC123' }

    const result = ProductValidator.validate(product, 'PAZARAMA')

    expect(result.valid).toBe(true)
  })

  it('should reject invalid SKU format for Hepsiburada', () => {
    const product = { ...validProduct, sku: 'invalid@sku!' }

    const result = ProductValidator.validate(product, 'HEPSIBURADA')

    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('should reject short description for N11', () => {
    const product = { ...validProduct, description: 'Short' }

    const result = ProductValidator.validate(product, 'N11')

    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('Description')
  })

  it('should warn for HTML in title', () => {
    const product = { ...validProduct, title: 'Test <b>Product</b>' }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(true)
    expect(result.warnings).toContain('Title contains HTML tags')
  })

  it('should warn for HTTP images', () => {
    const product = { ...validProduct, images: ['http://example.com/image.jpg'] }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(true)
    expect(result.warnings).toContain('1 image(s) use HTTP instead of HTTPS')
  })

  it('should reject product with no images', () => {
    const product = { ...validProduct, images: [] }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Not enough images: 0 < 1')
  })

  it('should warn for too many images', () => {
    const product = { ...validProduct, images: Array(12).fill('https://example.com/image.jpg') }

    const result = ProductValidator.validate(product, 'TRENDYOL')

    expect(result.valid).toBe(true)
    expect(result.warnings).toContain('Too many images: 12 > 8, will use first 8')
  })
})
