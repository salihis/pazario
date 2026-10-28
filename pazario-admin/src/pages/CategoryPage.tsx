import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import MarketplaceAttributeSections from '../components/MarketplaceAttributeSections'

interface CategoryMapping {
  id: string
  sourceCategory: string
  marketplace: string
  marketplaceCategoryId: string | null
  marketplaceCategoryPath: string | null
  status: string
  aiSuggested: boolean
  aiConfidence: number | string | null
  allSuggestions: {
    categoryId: string
    categoryPath: string
    confidence: number
    reason: string
  }[] | null
  source: { id: string; name: string }
  productCount: number
  attributeSummary: {
    mandatory: number
    filled: number
    missing: number
    complete: boolean
  }
}

interface CategoryStats {
  pending: number
  approved: number
  rejected: number
  total: number
}

interface XmlSource {
  id: string
  name: string
}

interface MarketplaceCategoryResult {
  categoryId: string
  categoryPath: string
  categoryName: string
}

interface CategoryAttributeField {
  attributeId: string
  attributeName: string
  isMandatory: boolean
  attributeType: string
  values: { id: string; name: string }[]
  allowCustomValue: boolean
  currentValue: string | null
}

interface AttributeSyncResult {
  marketplace: string
  scannedMappings: number
  categoryCount: number
  synced: number
  failed: number
  attributes: number
}

interface AttributeRulePreview {
  mappingId: string
  marketplace: string
  productCount: number
  ruleCount: number
  applicable: number
  skippedExisting: number
  skippedManual: number
  applied?: number
  suggestions: {
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
  }[]
}

type AttributeRuleMatchType = 'ALWAYS' | 'TITLE_CONTAINS' | 'BRAND_EQUALS' | 'XML_ATTRIBUTE_EQUALS'

interface AttributeRule {
  id: string
  name: string
  attributeId: string
  attributeName: string | null
  valueId: string | null
  valueText: string | null
  matchType: AttributeRuleMatchType
  matchField: string | null
  matchValue: string | null
  confidence: number | string
  isActive: boolean
}

interface ApiList<T> {
  data: T[]
  meta?: { total: number; page: number; limit: number }
}

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

const STATUS_TABS = [
  { value: 'PENDING', label: 'Bekleyen' },
  { value: 'APPROVED', label: 'Onaylanan' },
  { value: 'REJECTED', label: 'Reddedilen' },
  { value: '', label: 'Tumu' },
]
const PAGE_SIZE_OPTIONS = [25, 50, 100]

const statusLabel: Record<string, string> = {
  PENDING: 'Bekliyor',
  APPROVED: 'Onaylandi',
  REJECTED: 'Reddedildi',
}

const statusColor: Record<string, string> = {
  PENDING: 'text-yellow-400 bg-yellow-900/30',
  APPROVED: 'text-green-400 bg-green-900/30',
  REJECTED: 'text-red-400 bg-red-900/30',
}

const confidenceColor = (value: number) => {
  if (value >= 0.9) return 'text-green-400'
  if (value >= 0.6) return 'text-yellow-400'
  return 'text-red-400'
}

