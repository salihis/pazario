import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface CategoryMapping {
  id: string
  sourceCategory: string
  marketplace: string
  marketplaceCategoryId: string | null
  marketplaceCategoryPath: string | null
  status: string
  aiSuggested: boolean
  aiConfidence: number | null
  allSuggestions: {
    categoryId: string
    categoryPath: string
    confidence: number
    reason: string
  }[] | null
  source: { name: string }
}

interface CategoryStats {
  pending: number
  approved: number
  rejected: number
  total: number
}

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

const statusColor: Record<string, string> = {
  PENDING: 'text-yellow-400 bg-yellow-900/30',
  APPROVED: 'text-green-400 bg-green-900/30',
  REJECTED: 'text-red-400 bg-red-900/30',
}

const confidenceColor = (c: number) => {
  if (c >= 0.9) return 'text-green-400'
  if (c >= 0.6) return 'text-yellow-400'
  return 'text-red-400'
}

export default function CategoryPage() {
  const queryClient = useQueryClient()
  const [marketplace, setMarketplace] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: stats } = useQuery<{ data: CategoryStats }>({
    queryKey: ['category-stats'],
    queryFn: () => api.get('/category-stats').then(r => r.data),
  })

  const { data, isLoading } = useQuery<{ data: CategoryMapping[] }>({
    queryKey: ['category-mappings', marketplace],
    queryFn: () =>
      api.get('/category-mappings/pending', {
        params: { marketplace: marketplace || undefined, limit: 50 },
      }).then(r => r.data),
  })

  const approveMutation = useMutation({
    mutationFn: ({ id, suggestionIndex }: { id: string; suggestionIndex: number }) =>
      api.put(`/category-mappings/${id}/approve`, { suggestionIndex }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      setSelectedId(null)
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (id: string) => api.put(`/category-mappings/${id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['category-mappings'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
    },
  })

  const selected = data?.data.find(m => m.id === selectedId)

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Kategoriler</h1>
          <p className="text-gray-400 text-sm mt-1">Kategori eslestirme onaylari</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Bekleyen', value: stats?.data.pending ?? 0, color: 'text-yellow-400', bg: 'bg-yellow-900/30' },
          { label: 'Onaylanan', value: stats?.data.approved ?? 0, color: 'text-green-400', bg: 'bg-green-900/30' },
          { label: 'Reddedilen', value: stats?.data.rejected ?? 0, color: 'text-red-400', bg: 'bg-red-900/30' },
          { label: 'Toplam', value: stats?.data.total ?? 0, color: 'text-blue-400', bg: 'bg-blue-900/30' },
        ].map(card => (
          <div key={card.label} className={`rounded-xl p-4 border border-gray-800 ${card.bg}`}>
            <div className={`text-3xl font-bold ${card.color}`}>{card.value}</div>
            <div className="text-sm text-gray-400 mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div className="flex gap-3 mb-4">
        <select
          value={marketplace}
          onChange={e => setMarketplace(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          <option value="">Tum Pazaryerleri</option>
          {MARKETPLACES.map(mp => (
            <option key={mp} value={mp}>{mp}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-4">
        {/* Liste */}
        <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 text-xs text-gray-400 uppercase tracking-wider">
            Onay Bekleyen Kategoriler
          </div>
          {isLoading ? (
            <div className="p-8 text-center text-gray-500">Yukleniyor...</div>
          ) : data?.data.length === 0 ? (
            <div className="p-8 text-center text-gray-500">Bekleyen kategori yok</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {data?.data.map(mapping => (
                <div
                  key={mapping.id}
                  onClick={() => setSelectedId(mapping.id === selectedId ? null : mapping.id)}
                  className={`px-4 py-3 cursor-pointer hover:bg-gray-800/50 transition-colors ${
                    selectedId === mapping.id ? 'bg-gray-800 border-l-2 border-blue-500' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-100 truncate">{mapping.sourceCategory}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-gray-500">{mapping.marketplace}</span>
                        <span className="text-xs text-gray-600">•</span>
                        <span className="text-xs text-gray-500">{mapping.source?.name}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {mapping.aiConfidence && (
                        <span className={`text-xs font-mono ${confidenceColor(mapping.aiConfidence)}`}>
                          %{Math.round(mapping.aiConfidence * 100)}
                        </span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor[mapping.status]}`}>
                        {mapping.status === 'PENDING' ? 'Bekliyor' : mapping.status === 'APPROVED' ? 'Onaylandi' : 'Reddedildi'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detay Paneli */}
        {selected && (
          <div className="w-96 bg-gray-900 rounded-xl border border-gray-800 flex flex-col">
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="text-sm font-bold text-gray-100">AI Onerileri</div>
              <div className="text-xs text-gray-500 mt-0.5 truncate">{selected.sourceCategory}</div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {selected.allSuggestions?.map((s, i) => (
                <div
                  key={i}
                  className="bg-gray-800 rounded-lg p-3 border border-gray-700"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className={`text-sm font-mono font-bold ${confidenceColor(s.confidence)}`}>
                      %{Math.round(s.confidence * 100)}
                    </span>
                    <span className="text-xs text-gray-500">#{i + 1}</span>
                  </div>
                  <div className="text-xs text-gray-300 mb-1">{s.categoryPath}</div>
                  <div className="text-xs text-gray-500 mb-3">{s.reason}</div>
                  <button
                    onClick={() => approveMutation.mutate({ id: selected.id, suggestionIndex: i })}
                    disabled={approveMutation.isPending}
                    className="w-full bg-green-700 hover:bg-green-600 text-white text-xs py-1.5 rounded transition-colors disabled:opacity-50"
                  >
                    Bu Oneriyi Onayla
                  </button>
                </div>
              ))}

              {(!selected.allSuggestions || selected.allSuggestions.length === 0) && (
                <div className="text-center text-gray-500 text-sm py-4">
                  AI onerisi yok
                </div>
              )}
            </div>

            <div className="p-4 border-t border-gray-800 space-y-2">
              <button
                onClick={() => rejectMutation.mutate(selected.id)}
                disabled={rejectMutation.isPending}
                className="w-full bg-red-900/50 hover:bg-red-900 text-red-400 text-xs py-2 rounded transition-colors disabled:opacity-50"
              >
                Reddet
              </button>
              <button
                onClick={() => setSelectedId(null)}
                className="w-full bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs py-2 rounded transition-colors"
              >
                Kapat
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}