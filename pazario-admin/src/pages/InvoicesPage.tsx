import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

type Invoice = { id: string; status: string; invoiceNumber: string | null; issuedAt: string | null; approvedFileName: string | null; marketplaceMessage: string | null; marketplaceSentAt: string | null }
type Order = { id: string; marketplace: string; marketplaceOrderId: string; marketplaceOrderNo: string | null; customerName: string | null; totalAmount: number; orderedAt: string | null; createdAt: string; invoice: Invoice | null }
type Profile = { companyName: string; address: string; phone: string | null; fax: string | null; website: string | null; email: string | null; taxOffice: string | null; taxNumber: string | null; defaultVatRate: number; invoicePrefix: string }
const emptyProfile: Profile = { companyName: '', address: '', phone: '', fax: '', website: '', email: '', taxOffice: '', taxNumber: '', defaultVatRate: 20, invoicePrefix: 'GIB' }
const labels: Record<string, string> = { DRAFT: 'Taslak', GENERATED: 'Taslak Oluşturuldu', APPROVED: 'Onaylı PDF', SENT: 'Gönderildi', FAILED: 'Hatalı' }

function downloadBlob(data: Blob, name: string) {
  const url = URL.createObjectURL(data); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url)
}

export default function InvoicesPage() {
  const queryClient = useQueryClient(); const [profileForm, setProfileForm] = useState<Profile | null>(null)
  const [marketplace, setMarketplace] = useState(''); const [status, setStatus] = useState(''); const [search, setSearch] = useState(''); const [message, setMessage] = useState('')
  const { data: profileData } = useQuery<{ data: Profile }>({ queryKey: ['invoice-profile'], queryFn: () => api.get('/invoices/profile').then(r => r.data) })
  const form = profileForm || profileData?.data || emptyProfile
  const { data, isLoading } = useQuery<{ data: Order[]; meta: { total: number } }>({ queryKey: ['invoices', marketplace, status, search], queryFn: () => api.get('/invoices', { params: { marketplace: marketplace || undefined, status: status || undefined, search: search || undefined, limit: 100 } }).then(r => r.data) })
  const rows = data?.data || []
  const updateField = (key: keyof Profile, value: string | number) => setProfileForm({ ...form, [key]: value })
  const profileMutation = useMutation({ mutationFn: () => api.put('/invoices/profile', form), onSuccess: () => { setMessage('Fatura profili kaydedildi.'); setProfileForm(null); queryClient.invalidateQueries({ queryKey: ['invoice-profile'] }) }, onError: (e: any) => setMessage(e.response?.data?.error || 'Profil kaydedilemedi') })
  const uploadMutation = useMutation({ mutationFn: ({ orderId, file }: { orderId: string; file: File }) => api.put(`/orders/${orderId}/invoice/approved-file`, file, { params: { fileName: file.name }, headers: { 'Content-Type': 'application/pdf' } }), onSuccess: () => { setMessage('Onaylı fatura yüklendi.'); queryClient.invalidateQueries({ queryKey: ['invoices'] }) }, onError: (e: any) => setMessage(e.response?.data?.error || 'Fatura yüklenemedi') })
  const sendMutation = useMutation({ mutationFn: (id: string) => api.post(`/invoices/${id}/send-marketplace`), onSuccess: () => { setMessage('Fatura pazaryerine aktarıldı.'); queryClient.invalidateQueries({ queryKey: ['invoices'] }) }, onError: (e: any) => { setMessage(e.response?.data?.error || 'Fatura aktarılamadı'); queryClient.invalidateQueries({ queryKey: ['invoices'] }) } })
  const draft = async (order: Order) => { try { await api.post(`/orders/${order.id}/invoice/draft`, {}); const response = await api.get(`/orders/${order.id}/invoice/draft.pdf`, { responseType: 'blob' }); downloadBlob(response.data, `taslak-${order.marketplaceOrderNo || order.marketplaceOrderId}.pdf`); queryClient.invalidateQueries({ queryKey: ['invoices'] }) } catch (e: any) { setMessage(e.response?.data?.error || 'Taslak oluşturulamadı') } }
  const approved = async (invoice: Invoice) => { const response = await api.get(`/invoices/${invoice.id}/approved.pdf`, { responseType: 'blob' }); downloadBlob(response.data, invoice.approvedFileName || 'onayli-fatura.pdf') }

  return <div className="p-6 space-y-5">
    <div><h1 className="text-2xl font-bold">Faturalar</h1><p className="text-sm text-gray-500 mt-1">Taslak oluşturun, onaylı faturayı yükleyin ve pazaryerine aktarın.</p></div>
    {message && <div className="border border-[#d6c58f] bg-white/70 rounded-lg px-4 py-3 text-sm">{message}</div>}
    <section className="border border-[#d6c58f] bg-white/55 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3"><h2 className="font-bold">Fatura Profili</h2><button onClick={() => profileMutation.mutate()} className="bg-[#0d3b3c] text-white px-4 py-2 rounded-md text-sm">Profili Kaydet</button></div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {([['companyName','Firma Unvanı'],['taxOffice','Vergi Dairesi'],['taxNumber','TCKN / VKN'],['phone','Telefon'],['email','E-posta'],['website','Web Sitesi'],['invoicePrefix','Fatura Ön Eki']] as [keyof Profile,string][]).map(([key,label]) => <label key={key} className="text-xs text-gray-600">{label}<input value={String(form[key] ?? '')} onChange={e => updateField(key,e.target.value)} className="mt-1 w-full bg-[#111827] text-white border border-gray-700 rounded-md px-3 py-2" /></label>)}
        <label className="text-xs text-gray-600">Varsayılan KDV<input type="number" value={form.defaultVatRate} onChange={e => updateField('defaultVatRate', Number(e.target.value))} className="mt-1 w-full bg-[#111827] text-white border border-gray-700 rounded-md px-3 py-2" /></label>
        <label className="text-xs text-gray-600 md:col-span-4">Adres<textarea value={form.address} onChange={e => updateField('address',e.target.value)} className="mt-1 w-full bg-[#111827] text-white border border-gray-700 rounded-md px-3 py-2 min-h-20" /></label>
      </div>
    </section>
    <div className="flex flex-wrap gap-3">
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Sipariş no ara" className="bg-[#111827] text-white border border-gray-700 rounded-md px-3 py-2" />
      <select value={marketplace} onChange={e => setMarketplace(e.target.value)} className="bg-[#111827] text-white border border-gray-700 rounded-md px-3 py-2"><option value="">Tüm Pazaryerleri</option>{['TRENDYOL','HEPSIBURADA','N11','PAZARAMA'].map(v => <option key={v}>{v}</option>)}</select>
      <select value={status} onChange={e => setStatus(e.target.value)} className="bg-[#111827] text-white border border-gray-700 rounded-md px-3 py-2"><option value="">Tüm Durumlar</option>{Object.entries(labels).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
      <span className="self-center text-sm text-gray-500">{data?.meta.total || 0} sipariş</span>
    </div>
    <div className="bg-[#111827] text-white rounded-lg overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 border-b border-gray-700"><th className="p-3">Sipariş</th><th className="p-3">Pazaryeri</th><th className="p-3">Müşteri</th><th className="p-3 text-right">Tutar</th><th className="p-3">Fatura</th><th className="p-3">İşlemler</th></tr></thead><tbody>
      {isLoading ? <tr><td colSpan={6} className="p-10 text-center text-gray-500">Yükleniyor...</td></tr> : rows.map(order => <tr key={order.id} className="border-b border-gray-800"><td className="p-3"><div>{order.marketplaceOrderNo || order.marketplaceOrderId}</div><div className="text-xs text-gray-500">{new Date(order.orderedAt || order.createdAt).toLocaleDateString('tr-TR')}</div></td><td className="p-3">{order.marketplace}</td><td className="p-3">{order.customerName || 'Bilgi yok'}</td><td className="p-3 text-right text-emerald-400">{Number(order.totalAmount).toLocaleString('tr-TR',{minimumFractionDigits:2})} TL</td><td className="p-3"><span className="rounded-full bg-gray-700 px-2 py-1 text-xs">{order.invoice ? labels[order.invoice.status] || order.invoice.status : 'Fatura yok'}</span>{order.invoice?.marketplaceMessage && <div className="text-xs text-gray-500 mt-1 max-w-52">{order.invoice.marketplaceMessage}</div>}</td><td className="p-3"><div className="flex flex-wrap gap-2"><button onClick={() => draft(order)} className="bg-blue-700 px-3 py-1.5 rounded">Taslak PDF</button><label className="bg-amber-700 px-3 py-1.5 rounded cursor-pointer">Fatura Yükle<input type="file" accept="application/pdf" className="hidden" onChange={e => { const file=e.target.files?.[0]; if(file) uploadMutation.mutate({orderId:order.id,file}); e.currentTarget.value='' }} /></label>{order.invoice?.approvedFileName && <button onClick={() => approved(order.invoice!)} className="bg-gray-700 px-3 py-1.5 rounded">Onaylı PDF</button>}{order.invoice && ['APPROVED','FAILED'].includes(order.invoice.status) && <button onClick={() => sendMutation.mutate(order.invoice!.id)} className="bg-emerald-700 px-3 py-1.5 rounded">Pazaryerine Gönder</button>}</div></td></tr>)}
      {!isLoading && rows.length===0 && <tr><td colSpan={6} className="p-10 text-center text-gray-500">Sipariş bulunamadı</td></tr>}
    </tbody></table></div>
    <p className="text-xs text-amber-800">Taslak PDF kontrol amaçlıdır. Mali açıdan geçerli fatura, dış sistemde onaylandıktan sonra PDF olarak yüklenmelidir.</p>
  </div>
}
