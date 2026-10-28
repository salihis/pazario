import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface FinanceItem {
  id: string
  orderId: string
  orderNo: string
  orderDate: string
  orderStatus: string
  marketplace: string
  sourceName: string
  sku: string | null
  title: string
  quantity: number
  unitPrice: number
  unitPurchasePrice: number | null
  manualPurchasePrice: number | null
  purchasePriceSource: 'MANUAL' | 'XML' | 'MISSING'
  purchase: number | null
  originalSales: number
  sales: number
  shipping: number | null
  service: number | null
  extra: number | null
  additionalIncome: number
  manualFees: { shipping: number; service: number; extra: number }
  provisional: boolean
  accountingStatus: 'WAITING' | 'PARTIAL' | 'RECORDED' | 'REVIEW'
  accountingSyncedAt: string | null
  issues: string[]
  missingFees: string[]
  paid: number | null
  pending: number | null
  transactions: Array<{ id: string; type: string; amount: number; status: string; dueDate: string | null }>
  net: number
  grossProfit: number | null
  profit: number | null
  isRevenueOrder: boolean
}

interface FinanceSummary {
  orders: number
  sales: number
  purchase: number
  shipping: number
  service: number
  extra: number
  net: number
  profit: number | null
  missingPurchase: number
  additionalIncome: number
  incomplete: number
  provisional: boolean
  paid: number
  pending: number
}

interface FinanceResponse {
  data: {
    items: FinanceItem[]
    syncTargets: Array<{ orderId: string; orderNumber: string }>
    summary: {
      selectedRange: FinanceSummary
      today: FinanceSummary
      week: FinanceSummary
      month: FinanceSummary
    }
    meta: { total: number; page: number; limit: number }
  }
}

interface XmlSource {
  id: string
  name: string
}

interface CargoInvoicePreview {
  data: {
    invoiceSerialNumber: string
    totalElements: number
    items: Array<{
      shipmentPackageType: string
      parcelUniqueId: string | null
      orderNumber: string | null
      amount: number
      desi: number | null
    }>
    summary: { count: number; amount: number }
  }
}

interface CargoInvoiceImportResult {
  data: {
    invoiceSerialNumber: string
    importedItems: number
    invoiceAmount: number
    matchedOrders: number
    updatedItems: number
    appliedAmount: number
    unmatchedOrderNumbers: string[]
  }
}

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const PAGE_SIZE_OPTIONS = [25, 50, 100]
const accountingLabels = { WAITING: 'Muhasebe bekleniyor', PARTIAL: 'Eksik muhasebe kaydi', RECORDED: 'Muhasebe kayitli', REVIEW: 'Kontrol gerekli' }
const transactionLabels: Record<string, string> = {
  Payment: 'Satis', Return: 'Satis iadesi', Commission: 'Komisyon', CommissionRefund: 'Komisyon iadesi',
  ShipmentCostSharingExpense: 'Kargo', ReturnShipmentCostSharingExpense: 'Iade kargosu',
  CampaignDiscount: 'Kampanya destegi', CampaignDiscountRefund: 'Kampanya destegi iadesi',
  Stoppage: 'Stopaj', StoppageRefund: 'Stopaj iadesi', PaymentServiceCostReflection: 'Odeme hizmet bedeli',
  ProcessingFeeExpense: 'Islem ucreti', DeliveryProcessingFee: 'Teslimat islem bedeli',
}

const money = (value: number) =>
  Number(value || 0).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const moneyOrDash = (value: number | null | undefined) =>
  value === null || value === undefined ? '-' : `${money(value)} TL`

const orderStatusLabel: Record<string, string> = {
  NEW: 'Yeni',
  PENDING_APPROVAL: 'Onay Bekliyor',
  PREPARING: 'Hazirlaniyor',
  LABEL_CREATED: 'Etiket',
  SHIPPED: 'Kargoda',
  IN_TRANSIT: 'Yolda',
  DELIVERED: 'Teslim',
  COMPLETED: 'Tamamlandi',
  CANCELLED: 'Iptal',
  CANCELLATION_REQUESTED: 'Iptal Talebi',
  RETURN_REQUESTED: 'Iade Talebi',
  RETURN_APPROVED: 'Iade Onayli',
  RETURN_REJECTED: 'Iade Red',
  REFUNDED: 'Iade Edildi',
  DELIVERY_FAILED: 'Teslim Edilemedi',
}

