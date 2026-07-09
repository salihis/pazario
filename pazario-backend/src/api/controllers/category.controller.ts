// src/api/controllers/category.controller.ts

import { Request, Response } from 'express'
import { Marketplace, PrismaClient } from '@prisma/client'
import axios from 'axios'
import { CategoryAttributeService } from '../../services/CategoryAttributeService'
import { getXmlAttributeOverride } from '../../services/XmlAttributeOverrideService'
import { decodeXmlBuffer } from '../../utils/xmlFetch'

const prisma = new PrismaClient()
const categoryAttributeService = new CategoryAttributeService(prisma)
const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const MIN_SUGGESTION_CONFIDENCE = 0.55
const TRENDYOL_CATEGORY_URL = 'https://apigw.trendyol.com/integration/product/product-categories'
const N11_CATEGORY_URL = 'https://api.n11.com/cdn/categories'
const PAZARAMA_TOKEN_URL = 'https://isortagimgiris.pazarama.com/connect/token'
const PAZARAMA_CATEGORY_URL = 'https://isortagimapi.pazarama.com/category/getCategoryTree'

type CategorySuggestion = {
  categoryId: string
  categoryPath: string
  confidence: number
  reason: string
}

type MarketplaceCategoryRow = {
  categoryId: string
  categoryName: string
  categoryPath: string
  parentId: string | null
  isLeaf: boolean
}
type AttributePayload = { attributeId: string; valueId?: string; valueText?: string }

let pazaramaTokenCache: { token: string; expiresAt: number } | null = null

async function getJsonWithCharset(url: string, options: Parameters<typeof axios.get>[1] = {}) {
  const response = await axios.get<ArrayBuffer>(url, {
    ...options,
    responseType: 'arraybuffer',
    transformResponse: data => data,
  })
  const text = decodeXmlBuffer(response.data, response.headers['content-type'])
  return JSON.parse(text)
}

