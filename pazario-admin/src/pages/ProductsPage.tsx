import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import MarketplaceAttributeSections from '../components/MarketplaceAttributeSections'
import ProductMediaEditor from '../components/ProductMediaEditor'
import { Images } from 'lucide-react'

interface Product {
  id: string
  sku: string
  title: string
  brand: string | null
  categoryRaw: string | null
  price: number
  stock: number
  images: string[]
  updatedAt: string
  listings?: ProductMarketplaceListing[]
  variantParentKey?: string
  variantColor?: string
  variantTotal?: number
    publishProductIds?: string[]
    groupProductIds?: string[]
}

interface ProductMarketplaceListing {
  marketplace: string
  status: 'PENDING' | 'PUBLISHED' | 'FAILED' | 'DELISTED' | string
  lastUpdatedAt?: string | null
}

interface ProductsResponse {
  data: Product[]
  meta: {
    total: number
    rawTotal?: number
    groupedTotal?: number
    page: number
    limit: number
    grouped?: boolean
    marketplaceStatus?: Record<string, { published: number; pending: number; failed: number; missing: number }>
  }
}

interface XmlSource {
  id: string
  name: string
  url: string
  active: boolean
  _count: { products: number }
}

interface CategoryOption {
  category: string
  count: number
}

interface SocialPublishResult {
  productId: string
  sku: string
  targets: string[]
  makeStatus: number
}

interface ProductAttributeField {
  attributeId: string
  attributeName: string
  attributeType: 'dropdown' | 'multi_select' | 'free_text' | 'number' | 'boolean' | 'color'
  isMandatory: boolean
  allowCustomValue: boolean
  values: { id: string; name: string }[]
  currentValue: string | string[] | boolean | null
  isValid: boolean
  validationError: string | null
  systemManaged: boolean
}

interface ProductAttributeSchema {
  product: { id: string; title: string; categoryRaw: string | null }
  mapping: { marketplaceCategoryId: string; marketplaceCategoryPath: string | null }
  attributes: ProductAttributeField[]
  source: 'cache' | 'api'
  fetchedAt: string
}

interface MarketplacePublishCheck {
  productId: string
  sku: string
  title: string
  imageUrl?: string | null
  categoryRaw: string | null
  sourceId: string | null
  sourceName: string | null
  marketplace: string
  canPublish: boolean
  variantParentKey?: string
  variantColor?: string
  publishProductIds?: string[]
  variantTotal?: number
  readyVariantCount?: number
  blockedVariantCount?: number
  purchasePrice?: number | null
  calculatedPrice: { finalPrice: number; ruleName: string; minPriceApplied: boolean } | null
  existingListingStatus: string | null
  checks: { key: string; ok: boolean; message: string }[]
}

interface BulkMarketplacePublishCheck {
  marketplace: string
  checked: number
  requested: number
  hiddenStockInsufficient: number
  ready: number
  blocked: number
  reasonCounts: Record<string, number>
  results: MarketplacePublishCheck[]
}

interface BulkAttributeGroup {
  key: string
  categoryRaw: string
  sourceName: string
  sample: MarketplacePublishCheck
  productIds: string[]
  count: number
}

interface AutoFillAttributesResult {
  marketplace: string
  requested: number
  scanned: number
  updatedProducts: number
  filled: number
  unresolved: { productId: string; sku: string; attributeId: string; attributeName: string }[]
  skipped: { productId: string; reason: string }[]
}

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const MARKETPLACE_BADGES = [
  { marketplace: 'TRENDYOL', label: 'TR' },
  { marketplace: 'HEPSIBURADA', label: 'HB' },
  { marketplace: 'N11', label: 'N1' },
  { marketplace: 'PAZARAMA', label: 'PA' },
]
const PAGE_SIZE_OPTIONS = [25, 50, 100]
const STOCK_FILTERS = [
  { label: 'Stok esigi uygula', value: 'marketplace' },
  { label: 'Tum stoklar', value: 'all' },
]
const TRANSFER_STATUS_FILTERS = [
  { label: 'Tum aktarim durumlari', value: '' },
  { label: 'Gonderilmeye Hazir / Eksik', value: 'not_published' },
  { label: 'Yayinda', value: 'published' },
]

function marketplaceBadgeClass(status?: string | null) {
  if (status === 'PUBLISHED') return 'bg-emerald-900/70 text-emerald-200 border-emerald-700'
  if (status === 'PENDING') return 'bg-yellow-900/70 text-yellow-100 border-yellow-600'
  return 'bg-red-950/70 text-red-200 border-red-800'
}

function marketplaceStatusLabel(status?: string | null) {
  if (status === 'PUBLISHED') return 'Yuklendi / onaylandi'
  if (status === 'PENDING') return 'Onay surecinde'
  if (status === 'FAILED') return 'Hatali'
  if (status === 'DELISTED') return 'Yayindan kaldirildi'
  return 'Yuklenmedi'
}

