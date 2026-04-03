import { describe, it, expect } from 'vitest'
import { XMLParser } from '../parser/XMLParser'

describe('XMLParser', () => {
  const parser = new XMLParser()

  it('should parse Google Shopping RSS format', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <item>
      <g:id>12345</g:id>
      <g:title>Test Product</g:title>
      <g:description>Test description</g:description>
      <g:price>1299.99 TRY</g:price>
      <g:sale_price>999.99 TRY</g:sale_price>
      <g:image_link>https://example.com/image.jpg</g:image_link>
      <g:brand>Test Brand</g:brand>
      <g:product_type>Electronics</g:product_type>
      <g:quantity>10</g:quantity>
      <g:mpn>TEST123</g:mpn>
    </item>
  </channel>
</rss>`

    const result = await parser.parse(xml)

    expect(result.products).toHaveLength(1)
    expect(result.meta.feedType).toBe('RSS_SHOPPING')
    expect(result.products[0]).toMatchObject({
      id: '12345',
      title: 'Test Product',
      description: 'Test description',
      price: 1299.99,
      stock: 10,
      brand: 'Test Brand'
    })
  })

  it('should parse custom <products> format', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products>
  <product>
    <id>P001</id>
    <name>Custom Product</name>
    <price>299.99</price>
    <stock>5</stock>
    <image>https://example.com/img.jpg</image>
  </product>
</products>`

    const result = await parser.parse(xml)

    expect(result.products).toHaveLength(1)
    expect(result.meta.feedType).toBe('CUSTOM_PRODUCTS')
    expect(result.products[0]).toMatchObject({
      id: 'P001',
      title: 'Custom Product',
      price: 299.99,
      stock: 5
    })
  })

  it('should parse Turkish price format "1.299,99 TL"', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products>
  <product>
    <id>P001</id>
    <title>Test</title>
    <price>1.299,99 TL</price>
    <stock>1</stock>
  </product>
</products>`

    const result = await parser.parse(xml)

    expect(result.products[0].price).toBe(1299.99)
  })

  it('should handle malformed XML gracefully', async () => {
    const invalidXml = '<products><product><id>123</title></product></products>'

    const result = await parser.parse(invalidXml)

    // Parser'ı kırılmayacak, error'u log et
    expect(result).toBeDefined()
    expect(result.products || result.errors).toBeDefined()
  })

  it('should handle empty feed', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products></products>`

    const result = await parser.parse(xml)

    expect(result.products).toHaveLength(0)
  })

  it('should clean HTML entities', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products>
  <product>
    <id>P001</id>
    <title>Test &amp; Product</title>
    <description>Description &lt;test&gt;</description>
    <price>99.99</price>
    <stock>1</stock>
  </product>
</products>`

    const result = await parser.parse(xml)

    expect(result.products[0].title).toBe('Test & Product')
    expect(result.products[0].description).toContain('Description')
  })

  it('should generate content hash', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products>
  <product>
    <id>123</id>
    <title>Test Product</title>
    <price>99.99</price>
    <stock>5</stock>
  </product>
</products>`

    const result = await parser.parse(xml)

    expect(result.products[0].contentHash).toBeDefined()
  })
})