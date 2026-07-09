import { describe, it, expect, vi } from 'vitest'
import { XMLParser, XMLParseError } from '../parser/XMLParser'
import { XMLParser as FastXMLParser } from 'fast-xml-parser'

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
      brand: 'Test Brand',
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
      stock: 5,
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

  it('should parse Ticimax Urun/Secenek format', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <Urunler>
    <Urun>
      <UrunKartiID>3</UrunKartiID>
      <UrunAdi>Test Ticimax Product</UrunAdi>
      <Aciklama>Detail text</Aciklama>
      <Marka>Test Brand</Marka>
      <KategoriTree>Ev Giyim/Test</KategoriTree>
      <Resimler>
        <Resim>https://example.com/one.jpg</Resim>
        <Resim>https://example.com/two.jpg</Resim>
      </Resimler>
      <UrunSecenek>
        <Secenek>
          <VaryasyonID>31</VaryasyonID>
          <StokKodu>TEST-SM</StokKodu>
          <Barkod>8690000000012</Barkod>
          <StokAdedi>12</StokAdedi>
          <SatisFiyati>449,00</SatisFiyati>
          <IndirimliFiyat>349,00</IndirimliFiyat>
          <ParaBirimiKodu>TRY</ParaBirimiKodu>
          <EkSecenekOzellik>
            <Ozellik Tanim="Beden" Deger="S/M">S/M</Ozellik>
          </EkSecenekOzellik>
        </Secenek>
      </UrunSecenek>
    </Urun>
  </Urunler>
</Root>`

    const result = await parser.parse(xml)

    expect(result.products).toHaveLength(1)
    expect(result.meta.feedType).toBe('CUSTOM_PRODUCTS')
    expect(result.products[0]).toMatchObject({
      id: '31',
      sku: 'TEST-SM',
      barcode: '8690000000012',
      title: 'Test Ticimax Product',
      description: 'Detail text',
      brand: 'Test Brand',
      category: 'Ev Giyim/Test',
      price: 349,
      listPrice: 449,
      currency: 'TRY',
      stock: 12,
      images: ['https://example.com/one.jpg', 'https://example.com/two.jpg'],
      attributes: { Beden: 'S/M', variantParentId: '3', variantParentSku: '3' },
    })
  })

  it('should expand XML Tedarik product variants as separate products', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products>
  <product>
    <id>558</id>
    <productCode>RYL-AKKT4000</productCode>
    <barcode>624987670638</barcode>
    <category>KADIN >>> Giyim >>> Tayt</category>
    <brand>Royaleks</brand>
    <name>Kota Kadın Uzun Paça Katlamalı Likralı Sporcu Düz Tayt Siyah 4000</name>
    <listPrice>249.90</listPrice>
    <price>249.90</price>
    <currency>TRY</currency>
    <quantity>646</quantity>
    <variants>
      <variant><name1>Beden</name1><value1>M</value1><quantity>215</quantity><barcode>624987957326</barcode></variant>
      <variant><name1>Beden</name1><value1>L</value1><quantity>216</quantity><barcode>624987267326</barcode></variant>
      <variant><name1>Beden</name1><value1>XL</value1><quantity>215</quantity><barcode>624987276908</barcode></variant>
    </variants>
  </product>
</products>`

    const result = await parser.parse(xml)

    expect(result.products).toHaveLength(3)
    expect(result.products.map(product => product.sku)).toEqual([
      'RYL-AKKT4000-M',
      'RYL-AKKT4000-L',
      'RYL-AKKT4000-XL',
    ])
    expect(result.products.map(product => product.barcode)).toEqual([
      '624987957326',
      '624987267326',
      '624987276908',
    ])
    expect(result.products.map(product => product.stock)).toEqual([215, 216, 215])
    expect(result.products[0].attributes).toMatchObject({
      Beden: 'M',
      variantParentId: '558',
      variantParentSku: 'RYL-AKKT4000',
    })
  })

  it('should read phone case variant brand/model and title suffix color', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products>
  <product>
    <id>493</id>
    <productCode>1</productCode>
    <barcode>8683140692650</barcode>
    <category><![CDATA[TELEFON & TABLET AKSESUARLARI >>> TELEFON KILIFI]]></category>
    <brand><![CDATA[toptanbudur]]></brand>
    <name><![CDATA[Newface Samsung Galaxy S24 Ultra Kilif Kart Seffaf Silikon - Seffaf]]></name>
    <sitePrice>66.11</sitePrice>
    <price>66.11</price>
    <currency>TRY</currency>
    <quantity>20</quantity>
    <variants>
      <variant>
        <name1>marka</name1>
        <value1>Samsung</value1>
        <name2>model</name2>
        <value2>Galaxy S24 Ultra</value2>
        <quantity>20</quantity>
      </variant>
    </variants>
  </product>
</products>`

    const result = await parser.parse(xml)

    expect(result.products).toHaveLength(1)
    expect(result.products[0].attributes).toMatchObject({
      marka: 'Samsung',
      model: 'Galaxy S24 Ultra',
      Renk: 'Seffaf',
      renk: 'Seffaf',
    })
  })

  it('should throw XMLParseError on broken XML', async () => {
    // Underlying fast-xml-parser.parse() throw'unu XMLParseError'a sarmalaması gerekir
    const spy = vi
      .spyOn(FastXMLParser.prototype, 'parse')
      .mockImplementationOnce(() => {
        throw new Error('Unexpected token')
      })

    await expect(parser.parse('<broken xml')).rejects.toBeInstanceOf(XMLParseError)
    spy.mockRestore()
  })

  it('should return empty array and EMPTY_FEED warning for empty feed', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<products></products>`

    const result = await parser.parse(xml)

    expect(result.products).toHaveLength(0)
    const hasEmptyFeedWarn = result.errors.some(
      (e) => e.code === 'EMPTY_FEED' && e.type === 'WARN'
    )
    expect(hasEmptyFeedWarn).toBe(true)
  })

  it('should clean HTML entities (&amp; → &)', async () => {
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

  it('should generate MD5 content hash', async () => {
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
    // MD5 hex string — 32 karakter
    expect(result.products[0].contentHash).toMatch(/^[a-f0-9]{32}$/)
  })
})
