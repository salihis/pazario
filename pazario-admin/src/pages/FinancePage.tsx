import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface FinanceItem {
  id: string
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
  purchase: number | null
  sales: number
  shipping: number
  service: number
  extra: number
  net: number
  grossProfit: number | null
  profit: number | null
}

interface FinanceSummary {
  orders: number
  sales: number
  purchase: number
  shipping: number
  service: number
  extra: number
  net: number
  profit: number
  missingPurchase: number
}

interface FinanceResponse {
  data: {
    items: FinanceItem[]
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

const money = (value: number) =>
  Number(value || 0).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const moneyOrDash = (value: number | null | undefined) =>
  value === null || value === undefined ? '-' : `${money(value)} TL`

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
  const [feeForm, setFeeForm] = useState({ shipping: '0', service: '0', extra: '0' })
  const [feeMessage, setFeeMessage] = useState('')

  const { data: sources } = useQuery<{ data: XmlSource[] }>({
    queryKey: ['sources'],
    queryFn: () => api.get('/sources').then(r => r.data),
  })

  const { data, isLoading } = useQuery<FinanceResponse>({
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
      shipping: String(item.shipping),
      service: String(item.service),
      extra: String(item.extra),
    })
    setFeeMessage('')
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
        <p className="text-gray-400 text-sm mt-1">Siparis kalemi bazinda satis, kargo, hizmet ve ek ucret takibi</p>
      </div>

      <div className="mb-5 grid grid-cols-1 md:grid-cols-4 gap-3">
        {summaryCards.map(card => (
          <div key={card.label} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider">{card.label}</div>
            <div className="mt-3 text-2xl font-bold text-green-400">{money(card.value?.sales ?? 0)} TL</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-400">
              <div>Kar/Zarar: <span className={(card.value?.profit ?? 0) >= 0 ? 'text-green-300' : 'text-red-300'}>{money(card.value?.profit ?? 0)}</span></div>
              <div>Kalem: <span className="text-gray-200">{card.value?.orders ?? 0}</span></div>
              <div>Alis: {money(card.value?.purchase ?? 0)}</div>
              <div>Kargo: {money(card.value?.shipping ?? 0)}</div>
              <div>Kesinti: {money(card.value?.service ?? 0)}</div>
              <div>Ek: {money(card.value?.extra ?? 0)}</div>
            </div>
            {(card.value?.missingPurchase ?? 0) > 0 && (
              <div className="mt-2 text-[11px] text-yellow-300">
                {card.value?.missingPurchase} kalemde alis maliyeti yok.
              </div>
            )}
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
                <th className="text-right px-4 py-3">Kargo</th>
                <th className="text-right px-4 py-3">Kesinti</th>
                <th className="text-right px-4 py-3">Ek</th>
                <th className="text-right px-4 py-3">Kar/Zarar</th>
                <th className="text-right px-4 py-3">Aksiyon</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="text-center py-12 text-gray-500">Yukleniyor...</td></tr>
              ) : data?.data.items.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-12 text-gray-500">Finans kalemi yok</td></tr>
              ) : (
                data?.data.items.map(item => (
                  <tr key={item.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-gray-200">{item.orderNo}</div>
                      <div className="text-xs text-gray-500 mt-1">{item.marketplace} | {new Date(item.orderDate).toLocaleDateString('tr-TR')}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-100 line-clamp-1 max-w-md">{item.title}</div>
                      <div className="text-xs text-gray-500 mt-1">{item.sku ?? '-'} | {item.quantity} adet x {money(item.unitPrice)} TL</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-300">{item.sourceName}</td>
                    <td className="px-4 py-3 text-right text-gray-200 whitespace-nowrap">
                      {item.purchase === null ? '-' : `${money(item.purchase)} TL`}
                      {item.unitPurchasePrice !== null && item.quantity > 1 && (
                        <div className="text-[11px] text-gray-500 mt-0.5">
                          {item.quantity} x {money(item.unitPurchasePrice)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-green-300">{money(item.sales)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{money(item.shipping)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{money(item.service)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{money(item.extra)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${item.profit === null ? 'text-gray-500' : item.profit >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                      {moneyOrDash(item.profit)}
                      {item.purchase === null && <div className="text-[11px] text-yellow-300 mt-0.5">Alis yok</div>}
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
          <div className="w-full max-w-lg rounded-lg border border-gray-700 bg-gray-950 shadow-2xl">
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs text-gray-400">
                  Kargo
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
                  Pazaryeri Kesintisi
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
                  Ek Ucret
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
