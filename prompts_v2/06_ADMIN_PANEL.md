# Modül 7 — Admin Panel (Frontend) Promptları

Stack: React Native (Web) veya React + Tailwind CSS
API: Backend REST API (JWT Bearer token)

---

## PROMPT 7.1 — API Client ve Auth Altyapısı

```
src/api/ klasöründe aşağıdaki dosyaları yaz.
Framework: React + TypeScript + TanStack Query v5 + Axios

### src/api/client.ts — Axios Instance

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
})

### Request Interceptor
- localStorage'dan access token oku
- Her isteğe Authorization: Bearer {token} ekle

### Response Interceptor
- HTTP 401 → refresh token dene
  POST /auth/refresh ile yeni token al
  Başarılıysa başarısız isteği tekrar gönder
  Refresh da başarısız → logout() + login sayfasına yönlendir
- HTTP 429 → Retry-After header'ına göre bekle + tekrar dene
- HTTP 5xx → toast('Sunucu hatası') + hata logla

### src/api/auth.ts

interface AuthTokens { accessToken: string; refreshToken: string }
interface User { id: string; name: string; email: string; role: 'SUPER_ADMIN' | 'ADMIN' | 'VIEWER' }

login(email, password): Promise<{ tokens: AuthTokens; user: User }>
verifyMfa(code: string): Promise<AuthTokens>
refresh(refreshToken): Promise<AuthTokens>
logout(): Promise<void>
getMe(): Promise<User>

### src/api/hooks/ — TanStack Query Hooks

useOrders(filters):  useQuery({ queryKey: ['orders', filters], ... })
useOrderDetail(id):  useQuery({ queryKey: ['order', id], ... })
useApproveOrder():   useMutation + onSuccess: invalidate ['orders']
useProducts(filters): useQuery(...)
usePriceRules():     useQuery(...)
useSimulatePrice():  useMutation
useSyncStats():      useQuery({ refetchInterval: 5000 })  // 5sn polling
usePendingCategories(): useQuery(...)
useApproveCategory(): useMutation

### Ortak HTTP Durum İşleme (useApiError hook)
const message = {
  400: (err) => err.response.data.message || 'Geçersiz istek',
  401: () => 'Oturum süresi doldu',
  403: () => 'Bu işlem için yetkiniz yok',
  404: () => 'Kayıt bulunamadı',
  409: () => 'Çakışma — lütfen sayfayı yenileyin',
  429: () => 'Çok fazla istek — lütfen bekleyin',
  500: () => 'Sunucu hatası — ekibimize bildirildi',
}

### Test (Vitest + MSW)
- 401 → token refresh denenmeli
- Refresh başarısız → login'e yönlendirmeli
- 429 → retry sonrası başarılı dönmeli
- getMe() response'dan User parse edilmeli
```

---

## PROMPT 7.2 — Senkronizasyon Ekranı

```
src/pages/SyncPage.tsx bileşenini yaz.

### Tasarım Gereksinimleri
- Tailwind CSS
- Türkçe arayüz
- Responsive (mobil + masaüstü)

### Bileşenler

**SyncStatsBar** — 4 istatistik kartı
  Toplam Ürün | Yayınlanan | Bekleyen | Hata
  Her kart: ikon + sayı + alt başlık
  Veri: GET /sync/jobs?limit=1 + GET /products/stats

**ActiveJobProgress** — Aktif iş ilerleme
  Koşul: aktif job varsa göster
  - Kaynak adı
  - Progress bar: (published / total) * 100
  - Süre: X dakika Y saniye
  - İptal butonu (ADMIN)
  Polling: GET /sync/jobs/:jobId her 5 saniyede bir
  Page Visibility API: sekme arka planda → 30sn polling

**SyncHistoryTable** — Geçmiş işler
  Sütunlar: Tarih | Kaynak | Toplam | Değişen | Yayınlanan | Hata | Süre | Durum
  Status badge: DONE=yeşil, FAILED=kırmızı, RUNNING=sarı (animasyonlu)
  Veri: GET /sync/jobs?limit=10

**SyncTriggerButton** — 'Senkronizasyonu Başlat' butonu
  Tıklandığında: POST /sync/trigger
  Response 202 → jobId al → polling başlat
  Loading state + disabled while running

**PricingPreviewCard** — Fiyat önizleme özeti
  İlk ürün için 4 pazaryeri fiyatı
  Veri: GET /price-rules/preview/{firstProductId}

**CategoryQueueSummary** — Kategori onay kuyruğu özeti
  'X kategori onay bekliyor' uyarısı
  İlk 3 bekleyen — her biri 'Onayla' butonu
  Veri: GET /category-mappings/pending?limit=3

### Test (Vitest + React Testing Library)
- Aktif job varken progress bar görünmeli
- Job tamamlandığında polling durmalı
- 'Senkronizasyonu Başlat' tıklandığında POST çağrılmalı
- Hata durumunda error toast gösterilmeli
```

---

## PROMPT 7.3 — Ürünler Ekranı

