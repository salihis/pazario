// src/services/CategoryAttributeService.ts

import { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger'
import { applyXmlColorSizeOverrides } from './XmlAttributeOverrideService'

// â”€â”€â”€ INTERFACE'LER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ SABÄ°TLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CACHE_TTL_DAYS = 7
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000

type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'
let pazaramaTokenCache: { token: string; expiresAt: number } | null = null

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .toLowerCase()
}

function isColorLikeName(name: string): boolean {
  const text = normalizeText(name)
  return text.includes('renk') || text.includes('web color')
}

function isSizeLikeName(name: string): boolean {
  const text = normalizeText(name)
  return text.includes('beden') || text.includes('size') || text.includes('olcu') || text.includes('olcu')
}

function isColorOrSizeLikeName(name: string): boolean {
  return isColorLikeName(name) || isSizeLikeName(name)
}

function extractAttributeValues(item: any): { id: string; name: string }[] {
  const candidates = [
    item?.attributeValues,
    item?.values,
    item?.valueList,
    item?.attributeValueList,
    item?.attributeValueResponses,
    item?.options,
    item?.items,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const normalized = candidate
      .map((value: any) => ({
        id: String(value?.id ?? value?.attributeValueId ?? value?.attributeValueID ?? value?.valueId ?? value?.optionId ?? ''),
        name: String(value?.name ?? value?.value ?? value?.attributeValue ?? value?.displayName ?? value?.text ?? ''),
      }))
      .filter((value: { id: string; name: string }) => value.id && value.name)
    if (normalized.length > 0) return normalized
  }

  return []
}