async function syncCategoryAttributesForApproval(marketplace: Marketplace, categoryId: string) {
  if (marketplace === 'HEPSIBURADA') return { attributesSynced: 0, attributesSyncError: null as string | null }
  try {
    const attributesSynced = await categoryAttributeService.refreshFromAPI(marketplace, categoryId)
    return { attributesSynced, attributesSyncError: null as string | null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kategori ozellikleri alinamadi'
    return { attributesSynced: 0, attributesSyncError: message }
  }
}

function attributeValueKey(attr: { valueId: string | null; valueText: string | null }) {
  return attr.valueId ? `id:${attr.valueId}` : attr.valueText ? `text:${attr.valueText}` : ''
}

function attributeValueFromKey(key: string) {
  if (key.startsWith('id:')) return { valueId: key.slice(3), valueText: null }
  if (key.startsWith('text:')) return { valueId: null, valueText: key.slice(5) }
  return { valueId: null, valueText: null }
}

function buildMappingWhere(req: Request, defaultStatus?: string) {
  const where: Record<string, unknown> = {}
  const marketplace = String(req.query.marketplace || '')
  const status = String(req.query.status || defaultStatus || '')
  const sourceId = String(req.query.sourceId || '')
  const search = String(req.query.search || '').trim()

  if (marketplace) where.marketplace = marketplace
  if (status && !['ALL', 'TUMU', 'TÜMÜ'].includes(status.toLocaleUpperCase('tr-TR'))) where.status = status
  if (sourceId) where.sourceId = sourceId
  if (search) {
    where.sourceCategory = { contains: search, mode: 'insensitive' }
  }

  return where
}

function normalizeCategoryText(value: unknown): string {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('tr-TR')
}

function categoryTokens(value: unknown): string[] {
  const stopWords = new Set(['ve', 'ile', 'icin', 'için', 'amp', 'the', 'bir', 'urun', 'ürün'])
  return normalizeCategoryText(value)
    .split(/\s+/)
    .filter(token => token.length >= 3 && !stopWords.has(token))
}

function categoryDomain(value: unknown): 'UNDERWEAR' | 'JEWELRY' | 'ELECTRONICS' | 'OTHER' {
  const text = normalizeCategoryText(value)
  if (/(gecelik|babydoll|jartiyer|sutyen|sütyen|kulot|külot|fantazi|fantezi|string|ic giyim|iç giyim|sabahlık|sabahlik)/.test(text)) return 'UNDERWEAR'
  if (/(taki|takı|bijuteri|kolye|kupe|küpe|bileklik|yuzuk|yüzük|halhal|sahmeran|şahmeran|charm|piercing)/.test(text)) return 'JEWELRY'
  if (/(elektronik|telefon|tablet|kilif|kılıf|kulaklik|kulaklık|ekran koruyucu|kamera lens|akilli saat|akıllı saat)/.test(text)) return 'ELECTRONICS'
  return 'OTHER'
}

function strictCategoryDomain(value: unknown): 'UNDERWEAR' | 'JEWELRY' | 'FASHION_ACCESSORY' | 'ELECTRONICS' | 'AUTOMOTIVE' | 'HOME_BUILDING' | 'OTHER' {
  const text = normalizeCategoryText(value)
  if (/(otomobil|motosiklet|oto |oto aksesuar|yedek parca|fren|debriyaj|balata|motorlu)/.test(text)) return 'AUTOMOTIVE'
  if (/(yapi market|elektrik tesisat|hirdavat|insaat|tesisat|nalbur|bahce)/.test(text)) return 'HOME_BUILDING'
  if (/(gecelik|babydoll|jartiyer|sutyen|kulot|fantazi|fantezi|string|ic giyim|sabahlik|pijama|tayt|elbise|korse)/.test(text)) return 'UNDERWEAR'
  if (/(taki|bijuteri|kolye|kupe|bileklik|yuzuk|halhal|sahmeran|charm|piercing)/.test(text)) return 'JEWELRY'
  if (/(sac aksesuar|sac tokasi|toka|tarak|saat|kol saati|aksesuar)/.test(text)) return 'FASHION_ACCESSORY'
  if (/(elektronik|telefon|tablet|kilif|kulaklik|ekran koruyucu|kamera lens|akilli saat)/.test(text)) return 'ELECTRONICS'
  return 'OTHER'
}

function isCompatibleCategory(sourceCategory: string, categoryPath: string): boolean {
  const sourceDomain = strictCategoryDomain(sourceCategory)
  const targetDomain = strictCategoryDomain(categoryPath)
  const sourcePath = normalizeCategoryText(sourceCategory)
  const targetPath = normalizeCategoryText(categoryPath)

  if (['AUTOMOTIVE', 'HOME_BUILDING'].includes(targetDomain) && !['AUTOMOTIVE', 'HOME_BUILDING'].includes(sourceDomain)) {
    return false
  }

  if (!sourcePath.includes('hamile') && targetPath.includes('hamile')) return false
  if (!sourcePath.includes('buyuk beden') && !sourcePath.includes('büyük beden') && targetPath.includes('buyuk beden')) return false
  if (!sourcePath.includes('cocuk') && !sourcePath.includes('çocuk') && targetPath.includes('cocuk')) return false
  if (!sourcePath.includes('erkek') && targetPath.includes('erkek')) return false

  if (sourceDomain === 'UNDERWEAR') return targetPath.includes('giyim')
  if (sourceDomain === 'JEWELRY') return /(taki|aksesuar|bijuteri|mucevher|kupe|kolye|yuzuk|bileklik|halhal|piercing)/.test(targetPath)
  if (sourceDomain === 'FASHION_ACCESSORY') return /(moda|giyim|aksesuar|taki|bijuteri|saat|sac|toka|canta|gozluk)/.test(targetPath)

  return true
}

function categoryLeaf(value: unknown): string {
  const parts = String(value ?? '')
    .split(/>>>|>|\/|\\/g)
    .map(part => part.trim())
    .filter(Boolean)

  return parts[parts.length - 1] ?? String(value ?? '')
}

function isGenericCategoryToken(token: string): boolean {
  return [
    'buyuk',
    'beden',
    'takim',
    'aksesuar',
    'giyim',
    'bayan',
    'kadin',
    'erkek',
    'cocuk',
    'sevgili',
    'diger',
    'urun',
    'urunleri',
  ].some(generic => token === generic || token.startsWith(generic))
}

function scoreCategory(sourceCategory: string, categoryPath: string, categoryName: string): number {
  const source = normalizeCategoryText(sourceCategory)
  const targetPath = normalizeCategoryText(categoryPath)
  const targetName = normalizeCategoryText(categoryName)
  const sourceTokens = categoryTokens(sourceCategory)
  if (sourceTokens.length === 0) return 0
  if (!isCompatibleCategory(sourceCategory, categoryPath)) return 0

  const sourceLeafTokens = categoryTokens(categoryLeaf(sourceCategory))
  const targetLeafTokens = new Set([...categoryTokens(categoryLeaf(categoryPath)), ...categoryTokens(categoryName)])
  const meaningfulLeafTokens = sourceLeafTokens.filter(token => !isGenericCategoryToken(token))
  const leafMatches = meaningfulLeafTokens.filter(token =>
    [...targetLeafTokens].some(targetToken => targetToken === token || targetToken.includes(token) || token.includes(targetToken))
  )
  const requiredLeafMatches = meaningfulLeafTokens.length >= 2 ? 2 : meaningfulLeafTokens.length
  if (requiredLeafMatches > 0 && leafMatches.length < requiredLeafMatches) return 0

  let score = 0
  const genericTokens = new Set(['buyuk', 'büyük', 'beden', 'takim', 'takım', 'aksesuar', 'giyim', 'bayan', 'kadin', 'kadın'])
  for (const token of sourceTokens) {
    const weight = genericTokens.has(token) ? 0.25 : 1
    if (targetName === token) score += 0.55 * weight
    else if (targetName.includes(token)) score += 0.38 * weight
    else if (targetPath.includes(token)) score += 0.20 * weight
  }
  if (targetPath.includes(source)) score += 0.35
  if (
    source === targetName ||
    source.startsWith(`${targetName} `) && targetName.split(/\s+/).length > 1 ||
    targetName.split(/\s+/).length > 1 && source.includes(targetName)
  ) {
    score += 0.25
  }

  const sourceDomain = categoryDomain(sourceCategory)
  const targetDomain = categoryDomain(categoryPath)
  if (sourceDomain !== 'OTHER' && targetDomain === sourceDomain) score += 0.30
  if (sourceDomain !== 'OTHER' && targetDomain !== 'OTHER' && targetDomain !== sourceDomain) score -= 0.60
  if (sourceDomain === 'UNDERWEAR' && !targetPath.includes('giyim')) score -= 0.40
  if (sourceDomain === 'UNDERWEAR' && source.includes('aksesuar') && targetPath.includes('giyim aksesuar')) score += 0.65
  if (sourceDomain === 'UNDERWEAR' && source.includes('jartiyer') && targetPath.includes('jartiyer')) score += 0.45
  if (sourceDomain === 'UNDERWEAR' && source.includes('string') && targetPath.includes('fantezi') && targetPath.includes('string')) score += 0.20
  if (sourceDomain === 'JEWELRY' && !targetPath.includes('aksesuar') && !targetPath.includes('taki') && !targetPath.includes('takı')) score -= 0.25

  return Math.max(0, Math.min(0.99, Number(score.toFixed(3))))
}

async function buildSuggestions(sourceCategory: string, marketplace: Marketplace): Promise<CategorySuggestion[]> {
  const tokens = categoryTokens(sourceCategory)
  const candidates = await prisma.marketplaceCategory.findMany({
    where: {
      marketplace,
      isLeaf: true,
      ...(tokens.length > 0
        ? {
            OR: tokens.flatMap(token => [
              { categoryName: { contains: token, mode: 'insensitive' as const } },
              { categoryPath: { contains: token, mode: 'insensitive' as const } },
            ]),
          }
        : {}),
    },
    take: 200,
  })
  const sourceDomain = categoryDomain(sourceCategory)
  const scopedCandidates = candidates.filter(category => {
    if (!isCompatibleCategory(sourceCategory, category.categoryPath)) return false
    if (sourceDomain === 'UNDERWEAR') return normalizeCategoryText(category.categoryPath).includes('giyim')
    if (sourceDomain === 'JEWELRY') {
      const path = normalizeCategoryText(category.categoryPath)
      return path.includes('aksesuar') || path.includes('taki') || path.includes('takı')
    }
    return true
  })

  return scopedCandidates
    .map(category => ({
      categoryId: category.categoryId,
      categoryPath: category.categoryPath,
      confidence: scoreCategory(sourceCategory, category.categoryPath, category.categoryName),
      reason: 'Kaynak kategori kelimeleri pazaryeri kategori yolu ile eslestirildi.',
    }))
    .filter(suggestion => suggestion.confidence >= MIN_SUGGESTION_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
}

async function refreshPendingSuggestions(marketplaces: Marketplace[], sourceId?: string) {
  const pending = await prisma.categoryMapping.findMany({
    where: {
      marketplace: { in: marketplaces },
      status: 'PENDING',
      ...(sourceId ? { sourceId } : {}),
    },
  })

  let updated = 0
  for (const mapping of pending) {
    const suggestions = await buildSuggestions(mapping.sourceCategory, mapping.marketplace)
    const best = suggestions[0]
    if (!best) {
      await prisma.categoryMapping.update({
        where: { id: mapping.id },
        data: {
          aiSuggested: false,
          aiConfidence: null,
          aiReason: null,
          marketplaceCategoryId: null,
          marketplaceCategoryPath: null,
          allSuggestions: [],
        },
      })
      continue
    }

    await prisma.categoryMapping.update({
      where: { id: mapping.id },
      data: {
        aiSuggested: true,
        aiConfidence: best.confidence,
        aiReason: best.reason,
        marketplaceCategoryId: best.categoryId,
        marketplaceCategoryPath: best.categoryPath,
        allSuggestions: suggestions,
      },
    })
    updated += 1
  }

  return { scanned: pending.length, updated }
}

function flattenTrendyolCategories(
  nodes: any[],
  parentId: string | null = null,
  parentPath = ''
): MarketplaceCategoryRow[] {
  return nodes.flatMap(node => {
    const categoryId = String(node.id ?? node.categoryId ?? '')
    const categoryName = String(node.name ?? node.categoryName ?? '')
    if (!categoryId || !categoryName) return []

    const children = Array.isArray(node.subCategories)
      ? node.subCategories
      : Array.isArray(node.children)
        ? node.children
        : []
    const categoryPath = parentPath ? `${parentPath} > ${categoryName}` : categoryName

    return [
      { categoryId, categoryName, categoryPath, parentId, isLeaf: children.length === 0 },
      ...flattenTrendyolCategories(children, categoryId, categoryPath),
    ]
  })
}

function flattenN11Categories(
  nodes: any[],
  parentId: string | null = null,
  parentPath = ''
): MarketplaceCategoryRow[] {
  return nodes.flatMap(node => {
    const categoryId = String(node.id ?? node.categoryId ?? '')
    const categoryName = String(node.name ?? node.categoryName ?? '')
    if (!categoryId || !categoryName) return []

    const children = Array.isArray(node.subCategories)
      ? node.subCategories
      : Array.isArray(node.children)
        ? node.children
        : []
    const categoryPath = parentPath ? `${parentPath} > ${categoryName}` : categoryName

    return [
      { categoryId, categoryName, categoryPath, parentId, isLeaf: children.length === 0 },
      ...flattenN11Categories(children, categoryId, categoryPath),
    ]
  })
}

function flattenPazaramaCategories(nodes: any[]): MarketplaceCategoryRow[] {
  return nodes.map(node => {
    const parentCategories = Array.isArray(node.parentCategories) ? node.parentCategories.map(String) : []
    const categoryName = String(node.displayName || node.name || '')
    const categoryPath = parentCategories.length > 0
      ? [...parentCategories, categoryName].filter(Boolean).join(' > ')
      : categoryName

    return {
      categoryId: String(node.id ?? ''),
      categoryName,
      categoryPath,
      parentId: node.parentId ? String(node.parentId) : null,
      isLeaf: Boolean(node.leaf ?? node.isLeaf ?? true),
    }
  }).filter(category => category.categoryId && category.categoryName)
}

async function getPazaramaAccessToken(): Promise<string> {
  if (pazaramaTokenCache && Date.now() < pazaramaTokenCache.expiresAt) {
    return pazaramaTokenCache.token
  }

  const clientId = process.env.PZ_CLIENT_ID
  const clientSecret = process.env.PZ_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Pazarama API bilgileri eksik')

  const response = await axios.post(
    PAZARAMA_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'merchantgatewayapi.fullaccess',
    }).toString(),
    {
      auth: { username: clientId, password: clientSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    }
  )
  const payload = response.data as Record<string, any>
  const token = payload?.access_token || payload?.accessToken || payload?.data?.access_token || payload?.data?.accessToken
  if (!token) throw new Error('Pazarama token cevabinda access token yok')

  pazaramaTokenCache = {
    token,
    expiresAt: Date.now() + 55 * 60 * 1000,
  }
  return token
}

async function fetchMarketplaceCategories(marketplace: Marketplace): Promise<MarketplaceCategoryRow[]> {
  if (marketplace === 'TRENDYOL') {
    const apiKey = process.env.TY_API_KEY
    const apiSecret = process.env.TY_API_SECRET
    const root = await getJsonWithCharset(TRENDYOL_CATEGORY_URL, {
      ...(apiKey && apiSecret ? { auth: { username: apiKey, password: apiSecret } } : {}),
      timeout: 60000,
    })
    const nodes = Array.isArray(root?.categories) ? root.categories : Array.isArray(root) ? root : []
    return flattenTrendyolCategories(nodes)
  }

  if (marketplace === 'N11') {
    const appKey = process.env.N11_APPKEY
    const appSecret = process.env.N11_APPSECRET
    if (!appKey || !appSecret) throw new Error('N11 API bilgileri eksik')

    const root = await getJsonWithCharset(N11_CATEGORY_URL, {
      headers: { appkey: appKey, appsecret: appSecret },
      timeout: 60000,
    })
    const nodes = Array.isArray(root?.categories)
      ? root.categories
      : Array.isArray(root?.data)
        ? root.data
        : Array.isArray(root)
          ? root
          : []
    return flattenN11Categories(nodes)
  }

  if (marketplace === 'PAZARAMA') {
    const token = await getPazaramaAccessToken()
    const root = await getJsonWithCharset(PAZARAMA_CATEGORY_URL, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    })
    const nodes = Array.isArray(root?.data) ? root.data : Array.isArray(root) ? root : []
    return flattenPazaramaCategories(nodes)
  }

  throw new Error(`${marketplace} kategori agaci senkronizasyonu devre disi`)
}

