// src/services/CategoryAttributeService.ts

import { PrismaClient } from '@prisma/client'

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export interface Attribute {
  attributeId: string
  attributeName: string
  attributeType: 'dropdown' | 'multi_select' | 'free_text' | 'number' | 'boolean' | 'color'
  isMandatory: boolean
  allowCustomValue: boolean
  values: { id: string; name: string }[]
  validationRules: {
    min?: number
    max?: number
    maxLength?: number
    pattern?: string
  }
  displayOrder: number
}

export interface FormField extends Attribute {
  currentValue: string | string[] | boolean | null
  isValid: boolean
  validationError: string | null
}

export interface ValidationResult {
  isValid: boolean
  error: string | null
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const CACHE_TTL_DAYS = 7
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000

type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'

// ─── SERVİS ───────────────────────────────────────────────────────────────────

export class CategoryAttributeService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Kategori özelliklerini getirir
   * Stale-while-revalidate: 7 günden eski → döndür + arka planda refresh
   */
  async getAttributes(
    marketplace: Marketplace,
    categoryId: string,
    productId?: string
  ): Promise<{ attributes: FormField[]; source: 'cache' | 'api'; fetchedAt: Date }> {
    const cached = await this.prisma.marketplaceCategoryAttribute.findMany({
      where: { marketplace, categoryId },
      orderBy: [{ isMandatory: 'desc' }, { displayOrder: 'asc' }],
    })

    if (cached.length > 0) {
      const fetchedAt = cached[0].fetchedAt
      const isStale = Date.now() - fetchedAt.getTime() > CACHE_TTL_MS

      if (isStale) {
        // Stale: döndür + arka planda yenile
        this.refreshFromAPI(marketplace, categoryId).catch(() => {})
      }

      const productAttrs = productId
        ? await this.getProductAttributes(productId, marketplace)
        : new Map<string, string>()

      const attributes = await this.buildFormSchema(
        cached.map(this.mapToAttribute),
        productAttrs
      )

      return { attributes, source: 'cache', fetchedAt }
    }

    // Cache yok — API'den çek
    await this.refreshFromAPI(marketplace, categoryId)

    const fresh = await this.prisma.marketplaceCategoryAttribute.findMany({
      where: { marketplace, categoryId },
      orderBy: [{ isMandatory: 'desc' }, { displayOrder: 'asc' }],
    })

    const productAttrs = productId
      ? await this.getProductAttributes(productId, marketplace)
      : new Map<string, string>()

    const attributes = await this.buildFormSchema(
      fresh.map(this.mapToAttribute),
      productAttrs
    )

    return {
      attributes,
      source: 'api',
      fetchedAt: fresh[0]?.fetchedAt ?? new Date(),
    }
  }

  /**
   * API'den kategori özelliklerini çeker ve DB'ye yazar
   */
  async refreshFromAPI(marketplace: Marketplace, categoryId: string): Promise<void> {
    try {
      const attrs = await this.fetchFromMarketplaceAPI(marketplace, categoryId)

      for (const attr of attrs) {
        await this.prisma.marketplaceCategoryAttribute.upsert({
          where: {
            marketplace_categoryId_attributeId: {
              marketplace,
              categoryId,
              attributeId: attr.attributeId,
            },
          },
          update: {
            attributeName: attr.attributeName,
            attributeType: attr.attributeType as 'dropdown',
            isMandatory: attr.isMandatory,
            allowCustomValue: attr.allowCustomValue,
            values: attr.values as object[],
            validationRules: attr.validationRules as object,
            displayOrder: attr.displayOrder,
            fetchedAt: new Date(),
          },
          create: {
            marketplace,
            categoryId,
            attributeId: attr.attributeId,
            attributeName: attr.attributeName,
            attributeType: attr.attributeType as 'dropdown',
            isMandatory: attr.isMandatory,
            allowCustomValue: attr.allowCustomValue,
            values: attr.values as object[],
            validationRules: attr.validationRules as object,
            displayOrder: attr.displayOrder,
            fetchedAt: new Date(),
          },
        })
      }
    } catch (e) {
      // Arka plan refresh hatası — sessizce geç
    }
  }

