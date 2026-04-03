# Modül 4 — Kategori Motoru Promptları

---

## PROMPT 4.1 — Kategori Eşleştirme Servisi (Hibrit)

```
src/services/CategoryMappingService.ts dosyasını yaz.

### Mimari: Hibrit (Cache-first + AI fallback)

async resolveCategory(
  sourceCategory: string,
  marketplace: Marketplace,
  sourceId: string
): Promise<CategoryResolutionResult>

interface CategoryResolutionResult {
  type: 'CACHED' | 'AI_SUGGESTED' | 'PENDING'
  marketplaceCategoryId: string | null
  marketplaceCategoryPath: string | null
  mappingId: string
  confidence: number | null
}

### Akış
1. category_mappings'te (sourceId, sourceCategory, marketplace, status=APPROVED) ara
   → Bulursa: { type: 'CACHED', ... } döndür

2. status=PENDING olan var mı bak
   → Varsa: { type: 'PENDING', mappingId } döndür (zaten bekliyor)

3. Claude API çağrısı yap (AI öneri)
   → Sonucu status=PENDING olarak kaydet
   → { type: 'AI_SUGGESTED', confidence } döndür

### Claude API Çağrısı (src/services/CategoryAIService.ts)

POST https://api.anthropic.com/v1/messages
Headers: x-api-key, anthropic-version: 2023-06-01
Model: claude-sonnet-4-20250514
Max tokens: 1000

System prompt:
"Sen bir e-ticaret kategori eşleştirme uzmanısın.
Verilen kaynak kategoriyi, hedef pazaryerinin kategori listesinden
en uygun 3 kategoriye eşleştir.
SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir metin olmadan:
{
  \"suggestions\": [
    {\"categoryId\": \"...\", \"categoryPath\": \"...\", \"confidence\": 0.92, \"reason\": \"...\"},
    {\"categoryId\": \"...\", \"categoryPath\": \"...\", \"confidence\": 0.78, \"reason\": \"...\"},
    {\"categoryId\": \"...\", \"categoryPath\": \"...\", \"confidence\": 0.61, \"reason\": \"...\"}
  ]
}"

User prompt:
"Kaynak kategori: '{sourceCategory}'
Hedef pazaryeri: {marketplace}

{marketplace} kategori listesi (en alakalı 50 kategori):
{categoryCandidates}"

### Semantic Search (getCandidates metodu)
- marketplace_categories tablosundan fulltext search
- pg_trgm ile benzerlik skoru
- LIMIT 50 sonuç al
- Bu 50 adayı AI prompt'una ekle

### Güven Eşiği
- confidence >= 0.90 → 'HIGH' — toplu onay için önerilir
- confidence >= 0.60 → 'MEDIUM' — admin seçmeli
- confidence < 0.60 → 'LOW' — admin manuel seçim yapmalı

### Test (Vitest)
- Cache hit: DB'de APPROVED varsa AI çağrısı yapılmamalı (mock ile doğrula)
- Cache miss: AI çağrısı yapılmalı, PENDING kaydı oluşmalı
- AI yanıt JSON parse hatası → CategoryAIError
- confidence threshold doğru sınıflandırılmalı
```

---

## PROMPT 4.2 — Kategori API Endpoint'leri