/**
 * GET /category-mappings
 * Kategori eslestirmelerini filtreli listeler
 */
export async function getCategoryMappings(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '50'))
    const skip = (page - 1) * limit
    const where = buildMappingWhere(req)

    const [data, total] = await Promise.all([
      prisma.categoryMapping.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: { source: { select: { id: true, name: true } } },
      }),
      prisma.categoryMapping.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

/**
 * POST /category-mappings/generate
 * Urunlerdeki kaynak kategorilerden bekleyen eslestirme kayitlari olusturur
 */
export async function generateCategoryMappings(req: Request, res: Response) {
  try {
    const sourceId = String(req.body.sourceId || req.query.sourceId || '')
    const marketplace = String(req.body.marketplace || req.query.marketplace || '')
    const marketplaces = marketplace ? [marketplace as Marketplace] : MARKETPLACES

    const products = await prisma.product.findMany({
      where: {
        ...(sourceId ? { sourceId } : {}),
        categoryRaw: { not: null },
        stock: { gt: 6 },
      },
      distinct: ['sourceId', 'categoryRaw'],
      select: { sourceId: true, categoryRaw: true },
    })

    const data = products
      .filter(product => product.categoryRaw && product.categoryRaw.trim())
      .flatMap(product =>
        marketplaces.map(mp => ({
          sourceId: product.sourceId,
          sourceCategory: product.categoryRaw as string,
          marketplace: mp,
          status: 'PENDING' as const,
          aiSuggested: false,
          allSuggestions: [],
        }))
      )

    if (data.length === 0) {
      res.json({ success: true, data: { created: 0, categories: 0, targetMappings: 0 } })
      return
    }

    const result = await prisma.categoryMapping.createMany({
      data,
      skipDuplicates: true,
    })
    const suggestionResult = await refreshPendingSuggestions(marketplaces, sourceId || undefined)

    res.status(201).json({
      success: true,
      data: {
        created: result.count,
        categories: products.length,
        targetMappings: data.length,
        suggestionsUpdated: suggestionResult.updated,
        suggestionsScanned: suggestionResult.scanned,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Kategori eslestirmeleri olusturulamadi' })
  }
}

export async function syncMarketplaceCategories(req: Request, res: Response) {
  try {
    const marketplace = String(req.params.marketplace || '').toUpperCase() as Marketplace
    if (!MARKETPLACES.includes(marketplace) || marketplace === 'HEPSIBURADA') {
      res.status(400).json({ success: false, error: 'Kategori agaci senkronizasyonu bu pazaryeri icin devre disi' })
      return
    }

    const categories = await fetchMarketplaceCategories(marketplace)
    const now = new Date()

    for (const chunk of Array.from({ length: Math.ceil(categories.length / 500) }, (_, index) => categories.slice(index * 500, (index + 1) * 500))) {
      await prisma.$transaction(
        chunk.map(category =>
          prisma.marketplaceCategory.upsert({
            where: { marketplace_categoryId: { marketplace, categoryId: category.categoryId } },
            update: {
              categoryName: category.categoryName,
              categoryPath: category.categoryPath,
              parentId: category.parentId,
              isLeaf: category.isLeaf,
              fetchedAt: now,
            },
            create: {
              marketplace,
              categoryId: category.categoryId,
              categoryName: category.categoryName,
              categoryPath: category.categoryPath,
              parentId: category.parentId,
              isLeaf: category.isLeaf,
              fetchedAt: now,
            },
          })
        )
      )
    }

    res.json({
      success: true,
      data: {
        marketplace,
        imported: categories.length,
        leaf: categories.filter(category => category.isLeaf).length,
      },
    })
  } catch (error) {
    res.status(502).json({
      success: false,
      error: 'Pazaryeri kategori agaci alinamadi',
      detail: axios.isAxiosError(error) ? error.response?.data || error.message : error instanceof Error ? error.message : String(error),
    })
  }
}

export async function suggestCategoryMappings(req: Request, res: Response) {
  try {
    const marketplace = String(req.body?.marketplace || req.query.marketplace || '') as Marketplace
    const sourceId = String(req.body?.sourceId || req.query.sourceId || '')
    const marketplaces = marketplace ? [marketplace] : MARKETPLACES
    const result = await refreshPendingSuggestions(marketplaces, sourceId || undefined)

    res.json({ success: true, data: result })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Kategori onerileri olusturulamadi' })
  }
}

/**
 * GET /category-mappings/pending
 * Onay bekleyen kategori eşleştirmelerini listeler
 */
export async function getPendingMappings(req: Request, res: Response) {
  try {
    const page = parseInt(String(req.query.page || '1'))
    const limit = parseInt(String(req.query.limit || '50'))
    const skip = (page - 1) * limit
    const where = buildMappingWhere(req, 'PENDING')

    const [data, total] = await Promise.all([
      prisma.categoryMapping.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { source: { select: { id: true, name: true } } },
      }),
      prisma.categoryMapping.count({ where }),
    ])

    res.json({ success: true, data, meta: { total, page, limit } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * PUT /category-mappings/:id/approve
 * AI önerilerinden birini seçerek onaylar
 */
export async function approveMapping(req: Request, res: Response) {
  try {
    const { suggestionIndex } = req.body
    if (suggestionIndex === undefined || ![0, 1, 2].includes(suggestionIndex)) {
      res.status(400).json({ success: false, error: 'Geçersiz suggestionIndex (0, 1 veya 2 olmalı)' })
      return
    }

    const mapping = await prisma.categoryMapping.findUnique({
      where: { id: req.params.id },
    })
    if (!mapping) {
      res.status(404).json({ success: false, error: 'Eşleştirme bulunamadı' })
      return
    }

    const suggestions = mapping.allSuggestions as {
      categoryId: string
      categoryPath: string
      confidence: number
    }[] | null

    if (!suggestions || !suggestions[suggestionIndex]) {
      res.status(400).json({ success: false, error: 'Öneri bulunamadı' })
      return
    }

    const selected = suggestions[suggestionIndex]
    const syncResult = await syncCategoryAttributesForApproval(mapping.marketplace, selected.categoryId)

    const updated = await prisma.categoryMapping.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        marketplaceCategoryId: selected.categoryId,
        marketplaceCategoryPath: selected.categoryPath,
        approvedBy: 'admin',
        approvedAt: new Date(),
      },
    })

    res.json({ success: true, data: updated, ...syncResult })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * PUT /category-mappings/:id/approve-manual
 * Manuel kategori seçimi ile onaylar
 */
export async function approveManual(req: Request, res: Response) {
  try {
    const { marketplaceCategoryId, marketplaceCategoryPath } = req.body
    if (!marketplaceCategoryId) {
      res.status(400).json({ success: false, error: 'Pazaryeri kategori ID zorunlu. Kategori aramasindan son kirilim secilmelidir.' })
      return
    }

    const mapping = await prisma.categoryMapping.findUnique({
      where: { id: req.params.id },
    })
    if (!mapping) {
      res.status(404).json({ success: false, error: 'Eslestirme bulunamadi' })
      return
    }

    const category = await prisma.marketplaceCategory.findFirst({
      where: {
        marketplace: mapping.marketplace,
        categoryId: String(marketplaceCategoryId),
      },
    })
    if (!category) {
      res.status(400).json({ success: false, error: 'Secilen pazaryeri kategorisi yerel kategori agacinda bulunamadi. Once pazaryeri kategorilerini alin.' })
      return
    }
    if (!category.isLeaf) {
      res.status(400).json({ success: false, error: 'Sadece son kirilim kategori secilebilir.' })
      return
    }

    const syncResult = await syncCategoryAttributesForApproval(mapping.marketplace, String(marketplaceCategoryId))

    const updated = await prisma.categoryMapping.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        marketplaceCategoryId: String(marketplaceCategoryId),
        marketplaceCategoryPath: marketplaceCategoryPath ?? category.categoryPath,
        aiSuggested: false,
        approvedBy: 'admin',
        approvedAt: new Date(),
      },
    })

    res.json({ success: true, data: updated, ...syncResult })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Eşleştirme bulunamadı' })
  }
}

/**
 * PUT /category-mappings/:id/reject
 * Eşleştirmeyi reddeder
 */
export async function rejectMapping(req: Request, res: Response) {
  try {
    const updated = await prisma.categoryMapping.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED' },
    })
    res.json({ success: true, data: updated })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Eşleştirme bulunamadı' })
  }
}

