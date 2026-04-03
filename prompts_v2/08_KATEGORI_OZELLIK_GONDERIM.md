# Modül 8 — Kategori Bazlı Ürün Özellik & Gönderim Ekranı

Bölüm 17 teknik tasarımını implement eder.
Web (React) + Mobil (React Native) — ortak backend, ayrı frontend.

---

## PROMPT 8.1 — Veritabanı Şeması (Yeni Tablolar)

```
Aşağıdaki 3 yeni tabloyu mevcut schema.prisma'ya ekle.

### marketplace_category_attributes — Özellik Önbelleği

model MarketplaceCategoryAttribute {
  id              String    @id @default(uuid())
  marketplace     Marketplace
  categoryId      String    @db.VarChar(100)
  attributeId     String    @db.VarChar(100)
  attributeName   String    @db.VarChar(200)
  attributeType   AttributeType        // dropdown | multi_select | free_text | number | boolean | color
  isMandatory     Boolean   @default(false)
  allowCustomValue Boolean  @default(false)
  values          Json?     // [{id: string, name: string}]
  validationRules Json?     // {min?, max?, maxLength?, pattern?}
  displayOrder    Int       @default(0)
  fetchedAt       DateTime  @default(now())

  @@unique([marketplace, categoryId, attributeId])
  @@index([marketplace, categoryId, isMandatory])
  @@map("marketplace_category_attributes")
}

enum AttributeType {
  dropdown
  multi_select
  free_text
  number
  boolean
  color
}

### product_attributes — Ürün Özellik Değerleri

model ProductAttribute {
  id            String    @id @default(uuid())
  productId     String
  product       Product   @relation(fields: [productId], references: [id])
  marketplace   Marketplace
  attributeId   String    @db.VarChar(100)
  attributeName String?   @db.VarChar(200)   // join gerektirmemesi için kopyalanır
  valueId       String?   @db.VarChar(100)   // dropdown seçiminde değer ID
  valueText     String?   @db.Text           // free text veya display değeri
  isInherited   Boolean   @default(false)    // toplu uygulama ile mi geldi
  savedBy       String?   @db.VarChar(100)
  savedAt       DateTime  @default(now())

  @@unique([productId, marketplace, attributeId])
  @@index([productId, marketplace])
  @@map("product_attributes")
}

### product_publish_jobs — Gönderim İş Takibi

model ProductPublishJob {
  id             String       @id @default(uuid())
  productId      String
  product        Product      @relation(fields: [productId], references: [id])
  marketplace    Marketplace
  externalJobId  String?      @db.VarChar(200)   // batchRequestId (TY) veya taskId (N11)
  status         PublishStatus @default(QUEUED)
  attemptCount   Int          @default(0)
  lastPolledAt   DateTime?
  errorMessage   String?      @db.Text
  submittedAt    DateTime?
  resolvedAt     DateTime?
  triggeredBy    String?      @db.VarChar(100)
  createdAt      DateTime     @default(now())

  @@index([status, marketplace, lastPolledAt])
  @@index([productId, marketplace])
  @@map("product_publish_jobs")
}

enum PublishStatus {
  QUEUED
  SUBMITTED
  POLLING
  SUCCESS
  FAILED
  POLLING_TIMEOUT
}

### Görev
- Tabloları schema.prisma'ya ekle
- Prisma migrate dev --name add_category_attributes_publish_jobs
- Product modeline ilişkileri ekle: productAttributes, publishJobs
```

---

## PROMPT 8.2 — CategoryAttributeService