```
src/api/routes/category.routes.ts dosyasını yaz.

### Endpoint'ler

GET /category-mappings/pending
  Onay bekleyen eşleştirmeler — admin panel ana kaynağı
  Query: ?marketplace=&page=1&limit=50
  Response: { data: CategoryMapping[], meta: {...} }
  Her kayıt allSuggestions alanını içermeli

PUT /category-mappings/:id/approve
  Body: { suggestionIndex: 0 | 1 | 2 }
  İşlem:
    1. allSuggestions[suggestionIndex]'i al
    2. status='APPROVED', marketplaceCategoryId, marketplaceCategoryPath güncelle
    3. approvedBy = req.user.name, approvedAt = now()
    4. Bu sourceCategory bekleyen ürünleri kuyruğa al (background)
  Response: 200 + updated mapping

PUT /category-mappings/:id/approve-manual
  Body: { marketplaceCategoryId: string, marketplaceCategoryPath: string }
  aiSuggested = false olarak işaretle
  Response: 200 + updated mapping

PUT /category-mappings/:id/reject
  status = 'REJECTED'
  Response: 200

POST /category-mappings/bulk-approve
  Body: { items: [{ id: string, suggestionIndex: number }] }
  Transaction içinde toplu onay
  Response: { approved: number, failed: number, errors: [...] }

POST /category-mappings/suggest
  Body: { sourceCategory: string, marketplace: string, sourceId: string }
  Manuel AI öneri tetikle
  Response: 202 + mappingId (async)

GET /marketplace-categories/:marketplace/search
  Query: ?q=...&isLeaf=true&limit=20
  Kategori ağacında metin araması (pg_trgm benzerlik)
  Response: [{ categoryId, categoryPath, categoryName }]

GET /category-stats
  Response: { pending: number, approved: number, rejected: number, total: number }

### Test (Vitest + supertest)
- bulk-approve transaction rollback testi (bir hata → hepsi rollback)
- Onay sonrası mapping status APPROVED olmalı
- Manuel onayda aiSuggested=false olmalı
```

---

# Modül 5 — Pazaryeri Adaptörleri Promptları

---

## PROMPT 5.1 — BaseAdapter

```
src/adapters/BaseAdapter.ts abstract sınıfını yaz.

### Abstract Interface

abstract class BaseAdapter {
  abstract readonly name: string
  abstract readonly rateLimitRPM: number

  abstract normalize(product: ParsedProduct, categoryId: string, finalPrice: number): unknown
  abstract publish(normalized: unknown): Promise<PublishResult>
  abstract getStatus(externalId: string): Promise<StatusResult>
  abstract updatePriceAndStock(items: PriceStockItem[]): Promise<void>

  // Implement edilen ortak metotlar:
  async process(product, categoryId, finalPrice): Promise<PublishResult>
  async processBatch(items, onProgress?): Promise<BatchResult>
  protected async _withRetry<T>(fn: () => Promise<T>): Promise<T>
  protected async _request(method, url, options): Promise<unknown>
  protected _stripHtml(str: string): string
  protected _truncate(str: string, maxLen: number): string
}

interface PublishResult {
  success: boolean
  externalId: string | null
  batchId?: string
  message: string
}

interface StatusResult {
  status: string
  items?: unknown[]
  failedItems?: unknown[]
}

### Rate Limiter (Token Bucket)
class TokenBucketRateLimiter {
  constructor(rpm: number)
  async throttle(): Promise<void>
  private refill(): void
}
- Token tükendiyse bekleme süresi hesapla: (60000 / rpm) ms

### Retry Stratejisi
- maxRetries: 3
- Exponential backoff: 1s, 2s, 4s (max 30s)
- Retry edilecek HTTP kodları: 429, 500, 502, 503, 504
- HTTP 429: Retry-After header varsa onu kullan

### Test (Vitest)
- Rate limiter: RPM sınırını aşmıyor mu
- Retry: 3 denemede başarılı olunca sonuç dönmeli
- Retry: 3 denemede başarısız → son hata fırlatılmalı
- _stripHtml: HTML tag'leri temizliyor mu
- _truncate: max uzunluğu aşmıyor mu
```

---

## PROMPT 5.2 — TrendyolAdapter

