import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

interface OrderStats {
  todayNew: number
  pendingApproval: number
  pendingReturn: number
  total: number
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

  const cards = [
    { label: 'Bugun Yeni Siparis', value: stats?.data.todayNew ?? 0, color: 'text-blue-400', bg: 'bg-blue-900/30' },
    { label: 'Onay Bekleyen', value: stats?.data.pendingApproval ?? 0, color: 'text-yellow-400', bg: 'bg-yellow-900/30' },
    { label: 'Iade Talebi', value: stats?.data.pendingReturn ?? 0, color: 'text-red-400', bg: 'bg-red-900/30' },
    { label: 'Kategori Onay Bekleyen', value: categoryStats?.data.pending ?? 0, color: 'text-purple-400', bg: 'bg-purple-900/30' },
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
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-gray-400 text-sm mt-1">Pazar.io genel ozet</p>
      </div>

      {isLoading ? (
        <div className="text-gray-400">Yukleniyor...</div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {cards.map(card => (
            <div key={card.label} className={`rounded-xl p-4 border border-gray-800 ${card.bg}`}>
              <div className={`text-3xl font-bold ${card.color}`}>{card.value}</div>
              <div className="text-sm text-gray-400 mt-1">{card.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="font-bold mb-3 text-sm text-gray-300">Hizli Baglantılar</h2>
          <div className="space-y-2">
            {quickLinks.map(link => (
              <a
                key={link.href}
                href={link.href}
                className="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>

        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="font-bold mb-3 text-sm text-gray-300">Sistem Durumu</h2>
          <div className="space-y-2">
            {systemStatus.map(item => (
              <div key={item.label} className="flex items-center justify-between text-sm">
                <span className="text-gray-400">{item.label}</span>
                <span className="flex items-center gap-1 text-green-400">
                  <span className="w-2 h-2 rounded-full bg-green-400 inline-block"></span>
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