```
src/pages/ProductsPage.tsx ve src/components/products/ bileşenlerini yaz.

### ProductsTable Bileşeni
Kolonlar (sırayla):
  [ ] Seç | Görsel | Stok Kodu | Ürün Adı | KDV | Miktar | Satış Fiyatı |
  Üstü Çizili Fiyat | Marka | Kategori | Aktif | Trendyol | HB | N11 | Pazarama

Pazaryeri ikonları:
  Yayında = yeşil ✓ ikon
  Yayında değil = gri - ikon
  Hata = kırmızı ! ikon (tooltip: hata mesajı)

### FilterBar Bileşeni
- Arama input (300ms debounce) → title, sku, barcode
- Pazaryeri dropdown (çoklu seçim)
- Durum dropdown: Tümü | Yayında | Bekleyen | Hata | Stok Yok
- Tarihe göre sıralama (asc/desc)
- 'Filtreleri Temizle' butonu

### ProductDetailModal
Satır tıklandığında açılır:
Sekmeler: Genel Bilgi | Fiyat Detayı | Pazaryeri Durumları | Hata Geçmişi

Fiyat Detayı sekmesi:
  4 pazaryeri için hesaplama adımları göster:
  Base → +Ek Tutar → ×Kar → +Kargo → ÷(1-Kom) = Final
  Veri: GET /price-rules/preview/:productId

### ExportButton
'Excel İndir' → GET /products?export=xlsx
Loading spinner göster, dosya inince spinner kapat

### Toplu İşlemler (seçili ürünler)
- Seçili ürünleri aktif et / pasif et
- Seçili ürünleri zorla yeniden yayınla

### Sayfalama
URL: ?page=1&limit=25
sayfa değişince URL güncellenir (useSearchParams)

### Test
- Arama debounce: 100ms → API çağrılmamalı, 400ms → çağrılmalı
- Pazaryeri filtresi URL'ye yansımalı
- Ürün satırı tıklandığında modal açılmalı
- Excel indirme: download attribute ile link oluşturulmalı
```

---

## PROMPT 7.4 — Fiyat Motoru Ekranı

```
src/pages/PriceEnginePage.tsx bileşenini yaz.

### Layout: İki Panel
Sol: Kural Listesi (60%) | Sağ: Canlı Simülatör (40%)

### RuleList Bileşeni
Her kural satırı:
  Öncelik sırası | Kural Adı | Kapsam | Pazaryeri | Ek Tutar | Kar | Kargo | Kom% | Aktif toggle

Sürükle-bırak ile öncelik sıralama (react-dnd veya dnd-kit)
Satır tıkla → düzenleme drawer açılır

### RuleFormDrawer (Yeni / Düzenle)
Alanlar:
  Kural Adı (zorunlu)
  Kapsam: Global / Pazaryeri / Kategori / Marka / Ürün (dropdown)
  Kapsam Değeri: (kapsama göre dinamik)
  Pazaryeri: Tümü / Trendyol / HB / N11 / Pazarama
  Ek Tutar: sayı input
  Kar Oranı: sayı input (min 1.0)
  Kargo: sayı input
  Komisyon Oranı: yüzde input (0-99)
  Öncelik: sayı input

Kaydet → POST veya PUT /price-rules
Validation: kar oranı < 1 → inline hata

### LiveSimulator Bileşeni (ÖNEMLI: gerçek zamanlı)
Inputlar: Base Fiyat, Ek Tutar, Kar Oranı, Kargo, Komisyon
onChange her tetiklendiğinde (debounce 300ms):
  POST /price-rules/simulate
  Sonuçlar:
    Her adım tablo olarak: Base + Ek = X | × Kar = Y | + Kargo = Z | ÷(1-Kom) = Final
  4 pazaryeri fiyatı yan yana kartlar olarak gösterilir

### GlobalSettings Bileşeni
Global Min Fiyat input + Kaydet butonu
GET/PUT /price-settings

### Test
- Simülatör: input değişince 300ms sonra API çağrılmalı
- Kar oranı < 1 → kaydet butonu disabled + hata mesajı
- Kural aktif/pasif toggle → PUT /price-rules/:id çağrılmalı
- Öncelik sıralama değişince API güncelleme çağrılmalı
```

---

## PROMPT 7.5 — Sipariş Ekranı

```
src/pages/OrdersPage.tsx bileşenini yaz.

### Tab Yapısı (URL: ?tab=new)
[ Yeni (badge) ] [ Hazırlanıyor ] [ Kargolanan ] [ Teslim/Tamamlanan ] [ İptal/İade (badge) ]

Her tab GET /orders?status=... ile ayrı sorgu atar.
Badge: sayı (kırmızı) — pending tab'larda görünür

### OrderRow Bileşeni
Kolonlar: # | Sipariş No | Pazaryeri ikon | Müşteri | Tutar | Tarih | Durum | Aksiyon

Aksiyon butonu (duruma göre değişir):
  NEW → 'Onayla' (yeşil)
  LABEL_CREATED → 'Kargoya Verildi' (mavi)
  RETURN_REQUESTED → 'İncelemeye Al' (turuncu)
  Diğerleri → 'Detay' linki

### OrderDetailDrawer
Sağdan açılır panel. Sekmeler:
  Sipariş Detayı | Kargo Bilgisi | Fatura | Durum Geçmişi

Sipariş Detayı:
  - Müşteri: Ad, telefon (maskelenmiş: 05**-***-**34)
  - Teslimat adresi
  - Ürün listesi: görsel + ad + adet + fiyat

Kargo sekmesi:
  - Kargo firması dropdown (etiket yoksa)
  - 'Kargo Etiketi Oluştur' butonu → POST /cargo/create/:orderId
  - Etiket varsa: PDF önizleme linki + takip no
  - Kargo durumu: son güncelleme + timeline

Durum Geçmişi:
  Timeline bileşeni: her geçiş — saat + kimin yaptığı + not

### ApproveModal (onay diyaloğu)
"Bu siparişi onaylıyor musunuz?" + stok durumu özeti
Onayla → POST /orders/:id/approve
Başarıyla → toast + drawer kapat + liste yenile

### Test
- Tab değişince URL güncellenmeli
- 'Onayla' tıklandığında modal açılmalı
- Modal onay → API çağrısı → liste yenilenmeli
- Müşteri telefonu maskelenmiş görünmeli (05**-***-**34)
```
