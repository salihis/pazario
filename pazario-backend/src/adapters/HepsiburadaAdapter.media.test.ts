import { describe, expect, it } from 'vitest'
import { HepsiburadaAdapter } from './HepsiburadaAdapter'
import type { Product } from './BaseAdapter'

const product: Product = {
  id: 'test', sku: 'MEDIA-1', title: 'Test', description: 'Test', price: 100, stock: 1,
  images: ['https://example.com/new.jpg'], videos: ['https://example.com/new.mp4'],
}

describe('Hepsiburada catalog media', () => {
  const adapter = new HepsiburadaAdapter('test-merchant', 'test-key')
  const serialize = (value: Product & { marketplaceAttributes?: unknown[] }) =>
    (adapter as any).toImportItem(value).attributes

  it('uses ordered images and the primary video', () => {
    const attrs = serialize({ ...product, videos: [...product.videos!, 'https://example.com/second.mp4'] })
    expect(attrs.Image1).toBe(product.images[0])
    expect(attrs['00000MU']).toBe(product.images[0])
    expect(attrs.Video1).toBe(product.videos![0])
    expect(attrs.Video2).toBeUndefined()
  })

  it('does not resurrect removed media from category attributes', () => {
    const attrs = serialize({ ...product, videos: [], marketplaceAttributes: [
      { attributeId: 'Image2', customAttributeValue: 'https://example.com/old.jpg' },
      { attributeId: 'Video1', customAttributeValue: 'https://example.com/old.mp4' },
      { attributeId: '00000MU', customAttributeValue: 'https://example.com/old.jpg' },
      { attributeId: 'color', customAttributeValue: 'Black' },
    ] })
    expect(attrs.Image2).toBeUndefined()
    expect(attrs.Video1).toBeUndefined()
    expect(attrs['00000MU']).toBe(product.images[0])
    expect(attrs.color).toBe('Black')
  })
})
