import {
  AttributeRule,
  AttributeRuleMatchType,
  Marketplace,
  Prisma,
  PrismaClient,
} from '@prisma/client'

type RuleProduct = {
  id: string
  sku: string
  title: string
  brand: string | null
  attributes: Prisma.JsonValue
}

type RuleSuggestion = {
  productId: string
  sku: string
  productTitle: string
  ruleId: string
  ruleName: string
  attributeId: string
  attributeName: string
  valueId: string | null
  valueText: string | null
  confidence: number
}

export type AttributeRuleRunOptions = {
  overwrite?: boolean
  minConfidence?: number
  limit?: number
}

export type AttributeRulePreview = {
  mappingId: string
  marketplace: Marketplace
  productCount: number
  ruleCount: number
  applicable: number
  skippedExisting: number
  skippedManual: number
  suggestions: RuleSuggestion[]
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .toLowerCase()
    .trim()
}

function readXmlAttribute(attributes: Prisma.JsonValue, field: string): string | null {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null
  const record = attributes as Record<string, unknown>
  const wanted = normalizeText(field)

  for (const [key, value] of Object.entries(record)) {
    if (normalizeText(key) === wanted) {
      const text = String(value ?? '').replace(/<[^>]*>/g, '').trim()
      return text || null
    }
  }

  for (let index = 1; index <= 20; index++) {
    const name = record[`name${index}`] ?? record[`Name${index}`]
    if (normalizeText(name) !== wanted) continue
    const value = record[`value${index}`] ?? record[`Value${index}`]
    const text = String(value ?? '').replace(/<[^>]*>/g, '').trim()
    return text || null
  }

  return null
}

export function attributeRuleMatches(rule: Pick<AttributeRule, 'matchType' | 'matchField' | 'matchValue'>, product: RuleProduct): boolean {
  if (rule.matchType === 'ALWAYS') return true
  const expected = normalizeText(rule.matchValue)
  if (!expected) return false

  if (rule.matchType === 'TITLE_CONTAINS') {
    return normalizeText(product.title).includes(expected)
  }
  if (rule.matchType === 'BRAND_EQUALS') {
    return normalizeText(product.brand) === expected
  }
  if (rule.matchType === 'XML_ATTRIBUTE_EQUALS') {
    if (!rule.matchField) return false
    return normalizeText(readXmlAttribute(product.attributes, rule.matchField)) === expected
  }
  return false
}

function isValidRuleValue(
  rule: AttributeRule,
  definition: {
    attributeType: string
    allowCustomValue: boolean
    values: Prisma.JsonValue
  },
): boolean {
  if (!rule.valueId && !rule.valueText) return false
  if (!rule.valueId) return definition.attributeType !== 'dropdown' || definition.allowCustomValue
  if (!Array.isArray(definition.values) || definition.values.length === 0) {
    return definition.allowCustomValue || definition.attributeType !== 'dropdown'
  }
  return definition.values.some(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    return String((value as Record<string, unknown>).id ?? '') === rule.valueId
  })
}

export class AttributeRuleService {
  constructor(private readonly prisma: PrismaClient) {}

  private async evaluateMapping(
    mappingId: string,
    options: AttributeRuleRunOptions = {},
    includeAllSuggestions = false,
  ): Promise<AttributeRulePreview> {
    const mapping = await this.prisma.categoryMapping.findUnique({ where: { id: mappingId } })
    if (!mapping) throw new Error('Eslestirme bulunamadi')
    if (!mapping.marketplaceCategoryId) throw new Error('Pazaryeri kategori eslesmesi yok')

    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000)
    const minConfidence = Math.min(Math.max(options.minConfidence ?? 0.9, 0), 1)
    const products = await this.prisma.product.findMany({
      where: { sourceId: mapping.sourceId, categoryRaw: mapping.sourceCategory },
      select: { id: true, sku: true, title: true, brand: true, attributes: true },
      take: limit,
      orderBy: { id: 'asc' },
    })
    const rules = await this.prisma.attributeRule.findMany({
      where: {
        marketplace: mapping.marketplace,
        isActive: true,
        confidence: { gte: minConfidence },
        AND: [
          { OR: [{ sourceId: null }, { sourceId: mapping.sourceId }] },
          { OR: [{ sourceCategory: null }, { sourceCategory: mapping.sourceCategory }] },
          { OR: [{ marketplaceCategoryId: null }, { marketplaceCategoryId: mapping.marketplaceCategoryId }] },
        ],
      },
      orderBy: [{ priority: 'desc' }, { confidence: 'desc' }, { createdAt: 'asc' }],
    })