```
Önceki BaseAdapter sınıfını extend eden
src/adapters/TrendyolAdapter.ts dosyasını yaz.

### Gerçek API Bilgileri (Ek B'den)
- Base URL: https://apigw.trendyol.com/integration
- Auth: Basic Auth (merchantId:serviceKey Base64) — Ağustos 2024 sonrası yeni yapı
- User-Agent: '{sellerId} - SelfIntegration'  ← ZORUNLU, 403 alınır yoksa
- Rate limit: 200 req/dk

### Constructor
constructor(config: {
  merchantId: string   // GUID — HB_MERCHANT_ID
  serviceKey: string   // 12 karakter — HB_SERVICE_KEY (Ağustos 2024+)
  supplierId: string
  cargoCompanyId?: number  // default: 10
})

### normalize(product, categoryId, finalPrice)
Gerçek Trendyol ürün yapısı:
{
  barcode: product.barcode || product.sku,
  title: truncate(stripHtml(product.title), 250),
  productMainId: product.sku || product.id,
  brandId: product._trendyolBrandId || null,
  categoryId: parseInt(categoryId),
  quantity: Math.min(product.stock, 999999),
  stockCode: product.sku || product.id,
  description: truncate(stripHtml(product.description || product.title), 30000),
  currencyType: 'TRY',
  listPrice: finalPrice + 1,  // liste fiyatı satış fiyatından yüksek olmalı
  salePrice: finalPrice.toFixed(2).replace(".",","),  // HB: virgüllü ondalık
  vatRate: 20,
  cargoCompanyId: this.cargoCompanyId,
  images: product.images.slice(0, 8).map(url => ({ url })),
  attributes: []  // kategori özelliklerini ayrı prompt'ta ekleyeceğiz
}

### publish(normalized)
POST /product/sellers/{supplierId}/products
Body: { items: [normalized] }
Response: { batchRequestId } → batchId olarak döndür

### getStatus(batchRequestId)
GET /product/sellers/{supplierId}/products/batch-requests/{batchRequestId}

### updatePriceAndStock(items)
POST /inventory/sellers/{supplierId}/products/price-and-inventory
items: [{ barcode, quantity, salePrice, listPrice }]

### trackingNumberUpdate(packageId, trackingNumber)
PUT /order/sellers/{supplierId}/shipment-packages/{packageId}/update-tracking-number
Body: { trackingNumber }

### getOrders(params: { startDate: number, endDate: number, status?: string, page?: number })
GET /order/sellers/{supplierId}/orders?startDate=...&endDate=...
ÖNEMLİ: tarihler epoch millisaniye (Date.getTime())

### Test (Vitest + nock ile HTTP mock)
- User-Agent header her istekte gönderilmeli
- normalize() doğru alan adlarını üretmeli
- publish() batchRequestId döndürmeli
- getOrders() tarih formatı epoch ms kontrolü
- updatePriceAndStock() doğru endpoint çağrılmalı
```

---

## PROMPT 5.3 — PazaramaAdapter

```
BaseAdapter'ı extend eden src/adapters/PazaramaAdapter.ts dosyasını yaz.

### Gerçek API Bilgileri (Ek A'dan)
- Token URL: https://isortagimgiris.pazarama.com/connect/token
- API Base: https://isortagimapi.pazarama.com
- Auth: OAuth2 client_credentials
- Token formatı: Basic Auth(clientId:clientSecret) + form-urlencoded body
- Scope: merchantgatewayapi.fullaccess
- Token süresi: 1 saat

### Token Cache
private _token: string | null = null
private _tokenExpiry: number = 0

async _getToken(): Promise<string>
- Süresi dolmamışsa cache'ten döndür (60sn buffer)
- POST https://isortagimgiris.pazarama.com/connect/token
- Body (urlencoded): grant_type=client_credentials&client_id=...&client_secret=...&scope=merchantgatewayapi.fullaccess
- Authorization: Basic Base64(clientId:clientSecret)

### normalize(product, categoryId, finalPrice)
Gerçek Pazarama alan adları:
{
  code: product.sku || product.id,
  name: truncate(stripHtml(product.title), 300),
  displayName: truncate(stripHtml(product.title), 300),
  description: truncate(stripHtml(product.description || ''), 50000),
  brandId: product._pazaramaBrandId,
  categoryId: categoryId,
  stockCount: product.stock,
  listPrice: finalPrice + 1,
  salePrice: finalPrice.toFixed(2).replace(".",","),  // HB: virgüllü ondalık
  vatRate: 20,
  currencyType: 'TRY',
  desi: 1,  // varsayılan
  images: product.images.slice(0, 10).map(url => ({ imageurl: url })),
  attributes: Object.entries(product.attributes).map(([k,v]) => ({ attributeId: k, attributeValueId: v })),
  deliveries: []  // deliveryId ve cityList ayrıca set edilmeli
}

### publish(normalized)
POST /product/create
Body: { products: [normalized] }

### getOrders(params)
POST /order/getOrdersForApi  ← GET değil POST!
Body: { startDate, endDate, pageSize, pageNumber, orderItemStatus? }
startDate/endDate format: 'YYYY-MM-DD' string

### updateOrderStatus(orderNumber, item)
PUT /order/updateOrderStatus
Body: {
  orderNumber,
  item: {
    orderItemId,
    status: 11,            // kargoya verildi
    deliveryType: 1,
    shippingTrackingNumber,
    trackingUrl,
    cargoCompanyId         // UUID string — cargo_company_mappings tablosundan
  }
}

### Test (Vitest)
- Token cache: aynı dakikada 2 çağrı → tek token request
- Token süresi doldukça yenilenmeli
- normalize() 'imageurl' küçük harf kontrolü (Pazarama özelliği)
- getOrders() POST metodu ile çağrılmalı (GET değil)
```