```
src/services/CategoryAttributeService.ts dosyasını yaz.

### Sorumluluk
Pazaryeri kategori özelliklerini önbellekten veya API'den getirir.
Stale-while-revalidate stratejisi: 7 günden eski veri API'den yenilenir,
bu arada önbellekteki veri döndürülür.

### Arayüz

interface Attribute {
  attributeId: string
  attributeName: string
  attributeType: 'dropdown' | 'multi_select' | 'free_text' | 'number' | 'boolean' | 'color'
  isMandatory: boolean
  allowCustomValue: boolean
  values: { id: string; name: string }[]
  validationRules: { min?: number; max?: number; maxLength?: number; pattern?: string }
  displayOrder: number
}

interface FormField extends Attribute {
  currentValue: string | string[] | boolean | null  // ürünün mevcut değeri
  isValid: boolean
  validationError: string | null
}

### getAttributes(marketplace, categoryId, productId?)
1. marketplace_category_attributes tablosunu sorgula
2. Sonuç varsa:
   a. fetchedAt < 7 gün → direkt döndür
   b. fetchedAt >= 7 gün → döndür + arka planda refreshFromAPI() tetikle (await olmadan)
3. Sonuç yoksa → refreshFromAPI() await et, sonra döndür
4. productId verilmişse → product_attributes'tan mevcut değerleri ekle (currentValue)

### refreshFromAPI(marketplace, categoryId)
Her pazaryeri için doğru endpoint:
- Trendyol: GET /integration/product/product-categories/{categoryId}/attributes
- HB: GET /product/api/categories/{categoryId}/attributes
- N11: GET /cdn/category/{categoryId}/attribute
- Pazarama: GET /category/getCategoryTree (ağaçtan filtrele)

API yanıtını normalize et → Attribute[] formatına dönüştür
Prisma upsert ile marketplace_category_attributes'a yaz
fetchedAt güncelle

### buildFormSchema(attributes, productAttributes)
FormField[] döndür: her attribute'a productAttributes'tan currentValue ekle

### validateValue(attribute, value)
{ isValid: boolean; error: string | null }
- required + boş → "Bu alan zorunludur"
- maxLength aşımı → "En fazla X karakter"
- number min/max → "X ile Y arasında olmalı"
- dropdown: değer listede yok → "Geçersiz değer"

### Test (Vitest)
- Cache hit: 3 günlük cache → API çağrısı yok (mock ile doğrula)
- Stale: 8 günlük cache → döndür + arka planda refresh tetikle
- Cache miss: API çağrısı yapılmalı, DB'ye yazılmalı
- buildFormSchema: currentValue doğru eşleşmeli
- validateValue: zorunlu boş → hata, dolu → valid
```

---

## PROMPT 8.3 — PublishService (Gönderim + Polling)

```
src/services/PublishService.ts dosyasını yaz.

### submitProducts(productIds, marketplace, triggeredBy)
Seçili ürünleri pazaryerine gönderir.

Adımlar:
1. Her ürün için:
   a. Zorunlu attribute'lar dolu mu? → doluluk kontrolü
   b. Eksikse: { productId, missingAttributes[] } hata listesine ekle, atla
   c. Adaptörden normalize() çağır
   d. Pazaryerine gönder (batch veya tekil)
   e. ProductPublishJob oluştur: status=SUBMITTED, externalJobId kaydet
2. BullMQ polling job'larını kuyruğa al
3. Sonuç: { submitted: number, skipped: { productId, reason }[] }

### Pazaryeri Bazlı Gönderim Stratejisi
- Trendyol: batch (max 100 ürün/istek) → batchRequestId döner
- N11: task (max 1000 ürün) → taskId döner — asenkron, polling zorunlu
- HB: multipart/form-data → trackingId döner — asenkron
- Pazarama: tekil veya toplu → senkron yanıt, polling gerekmez

### pollJobStatus(jobId)
BullMQ worker tarafından her X saniyede çağrılır:
1. ProductPublishJob'ı çek (status=SUBMITTED veya POLLING)
2. Pazaryerine externalJobId ile durum sor
3. Sonuca göre güncelle:
   - Devam ediyor → status=POLLING, lastPolledAt=now(), attemptCount++
   - Başarılı → status=SUCCESS, resolvedAt=now()
     + marketplace_listings güncelle (status=PUBLISHED, hashAtPublish=contentHash)
   - Başarısız → status=FAILED, errorMessage kaydet
     + publish_errors tablosuna yaz
   - attemptCount > limit → status=POLLING_TIMEOUT + Slack bildirimi

### Polling Limitleri (Pazaryeri Bazında)
const POLLING_CONFIG = {
  TRENDYOL:    { intervalSec: 10, maxAttempts: 12 },   // max 2 dk
  N11:         { intervalSec: 15, maxAttempts: 20 },   // max 5 dk
  HEPSIBURADA: { intervalSec: 20, maxAttempts: 15 },   // max 5 dk
  PAZARAMA:    { intervalSec: 0,  maxAttempts: 1  },   // tek seferlik
}

### getCompleteness(productIds, marketplace)
Ürünlerin doluluk oranını hesapla:
SELECT zorunlu attribute sayısı vs dolu olanlar
{ productId, totalMandatory, filledMandatory, completenessPercent }[]

### Test (Vitest)
- submitProducts: eksik attribute → skipped listesine girmeli
- submitProducts: dolu ürün → job oluşmalı, kuyruğa alınmalı
- pollJobStatus: SUCCESS → marketplace_listings güncellenmeli
- pollJobStatus: maxAttempts aşılırsa → POLLING_TIMEOUT + Slack
- Pazarama: polling gerekmez, tek seferlik kontrol
- N11 taskId polling: PROCESSED → SUCCESS, IN_QUEUE → POLLING devam
```