export default function ProductsPage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [category, setCategory] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [stockFilter, setStockFilter] = useState('marketplace')
  const [minStock, setMinStock] = useState(6)
  const [transferStatus, setTransferStatus] = useState('')
  const [socialMessage, setSocialMessage] = useState('')
  const [attributeProduct, setAttributeProduct] = useState<Product | null>(null)
  const [attributeMarketplace, setAttributeMarketplace] = useState('PAZARAMA')
  const [attributeTargetProductIds, setAttributeTargetProductIds] = useState<string[]>([])
  const [attributeValues, setAttributeValues] = useState<Record<string, string>>({})
  const [attributeProductTitle, setAttributeProductTitle] = useState('')
  const [attributeMessage, setAttributeMessage] = useState('')
  const [publishMarketplace, setPublishMarketplace] = useState('TRENDYOL')
  const [publishCheck, setPublishCheck] = useState<MarketplacePublishCheck | null>(null)
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [bulkPublishCheck, setBulkPublishCheck] = useState<BulkMarketplacePublishCheck | null>(null)
  const [bulkResultFilter, setBulkResultFilter] = useState<'all' | 'missing' | 'ready' | 'published'>('all')
  const [bulkPreviewImage, setBulkPreviewImage] = useState<{ src: string; title: string } | null>(null)
  const [showBulkAttributeGroups, setShowBulkAttributeGroups] = useState(false)
  const [mediaProductId, setMediaProductId] = useState<string | null>(null)
  const [mediaProductIds, setMediaProductIds] = useState<string[]>([])

  const { data, isLoading } = useQuery<ProductsResponse>({
    queryKey: ['products', page, pageSize, search, category, sourceId, stockFilter, minStock, publishMarketplace, transferStatus],
    queryFn: () =>
      api.get('/products', {
        params: {
          page,
          limit: pageSize,
          search: search || undefined,
          category: category || undefined,
          sourceId: sourceId || undefined,
          stockFilter,
          minStock: stockFilter === 'marketplace' ? minStock : undefined,
          transferMarketplace: transferStatus ? publishMarketplace : undefined,
          transferStatus: transferStatus || undefined,
        },
      }).then(r => r.data),
  })

  const { data: categories } = useQuery<{ data: CategoryOption[] }>({
    queryKey: ['product-categories', sourceId],
    queryFn: () =>
      api.get('/products/categories', {
        params: {
          sourceId: sourceId || undefined,
        },
      }).then(r => r.data),
  })

  const { data: sources } = useQuery<{ data: XmlSource[] }>({
    queryKey: ['sources'],
    queryFn: () => api.get('/sources').then(r => r.data),
  })

  const {
    data: attributeSchema,
    isFetching: isAttributesLoading,
    error: attributeSchemaError,
  } = useQuery<{ success: boolean; data: ProductAttributeSchema }>({
    queryKey: ['product-attribute-schema', attributeProduct?.id, attributeMarketplace],
    enabled: Boolean(attributeProduct?.id),
    retry: false,
    queryFn: () =>
      api.get(`/products/${attributeProduct?.id}/attribute-schema/${attributeMarketplace}`).then(r => r.data),
  })

  useEffect(() => {
    if (!attributeSchema?.data.attributes) {
      setAttributeValues({})
      return
    }

    const nextValues: Record<string, string> = {}
    for (const attr of attributeSchema.data.attributes) {
      const value = attr.currentValue
      nextValues[attr.attributeId] = Array.isArray(value)
        ? value.join(',')
        : typeof value === 'boolean'
          ? String(value)
          : String(value ?? '')
    }
    setAttributeValues(nextValues)
  }, [attributeSchema])

  const socialPublish = useMutation({
    mutationFn: (productId: string) =>
      api.post<{ success: boolean; data: SocialPublishResult }>(`/products/${productId}/social-publish`, {
        targets: ['pinterest', 'instagram'],
      }).then(r => r.data.data),
    onSuccess: result => {
      setSocialMessage(`${result.sku} Make webhook'una gonderildi. Hedefler: ${result.targets.join(', ')}.`)
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.detail || error?.response?.data?.error || 'Sosyal medya gonderimi basarisiz'
      setSocialMessage(typeof detail === 'string' ? detail : JSON.stringify(detail))
    },
  })

  const saveAttributes = useMutation({
    mutationFn: async () => {
      const attrs = attributeSchema?.data.attributes ?? []
      const payload = attrs
        .filter(attr => !attr.systemManaged)
        .map(attr => {
          const value = (attributeValues[attr.attributeId] ?? '').trim()
          if (!value) return null
          if (attr.attributeType === 'dropdown' || attr.attributeType === 'multi_select' || attr.attributeType === 'color') {
            const isMarketplaceValue = attr.values.some(option => option.id === value)
            return isMarketplaceValue
              ? { attributeId: attr.attributeId, valueId: value }
              : { attributeId: attr.attributeId, valueText: value }
          }
          return { attributeId: attr.attributeId, valueText: value }
        })
        .filter(Boolean)

      const targetIds = attributeTargetProductIds.length > 0
        ? attributeTargetProductIds
        : attributeProduct?.id
          ? [attributeProduct.id]
          : []

      const nextTitle = attributeProductTitle.trim()
      const shouldUpdateTitle = targetIds.length === 1 && Boolean(attributeProduct && nextTitle && nextTitle !== attributeProduct.title)

      if (shouldUpdateTitle) {
        await Promise.all(targetIds.map(productId =>
          api.patch(`/products/${productId}`, { title: nextTitle })
        ))
      }

      if (targetIds.length > 1) {
        return api.post('/products/attributes/bulk-apply', {
          marketplace: attributeMarketplace,
          productIds: targetIds,
          attributes: payload,
        })
      }

      return api.put(`/products/${attributeProduct?.id}/attributes/${attributeMarketplace}`, {
        attributes: payload,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product-attribute-schema', attributeProduct?.id, attributeMarketplace] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
      const idsToRecheck = Array.from(new Set<string>(
        bulkPublishCheck?.results.flatMap(result =>
          result.publishProductIds?.length ? result.publishProductIds : [result.productId]
        ) ?? []
      ))
      if (idsToRecheck.length > 0) {
        closeAttributeModal()
        setShowBulkAttributeGroups(false)
        bulkMarketplaceCheck.mutate(idsToRecheck)
      } else {
        setAttributeMessage(attributeTargetProductIds.length > 1
          ? `${attributeTargetProductIds.length} varyanta ozellikler kaydedildi.`
          : 'Urun adi/ozellikler kaydedildi.')
      }
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.errors || error?.response?.data?.error || 'Ozellikler kaydedilemedi'
      setAttributeMessage(typeof detail === 'string' ? detail : JSON.stringify(detail))
    },
  })

  const marketplaceCheck = useMutation({
    mutationFn: (productId: string) =>
      api.post<{ success: boolean; data: MarketplacePublishCheck }>(`/products/${productId}/marketplace-check`, {
        marketplace: publishMarketplace,
      }).then(r => r.data.data),
    onSuccess: result => setPublishCheck(result),
    onError: (error: any) => {
      const detail = error?.response?.data?.error || 'Gonderim kontrolu basarisiz'
      setSocialMessage(String(detail))
    },
  })

  const bulkMarketplaceCheck = useMutation({
    mutationFn: (productIds: string[]) =>
      api.post<{ success: boolean; data: BulkMarketplacePublishCheck }>('/products/marketplace-check', {
        marketplace: publishMarketplace,
        productIds,
      }).then(r => r.data.data),
    onSuccess: result => {
      setBulkPublishCheck(result)
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.error || 'Toplu gonderim kontrolu basarisiz'
      setSocialMessage(String(detail))
    },
  })

  const submitMarketplacePublish = useMutation({
    mutationFn: ({ productIds, force = false }: { productIds: string[]; force?: boolean }) =>
      api.post<{ success: boolean; submitted: number; skipped: { productId: string; reason: string }[]; jobIds: string[] }>('/publish/submit', {
        marketplace: publishMarketplace,
        productIds,
        force,
      }).then(r => r.data),
    onSuccess: result => {
      setSocialMessage(`${result.submitted} urun gonderim kuyruguna alindi. ${result.skipped.length} urun atlandi.`)
      setBulkPublishCheck(null)
      setBulkResultFilter('all')
      setSelectedProductIds([])
      setPublishCheck(null)
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.error || 'Urun gonderimi basarisiz'
      setSocialMessage(String(detail))
    },
  })

  const autoFillMissingAttributes = useMutation({
    mutationFn: (productIds: string[]) =>
      api.post<{ success: boolean; data: AutoFillAttributesResult }>('/products/attributes/auto-fill', {
        marketplace: publishMarketplace,
        productIds,
      }).then(r => r.data.data),
    onSuccess: result => {
      setSocialMessage(`${result.updatedProducts} urunde ${result.filled} eksik ozellik urun adi/kategoriden tamamlandi.`)
      if (attributeProduct?.id) {
        queryClient.invalidateQueries({ queryKey: ['product-attribute-schema', attributeProduct.id, attributeMarketplace] })
      }
      const idsToCheck = missingBulkProductIds.length > 0 ? missingBulkProductIds : selectedProductIds
      if (idsToCheck.length > 0) bulkMarketplaceCheck.mutate(idsToCheck)
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.error || 'Eksik ozellikler otomatik tamamlanamadi'
      setSocialMessage(String(detail))
    },
  })

  const totalPages = data ? Math.ceil(data.meta.total / pageSize) : 1
  const getProductTargetIds = (product: Product) =>
    product.publishProductIds?.length ? product.publishProductIds : [product.id]
  const visibleProductIds = data?.data.flatMap(getProductTargetIds) ?? []
  const allVisibleSelected = visibleProductIds.length > 0 && visibleProductIds.every(id => selectedProductIds.includes(id))
  const pageStart = data && data.meta.total > 0 ? (page - 1) * pageSize + 1 : 0
  const pageEnd = data ? Math.min(page * pageSize, data.meta.total) : 0
  const marketplaceSummary = data?.meta.marketplaceStatus?.[publishMarketplace]
  const publishedCount = marketplaceSummary?.published ?? 0
  const missingCount = marketplaceSummary?.missing ?? 0
  const rawTotal = data?.meta.rawTotal ?? data?.meta.total ?? 0
  const groupedTotal = data?.meta.groupedTotal ?? data?.meta.total ?? 0

  const handlePageSizeChange = (value: string) => {
    setPageSize(Number(value))
    setPage(1)
  }

  const paginationControls = data && (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-y border-gray-800 bg-gray-900">
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span>
          {pageStart} - {pageEnd} / {data.meta.total} grup
          {data.meta.grouped && data.meta.rawTotal !== undefined && ` (${data.meta.rawTotal} varyant)`}
        </span>
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
          <span>urun</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700 transition-colors"
        >
          Onceki
        </button>
        <span className="px-3 py-1 text-xs text-gray-400">
          {page} / {totalPages}
        </span>
        <button
          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700 transition-colors"
        >
          Sonraki
        </button>
      </div>
    </div>
  )

  const toggleProductSelection = (product: Product) => {
    const targetIds = getProductTargetIds(product)
    const allSelected = targetIds.every(id => selectedProductIds.includes(id))
    setSelectedProductIds(current => {
      if (allSelected) return current.filter(id => !targetIds.includes(id))
      return Array.from(new Set([...current, ...targetIds]))
    })
  }

  const toggleVisibleSelection = () => {
    setSelectedProductIds(current => {
      if (allVisibleSelected) return current.filter(id => !visibleProductIds.includes(id))
      return Array.from(new Set([...current, ...visibleProductIds]))
    })
  }

  const handleSearch = () => {
    setPage(1)
    setSearch(searchInput)
    setSelectedProductIds([])
    setBulkPublishCheck(null)
  }

  const handleCategoryChange = (value: string) => {
    setPage(1)
    setCategory(value)
    setSelectedProductIds([])
    setBulkPublishCheck(null)
  }

  const handleSourceChange = (value: string) => {
    setPage(1)
    setSourceId(value)
    setCategory('')
    setSelectedProductIds([])
    setBulkPublishCheck(null)
  }

  const openAttributeModal = (product: Product, marketplaceName = 'PAZARAMA', targetProductIds: string[] = [product.id]) => {
    setAttributeProduct(product)
    setAttributeProductTitle(product.title)
    setAttributeMarketplace(marketplaceName)
    setAttributeTargetProductIds(targetProductIds)
    setAttributeMessage('')
  }

  const closeAttributeModal = () => {
    setAttributeProduct(null)
    setAttributeTargetProductIds([])
    setAttributeValues({})
    setAttributeProductTitle('')
    setAttributeMessage('')
  }

  const mandatoryMissing = attributeSchema?.data.attributes.filter(
    attr => attr.isMandatory && !(attributeValues[attr.attributeId] ?? '').trim()
  ) ?? []
  const attributeFields = attributeSchema?.data.attributes ?? []
  const attributeMandatoryCount = attributeFields.filter(attr => attr.isMandatory).length
  const attributeOptionalCount = attributeFields.filter(attr => !attr.isMandatory).length
  const isBulkAttributeEdit = attributeTargetProductIds.length > 1

  const openAttributeModalFromCheck = (result: MarketplacePublishCheck) => {
    const targetProductIds = result.publishProductIds?.length
      ? result.publishProductIds
      : [result.productId]
    openAttributeModal({
      id: result.productId,
      sku: result.sku,
      title: result.title,
      brand: null,
      categoryRaw: result.categoryRaw,
      price: 0,
      stock: 0,
      images: [],
      updatedAt: '',
    }, result.marketplace, targetProductIds)
    setPublishCheck(null)
  }

  const openBulkAttributeGroup = (group: { sample: MarketplacePublishCheck; productIds: string[] }) => {
    openAttributeModal({
      id: group.sample.productId,
      sku: group.sample.sku,
      title: group.sample.title,
      brand: null,
      categoryRaw: group.sample.categoryRaw,
      price: 0,
      stock: 0,
      images: group.sample.imageUrl ? [group.sample.imageUrl] : [],
      updatedAt: '',
    }, group.sample.marketplace, group.productIds)
  }

  const openCategoryMappingFromCheck = (result: MarketplacePublishCheck) => {
    const params = new URLSearchParams({
      marketplace: result.marketplace,
      status: '',
    })
    if (result.sourceId) params.set('sourceId', result.sourceId)
    if (result.categoryRaw) params.set('search', result.categoryRaw)
    window.location.href = `/categories?${params.toString()}`
  }

  const readyBulkProductIds: string[] = Array.from(new Set<string>(
    bulkPublishCheck?.results
      .filter(result => result.canPublish)
      .flatMap(result => result.publishProductIds?.length ? result.publishProductIds : [result.productId]) ?? []
  ))
  const isAlreadyPublishedOnly = (result: MarketplacePublishCheck) => {
    return result.existingListingStatus === 'PUBLISHED'
  }
  const hasActionableIssue = (result: MarketplacePublishCheck) =>
    !result.canPublish && !isAlreadyPublishedOnly(result)
  const missingBulkProductIds: string[] = Array.from(new Set<string>(bulkPublishCheck?.results
    .filter(hasActionableIssue)
    .flatMap(result => result.groupProductIds?.length ? result.groupProductIds : [result.productId]) ?? []))
  const alreadyPublishedBulkProductIds = bulkPublishCheck?.results
    .filter(isAlreadyPublishedOnly)
    .flatMap(result => result.publishProductIds?.length ? result.publishProductIds : [result.productId]) ?? []
  const visibleBulkResults = bulkPublishCheck?.results.filter(result => {
    if (bulkResultFilter === 'missing') return hasActionableIssue(result)
    if (bulkResultFilter === 'ready') return result.canPublish
    if (bulkResultFilter === 'published') return isAlreadyPublishedOnly(result)
    return true
  }) ?? []
  const bulkAttributeGroupMap = (bulkPublishCheck?.results ?? [])
    .filter(result => {
      const hasMandatoryIssue = result.checks.some(check => !check.ok && check.key === 'mandatory_attributes')
      return result.canPublish || (hasActionableIssue(result) && hasMandatoryIssue)
    })
    .reduce<Record<string, BulkAttributeGroup>>((acc, result) => {
      const key = `${result.marketplace}|${result.sourceId ?? ''}|${result.categoryRaw ?? ''}`
      const targetIds = result.groupProductIds?.length
        ? result.groupProductIds
        : result.publishProductIds?.length
          ? result.publishProductIds
          : [result.productId]
      if (!acc[key]) {
        acc[key] = {
          key,
          categoryRaw: result.categoryRaw ?? 'Kategori yok',
          sourceName: result.sourceName ?? 'Kaynak yok',
          sample: result,
          productIds: [],
          count: 0,
        }
      }
      acc[key].productIds = Array.from(new Set([...acc[key].productIds, ...targetIds]))
      acc[key].count += 1
      return acc
    }, {})
  const bulkAttributeGroups = Object.keys(bulkAttributeGroupMap)
    .map(key => bulkAttributeGroupMap[key])
    .sort((a, b) => b.count - a.count)

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Urunler</h1>
          <p className="text-slate-600 text-sm mt-1">
            {groupedTotal} varyant grubu / {rawTotal} varyant
          </p>
        </div>
      </div>

      {socialMessage && (
        <div className="mb-5 rounded-lg border border-blue-800 bg-blue-950/40 px-4 py-3 text-sm text-blue-100">
          {socialMessage}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4 mb-5">
        {[
          { label: 'Renk Grubu', value: groupedTotal, color: 'text-blue-800', bg: 'bg-blue-100/70' },
          { label: 'Secili Urunler', value: selectedProductIds.length, color: 'text-green-800', bg: 'bg-green-100/70' },
          { label: `${publishMarketplace} Yayinda`, value: publishedCount, color: 'text-emerald-800', bg: 'bg-emerald-100/70' },
          { label: 'Yuklenmemis', value: missingCount, color: 'text-amber-800', bg: 'bg-amber-100/70' },
        ].map(card => (
          <div key={card.label} className={`rounded-2xl border border-gray-800 px-4 py-3 ${card.bg}`}>
            <div className={`text-3xl font-bold ${card.color}`}>{card.value}</div>
            <div className="text-xs font-medium text-slate-700 mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={sourceId}
          onChange={e => handleSourceChange(e.target.value)}
          className="w-64 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          <option value="">Tum XML kaynaklari</option>
          {sources?.data.map(source => (
            <option key={source.id} value={source.id}>
              {source.name} ({source._count.products})
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="SKU, urun adi ara..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleSearch}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Ara
        </button>
        <select
          value={category}
          onChange={e => handleCategoryChange(e.target.value)}
          className="w-80 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          <option value="">Tum kategoriler</option>
          {categories?.data.map(item => (
            <option key={item.category} value={item.category}>
              {item.category} ({item.count})
            </option>
          ))}
        </select>
        <select
          value={stockFilter}
          onChange={e => { setStockFilter(e.target.value); setPage(1); setSelectedProductIds([]); setBulkPublishCheck(null) }}
          className="w-44 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          {STOCK_FILTERS.map(filter => (
            <option key={filter.value} value={filter.value}>{filter.label}</option>
          ))}
        </select>
        {stockFilter === 'marketplace' && (
          <label className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100">
            <span className="whitespace-nowrap text-gray-400">Stok &gt;</span>
            <input
              type="number"
              min={0}
              step={1}
              value={minStock}
              onChange={e => {
                const nextValue = Math.max(0, Math.floor(Number(e.target.value) || 0))
                setMinStock(nextValue)
                setPage(1)
                setSelectedProductIds([])
                setBulkPublishCheck(null)
              }}
              className="w-20 bg-gray-950 border border-gray-800 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            />
          </label>
        )}
        {(search || category || sourceId || stockFilter !== 'marketplace' || minStock !== 6 || transferStatus) && (
          <button
            onClick={() => {
              setSearch('')
              setSearchInput('')
              setCategory('')
              setSourceId('')
              setStockFilter('marketplace')
              setMinStock(6)
              setTransferStatus('')
              setSelectedProductIds([])
              setBulkPublishCheck(null)
              setPage(1)
            }}
            className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm transition-colors"
          >
            Temizle
          </button>
        )}
        <select
          value={publishMarketplace}
          onChange={e => {
            setPublishMarketplace(e.target.value)
            setPage(1)
            setSelectedProductIds([])
            setBulkPublishCheck(null)
          }}
          className="w-44 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          {MARKETPLACES.map(mp => (
            <option key={mp} value={mp}>{mp}</option>
          ))}
        </select>
        <select
          value={transferStatus}
          onChange={e => {
            setTransferStatus(e.target.value)
            setPage(1)
            setSelectedProductIds([])
            setBulkPublishCheck(null)
          }}
          className="w-60 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          aria-label="Aktarim durumu"
        >
          {TRANSFER_STATUS_FILTERS.map(filter => (
            <option key={filter.value} value={filter.value}>{filter.label}</option>
          ))}
        </select>
        <button
          onClick={() => {
            setBulkResultFilter('all')
            bulkMarketplaceCheck.mutate(selectedProductIds)
          }}
          disabled={bulkMarketplaceCheck.isPending || selectedProductIds.length === 0}
          className="bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-600 disabled:text-slate-100 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          {bulkMarketplaceCheck.isPending ? 'Kontrol ediliyor...' : `Toplu Kontrol (${selectedProductIds.length})`}
        </button>
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {paginationControls}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
                <th className="text-left px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleVisibleSelection}
                    className="h-4 w-4"
                  />
                </th>
                <th className="text-left px-4 py-3">Gorsel</th>
                <th className="text-left px-4 py-3">Urun</th>
                <th className="text-left px-4 py-3">SKU</th>
                <th className="text-left px-4 py-3">Marka</th>
                <th className="text-right px-4 py-3">Fiyat</th>
                <th className="text-right px-4 py-3">Stok</th>
                <th className="text-left px-4 py-3">Pazaryerleri</th>
                <th className="text-left px-4 py-3">Ozellik</th>
                <th className="text-left px-4 py-3">Gonderim</th>
                <th className="text-left px-4 py-3">Sosyal</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-gray-500">
                    Yukleniyor...
                  </td>
                </tr>
              ) : data?.data.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-gray-500">
                    Urun bulunamadi
                  </td>
                </tr>
              ) : (
                data?.data.map(product => {
                  const listingStatusByMarketplace = new Map(
                    (product.listings ?? []).map(listing => [listing.marketplace, listing.status])
                  )
                  const productTargetIds = getProductTargetIds(product)
                  const isProductSelected = productTargetIds.every(id => selectedProductIds.includes(id))

                  return (
                  <tr
                    key={product.id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isProductSelected}
                        onChange={() => toggleProductSelection(product)}
                        className="h-4 w-4"
                      />
                    </td>

                    {/* Gorsel */}
                    <td className="px-4 py-3">
                      {product.images[0] ? (
                        <div
                          className="inline-flex"
                          onMouseEnter={() => setBulkPreviewImage({ src: product.images[0] as string, title: product.title })}
                          onMouseLeave={() => setBulkPreviewImage(null)}
                        >
                          <img
                            src={product.images[0]}
                            alt={product.title}
                            className="w-10 h-10 cursor-zoom-in object-cover rounded-lg bg-gray-800 transition-transform hover:scale-105"
                            onError={e => {
                              (e.target as HTMLImageElement).style.display = 'none'
                              setBulkPreviewImage(null)
                            }}
                          />
                        </div>
                      ) : (
                        <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center text-gray-600 text-xs">
                          YOK
                        </div>
                      )}
                    </td>

                    {/* Urun Adi */}
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-100 line-clamp-1 max-w-xs">
                        {product.title}
                      </div>
                      {product.categoryRaw && (
                        <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                          {product.categoryRaw}
                        </div>
                      )}
                      {(product.variantColor || (product.variantTotal ?? 1) > 1) && (
                        <div className="text-[11px] text-blue-300 mt-1">
                          {product.variantColor ? `Renk: ${product.variantColor}` : 'Renk varyanti'}
                          {(product.variantTotal ?? 1) > 1 && ` | ${product.variantTotal} varyant`}
                        </div>
                      )}
                    </td>

                    {/* SKU */}
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded">
                        {product.sku}
                      </span>
                    </td>

                    {/* Marka */}
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {product.brand ?? '-'}
                    </td>

                    {/* Fiyat */}
                    <td className="px-4 py-3 text-right">
                      <span className="font-medium text-green-400">
                        {Number(product.price).toLocaleString('tr-TR', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })} TL
                      </span>
                    </td>

                    {/* Stok */}
                    <td className="px-4 py-3 text-right">
                      <span className={`font-medium ${product.stock === 0 ? 'text-red-400' : 'text-gray-300'}`}>
                        {product.stock}
                      </span>
                    </td>

                    {/* Pazaryerleri */}
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {MARKETPLACE_BADGES.map(({ marketplace, label }) => {
                          const status = listingStatusByMarketplace.get(marketplace)
                          return (
                          <span
                            key={marketplace}
                            className={`text-xs px-1.5 py-0.5 rounded border ${marketplaceBadgeClass(status)}`}
                            title={`${marketplace}: ${marketplaceStatusLabel(status)}`}
                          >
                            {label}
                          </span>
                          )
                        })}
                      </div>
                    </td>

                    {/* Ozellikler */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => openAttributeModal(product, publishMarketplace, productTargetIds)}
                        className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                      >
                        Ozellikler
                      </button>
                      <button onClick={() => { setMediaProductId(product.id); setMediaProductIds(productTargetIds) }} title="Gorseller ve Video" aria-label={`${product.sku} gorseller ve video`}
                        className="ml-2 inline-flex h-8 w-8 items-center justify-center rounded border border-gray-600 bg-gray-800 text-white hover:bg-gray-700">
                        <Images size={16} />
                      </button>
                    </td>

                    {/* Sosyal Medya */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => marketplaceCheck.mutate(product.id)}
                        disabled={marketplaceCheck.isPending}
                        className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                      >
                        {marketplaceCheck.isPending ? 'Kontrol...' : 'Kontrol Et'}
                      </button>
                    </td>

                    {/* Sosyal Medya */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => socialPublish.mutate(product.id)}
                        disabled={socialPublish.isPending || !product.images[0]}
                        className="bg-pink-700 hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                        title={!product.images[0] ? 'Gorseli olmayan urun gonderilemez' : 'Make uzerinden Pinterest ve Instagram gonderimi'}
                      >
                        {socialPublish.isPending ? 'Gonderiliyor...' : 'Sosyal Medya'}
                      </button>
                    </td>
                  </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {paginationControls}
      </div>

      {mediaProductId && <ProductMediaEditor productId={mediaProductId} productIds={mediaProductIds} onClose={() => setMediaProductId(null)} onSaved={() => {
        queryClient.invalidateQueries({ queryKey: ['products'] })
        queryClient.invalidateQueries({ queryKey: ['product-attribute-schema'] })
      }} />}
      {bulkPublishCheck && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl max-h-[88vh] bg-gray-950 border border-gray-800 rounded-lg overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-800 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-gray-100">Toplu Gonderim Kontrolu</h2>
                <div className="text-xs text-gray-500 mt-1">
                  {bulkPublishCheck.marketplace} | {bulkPublishCheck.requested} varyant istendi, {bulkPublishCheck.checked} varyant grubu kontrol edildi, {bulkPublishCheck.ready} hazir, {missingBulkProductIds.length} duzeltilecek eksik
                  {alreadyPublishedBulkProductIds.length > 0 && `, ${alreadyPublishedBulkProductIds.length} zaten yayinda`}
                  {bulkPublishCheck.hiddenStockInsufficient > 0 && `, ${bulkPublishCheck.hiddenStockInsufficient} stok yetersiz gizlendi`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => submitMarketplacePublish.mutate({ productIds: readyBulkProductIds })}
                  disabled={submitMarketplacePublish.isPending || readyBulkProductIds.length === 0}
                  className="bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded"
                >
                  {submitMarketplacePublish.isPending ? 'Gonderiliyor...' : `Hazir Urunleri Gonder (${readyBulkProductIds.length})`}
                </button>
                <button
                  onClick={() => submitMarketplacePublish.mutate({ productIds: alreadyPublishedBulkProductIds, force: true })}
                  disabled={submitMarketplacePublish.isPending || alreadyPublishedBulkProductIds.length === 0}
                  className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded"
                >
                  {submitMarketplacePublish.isPending ? 'Guncelleniyor...' : `Yayindakileri Guncelle (${alreadyPublishedBulkProductIds.length})`}
                </button>
                <button
                  onClick={() => setBulkResultFilter('missing')}
                  disabled={missingBulkProductIds.length === 0}
                  className="bg-red-800 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded"
                >
                  Eksik Urunleri Goster ({missingBulkProductIds.length})
                </button>
                <button
                  onClick={() => bulkMarketplaceCheck.mutate(missingBulkProductIds)}
                  disabled={bulkMarketplaceCheck.isPending || missingBulkProductIds.length === 0}
                  className="bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded"
                >
                  {bulkMarketplaceCheck.isPending ? 'Kontrol...' : 'Eksikleri Yeniden Kontrol Et'}
                </button>
                <button
                  onClick={() => autoFillMissingAttributes.mutate(missingBulkProductIds)}
                  disabled={autoFillMissingAttributes.isPending || missingBulkProductIds.length === 0}
                  className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded"
                >
                  {autoFillMissingAttributes.isPending ? 'Tamamlaniyor...' : 'Eksikleri Otomatik Tamamla'}
                </button>
                <button
                  onClick={() => setShowBulkAttributeGroups(value => !value)}
                  disabled={bulkAttributeGroups.length === 0}
                  className="bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded"
                >
                  Toplu Ozellik Guncelle ({bulkAttributeGroups.length})
                </button>
                <button
                  onClick={() => {
                    setBulkPublishCheck(null)
                    setBulkResultFilter('all')
                    setBulkPreviewImage(null)
                    setShowBulkAttributeGroups(false)
                  }}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm px-3 py-1.5 rounded"
                >
                  Kapat
                </button>
              </div>
            </div>

            <div className="p-5 border-b border-gray-800 grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'Hazir', value: bulkPublishCheck.ready, color: 'text-green-400' },
                { label: 'Duzeltilecek Eksik', value: missingBulkProductIds.length, color: 'text-red-400' },
                { label: 'Kategori', value: bulkPublishCheck.reasonCounts.category_mapping ?? 0, color: 'text-yellow-300' },
                { label: 'Fiyat/Ozellik', value: (bulkPublishCheck.reasonCounts.price ?? 0) + (bulkPublishCheck.reasonCounts.mandatory_attributes ?? 0), color: 'text-yellow-300' },
                { label: 'Zaten Yayinda', value: alreadyPublishedBulkProductIds.length, color: 'text-yellow-300' },
                { label: 'Gizlenen Stok', value: bulkPublishCheck.hiddenStockInsufficient, color: 'text-gray-400' },
              ].map(card => (
                <div key={card.label} className="rounded-lg border border-gray-800 bg-gray-900 p-3">
                  <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
                  <div className="text-xs text-gray-500 mt-1">{card.label}</div>
                </div>
              ))}
            </div>

            {showBulkAttributeGroups && (
              <div className="px-5 py-4 border-b border-gray-800 bg-gray-900/60">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-100">Kategori Bazinda Toplu Ozellik Guncelleme</div>
                    <div className="text-xs text-gray-500 mt-1">
                      Hazir veya eksik durumdaki ayni kategori ve XML kaynagindaki urunlere ayni ozellik degerleri uygulanir.
                    </div>
                  </div>
                  <button
                    onClick={() => setShowBulkAttributeGroups(false)}
                    className="rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
                  >
                    Gizle
                  </button>
                </div>
                {bulkAttributeGroups.length === 0 ? (
                  <div className="rounded-lg border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-gray-500">
                    Toplu duzenlenecek uygun urun grubu yok.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {bulkAttributeGroups.map(group => (
                      <div key={group.key} className="rounded-xl border border-gray-800 bg-gray-950 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="line-clamp-2 text-sm font-semibold text-gray-100">{group.categoryRaw}</div>
                            <div className="mt-1 text-xs text-gray-500">
                              {group.sourceName} | {group.count} urun grubu | {group.productIds.length} varyant
                            </div>
                          </div>
                          <button
                            onClick={() => openBulkAttributeGroup(group)}
                            className="shrink-0 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs text-white hover:bg-emerald-600"
                          >
                            Toplu Duzenle
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="px-5 py-3 border-b border-gray-800 flex flex-wrap items-center gap-2">
              {[
                { label: `Tumu (${bulkPublishCheck.results.length})`, value: 'all' },
                { label: `Eksik (${missingBulkProductIds.length})`, value: 'missing' },
                { label: `Hazir (${readyBulkProductIds.length})`, value: 'ready' },
                { label: `Yayinda (${alreadyPublishedBulkProductIds.length})`, value: 'published' },
              ].map(filter => (
                <button
                  key={filter.value}
                  onClick={() => setBulkResultFilter(filter.value as 'all' | 'missing' | 'ready' | 'published')}
                  className={`px-3 py-1.5 rounded text-xs transition-colors ${
                    bulkResultFilter === filter.value
                      ? 'bg-blue-700 text-white'
                      : 'bg-gray-900 text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-visible">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-950">
                  <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
                    <th className="text-left px-4 py-3">Durum</th>
                    <th className="text-left px-4 py-3">Gorsel</th>
                    <th className="text-left px-4 py-3">Urun</th>
                    <th className="text-left px-4 py-3">Alis</th>
                    <th className="text-left px-4 py-3">Satis</th>
                    <th className="text-left px-4 py-3">Eksikler</th>
                    <th className="text-left px-4 py-3">Duzelt</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleBulkResults.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                        Bu filtrede gosterilecek urun yok. Stok yetersiz urunler bu listede gizlenir.
                      </td>
                    </tr>
                  ) : (
                    visibleBulkResults.map(result => {
                      const failedChecks = result.checks.filter(check => !check.ok)
                      const hasCategoryIssue = failedChecks.some(check => check.key === 'category_mapping')
                      const hasAttributeIssue = failedChecks.some(check => check.key === 'mandatory_attributes')
                      const alreadyPublishedOnly = isAlreadyPublishedOnly(result)
                      const statusLabel = result.canPublish ? 'Hazir' : alreadyPublishedOnly ? 'Yayinda' : 'Eksik'
                      const statusClass = result.canPublish
                        ? 'bg-green-900/40 text-green-200'
                        : alreadyPublishedOnly
                          ? 'bg-yellow-900/40 text-yellow-200'
                          : 'bg-red-900/40 text-red-200'
                      return (
                        <tr key={result.productId} className="border-b border-gray-800/60">
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-1 rounded ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {result.imageUrl ? (
                              <div
                                className="inline-flex"
                                onMouseEnter={() => setBulkPreviewImage({ src: result.imageUrl as string, title: result.title })}
                                onMouseLeave={() => setBulkPreviewImage(null)}
                              >
                                <img
                                  src={result.imageUrl}
                                  alt={result.title}
                                  className="h-12 w-12 cursor-zoom-in rounded-lg border border-gray-700 bg-gray-900 object-cover transition-transform hover:scale-105"
                                  onError={event => {
                                    event.currentTarget.style.display = 'none'
                                    setBulkPreviewImage(null)
                                  }}
                                />
                              </div>
                            ) : (
                              <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-gray-800 bg-gray-900 text-[10px] text-gray-500">
                                YOK
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-gray-100 line-clamp-1 max-w-md">{result.title}</div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {result.sku}{result.sourceName ? ` | ${result.sourceName}` : ''}
                            </div>
                            {(result.variantColor || (result.variantTotal ?? 1) > 1) && (
                              <div className="text-[11px] text-blue-300 mt-1">
                                {result.variantColor ? `Renk: ${result.variantColor}` : 'Renk varyanti'}
                                {(result.variantTotal ?? 1) > 1 && ` | ${result.readyVariantCount ?? 0}/${result.variantTotal} varyant hazir`}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-200 whitespace-nowrap">
                            {typeof result.purchasePrice === 'number'
                              ? `${result.purchasePrice.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`
                              : '-'}
                          </td>
                          <td className="px-4 py-3 text-green-300 whitespace-nowrap">
                            {result.calculatedPrice
                              ? `${result.calculatedPrice.finalPrice.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`
                              : '-'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-300">
                            {failedChecks.map(check => check.message).join(' | ') || 'Yok'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              {result.canPublish && (
                                <button
                                  onClick={() => openAttributeModalFromCheck(result)}
                                  className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                                >
                                  Duzenle
                                </button>
                              )}
                              {hasCategoryIssue && (
                                <button
                                  onClick={() => openCategoryMappingFromCheck(result)}
                                  className="bg-blue-700 hover:bg-blue-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                                >
                                  Kategori Duzelt
                                </button>
                              )}
                              {hasAttributeIssue && (
                                <button
                                  onClick={() => openAttributeModalFromCheck(result)}
                                  className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                                >
                                  Ozellik Duzelt
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {bulkPreviewImage && (
        <div className="pointer-events-none fixed right-8 top-24 z-[100] max-w-xs rounded-xl border border-gray-700 bg-gray-950 p-2 shadow-2xl shadow-black/80">
          <img
            src={bulkPreviewImage.src}
            alt=""
            className="h-72 w-72 rounded-lg bg-gray-900 object-contain"
          />
          <div className="mt-2 line-clamp-2 px-1 text-xs text-gray-300">
            {bulkPreviewImage.title}
          </div>
        </div>
      )}

      {publishCheck && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl max-h-[90vh] bg-gray-950 border border-gray-800 rounded-lg overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-800 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-100">Pazaryeri Gonderim Kontrolu</h2>
                <div className="text-sm text-gray-400 truncate mt-1">{publishCheck.title}</div>
                <div className="text-xs text-gray-500 mt-1">{publishCheck.marketplace} | {publishCheck.sku}</div>
              </div>
              <button
                onClick={() => setPublishCheck(null)}
                className="bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm px-3 py-1.5 rounded"
              >
                Kapat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="space-y-4">
                  <div className="rounded-2xl border border-gray-800 bg-gray-900/70 p-4">
                    <div className="aspect-square max-h-72 rounded-xl border border-gray-800 bg-gray-950 overflow-hidden flex items-center justify-center">
                      {publishCheck.imageUrl ? (
                      <img
                        src={publishCheck.imageUrl}
                        alt={publishCheck.title}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="text-xs text-gray-500 px-4 text-center">Gorsel bulunamadi</div>
                    )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-800 bg-gray-900/70 p-4">
                    <div className="text-xs uppercase tracking-wider text-gray-500">Urun Detayi</div>
                    <div className="text-sm font-semibold text-gray-100 mt-1 line-clamp-3">{publishCheck.title}</div>
                    <div className="text-xs text-gray-500 mt-2 break-all">{publishCheck.marketplace} | {publishCheck.sku}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: 'Stok', value: publishCheck.checks.find(check => check.key === 'stock')?.ok ? 'Uygun' : 'Kontrol' },
                      { label: 'Durum', value: publishCheck.existingListingStatus === 'PUBLISHED' ? 'Yayinda' : publishCheck.canPublish ? 'Hazir' : 'Eksik' },
                      { label: 'Kaynak', value: publishCheck.sourceName ?? '-' },
                      { label: 'Kategori', value: publishCheck.categoryRaw ?? '-' },
                    ].map(item => (
                      <div key={item.label} className="rounded-xl border border-gray-800 bg-gray-950 px-3 py-2">
                        <div className="text-[11px] text-gray-500">{item.label}</div>
                        <div className="text-sm font-semibold text-gray-100 mt-1 line-clamp-2 break-words">{item.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className={`rounded-xl border px-4 py-3 text-sm ${
                    publishCheck.existingListingStatus === 'PUBLISHED' || publishCheck.canPublish
                      ? 'border-green-800 bg-green-950/30 text-green-100'
                      : 'border-yellow-800 bg-yellow-950/30 text-yellow-100'
                  }`}>
                    {publishCheck.existingListingStatus === 'PUBLISHED'
                      ? `Bu urun ${publishCheck.marketplace} uzerinde yayinda. Duzeltmeleri pazaryerine aktarmak icin Guncelle butonunu kullanin.`
                      : publishCheck.canPublish
                        ? `Bu grup gonderim icin hazir. ${publishCheck.readyVariantCount}/${publishCheck.variantTotal} varyant pazaryerine aktarilacak.`
                        : 'Bu urun henuz gonderime hazir degil. Eksikleri tamamlayin.'}
                  </div>

                  {publishCheck.calculatedPrice && (
                    <div className="rounded-2xl border border-gray-800 bg-gray-900/80 px-4 py-3">
                      <div className="text-xs uppercase tracking-wider text-gray-500">Hesaplanmis Pazaryeri Fiyati</div>
                      <div className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-1">
                        <span className="text-2xl font-bold text-green-400">
                          {publishCheck.calculatedPrice.finalPrice.toLocaleString('tr-TR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })} TL
                        </span>
                        <span className="text-xs text-gray-500 break-all">{publishCheck.calculatedPrice.ruleName}</span>
                      </div>
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-2">
                    {publishCheck.checks.map(check => (
                      <div key={check.key} className="min-w-0 flex items-start gap-3 rounded-xl border border-gray-800 bg-gray-900 px-3 py-3">
                        <div className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${check.ok ? 'bg-green-400' : 'bg-red-400'}`} />
                        <div className="min-w-0 text-sm leading-5 text-gray-200 break-words">{check.message}</div>
                      </div>
                    ))}
                  </div>

                  {(publishCheck.canPublish || publishCheck.existingListingStatus === 'PUBLISHED') && (
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setPublishCheck(null)}
                        className="bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm px-4 py-2 rounded-lg transition-colors"
                      >
                        Kapat
                      </button>
                      <button
                        onClick={() => submitMarketplacePublish.mutate({
                          productIds: publishCheck.publishProductIds?.length ? publishCheck.publishProductIds : [publishCheck.productId],
                          force: publishCheck.existingListingStatus === 'PUBLISHED',
                        })}
                        disabled={submitMarketplacePublish.isPending}
                        className="bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
                      >
                        {submitMarketplacePublish.isPending
                          ? publishCheck.existingListingStatus === 'PUBLISHED' ? 'Guncelleniyor...' : 'Gonderiliyor...'
                          : publishCheck.existingListingStatus === 'PUBLISHED' ? `Varyant Grubunu Duzelt (${publishCheck.publishProductIds?.length || 1})` : `Gonder (${publishCheck.publishProductIds?.length || 1})`}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {attributeProduct && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[88vh] bg-gray-950 border border-gray-800 rounded-lg overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-800 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-100 truncate">Pazaryeri Ozellikleri</h2>
                <div className="text-sm text-gray-400 truncate mt-1">{attributeProduct.title}</div>
                <div className="text-xs text-gray-500 truncate mt-1">{attributeProduct.categoryRaw ?? '-'}</div>
                {attributeTargetProductIds.length > 1 && (
                  <div className="text-xs text-blue-300 mt-1">
                    Bu duzenleme {attributeTargetProductIds.length} varyanta uygulanacak.
                  </div>
                )}
              </div>
              <button
                onClick={closeAttributeModal}
                className="bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm px-3 py-1.5 rounded"
              >
                Kapat
              </button>
            </div>

            <div className="px-5 py-3 border-b border-gray-800 flex flex-wrap items-center gap-3">
              <select
                value={attributeMarketplace}
                onChange={e => {
                  setAttributeMarketplace(e.target.value)
                  setAttributeMessage('')
                }}
                className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              >
                {MARKETPLACES.map(mp => (
                  <option key={mp} value={mp}>{mp}</option>
                ))}
              </select>
              {attributeSchema?.data.mapping.marketplaceCategoryPath && (
                <div className="text-xs text-gray-400 flex-1 min-w-[260px] truncate">
                  {attributeSchema.data.mapping.marketplaceCategoryPath}
                </div>
              )}
              {attributeSchema?.data.attributes && (
                <div className={`text-xs px-2 py-1 rounded ${mandatoryMissing.length ? 'bg-red-900/40 text-red-200' : 'bg-green-900/40 text-green-200'}`}>
                  {mandatoryMissing.length ? `${mandatoryMissing.length} zorunlu eksik` : 'Zorunlu alanlar tamam'}
                </div>
              )}
              {attributeProduct && (
                <button
                  onClick={() => autoFillMissingAttributes.mutate(isBulkAttributeEdit ? attributeTargetProductIds : [attributeProduct.id])}
                  disabled={autoFillMissingAttributes.isPending || isAttributesLoading}
                  className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
                >
                  {autoFillMissingAttributes.isPending ? 'Tamamlaniyor...' : 'Urun Adindan Tamamla'}
                </button>
              )}
            </div>

            {attributeMessage && (
              <div className="mx-5 mt-4 rounded border border-blue-800 bg-blue-950/40 px-3 py-2 text-sm text-blue-100">
                {attributeMessage}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-5">
              {isAttributesLoading ? (
                <div className="py-12 text-center text-gray-500">Ozellikler yukleniyor...</div>
              ) : attributeSchemaError ? (
                <div className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-200">
                  {(attributeSchemaError as any)?.response?.data?.error || 'Ozellik semasi alinamadi'}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-xl border border-gray-800 bg-gray-900/80 p-4">
                    <label className="block text-sm font-semibold text-gray-200 mb-2">
                      Urun Adi
                    </label>
                    <textarea
                      value={attributeProductTitle}
                      onChange={e => setAttributeProductTitle(e.target.value)}
                      disabled={isBulkAttributeEdit}
                      maxLength={500}
                      rows={3}
                      className="w-full resize-none rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                      placeholder="Pazaryerine gonderilecek urun adini duzeltin"
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                      <span>
                        {isBulkAttributeEdit
                          ? 'Toplu ozellik guncellemede urun adi degistirilmez; sadece ozellikler uygulanir.'
                          : 'Yazim hatasi ve yasak kelime duzeltmeleri icin kullanilir.'}
                      </span>
                      <span>{attributeProductTitle.trim().length}/500</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: 'Toplam', value: attributeFields.length, color: 'text-blue-300' },
                      { label: 'Zorunlu', value: attributeMandatoryCount, color: 'text-red-300' },
                      { label: 'Opsiyonel', value: attributeOptionalCount, color: 'text-gray-300' },
                    ].map(card => (
                      <div key={card.label} className="rounded-xl border border-gray-800 bg-gray-900/80 px-3 py-2">
                        <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
                        <div className="text-xs text-gray-500 mt-1">{card.label}</div>
                      </div>
                    ))}
                  </div>

                  <MarketplaceAttributeSections
                    marketplace={attributeMarketplace}
                    attributes={attributeFields}
                    values={attributeValues}
                    onChange={(attributeId, value) =>
                      setAttributeValues(values => ({ ...values, [attributeId]: value }))
                    }
                    emptyMessage="Bu kategori icin ozellik semasi bulunamadi."
                  />
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-between gap-3">
              <div className="text-xs text-gray-500">
                Kayit sonrasi urun gonderim kontrolu bu degerleri kullanir.
              </div>
              <button
                onClick={() => saveAttributes.mutate()}
                disabled={saveAttributes.isPending || isAttributesLoading || Boolean(attributeSchemaError) || attributeProductTitle.trim().length < 3}
                className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm px-5 py-2 rounded-lg transition-colors"
              >
                {saveAttributes.isPending ? 'Kaydediliyor...' : isBulkAttributeEdit ? `Toplu Kaydet (${attributeTargetProductIds.length})` : 'Kaydet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
