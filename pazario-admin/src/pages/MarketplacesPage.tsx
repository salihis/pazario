import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface MarketplaceListing {
  id: string
  marketplace: string
  status: string
  externalListingId: string | null
  stockCode: string | null
  barcode: string | null
  title: string
  brand: string | null
  categoryName: string | null
  imageUrl: string | null
  price: string | number | null
  stock: number | null
  firstSeenAt: string
  lastSeenAt: string
}

interface ListingsResponse {
  data: MarketplaceListing[]
  meta: { total: number; page: number; limit: number }
}

interface MarketplaceStats {
  pending: number
  published: number
  failed: number
  delisted: number
  total: number
}

interface MarketplaceImportResult {
  marketplace: string
  fetched: number
  matched: number
  imported: number
  delisted: number
  fullScan: boolean
  unmatched: Array<{ code: string; stockCode: string; barcode: string; name: string }>
}

interface MarketplaceSyncResult {
  marketplace: string
  mode: string
  dryRun: boolean
  scanned: number
  prepared: number
  skippedNoPrice: number
  zeroStock: number
  updated: number
}

interface UnmatchedMarketplaceProduct {
  code: string
  stockCode: string
  barcode: string
  name: string
}

interface UnmatchedMarketplaceResult {
  marketplace: string
  fetched: number
  matched: number
  unmatchedCount: number
  unmatched: UnmatchedMarketplaceProduct[]
}

interface ArchiveMarketplaceResult {
  marketplace: string
  archivedRequested: number
  batches: Array<{ count: number; batchRequestId: string | null }>
}

interface MarketplaceSyncSetting {
  marketplace: string
  enabled: boolean
  mode: 'stock' | 'price' | 'stock-price'
  scheduleTime: string
  limit: number
  lastRunAt: string | null
}

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const STATUS_TABS = [
  { value: '', label: 'Tumu' },
  { value: 'PUBLISHED', label: 'Yayinda' },
  { value: 'PENDING', label: 'Bekleyen' },
  { value: 'FAILED', label: 'Hatali' },
  { value: 'DELISTED', label: 'Pasif' },
]
const PAGE_SIZE_OPTIONS = [25, 50, 100]

const statusColor: Record<string, string> = {
  PUBLISHED: 'text-green-400 bg-green-900/30',
  PENDING: 'text-yellow-400 bg-yellow-900/30',
  FAILED: 'text-red-400 bg-red-900/30',
  DELISTED: 'text-gray-300 bg-gray-800',
}

const statusLabel: Record<string, string> = {
  PUBLISHED: 'Yayinda',
  PENDING: 'Bekleyen',
  FAILED: 'Hatali',
  DELISTED: 'Pasif',
}

