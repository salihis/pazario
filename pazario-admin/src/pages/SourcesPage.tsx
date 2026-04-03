// src/pages/SourcesPage.tsx

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface XmlSource {
  id: string
  name: string
  url: string
  fetchTimeoutSec: number
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
  parsed: number
  failed: number
  durationMs: number
  sample: { id: string; title: string; price: number; stock: number; images: number }[]
  errors: { type: string; code: string; message: string }[]
}

const statusColor: Record<string, string> = {
  PENDING: 'text-gray-400 bg-gray-800',
  RUNNING: 'text-yellow-400 bg-yellow-900/30',
  DONE: 'text-green-400 bg-green-900/30',
  FAILED: 'text-red-400 bg-red-900/30',
}

export default function SourcesPage() {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [testUrl, setTestUrl] = useState('')
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState('')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [formData, setFormData] = useState({ name: '', url: '', fetchTimeoutSec: 60 })

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

  const createMutation = useMutation({
    mutationFn: (data: typeof formData) => api.post('/sources', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      setShowForm(false)
      setFormData({ name: '', url: '', fetchTimeoutSec: 60 })
    },
  })

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.post(`/sources/${id}/sync`),
    onSuccess: (_, id) => {
      setSelectedSourceId(id)
      queryClient.invalidateQueries({ queryKey: ['sync-jobs', id] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.put(`/sources/${id}`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sources'] }),
  })

  const testMutation = useMutation({
    mutationFn: (url: string) => api.post('/sources/test', { url }).then(r => r.data),
    onSuccess: (data) => { setTestResult(data.data); setTestError('') },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string } } }
      setTestError(err.response?.data?.error ?? 'Test basarisiz')
      setTestResult(null)
    },
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">XML Kaynaklar</h1>
          <p className="text-gray-400 text-sm mt-1">Tedarikci XML feed yonetimi</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + Yeni Kaynak
        </button>
      </div>

      {/* Feed Test Araci */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 mb-6">
        <div className="text-sm font-bold text-gray-200 mb-3">Feed Test Araci</div>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="https://tedarikci.com/feed.xml"
            value={testUrl}
            onChange={e => setTestUrl(e.target.value)}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => testMutation.mutate(testUrl)}
            disabled={!testUrl || testMutation.isPending}
            className="bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {testMutation.isPending ? 'Test ediliyor...' : 'Test Et'}
          </button>
        </div>

        {testError && (
          <div className="mt-3 text-red-400 text-sm bg-red-900/20 rounded-lg p-3">{testError}</div>
        )}

        {testResult && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Feed Tipi', value: testResult.feedType },
                { label: 'Toplam Urun', value: testResult.totalProducts },
                { label: 'Parse Edilen', value: testResult.parsed },
                { label: 'Sure', value: `${testResult.durationMs}ms` },
              ].map(item => (
                <div key={item.label} className="bg-gray-800 rounded-lg p-3">
                  <div className="text-xs text-gray-500">{item.label}</div>
                  <div className="text-sm font-bold text-gray-200 mt-1">{item.value}</div>
                </div>
              ))}
            </div>

            {testResult.sample.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-2">Ornek Urunler</div>
                <div className="space-y-2">
                  {testResult.sample.map(p => (
                    <div key={p.id} className="bg-gray-800 rounded-lg p-3 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-gray-200">{p.title}</div>
                        <div className="text-xs text-gray-500 mt-0.5">ID: {p.id}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm text-green-400">{p.price} TL</div>
                        <div className="text-xs text-gray-500">Stok: {p.stock}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-4">
        {/* Kaynak Listesi */}
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
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium text-gray-200">{source.name}</div>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${source.active ? 'text-green-400 bg-green-900/30' : 'text-gray-500 bg-gray-800'}`}>
                          {source.active ? 'Aktif' : 'Pasif'}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1 truncate">{source.url}</div>
                      <div className="text-xs text-gray-600 mt-1">{source._count.products} urun</div>
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

        {/* Sync Job Gecmisi */}
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

      {/* Yeni Kaynak Formu */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Yeni XML Kaynak</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-300">X</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Kaynak Adi</label>
                <input
                  type="text"
                  placeholder="Tedarikci A"
                  value={formData.name}
                  onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Feed URL</label>
                <input
                  type="text"
                  placeholder="https://tedarikci.com/feed.xml"
                  value={formData.url}
                  onChange={e => setFormData(p => ({ ...p, url: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Timeout (saniye)</label>
                <input
                  type="number"
                  value={formData.fetchTimeoutSec}
                  onChange={e => setFormData(p => ({ ...p, fetchTimeoutSec: parseInt(e.target.value) }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => createMutation.mutate(formData)}
                  disabled={createMutation.isPending || !formData.name || !formData.url}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Kaydediliyor...' : 'Kaydet'}
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 rounded-lg text-sm"
                >
                  Iptal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}