const nonRevenueStatuses = new Set([
  'CANCELLED',
  'CANCELLATION_REQUESTED',
  'RETURN_REQUESTED',
  'RETURN_APPROVED',
  'REFUNDED',
  'DELIVERY_FAILED',
])

const orderStatusClass = (status: string) =>
  nonRevenueStatuses.has(status)
    ? 'border-red-800 bg-red-950/50 text-red-200'
    : status === 'COMPLETED' || status === 'DELIVERED'
      ? 'border-green-800 bg-green-950/50 text-green-200'
      : 'border-blue-800 bg-blue-950/50 text-blue-200'

const todayInput = () => new Date().toISOString().slice(0, 10)
const monthStartInput = () => {
  const date = new Date()
  date.setDate(1)
  return date.toISOString().slice(0, 10)
}

export default function FinancePage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [marketplace, setMarketplace] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [startDate, setStartDate] = useState(monthStartInput())
  const [endDate, setEndDate] = useState(todayInput())
  const [cargoInvoiceNo, setCargoInvoiceNo] = useState('')
  const [cargoPreview, setCargoPreview] = useState<CargoInvoicePreview['data'] | null>(null)
  const [cargoMessage, setCargoMessage] = useState('')
  const [editingItem, setEditingItem] = useState<FinanceItem | null>(null)
  const [feeForm, setFeeForm] = useState({
    manualPurchasePrice: '',
    shipping: '0',
    service: '0',
    extra: '0',
  })
  const [feeMessage, setFeeMessage] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const stopSync = useRef(false)

  const { data: sources } = useQuery<{ data: XmlSource[] }>({
    queryKey: ['sources'],
    queryFn: () => api.get('/sources').then(r => r.data),
  })

  const { data, isLoading, isError } = useQuery<FinanceResponse>({
    queryKey: ['finance-overview', page, pageSize, marketplace, sourceId, startDate, endDate],
    queryFn: () =>
      api.get('/finance/overview', {
        params: {
          page,
          limit: pageSize,
          marketplace: marketplace || undefined,
          sourceId: sourceId || undefined,
          startDate,
          endDate,
        },
      }).then(r => r.data),
  })

  const previewCargoInvoice = useMutation({
    mutationFn: (invoiceNo: string) =>
      api.get<CargoInvoicePreview>(`/finance/trendyol/cargo-invoice/${encodeURIComponent(invoiceNo)}/items`)
        .then(r => r.data.data),
    onSuccess: result => {
      setCargoPreview(result)
      setCargoMessage(`${result.summary.count} kargo fatura kalemi bulundu. Toplam ${money(result.summary.amount)} TL.`)
    },
    onError: () => {
      setCargoPreview(null)
      setCargoMessage('Kargo faturasi alinamadi')
    },
  })

  const importCargoInvoice = useMutation({
    mutationFn: (invoiceNo: string) =>
      api.post<CargoInvoiceImportResult>(`/finance/trendyol/cargo-invoice/${encodeURIComponent(invoiceNo)}/import`)
        .then(r => r.data.data),
    onSuccess: result => {
      setCargoMessage(`${result.importedItems} kalem okundu, ${result.matchedOrders} siparis eslesti, ${result.updatedItems} urun kalemi guncellendi. Uygulanan kargo: ${money(result.appliedAmount)} TL.`)
      queryClient.invalidateQueries({ queryKey: ['finance-overview'] })
    },
    onError: () => {
      setCargoMessage('Kargo faturasi finans kayitlarina islenemedi')
    },
  })

  const updateFees = useMutation({
    mutationFn: ({ itemId, values }: { itemId: string; values: typeof feeForm }) =>
      api.put(`/finance/items/${itemId}/fees`, {
        manualPurchasePrice: values.manualPurchasePrice === '' ? null : values.manualPurchasePrice,
        shipping: values.shipping,
        service: values.service,
        extra: values.extra,
      }).then(r => r.data),
    onSuccess: () => {
      setFeeMessage('Finans kalemi guncellendi')
      setEditingItem(null)
      queryClient.invalidateQueries({ queryKey: ['finance-overview'] })
    },
    onError: () => {
      setFeeMessage('Finans kalemi guncellenemedi')
    },
  })

  const total = data?.data.meta.total ?? 0
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const summary = data?.data.summary

  const handlePageSize = (value: string) => {
    setPageSize(Number(value))
    setPage(1)
  }

  const openFeeEditor = (item: FinanceItem) => {
    setEditingItem(item)
    setFeeForm({
      manualPurchasePrice: item.manualPurchasePrice === null ? '' : String(item.manualPurchasePrice),
      shipping: String(item.manualFees.shipping),
      service: String(item.manualFees.service),
      extra: String(item.manualFees.extra),
    })
    setFeeMessage('')
  }

  const syncAccounting = async () => {
    const targets = data?.data.syncTargets ?? []
    if (syncing || !targets.length) return
    setSyncing(true)
    stopSync.current = false
    let completed = 0
    let failure = ''
    try {
      for (const target of targets) {
        if (stopSync.current) break
        setSyncMessage(`Muhasebe guncelleniyor: ${completed + 1}/${targets.length} | ${target.orderNumber}`)
        try {
          await api.post(`/finance/hepsiburada/orders/${target.orderId}/sync`, {}, { timeout: 240000 })
          completed++
        } catch (error: any) {
          failure = error?.response?.data?.error || 'Baglanti hatasi. Onceki kayitlar korunuyor.'
          break
        }
        await new Promise(resolve => setTimeout(resolve, 1100))
      }
    } finally {
      setSyncing(false)
      setSyncMessage(`${completed}/${targets.length} siparis guncellendi.${failure ? ` ${failure}` : stopSync.current ? ' Durduruldu.' : ''}`)
      queryClient.invalidateQueries({ queryKey: ['finance-overview'] })
    }
  }

  const summaryCards = [
    { label: 'Bugun', value: summary?.today },
    { label: 'Haftalik', value: summary?.week },
    { label: 'Aylik', value: summary?.month },
    { label: 'Secili Aralik', value: summary?.selectedRange },
  ]

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Finans</h1>
      </div>

      <div className="mb-5 grid grid-cols-1 md:grid-cols-4 gap-3">
        {summaryCards.map(card => (
          <div key={card.label} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider">{card.label}</div>
            <div className="mt-3 text-2xl font-bold text-green-400">{money(card.value?.sales ?? 0)} TL</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-400">
              <div>Gecici Kar/Zarar: <span className={(card.value?.profit ?? 0) >= 0 ? 'text-green-300' : 'text-red-300'}>{moneyOrDash(card.value?.profit)}</span></div>
              <div>Kalem: <span className="text-gray-200">{card.value?.orders ?? 0}</span></div>
              <div>Alis: {money(card.value?.purchase ?? 0)}</div>
              <div>Kargo: {money(card.value?.shipping ?? 0)}</div>
              <div>Kesinti: {money(card.value?.service ?? 0)}</div>
              <div>Ek: {money(card.value?.extra ?? 0)}</div>
              <div>Ek gelir: {money(card.value?.additionalIncome ?? 0)}</div>
              <div>HB odenecek net: {money(card.value?.pending ?? 0)}</div>
              <div>HB odenmis net: {money(card.value?.paid ?? 0)}</div>
            </div>
            {(card.value?.missingPurchase ?? 0) > 0 && (
              <div className="mt-2 text-[11px] text-yellow-300">
                {card.value?.missingPurchase} kalemde alis maliyeti yok.
              </div>
            )}
            {(card.value?.incomplete ?? 0) > 0 && <div className="mt-2 text-xs text-yellow-300">{card.value?.incomplete} kalemde muhasebe eksik / kontrol gerekli</div>}
          </div>
        ))}
      </div>

      <div className="mb-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-400">
            Trendyol Kargo Fatura Seri No
            <input
              value={cargoInvoiceNo}
              onChange={e => setCargoInvoiceNo(e.target.value)}
              placeholder="Cari hesap ekstresindeki Id"
              className="mt-1 block w-72 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            />
          </label>
          <button
            onClick={() => cargoInvoiceNo.trim() && previewCargoInvoice.mutate(cargoInvoiceNo.trim())}
            disabled={!cargoInvoiceNo.trim() || previewCargoInvoice.isPending}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm"
          >
            Onizle
          </button>
          <button
            onClick={() => cargoInvoiceNo.trim() && importCargoInvoice.mutate(cargoInvoiceNo.trim())}
            disabled={!cargoInvoiceNo.trim() || importCargoInvoice.isPending}
            className="px-4 py-2 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 text-sm"
          >
            Finansa Isle
          </button>
          {cargoMessage && <div className="text-sm text-gray-300">{cargoMessage}</div>}
        </div>
        {cargoPreview && (
          <div className="mt-3 text-xs text-gray-500">
            Ilk kayit: {cargoPreview.items[0]?.orderNumber ?? '-'} | {cargoPreview.items[0]?.shipmentPackageType ?? '-'} | {money(cargoPreview.items[0]?.amount ?? 0)} TL
          </div>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <label className="text-xs text-gray-400">
          Pazaryeri
          <select
            value={marketplace}
            onChange={e => { setMarketplace(e.target.value); setPage(1) }}
            className="mt-1 block w-44 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          >
            <option value="">Tumu</option>
            {MARKETPLACES.map(mp => <option key={mp} value={mp}>{mp}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-400">
          XML Kaynagi
          <select
            value={sourceId}
            onChange={e => { setSourceId(e.target.value); setPage(1) }}
            className="mt-1 block w-64 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          >
            <option value="">Tumu</option>
            {sources?.data.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-400">
          Baslangic
          <input
            type="date"
            value={startDate}
            onChange={e => { setStartDate(e.target.value); setPage(1) }}
            className="mt-1 block bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs text-gray-400">
          Bitis
          <input
            type="date"
            value={endDate}
            onChange={e => { setEndDate(e.target.value); setPage(1) }}
            className="mt-1 block bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
        </label>
      </div>

      {(!marketplace || marketplace === 'HEPSIBURADA') && <div className="mb-4 flex flex-wrap items-center gap-3">
        <button onClick={syncAccounting} disabled={syncing || !data?.data.syncTargets.length}
          className="rounded bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-50">
          HB Muhasebeyi Guncelle ({data?.data.syncTargets.length ?? 0})
        </button>
        {syncing && <button onClick={() => { stopSync.current = true }} className="rounded bg-gray-800 px-4 py-2 text-sm">Durdur</button>}
        <span role="status" className="text-sm text-gray-400">{syncMessage}</span>
      </div>}
      {isError && <div role="alert" className="mb-4 text-red-300">Finans verileri alinamadi.</div>}

      <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs text-gray-400 uppercase tracking-wider">Urun Bazinda Finans</div>
            <div className="text-xs text-gray-500 mt-0.5">{total} kalem</div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-500">
            <span>Sayfada</span>
            <select
              value={pageSize}
              onChange={e => handlePageSize(e.target.value)}
              className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
            >
              {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
            </select>
            <span>kalem</span>
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
                <th className="text-left px-4 py-3">Siparis</th>
                <th className="text-left px-4 py-3">Urun</th>
                <th className="text-left px-4 py-3">XML</th>
                <th className="text-right px-4 py-3">Alis</th>
                <th className="text-right px-4 py-3">Satis</th>
                <th className="text-right px-4 py-3">Ek Gelir</th>
                <th className="text-right px-4 py-3">Kargo</th>
                <th className="text-right px-4 py-3">Kesinti</th>
                <th className="text-right px-4 py-3">Ek</th>
                <th className="text-right px-4 py-3">Kar/Zarar</th>
                <th className="text-right px-4 py-3">Aksiyon</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={11} className="text-center py-12 text-gray-500">Yukleniyor...</td></tr>
              ) : data?.data.items.length === 0 ? (
                <tr><td colSpan={11} className="text-center py-12 text-gray-500">Finans kalemi yok</td></tr>
              ) : (
                data?.data.items.map(item => (
                  <tr key={item.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-gray-200">{item.orderNo}</div>
                      <div className="text-xs text-gray-500 mt-1">{item.marketplace} | {new Date(item.orderDate).toLocaleDateString('tr-TR')}</div>
                      <span className={`mt-2 inline-flex rounded-full border px-2 py-0.5 text-[11px] ${orderStatusClass(item.orderStatus)}`}>
                        {orderStatusLabel[item.orderStatus] ?? item.orderStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-100 line-clamp-1 max-w-md">{item.title}</div>
                      <div className="text-xs text-gray-500 mt-1">{item.sku ?? '-'} | {item.quantity} adet x {money(item.unitPrice)} TL</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-300">{item.sourceName}</td>
                    <td className="px-4 py-3 text-right text-gray-200 whitespace-nowrap">
                      {item.purchase === null ? '-' : `${money(item.purchase)} TL`}
                      {item.purchasePriceSource !== 'MISSING' && (
                        <div className={`text-[11px] mt-0.5 ${item.purchasePriceSource === 'MANUAL' ? 'text-blue-300' : 'text-gray-500'}`}>
                          {item.purchasePriceSource === 'MANUAL' ? 'Manuel' : 'XML'}
                        </div>
                      )}
                      {item.unitPurchasePrice !== null && item.quantity > 1 && (
                        <div className="text-[11px] text-gray-500 mt-0.5">
                          {item.quantity} x {money(item.unitPurchasePrice)}
                        </div>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right ${item.isRevenueOrder ? 'text-green-300' : 'text-gray-400'}`}>
                      {money(item.sales)}
                      {!item.isRevenueOrder && item.originalSales > 0 && (
                        <div className="text-[11px] text-red-300 mt-0.5">
                          Iade/iptal: brüt {money(item.originalSales)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-green-300">{money(item.additionalIncome)}</td>
                    <td className="px-4 py-3 text-right text-gray-300 whitespace-nowrap">{moneyOrDash(item.shipping)}</td>
                    <td className="px-4 py-3 text-right text-gray-300 whitespace-nowrap">{moneyOrDash(item.service)}</td>
                    <td className="px-4 py-3 text-right text-gray-300 whitespace-nowrap">{moneyOrDash(item.extra)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${item.profit === null ? 'text-gray-500' : item.profit >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                      {moneyOrDash(item.profit)}
                      {item.purchase === null && <div className="text-[11px] text-yellow-300 mt-0.5">Alis yok</div>}
                      <div className="mt-1 text-xs font-normal text-amber-300">{item.accountingStatus === 'REVIEW' ? 'Kontrol gerekli' : 'Gecici hesap'}</div>
                      <div className="mt-1 text-xs font-normal text-gray-400">{accountingLabels[item.accountingStatus]}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openFeeEditor(item)}
                        className="px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-xs text-white"
                      >
                        Duzenle
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-between">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-300 disabled:opacity-40 hover:bg-gray-700"
          >
            Onceki
          </button>
          <div className="text-xs text-gray-500">Sayfa {page} / {lastPage}</div>
          <button
            onClick={() => setPage(p => Math.min(lastPage, p + 1))}
            disabled={page >= lastPage}
            className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-300 disabled:opacity-40 hover:bg-gray-700"
          >
            Sonraki
          </button>
        </div>
      </div>

      {feeMessage && (
        <div className="mt-4 rounded-lg border border-blue-700 bg-blue-950/40 px-4 py-3 text-sm text-blue-100">
          {feeMessage}
        </div>
      )}

      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-950 shadow-2xl">
            <div className="border-b border-gray-800 px-5 py-4">
              <div className="text-lg font-semibold text-white">Finans Kalemi Duzenle</div>
              <div className="mt-1 text-xs text-gray-400">
                Siparis: {editingItem.orderNo} | {editingItem.marketplace}
              </div>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <div className="text-sm font-semibold text-gray-100 line-clamp-2">{editingItem.title}</div>
                <div className="mt-1 text-xs text-gray-500">{editingItem.sku ?? '-'} | {editingItem.sourceName}</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs text-gray-400">
                  Birim Alis Fiyati
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={feeForm.manualPurchasePrice}
                    onChange={e => setFeeForm(form => ({ ...form, manualPurchasePrice: e.target.value }))}
                    placeholder={editingItem.unitPurchasePrice === null ? 'Orn: 125,50' : `XML: ${money(editingItem.unitPurchasePrice)}`}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                  <span className="mt-1 block text-[11px] text-gray-500">
                    Bos birakilirsa XML alis fiyati kullanilir.
                  </span>
                </label>
                <label className="text-xs text-gray-400">
                  Manuel Kargo
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={feeForm.shipping}
                    onChange={e => setFeeForm(form => ({ ...form, shipping: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </label>
                <label className="text-xs text-gray-400">
                  Manuel Pazaryeri Kesintisi
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={feeForm.service}
                    onChange={e => setFeeForm(form => ({ ...form, service: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </label>
                <label className="text-xs text-gray-400">
                  Manuel Ek Ucret
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={feeForm.extra}
                    onChange={e => setFeeForm(form => ({ ...form, extra: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </label>
              </div>
              <div className="border-t border-gray-800 pt-3 text-xs text-gray-300">
                <div className="font-semibold">{accountingLabels[editingItem.accountingStatus]}</div>
                {editingItem.accountingSyncedAt && <div className="mt-1 text-gray-400">Son sorgu: {new Date(editingItem.accountingSyncedAt).toLocaleString('tr-TR')}</div>}
                {editingItem.missingFees.length > 0 && <div className="mt-1 text-amber-300">Kayit beklenen: {editingItem.missingFees.join(', ')}</div>}
                {editingItem.issues.map(issue => <div key={issue} className="mt-1 text-amber-300">{issue}</div>)}
                {editingItem.transactions.length > 0 && <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead><tr><th className="py-2">HB Hareketi</th><th className="py-2 text-right">Tutar</th><th className="px-3 py-2">Durum</th><th className="py-2">Vade</th></tr></thead>
                    <tbody>{editingItem.transactions.map(t => <tr key={t.id} className="border-t border-gray-800">
                      <td className="py-2">{transactionLabels[t.type] ?? t.type}</td>
                      <td className={`py-2 text-right whitespace-nowrap ${t.amount < 0 ? 'text-red-300' : 'text-green-300'}`}>{moneyOrDash(t.amount)}</td>
                      <td className="px-3 py-2">{t.status === 'Paid' ? 'Odenmis' : 'Odenecek'}</td>
                      <td className="py-2 whitespace-nowrap">{t.dueDate ? new Date(t.dueDate).toLocaleDateString('tr-TR') : '-'}</td>
                    </tr>)}</tbody>
                  </table>
                  <div className="mt-3">HB odenecek net: {moneyOrDash(editingItem.pending)} | HB odenmis net: {moneyOrDash(editingItem.paid)}</div>
                </div>}
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-300">
                <div>Satis: <span className="text-green-300">{money(editingItem.sales)} TL</span></div>
                <div>Alis: <span>{moneyOrDash(editingItem.purchase)}</span></div>
                <div>Mevcut kar/zarar: <span className={editingItem.profit !== null && editingItem.profit < 0 ? 'text-red-300' : 'text-green-300'}>{moneyOrDash(editingItem.profit)}</span></div>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-800 px-5 py-4">
              <button
                onClick={() => setEditingItem(null)}
                className="rounded-lg bg-gray-800 px-4 py-2 text-sm text-gray-200 hover:bg-gray-700"
              >
                Iptal
              </button>
              <button
                onClick={() => updateFees.mutate({ itemId: editingItem.id, values: feeForm })}
                disabled={updateFees.isPending}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
              >
                Kaydet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