// â”€â”€â”€ SERVÄ°S â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class CategoryAttributeService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Kategori Ã¶zelliklerini getirir
   * Stale-while-revalidate: 7 gÃ¼nden eski â†’ dÃ¶ndÃ¼r + arka planda refresh
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
        // Stale: dÃ¶ndÃ¼r + arka planda yenile
        this.refreshFromAPI(marketplace, categoryId).catch((err: unknown) => {
          logger.error({ err, marketplace, categoryId }, 'Stale-while-revalidate yenileme hatasÄ±')
        })
      }

      if (productId) {
        await this.syncXmlOverridesForProduct(productId, marketplace, categoryId)
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

    // Cache yok â€” API'den Ã§ek
    await this.refreshFromAPI(marketplace, categoryId)

    const fresh = await this.prisma.marketplaceCategoryAttribute.findMany({
      where: { marketplace, categoryId },
      orderBy: [{ isMandatory: 'desc' }, { displayOrder: 'asc' }],
    })

    if (productId) {
      await this.syncXmlOverridesForProduct(productId, marketplace, categoryId)
    }

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
   * API'den kategori Ã¶zelliklerini Ã§eker ve DB'ye yazar
   */
  async refreshFromAPI(marketplace: Marketplace, categoryId: string): Promise<number> {
    try {
      const attrs = await this.fetchFromMarketplaceAPI(marketplace, categoryId)
      const enrichedAttrs = marketplace === 'TRENDYOL'
        ? await this.enrichTrendyolAttributeValues(categoryId, attrs)
        : attrs

      for (const attr of enrichedAttrs) {
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
      return enrichedAttrs.length
    } catch (e) {
      logger.error({ err: e, marketplace, categoryId }, 'Kategori ozellikleri yenilenemedi')
      return 0
    }
  }

  /**
   * FormField dizisi oluÅŸturur â€” mevcut deÄŸerleri ekler
   */
  async buildFormSchema(
    attributes: Attribute[],
    productAttrs: Map<string, string>
  ): Promise<FormField[]> {
    return attributes.map(attr => {
      const storedValue = productAttrs.get(attr.attributeId) ?? null
      const currentValue = this.resolveStoredValueForForm(attr, storedValue)
      const validation = this.validateValue(attr, currentValue)

      return {
        ...attr,
        currentValue,
        isValid: validation.isValid,
        validationError: validation.error,
      }
    })
  }

  private resolveStoredValueForForm(
    attribute: Attribute,
    storedValue: string | null
  ): string | null {
    if (!storedValue) return null
    if (!['dropdown', 'multi_select', 'color'].includes(attribute.attributeType)) {
      return storedValue
    }

    const byId = attribute.values.find(value => value.id === storedValue)
    if (byId) return byId.id

    const normalizedStoredValue = normalizeText(storedValue)
    const byName = attribute.values.find(value => normalizeText(value.name) === normalizedStoredValue)
      ?? attribute.values.find(value => normalizeText(value.name).includes(normalizedStoredValue))

    if (byName) return byName.id
    if (attribute.allowCustomValue || isColorOrSizeLikeName(attribute.attributeName)) return storedValue
    return null
  }

  /**
   * DeÄŸer validasyonu
   */
  validateValue(
    attribute: Attribute,
    value: string | string[] | boolean | null
  ): ValidationResult {
    // Zorunlu alan boÅŸ
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

    // Min/max sayÄ±
    if (attribute.attributeType === 'number' && typeof value === 'string') {
      const num = parseFloat(value)
      if (isNaN(num)) return { isValid: false, error: 'GeÃ§erli bir sayÄ± girin' }
      if (rules.min !== undefined && num < rules.min) {
        return { isValid: false, error: `En az ${rules.min} olmalÄ±` }
      }
      if (rules.max !== undefined && num > rules.max) {
        return { isValid: false, error: `En fazla ${rules.max} olabilir` }
      }
    }

    // Dropdown deÄŸer listesi kontrolÃ¼
    if (attribute.attributeType === 'dropdown' && typeof value === 'string') {
      const validIds = attribute.values.map(v => v.id)
      if (validIds.length > 0 && !validIds.includes(value) && !attribute.allowCustomValue) {
        return { isValid: false, error: 'GeÃ§ersiz deÄŸer' }
      }
    }

    return { isValid: true, error: null }
  }

  /**
   * ÃœrÃ¼nÃ¼n mevcut Ã¶zellik deÄŸerlerini Ã§eker
   */
  private async getProductAttributes(
    productId: string,
    marketplace: Marketplace
  ): Promise<Map<string, string>> {
    const attrs = await this.prisma.productAttribute.findMany({
      where: { productId, marketplace },
    })
    return new Map(attrs.map(a => [a.attributeId, a.valueId ?? a.valueText ?? '']))
  }

  /**
   * DB kaydÄ±nÄ± Attribute interface'ine dÃ¶nÃ¼ÅŸtÃ¼rÃ¼r
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
   * Pazaryeri API'sinden Ã¶zellik Ã§eker
   * Her pazaryeri farklÄ± endpoint kullanÄ±r
   */
  private async fetchFromMarketplaceAPI(
    marketplace: Marketplace,
    categoryId: string
  ): Promise<Attribute[]> {
    const endpoints: Record<Marketplace, string> = {
      TRENDYOL: `https://apigw.trendyol.com/integration/product/product-categories/${categoryId}/attributes`,
      HEPSIBURADA: `https://mpop.hepsiburada.com/product/api/categories/${categoryId}/attributes`,
      N11: `https://api.n11.com/cdn/category/${categoryId}/attribute`,
      PAZARAMA: `https://isortagimapi.pazarama.com/category/getCategoryWithAttributes?Id=${encodeURIComponent(categoryId)}`,
    }

    try {
      const headers = await this.buildHeaders(marketplace)
      const response = await fetch(endpoints[marketplace], {
        headers,
      })
      if (!response.ok) return []
      const data = await response.json()
      return this.normalizeAPIResponse(marketplace, data)
    } catch {
      return []
    }
  }

  private async enrichTrendyolAttributeValues(categoryId: string, attributes: Attribute[]): Promise<Attribute[]> {
    const headers = await this.buildHeaders('TRENDYOL')
    const results: Attribute[] = await Promise.all(attributes.map(async (attr): Promise<Attribute> => {
      const listLike = isColorOrSizeLikeName(attr.attributeName)
      if (!listLike && attr.values.length > 0) return attr

      try {
        const url = `https://apigw.trendyol.com/integration/product/categories/${categoryId}/attributes/${attr.attributeId}/values?page=0&size=1000`
        const response = await fetch(url, { headers })
        if (!response.ok) return attr

        const data = await response.json()
        const root = data as any
        const values = Array.isArray(root?.content)
          ? root.content
              .map((item: any) => ({
                id: String(item?.attributeValueId ?? item?.id ?? ''),
                name: String(item?.attributeValue ?? item?.name ?? item?.value ?? ''),
              }))
              .filter((value: { id: string; name: string }) => value.id && value.name)
          : []

        if (values.length === 0) return attr
        return {
          ...attr,
          attributeType: 'dropdown',
          allowCustomValue: false,
          values,
        }
      } catch {
        return attr
      }
    }))

    return results
  }

  private async buildHeaders(marketplace: Marketplace): Promise<Record<string, string>> {
    if (marketplace === 'TRENDYOL') {
      const apiKey = process.env.TY_API_KEY
      const apiSecret = process.env.TY_API_SECRET
      if (!apiKey || !apiSecret) return { 'User-Agent': 'PazarioIntegration' }
      return {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
        'User-Agent': 'PazarioIntegration',
      }
    }

    if (marketplace === 'N11') {
      return {
        appkey: process.env.N11_APPKEY ?? '',
        appsecret: process.env.N11_APPSECRET ?? '',
      }
    }

    if (marketplace === 'PAZARAMA') {
      return { Authorization: `Bearer ${await this.getPazaramaAccessToken()}` }
    }

    return {}
  }

  private async getPazaramaAccessToken(): Promise<string> {
    if (pazaramaTokenCache && Date.now() < pazaramaTokenCache.expiresAt) {
      return pazaramaTokenCache.token
    }

    const clientId = process.env.PZ_CLIENT_ID
    const clientSecret = process.env.PZ_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('Pazarama API bilgileri eksik')

    const response = await fetch('https://isortagimgiris.pazarama.com/connect/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'merchantgatewayapi.fullaccess',
      }).toString(),
    })
    if (!response.ok) throw new Error(`Pazarama token alinamadi: HTTP ${response.status}`)

    const payload = await response.json() as Record<string, any>
    const token = payload?.access_token || payload?.accessToken || payload?.data?.access_token || payload?.data?.accessToken
    if (!token) throw new Error('Pazarama token cevabinda access token yok')

    pazaramaTokenCache = {
      token,
      expiresAt: Date.now() + 55 * 60 * 1000,
    }
    return token
  }

  private async syncXmlOverridesForProduct(productId: string, marketplace: Marketplace, categoryId: string): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, title: true, categoryRaw: true, attributes: true },
    })
    if (!product) return
    await applyXmlColorSizeOverrides(this.prisma, product, marketplace, categoryId)
  }

  /**
   * API yanÄ±tÄ±nÄ± normalize eder
   */
  private normalizeAPIResponse(
    marketplace: Marketplace,
    data: unknown
  ): Attribute[] {
    if (marketplace === 'TRENDYOL') return this.normalizeTrendyolAttributes(data)
    if (marketplace === 'N11') return this.normalizeN11Attributes(data)
    if (marketplace === 'PAZARAMA') return this.normalizePazaramaAttributes(data)
    return []
  }

  private normalizeTrendyolAttributes(data: unknown): Attribute[] {
    const root = data as any
    const attrs = Array.isArray(root?.categoryAttributes) ? root.categoryAttributes : []
    return attrs.map((item: any, index: number) => {
      const attributeType: Attribute['attributeType'] = item?.allowMultipleAttributeValues
        ? 'multi_select'
        : isColorOrSizeLikeName(String(item?.attribute?.name ?? item?.attributeName ?? ''))
          ? 'dropdown'
          : Array.isArray(item?.attributeValues) && item.attributeValues.length > 0
            ? 'dropdown'
            : 'free_text'

      return {
        attributeId: String(item?.attribute?.id ?? item?.attributeId ?? ''),
        attributeName: String(item?.attribute?.name ?? item?.attributeName ?? ''),
        attributeType,
        isMandatory: Boolean(item?.required ?? item?.isMandatory),
        allowCustomValue: Array.isArray(item?.attributeValues) ? item.attributeValues.length === 0 : Boolean(item?.allowCustom ?? item?.allowCustomValue),
        values: Array.isArray(item?.attributeValues)
          ? item.attributeValues
              .map((value: any) => ({ id: String(value.id), name: String(value.name ?? value.value ?? '') }))
              .filter((value: { id: string; name: string }) => value.id && value.name)
          : [],
        validationRules: {},
        displayOrder: index,
      }
    }).filter((attr: Attribute) => attr.attributeId && attr.attributeName)
  }

  private normalizeN11Attributes(data: unknown): Attribute[] {
    const root = data as any
    const attrs = Array.isArray(root?.categoryAttributes) ? root.categoryAttributes : []
    return attrs.map((item: any, index: number) => {
      const attributeType: Attribute['attributeType'] = extractAttributeValues(item).length > 0 || isColorOrSizeLikeName(String(item?.attributeName ?? ''))
        ? 'dropdown'
        : 'free_text'

      return {
        attributeId: String(item?.attributeId ?? ''),
        attributeName: String(item?.attributeName ?? ''),
        attributeType,
        isMandatory: Boolean(item?.isMandatory),
        allowCustomValue: extractAttributeValues(item).length === 0 ? true : Boolean(item?.isCustomValue),
        values: extractAttributeValues(item),
        validationRules: {},
        displayOrder: Number(item?.attributeOrder ?? index),
      }
    }).filter((attr: Attribute) => attr.attributeId && attr.attributeName)
  }

  private normalizePazaramaAttributes(data: unknown): Attribute[] {
    const root = data as any
    const attrs = Array.isArray(root?.data?.attributes)
      ? root.data.attributes
      : Array.isArray(root?.attributes)
        ? root.attributes
        : []

    return attrs.map((item: any, index: number) => {
      const attributeType: Attribute['attributeType'] = extractAttributeValues(item).length > 0 || isColorOrSizeLikeName(String(item?.displayName ?? item?.name ?? item?.attributeName ?? ''))
        ? 'dropdown'
        : 'free_text'

      return {
        attributeId: String(item?.id ?? item?.attributeId ?? ''),
        attributeName: String(item?.displayName ?? item?.name ?? item?.attributeName ?? ''),
        attributeType,
        isMandatory: Boolean(item?.isRequired ?? item?.required ?? item?.isMandatory),
        allowCustomValue: extractAttributeValues(item).length === 0,
        values: extractAttributeValues(item),
        validationRules: {},
        displayOrder: index,
      }
    }).filter((attr: Attribute) => attr.attributeId && attr.attributeName)
  }
}

