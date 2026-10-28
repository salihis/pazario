import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ImagePlus, Link, RotateCcw, Save, Star, Trash2, Upload, X } from 'lucide-react'
import { api } from '../api/client'

interface MediaData {
  images: string[]; videos: string[]; xmlImages: string[]; manualImages: string[]
  version: number; title: string; sku: string
}
const errorMessage = (error: any) => error?.response?.data?.error || error?.message || 'Islem tamamlanamadi'
const buttonClass = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gray-700 bg-gray-900 text-gray-200 hover:bg-gray-800 disabled:opacity-30'

export default function ProductMediaEditor({ productId, productIds = [], onClose, onSaved }: { productId: string; productIds?: string[]; onClose: () => void; onSaved: () => void }) {
  const [applyGroup, setApplyGroup] = useState(false)
  const [data, setData] = useState<MediaData | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [videos, setVideos] = useState<string[]>([])
  const [kind, setKind] = useState<'image' | 'video'>('image')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const dirty = Boolean(data && (applyGroup || JSON.stringify(data.images) !== JSON.stringify(images) || JSON.stringify(data.videos) !== JSON.stringify(videos)))

  useEffect(() => {
    let active = true
    const focused = document.activeElement as HTMLElement | null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    api.get(`/products/${productId}/media`).then(r => {
      if (active) { setData(r.data.data); setImages(r.data.data.images); setVideos(r.data.data.videos) }
    }).catch(error => { if (active) setMessage(errorMessage(error)) })
    return () => { active = false; document.body.style.overflow = oldOverflow; focused?.focus() }
  }, [productId])

  const close = () => { if (!busy && (!dirty || window.confirm('Kaydedilmeyen medya degisiklikleri iptal edilsin mi?'))) onClose() }
  const add = (value: string, type: 'image' | 'video') => {
    const list = type === 'image' ? images : videos
    if (list.includes(value)) throw new Error('Bu baglanti zaten ekli')
    if (list.length >= (type === 'image' ? 20 : 3)) throw new Error('Medya sayisi sinirina ulasildi')
    if (type === 'image') setImages(old => [...new Set([...old, value])])
    else setVideos(old => [...new Set([...old, value])])
  }
  const addUrl = () => {
    try {
      const parsed = new URL(url.trim())
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('HTTPS baglantisi gerekli')
      if (kind === 'video' && !/\.mp4$/i.test(parsed.pathname)) throw new Error('MP4 video baglantisi gerekli')
      add(url.trim(), kind); setUrl(''); setMessage('')
    } catch (error) { setMessage(errorMessage(error)) }
  }
  const upload = async (file?: File) => {
    if (!file) return
    if (fileInput.current) fileInput.current.value = ''
    const type = file.type === 'video/mp4' ? 'video' : 'image'
    const max = type === 'video' ? 40 : 8
    if (!['image/jpeg', 'image/png', 'video/mp4'].includes(file.type) || file.size > max * 1024 * 1024) {
      setMessage('JPG/PNG en fazla 8 MB, MP4 en fazla 40 MB olabilir'); return
    }
    if ((type === 'image' ? images : videos).length >= (type === 'image' ? 20 : 3)) { setMessage('Medya sayisi sinirina ulasildi'); return }
    setBusy(true); setMessage(''); setProgress(0)
    try {
      const response = await api.post(`/products/${productId}/media/upload`, file, {
        headers: { 'Content-Type': file.type }, timeout: 180000,
        onUploadProgress: e => setProgress(e.total ? Math.round(e.loaded / e.total * 100) : 0),
      })
      add(response.data.data.url, type)
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const save = async () => {
    if (!data) return
    setBusy(true); setMessage(''); setProgress(0)
    try {
      await api.put(`/products/${productId}/media`, { images, videos, version: data.version, ...(applyGroup ? { productIds } : {}) })
      onSaved(); onClose()
    } catch (error) { setMessage(errorMessage(error)) }
    finally { setBusy(false) }
  }
  const move = (index: number, next: number) => setImages(old => {
    const copy = [...old]; [copy[index], copy[next]] = [copy[next], copy[index]]; return copy
  })

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="media-heading"
      onKeyDown={e => {
        if (e.key === 'Escape') close()
        if (e.key === 'Tab') {
          const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), video[controls]')
          if (!nodes?.length) return
          if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes[nodes.length - 1].focus() }
          else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) { e.preventDefault(); nodes[0].focus() }
        }
      }}
      className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-950 text-gray-100 shadow-xl">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-800 p-4">
        <div className="min-w-0"><h2 id="media-heading" className="text-lg font-semibold">Gorseller ve Video</h2>
          <div className="mt-1 break-words text-sm text-gray-400">{data?.title}</div><div className="break-all text-xs text-gray-500">{data?.sku}</div></div>
        <button ref={closeButton} onClick={close} disabled={busy} className={buttonClass} title="Kapat" aria-label="Kapat"><X size={18} /></button>
      </header>
      <div className="min-h-0 overflow-y-auto p-4">
        {!data && !message && <div role="status">Yukleniyor...</div>}
        {data && <>
          {productIds.length > 1 && productIds.length <= 100 && <label className="mb-4 flex items-center gap-2 text-sm text-amber-200">
            <input type="checkbox" checked={applyGroup} disabled={busy} onChange={e => setApplyGroup(e.target.checked)} />
            Gruptaki {productIds.length} varyantin medyasini bu listeyle degistir
          </label>}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,video/mp4" className="hidden" onChange={e => upload(e.target.files?.[0])} />
            <button disabled={busy} onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-2 rounded bg-blue-700 px-3 py-2 text-sm disabled:opacity-40"><Upload size={16} /> Dosya Yukle</button>
            <span className="text-xs text-gray-400">JPG / PNG: 8 MB | MP4: 40 MB</span>
            {busy && <span role="status" className="text-xs text-blue-300">Isleniyor {progress ? `%${progress}` : ''}</span>}
          </div>
          <div className="mb-5 flex flex-wrap gap-2">
            <select aria-label="Medya turu" value={kind} disabled={busy} onChange={e => setKind(e.target.value as 'image' | 'video')} className="rounded border border-gray-700 bg-gray-900 px-2 py-2 text-sm"><option value="image">Gorsel</option><option value="video">Video</option></select>
            <input aria-label="Medya baglantisi" type="url" value={url} disabled={busy} onChange={e => setUrl(e.target.value)} placeholder="https://..." className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm" />
            <button onClick={addUrl} disabled={busy || !url.trim()} title="Baglanti ekle" aria-label="Baglanti ekle" className={buttonClass}><Link size={18} /></button>
          </div>
          <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Gorseller ({images.length}/20)</h3>
            <button onClick={() => setImages(old => [...new Set([...old, ...data.xmlImages])])} disabled={busy} title="XML gorsellerini geri ekle" aria-label="XML gorsellerini geri ekle" className={buttonClass}><RotateCcw size={16} /></button></div>
          {images.length === 0 && <div className="flex items-center gap-2 py-5 text-sm text-gray-500"><ImagePlus size={20} /> Gorsel yok</div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {images.map((image, index) => <div key={image} className="overflow-hidden rounded-lg border border-gray-700">
              <div className="relative aspect-[4/3] bg-white"><img src={image} alt={`Urun gorseli ${index + 1}`} className="h-full w-full object-contain" onError={e => { e.currentTarget.alt = 'Gorsel yuklenemedi' }} />
                <span className="absolute left-2 top-2 rounded bg-gray-950/90 px-2 py-1 text-xs text-white">{index === 0 ? 'Ana gorsel' : index + 1} | {data.xmlImages.includes(image) && !data.manualImages.includes(image) ? 'XML' : 'Manuel'}</span></div>
              <div className="flex items-center justify-between gap-1 p-2">
                <button title="Ana gorsel yap" aria-label={`Gorsel ${index + 1} ana gorsel yap`} className={buttonClass} disabled={busy || index === 0} onClick={() => setImages(old => [image, ...old.filter(v => v !== image)])}><Star size={16} /></button>
                <button title="One tasi" aria-label={`Gorsel ${index + 1} one tasi`} className={buttonClass} disabled={busy || index === 0} onClick={() => move(index, index - 1)}><ArrowUp size={16} /></button>
                <button title="Sona tasi" aria-label={`Gorsel ${index + 1} sona tasi`} className={buttonClass} disabled={busy || index === images.length - 1} onClick={() => move(index, index + 1)}><ArrowDown size={16} /></button>
                <button title="Gorseli kaldir" aria-label={`Gorsel ${index + 1} kaldir`} className={buttonClass} disabled={busy} onClick={() => setImages(old => old.filter(v => v !== image))}><Trash2 size={16} /></button>
              </div>
            </div>)}
          </div>
          <h3 className="mb-3 mt-6 text-sm font-semibold">Videolar ({videos.length}/3)</h3>
          {videos.length === 0 && <div className="text-sm text-gray-500">Video yok</div>}
          {videos.map((video, index) => <div key={video} className="mb-4 border-b border-gray-800 pb-3">
            <div className="mb-2 flex items-center justify-between text-xs text-gray-400"><span>{index === 0 ? 'Ana video' : `Video ${index + 1}`}</span>
              <div className="flex gap-2"><button title="Ana video yap" aria-label={`Video ${index + 1} ana video yap`} disabled={busy || index === 0} className={buttonClass} onClick={() => setVideos(old => [video, ...old.filter(v => v !== video)])}><Star size={16} /></button>
              <button title="Videoyu kaldir" aria-label={`Video ${index + 1} kaldir`} disabled={busy} className={buttonClass} onClick={() => setVideos(old => old.filter(v => v !== video))}><Trash2 size={16} /></button></div></div>
            <video controls preload="metadata" src={video} className="aspect-video w-full max-w-lg bg-black" />
          </div>)}
        </>}
        {message && <div role="alert" className="mt-4 break-words text-sm text-red-300">{message}</div>}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-gray-800 p-4">
        <button disabled={busy} onClick={close} className="rounded bg-gray-800 px-4 py-2 text-sm">Iptal</button>
        <button disabled={busy || !data || !dirty} onClick={save} className="inline-flex items-center gap-2 rounded bg-blue-700 px-4 py-2 text-sm disabled:opacity-40"><Save size={16} /> Kaydet</button>
      </footer>
    </div>
  </div>
}
