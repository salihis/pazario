import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

type Marketplace = 'TRENDYOL' | 'PAZARAMA' | 'N11' | 'HEPSIBURADA'

interface MarketplaceCredential {
  id: string
  marketplace: Marketplace
  name: string
  isActive: boolean
  credentialStatus: Record<string, boolean>
  lastTestStatus: 'SUCCESS' | 'FAILED' | null
  lastTestMessage: string | null
  lastTestAt: string | null
}

type CredentialForm = {
  id?: string
  name: string
  isActive: boolean
  credentials: Record<string, string>
}

const MASK_VALUE = '********'

const MARKETPLACE_CONFIG: Array<{
  marketplace: Marketplace
  title: string
  fields: Array<{ key: string; label: string; secret?: boolean }>
}> = [
  {
    marketplace: 'TRENDYOL',
    title: 'Trendyol',
    fields: [
      { key: 'supplierId', label: 'Supplier ID' },
      { key: 'apiKey', label: 'API Key', secret: true },
      { key: 'apiSecret', label: 'API Secret', secret: true },
    ],
  },
  {
    marketplace: 'PAZARAMA',
    title: 'Pazarama',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: true },
      { key: 'clientSecret', label: 'Client Secret', secret: true },
    ],
  },
  {
    marketplace: 'N11',
    title: 'N11',
    fields: [
      { key: 'appKey', label: 'App Key', secret: true },
      { key: 'appSecret', label: 'App Secret', secret: true },
    ],
  },
  {
    marketplace: 'HEPSIBURADA',
    title: 'Hepsiburada',
    fields: [
      { key: 'merchantId', label: 'Merchant ID' },
      { key: 'serviceKey', label: 'Service Key', secret: true },
    ],
  },
]

const emptyForm = (marketplace: Marketplace, title: string): CredentialForm => ({
  name: title,
  isActive: false,
  credentials: Object.fromEntries(
    MARKETPLACE_CONFIG.find(item => item.marketplace === marketplace)?.fields.map(field => [field.key, '']) ?? []
  ),
})

function formFromCredential(config: typeof MARKETPLACE_CONFIG[number], credential?: MarketplaceCredential): CredentialForm {
  if (!credential) return emptyForm(config.marketplace, config.title)

  return {
    id: credential.id,
    name: credential.name,
    isActive: credential.isActive,
    credentials: Object.fromEntries(
      config.fields.map(field => [
        field.key,
        credential.credentialStatus[field.key] ? MASK_VALUE : '',
      ])
    ),
  }
}

const testBadgeClass = (status: string | null) => {
  if (status === 'SUCCESS') return 'border-green-800 bg-green-950/40 text-green-200'
  if (status === 'FAILED') return 'border-red-800 bg-red-950/40 text-red-200'
  return 'border-gray-800 bg-gray-950 text-gray-400'
}