---

## PROMPT 5.4 — N11Adapter

```
BaseAdapter'ı extend eden src/adapters/N11Adapter.ts dosyasını yaz.

### Gerçek API Bilgileri (Ek C'den)
- Base URL: https://api.n11.com
- Auth: NO TOKEN — her istekte header'a appkey + appsecret
- Header: { appkey: '...', appsecret: '...', Content-Type: 'application/json' }
- Rate limit: 1000 req/dk

### _request override
Protected _request her çağrıda appkey + appsecret header eklemeli
Token alma YOK — constructor'dan config alıyor:
constructor(config: { appkey: string; appsecret: string; integrator: string })

### normalize(product, categoryId, finalPrice)
{
  integrator: this.integrator,  // ZORUNLU alan
  title: truncate(stripHtml(product.title), 200),
  stockCode: product.sku || product.id,
  description: truncate(stripHtml(product.description || product.title), 50000),
  categoryId: parseInt(categoryId),
  listPrice: finalPrice + 1,
  salePrice: finalPrice.toFixed(2).replace(".",","),  // HB: virgüllü ondalık
  stockCount: product.stock,
  productMainId: product._groupCode || product.sku,
  images: product.images.slice(0, 5).map((url, i) => ({ url, order: i + 1 })),
  attributes: Object.entries(product.attributes).map(([k,v]) => ({ attributeId: k, value: v }))
}

### publish(normalized)
POST /ms/product/tasks/product-create
ÖNEMLİ: Senkron değil — taskId döner
Response: { id: taskId }

### getStatus(taskId)
POST /ms/product/task-details/page-query
Body: { taskId: parseInt(taskId), pageable: { page: 0, size: 1000 } }
Poll et: status PROCESSED, IN_QUEUE, REJECT

### updatePriceAndStock(items)
POST /ms/product/tasks/price-stock-update
items map → [{ integrator, stockCode, listPrice, salePrice, stockCount }]
ÖNEMLİ: listPrice, salePrice nokta ile ayrılmalı (virgül değil), 2 ondalık

### getOrders(params)
GET /rest/delivery/v1/shipmentPackages
Query params ile filtre (body değil)

### approveOrder(lineIds: number[])
PUT /rest/order/v1/update
Body: { lines: [{ lineId }], status: 'Picking' }
NOT: Sadece 'Picking' güncelleme şu an destekleniyor

### Test (Vitest)
- Her istekte appkey + appsecret header olmalı (token yok)
- publish() asenkron: taskId döndürmeli
- updatePriceAndStock() fiyatlar nokta ile, 2 ondalık
- getOrders() GET metoduyla query string kullanmalı
```
