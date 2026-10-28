import { useQuery } from '@tanstack/react-query'
import { getLocalSyncSources, getLocalSyncStatus } from '../services/localSyncApi'

interface LocalSyncState {
  id: string
  lastSeenAt: string | null
  lastSyncAt: string | null
  totalProducts: number
  pendingProducts: number
  syncedProducts: number
  failedProducts: number
  lastError: string | null
  updatedAt: string | null
}

interface LocalSyncStatus {
  state: LocalSyncState
  sourceCount: number
  productCount: number
}

interface LocalSyncSource {
  id: string
  name: string
  url: string
  active: boolean
  createdAt: string
  _count: { products: number }
}

function formatDate(value: string | null) {
  if (!value) return 'Yok'
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value))
}

function StatCard({ label, value, tone = 'blue' }: { label: string; value: string | number; tone?: 'blue' | 'green' | 'red' | 'amber' }) {
  const colors = {
    blue: 'border-blue-900 bg-blue-950/40 text-blue-300',
    green: 'border-emerald-900 bg-emerald-950/40 text-emerald-300',
    red: 'border-red-900 bg-red-950/40 text-red-300',
    amber: 'border-amber-900 bg-amber-950/40 text-amber-300',
  }

  return (
    <div className={`rounded-lg border p-5 ${colors[tone]}`}>
      <div className="text-3xl font-bold">{value}</div>
      <div className="mt-2 text-sm text-gray-300">{label}</div>
    </div>
  )
}

export default function LocalXmlSyncPage() {
  const statusQuery = useQuery({
    queryKey: ['local-sync-status'],
    queryFn: () => getLocalSyncStatus<LocalSyncStatus>(),
    refetchInterval: 30000,
  })

  const sourcesQuery = useQuery({
    queryKey: ['local-sync-sources'],
    queryFn: () => getLocalSyncSources<LocalSyncSource[]>(),
    refetchInterval: 30000,
  })

  const state = statusQuery.data?.state

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Local XML Sync</h1>
        <p className="text-gray-400 mt-2">Windows local agent ve bulut urun senkronizasyon durumu</p>
      </div>

      {statusQuery.error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-5 py-4 text-red-100">
          Local sync durumu alinamadi.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Buluttaki XML kaynak" value={statusQuery.data?.sourceCount ?? 0} />
        <StatCard label="Buluttaki urun" value={statusQuery.data?.productCount ?? 0} tone="green" />
        <StatCard label="Son pakette senkron" value={state?.syncedProducts ?? 0} tone="green" />
        <StatCard label="Son pakette hatali" value={state?.failedProducts ?? 0} tone="red" />
      </div>

      <section className="rounded-lg border border-gray-800 bg-gray-900 p-5">
        <h2 className="text-lg font-semibold text-white">Agent Durumu</h2>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-gray-500">Son baglanti</div>
            <div className="mt-1 text-white">{formatDate(state?.lastSeenAt ?? null)}</div>
          </div>
          <div>
            <div className="text-gray-500">Son senkronizasyon</div>
            <div className="mt-1 text-white">{formatDate(state?.lastSyncAt ?? null)}</div>
          </div>
          <div>
            <div className="text-gray-500">Son paket urun sayisi</div>
            <div className="mt-1 text-white">{state?.totalProducts ?? 0}</div>
          </div>
          <div>
            <div className="text-gray-500">Bekleyen</div>
            <div className="mt-1 text-white">{state?.pendingProducts ?? 0}</div>
          </div>
        </div>
        {state?.lastError && (
          <div className="mt-4 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-red-100">
            {state.lastError}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">XML Kaynaklari</h2>
            <p className="text-sm text-gray-500">Local agent tarafindan buluta bildirilen kaynaklar</p>
          </div>
          {sourcesQuery.isFetching && <span className="text-sm text-gray-500">Yenileniyor...</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-950 text-gray-400">
              <tr>
                <th className="px-5 py-3 text-left font-medium">Kaynak</th>
                <th className="px-5 py-3 text-left font-medium">URL</th>
                <th className="px-5 py-3 text-left font-medium">Urun</th>
                <th className="px-5 py-3 text-left font-medium">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {(sourcesQuery.data ?? []).map(source => (
                <tr key={source.id}>
                  <td className="px-5 py-4 text-white">{source.name}</td>
                  <td className="px-5 py-4 text-gray-400 max-w-xl truncate">{source.url}</td>
                  <td className="px-5 py-4 text-gray-300">{source._count.products}</td>
                  <td className="px-5 py-4">
                    <span className={`rounded px-2 py-1 text-xs ${source.active ? 'bg-emerald-950 text-emerald-300' : 'bg-gray-800 text-gray-400'}`}>
                      {source.active ? 'Aktif' : 'Pasif'}
                    </span>
                  </td>
                </tr>
              ))}
              {!sourcesQuery.isLoading && (sourcesQuery.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-gray-500">
                    Henuz local agent kaynagi yok.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
