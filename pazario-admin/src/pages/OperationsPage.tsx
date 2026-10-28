import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

type OperationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'PARTIALLY_FAILED'
  | 'WAITING_MARKETPLACE'
  | 'RETRYING'

type OperationType =
  | 'PRODUCT_PUBLISH'
  | 'VARIANT_UPDATE'
  | 'STOCK_UPDATE'
  | 'PRICE_UPDATE'
  | 'STOCK_PRICE_UPDATE'
  | 'XML_SYNC'
  | 'ORDER_FETCH'
  | 'MARKETPLACE_IMPORT'

interface Operation {
  id: string
  type: OperationType
  status: OperationStatus
  title: string
  marketplace: string | null
  queueName: string | null
  queueJobId: string | null
  externalBatchId: string | null
  requestedBy: string | null
  targetCount: number
  successCount: number
  failedCount: number
  skippedCount: number
  retryCount: number
  maxRetryCount: number
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  metadata: unknown
  _count?: { items: number }
}

interface OperationItem {
  id: string
  productId: string | null
  sku: string | null
  barcode: string | null
  variantGroupKey: string | null
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED'
  externalListingId: string | null
  externalBatchId: string | null
  errorMessage: string | null
  product?: { id: string; sku: string; title: string; images: string[] } | null
}

interface OperationDetail extends Operation {
  items: OperationItem[]
}

interface OperationsResponse {
  data: Operation[]
  meta: { total: number; page: number; limit: number }
}

const STATUSES: Array<{ value: '' | OperationStatus; label: string }> = [
  { value: '', label: 'Tumu' },
  { value: 'QUEUED', label: 'Queued' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'WAITING_MARKETPLACE', label: 'Waiting' },
  { value: 'SUCCEEDED', label: 'Succeeded' },
  { value: 'PARTIALLY_FAILED', label: 'Partial' },
  { value: 'FAILED', label: 'Failed' },
]

const TYPES: Array<{ value: '' | OperationType; label: string }> = [
  { value: '', label: 'Tum Islemler' },
  { value: 'PRODUCT_PUBLISH', label: 'Product Publish' },
  { value: 'VARIANT_UPDATE', label: 'Variant Update' },
  { value: 'STOCK_UPDATE', label: 'Stock Update' },
  { value: 'PRICE_UPDATE', label: 'Price Update' },
  { value: 'STOCK_PRICE_UPDATE', label: 'Stock + Price' },
  { value: 'XML_SYNC', label: 'XML Sync' },
  { value: 'ORDER_FETCH', label: 'Order Fetch' },
  { value: 'MARKETPLACE_IMPORT', label: 'Marketplace Import' },
]

const MARKETPLACES = ['', 'TRENDYOL', 'PAZARAMA', 'N11', 'HEPSIBURADA']

function statusClass(status: string) {
  if (status === 'SUCCEEDED') return 'bg-emerald-950 text-emerald-200 border-emerald-800'
  if (status === 'FAILED') return 'bg-red-950 text-red-200 border-red-800'
  if (status === 'PARTIALLY_FAILED') return 'bg-amber-950 text-amber-200 border-amber-800'
  if (status === 'RUNNING') return 'bg-blue-950 text-blue-200 border-blue-800'
  if (status === 'WAITING_MARKETPLACE') return 'bg-purple-950 text-purple-200 border-purple-800'
  return 'bg-gray-900 text-gray-300 border-gray-700'
}

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value))
}