export default function MarketplaceSettingsPage() {
  const queryClient = useQueryClient()
  const [forms, setForms] = useState<Record<Marketplace, CredentialForm>>(() =>
    Object.fromEntries(
      MARKETPLACE_CONFIG.map(config => [config.marketplace, emptyForm(config.marketplace, config.title)])
    ) as Record<Marketplace, CredentialForm>
  )
  const [message, setMessage] = useState('')

  const { data, isLoading } = useQuery<{ data: MarketplaceCredential[] }>({
    queryKey: ['marketplace-credentials'],
    queryFn: () => api.get('/marketplace-credentials').then(r => r.data),
  })

  const credentialsByMarketplace = useMemo(() => {
    return new Map((data?.data ?? []).map(item => [item.marketplace, item]))
  }, [data?.data])

  useEffect(() => {
    if (!data?.data) return

    setForms(
      Object.fromEntries(
        MARKETPLACE_CONFIG.map(config => [
          config.marketplace,
          formFromCredential(config, credentialsByMarketplace.get(config.marketplace)),
        ])
      ) as Record<Marketplace, CredentialForm>
    )
  }, [credentialsByMarketplace, data?.data])

  const saveCredential = useMutation({
    mutationFn: ({ marketplace, form }: { marketplace: Marketplace; form: CredentialForm }) => {
      const payload = {
        marketplace,
        name: form.name,
        isActive: form.isActive,
        credentials: form.credentials,
      }

      return form.id
        ? api.put(`/marketplace-credentials/${form.id}`, payload).then(r => r.data)
        : api.post('/marketplace-credentials', payload).then(r => r.data)
    },
    onSuccess: (_result, variables) => {
      setMessage(`${variables.marketplace} API bilgileri kaydedildi`)
      queryClient.invalidateQueries({ queryKey: ['marketplace-credentials'] })
    },
    onError: (error: any) => {
      setMessage(error?.response?.data?.error || 'API bilgileri kaydedilemedi')
    },
  })

  const testCredential = useMutation({
    mutationFn: (credentialId: string) =>
      api.post(`/marketplace-credentials/${credentialId}/test`).then(r => r.data),
    onSuccess: () => {
      setMessage('Baglanti testi tamamlandi')
      queryClient.invalidateQueries({ queryKey: ['marketplace-credentials'] })
    },
    onError: (error: any) => {
      setMessage(error?.response?.data?.error || 'Baglanti testi calistirilamadi')
    },
  })

  const deleteCredential = useMutation({
    mutationFn: (credentialId: string) =>
      api.delete(`/marketplace-credentials/${credentialId}`).then(r => r.data),
    onSuccess: () => {
      setMessage('API bilgileri silindi')
      queryClient.invalidateQueries({ queryKey: ['marketplace-credentials'] })
    },
    onError: () => {
      setMessage('API bilgileri silinemedi')
    },
  })

  const updateForm = (marketplace: Marketplace, updater: (form: CredentialForm) => CredentialForm) => {
    setForms(current => ({
      ...current,
      [marketplace]: updater(current[marketplace]),
    }))
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Pazaryeri Ayarlari</h1>
          <p className="mt-1 text-sm text-gray-400">API bilgileri sifreli saklanir, aktiflik ve baglanti testi buradan yonetilir</p>
        </div>
        {isLoading && <div className="text-sm text-gray-500">Yukleniyor...</div>}
      </div>

      {message && (
        <div className="mb-5 rounded-lg border border-blue-800 bg-blue-950/40 px-4 py-3 text-sm text-blue-100">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {MARKETPLACE_CONFIG.map(config => {
          const form = forms[config.marketplace]
          const credential = credentialsByMarketplace.get(config.marketplace)
          const isSaving = saveCredential.isPending
          const isTesting = testCredential.isPending

          return (
            <section key={config.marketplace} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-100">{config.title}</h2>
                  <div className="mt-1 text-xs text-gray-500">{config.marketplace}</div>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
                  <span>{form.isActive ? 'Aktif' : 'Pasif'}</span>
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={e => updateForm(config.marketplace, current => ({ ...current, isActive: e.target.checked }))}
                    className="sr-only"
                  />
                  <span className={`relative h-6 w-11 rounded-full transition-colors ${form.isActive ? 'bg-green-600' : 'bg-gray-700'}`}>
                    <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${form.isActive ? 'translate-x-6' : 'translate-x-1'}`} />
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-xs text-gray-400 md:col-span-2">
                  Kayit Adi
                  <input
                    value={form.name}
                    onChange={e => updateForm(config.marketplace, current => ({ ...current, name: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  />
                </label>

                {config.fields.map(field => (
                  <label key={field.key} className="text-xs text-gray-400">
                    {field.label}
                    <input
                      type={field.secret ? 'password' : 'text'}
                      value={form.credentials[field.key] ?? ''}
                      placeholder={credential?.credentialStatus[field.key] ? MASK_VALUE : ''}
                      onChange={e => updateForm(config.marketplace, current => ({
                        ...current,
                        credentials: {
                          ...current.credentials,
                          [field.key]: e.target.value,
                        },
                      }))}
                      className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                  </label>
                ))}
              </div>

              <div className={`mt-4 rounded-lg border px-3 py-2 text-xs ${testBadgeClass(credential?.lastTestStatus ?? null)}`}>
                <div className="font-medium">
                  Son test: {credential?.lastTestStatus === 'SUCCESS' ? 'Basarili' : credential?.lastTestStatus === 'FAILED' ? 'Basarisiz' : 'Test yok'}
                </div>
                <div className="mt-1 text-gray-400">
                  {credential?.lastTestMessage ?? 'Henuz baglanti testi calistirilmadi'}
                  {credential?.lastTestAt ? ` | ${new Date(credential.lastTestAt).toLocaleString('tr-TR')}` : ''}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 pt-4">
                <div className="flex gap-2">
                  <button
                    onClick={() => saveCredential.mutate({ marketplace: config.marketplace, form })}
                    disabled={isSaving}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                  >
                    {isSaving ? 'Kaydediliyor...' : 'Kaydet'}
                  </button>
                  <button
                    onClick={() => form.id && testCredential.mutate(form.id)}
                    disabled={!form.id || isTesting}
                    className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white transition-colors hover:bg-gray-600 disabled:opacity-50"
                  >
                    {isTesting ? 'Test ediliyor...' : 'Test Et'}
                  </button>
                </div>
                {form.id && (
                  <button
                    onClick={() => form.id && deleteCredential.mutate(form.id)}
                    disabled={deleteCredential.isPending}
                    className="rounded-lg bg-red-950 px-3 py-2 text-xs text-red-200 transition-colors hover:bg-red-900 disabled:opacity-50"
                  >
                    Sil
                  </button>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