export default function MarketplacesPage() {
  const queryClient = useQueryClient()
  const [marketplace, setMarketplace] = useState('TRENDYOL')
  const [status, setStatus] = useState('PUBLISHED')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [importMessage, setImportMessage] = useState('')
  const [unmatched, setUnmatched] = useState<UnmatchedMarketplaceResult | null>(null)
  const [selectedBarcodes, setSelectedBarcodes] = useState<string[]>([])
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [autoMode, setAutoMode] = useState<'stock' | 'price' | 'stock-price'>('stock-price')
  const [autoTime, setAutoTime] = useState('03:00')
  const [autoLimit, setAutoLimit] = useState(1000)
  const [pageSize, setPageSize] = useState(25)

  const resetPage = () => setPage(1)

  const { data: stats } = useQuery<{ data: MarketplaceStats }>({
    queryKey: ['marketplace-listing-stats', marketplace],
    queryFn: () =>
      api.get('/marketplace-listings/stats', {
        params: { marketplace },
      }).then(r => r.data),
  })

  const { data, isLoading } = useQuery<ListingsResponse>({
    queryKey: ['marketplace-listings', marketplace, status, search, page, pageSize],
    queryFn: () =>
      api.get('/marketplace-listings', {
        params: {
          marketplace,
          status: status || undefined,
          search: search || undefined,
          page,
          limit: pageSize,
        },
      }).then(r => r.data),
  })

  const { data: syncSettings } = useQuery<{ data: MarketplaceSyncSetting[] }>({
    queryKey: ['marketplace-sync-settings'],
    queryFn: () => api.get('/marketplace-sync-settings').then(r => r.data),
  })

  const currentSyncSetting = syncSettings?.data.find(setting => setting.marketplace === marketplace)

  useEffect(() => {
    setAutoEnabled(currentSyncSetting?.enabled ?? false)
    setAutoMode(currentSyncSetting?.mode ?? 'stock-price')
    setAutoTime(currentSyncSetting?.scheduleTime ?? '03:00')
    setAutoLimit(currentSyncSetting?.limit ?? 1000)
  }, [currentSyncSetting?.enabled, currentSyncSetting?.limit, currentSyncSetting?.mode, currentSyncSetting?.scheduleTime])

  useEffect(() => {
    setUnmatched(null)
    setSelectedBarcodes([])
  }, [marketplace])

  const importMarketplace = useMutation({
    mutationFn: (targetMarketplace: string) =>
      api.post<{ success: boolean; data: MarketplaceImportResult }>(`/marketplace-listings/import/${targetMarketplace.toLowerCase()}`, {
        size: 100,
        maxPages: 300,
      }, { timeout: 300000 }).then(r => r.data.data),
    onSuccess: result => {
      const emptyMatchNote = result.fetched > 0 && result.matched === 0
        ? ' DB urunleri bos veya barkod/SKU eslesmesi yok.'
        : ''
      const partialScanNote = !result.fullScan
        ? ' Liste sonuna kadar okunamadigi icin pasife alma yapilmadi.'
        : ''
      setImportMessage(
        `${result.marketplace} icin ${result.fetched} satistaki urun okundu, ${result.matched} urun eslesti, ${result.imported} kayit guncellendi, ${result.delisted} kayit artik satista olmadigi icin pasife alindi.${emptyMatchNote}${partialScanNote}`
      )
      setStatus('PUBLISHED')
      setPage(1)
      queryClient.invalidateQueries({ queryKey: ['marketplace-listing-stats'] })
      queryClient.invalidateQueries({ queryKey: ['marketplace-listings'] })
    },
    onError: (error: any) => {
      const detail = error?.code === 'ECONNABORTED'
        ? 'Import zaman asimina ugradi. Daha az sayfa ile tekrar deneyin veya backend loglarini kontrol edin.'
        : error?.response?.data?.detail || error?.response?.data?.error || 'Import basarisiz'
      setImportMessage(String(detail))
    },
  })

  const syncMarketplace = useMutation({
    mutationFn: (mode: 'stock' | 'price' | 'stock-price') => {
      const endpoint = mode === 'stock'
        ? '/marketplace-listings/stock-sync'
        : mode === 'price'
          ? '/marketplace-listings/price-sync'
          : '/marketplace-listings/stock-price-sync'

      return api.post<{ success: boolean; data: MarketplaceSyncResult }>(endpoint, {
        marketplace,
        dryRun: false,
        limit: autoLimit,
      }, { timeout: 120000 }).then(r => r.data.data)
    },
    onSuccess: result => {
      const labels: Record<string, string> = {
        stock: 'Stok',
        price: 'Fiyat',
        'stock-price': 'Stok ve fiyat',
      }
      setImportMessage(
        `${result.marketplace} ${labels[result.mode] ?? result.mode} guncellemesi tamamlandi. ${result.updated} kayit gonderildi, ${result.zeroStock} urun 0 stok yapildi, ${result.skippedNoPrice} urunde hesaplanmis fiyat yok.`
      )
      queryClient.invalidateQueries({ queryKey: ['marketplace-listing-stats'] })
      queryClient.invalidateQueries({ queryKey: ['marketplace-listings'] })
    },
    onError: (error: any) => {
      const detail = error?.code === 'ECONNABORTED'
        ? 'Guncelleme zaman asimina ugradi. Pazaryeri API yaniti gecikti; paket limitini dusurup tekrar deneyin.'
        : error?.response?.data?.detail || error?.response?.data?.error || error?.message || 'Guncelleme basarisiz'
      setImportMessage(String(detail))
    },
  })

  const saveSyncSetting = useMutation({
    mutationFn: () =>
      api.put<{ success: boolean; data: MarketplaceSyncSetting }>(`/marketplace-sync-settings/${marketplace}`, {
        enabled: autoEnabled,
        mode: autoMode,
        scheduleTime: autoTime,
        limit: autoLimit,
      }).then(r => r.data.data),
    onSuccess: result => {
      setImportMessage(
        `${result.marketplace} otomatik guncelleme ayari kaydedildi. ${result.enabled ? `${result.scheduleTime} saatinde ${result.mode} calisacak.` : 'Otomatik calisma kapali.'}`
      )
      queryClient.invalidateQueries({ queryKey: ['marketplace-sync-settings'] })
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.detail || error?.response?.data?.error || 'Otomatik guncelleme ayari kaydedilemedi'
      setImportMessage(String(detail))
    },
  })

  const findUnmatched = useMutation({
    mutationFn: () =>
      api.get<{ success: boolean; data: UnmatchedMarketplaceResult }>('/marketplace-listings/unmatched', {
        params: { marketplace, size: 100, maxPages: 300 },
        timeout: 300000,
      }).then(r => r.data.data),
    onSuccess: result => {
      setUnmatched(result)
      setSelectedBarcodes([])
      setImportMessage(
        `${result.marketplace} icin ${result.fetched} satistaki urun okundu, ${result.matched} urun DB ile eslesti, ${result.unmatchedCount} urun eslesmedi.`
      )
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.detail || error?.response?.data?.error || 'Eslesmeyen urunler alinamadi'
      setImportMessage(String(detail))
    },
  })

  const archiveUnmatched = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; data: ArchiveMarketplaceResult }>('/marketplace-listings/archive-unmatched', {
        marketplace,
        barcodes: selectedBarcodes,
      }).then(r => r.data.data),
    onSuccess: result => {
      setImportMessage(
        `${result.marketplace} icin ${result.archivedRequested} urun arsivleme istegi gonderildi. Batch: ${result.batches.map(batch => batch.batchRequestId || '-').join(', ')}`
      )
      setSelectedBarcodes([])
      findUnmatched.mutate()
    },
    onError: (error: any) => {
      const detail = error?.response?.data?.detail || error?.response?.data?.error || 'Arsivleme basarisiz'
      setImportMessage(String(detail))
    },
  })

  const totalPages = data ? Math.max(1, Math.ceil(data.meta.total / pageSize)) : 1

  const handleSearch = () => {
    setSearch(searchInput)
    resetPage()
  }

  const visibleUnmatched = unmatched?.unmatched ?? []
  const selectableBarcodes = visibleUnmatched.map(item => item.barcode).filter(Boolean)
  const allVisibleSelected = selectableBarcodes.length > 0 && selectableBarcodes.every(barcode => selectedBarcodes.includes(barcode))

  const toggleBarcode = (barcode: string) => {
    setSelectedBarcodes(current =>
      current.includes(barcode) ? current.filter(item => item !== barcode) : [...current, barcode]
    )
  }

  const toggleAllVisible = () => {
    setSelectedBarcodes(current => {
      if (allVisibleSelected) {
        return current.filter(barcode => !selectableBarcodes.includes(barcode))
      }
      return Array.from(new Set([...current, ...selectableBarcodes]))
    })
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Pazaryerleri</h1>
          <p className="text-gray-400 text-sm mt-1">
            Sadece pazaryeri API'lerinden okunan urunler burada gorunur
          </p>
        </div>
        <button
          onClick={() => importMarketplace.mutate(marketplace)}
          disabled={importMarketplace.isPending}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          {importMarketplace.isPending ? `${marketplace} okunuyor...` : `${marketplace} satistaki urunleri kontrol et`}
        </button>
      </div>

      {importMessage && (
        <div className="mb-5 rounded-lg border border-blue-800 bg-blue-950/40 px-4 py-3 text-sm text-blue-100">
          {importMessage}
        </div>
      )}

      <div className="mb-5 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => syncMarketplace.mutate('stock')}
            disabled={syncMarketplace.isPending}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Stok Guncelle
          </button>
          <button
            onClick={() => syncMarketplace.mutate('price')}
            disabled={syncMarketplace.isPending}
            className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Fiyat Guncelle
          </button>
          <button
            onClick={() => syncMarketplace.mutate('stock-price')}
            disabled={syncMarketplace.isPending}
            className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Stok ve Fiyat Guncelle
          </button>
          <span className="text-xs text-gray-500">
            {syncMarketplace.isPending
              ? 'Guncelleme gonderiliyor...'
              : 'Yayindaki urunler icin calisir.'}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-[auto_180px_160px_120px_auto_1fr] gap-3 items-end border-t border-gray-800 pt-4">
          <label className="flex items-center gap-2 text-sm text-gray-200">
            <input
              type="checkbox"
              checked={autoEnabled}
              onChange={e => setAutoEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            Otomatik guncelle
          </label>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Islem</label>
            <select
              value={autoMode}
              onChange={e => setAutoMode(e.target.value as 'stock' | 'price' | 'stock-price')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
            >
              <option value="stock">Stok</option>
              <option value="price">Fiyat</option>
              <option value="stock-price">Stok ve Fiyat</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Saat</label>
            <input
              type="time"
              value={autoTime}
              onChange={e => setAutoTime(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Paket limiti</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={autoLimit}
              onChange={e => setAutoLimit(Math.min(Math.max(parseInt(e.target.value) || 1, 1), 1000))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
            />
          </div>
          <button
            onClick={() => saveSyncSetting.mutate()}
            disabled={saveSyncSetting.isPending}
            className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {saveSyncSetting.isPending ? 'Kaydediliyor...' : 'Ayar Kaydet'}
          </button>
          <div className="text-xs text-gray-500">
            {currentSyncSetting?.lastRunAt
              ? `Son otomatik calisma: ${new Date(currentSyncSetting.lastRunAt).toLocaleString('tr-TR')}. Paket dolarsa 5 dakika sonra devam eder.`
              : 'Belirtilen saatte baslar; paket dolarsa 5 dakika arayla tum uygun urunler bitene kadar devam eder.'}
          </div>
        </div>
      </div>

      <div className="mb-5 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <div className="text-sm font-semibold text-gray-100">DB ile eslesmeyen {marketplace} urunleri</div>
              <div className="text-xs text-gray-500 mt-1">
                Yalnizca pazaryerinde satis durumunda olan urunler kontrol edilir.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => findUnmatched.mutate()}
                disabled={findUnmatched.isPending}
                className="bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
              >
                {findUnmatched.isPending ? 'Kontrol ediliyor...' : 'Eslesmeyenleri Bul'}
              </button>
              {marketplace === 'TRENDYOL' && (
                <button
                  onClick={() => archiveUnmatched.mutate()}
                  disabled={archiveUnmatched.isPending || selectedBarcodes.length === 0}
                  className="bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
                >
                  {archiveUnmatched.isPending ? 'Arsivleniyor...' : `Secilenleri Arsive Al (${selectedBarcodes.length})`}
                </button>
              )}
            </div>
          </div>

          {unmatched && (
            <div className="border border-gray-800 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-gray-800 bg-gray-950/40">
                <span className="text-xs text-gray-400">
                  {unmatched.fetched} satistaki urun okundu, {unmatched.matched} eslesti, {unmatched.unmatchedCount} eslesmedi
                </span>
                {marketplace === 'TRENDYOL' && (
                  <button
                    onClick={toggleAllVisible}
                    disabled={selectableBarcodes.length === 0}
                    className="text-xs text-blue-300 disabled:text-gray-600"
                  >
                    {allVisibleSelected ? 'Tum secimi kaldir' : 'Gorunen barkodlari sec'}
                  </button>
                )}
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900">
                    <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
                      {marketplace === 'TRENDYOL' && <th className="text-left px-3 py-2 w-10">Sec</th>}
                      <th className="text-left px-3 py-2">Urun</th>
                      <th className="text-left px-3 py-2">Barkod</th>
                      <th className="text-left px-3 py-2">Stok Kodu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUnmatched.length === 0 ? (
                      <tr>
                        <td colSpan={marketplace === 'TRENDYOL' ? 4 : 3} className="text-center py-8 text-gray-500">
                          Eslesmeyen urun bulunmadi
                        </td>
                      </tr>
                    ) : (
                      visibleUnmatched.map((item, index) => (
                        <tr key={`${item.barcode}-${item.stockCode}-${index}`} className="border-b border-gray-800/50">
                          {marketplace === 'TRENDYOL' && (
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={Boolean(item.barcode && selectedBarcodes.includes(item.barcode))}
                                disabled={!item.barcode}
                                onChange={() => item.barcode && toggleBarcode(item.barcode)}
                                className="h-4 w-4"
                              />
                            </td>
                          )}
                          <td className="px-3 py-2 text-gray-200">
                            <div className="line-clamp-1 max-w-xl">{item.name || '-'}</div>
                            {item.code && <div className="text-xs text-gray-500 mt-0.5">{item.code}</div>}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-400 font-mono">{item.barcode || '-'}</td>
                          <td className="px-3 py-2 text-xs text-gray-400 font-mono">{item.stockCode || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
      </div>

      <div className="grid grid-cols-4 gap-3 mb-5">
        {MARKETPLACES.map(mp => (
          <button
            key={mp}
            onClick={() => {
              setMarketplace(mp)
              setUnmatched(null)
              setSelectedBarcodes([])
              resetPage()
            }}
            className={`text-left rounded-lg px-4 py-3 border transition-colors ${
              marketplace === mp
                ? 'bg-blue-900/40 border-blue-500 text-blue-100'
                : 'bg-gray-900 border-gray-800 text-gray-400 hover:bg-gray-800'
            }`}
          >
            <div className="text-sm font-semibold">{mp}</div>
            <div className="text-xs text-gray-500 mt-1">Yuklu urunler ve durumlari</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-4 mb-6">
        {[
          { label: 'Yayinda', value: stats?.data.published ?? 0, color: 'text-green-400', bg: 'bg-green-900/30' },
          { label: 'Bekleyen', value: stats?.data.pending ?? 0, color: 'text-yellow-400', bg: 'bg-yellow-900/30' },
          { label: 'Hatali', value: stats?.data.failed ?? 0, color: 'text-red-400', bg: 'bg-red-900/30' },
          { label: 'Pasif', value: stats?.data.delisted ?? 0, color: 'text-gray-300', bg: 'bg-gray-800/60' },
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
                resetPage()
              }}
              className={`px-4 py-2 text-sm border-r border-gray-800 last:border-r-0 ${
                status === tab.value ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="SKU, barkod veya urun adi ara"
          className="flex-1 min-w-[240px] bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleSearch}
          className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          Ara
        </button>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
                <th className="text-left px-4 py-3">Gorsel</th>
                <th className="text-left px-4 py-3">Urun</th>
                <th className="text-left px-4 py-3">SKU</th>
                <th className="text-left px-4 py-3">Pazaryeri</th>
                <th className="text-right px-4 py-3">Fiyat</th>
                <th className="text-right px-4 py-3">Stok</th>
                <th className="text-left px-4 py-3">Durum</th>
                <th className="text-left px-4 py-3">Pazaryeri ID</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-gray-500">Yukleniyor...</td>
                </tr>
              ) : data?.data.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-gray-500">
                    Bu pazaryeri icin kayitli/gonderilmis urun yok
                  </td>
                </tr>
              ) : (
                data?.data.map(listing => (
                  <tr key={listing.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3">
                      {listing.imageUrl ? (
                        <img
                          src={listing.imageUrl}
                          alt={listing.title}
                          className="w-10 h-10 object-cover rounded-lg bg-gray-800"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center text-gray-600 text-xs">YOK</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-100 line-clamp-1 max-w-md">{listing.title}</div>
                      <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                        {listing.categoryName ?? '-'}
                        {listing.barcode ? ` | Barkod: ${listing.barcode}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded">
                        {listing.stockCode ?? '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{listing.marketplace}</td>
                    <td className="px-4 py-3 text-right text-green-400 font-medium">
                      {listing.price === null || listing.price === undefined
                        ? '-'
                        : `${Number(listing.price).toLocaleString('tr-TR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })} TL`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={(listing.stock ?? 0) <= 6 ? 'text-red-400 font-medium' : 'text-gray-300'}>
                        {listing.stock ?? '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor[listing.status] ?? 'bg-gray-800 text-gray-400'}`}>
                        {statusLabel[listing.status] ?? listing.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                      {listing.externalListingId ?? '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data && data.meta.total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
              <span>
                {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, data.meta.total)} / {data.meta.total}
              </span>
              <label className="flex items-center gap-2">
                <span>Sayfada</span>
                <select
                  value={pageSize}
                  onChange={e => {
                    setPageSize(Number(e.target.value))
                    setPage(1)
                  }}
                  className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
                <span>kayit</span>
              </label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700 transition-colors"
              >
                Onceki
              </button>
              <span className="px-3 py-1 text-xs text-gray-400">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700 transition-colors"
              >
                Sonraki
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
