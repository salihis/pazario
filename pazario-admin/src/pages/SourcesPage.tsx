import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface XmlSource {
  id: string
  name: string
  url: string
  fallbackUrl: string | null
  fetchTimeoutSec: number
  categoryIncludeKeywords: string | null
  autoSyncEnabled: boolean
  autoSyncTime: string
  lastAutoSyncAt: string | null
  active: boolean
  createdAt: string
  _count: { products: number }
}

interface SyncJob {
  id: string
  status: string
  totalProducts: number | null
  changedProducts: number | null
  publishedCount: number | null
  failedCount: number | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

interface TestResult {
  feedType: string
  totalProducts: number
  filteredProducts?: number
  categoryFilter?: string | null
  parsed: number
  failed: number
  durationMs: number
  stockOk: number
  stockBlocked: number
  minStock: number
  categoryCount: number
  missingBarcode: number
  missingImages: number
  variantProducts: number
  variantGroups: number
  turkishBroken: number
  turkishStatus: 'OK' | 'BROKEN'
  detectedFields: Record<string, boolean>
  sample: {
    id: string
    sku: string
    barcode: string | null
    title: string
    brand: string | null
    category: string | null
    price: number
    listPrice: number | null
    stock: number
    images: number
  }[]
  errors: { type: string; code: string; message: string }[]
}

const statusColor: Record<string, string> = {
  PENDING: 'text-gray-400 bg-gray-800',
  RUNNING: 'text-yellow-400 bg-yellow-900/30',
  DONE: 'text-green-400 bg-green-900/30',
  FAILED: 'text-red-400 bg-red-900/30',
}

const fieldLabels: Record<string, string> = {
  id: 'ID',
  title: 'Urun adi',
  sku: 'SKU',
  barcode: 'Barkod',
  brand: 'Marka',
  category: 'Kategori',
  price: 'Fiyat',
  listPrice: 'ListPrice',
  stock: 'Stok',
  images: 'Gorsel',
  color: 'Renk',
  size: 'Beden',
  variants: 'Varyant',
}

const steps = ['XML linki', 'Test ve onizleme', 'Kurallar', 'Kaydet']

function resetWizardState() {
  return {
    name: '',
    url: '',
    fallbackUrl: '',
    fetchTimeoutSec: 60,
    categoryIncludeKeywords: '',
    minStock: 6,
    priceField: 'Otomatik',
    vatIncluded: true,
    hideLowStock: true,
    syncAfterCreate: true,
    autoSyncEnabled: true,
    autoSyncTime: '03:00',
  }
}

export default function SourcesPage() {
  const queryClient = useQueryClient()
  const [showWizard, setShowWizard] = useState(false)
  const [wizardStep, setWizardStep] = useState(0)
  const [wizard, setWizard] = useState(resetWizardState)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState('')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [selectedSyncIds, setSelectedSyncIds] = useState<string[]>([])
  const [bulkSyncMessage, setBulkSyncMessage] = useState('')

  const { data: sources, isLoading } = useQuery<{ data: XmlSource[] }>({
    queryKey: ['sources'],
    queryFn: () => api.get('/sources').then(r => r.data),
  })

  const { data: syncJobs } = useQuery<{ data: SyncJob[] }>({
    queryKey: ['sync-jobs', selectedSourceId],
    queryFn: () => api.get('/sync-jobs', { params: { sourceId: selectedSourceId } }).then(r => r.data),
    enabled: !!selectedSourceId,
    refetchInterval: 5000,
  })

  const closeWizard = () => {
    setShowWizard(false)
    setWizardStep(0)
    setWizard(resetWizardState())
    setTestResult(null)
    setTestError('')
  }

  const testMutation = useMutation({
    mutationFn: () => api.post('/sources/test', {
      url: wizard.url,
      fetchTimeoutSec: wizard.fetchTimeoutSec,
      categoryIncludeKeywords: wizard.categoryIncludeKeywords,
    }, {
      timeout: Math.min(Math.max(wizard.fetchTimeoutSec, 10), 600) * 1000 + 15000,
    }).then(r => r.data),
    onSuccess: data => {
      setTestResult(data.data)
      setTestError('')
      setWizardStep(1)
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string } | string }; message?: string }
      const responseData = err.response?.data
      const message = typeof responseData === 'string' ? responseData : responseData?.error
      const fallbackMessage = err.message?.includes('timeout')
        ? 'XML testi belirtilen surede tamamlanamadi. Timeout suresini artirin veya kaynagi kaydedip senkronizasyonu arka planda calistirin.'
        : 'Test basarisiz'
      setTestError(message ?? fallbackMessage)
      setTestResult(null)
    },
  })

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.post(`/sources/${id}/sync`),
    onSuccess: (_, id) => {
      setSelectedSourceId(id)
      queryClient.invalidateQueries({ queryKey: ['sync-jobs', id] })
    },
  })

  const bulkSyncMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results: { id: string; ok: boolean; error?: string }[] = []
      for (const id of ids) {
        try {
          await api.post(`/sources/${id}/sync`)
          results.push({ id, ok: true })
        } catch (error: any) {
          results.push({
            id,
            ok: false,
            error: error?.response?.data?.error || error?.message || 'Senkronizasyon baslatilamadi',
          })
        }
      }
      return results
    },
    onSuccess: results => {
      const okCount = results.filter(result => result.ok).length
      const failCount = results.length - okCount
      setBulkSyncMessage(`${okCount} kaynak icin senkronizasyon baslatildi${failCount ? `, ${failCount} kaynak baslatilamadi` : ''}.`)
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      queryClient.invalidateQueries({ queryKey: ['sync-jobs'] })
      if (selectedSyncIds.length > 0) setSelectedSourceId(selectedSyncIds[0])
    },
  })

  const createWizardMutation = useMutation({
    mutationFn: async () => {
      const created = await api.post('/sources', {
        name: wizard.name,
        url: wizard.url,
        fallbackUrl: wizard.fallbackUrl,
        fetchTimeoutSec: wizard.fetchTimeoutSec,
        categoryIncludeKeywords: wizard.categoryIncludeKeywords,
        autoSyncEnabled: wizard.autoSyncEnabled,
        autoSyncTime: wizard.autoSyncTime,
      })
      const sourceId = created.data.data.id as string
      if (wizard.syncAfterCreate) {
        await api.post(`/sources/${sourceId}/sync`)
      }
      return sourceId
    },
    onSuccess: sourceId => {
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      setSelectedSourceId(sourceId)
      closeWizard()
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.put(`/sources/${id}`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sources'] }),
  })

  const updateSourceMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Pick<XmlSource, 'autoSyncEnabled' | 'autoSyncTime' | 'fetchTimeoutSec' | 'categoryIncludeKeywords' | 'fallbackUrl'>> }) =>
      api.put(`/sources/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sources'] }),
  })

  const readyForSave = Boolean(wizard.name && wizard.url && (!testResult || testResult.turkishStatus === 'OK'))
  const detectedEntries = Object.entries(testResult?.detectedFields ?? {})
  const activeSourceIds = sources?.data.filter(source => source.active).map(source => source.id) ?? []
  const autoSyncSourceCount = sources?.data.filter(source => source.active && source.autoSyncEnabled).length ?? 0
  const allVisibleSourceIds = sources?.data.map(source => source.id) ?? []
  const selectedActiveCount = selectedSyncIds.filter(id => activeSourceIds.includes(id)).length
  const allActiveSelected = activeSourceIds.length > 0 && activeSourceIds.every(id => selectedSyncIds.includes(id))
  const toggleSyncSelection = (id: string) => {
    setSelectedSyncIds(current =>
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    )
  }
  const toggleAllActiveSelection = () => {
    setSelectedSyncIds(allActiveSelected ? [] : activeSourceIds)
  }
  const clearSelection = () => setSelectedSyncIds([])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">XML Kaynaklar</h1>
          <p className="text-gray-400 text-sm mt-1">Tedarikci XML feed yonetimi</p>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + XML Kurulum Sihirbazi
        </button>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500">Aktif kaynak</div>
            <div className="text-xl font-bold text-gray-100 mt-1">{sources?.data.filter(s => s.active).length ?? 0}</div>
          </div>
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500">Toplam kaynak</div>
            <div className="text-xl font-bold text-gray-100 mt-1">{sources?.data.length ?? 0}</div>
          </div>
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500">Toplam urun</div>
            <div className="text-xl font-bold text-green-300 mt-1">
              {(sources?.data.reduce((sum, source) => sum + source._count.products, 0) ?? 0).toLocaleString('tr-TR')}
            </div>
          </div>
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500">Otomatik guncelleme</div>
            <div className="text-xl font-bold text-blue-300 mt-1">{autoSyncSourceCount}</div>
          </div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-gray-100">Toplu XML Senkronizasyonu</div>
            <div className="text-xs text-gray-500 mt-1">
              {selectedSyncIds.length} kaynak secildi. Aktif kaynaklardan {selectedActiveCount} tanesi guncellenecek.
            </div>
            <div className="text-xs text-gray-600 mt-1">
              Otomatik guncelleme acik kaynaklar belirlenen saatte gunde bir kez kuyruga alinir.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={toggleAllActiveSelection}
              disabled={activeSourceIds.length === 0 || bulkSyncMutation.isPending}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              {allActiveSelected ? 'Secimi Kaldir' : 'Aktifleri Sec'}
            </button>
            <button
              onClick={clearSelection}
              disabled={selectedSyncIds.length === 0 || bulkSyncMutation.isPending}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              Temizle
            </button>
            <button
              onClick={() => bulkSyncMutation.mutate(selectedSyncIds.filter(id => activeSourceIds.includes(id)))}
              disabled={bulkSyncMutation.isPending || selectedActiveCount === 0}
              className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              {bulkSyncMutation.isPending ? 'Guncelleniyor...' : `Secilenleri Guncelle (${selectedActiveCount})`}
            </button>
          </div>
        </div>
        {bulkSyncMessage && (
          <div className="mt-3 rounded-lg border border-blue-800 bg-blue-950/40 px-3 py-2 text-sm text-blue-100">
            {bulkSyncMessage}
          </div>
        )}
      </div>

      <div className="flex gap-4">
        <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 text-xs text-gray-400 uppercase tracking-wider">
            XML Kaynaklar
          </div>
          {isLoading ? (
            <div className="p-8 text-center text-gray-500">Yukleniyor...</div>
          ) : sources?.data.length === 0 ? (
            <div className="p-8 text-center text-gray-500">Henuz kaynak yok</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {sources?.data.map(source => (
                <div
                  key={source.id}
                  className={`px-4 py-4 hover:bg-gray-800/30 transition-colors cursor-pointer ${
                    selectedSourceId === source.id ? 'bg-gray-800/50 border-l-2 border-blue-500' : ''
                  }`}
                  onClick={() => setSelectedSourceId(source.id === selectedSourceId ? null : source.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedSyncIds.includes(source.id)}
                        onChange={e => {
                          e.stopPropagation()
                          toggleSyncSelection(source.id)
                        }}
                        onClick={e => e.stopPropagation()}
                        disabled={!source.active || bulkSyncMutation.isPending}
                        className="mt-1 h-4 w-4 accent-blue-600 disabled:opacity-40"
                        title={source.active ? 'Toplu guncelleme icin sec' : 'Pasif kaynak secilemez'}
                      />
                      <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium text-gray-200">{source.name}</div>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${source.active ? 'text-green-400 bg-green-900/30' : 'text-gray-500 bg-gray-800'}`}>
                          {source.active ? 'Aktif' : 'Pasif'}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1 truncate">{source.url}</div>
                      {source.fallbackUrl && (
                        <div className="text-xs text-amber-300 mt-1 truncate">
                          Yedek XML: {source.fallbackUrl}
                        </div>
                      )}
                      {source.categoryIncludeKeywords && (
                        <div className="text-xs text-blue-300 mt-1">
                          Kategori filtresi: {source.categoryIncludeKeywords}
                        </div>
                      )}
                      <div className="text-xs text-gray-600 mt-1">{source._count.products.toLocaleString('tr-TR')} urun</div>
                      <div className="mt-3 flex flex-wrap items-center gap-2" onClick={e => e.stopPropagation()}>
                        <label className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-950 px-2 py-1 text-xs text-gray-300">
                          <input
                            type="checkbox"
                            checked={source.autoSyncEnabled}
                            disabled={!source.active || updateSourceMutation.isPending}
                            onChange={e => updateSourceMutation.mutate({
                              id: source.id,
                              data: { autoSyncEnabled: e.target.checked },
                            })}
                            className="h-3.5 w-3.5 accent-blue-600"
                          />
                          Otomatik
                        </label>
                        <input
                          type="time"
                          value={source.autoSyncTime || '03:00'}
                          disabled={!source.active || !source.autoSyncEnabled || updateSourceMutation.isPending}
                          onChange={e => updateSourceMutation.mutate({
                            id: source.id,
                            data: { autoSyncTime: e.target.value },
                          })}
                          className="h-7 rounded-lg border border-gray-800 bg-gray-950 px-2 text-xs text-gray-200 disabled:opacity-50"
                        />
                        <input
                          key={`${source.id}-${source.categoryIncludeKeywords ?? ''}`}
                          type="text"
                          defaultValue={source.categoryIncludeKeywords ?? ''}
                          placeholder="Kategori filtresi"
                          disabled={!source.active || updateSourceMutation.isPending}
                          onBlur={e => {
                            const next = e.target.value.trim()
                            const current = source.categoryIncludeKeywords ?? ''
                            if (next !== current) {
                              updateSourceMutation.mutate({
                                id: source.id,
                                data: { categoryIncludeKeywords: next },
                              })
                            }
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                          }}
                          className="h-7 w-40 rounded-lg border border-gray-800 bg-gray-950 px-2 text-xs text-gray-200 placeholder-gray-600 disabled:opacity-50"
                        />
                        <input
                          key={`${source.id}-${source.fallbackUrl ?? ''}`}
                          type="text"
                          defaultValue={source.fallbackUrl ?? ''}
                          placeholder="Yedek XML"
                          disabled={!source.active || updateSourceMutation.isPending}
                          onBlur={e => {
                            const next = e.target.value.trim()
                            const current = source.fallbackUrl ?? ''
                            if (next !== current) {
                              updateSourceMutation.mutate({
                                id: source.id,
                                data: { fallbackUrl: next },
                              })
                            }
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                          }}
                          className="h-7 w-64 rounded-lg border border-gray-800 bg-gray-950 px-2 text-xs text-gray-200 placeholder-gray-600 disabled:opacity-50"
                        />
                        {source.lastAutoSyncAt && (
                          <span className="text-xs text-gray-600">
                            Son: {new Date(source.lastAutoSyncAt).toLocaleString('tr-TR')}
                          </span>
                        )}
                      </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={e => { e.stopPropagation(); toggleMutation.mutate({ id: source.id, active: !source.active }) }}
                        className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 px-2 py-1 rounded transition-colors"
                      >
                        {source.active ? 'Durdur' : 'Aktifles'}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); syncMutation.mutate(source.id) }}
                        disabled={syncMutation.isPending}
                        className="text-xs bg-blue-700 hover:bg-blue-600 text-white px-3 py-1 rounded transition-colors disabled:opacity-50"
                      >
                        Sync
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {selectedSourceId && (
          <div className="w-80 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 text-xs text-gray-400 uppercase tracking-wider">
              Sync Gecmisi
            </div>
            <div className="divide-y divide-gray-800">
              {syncJobs?.data.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">Sync gecmisi yok</div>
              ) : (
                syncJobs?.data.map(job => (
                  <div key={job.id} className="px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor[job.status]}`}>
                        {job.status}
                      </span>
                      <span className="text-xs text-gray-600">
                        {new Date(job.createdAt).toLocaleString('tr-TR')}
                      </span>
                    </div>
                    {job.status === 'DONE' && (
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        {[
                          { label: 'Toplam', value: job.totalProducts },
                          { label: 'Degisen', value: job.changedProducts },
                          { label: 'Hata', value: job.failedCount },
                        ].map(item => (
                          <div key={item.label} className="bg-gray-800 rounded p-1.5 text-center">
                            <div className="text-xs text-gray-500">{item.label}</div>
                            <div className="text-xs font-bold text-gray-300">{item.value ?? 0}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {job.status === 'RUNNING' && (
                      <div className="mt-2">
                        <div className="h-1 bg-gray-800 rounded overflow-hidden">
                          <div className="h-full bg-yellow-500 rounded animate-pulse" style={{ width: '60%' }} />
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {showWizard && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-xl border border-gray-700 w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-100">XML Kurulum Sihirbazi</h2>
                <div className="text-xs text-gray-500 mt-1">Linki test et, alanlari kontrol et, kurallari onayla ve senkronize et.</div>
              </div>
              <button onClick={closeWizard} className="text-gray-500 hover:text-gray-300">X</button>
            </div>

            <div className="px-6 pt-4">
              <div className="grid grid-cols-4 gap-2">
                {steps.map((step, index) => (
                  <div
                    key={step}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      wizardStep === index
                        ? 'border-blue-500 bg-blue-950/40 text-blue-100'
                        : wizardStep > index
                          ? 'border-green-800 bg-green-950/30 text-green-200'
                          : 'border-gray-800 bg-gray-950 text-gray-500'
                    }`}
                  >
                    <div className="font-bold">{index + 1}. {step}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {wizardStep === 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Kaynak adi</label>
                      <input
                        type="text"
                        placeholder="Tedarikci A"
                        value={wizard.name}
                        onChange={e => setWizard(p => ({ ...p, name: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">XML linki</label>
                      <input
                        type="text"
                        placeholder="https://tedarikci.com/feed.xml"
                        value={wizard.url}
                        onChange={e => setWizard(p => ({ ...p, url: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Yedek XML dosyasi / URL</label>
                      <input
                        type="text"
                        placeholder="Orn: file:///app/imports/toptanbudur.xml"
                        value={wizard.fallbackUrl}
                        onChange={e => setWizard(p => ({ ...p, fallbackUrl: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                      />
                      <div className="text-xs text-gray-600 mt-1">
                        Ana XML linki hata verirse veya zaman asimina duserse bu kaynak kullanilir.
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Timeout (saniye)</label>
                      <input
                        type="number"
                        min={10}
                        max={600}
                        value={wizard.fetchTimeoutSec}
                        onChange={e => setWizard(p => ({ ...p, fetchTimeoutSec: parseInt(e.target.value || '60') }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                      />
                      <div className="text-xs text-gray-600 mt-1">
                        Buyuk XML kaynaklari icin 180-600 saniye arasi kullanin. Kaynak cok yavassa kaydedip arka planda senkronize etmek daha sagliklidir.
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Kategori filtresi</label>
                      <input
                        type="text"
                        placeholder="Orn: Giyim"
                        value={wizard.categoryIncludeKeywords}
                        onChange={e => setWizard(p => ({ ...p, categoryIncludeKeywords: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                      />
                      <div className="text-xs text-gray-600 mt-1">
                        Virgulle birden fazla kategori yazabilirsiniz. Orn: Giyim, Plaj Giyim. Bos birakilirsa tum XML alinir.
                      </div>
                    </div>
                    {testError && (
                      <div className="rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                        <div>{testError}</div>
                        <button
                          type="button"
                          onClick={() => setWizardStep(2)}
                          disabled={!wizard.name || !wizard.url}
                          className="mt-3 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                        >
                          Testi Atla ve Devam Et
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                    <div className="text-sm font-bold text-gray-200 mb-3">Test sonucu bekleniyor</div>
                    <div className="text-sm text-gray-500">
                      XML testinde urun sayisi, stok uygunlugu, kategori sayisi, eksik barkod/gorsel, varyant ve Turkce karakter kontrolu yapilir.
                    </div>
                  </div>
                </div>
              )}

              {wizardStep === 1 && testResult && (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Toplam urun', value: testResult.totalProducts.toLocaleString('tr-TR') },
                      ...(testResult.categoryFilter ? [{ label: 'Filtre sonrasi', value: (testResult.filteredProducts ?? 0).toLocaleString('tr-TR') }] : []),
                      { label: `Stok > ${testResult.minStock}`, value: testResult.stockOk.toLocaleString('tr-TR') },
                      { label: 'Kategori', value: testResult.categoryCount.toLocaleString('tr-TR') },
                      { label: 'Turkce karakter', value: testResult.turkishStatus === 'OK' ? 'Sorun yok' : `${testResult.turkishBroken} sorun`, bad: testResult.turkishStatus !== 'OK' },
                      { label: 'Eksik barkod', value: testResult.missingBarcode.toLocaleString('tr-TR'), bad: testResult.missingBarcode > 0 },
                      { label: 'Eksik gorsel', value: testResult.missingImages.toLocaleString('tr-TR'), bad: testResult.missingImages > 0 },
                      { label: 'Varyant urun', value: testResult.variantProducts.toLocaleString('tr-TR') },
                      { label: 'Sure', value: `${testResult.durationMs}ms` },
                    ].map(item => (
                      <div key={item.label} className={`rounded-lg border p-3 ${item.bad ? 'border-red-900 bg-red-950/20' : 'border-gray-800 bg-gray-950'}`}>
                        <div className="text-xs text-gray-500">{item.label}</div>
                        <div className={`text-lg font-bold mt-1 ${item.bad ? 'text-red-200' : 'text-gray-100'}`}>{item.value}</div>
                      </div>
                    ))}
                  </div>

                  <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                    <div className="text-sm font-bold text-gray-200 mb-3">Algilanan alanlar</div>
                    <div className="flex flex-wrap gap-2">
                      {detectedEntries.map(([key, ok]) => (
                        <span
                          key={key}
                          className={`text-xs px-2 py-1 rounded border ${ok ? 'bg-green-950/30 text-green-200 border-green-800' : 'bg-gray-900 text-gray-500 border-gray-800'}`}
                        >
                          {fieldLabels[key] ?? key}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-gray-800 text-sm font-bold text-gray-200">Ornek urunler</div>
                    <div className="divide-y divide-gray-800">
                      {testResult.sample.slice(0, 8).map(product => (
                        <div key={product.id} className="px-4 py-3 grid grid-cols-[1fr_110px_90px] gap-3 items-center">
                          <div className="min-w-0">
                            <div className="text-sm text-gray-100 truncate">{product.title}</div>
                            <div className="text-xs text-gray-500 truncate mt-1">
                              {product.category ?? '-'} | SKU: {product.sku} | Barkod: {product.barcode ?? '-'}
                            </div>
                          </div>
                          <div className="text-sm text-green-300 text-right">{product.listPrice ?? product.price} TL</div>
                          <div className={`text-sm text-right ${product.stock > testResult.minStock ? 'text-gray-100' : 'text-red-300'}`}>Stok {product.stock}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {wizardStep === 2 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Fiyat alani</label>
                      <select
                        value={wizard.priceField}
                        onChange={e => setWizard(p => ({ ...p, priceField: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                      >
                        <option>Otomatik</option>
                        <option>ListPrice</option>
                        <option>price</option>
                        <option>salePrice</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Minimum stok</label>
                      <input
                        type="number"
                        value={wizard.minStock}
                        onChange={e => setWizard(p => ({ ...p, minStock: parseInt(e.target.value || '6') }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <label className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 p-3">
                      <input type="checkbox" checked={wizard.vatIncluded} onChange={e => setWizard(p => ({ ...p, vatIncluded: e.target.checked }))} />
                      <span className="text-sm text-gray-200">XML fiyatlarina KDV dahil</span>
                    </label>
                    <label className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 p-3">
                      <input type="checkbox" checked={wizard.hideLowStock} onChange={e => setWizard(p => ({ ...p, hideLowStock: e.target.checked }))} />
                      <span className="text-sm text-gray-200">Stok kosulunu saglamayanlari pazaryerine gonderme</span>
                    </label>
                    <label className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 p-3">
                      <input type="checkbox" checked={wizard.syncAfterCreate} onChange={e => setWizard(p => ({ ...p, syncAfterCreate: e.target.checked }))} />
                      <span className="text-sm text-gray-200">Kaydettikten sonra ilk senkronu baslat</span>
                    </label>
                    <label className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 p-3">
                      <input type="checkbox" checked={wizard.autoSyncEnabled} onChange={e => setWizard(p => ({ ...p, autoSyncEnabled: e.target.checked }))} />
                      <span className="text-sm text-gray-200">Bu kaynagi otomatik guncelle</span>
                    </label>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Otomatik guncelleme saati</label>
                      <input
                        type="time"
                        value={wizard.autoSyncTime}
                        onChange={e => setWizard(p => ({ ...p, autoSyncTime: e.target.value }))}
                        disabled={!wizard.autoSyncEnabled}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 disabled:opacity-50"
                      />
                    </div>
                  </div>
                  <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                    <div className="text-sm font-bold text-gray-200 mb-3">Uygulanacak sistem kurallari</div>
                    <div className="space-y-2 text-sm text-gray-400">
                      <div>Fiyat gonderiminde urun fiyati degil hesaplanmis pazaryeri fiyati kullanilir.</div>
                      <div>Renk ve beden XML'den geliyorsa gonderimde XML degeri onceliklidir.</div>
                      <div>Marka ve barkod donusumleri pazaryeri payload asamasinda uygulanir, kaynak urun bozulmaz.</div>
                      <div>Kategori eslestirmeleri stok &gt; {wizard.minStock} urunlerden uretilir.</div>
                      <div>Otomatik XML guncelleme aciksa kaynak belirlenen saatte gunde bir kez kuyruga alinir.</div>
                    </div>
                  </div>
                </div>
              )}

              {wizardStep === 3 && (
                <div className="space-y-4">
                  <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                    <div className="text-sm font-bold text-gray-200 mb-3">Kurulum ozeti</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                      <div className="text-gray-500">Kaynak</div><div className="text-gray-100">{wizard.name}</div>
                      <div className="text-gray-500">URL</div><div className="text-gray-100 truncate">{wizard.url}</div>
                      <div className="text-gray-500">Yedek URL</div><div className="text-gray-100 truncate">{wizard.fallbackUrl || 'Yok'}</div>
                      <div className="text-gray-500">Kategori filtresi</div><div className="text-gray-100">{wizard.categoryIncludeKeywords || 'Tum XML'}</div>
                      <div className="text-gray-500">Toplam urun</div><div className="text-gray-100">{testResult ? testResult.totalProducts.toLocaleString('tr-TR') : 'Test atlandi'}</div>
                      <div className="text-gray-500">Filtre sonrasi</div><div className="text-gray-100">{testResult?.filteredProducts !== undefined ? testResult.filteredProducts.toLocaleString('tr-TR') : 'Senkron sirasinda hesaplanacak'}</div>
                      <div className="text-gray-500">Stok uygun</div><div className="text-green-300">{testResult ? testResult.stockOk.toLocaleString('tr-TR') : 'Senkron sirasinda hesaplanacak'}</div>
                      <div className="text-gray-500">Fiyat alani</div><div className="text-gray-100">{wizard.priceField}</div>
                      <div className="text-gray-500">Otomatik guncelleme</div><div className="text-gray-100">{wizard.autoSyncEnabled ? wizard.autoSyncTime : 'Kapali'}</div>
                      <div className="text-gray-500">Turkce karakter</div><div className={testResult?.turkishStatus === 'OK' || !testResult ? 'text-green-300' : 'text-red-300'}>{testResult ? (testResult.turkishStatus === 'OK' ? 'Sorun yok' : 'Sorun var') : 'Test atlandi'}</div>
                    </div>
                  </div>
                  {createWizardMutation.isError && (
                    <div className="rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                      Kaynak kaydedilemedi.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between">
              <button
                onClick={() => setWizardStep(step => Math.max(step - 1, 0))}
                disabled={wizardStep === 0 || createWizardMutation.isPending}
                className="bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 px-4 py-2 rounded-lg text-sm"
              >
                Geri
              </button>
              <div className="flex items-center gap-3">
                {wizardStep === 0 && (
                  <>
                    <button
                      onClick={() => setWizardStep(2)}
                      disabled={!wizard.name || !wizard.url || testMutation.isPending}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
                    >
                      Testi Atla
                    </button>
                    <button
                      onClick={() => testMutation.mutate()}
                      disabled={!wizard.name || !wizard.url || testMutation.isPending}
                      className="bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
                    >
                      {testMutation.isPending ? 'Test ediliyor...' : 'XML Test Et'}
                    </button>
                  </>
                )}
                {wizardStep > 0 && wizardStep < 3 && (
                  <button
                    onClick={() => setWizardStep(step => step + 1)}
                    disabled={wizardStep === 1 && testResult?.turkishStatus !== 'OK'}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
                  >
                    Devam Et
                  </button>
                )}
                {wizardStep === 3 && (
                  <button
                    onClick={() => createWizardMutation.mutate()}
                    disabled={!readyForSave || createWizardMutation.isPending}
                    className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
                  >
                    {createWizardMutation.isPending ? 'Kaydediliyor...' : wizard.syncAfterCreate ? 'Kaydet ve Senkronize Et' : 'Kaydet'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