function formatJson(value: unknown) {
  if (!value || (typeof value === 'object' && Object.keys(value as object).length === 0)) return '-'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export default function OperationsPage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'' | OperationStatus>('')
  const [type, setType] = useState<'' | OperationType>('')
  const [marketplace, setMarketplace] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data, isFetching } = useQuery<OperationsResponse>({
    queryKey: ['operations', page, status, type, marketplace],
    refetchInterval: 10000,
    queryFn: () =>
      api.get('/operations', {
        params: {
          page,
          limit: 25,
          status: status || undefined,
          type: type || undefined,
          marketplace: marketplace || undefined,
        },
      }).then(r => r.data),
  })

  const { data: detail, isFetching: isDetailLoading } = useQuery<{ success: boolean; data: OperationDetail }>({
    queryKey: ['operation-detail', selectedId],
    enabled: Boolean(selectedId),
    refetchInterval: selectedId ? 5000 : false,
    queryFn: () => api.get(`/operations/${selectedId}`).then(r => r.data),
  })

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.post(`/operations/${id}/retry`).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['operations'] })
      queryClient.invalidateQueries({ queryKey: ['operation-detail', selectedId] })
    },
  })

  const total = data?.meta.total ?? 0
  const lastPage = Math.max(1, Math.ceil(total / 25))
  const selected = detail?.data

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Operasyon Izleme</h1>
          <p className="mt-1 text-sm text-gray-400">
            Arka plan islemleri, pazaryeri batch sonuclari ve hata gecmisi.
          </p>
        </div>
        <div className="text-xs text-gray-500">{isFetching ? 'Guncelleniyor...' : '10 sn otomatik yenilenir'}</div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={e => {
            setStatus(e.target.value as '' | OperationStatus)
            setPage(1)
          }}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
        >
          {STATUSES.map(item => <option key={item.label} value={item.value}>{item.label}</option>)}
        </select>
        <select
          value={type}
          onChange={e => {
            setType(e.target.value as '' | OperationType)
            setPage(1)
          }}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
        >
          {TYPES.map(item => <option key={item.label} value={item.value}>{item.label}</option>)}
        </select>
        <select
          value={marketplace}
          onChange={e => {
            setMarketplace(e.target.value)
            setPage(1)
          }}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
        >
          {MARKETPLACES.map(item => <option key={item || 'ALL'} value={item}>{item || 'Tum Pazaryerleri'}</option>)}
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
        <table className="w-full text-sm">
          <thead className="bg-gray-950 text-xs uppercase text-gray-400">
            <tr>
              <th className="px-4 py-3 text-left">Durum</th>
              <th className="px-4 py-3 text-left">Islem</th>
              <th className="px-4 py-3 text-left">Pazaryeri</th>
              <th className="px-4 py-3 text-left">Sonuc</th>
              <th className="px-4 py-3 text-left">Batch / Queue</th>
              <th className="px-4 py-3 text-left">Tarih</th>
              <th className="px-4 py-3 text-left">Aksiyon</th>
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  Operasyon kaydi bulunamadi.
                </td>
              </tr>
            ) : data?.data.map(operation => (
              <tr key={operation.id} className="border-t border-gray-800">
                <td className="px-4 py-3">
                  <span className={`rounded-full border px-2 py-1 text-xs ${statusClass(operation.status)}`}>
                    {operation.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-100">{operation.title}</div>
                  <div className="text-xs text-gray-500">{operation.type}</div>
                </td>
                <td className="px-4 py-3 text-gray-300">{operation.marketplace ?? '-'}</td>
                <td className="px-4 py-3 text-xs text-gray-300">
                  <div>Target: {operation.targetCount}</div>
                  <div>OK: {operation.successCount} | Fail: {operation.failedCount} | Skip: {operation.skippedCount}</div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-400">
                  <div>{operation.externalBatchId ?? '-'}</div>
                  <div>{operation.queueName ?? '-'} / {operation.queueJobId ?? '-'}</div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-400">
                  <div>{formatDate(operation.createdAt)}</div>
                  <div>{operation.finishedAt ? `Bitti: ${formatDate(operation.finishedAt)}` : ''}</div>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setSelectedId(operation.id)}
                    className="rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-600"
                  >
                    Detay
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between border-t border-gray-800 px-4 py-3 text-xs text-gray-500">
          <span>Toplam {total} kayit</span>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="rounded bg-gray-800 px-3 py-1.5 text-gray-300 disabled:opacity-40"
            >
              Onceki
            </button>
            <span>{page} / {lastPage}</span>
            <button
              disabled={page >= lastPage}
              onClick={() => setPage(p => Math.min(lastPage, p + 1))}
              className="rounded bg-gray-800 px-3 py-1.5 text-gray-300 disabled:opacity-40"
            >
              Sonraki
            </button>
          </div>
        </div>
      </div>

      {selectedId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[88vh] w-full max-w-6xl overflow-hidden rounded-lg border border-gray-800 bg-gray-950 shadow-xl">
            <div className="flex items-start justify-between border-b border-gray-800 px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-gray-100">Operasyon Detayi</h2>
                <p className="mt-1 text-xs text-gray-500">{selectedId}</p>
              </div>
              <button onClick={() => setSelectedId(null)} className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-300">
                Kapat
              </button>
            </div>

            {isDetailLoading || !selected ? (
              <div className="p-8 text-center text-gray-500">Yukleniyor...</div>
            ) : (
              <div className="max-h-[75vh] overflow-y-auto p-5">
                <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
                  {[
                    ['Status', selected.status],
                    ['Type', selected.type],
                    ['Marketplace', selected.marketplace ?? '-'],
                    ['Batch', selected.externalBatchId ?? '-'],
                    ['Retry', `${selected.retryCount}/${selected.maxRetryCount}`],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-gray-800 bg-gray-900 p-3">
                      <div className="text-xs text-gray-500">{label}</div>
                      <div className="mt-1 break-words text-sm font-semibold text-gray-100">{value}</div>
                    </div>
                  ))}
                </div>

                {selected.errorMessage && (
                  <div className="mb-4 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-100">
                    {selected.errorMessage}
                  </div>
                )}

                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-gray-100">Urun / Varyant Sonuclari</div>
                  <button
                    onClick={() => retryMutation.mutate(selected.id)}
                    disabled={retryMutation.isPending || !['FAILED', 'PARTIALLY_FAILED', 'SUCCEEDED'].includes(selected.status)}
                    className="rounded bg-amber-700 px-3 py-1.5 text-xs text-white hover:bg-amber-600 disabled:opacity-40"
                  >
                    {retryMutation.isPending ? 'Tekrar deneniyor...' : 'Yeniden Dene'}
                  </button>
                </div>

                <div className="overflow-hidden rounded-lg border border-gray-800">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-900 text-xs uppercase text-gray-400">
                      <tr>
                        <th className="px-3 py-2 text-left">Durum</th>
                        <th className="px-3 py-2 text-left">SKU</th>
                        <th className="px-3 py-2 text-left">Urun</th>
                        <th className="px-3 py-2 text-left">External</th>
                        <th className="px-3 py-2 text-left">Hata</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.length === 0 ? (
                        <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">Detay satiri yok.</td></tr>
                      ) : selected.items.map(item => (
                        <tr key={item.id} className="border-t border-gray-800">
                          <td className="px-3 py-2">
                            <span className={`rounded-full border px-2 py-1 text-xs ${statusClass(item.status)}`}>{item.status}</span>
                          </td>
                          <td className="px-3 py-2 text-gray-200">{item.sku ?? item.product?.sku ?? '-'}</td>
                          <td className="px-3 py-2 text-gray-300">{item.product?.title ?? '-'}</td>
                          <td className="px-3 py-2 text-xs text-gray-400">
                            <div>{item.externalListingId ?? '-'}</div>
                            <div>{item.externalBatchId ?? '-'}</div>
                          </td>
                          <td className="px-3 py-2 text-xs text-red-200">{item.errorMessage ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3">
                  <div className="mb-2 text-xs uppercase text-gray-500">Metadata</div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-gray-300">{formatJson(selected.metadata)}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