    const definitions = await this.prisma.marketplaceCategoryAttribute.findMany({
      where: {
        marketplace: mapping.marketplace,
        categoryId: mapping.marketplaceCategoryId,
        attributeId: { in: rules.map(rule => rule.attributeId) },
      },
    })
    const definitionById = new Map(definitions.map(definition => [definition.attributeId, definition]))
    const existing = products.length
      ? await this.prisma.productAttribute.findMany({
          where: {
            productId: { in: products.map(product => product.id) },
            marketplace: mapping.marketplace,
            attributeId: { in: rules.map(rule => rule.attributeId) },
          },
        })
      : []
    const existingByKey = new Map(existing.map(item => [`${item.productId}:${item.attributeId}`, item]))

    const suggestions: RuleSuggestion[] = []
    let skippedExisting = 0
    let skippedManual = 0

    for (const product of products) {
      const selectedAttributes = new Set<string>()
      for (const rule of rules) {
        if (selectedAttributes.has(rule.attributeId)) continue
        const definition = definitionById.get(rule.attributeId)
        if (!definition || !isValidRuleValue(rule, definition)) continue
        if (!attributeRuleMatches(rule, product)) continue

        const current = existingByKey.get(`${product.id}:${rule.attributeId}`)
        const hasValue = Boolean(current?.valueId || current?.valueText)
        if (hasValue && !current?.isInherited) {
          skippedManual++
          selectedAttributes.add(rule.attributeId)
          continue
        }
        if (hasValue && !options.overwrite) {
          skippedExisting++
          selectedAttributes.add(rule.attributeId)
          continue
        }

        suggestions.push({
          productId: product.id,
          sku: product.sku,
          productTitle: product.title,
          ruleId: rule.id,
          ruleName: rule.name,
          attributeId: rule.attributeId,
          attributeName: rule.attributeName ?? definition.attributeName,
          valueId: rule.valueId,
          valueText: rule.valueText,
          confidence: Number(rule.confidence),
        })
        selectedAttributes.add(rule.attributeId)
      }
    }

    return {
      mappingId,
      marketplace: mapping.marketplace,
      productCount: products.length,
      ruleCount: rules.length,
      applicable: suggestions.length,
      skippedExisting,
      skippedManual,
      suggestions: includeAllSuggestions ? suggestions : suggestions.slice(0, 500),
    }
  }

  previewMapping(mappingId: string, options: AttributeRuleRunOptions = {}) {
    return this.evaluateMapping(mappingId, options)
  }

  async applyMapping(mappingId: string, options: AttributeRuleRunOptions = {}) {
    const preview = await this.evaluateMapping(mappingId, options, true)
    for (const suggestion of preview.suggestions) {
      await this.prisma.productAttribute.upsert({
        where: {
          productId_marketplace_attributeId: {
            productId: suggestion.productId,
            marketplace: preview.marketplace,
            attributeId: suggestion.attributeId,
          },
        },
        update: {
          attributeName: suggestion.attributeName,
          valueId: suggestion.valueId,
          valueText: suggestion.valueText,
          isInherited: true,
          savedBy: `system:attribute-rule:${suggestion.ruleId}`,
          savedAt: new Date(),
        },
        create: {
          productId: suggestion.productId,
          marketplace: preview.marketplace,
          attributeId: suggestion.attributeId,
          attributeName: suggestion.attributeName,
          valueId: suggestion.valueId,
          valueText: suggestion.valueText,
          isInherited: true,
          savedBy: `system:attribute-rule:${suggestion.ruleId}`,
        },
      })
    }
    return { ...preview, applied: preview.suggestions.length }
  }
}