---

## PROMPT 8.4 — API Endpointleri

```
src/api/routes/attributes.routes.ts ve publish.routes.ts dosyalarını yaz.

### Özellik Endpointleri

GET /category-attributes/:marketplace/:categoryId
  Query: ?productId= (opsiyonel — mevcut değerleri ekler)
  Response: {
    attributes: FormField[],   // zorunlular önce, displayOrder sırası
    source: 'cache' | 'api',
    fetchedAt: string
  }
  Cache-Control: max-age=3600

POST /category-attributes/:marketplace/:categoryId/refresh
  Response: 202 + { message: 'Yenileniyor…' }
  Arka planda refreshFromAPI() tetikle

GET /products/:productId/attributes/:marketplace
  Response: ProductAttribute[]

PUT /products/:productId/attributes/:marketplace
  Body: { attributes: [{ attributeId, valueId?, valueText? }] }
  Upsert işlemi: her attribute için createOrUpdate
  Response: { saved: number, updated: number }

POST /products/attributes/bulk-apply
  Body: {
    productIds: string[],
    marketplace: Marketplace,
    attributes: [{ attributeId, valueId?, valueText? }]
  }
  isInherited: true olarak kaydet
  Response: { applied: number, products: string[] }

GET /products/attributes/completeness
  Query: ?marketplace=&categoryMappingId=&productIds[]=
  Response: [{ productId, totalMandatory, filledMandatory, completenessPercent }]

### Gönderim Endpointleri

POST /publish/submit
  Body: { productIds: string[], marketplace: Marketplace }
  Middleware: requireRole('ADMIN')
  Response: 202 + { submitted, skipped, jobIds[] }

GET /publish/jobs
  Query: ?status=&marketplace=&productId=&page=1&limit=25
  Response: paginated ProductPublishJob[]

GET /publish/jobs/:jobId
  Response: ProductPublishJob (detay)

POST /publish/jobs/:jobId/retry
  Başarısız job'ı yeniden kuyruğa al
  Response: 202

POST /publish/jobs/retry-failed
  Tüm FAILED job'ları toplu retry
  Response: 202 + { queued: number }

GET /publish/status/:productId/:marketplace
  En son job durumu + completeness oranı
  Response: { status, completenessPercent, lastJobId, resolvedAt }

### Validasyon
- PUT attributes: her değer için validateValue() çağır — hata varsa 400
- POST submit: completenessPercent < 100 olan ürünler skipped'e düşer

### Test (Vitest + supertest)
- GET attributes: cache hit → source='cache'
- PUT attributes: zorunlu alan boş → 400 + validationError
- POST bulk-apply: isInherited=true olarak kaydedilmeli
- POST submit: eksik ürün → skipped, dolu ürün → 202
- GET completeness: doğru yüzde hesaplanmalı
```

---

## PROMPT 8.5 — Web Frontend (React)