/**
 * PUT /category-mappings/:id/reset
 * Onayli veya reddedilmis eslestirmeyi tekrar duzenlenebilir hale getirir
 */
export async function resetMapping(req: Request, res: Response) {
  try {
    const updated = await prisma.categoryMapping.update({
      where: { id: req.params.id },
      data: {
        status: 'PENDING',
        marketplaceCategoryId: null,
        marketplaceCategoryPath: null,
        approvedBy: null,
        approvedAt: null,
      },
    })
    res.json({ success: true, data: updated })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Eslestirme bulunamadi' })
  }
}

export async function getMappingDefaultAttributes(req: Request, res: Response) {
  try {
    const mapping = await prisma.categoryMapping.findUnique({
      where: { id: req.params.id },
      include: { source: { select: { id: true, name: true } } },
    })
    if (!mapping) {
      res.status(404).json({ success: false, error: 'Eslestirme bulunamadi' })
      return
    }
    if (!mapping.marketplaceCategoryId) {
      res.status(400).json({ success: false, error: 'Pazaryeri kategori eslesmesi yok' })
      return
    }

    const attrDefs = await prisma.marketplaceCategoryAttribute.findMany({
      where: {
        marketplace: mapping.marketplace,
        categoryId: mapping.marketplaceCategoryId,
        isMandatory: true,
      },
      orderBy: [{ displayOrder: 'asc' }, { attributeName: 'asc' }],
    })

    const products = await prisma.product.findMany({
      where: {
        sourceId: mapping.sourceId,
        categoryRaw: mapping.sourceCategory,
      },
      select: { id: true, title: true, categoryRaw: true, attributes: true },
    })
    const productIds = products.map(product => product.id)
    const existing = productIds.length > 0
      ? await prisma.productAttribute.findMany({
          where: {
            productId: { in: productIds },
            marketplace: mapping.marketplace,
            attributeId: { in: attrDefs.map(attr => attr.attributeId) },
          },
        })
      : []

    const attrs = attrDefs.map(def => {
      const counts = new Map<string, number>()
      for (const attr of existing.filter(item => item.attributeId === def.attributeId)) {
        const key = attributeValueKey(attr)
        if (!key) continue
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const [bestKey, valueCount] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
      const current = attributeValueFromKey(bestKey)
      return {
        attributeId: def.attributeId,
        attributeName: def.attributeName,
        attributeType: def.attributeType,
        isMandatory: def.isMandatory,
        allowCustomValue: def.allowCustomValue,
        values: def.values ?? [],
        currentValue: current.valueId ?? current.valueText,
        currentValueType: current.valueId ? 'valueId' : current.valueText ? 'valueText' : null,
        valueCount,
      }
    })

    res.json({
      success: true,
      mapping,
      productCount: productIds.length,
      attributes: attrs,
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Kategori varsayilan ozellikleri alinamadi' })
  }
}

export async function saveMappingDefaultAttributes(req: Request, res: Response) {
  try {
    const { attributes, overwrite = false } = req.body as {
      attributes: AttributePayload[]
      overwrite?: boolean
    }
    if (!Array.isArray(attributes)) {
      res.status(400).json({ success: false, error: 'attributes dizisi zorunlu' })
      return
    }

    const mapping = await prisma.categoryMapping.findUnique({
      where: { id: req.params.id },
    })
    if (!mapping) {
      res.status(404).json({ success: false, error: 'Eslestirme bulunamadi' })
      return
    }
    if (!mapping.marketplaceCategoryId) {
      res.status(400).json({ success: false, error: 'Pazaryeri kategori eslesmesi yok' })
      return
    }

    const attrDefs = await prisma.marketplaceCategoryAttribute.findMany({
      where: {
        marketplace: mapping.marketplace,
        categoryId: mapping.marketplaceCategoryId,
        attributeId: { in: attributes.map(attr => attr.attributeId) },
      },
    })

    const errors: { attributeId: string; error: string }[] = []
    for (const attr of attributes) {
      const def = attrDefs.find(item => item.attributeId === attr.attributeId)
      if (!def) {
        errors.push({ attributeId: attr.attributeId, error: 'Kategori ozelligi bulunamadi' })
        continue
      }
      const value = attr.valueText ?? attr.valueId ?? null
      const validation = categoryAttributeService.validateValue(
        {
          attributeId: def.attributeId,
          attributeName: def.attributeName,
          attributeType: def.attributeType as any,
          isMandatory: def.isMandatory,
          allowCustomValue: def.allowCustomValue,
          values: (def.values as { id: string; name: string }[]) ?? [],
          validationRules: (def.validationRules as object) ?? {},
          displayOrder: def.displayOrder,
        },
        value
      )
      if (!validation.isValid) {
        errors.push({ attributeId: attr.attributeId, error: validation.error ?? 'Gecersiz deger' })
      }
    }
    if (errors.length > 0) {
      res.status(400).json({ success: false, errors })
      return
    }

    const products = await prisma.product.findMany({
      where: {
        sourceId: mapping.sourceId,
        categoryRaw: mapping.sourceCategory,
      },
      select: { id: true, title: true, categoryRaw: true, attributes: true },
    })

    let applied = 0
    let skipped = 0
    for (const product of products) {
      for (const attr of attributes) {
        const def = attrDefs.find(item => item.attributeId === attr.attributeId)
        if (!def) continue
        const xmlOverride = await getXmlAttributeOverride(
          prisma,
          product,
          mapping.marketplace,
          mapping.marketplaceCategoryId,
          attr.attributeId
        )
        const existing = await prisma.productAttribute.findUnique({
          where: {
            productId_marketplace_attributeId: {
              productId: product.id,
              marketplace: mapping.marketplace,
              attributeId: attr.attributeId,
            },
          },
        })
        if (existing && !overwrite && !existing.isInherited) {
          skipped += 1
          continue
        }

        const valueId = xmlOverride ? xmlOverride.valueId : attr.valueId ?? null
        const valueText = xmlOverride ? xmlOverride.valueText : attr.valueText ?? null
        const savedBy = xmlOverride ? 'system:xml-color-size' : 'category-mapping-default'

        await prisma.productAttribute.upsert({
          where: {
            productId_marketplace_attributeId: {
              productId: product.id,
              marketplace: mapping.marketplace,
              attributeId: attr.attributeId,
            },
          },
          update: {
            attributeName: def.attributeName,
            valueId,
            valueText,
            isInherited: true,
            savedBy,
            savedAt: new Date(),
          },
          create: {
            productId: product.id,
            marketplace: mapping.marketplace,
            attributeId: attr.attributeId,
            attributeName: def.attributeName,
            valueId,
            valueText,
            isInherited: true,
            savedBy,
          },
        })
        applied += 1
      }
    }

    res.json({
      success: true,
      productCount: products.length,
      applied,
      skipped,
    })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Kategori varsayilan ozellikleri kaydedilemedi' })
  }
}
/**
 * POST /category-mappings/bulk-approve
 * Toplu onay — transaction içinde
 */
export async function bulkApprove(req: Request, res: Response) {
  const { items } = req.body as {
    items: { id: string; suggestionIndex: number }[]
  }

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, error: 'items dizisi boş olamaz' })
    return
  }

  let approved = 0
  const errors: { id: string; error: string }[] = []

  try {
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        try {
          const mapping = await tx.categoryMapping.findUnique({
            where: { id: item.id },
          })
          if (!mapping) throw new Error('Bulunamadı')

          const suggestions = mapping.allSuggestions as {
            categoryId: string; categoryPath: string
          }[] | null
          const selected = suggestions?.[item.suggestionIndex]
          if (!selected) throw new Error('Öneri yok')

          await tx.categoryMapping.update({
            where: { id: item.id },
            data: {
              status: 'APPROVED',
              marketplaceCategoryId: selected.categoryId,
              marketplaceCategoryPath: selected.categoryPath,
              approvedBy: 'admin',
              approvedAt: new Date(),
            },
          })
          approved++
        } catch (e) {
          errors.push({ id: item.id, error: e instanceof Error ? e.message : 'Hata' })
          throw e // transaction rollback
        }
      }
    })
  } catch (e) {
    res.status(400).json({ success: false, approved: 0, failed: items.length, errors })
    return
  }

  res.json({ success: true, approved, failed: errors.length, errors })
}

