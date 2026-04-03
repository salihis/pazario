// src/services/CategoryMappingService.ts

import { PrismaClient } from '@prisma/client'

// ─── HATA SINIFLARI ──────────────────────────────────────────────────────────

export class CategoryAIError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'CategoryAIError'
  }
}

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export type Marketplace = 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'

export interface AISuggestion {
  categoryId: string
  categoryPath: string
  confidence: number
  reason: string
}

export interface CategoryResolutionResult {
  type: 'CACHED' | 'AI_SUGGESTED' | 'PENDING'
  marketplaceCategoryId: string | null
  marketplaceCategoryPath: string | null
  mappingId: string
  confidence: number | null
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const AI_CANDIDATE_LIMIT = 50
const HIGH_CONFIDENCE = 0.90
const MEDIUM_CONFIDENCE = 0.60

// ─── SERVİS ───────────────────────────────────────────────────────────────────

export class CategoryMappingService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Kategori çözümleme: Cache → Pending → AI
   */
  async resolveCategory(
    sourceCategory: string,
    marketplace: Marketplace,
    sourceId: string
  ): Promise<CategoryResolutionResult> {
    // ── 1. Onaylı cache'e bak ────────────────────────────────────────────
    const approved = await this.prisma.categoryMapping.findFirst({
      where: { sourceId, sourceCategory, marketplace, status: 'APPROVED' },
    })
    if (approved) {
      return {
        type: 'CACHED',
        marketplaceCategoryId: approved.marketplaceCategoryId,
        marketplaceCategoryPath: approved.marketplaceCategoryPath,
        mappingId: approved.id,
        confidence: approved.aiConfidence ? Number(approved.aiConfidence) : null,
      }
    }

    // ── 2. Bekleyen kayıt var mı ─────────────────────────────────────────
    const pending = await this.prisma.categoryMapping.findFirst({
      where: { sourceId, sourceCategory, marketplace, status: 'PENDING' },
    })
    if (pending) {
      return {
        type: 'PENDING',
        marketplaceCategoryId: null,
        marketplaceCategoryPath: null,
        mappingId: pending.id,
        confidence: null,
      }
    }

    // ── 3. AI öneri al ───────────────────────────────────────────────────
    const candidates = await this.getCandidates(sourceCategory, marketplace)
    const suggestions = await this.callAI(sourceCategory, marketplace, candidates)

    const best = suggestions[0] ?? null

    // PENDING olarak kaydet
    const mapping = await this.prisma.categoryMapping.create({
      data: {
        sourceId,
        sourceCategory,
        marketplace,
        status: 'PENDING',
        aiSuggested: true,
        aiConfidence: best?.confidence ?? null,
        aiReason: best?.reason ?? null,
        marketplaceCategoryId: best?.categoryId ?? null,
        marketplaceCategoryPath: best?.categoryPath ?? null,
        allSuggestions: suggestions as unknown as object,
      },
    })

    return {
      type: 'AI_SUGGESTED',
      marketplaceCategoryId: best?.categoryId ?? null,
      marketplaceCategoryPath: best?.categoryPath ?? null,
      mappingId: mapping.id,
      confidence: best?.confidence ?? null,
    }
  }

  /**
   * Güven seviyesini belirler
   */
  getConfidenceLevel(confidence: number): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (confidence >= HIGH_CONFIDENCE) return 'HIGH'
    if (confidence >= MEDIUM_CONFIDENCE) return 'MEDIUM'
    return 'LOW'
  }

  /**
   * pg_trgm ile benzerlik araması — AI'a gönderilecek adaylar
   */
  private async getCandidates(
    sourceCategory: string,
    marketplace: Marketplace
  ): Promise<{ categoryId: string; categoryPath: string; categoryName: string }[]> {
    // Basit fulltext search — pg_trgm extension gerekir
    const results = await this.prisma.marketplaceCategory.findMany({
      where: {
        marketplace,
        OR: [
          { categoryName: { contains: sourceCategory, mode: 'insensitive' } },
          { categoryPath: { contains: sourceCategory, mode: 'insensitive' } },
        ],
      },
      take: AI_CANDIDATE_LIMIT,
    })

    return results.map(r => ({
      categoryId: r.categoryId,
      categoryPath: r.categoryPath,
      categoryName: r.categoryName,
    }))
  }

  /**
   * Claude API ile kategori eşleştirme önerisi alır
   */
  private async callAI(
    sourceCategory: string,
    marketplace: Marketplace,
    candidates: { categoryId: string; categoryPath: string; categoryName: string }[]
  ): Promise<AISuggestion[]> {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new CategoryAIError('ANTHROPIC_API_KEY tanımlı değil')
    }

    const candidateText = candidates
      .map(c => `ID: ${c.categoryId} | Yol: ${c.categoryPath} | Ad: ${c.categoryName}`)
      .join('\n')

    const userPrompt = `Kaynak kategori: '${sourceCategory}'
Hedef pazaryeri: ${marketplace}

${marketplace} kategori listesi (en alakalı ${candidates.length} kategori):
${candidateText || 'Kategori bulunamadı'}`

    const systemPrompt = `Sen bir e-ticaret kategori eşleştirme uzmanısın.
Verilen kaynak kategoriyi, hedef pazaryerinin kategori listesinden en uygun 3 kategoriye eşleştir.
SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir metin olmadan:
{
  "suggestions": [
    {"categoryId": "...", "categoryPath": "...", "confidence": 0.92, "reason": "..."},
    {"categoryId": "...", "categoryPath": "...", "confidence": 0.78, "reason": "..."},
    {"categoryId": "...", "categoryPath": "...", "confidence": 0.61, "reason": "..."}
  ]
}`

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      })

      if (!response.ok) {
        throw new CategoryAIError(`Claude API hatası: HTTP ${response.status}`)
      }

      const data = await response.json() as {
        content: { type: string; text: string }[]
      }
      const text = data.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')

      // JSON parse
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean) as { suggestions: AISuggestion[] }
      return parsed.suggestions ?? []
    } catch (e) {
      if (e instanceof CategoryAIError) throw e
      throw new CategoryAIError(
        `AI yanıtı parse edilemedi: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
  }
}