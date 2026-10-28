import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

interface OrderStats {
  todayNew: number
  pendingApproval: number
  pendingReturn: number
  total: number
}

interface ProductUpdateOperationReport {
  date: string
  totals: {
    scanned: number
    prepared: number
    updated: number
    skipped: number
    failed: number
    operations: number
  }
  marketplaces: {
    marketplace: string
    enabled: boolean
    scheduleTime: string | null
    scanned: number
    prepared: number
    updated: number
    skipped: number
    failed: number
    operations: number
    lastOperationAt: string | null
    nextBatchAt: string | null
    inProgress: boolean
  }[]
  recentFailures: {
    id: string
    marketplace: string | null
    type: string
    status: string
    message: string | null
    at: string
  }[]
}

const marketplaceLabel: Record<string, string> = {
  TRENDYOL: 'Trendyol',
  PAZARAMA: 'Pazarama',
  N11: 'N11',
  HEPSIBURADA: 'Hepsiburada',
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00+03:00`)
  return new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

function formatTime(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export default function DashboardPage() {
  const { data: stats, isLoading } = useQuery<{ data: OrderStats }>({
    queryKey: ['order-stats'],
    queryFn: () => api.get('/orders/stats').then(r => r.data),
    refetchInterval: 30000,
  })

  const { data: categoryStats } = useQuery<{ data: { pending: number; approved: number; total: number } }>({
    queryKey: ['category-stats'],
    queryFn: () => api.get('/category-stats').then(r => r.data),
  })

  const { data: productUpdateReport } = useQuery<{ data: ProductUpdateOperationReport }>({
    queryKey: ['product-update-operation-report'],
    queryFn: () => api.get('/marketplace-listings/daily-report').then(r => r.data),
    refetchInterval: 60000,
  })

  const cards = [
    { label: 'Bugun Yeni Siparis', value: stats?.data.todayNew ?? 0, accent: '#e9b33f', tint: '#fff4d8' },
    { label: 'Onay Bekleyen', value: stats?.data.pendingApproval ?? 0, accent: '#b68a2f', tint: '#f3ead2' },
    { label: 'Iade Talebi', value: stats?.data.pendingReturn ?? 0, accent: '#bd6a4a', tint: '#f8e5da' },
    { label: 'Kategori Onay Bekleyen', value: categoryStats?.data.pending ?? 0, accent: '#718348', tint: '#e9eddc' },
  ]

  const quickLinks = [
    { label: 'Urun Listesi', href: '/products' },
    { label: 'Yeni Siparisler', href: '/orders' },
    { label: 'Fiyat Simulatoru', href: '/price-engine' },
    { label: 'Kategori Onaylari', href: '/categories' },
  ]

  const systemStatus = [
    { label: 'Backend API', status: 'Calisiyor' },
    { label: 'PostgreSQL', status: 'Bagli' },
    { label: 'Redis', status: 'Bagli' },
    { label: 'BullMQ', status: 'Aktif' },
  ]

  return (
    <div className="p-6 lg:p-8 max-w-[1600px] mx-auto">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#a87820] mb-2">Genel Bakis</div>
          <h1 className="text-3xl font-bold tracking-tight text-[#123a3b]">Dashboard</h1>
          <p className="text-[#766454] text-sm mt-1">Siparis, kategori ve entegrasyon durumunun anlik ozeti</p>
        </div>
        <div className="rounded-full border border-[#d8c594] bg-[#fffaf3] px-4 py-2 text-xs text-[#6f604e] shadow-sm">
          <span className="inline-block w-2 h-2 rounded-full bg-[#819848] mr-2" />
          Sistemler aktif
        </div>
      </div>

      {isLoading ? (
        <div className="text-[#766454]">Yukleniyor...</div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {cards.map(card => (
            <div
              key={card.label}
              className="relative overflow-hidden rounded-2xl border border-[#dfcda5] p-5 shadow-sm"
              style={{ backgroundColor: card.tint }}
            >
              <div className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: card.accent }} />
              <div className="text-3xl font-black text-[#153b3c]">{card.value}</div>
              <div className="text-sm text-[#695849] mt-1">{card.label}</div>
              <div className="absolute -right-5 -bottom-8 w-20 h-20 rounded-full opacity-10" style={{ backgroundColor: card.accent }} />
            </div>
          ))}
        </div>
      )}

      <div className="warm-panel p-5 lg:p-6 mb-8">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2 className="font-bold text-lg text-[#153b3c]">Urun Guncelleme Operasyon Raporu</h2>
            <p className="text-xs text-[#7b6a58] mt-1">
              {productUpdateReport?.data.date ? formatDate(productUpdateReport.data.date) : 'Bugun'} tarihinde calisan stok/fiyat entegrasyon sonuclari
            </p>
          </div>
          <div className="rounded-full bg-[#efe5cf] px-3 py-1.5 text-xs text-[#766454]">60 sn otomatik yenilenir</div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          <div className="warm-subpanel p-3">
            <div className="text-2xl font-bold text-[#174f50]">{productUpdateReport?.data.totals.scanned ?? 0}</div>
            <div className="text-xs text-[#746250] mt-1">Taranan</div>
          </div>
          <div className="warm-subpanel p-3">
            <div className="text-2xl font-bold text-[#397071]">{productUpdateReport?.data.totals.prepared ?? 0}</div>
            <div className="text-xs text-[#746250] mt-1">Hazirlanan</div>
          </div>
          <div className="warm-subpanel p-3">
            <div className="text-2xl font-bold text-[#718348]">{productUpdateReport?.data.totals.updated ?? 0}</div>
            <div className="text-xs text-[#746250] mt-1">Gonderilen</div>
          </div>
          <div className="warm-subpanel p-3">
            <div className="text-2xl font-bold text-[#b27d19]">{productUpdateReport?.data.totals.skipped ?? 0}</div>
            <div className="text-xs text-[#746250] mt-1">Atlanan</div>
          </div>
          <div className="warm-subpanel p-3">
            <div className="text-2xl font-bold text-[#bd6548]">{productUpdateReport?.data.totals.failed ?? 0}</div>
            <div className="text-xs text-[#746250] mt-1">Hatali</div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-[#dfcda5]">
          <table className="w-full text-sm">
            <thead className="bg-[#123f40]">
              <tr className="text-left text-[#f6ead0]">
                <th className="py-3 pl-3 pr-3">Pazaryeri</th>
                <th className="py-2 pr-3">Taranan</th>
                <th className="py-2 pr-3">Hazirlanan</th>
                <th className="py-2 pr-3">Gonderilen</th>
                <th className="py-2 pr-3">Atlanan</th>
                <th className="py-2 pr-3">Hatali</th>
                <th className="py-2 pr-3">Paket</th>
                <th className="py-2 pr-3">Durum</th>
                <th className="py-2 pr-3">Son Paket</th>
              </tr>
            </thead>
            <tbody className="bg-[#fffdf8]">
              {(productUpdateReport?.data.marketplaces ?? []).map(item => (
                <tr key={item.marketplace} className="border-b border-[#eadfc9] last:border-b-0 hover:bg-[#faf3e5] transition-colors">
                  <td className="py-3 pl-3 pr-3 font-semibold text-[#163b3c]">{marketplaceLabel[item.marketplace] ?? item.marketplace}</td>
                  <td className="py-3 pr-3 text-[#245b5c]">{item.scanned}</td>
                  <td className="py-3 pr-3 text-[#397071]">{item.prepared}</td>
                  <td className="py-3 pr-3 text-[#718348]">{item.updated}</td>
                  <td className="py-3 pr-3 text-[#a87518]">{item.skipped}</td>
                  <td className="py-3 pr-3 text-[#bd6548]">{item.failed}</td>
                  <td className="py-3 pr-3 text-[#5f5144]">{item.operations}</td>
                  <td className="py-2 pr-3">
                    <span className={`rounded-full px-2 py-1 text-xs ${
                      item.inProgress
                        ? 'bg-[#f5dfac] text-[#7c5816]'
                        : item.operations > 0
                          ? 'bg-[#e5ead7] text-[#607239]'
                          : item.enabled
                            ? 'bg-[#dcebea] text-[#245b5c]'
                            : 'bg-[#ebe3d5] text-[#75685a]'
                    }`}>
                      {item.inProgress
                        ? 'Devam ediyor'
                        : item.operations > 0
                          ? 'Tamamlandi'
                          : item.enabled
                            ? 'Planlandi'
                            : 'Otomatik kapali'}
                    </span>
                    {item.nextBatchAt ? <div className="text-xs text-[#857463] mt-1">Sonraki: {formatTime(item.nextBatchAt)}</div> : null}
                    {!item.nextBatchAt && item.enabled && item.scheduleTime
                      ? <div className="text-xs text-[#857463] mt-1">Her gun: {item.scheduleTime}</div>
                      : null}
                  </td>
                  <td className="py-3 pr-3 text-[#75685a]">{formatTime(item.lastOperationAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(productUpdateReport?.data.recentFailures?.length ?? 0) > 0 ? (
          <div className="mt-4 rounded-xl border border-[#dfa88f] bg-[#f9e8de] p-3">
            <div className="text-sm font-semibold text-[#944b35] mb-2">Son hatalar</div>
            <div className="space-y-2">
              {productUpdateReport?.data.recentFailures.map(item => (
                <div key={item.id} className="text-xs text-[#604d42]">
                  <span className="font-medium text-[#423128]">{item.marketplace ? marketplaceLabel[item.marketplace] ?? item.marketplace : 'Genel'}</span>
                  <span className="text-[#8a7568]"> | {item.type} | {formatTime(item.at)} | </span>
                  <span className="text-[#a44f38]">{item.message || item.status}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="warm-panel p-5">
          <h2 className="font-bold mb-3 text-[#153b3c]">Hizli Baglantilar</h2>
          <div className="space-y-2">
            {quickLinks.map(link => (
              <a
                key={link.href}
                href={link.href}
                className="flex items-center justify-between px-3 py-2.5 rounded-xl text-sm text-[#5f5144] border border-transparent hover:border-[#dfcda5] hover:bg-[#f3ead6] hover:text-[#153b3c] transition-all"
              >
                <span>{link.label}</span>
                <span className="text-[#b07b1c]">→</span>
              </a>
            ))}
          </div>
        </div>

        <div className="warm-panel p-5">
          <h2 className="font-bold mb-3 text-[#153b3c]">Sistem Durumu</h2>
          <div className="space-y-2">
            {systemStatus.map(item => (
              <div key={item.label} className="flex items-center justify-between text-sm px-3 py-2.5 rounded-xl bg-[#f3ead6]">
                <span className="text-[#5f5144]">{item.label}</span>
                <span className="flex items-center gap-2 text-[#607239] font-medium">
                  <span className="w-2 h-2 rounded-full bg-[#819848] inline-block shadow-[0_0_0_3px_rgba(129,152,72,0.14)]"></span>
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