/**
 * GET /marketplace-categories/:marketplace/search
 * Pazaryeri kategori ağacında arama
 */
export async function searchCategories(req: Request, res: Response) {
  try {
    const { marketplace } = req.params
    const q = String(req.query.q || '')
    const isLeaf = req.query.isLeaf === 'true'
    const limit = parseInt(String(req.query.limit || '20'))

    const where: Record<string, unknown> = { marketplace }
    if (q) {
      where.OR = [
        { categoryName: { contains: q, mode: 'insensitive' } },
        { categoryPath: { contains: q, mode: 'insensitive' } },
      ]
    }
    if (req.query.isLeaf !== undefined) where.isLeaf = isLeaf

    const results = await prisma.marketplaceCategory.findMany({
      where,
      take: limit,
      select: { categoryId: true, categoryPath: true, categoryName: true },
    })

    res.json({ success: true, data: results })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

/**
 * GET /category-stats
 * Kategori eşleştirme istatistikleri
 */
export async function getCategoryStats(req: Request, res: Response) {
  try {
    const marketplace = String(req.query.marketplace || '')
    const sourceId = String(req.query.sourceId || '')
    const baseWhere: Record<string, unknown> = {}
    if (marketplace) baseWhere.marketplace = marketplace
    if (sourceId) baseWhere.sourceId = sourceId

    const [pending, approved, rejected, total] = await Promise.all([
      prisma.categoryMapping.count({ where: { ...baseWhere, status: 'PENDING' } }),
      prisma.categoryMapping.count({ where: { ...baseWhere, status: 'APPROVED' } }),
      prisma.categoryMapping.count({ where: { ...baseWhere, status: 'REJECTED' } }),
      prisma.categoryMapping.count({ where: baseWhere }),
    ])

    res.json({ success: true, data: { pending, approved, rejected, total } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatası' })
  }
}

