import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface PriceRule {
  id: string
  name: string
  marketplace: string
  scopeType: string
  scopeValue: string | null
  priceStart: string | number | null
  priceEnd: string | number | null
  ekTutar: string | number
  karOrani: string | number
  kargo: string | number
  komisyonOrani: string | number
  priority: number
  active: boolean
}

interface SimulateResult {
  ara1BaseEk: number
  ara2Kar: number
  ara3Kargo: number
  rawPrice: number
  finalPrice: number
  minPriceApplied: boolean
}

type RangeRow = {
  id?: string
  start: string
  end: string
  margin: string
}

type FeeSettings = {
  ekTutar: string
  kargo: string
  komisyonOrani: string
}

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']
const RANGE_RULE_PREFIX = 'RANGE_MARGIN'

function parseDecimalInput(value: string): number {
  const parsed = Number(String(value).replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

function marginPercentToMultiplier(value: string): number {
  const percent = parseDecimalInput(value)
  return Math.round((1 + percent / 100) * 10000) / 10000
}

function multiplierToMarginPercent(value: string | number): string {
  const multiplier = Number(value)
  if (!Number.isFinite(multiplier)) return '0'
  return String(Math.round((multiplier - 1) * 10000) / 100)
}

function decimalToPercent(value: string | number): string {
  const decimal = Number(value)
  if (!Number.isFinite(decimal)) return '0'
  return String(Math.round(decimal * 10000) / 100)
}

function percentToDecimal(value: string): number {
  const percent = parseDecimalInput(value)
  return Math.round((percent / 100) * 10000) / 10000
}

function defaultRows(): RangeRow[] {
  return [
    { start: '0', end: '300', margin: '200' },
    { start: '300', end: '1500', margin: '150' },
    { start: '1500', end: '100000', margin: '100' },
  ]
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`h-6 w-11 rounded-full border transition-colors ${checked ? 'border-pink-500 bg-pink-600' : 'border-gray-600 bg-gray-700'}`}
      aria-pressed={checked}
    >
      <span
        className={`block h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

export default function PriceEnginePage() {
  const queryClient = useQueryClient()
  const [marketplace, setMarketplace] = useState('TRENDYOL')
  const [rows, setRows] = useState<RangeRow[]>(defaultRows)
  const [fees, setFees] = useState<FeeSettings>({ ekTutar: '0', kargo: '0', komisyonOrani: '0' })
  const [minimumStock, setMinimumStock] = useState(() => localStorage.getItem('priceEngine.minimumStock') || '6')
  const [settings, setSettings] = useState(() => ({
    priceUpdate: localStorage.getItem('priceEngine.priceUpdate') === 'true',
    stockUpdate: localStorage.getItem('priceEngine.stockUpdate') === 'true',
    onlyPositivePrice: localStorage.getItem('priceEngine.onlyPositivePrice') !== 'false',
    onlyPositiveStock: localStorage.getItem('priceEngine.onlyPositiveStock') !== 'false',
    updateProductInfo: localStorage.getItem('priceEngine.updateProductInfo') === 'true',
    active: localStorage.getItem('priceEngine.active') !== 'false',
  }))
  const [simInput, setSimInput] = useState({
    basePrice: 200,
    ekTutar: 0,
    kargo: 0,
    komisyonOrani: 0,
  })
  const [simResult, setSimResult] = useState<SimulateResult | null>(null)
  const [message, setMessage] = useState('')

  const { data: rulesData, isLoading } = useQuery<{ data: PriceRule[] }>({
    queryKey: ['price-rules'],
    queryFn: () => api.get('/price-rules', { params: { active: true, limit: 500 } }).then(r => r.data),
  })

  const rangeRules = useMemo(() => {
    return (rulesData?.data ?? [])
      .filter(rule => rule.active && rule.marketplace === marketplace && rule.scopeType === 'MARKETPLACE' && rule.name.startsWith(RANGE_RULE_PREFIX))
      .sort((a, b) => Number(a.priceStart ?? 0) - Number(b.priceStart ?? 0))
  }, [rulesData, marketplace])

  useEffect(() => {
    if (rangeRules.length === 0) {
      setRows(defaultRows())
      setFees({ ekTutar: '0', kargo: '0', komisyonOrani: '0' })
      return
    }
    const firstRule = rangeRules[0]
    setRows(rangeRules.map(rule => ({
      id: rule.id,
      start: String(rule.priceStart ?? 0),
      end: String(rule.priceEnd ?? ''),
      margin: multiplierToMarginPercent(rule.karOrani),
    })))
    setFees({
      ekTutar: String(firstRule.ekTutar ?? 0),
      kargo: String(firstRule.kargo ?? 0),
      komisyonOrani: decimalToPercent(firstRule.komisyonOrani),
    })
  }, [rangeRules])

  const simulateMutation = useMutation({
    mutationFn: (input: typeof simInput & { karOrani: number }) =>
      api.post('/price-rules/simulate', input).then(r => r.data),
    onSuccess: data => setSimResult(data.data),
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      for (const [index, row] of rows.entries()) {
        const endValue = parseDecimalInput(row.end)
        const payload: Record<string, unknown> = {
          name: `${RANGE_RULE_PREFIX}_${marketplace}_${index + 1}`,
          marketplace,
          scopeType: 'MARKETPLACE',
          scopeValue: undefined,
          priceStart: parseDecimalInput(row.start),
          ekTutar: parseDecimalInput(fees.ekTutar),
          karOrani: marginPercentToMultiplier(row.margin),
          kargo: parseDecimalInput(fees.kargo),
          komisyonOrani: percentToDecimal(fees.komisyonOrani),
          priority: index + 1,
        }
        if (endValue > 0) payload.priceEnd = endValue
        if (row.id && endValue <= 0) payload.priceEnd = null

        if (row.id) {
          await api.put(`/price-rules/${row.id}`, payload)
        } else {
          await api.post('/price-rules', payload)
        }
      }
      localStorage.setItem('priceEngine.minimumStock', minimumStock)
      Object.entries(settings).forEach(([key, value]) => localStorage.setItem(`priceEngine.${key}`, String(value)))
    },
    onSuccess: () => {
      setMessage('Fiyat araliklari kaydedildi.')
      queryClient.invalidateQueries({ queryKey: ['price-rules'] })
    },
    onError: () => setMessage('Kayit sirasinda hata olustu.'),
  })

  const deleteRowMutation = useMutation({
    mutationFn: async (row: RangeRow) => {
      if (row.id) await api.delete(`/price-rules/${row.id}`)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-rules'] }),
  })

  const updateRow = (index: number, patch: Partial<RangeRow>) => {
    setRows(prev => prev.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))
  }

  const addRow = () => {
    const lastEnd = rows[rows.length - 1]?.end || '0'
    setRows(prev => [...prev, { start: lastEnd, end: '', margin: '100' }])
  }

  const removeRow = (index: number) => {
    const row = rows[index]
    setRows(prev => prev.filter((_, rowIndex) => rowIndex !== index))
    if (row?.id) deleteRowMutation.mutate(row)
  }

  const handleSimulate = () => {
    const matchingRow = rows.find(row => {
      const start = parseDecimalInput(row.start)
      const end = parseDecimalInput(row.end)
      return simInput.basePrice >= start && (end <= 0 || simInput.basePrice < end)
    }) ?? rows[0]
    simulateMutation.mutate({
      ...simInput,
      ekTutar: parseDecimalInput(fees.ekTutar),
      kargo: parseDecimalInput(fees.kargo),
      komisyonOrani: percentToDecimal(fees.komisyonOrani),
      karOrani: marginPercentToMultiplier(matchingRow?.margin ?? '0'),
    })
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Fiyat Motoru</h1>
          <p className="mt-1 text-sm text-gray-400">Fiyat araliklari, kar marji ve aktarim ayarlari</p>
        </div>
        <select
          value={marketplace}
          onChange={e => setMarketplace(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-100"
        >
          {MARKETPLACES.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-gray-800 bg-gray-900 p-5">
          <div className="mb-5 rounded-md bg-pink-700 px-4 py-2 text-center text-sm font-bold text-white">
            Kar Marji (Orn: 10.5 degeri yazildiginda XML urunleri %10.5 kar marji ile aktarilir.)
          </div>

          <div className="grid grid-cols-[1fr_1fr_220px_44px] gap-4 text-sm font-semibold text-gray-300">
            <div>Fiyat Baslangici</div>
            <div>Fiyat Bitisi</div>
            <div>Kar Marji (%)</div>
            <div />
          </div>

          <div className="mt-2 space-y-3">
            {rows.map((row, index) => (
              <div key={`${row.id ?? 'new'}-${index}`} className="grid grid-cols-[1fr_1fr_220px_44px] gap-4">
                <input
                  value={row.start}
                  onChange={e => updateRow(index, { start: e.target.value })}
                  className="rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-gray-100"
                  inputMode="decimal"
                />
                <input
                  value={row.end}
                  onChange={e => updateRow(index, { end: e.target.value })}
                  className="rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-gray-100"
                  inputMode="decimal"
                />
                <div className="flex overflow-hidden rounded-lg border border-gray-700 bg-gray-950">
                  <span className="flex w-12 items-center justify-center border-r border-gray-700 bg-gray-800 text-gray-300">%</span>
                  <input
                    value={row.margin}
                    onChange={e => updateRow(index, { margin: e.target.value })}
                    className="w-full bg-transparent px-4 py-3 text-gray-100 outline-none"
                    inputMode="decimal"
                  />
                </div>
                <button
                  onClick={() => removeRow(index)}
                  className="rounded-lg bg-red-700 text-white hover:bg-red-600 disabled:opacity-40"
                  disabled={rows.length <= 1}
                  title="Satiri sil"
                >
                  x
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={addRow}
            className="mt-4 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            + Aralik Ekle
          </button>

          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-gray-300">Ek Tutar</span>
              <input
                value={fees.ekTutar}
                onChange={e => setFees(prev => ({ ...prev, ekTutar: e.target.value }))}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-gray-100"
                inputMode="decimal"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-gray-300">Kargo</span>
              <input
                value={fees.kargo}
                onChange={e => setFees(prev => ({ ...prev, kargo: e.target.value }))}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-gray-100"
                inputMode="decimal"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-gray-300">Komisyon (%)</span>
              <input
                value={fees.komisyonOrani}
                onChange={e => setFees(prev => ({ ...prev, komisyonOrani: e.target.value }))}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-gray-100"
                inputMode="decimal"
              />
            </label>
          </div>

          <div className="mt-6">
            <label className="text-sm font-semibold text-gray-300">
              Minimum Stok
              <span className="ml-2 font-normal text-gray-500">
                Belirlenen minimum stok altindaki urunler pazaryerine 0 stok olarak aktarilir.
              </span>
            </label>
            <input
              value={minimumStock}
              onChange={e => setMinimumStock(e.target.value)}
              className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-gray-100"
              inputMode="numeric"
            />
          </div>

          <div className="mt-5 space-y-3 rounded-lg border border-gray-800 bg-gray-950 p-4">
            {[
              ['priceUpdate', 'Fiyat Guncelle', 'XML kaynagindaki fiyatlar duzenli araliklarla kontrol edilerek panelinizdeki fiyatlar otomatik guncellenir.'],
              ['stockUpdate', 'Stok Guncelle', 'XML kaynagindaki stoklar duzenli araliklarla kontrol edilerek panelinizdeki stoklar otomatik guncellenir.'],
              ['onlyPositivePrice', "XML'den sadece fiyati 0'dan buyuk urunleri getir."],
              ['onlyPositiveStock', "XML'den sadece stogu 0'dan buyuk urunleri getir."],
              ['updateProductInfo', 'Urun bilgilerini guncelle', 'XML urun bilgisinde degisiklik olursa paneldeki urun bilgileri otomatik guncellenir.'],
              ['active', 'Durum'],
            ].map(item => {
              const [key, label, help] = item
              return (
                <div key={key} className="flex items-start gap-3">
                  <Toggle
                    checked={settings[key as keyof typeof settings]}
                    onChange={checked => setSettings(prev => ({ ...prev, [key]: checked }))}
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-200">{label}</div>
                    {help && <div className="mt-0.5 text-xs leading-5 text-gray-500">{help}</div>}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Kaydediliyor...' : 'Kaydet'}
            </button>
            {message && <span className="text-sm text-gray-300">{message}</span>}
            {isLoading && <span className="text-sm text-gray-500">Kurallar yukleniyor...</span>}
          </div>
        </section>

        <aside className="rounded-lg border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4 text-sm font-bold text-gray-200">Canli Simulator</div>
          <div className="space-y-3">
            {[
              ['basePrice', 'Base Fiyat'],
            ].map(([key, label]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-xs text-gray-500">{label}</span>
                <input
                  type="number"
                  step="0.01"
                  value={simInput[key as keyof typeof simInput]}
                  onChange={e => setSimInput(prev => ({ ...prev, [key]: parseDecimalInput(e.target.value) }))}
                  className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100"
                />
              </label>
            ))}
            <div className="rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-gray-400">
              Simulasyon, secili fiyat araligindaki kar marjini ve yukarida kaydedilecek ek tutar, kargo, komisyon ayarlarini kullanir.
            </div>
            <button
              onClick={handleSimulate}
              className="w-full rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Hesapla
            </button>
          </div>

          {simResult && (
            <div className="mt-5 space-y-2 border-t border-gray-800 pt-4 text-sm">
              <div className="flex justify-between text-gray-400"><span>Base + Ek</span><span>{simResult.ara1BaseEk.toFixed(2)} TL</span></div>
              <div className="flex justify-between text-gray-400"><span>Kar sonrasi</span><span>{simResult.ara2Kar.toFixed(2)} TL</span></div>
              <div className="flex justify-between text-gray-400"><span>Kargo sonrasi</span><span>{simResult.ara3Kargo.toFixed(2)} TL</span></div>
              <div className="flex justify-between text-gray-400"><span>Ham fiyat</span><span>{simResult.rawPrice.toFixed(2)} TL</span></div>
              <div className="flex justify-between border-t border-gray-800 pt-3 text-base font-bold text-green-400">
                <span>Final</span>
                <span>{simResult.finalPrice.toFixed(2)} TL</span>
              </div>
              <div className="flex justify-between text-base font-bold text-blue-300">
                <span>Brut Kar</span>
                <span>
                  {(simResult.finalPrice
                    - (simResult.finalPrice * percentToDecimal(fees.komisyonOrani))
                    - parseDecimalInput(fees.kargo)
                    - simInput.basePrice).toFixed(2)} TL
                </span>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
