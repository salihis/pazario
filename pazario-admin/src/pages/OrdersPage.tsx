import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface OrderItem {
  id: string
  title: string
  quantity: number
  unitPrice: number
  totalPrice: number
  sku: string | null
}

interface Order {
  id: string
  marketplace: string
  marketplaceOrderId: string
  marketplaceOrderNo: string | null
  status: string
  customerName: string | null
  customerPhone: string | null
  totalAmount: number
  currency: string
  trackingNumber: string | null
  cargoCompany: string | null
  createdAt: string
  items: OrderItem[]
}

interface OrdersResponse {
  data: Order[]
  meta: { total: number; page: number; limit: number }
}

const TABS = [
  { key: 'NEW', label: 'Yeni' },
  { key: 'PREPARING', label: 'Hazirlaniyor' },
  { key: 'SHIPPED', label: 'Kargolandi' },
  { key: 'DELIVERED', label: 'Teslim Edildi' },
  { key: 'CANCELLED', label: 'Iptal/Iade' },
]

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

const statusColor: Record<string, string> = {
  NEW: 'text-blue-400 bg-blue-900/30',
  PENDING_APPROVAL: 'text-yellow-400 bg-yellow-900/30',
  PREPARING: 'text-orange-400 bg-orange-900/30',
  LABEL_CREATED: 'text-purple-400 bg-purple-900/30',
  SHIPPED: 'text-indigo-400 bg-indigo-900/30',
  IN_TRANSIT: 'text-cyan-400 bg-cyan-900/30',
  DELIVERED: 'text-green-400 bg-green-900/30',
  COMPLETED: 'text-green-600 bg-green-900/20',
  CANCELLED: 'text-red-400 bg-red-900/30',
  RETURN_REQUESTED: 'text-pink-400 bg-pink-900/30',
  REFUNDED: 'text-gray-400 bg-gray-800',
}

const statusLabel: Record<string, string> = {
  NEW: 'Yeni',
  PENDING_APPROVAL: 'Onay Bekliyor',
  PREPARING: 'Hazirlaniyor',
  LABEL_CREATED: 'Etiket Olusturuldu',
  SHIPPED: 'Kargolandi',
  IN_TRANSIT: 'Yolda',
  DELIVERED: 'Teslim Edildi',
  COMPLETED: 'Tamamlandi',
  CANCELLED: 'Iptal Edildi',
  RETURN_REQUESTED: 'Iade Talebi',
  REFUNDED: 'Iade Edildi',
}

const mpShort: Record<string, string> = {
  TRENDYOL: 'TY',
  HEPSIBURADA: 'HB',
  N11: 'N11',
  PAZARAMA: 'PZ',
}