const toConfidence = (value: number | string | null) => {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const displayCategoryText = (value: string) =>
  value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')

export default function CategoryPage() {
  const queryClient = useQueryClient()
  const initialParams = new URLSearchParams(window.location.search)
  const [marketplace, setMarketplace] = useState(initialParams.get('marketplace') || 'TRENDYOL')
  const [status, setStatus] = useState(initialParams.has('status') ? initialParams.get('status') || '' : 'PENDING')
  const [sourceId, setSourceId] = useState(initialParams.get('sourceId') || '')
  const [search, setSearch] = useState(initialParams.get('search') || '')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [manualSearch, setManualSearch] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [isEditingMapping, setIsEditingMapping] = useState(false)
  const [mappingAttributeValues, setMappingAttributeValues] = useState<Record<string, string>>({})
  const [attributeFilter, setAttributeFilter] = useState<'all' | 'missing' | 'complete'>('all')
  const [showMandatoryOnly, setShowMandatoryOnly] = useState(false)
  const [attributeRulePreview, setAttributeRulePreview] = useState<AttributeRulePreview | null>(null)
  const [conditionalAttributeId, setConditionalAttributeId] = useState('')
  const [conditionalMatchType, setConditionalMatchType] = useState<Exclude<AttributeRuleMatchType, 'ALWAYS'>>('TITLE_CONTAINS')
  const [conditionalMatchField, setConditionalMatchField] = useState('')
  const [conditionalMatchValue, setConditionalMatchValue] = useState('')

  const resetList = () => {
    setPage(1)
    setSelectedId(null)
    setIsEditingMapping(false)
  }

  const { data: sources } = useQuery<{ data: XmlSource[] }>({
    queryKey: ['sources'],
    queryFn: () => api.get('/sources').then(r => r.data),
  })

  const { data: stats } = useQuery<{ data: CategoryStats }>({
    queryKey: ['category-stats', marketplace, sourceId],
    queryFn: () =>
      api.get('/category-stats', {
        params: {
          marketplace: marketplace || undefined,
          sourceId: sourceId || undefined,
        },
      }).then(r => r.data),
  })

  const { data, isLoading } = useQuery<ApiList<CategoryMapping>>({
    queryKey: ['category-mappings', marketplace, status, sourceId, search, page, pageSize],
    queryFn: () =>
      api.get('/category-mappings', {
        params: {
          marketplace: marketplace || undefined,
          status: status || undefined,
          sourceId: sourceId || undefined,
          search: search || undefined,
          page,
          limit: pageSize,
        },
      }).then(r => r.data),
  })

  const selected = data?.data.find(m => m.id === selectedId)
  const visibleMappings = (data?.data ?? []).filter(mapping => {
    if (attributeFilter === 'missing') return mapping.status === 'APPROVED' && mapping.attributeSummary.missing > 0
    if (attributeFilter === 'complete') return mapping.status === 'APPROVED' && mapping.attributeSummary.complete
    return true
  })
  const activeMarketplace = selected?.marketplace || marketplace
  const selectedCategoryId = selected?.marketplaceCategoryId || ''

  const { data: categorySearch, isFetching: isSearchingCategories } = useQuery<{ data: MarketplaceCategoryResult[] }>({
    queryKey: ['marketplace-category-search', activeMarketplace, manualSearch],
    enabled: Boolean(activeMarketplace && manualSearch.trim().length >= 2),
    queryFn: () =>
      api.get(`/marketplace-categories/${activeMarketplace}/search`, {
        params: { q: manualSearch.trim(), isLeaf: true, limit: 20 },
      }).then(r => r.data),
  })

  const { data: selectedCategoryAttributesData, isFetching: isFetchingSelectedAttributes } = useQuery<{
    success: boolean
    attributes: CategoryAttributeField[]
    productCount: number
  }>({
    queryKey: ['category-mapping-default-attributes', selected?.id],
    enabled: Boolean(selected?.id && selectedCategoryId && !selectedCategoryId.startsWith('MANUAL:')),
    retry: false,
    queryFn: () =>
      api.get(`/category-mappings/${selected?.id}/default-attributes`).then(r => r.data),
  })

  const { data: attributeRulesData } = useQuery<{ success: boolean; data: AttributeRule[] }>({
    queryKey: ['attribute-rules', selected?.id],
    enabled: Boolean(selected?.id && selected?.source?.id),
    queryFn: () =>
      api.get('/attribute-rules', {
        params: {
          marketplace: selected?.marketplace,
          sourceId: selected?.source?.id,
          sourceCategory: selected?.sourceCategory,
        },
      }).then(r => r.data),
  })

  const approveMutation = useMutation({
    mutationFn: ({ id, suggestionIndex }: { id: string; suggestionIndex: number }) =>
      api.put(`/category-mappings/${id}/approve`, { suggestionIndex }),
    onSuccess: response => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      queryClient.invalidateQueries({ queryKey: ['category-attributes-preview'] })
      const synced = response.data?.attributesSynced ?? 0
      const syncError = response.data?.attributesSyncError
      setActionMessage(syncError
        ? `Kategori onaylandi, ancak zorunlu ozellikler alinamadi: ${syncError}`
        : `Kategori onaylandi. ${synced} kategori ozelligi alindi.`
      )
      setSelectedId(null)
      setManualSearch('')
      setIsEditingMapping(false)
    },
  })

  useEffect(() => {
    const attrs = selectedCategoryAttributesData?.attributes ?? []
    const nextValues: Record<string, string> = {}
    for (const attr of attrs) {
      nextValues[attr.attributeId] = String(attr.currentValue ?? '')
    }
    setMappingAttributeValues(nextValues)
    setAttributeRulePreview(null)
    setConditionalAttributeId('')
    setConditionalMatchValue('')
    setConditionalMatchField('')
  }, [selectedCategoryAttributesData])

  const selectedCategoryAttributeFields = selectedCategoryAttributesData?.attributes ?? []
  const mandatoryAttributeCount = selectedCategoryAttributeFields.filter(attr => attr.isMandatory).length
  const optionalAttributeCount = selectedCategoryAttributeFields.filter(attr => !attr.isMandatory).length

  const saveMappingAttributesMutation = useMutation({
    mutationFn: () => {
      const attrs = selectedCategoryAttributesData?.attributes ?? []
      const payload = attrs
        .map(attr => {
          const value = (mappingAttributeValues[attr.attributeId] ?? '').trim()
          if (!value) return null
          if (attr.attributeType === 'dropdown' || attr.attributeType === 'multi_select' || attr.attributeType === 'color') {
            return { attributeId: attr.attributeId, valueId: value }
          }
          return { attributeId: attr.attributeId, valueText: value }
        })
        .filter(Boolean)

      return api.put(`/category-mappings/${selected?.id}/default-attributes`, {
        attributes: payload,
        saveAsRules: true,
        applyNow: false,
      }).then(r => r.data)
    },
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['category-mapping-default-attributes', selected?.id] })
      setAttributeRulePreview(null)
      setActionMessage(`${result.rulesSaved} ozellik kurali kaydedildi. Uygulamadan once Kurallari Onizle ile sonucu kontrol edin.`)
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.errors || error?.response?.data?.error || 'Kategori ozellikleri kaydedilemedi'
      setActionMessage(typeof detail === 'string' ? detail : JSON.stringify(detail))
    },
  })

  const previewAttributeRulesMutation = useMutation({
    mutationFn: () =>
      api.post(`/category-mappings/${selected?.id}/attribute-rules/preview`, {
        overwrite: false,
        minConfidence: 0.9,
        limit: 2000,
      }).then(r => r.data.data as AttributeRulePreview),
    onSuccess: result => {
      setAttributeRulePreview(result)
      setActionMessage(`${result.productCount} urun tarandi; ${result.applicable} alan uygulanabilir. ${result.skippedManual} manuel ve ${result.skippedExisting} mevcut deger korunacak.`)
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.error || 'Ozellik kurallari onizlenemedi')
    },
  })

  const applyAttributeRulesMutation = useMutation({
    mutationFn: () =>
      api.post(`/category-mappings/${selected?.id}/attribute-rules/apply`, {
        overwrite: false,
        minConfidence: 0.9,
        limit: 2000,
      }).then(r => r.data.data as AttributeRulePreview),
    onSuccess: result => {
      setAttributeRulePreview(result)
      queryClient.invalidateQueries({ queryKey: ['category-mapping-default-attributes', selected?.id] })
      setActionMessage(`${result.applied ?? 0} ozellik degeri uygulandi. Manuel girilmis degerler korunmustur.`)
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.error || 'Ozellik kurallari uygulanamadi')
    },
  })

  const createConditionalRuleMutation = useMutation({
    mutationFn: () => {
      const attr = selectedCategoryAttributeFields.find(item => item.attributeId === conditionalAttributeId)
      const value = (mappingAttributeValues[conditionalAttributeId] ?? '').trim()
      if (!attr || !value || !selected) throw new Error('Ozellik ve uygulanacak deger secilmelidir')
      const usesValueId = attr.attributeType === 'dropdown' || attr.attributeType === 'multi_select' || attr.attributeType === 'color'
      return api.post('/attribute-rules', {
        marketplace: selected.marketplace,
        sourceId: selected.source.id,
        sourceCategory: selected.sourceCategory,
        marketplaceCategoryId: selected.marketplaceCategoryId,
        name: `${attr.attributeName} - ${conditionalMatchValue}`,
        attributeId: attr.attributeId,
        attributeName: attr.attributeName,
        valueId: usesValueId ? value : null,
        valueText: usesValueId ? null : value,
        matchType: conditionalMatchType,
        matchField: conditionalMatchType === 'XML_ATTRIBUTE_EQUALS' ? conditionalMatchField.trim() : null,
        matchValue: conditionalMatchValue.trim(),
        confidence: 1,
        priority: 200,
        isActive: true,
      }).then(r => r.data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attribute-rules', selected?.id] })
      setAttributeRulePreview(null)
      setConditionalMatchValue('')
      setConditionalMatchField('')
      setActionMessage('Kosullu ozellik kurali kaydedildi. Uygulamadan once onizleme yapin.')
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.error || error?.message || 'Kosullu kural kaydedilemedi')
    },
  })

  const deleteAttributeRuleMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/attribute-rules/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attribute-rules', selected?.id] })
      setAttributeRulePreview(null)
      setActionMessage('Ozellik kurali silindi.')
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.error || 'Ozellik kurali silinemedi')
    },
  })

  const approveManualMutation = useMutation({
    mutationFn: ({ id, category }: { id: string; category: MarketplaceCategoryResult }) =>
      api.put(`/category-mappings/${id}/approve-manual`, {
        marketplaceCategoryId: category.categoryId,
        marketplaceCategoryPath: category.categoryPath,
      }),
    onSuccess: response => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      queryClient.invalidateQueries({ queryKey: ['category-attributes-preview'] })
      const synced = response.data?.attributesSynced ?? 0
      const syncError = response.data?.attributesSyncError
      setActionMessage(syncError
        ? `Kategori onaylandi, ancak zorunlu ozellikler alinamadi: ${syncError}`
        : `Kategori onaylandi. ${synced} kategori ozelligi alindi.`
      )
      setSelectedId(null)
      setManualSearch('')
      setIsEditingMapping(false)
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.error || 'Kategori onaylanamadi')
    },
  })

  const generateMutation = useMutation({
    mutationFn: () =>
      api.post('/category-mappings/generate', {
        marketplace,
        sourceId: sourceId || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      setActionMessage('Kategori eslestirme kayitlari olusturuldu.')
      resetList()
    },
  })

  const syncCategoriesMutation = useMutation({
    mutationFn: () => api.post(`/marketplace-categories/${marketplace}/sync`).then(r => r.data.data),
    onSuccess: result => {
      setActionMessage(`${result.marketplace} kategori agaci guncellendi. ${result.imported} kategori, ${result.leaf} uc kategori kaydedildi.`)
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.detail || error?.response?.data?.error || 'Kategori agaci alinamadi')
    },
  })

  const suggestMutation = useMutation({
    mutationFn: () =>
      api.post('/category-mappings/suggest', {
        marketplace,
        sourceId: sourceId || undefined,
      }).then(r => r.data.data),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      const created = result.created ? `${result.created} eslesme olusturuldu, ` : ''
      setActionMessage(`${created}${result.scanned} bekleyen eslesme tarandi, ${result.updated} onerisi guncellendi.`)
      resetList()
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.error || 'Kategori onerileri olusturulamadi')
    },
  })

  const syncAttributesMutation = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; data: AttributeSyncResult }>(
        `/category-attributes/${marketplace}/sync-approved`,
        {
          sourceId: sourceId || undefined,
          limit: 500,
        }
      ).then(r => r.data.data),
    onSuccess: result => {
      setActionMessage(
        `${result.marketplace} ozellikleri alindi. ${result.categoryCount} kategori tarandi, ${result.synced} kategori guncellendi, ${result.attributes} ozellik kaydedildi.`
      )
    },
    onError: (error: any) => {
      setActionMessage(error?.response?.data?.error || 'Kategori ozellikleri alinamadi')
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (id: string) => api.put(`/category-mappings/${id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      setSelectedId(null)
    },
  })

  const resetMutation = useMutation({
    mutationFn: (id: string) => api.put(`/category-mappings/${id}/reset`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      setManualSearch('')
      setIsEditingMapping(false)
      setActionMessage('Eslestirme tekrar duzenlenebilir hale getirildi.')
    },
  })

  const total = data?.meta?.total ?? 0
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const pageStart = total > 0 ? (page - 1) * pageSize + 1 : 0
  const pageEnd = Math.min(page * pageSize, total)

  const handlePageSizeChange = (value: string) => {
    setPageSize(Number(value))
    setPage(1)
  }

  const paginationControls = (
    <div className="px-4 py-3 border-t border-gray-800 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span>{pageStart} - {pageEnd} / {total}</span>
        <label className="flex items-center gap-2">
          <span>Sayfada</span>
          <select
            value={pageSize}
            onChange={e => handlePageSizeChange(e.target.value)}
            className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
          >
            {PAGE_SIZE_OPTIONS.map(size => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
          <span>kayit</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-300 disabled:opacity-40 hover:bg-gray-700 transition-colors"
        >
          Onceki
        </button>
        <span className="px-3 py-1 text-xs text-gray-400">
          {page} / {lastPage}
        </span>
        <button
          onClick={() => setPage(p => Math.min(lastPage, p + 1))}
          disabled={page >= lastPage}
          className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-300 disabled:opacity-40 hover:bg-gray-700 transition-colors"
        >
          Sonraki
        </button>
      </div>
    </div>
  )

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Kategori Eslestirme</h1>
          <p className="text-gray-400 text-sm mt-1">Pazaryerine gore kategori onay ve eslestirme ekrani</p>
        </div>
      </div>

      {actionMessage && (
        <div className="mb-5 rounded-lg border border-blue-800 bg-blue-950/40 px-4 py-3 text-sm text-blue-100">
          {actionMessage}
        </div>
      )}

      <div className="grid grid-cols-4 gap-3 mb-5">
        {MARKETPLACES.map(mp => (
          <button
            key={mp}
            onClick={() => {
              setMarketplace(mp)
              resetList()
            }}
            className={`text-left rounded-lg px-4 py-3 border transition-colors ${
              marketplace === mp
                ? 'bg-blue-900/40 border-blue-500 text-blue-100'
                : 'bg-gray-900 border-gray-800 text-gray-400 hover:bg-gray-800'
            }`}
          >
            <div className="text-sm font-semibold">{mp}</div>
            <div className="text-xs text-gray-500 mt-1">Kategori agaci ve eslestirmeler</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Bekleyen', value: stats?.data.pending ?? 0, color: 'text-yellow-400', bg: 'bg-yellow-900/30' },
          { label: 'Onaylanan', value: stats?.data.approved ?? 0, color: 'text-green-400', bg: 'bg-green-900/30' },
          { label: 'Reddedilen', value: stats?.data.rejected ?? 0, color: 'text-red-400', bg: 'bg-red-900/30' },
          { label: 'Toplam', value: stats?.data.total ?? 0, color: 'text-blue-400', bg: 'bg-blue-900/30' },
        ].map(card => (
          <div key={card.label} className={`rounded-lg p-4 border border-gray-800 ${card.bg}`}>
            <div className={`text-3xl font-bold ${card.color}`}>{card.value}</div>
            <div className="text-sm text-gray-400 mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {STATUS_TABS.map(tab => (
            <button
              key={tab.label}
              onClick={() => {
                setStatus(tab.value)
                resetList()
              }}
              className={`px-4 py-2 text-sm border-r border-gray-800 last:border-r-0 ${
                status === tab.value ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <select
          value={sourceId}
          onChange={e => {
            setSourceId(e.target.value)
            resetList()
          }}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          <option value="">Tum XML kaynaklari</option>
          {sources?.data.map(source => (
            <option key={source.id} value={source.id}>{source.name}</option>
          ))}
        </select>

        <input
          value={search}
          onChange={e => {
            setSearch(e.target.value)
            resetList()
          }}
          placeholder="Kaynak kategori ara"
          className="flex-1 min-w-[220px] bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />

        <button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          className="bg-blue-700 hover:bg-blue-600 text-white text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          {generateMutation.isPending ? 'Olusturuluyor...' : 'Eslestirme Olustur'}
        </button>

        <button
          onClick={() => syncCategoriesMutation.mutate()}
          disabled={syncCategoriesMutation.isPending}
          className="bg-sky-700 hover:bg-sky-600 text-white text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          {syncCategoriesMutation.isPending ? 'Kategori agaci aliniyor...' : 'Pazaryeri Kategorilerini Al'}
        </button>

        <button
          onClick={() => suggestMutation.mutate()}
          disabled={suggestMutation.isPending}
          className="bg-purple-700 hover:bg-purple-600 text-white text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          {suggestMutation.isPending ? 'Oneriler uretiliyor...' : 'Onerileri Yenile'}
        </button>

        <button
          onClick={() => syncAttributesMutation.mutate()}
          disabled={syncAttributesMutation.isPending}
          className="bg-emerald-700 hover:bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          {syncAttributesMutation.isPending ? 'Ozellikler aliniyor...' : 'Ozellikleri Al'}
        </button>

        <div className="flex bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {[
            { value: 'all', label: 'Tum Alan Durumlari' },
            { value: 'missing', label: 'Zorunlu Eksik' },
            { value: 'complete', label: 'Alanlari Tamam' },
          ].map(tab => (
            <button
              key={tab.value}
              onClick={() => setAttributeFilter(tab.value as 'all' | 'missing' | 'complete')}
              className={`px-3 py-2 text-xs border-r border-gray-800 last:border-r-0 ${
                attributeFilter === tab.value ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-4">
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-400 uppercase tracking-wider">Eslesmeler</div>
              <div className="text-xs text-gray-500 mt-0.5">{total} kayit</div>
            </div>
            <div className="text-xs text-gray-500">Sayfa {page} / {lastPage}</div>
          </div>
          {paginationControls}

          {isLoading ? (
            <div className="p-8 text-center text-gray-500">Yukleniyor...</div>
          ) : visibleMappings.length === 0 ? (
            <div className="p-8 text-center text-gray-500">Bu filtrelerde kategori eslestirmesi yok</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {visibleMappings.map(mapping => {
                const confidence = toConfidence(mapping.aiConfidence)
                const attrSummary = mapping.attributeSummary
                return (
                  <button
                    type="button"
                    key={mapping.id}
                    onClick={() => {
                      setSelectedId(mapping.id === selectedId ? null : mapping.id)
                      setManualSearch('')
                      setIsEditingMapping(false)
                    }}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-800/50 transition-colors ${
                      selectedId === mapping.id ? 'bg-gray-800 border-l-2 border-blue-500' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-gray-100 truncate">{displayCategoryText(mapping.sourceCategory)}</div>
                        <div className="text-xs text-gray-500 mt-1 truncate">
                          {mapping.source?.name} | {mapping.marketplace}
                        </div>
                        {mapping.marketplaceCategoryPath && (
                          <div className="text-xs text-gray-400 mt-1 truncate">
                            {mapping.marketplaceCategoryPath}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="rounded-full border border-gray-700 bg-gray-950 px-2 py-0.5 text-gray-300">
                            {mapping.productCount} urun
                          </span>
                          {mapping.status === 'APPROVED' && (
                            <span className={`rounded-full border px-2 py-0.5 ${
                              attrSummary.missing > 0
                                ? 'border-red-800 bg-red-950/40 text-red-200'
                                : 'border-green-800 bg-green-950/40 text-green-200'
                            }`}>
                              Zorunlu: {attrSummary.filled}/{attrSummary.mandatory}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {confidence !== null && (
                          <span className={`text-xs font-mono ${confidenceColor(confidence)}`}>
                            %{Math.round(confidence * 100)}
                          </span>
                        )}
                        <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor[mapping.status]}`}>
                          {statusLabel[mapping.status] || mapping.status}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {paginationControls}
        </div>

        <div className="bg-gray-900 rounded-lg border border-gray-800 min-h-[520px] lg:sticky lg:top-6">
          {!selected ? (
            <div className="h-full flex items-center justify-center p-8 text-center text-gray-500 text-sm">
              Detay, AI onerileri ve manuel eslestirme icin soldan bir kategori secin.
            </div>
          ) : (
            <div className="flex flex-col h-full">
              <div className="px-4 py-3 border-b border-gray-800">
                <div className="text-sm font-bold text-gray-100 truncate">{displayCategoryText(selected.sourceCategory)}</div>
                <div className="text-xs text-gray-500 mt-1">{selected.source?.name} | {selected.marketplace}</div>
              </div>

              <div className="p-4 space-y-5 flex-1 overflow-y-auto">
                {selected.marketplaceCategoryPath && (
                  <div className="bg-green-900/20 border border-green-900/40 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs text-green-400 mb-1">Mevcut eslesme</div>
                        <div className="text-sm text-gray-200">{selected.marketplaceCategoryPath}</div>
                      </div>
                      <button
                        onClick={() => setIsEditingMapping(value => !value)}
                        className="flex-shrink-0 bg-green-800/70 hover:bg-green-700 text-green-100 text-xs px-3 py-1.5 rounded transition-colors"
                      >
                        {isEditingMapping ? 'Vazgec' : 'Duzenle'}
                      </button>
                    </div>
                  </div>
                )}

                {selected.marketplaceCategoryId && !selected.marketplaceCategoryId.startsWith('MANUAL:') && (
                  <div className="rounded-2xl border border-gray-800 bg-gray-950/80 p-4">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <div className="text-xs uppercase tracking-wider text-gray-400">{selected.marketplace} Alanlari</div>
                        <div className="text-xs text-gray-500 mt-1">
                          Bu alanlar onaylanan kategoriye bagli varsayilan degerlerdir.
                          {selectedCategoryAttributesData?.productCount !== undefined && ` ${selectedCategoryAttributesData.productCount} urun etkilenecek.`}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {isFetchingSelectedAttributes && <span className="text-xs text-gray-500">Aliniyor...</span>}
                        <label className="flex items-center gap-2 text-xs text-gray-400">
                          <input
                            type="checkbox"
                            checked={showMandatoryOnly}
                            onChange={e => setShowMandatoryOnly(e.target.checked)}
                            className="h-4 w-4"
                          />
                          Sadece zorunlu
                        </label>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3 mb-4">
                      {[
                        { label: 'Toplam', value: selectedCategoryAttributeFields.length, color: 'text-blue-300' },
                        { label: 'Zorunlu', value: mandatoryAttributeCount, color: 'text-red-300' },
                        { label: 'Opsiyonel', value: optionalAttributeCount, color: 'text-gray-300' },
                      ].map(card => (
                        <div key={card.label} className="rounded-xl border border-gray-800 bg-gray-900/80 px-3 py-2">
                          <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
                          <div className="text-xs text-gray-500 mt-1">{card.label}</div>
                        </div>
                      ))}
                    </div>

                    <MarketplaceAttributeSections
                      marketplace={selected.marketplace}
                      attributes={selectedCategoryAttributeFields}
                      values={mappingAttributeValues}
                      onChange={(attributeId, value) =>
                        setMappingAttributeValues(values => ({ ...values, [attributeId]: value }))
                      }
                      mandatoryOnly={showMandatoryOnly}
                      emptyMessage={`Bu kategori icin alinmis ${selected.marketplace} alan bilgisi bulunamadi.`}
                    />

                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        onClick={() => saveMappingAttributesMutation.mutate()}
                        disabled={saveMappingAttributesMutation.isPending || isFetchingSelectedAttributes || selectedCategoryAttributeFields.length === 0}
                        className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm py-2.5 rounded-xl transition-colors font-medium"
                      >
                        {saveMappingAttributesMutation.isPending ? 'Kaydediliyor...' : 'Degerleri Kural Olarak Kaydet'}
                      </button>
                      <button
                        onClick={() => previewAttributeRulesMutation.mutate()}
                        disabled={previewAttributeRulesMutation.isPending || !selected?.id}
                        className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-100 text-sm py-2.5 rounded-xl border border-gray-700 transition-colors font-medium"
                      >
                        {previewAttributeRulesMutation.isPending ? 'Hesaplaniyor...' : 'Kurallari Onizle'}
                      </button>
                    </div>

                    {attributeRulePreview && (
                      <div className="mt-3 rounded-xl border border-blue-900/60 bg-blue-950/20 p-3">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                          {[
                            ['Urun', attributeRulePreview.productCount],
                            ['Uygulanabilir', attributeRulePreview.applicable],
                            ['Mevcut korundu', attributeRulePreview.skippedExisting],
                            ['Manuel korundu', attributeRulePreview.skippedManual],
                          ].map(([label, value]) => (
                            <div key={String(label)} className="rounded-lg bg-gray-950/70 px-2 py-2">
                              <div className="text-lg font-bold text-gray-100">{value}</div>
                              <div className="text-[11px] text-gray-500">{label}</div>
                            </div>
                          ))}
                        </div>
                        <button
                          onClick={() => applyAttributeRulesMutation.mutate()}
                          disabled={applyAttributeRulesMutation.isPending || attributeRulePreview.applicable === 0}
                          className="mt-3 w-full bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm py-2.5 rounded-xl transition-colors font-medium"
                        >
                          {applyAttributeRulesMutation.isPending
                            ? 'Uygulaniyor...'
                            : `Onayla ve ${attributeRulePreview.applicable} Alani Uygula`}
                        </button>
                      </div>
                    )}

                    <div className="mt-5 border-t border-gray-800 pt-4">
                      <div className="text-sm font-semibold text-gray-100">Kosullu Ozellik Kurali</div>
                      <div className="mt-1 text-xs text-gray-500">
                        Urun adi, marka veya XML alani eslestiginde secilen deger otomatik uygulanir.
                      </div>
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <select
                          value={conditionalAttributeId}
                          onChange={event => setConditionalAttributeId(event.target.value)}
                          className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
                        >
                          <option value="">Ozellik secin</option>
                          {selectedCategoryAttributeFields.map(attr => (
                            <option key={attr.attributeId} value={attr.attributeId}>{attr.attributeName}</option>
                          ))}
                        </select>
                        <select
                          value={conditionalMatchType}
                          onChange={event => setConditionalMatchType(event.target.value as Exclude<AttributeRuleMatchType, 'ALWAYS'>)}
                          className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
                        >
                          <option value="TITLE_CONTAINS">Urun adi sunu icerir</option>
                          <option value="BRAND_EQUALS">Marka sununla esittir</option>
                          <option value="XML_ATTRIBUTE_EQUALS">XML alani sununla esittir</option>
                        </select>
                        {conditionalMatchType === 'XML_ATTRIBUTE_EQUALS' && (
                          <input
                            value={conditionalMatchField}
                            onChange={event => setConditionalMatchField(event.target.value)}
                            placeholder="XML alan adi, orn. Materyal"
                            className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500"
                          />
                        )}
                        <input
                          value={conditionalMatchValue}
                          onChange={event => setConditionalMatchValue(event.target.value)}
                          placeholder="Eslesecek ifade"
                          className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500"
                        />
                      </div>
                      <div className="mt-2 text-xs text-gray-500">
                        Uygulanacak deger, yukaridaki ozellik alaninda secili olan degerdir.
                      </div>
                      <button
                        onClick={() => createConditionalRuleMutation.mutate()}
                        disabled={
                          createConditionalRuleMutation.isPending
                          || !conditionalAttributeId
                          || !conditionalMatchValue.trim()
                          || !(mappingAttributeValues[conditionalAttributeId] ?? '').trim()
                          || (conditionalMatchType === 'XML_ATTRIBUTE_EQUALS' && !conditionalMatchField.trim())
                        }
                        className="mt-3 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
                      >
                        {createConditionalRuleMutation.isPending ? 'Kaydediliyor...' : 'Kosullu Kurali Kaydet'}
                      </button>

                      {(attributeRulesData?.data?.length ?? 0) > 0 && (
                        <div className="mt-4 border-t border-gray-800 divide-y divide-gray-800">
                          {attributeRulesData?.data.map(rule => (
                            <div key={rule.id} className="flex items-start justify-between gap-3 py-3">
                              <div className="min-w-0">
                                <div className="text-sm text-gray-200 truncate">{rule.attributeName || rule.attributeId}</div>
                                <div className="text-xs text-gray-500 mt-1">
                                  {rule.matchType === 'ALWAYS'
                                    ? 'Her urune'
                                    : `${rule.matchType}${rule.matchField ? ` (${rule.matchField})` : ''}: ${rule.matchValue}`}
                                  {' -> '}
                                  {rule.valueText || rule.valueId}
                                </div>
                              </div>
                              <button
                                onClick={() => deleteAttributeRuleMutation.mutate(rule.id)}
                                disabled={deleteAttributeRuleMutation.isPending}
                                className="shrink-0 text-xs text-red-300 hover:text-red-200 px-2 py-1"
                              >
                                Sil
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {selected.marketplaceCategoryId?.startsWith('MANUAL:') && (
                  <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3 text-sm text-red-100">
                    Bu eslesme eski elle yazilan kategori yolu ile olusturulmus. Pazaryeri kategori aramasindan son kirilim secerek tekrar duzenleyin.
                  </div>
                )}

                {(selected.status !== 'APPROVED' || isEditingMapping) && (
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">AI onerileri</div>
                  <div className="space-y-3">
                    {selected.allSuggestions?.map((suggestion, index) => (
                      <div key={`${suggestion.categoryId}-${index}`} className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <span className={`text-sm font-mono font-bold ${confidenceColor(suggestion.confidence)}`}>
                            %{Math.round(suggestion.confidence * 100)}
                          </span>
                          <span className="text-xs text-gray-500">#{index + 1}</span>
                        </div>
                        <div className="text-xs text-gray-300 mb-1">{suggestion.categoryPath}</div>
                        <div className="text-xs text-gray-500 mb-3">{suggestion.reason}</div>
                        <button
                          onClick={() => approveMutation.mutate({ id: selected.id, suggestionIndex: index })}
                          disabled={approveMutation.isPending}
                          className="w-full bg-green-700 hover:bg-green-600 text-white text-xs py-1.5 rounded transition-colors disabled:opacity-40"
                        >
                          {selected.status === 'APPROVED' ? 'Bu oneriyle degistir' : 'Bu oneriyi onayla'}
                        </button>
                      </div>
                    ))}

                    {(!selected.allSuggestions || selected.allSuggestions.length === 0) && (
                      <div className="text-gray-500 text-sm py-2">AI onerisi yok</div>
                    )}
                  </div>
                </div>
                )}

                {(selected.status !== 'APPROVED' || isEditingMapping) && (
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Manuel pazaryeri kategorisi</div>
                  <input
                    value={manualSearch}
                    onChange={e => setManualSearch(e.target.value)}
                    placeholder={`${activeMarketplace} kategorisi ara`}
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <div className="mt-2 space-y-2">
                    {isSearchingCategories && (
                      <div className="text-xs text-gray-500 px-1">Araniyor...</div>
                    )}
                    {categorySearch?.data.map(category => (
                      <div key={category.categoryId} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                        <div className="text-xs text-gray-300">{category.categoryPath}</div>
                        <button
                          onClick={() => approveManualMutation.mutate({ id: selected.id, category })}
                          disabled={approveManualMutation.isPending}
                          className="mt-2 w-full bg-blue-700 hover:bg-blue-600 text-white text-xs py-1.5 rounded transition-colors disabled:opacity-40"
                        >
                          {selected.status === 'APPROVED' ? 'Bu kategoriyle degistir' : 'Manuel onayla'}
                        </button>
                      </div>
                    ))}
                    {manualSearch.trim().length >= 2 && categorySearch?.data.length === 0 && !isSearchingCategories && (
                      <div className="text-xs text-gray-500 px-1">Pazaryeri kategorisi bulunamadi</div>
                    )}
                  </div>
                </div>
                )}

              </div>

              <div className="p-4 border-t border-gray-800 grid grid-cols-3 gap-2">
                <button
                  onClick={() => rejectMutation.mutate(selected.id)}
                  disabled={rejectMutation.isPending}
                  className="bg-red-900/50 hover:bg-red-900 text-red-300 text-xs py-2 rounded transition-colors disabled:opacity-40"
                >
                  Reddet
                </button>
                <button
                  onClick={() => resetMutation.mutate(selected.id)}
                  disabled={selected.status === 'PENDING' || resetMutation.isPending}
                  className="bg-yellow-900/40 hover:bg-yellow-900/60 text-yellow-200 text-xs py-2 rounded transition-colors disabled:opacity-40"
                >
                  Onayi Geri Al
                </button>
                <button
                  onClick={() => {
                    setSelectedId(null)
                    setManualSearch('')
                  }}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs py-2 rounded transition-colors"
                >
                  Kapat
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