  /**
   * FormField dizisi oluşturur — mevcut değerleri ekler
   */
  async buildFormSchema(
    attributes: Attribute[],
    productAttrs: Map<string, string>
  ): Promise<FormField[]> {
    return attributes.map(attr => {
      const currentValue = productAttrs.get(attr.attributeId) ?? null
      const validation = this.validateValue(attr, currentValue)

      return {
        ...attr,
        currentValue,
        isValid: validation.isValid,
        validationError: validation.error,
      }
    })
  }

  /**
   * Değer validasyonu
   */
  validateValue(
    attribute: Attribute,
    value: string | string[] | boolean | null
  ): ValidationResult {
    // Zorunlu alan boş
    if (attribute.isMandatory && (value === null || value === '' || (Array.isArray(value) && value.length === 0))) {
      return { isValid: false, error: 'Bu alan zorunludur' }
    }

    if (value === null || value === '') {
      return { isValid: true, error: null }
    }

    const rules = attribute.validationRules

    // Max uzunluk
    if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
      return { isValid: false, error: `En fazla ${rules.maxLength} karakter` }
    }

    // Min/max sayı
    if (attribute.attributeType === 'number' && typeof value === 'string') {
      const num = parseFloat(value)
      if (isNaN(num)) return { isValid: false, error: 'Geçerli bir sayı girin' }
      if (rules.min !== undefined && num < rules.min) {
        return { isValid: false, error: `En az ${rules.min} olmalı` }
      }
      if (rules.max !== undefined && num > rules.max) {
        return { isValid: false, error: `En fazla ${rules.max} olabilir` }
      }
    }

    // Dropdown değer listesi kontrolü
    if (attribute.attributeType === 'dropdown' && typeof value === 'string') {
      const validIds = attribute.values.map(v => v.id)
      if (validIds.length > 0 && !validIds.includes(value) && !attribute.allowCustomValue) {
        return { isValid: false, error: 'Geçersiz değer' }
      }
    }

    return { isValid: true, error: null }
  }

  /**
   * Ürünün mevcut özellik değerlerini çeker
   */
  private async getProductAttributes(
    productId: string,
    marketplace: Marketplace
  ): Promise<Map<string, string>> {
    const attrs = await this.prisma.productAttribute.findMany({
      where: { productId, marketplace },
    })
    return new Map(attrs.map(a => [a.attributeId, a.valueText ?? a.valueId ?? '']))
  }

  /**
   * DB kaydını Attribute interface'ine dönüştürür
   */
  private mapToAttribute(raw: {
    attributeId: string
    attributeName: string
    attributeType: string
    isMandatory: boolean
    allowCustomValue: boolean
    values: unknown
    validationRules: unknown
    displayOrder: number
  }): Attribute {
    return {
      attributeId: raw.attributeId,
      attributeName: raw.attributeName,
      attributeType: raw.attributeType as Attribute['attributeType'],
      isMandatory: raw.isMandatory,
      allowCustomValue: raw.allowCustomValue,
      values: (raw.values as { id: string; name: string }[]) ?? [],
      validationRules: (raw.validationRules as Attribute['validationRules']) ?? {},
      displayOrder: raw.displayOrder,
    }
  }

  /**
   * Pazaryeri API'sinden özellik çeker
   * Her pazaryeri farklı endpoint kullanır
   */
  private async fetchFromMarketplaceAPI(
    marketplace: Marketplace,
    categoryId: string
  ): Promise<Attribute[]> {
    const apiKey = process.env[`${marketplace}_API_KEY`] ?? ''

    const endpoints: Record<Marketplace, string> = {
      TRENDYOL: `https://apigw.trendyol.com/integration/product/product-categories/${categoryId}/attributes`,
      HEPSIBURADA: `https://mpop.hepsiburada.com/product/api/categories/${categoryId}/attributes`,
      N11: `https://api.n11.com/cdn/category/${categoryId}/attribute`,
      PAZARAMA: `https://isortagimapi.pazarama.com/category/getCategoryTree`,
    }

    try {
      const response = await fetch(endpoints[marketplace], {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })
      if (!response.ok) return []
      const data = await response.json() as { categoryAttributes?: unknown[] }
      return this.normalizeAPIResponse(marketplace, data)
    } catch {
      return []
    }
  }

  /**
   * API yanıtını normalize eder
   */
  private normalizeAPIResponse(
    marketplace: Marketplace,
    data: unknown
  ): Attribute[] {
    // Her pazaryeri farklı format döndürür
    // Gerçek implementasyonda her biri ayrı işlenir
    return []
  }
}