export default function OrdersPage() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState('NEW')
  const [marketplace, setMarketplace] = useState('')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [page, setPage] = useState(1)
  const limit = 25

  const { data, isLoading } = useQuery<OrdersResponse>({
    queryKey: ['orders', activeTab, marketplace, page],
    queryFn: () =>
      api.get('/orders', {
        params: {
          status: activeTab,
          marketplace: marketplace || undefined,
          page,
          limit,
        },
      }).then(r => r.data),
  })

  const { data: statsData } = useQuery<{ data: { byStatus: Record<string, number> } }>({
    queryKey: ['order-stats'],
    queryFn: () => api.get('/orders/stats').then(r => r.data),
    refetchInterval: 30000,
  })

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/orders/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['order-stats'] })
      setSelectedOrder(null)
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/orders/${id}/cancel`, { reason: 'Admin tarafindan iptal edildi' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['order-stats'] })
      setSelectedOrder(null)
    },
  })

  const totalPages = data ? Math.ceil(data.meta.total / limit) : 1

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Siparisler</h1>
          <p className="text-gray-400 text-sm mt-1">Tum pazaryeri siparisleri</p>
        </div>
        <button
          onClick={() => api.post('/orders/fetch').then(() => queryClient.invalidateQueries({ queryKey: ['orders'] }))}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Siparis Cek
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-900 rounded-lg p-1 w-fit">
        {TABS.map(tab => {
          const count = statsData?.data?.byStatus?.[tab.key] ?? 0
          return (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setPage(1); setSelectedOrder(null) }}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                activeTab === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-gray-100'
              }`}
            >
              {tab.label}
              {count > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${
                  activeTab === tab.key ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-300'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Filter */}
      <div className="flex gap-3 mb-4">
        <select
          value={marketplace}
          onChange={e => { setMarketplace(e.target.value); setPage(1) }}
          className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          <option value="">Tum Pazaryerleri</option>
          {MARKETPLACES.map(mp => (
            <option key={mp} value={mp}>{mp}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-4">
        {/* Tablo */}
        <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
                  <th className="text-left px-4 py-3">Siparis No</th>
                  <th className="text-left px-4 py-3">Pazaryeri</th>
                  <th className="text-left px-4 py-3">Musteri</th>
                  <th className="text-right px-4 py-3">Tutar</th>
                  <th className="text-left px-4 py-3">Durum</th>
                  <th className="text-left px-4 py-3">Tarih</th>
                  <th className="text-left px-4 py-3">Aksiyon</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-gray-500">Yukleniyor...</td>
                  </tr>
                ) : data?.data.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-gray-500">Siparis bulunamadi</td>
                  </tr>
                ) : (
                  data?.data.map(order => (
                    <tr
                      key={order.id}
                      onClick={() => setSelectedOrder(order.id === selectedOrder?.id ? null : order)}
                      className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer ${
                        selectedOrder?.id === order.id ? 'bg-gray-800/50' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="font-mono text-xs text-gray-300">
                          {order.marketplaceOrderNo ?? order.marketplaceOrderId.slice(0, 12)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-bold px-2 py-1 rounded bg-gray-800 text-gray-300">
                          {mpShort[order.marketplace] ?? order.marketplace}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-300 text-xs">
                        {order.customerName ?? '***'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-medium text-green-400">
                          {Number(order.totalAmount).toLocaleString('tr-TR', {
                            minimumFractionDigits: 2,
                          })} TL
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-1 rounded-full ${statusColor[order.status] ?? 'text-gray-400 bg-gray-800'}`}>
                          {statusLabel[order.status] ?? order.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(order.createdAt).toLocaleDateString('tr-TR')}
                      </td>
                      <td className="px-4 py-3">
                        {order.status === 'NEW' && (
                          <button
                            onClick={e => { e.stopPropagation(); approveMutation.mutate(order.id) }}
                            disabled={approveMutation.isPending}
                            className="text-xs bg-green-700 hover:bg-green-600 text-white px-3 py-1 rounded transition-colors disabled:opacity-50"
                          >
                            Onayla
                          </button>
                        )}
                        {order.status === 'PREPARING' && (
                          <button
                            onClick={e => { e.stopPropagation(); cancelMutation.mutate(order.id) }}
                            disabled={cancelMutation.isPending}
                            className="text-xs bg-red-900/50 hover:bg-red-900 text-red-400 px-3 py-1 rounded transition-colors disabled:opacity-50"
                          >
                            Iptal
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data && data.meta.total > limit && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
              <span className="text-xs text-gray-500">
                Toplam {data.meta.total} siparis
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700"
                >
                  Onceki
                </button>
                <span className="px-3 py-1 text-xs text-gray-400">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700"
                >
                  Sonraki
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Siparis Detay */}
        {selectedOrder && (
          <div className="w-80 bg-gray-900 rounded-xl border border-gray-800 flex flex-col">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <div className="text-sm font-bold">Siparis Detayi</div>
              <button onClick={() => setSelectedOrder(null)} className="text-gray-500 hover:text-gray-300 text-xs">Kapat</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <div className="text-xs text-gray-500 mb-1">Siparis No</div>
                <div className="font-mono text-xs text-gray-300">{selectedOrder.marketplaceOrderId}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Pazaryeri</div>
                <div className="text-sm text-gray-300">{selectedOrder.marketplace}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Musteri</div>
                <div className="text-sm text-gray-300">{selectedOrder.customerName ?? '***'}</div>
                <div className="text-xs text-gray-500">{selectedOrder.customerPhone ?? ''}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-2">Urunler</div>
                <div className="space-y-2">
                  {selectedOrder.items.map(item => (
                    <div key={item.id} className="bg-gray-800 rounded-lg p-2">
                      <div className="text-xs text-gray-300 line-clamp-2">{item.title}</div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs text-gray-500">{item.quantity} adet</span>
                        <span className="text-xs text-green-400">
                          {Number(item.totalPrice).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Toplam</div>
                <div className="text-lg font-bold text-green-400">
                  {Number(selectedOrder.totalAmount).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL
                </div>
              </div>
              {selectedOrder.trackingNumber && (
                <div>
                  <div className="text-xs text-gray-500 mb-1">Takip No</div>
                  <div className="font-mono text-xs text-blue-400">{selectedOrder.trackingNumber}</div>
                  <div className="text-xs text-gray-500">{selectedOrder.cargoCompany}</div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-800 space-y-2">
              {selectedOrder.status === 'NEW' && (
                <button
                  onClick={() => approveMutation.mutate(selectedOrder.id)}
                  disabled={approveMutation.isPending}
                  className="w-full bg-green-700 hover:bg-green-600 text-white text-sm py-2 rounded transition-colors disabled:opacity-50"
                >
                  Onayla
                </button>
              )}
              {['NEW', 'PREPARING'].includes(selectedOrder.status) && (
                <button
                  onClick={() => cancelMutation.mutate(selectedOrder.id)}
                  disabled={cancelMutation.isPending}
                  className="w-full bg-red-900/50 hover:bg-red-900 text-red-400 text-sm py-2 rounded transition-colors disabled:opacity-50"
                >
                  Iptal Et
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}