```
src/pages/CategoryPublishPage.tsx ve src/components/publish/ bileşenlerini yaz.

### Layout: 3 Panel (yan yana, overflow hidden)

CategorySidebar (280px sabit)
  - Pazaryeri sekmesi (Trendyol/HB/N11/Pazarama)
  - Onaylı kategori listesi (GET /category-mappings?status=APPROVED&marketplace=X)
  - Her kategoride: ikon + ad + ürün sayısı + hazır/eksik göstergesi
  - Arama filtresi (client-side, debounce)

ProductList (flex-1)
  - Header: kategori başlığı + özet (X ürün · Y hazır · Z eksik)
  - Bulk action bar: seçili ürün sayısı + 'Toplu Özellik' + 'Gönder' butonları
  - Ürün kartları: checkbox + görsel + ad + SKU + doluluk progress + publish badge
  - Doluluk renk kodu: %100=yeşil, %70-99=sarı, %50-69=turuncu, <50=kırmızı
  - Publish badge: QUEUED/POLLING/SUCCESS/FAILED/none

AttributeFormPanel (420px sabit)
  - Boş durum: ürün seçilmediğinde placeholder
  - Seçili ürün: header (görsel + ad + sku) + nav sekmeler
  - Sekmeler: Zorunlu (badge: eksik sayısı) | Opsiyonel | Geçmiş
  - Her attribute type için ayrı input bileşeni:
    dropdown → <Select>
    multi_select → pill checkbox grubu
    boolean → Toggle switch
    color → renk paleti
    free_text → <Input>
    number → <Input type="number"> + min/max hint
  - Dolduruldukça: input yeşile döner (filled class)
  - Alt bar: doluluk progress + 'Kaydet' + 'Kaydet & Sonraki' butonları

### AttributeInput Bileşeni (ayrı dosya)
Her tip için ayrı render:
  <AttributeInput attribute={attr} value={val} onChange={fn} error={err} />

### BulkApplyDrawer
Sağdan açılan side drawer
Seçili ürünlerin ortak kategorisindeki zorunlu attribute'ları göster
Kaydet → POST /products/attributes/bulk-apply

### PublishConfirmDrawer
Gönder butonunda açılır:
  - Gönderilecek ürün listesi: ad + doluluk durumu (hazır/eksik)
  - Eksik ürünler sarı uyarı ile — "Bu ürünler atlanacak"
  - Onayla → POST /publish/submit

### Polling (TanStack Query)
useQuery key: ['publish-status', productId, marketplace]
refetchInterval: (data) => data?.status === 'POLLING' || data?.status === 'QUEUED' ? 5000 : false
// Polling → durur; tamamlanınca durum badge güncellenir

### Test (Vitest + RTL)
- Ürün seçilince sağ panel açılmalı
- Attribute doldurulunca progress güncellenmeli
- 'Kaydet & Sonraki' → bir sonraki ürüne geçmeli
- Toplu seçim → bulk bar görünmeli
- Publish badge 'Yayında' olunca yeşil olmalı
```

---

## PROMPT 8.6 — React Native Mobil Uyarlama

```
Bölüm 8.5'te yazılan web bileşenlerini React Native'e uyarla.
Backend API aynı — sadece UI katmanı değişiyor.

### Navigation Stack (React Navigation v7)
Stack.Navigator:
  CategoryListScreen     → kategori seçimi
  ProductListScreen      → ürün listesi
  AttributeFormScreen    → özellik formu (full screen)

### CategoryListScreen
FlatList: pazaryeri tab'ı + kategori satırları
Her satır: TouchableOpacity + ikon + ad + sayı badge + hazır/eksik nokta

### ProductListScreen
Header: kategori adı + toplu seçim butonu
FlatList: ProductCard bileşeni
Long press → çoklu seçim moduna gir
Seçim modunda: bottom floating bar (toplu özellik + gönder)

### AttributeFormScreen
ScrollView + her attribute için AttributeInput
Dropdown → @react-native-picker/picker veya ActionSheet (@expo/react-native-action-sheet)
Multi-select → BottomSheet içinde liste (@gorhom/bottom-sheet)
Boolean → Switch (react-native built-in)
Color → TouchableOpacity palette
Alt sabit bar: doluluk CircularProgress + Kaydet + Sonraki butonları

### AttributeInput (Shared Logic)
Platform agnostic validasyon mantığı paylaşılmalı:
  src/shared/attributeValidation.ts  ← web ve mobil her ikisi import eder

### PublishConfirmBottomSheet
BottomSheet: gönderilecek ürünler + onay butonu
POST /publish/submit çağrısı + polling başlat

### Polling (React Query + background fetch)
useQuery refetchInterval: 5000 (POLLING durumunda)
AppState ile arka plan yönetimi:
  active → 5sn polling
  background → polling durdur, foreground'a dönünce devam et

### Test (Jest + React Native Testing Library)
- CategoryListScreen: kategori tıklanınca navigate çalışmalı
- ProductListScreen: long press → seçim moduna geçmeli
- AttributeFormScreen: dropdown değişince state güncellenmeli
- Polling: AppState background → interval temizlenmeli
```
