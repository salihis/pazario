import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface PriceRule {
  id: string
  name: string
  marketplace: string
  scopeType: string
  scopeValue: string | null
  ekTutar: number
  karOrani: number
  kargo: number
  komisyonOrani: number
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

const SCOPE_TYPES = ['GLOBAL', 'MARKETPLACE', 'CATEGORY', 'BRAND', 'PRODUCT']
const MARKETPLACES = ['*', 'TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

export default function PriceEnginePage() {
  const queryClient = useQueryClient()

  const [simInput, setSimInput] = useState({
    basePrice: 200,
    ekTutar: 10,
    karOrani: 1.25,
    kargo: 15,
    komisyonOrani: 0.15,
  })
  const [simResult, setSimResult] = useState<SimulateResult | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    marketplace: '*',
    scopeType: 'GLOBAL',
    scopeValue: '',
    ekTutar: 0,
    karOrani: 1.0,
    kargo: 0,
    komisyonOrani: 0.1,
    priority: 10,
  })
  const [formError, setFormError] = useState('')

  const { data, isLoading } = useQuery<{ data: PriceRule[] }>({
    queryKey: ['price-rules'],
    queryFn: () => api.get('/price-rules', { params: { active: true, limit: 100 } }).then(r => r.data),
  })

  const { data: settings } = useQuery<{ data: { minPrice: number; currency: string } }>({
    queryKey: ['price-settings'],
    queryFn: () => api.get('/price-settings').then(r => r.data),
  })

  const simulateMutation = useMutation({
    mutationFn: (input: typeof simInput) => api.post('/price-rules/simulate', input).then(r => r.data),
    onSuccess: (data) => setSimResult(data.data),
  })

  const createMutation = useMutation({
    mutationFn: (data: typeof formData) => api.post('/price-rules', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['price-rules'] })
      setShowForm(false)
      setFormError('')
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { details?: { message: string }[] } } }
      setFormError(err.response?.data?.details?.[0]?.message ?? 'Hata olustu')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/price-rules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-rules'] }),
  })

  const updateSettingsMutation = useMutation({
    mutationFn: (minPrice: number) => api.put('/price-settings', { minPrice }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-settings'] }),
  })

  const handleSimulate = () => simulateMutation.mutate(simInput)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Fiyat Motoru</h1>
          <p className="text-gray-400 text-sm mt-1">Fiyat kurallari ve simulasyon</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + Yeni Kural
        </button>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Kural Listesi */}
        <div className="col-span-2 space-y-4">
          {/* Global Min Fiyat */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-gray-200">Global Minimum Fiyat</div>
                <div className="text-xs text-gray-500 mt-0.5">Hicbir urun bu fiyatin altinda satilamaz</div>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  defaultValue={settings?.data.minPrice ?? 50}
                  onBlur={e => updateSettingsMutation.mutate(parseFloat(e.target.value))}
                  className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-right text-gray-100 focus:outline-none focus:border-blue-500"
                />
                <span className="text-sm text-gray-400">TL</span>
              </div>
            </div>
          </div>

          {/* Kurallar */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <span className="text-xs text-gray-400 uppercase tracking-wider">Fiyat Kurallari</span>
              <span className="text-xs text-gray-500">{data?.data.length ?? 0} kural</span>
            </div>
            {isLoading ? (
              <div className="p-8 text-center text-gray-500">Yukleniyor...</div>
            ) : data?.data.length === 0 ? (
              <div className="p-8 text-center text-gray-500">Henuz kural yok</div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data?.data.map(rule => (
                  <div key={rule.id} className="px-4 py-3 flex items-center gap-4">
                    <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center text-xs text-gray-400 font-mono flex-shrink-0">
                      {rule.priority}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-200">{rule.name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-500">{rule.scopeType}</span>
                        {rule.scopeValue && (
                          <span className="text-xs text-gray-600">• {rule.scopeValue}</span>
                        )}
                        <span className="text-xs text-gray-600">•</span>
                        <span className="text-xs text-gray-500">
                          {rule.marketplace === '*' ? 'Tum pazaryerleri' : rule.marketplace}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400 flex-shrink-0">
                      <div className="text-right">
                        <div className="text-gray-500">Kar</div>
                        <div className="text-gray-200">x{Number(rule.karOrani).toFixed(2)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-gray-500">Kom</div>
                        <div className="text-gray-200">%{Math.round(Number(rule.komisyonOrani) * 100)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-gray-500">Kargo</div>
                        <div className="text-gray-200">{Number(rule.kargo).toFixed(0)} TL</div>
                      </div>
                    </div>
                    <button
                      onClick={() => deleteMutation.mutate(rule.id)}
                      className="text-red-500 hover:text-red-400 text-xs ml-2 flex-shrink-0"
                    >
                      Sil
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Simulatör */}
        <div className="space-y-4">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <div className="text-sm font-bold text-gray-200 mb-4">Canli Simulatör</div>
            <div className="space-y-3">
              {[
                { key: 'basePrice', label: 'Base Fiyat', step: 1 },
                { key: 'ekTutar', label: 'Ek Tutar', step: 1 },
                { key: 'karOrani', label: 'Kar Orani', step: 0.01 },
                { key: 'kargo', label: 'Kargo', step: 1 },
                { key: 'komisyonOrani', label: 'Komisyon', step: 0.01 },
              ].map(field => (
                <div key={field.key}>
                  <label className="text-xs text-gray-500 block mb-1">{field.label}</label>
                  <input
                    type="number"
                    step={field.step}
                    value={simInput[field.key as keyof typeof simInput]}
                    onChange={e => setSimInput(prev => ({ ...prev, [field.key]: parseFloat(e.target.value) || 0 }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
              ))}
              <button
                onClick={handleSimulate}
                disabled={simulateMutation.isPending}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {simulateMutation.isPending ? 'Hesaplaniyor...' : 'Hesapla'}
              </button>
            </div>

            {simResult && (
              <div className="mt-4 space-y-2 border-t border-gray-800 pt-4">
                <div className="text-xs text-gray-500 mb-2">Hesaplama Adimlari</div>
                {[
                  { label: 'Base + Ek', value: simResult.ara1BaseEk },
                  { label: 'x Kar', value: simResult.ara2Kar },
                  { label: '+ Kargo', value: simResult.ara3Kargo },
                  { label: 'Ham Fiyat', value: simResult.rawPrice },
                ].map(step => (
                  <div key={step.label} className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">{step.label}</span>
                    <span className="text-gray-300 font-mono">{step.value.toFixed(2)} TL</span>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-2 border-t border-gray-700">
                  <span className="text-sm font-bold text-gray-200">Final Fiyat</span>
                  <span className="text-lg font-bold text-green-400">
                    {simResult.finalPrice.toFixed(2)} TL
                  </span>
                </div>
                {simResult.minPriceApplied && (
                  <div className="text-xs text-yellow-400 text-center">
                    Min fiyat uygulandı
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Yeni Kural Formu */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Yeni Fiyat Kurali</h2>
              <button onClick={() => { setShowForm(false); setFormError('') }} className="text-gray-500 hover:text-gray-300">X</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Kural Adi</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Pazaryeri</label>
                  <select
                    value={formData.marketplace}
                    onChange={e => setFormData(p => ({ ...p, marketplace: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none"
                  >
                    {MARKETPLACES.map(mp => <option key={mp} value={mp}>{mp === '*' ? 'Tumu' : mp}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Kapsam</label>
                  <select
                    value={formData.scopeType}
                    onChange={e => setFormData(p => ({ ...p, scopeType: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none"
                  >
                    {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { key: 'ekTutar', label: 'Ek Tutar', step: 1 },
                  { key: 'karOrani', label: 'Kar Orani (min 1.0)', step: 0.01 },
                  { key: 'kargo', label: 'Kargo', step: 1 },
                  { key: 'komisyonOrani', label: 'Komisyon (0-0.99)', step: 0.01 },
                  { key: 'priority', label: 'Oncelik', step: 1 },
                ].map(field => (
                  <div key={field.key}>
                    <label className="text-xs text-gray-500 block mb-1">{field.label}</label>
                    <input
                      type="number"
                      step={field.step}
                      value={formData[field.key as keyof typeof formData]}
                      onChange={e => setFormData(p => ({ ...p, [field.key]: parseFloat(e.target.value) || 0 }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                ))}
              </div>
              {formError && <div className="text-red-400 text-xs">{formError}</div>}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => createMutation.mutate(formData)}
                  disabled={createMutation.isPending || !formData.name}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Kaydediliyor...' : 'Kaydet'}
                </button>
                <button
                  onClick={() => { setShowForm(false); setFormError('') }}
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