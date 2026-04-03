# Modül 6 — Sipariş & Kargo Yönetimi Promptları

---

## PROMPT 6.1 — Sipariş Çekme Servisi

```
src/services/OrderFetchService.ts dosyasını yaz.

### Sorumluluk
Tüm pazaryerlerinden yeni siparişleri polling ile çeker,
normalleştirir ve veritabanına yazar.

### fetchAll(): Promise<FetchSummary>
Her pazaryeri için paralel (Promise.allSettled) çalışır.
Bir pazaryeri hata verse diğerleri durmaz.

interface FetchSummary {
  results: {
    marketplace: Marketplace
    fetched: number
    newOrders: number
    errors: string[]
  }[]
  totalNew: number
  durationMs: number
}

### fetchFromMarketplace(marketplace: Marketplace)
1. Her pazaryeri için son başarılı fetch zamanını DB'den çek (order_fetch_log)
2. Tarih aralığı hesapla: lastFetchAt → now()
3. İlk çalışma: son 7 gün
4. Sayfalı çekme — tüm sayfaları tükene kadar dön
5. Her sipariş için:
   a. Veritabanında var mı? (marketplaceOrderId unique check)
   b. Yoksa: createOrder() ile kaydet, status=NEW
   c. Varsa: güncelleme gerekiyor mu kontrol et

### createOrder(raw, marketplace)
Pazaryerinin ham sipariş verisini normalize ederek orders tablosuna yaz.
KVKK: customerName, customerPhone, shippingAddress → AES-256-GCM şifreli sakla
Şifreleme anahtarı: process.env.FIELD_ENCRYPTION_KEY (zod ile validate edilmeli)

### Pazaryeri Özel Normalizer'lar
Her pazaryeri ham veriyi farklı format döndürür:
- normalizeTrendyolOrder(raw): Trendyol shipment-package → Order
- normalizeN11Order(raw): N11 shipmentPackage → Order
- normalizePazaramaOrder(raw): Pazarama order → Order
- normalizeHepsiburadaOrder(raw): HB order → Order

Ortak normalize alanları:
  marketplaceOrderId, marketplaceOrderNo,
  totalAmount, currency,
  items: [{ marketplaceProductId, sku, title, quantity, unitPrice, totalPrice }]

### order_fetch_log tablosu (yeni)
- id: UUID
- marketplace: Enum
- status: 'SUCCESS' | 'FAILED'
- fetchedCount: Int
- errorMessage: String?
- lastFetchedAt: DateTime
- createdAt: DateTime

### Test (Vitest)
- fetchAll: bir pazaryeri başarısız → diğerleri çalışmalı (Promise.allSettled)
- Duplikat sipariş: aynı marketplaceOrderId → ikinci kez insert yapılmamalı
- KVKK: customerName kaydedilen değer ham değer olmamalı (şifreli)
- Sayfalama: 2 sayfa veri → tüm siparişler çekilmeli
```

---

## PROMPT 6.2 — Sipariş Durum Makinesi

```
src/services/OrderStateMachine.ts dosyasını yaz.

### Geçerli Durum Geçişleri (bunun dışındaki geçişler InvalidTransitionError fırlatır)

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  NEW:                    ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL:       ['PREPARING', 'CANCELLED'],
  PREPARING:              ['LABEL_CREATED', 'CANCELLED'],
  LABEL_CREATED:          ['SHIPPED'],
  SHIPPED:                ['IN_TRANSIT'],
  IN_TRANSIT:             ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERED:              ['COMPLETED', 'RETURN_REQUESTED'],
  COMPLETED:              [],
  DELIVERY_FAILED:        ['SHIPPED', 'CANCELLED'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'PENDING_APPROVAL'],
  CANCELLED:              [],
  RETURN_REQUESTED:       ['RETURN_APPROVED', 'RETURN_REJECTED'],
  RETURN_APPROVED:        ['REFUNDED'],
  RETURN_REJECTED:        ['COMPLETED'],
  REFUNDED:               [],
}

### transition(orderId, toStatus, options)
interface TransitionOptions {
  changedBy: string
  note?: string
  skipValidation?: boolean  // sadece sistem kullanımı için
}

İşlem adımları (Prisma transaction):
1. Geçerli durumu oku (SELECT FOR UPDATE)
2. Geçiş geçerli mi kontrol et
3. orders.status güncelle
4. order_status_logs'a yaz
5. Yan etki tetikle: triggerSideEffect(toStatus, order)

### triggerSideEffect(status, order)
- PREPARING → stok düş + fatura oluştur (background queue)
- LABEL_CREATED → pazaryerine takip no bildir (background queue)
- SHIPPED → shipments kaydını güncelle
- CANCELLED → stok geri ekle + iptal faturası (background queue)
- REFUNDED → stok geri ekle + iade faturası

### Stok İşlemleri (SELECT FOR UPDATE ile kilitli)
# NOT: Ürün gönderimi asenkron (batch/taskId) — 'submit' ≠ 'yayında'
decreaseStock(productId, quantity):
  SELECT products FOR UPDATE
  Eğer stock - quantity < 0 → InsufficientStockError
  UPDATE products SET stock = stock - quantity

increaseStock(productId, quantity):
  UPDATE products SET stock = stock + quantity

### Test (Vitest)
- NEW → PREPARING geçişi geçerli
- NEW → SHIPPED geçişi InvalidTransitionError
- PREPARING → stok düşmeli
- CANCELLED (PREPARING sonrası) → stok geri eklenmeli
- Eş zamanlı iki sipariş aynı stoğa → sadece biri geçmeli (SELECT FOR UPDATE testi)
- Geçiş log'a yazılmalı
```

---

## PROMPT 6.3 — Sipariş API Endpoint'leri

```
src/api/routes/order.routes.ts ve src/api/controllers/order.controller.ts yaz.

### Endpoint'ler

GET /orders
  Query: ?status=&marketplace=&startDate=&endDate=&page=1&limit=25&search=
  search: marketplaceOrderId veya marketplaceOrderNo
  Response: paginated orders list
  ÖNEMLİ: customerName/phone decrypt edilerek döndürülmeli

GET /orders/:orderId
  Response: order + items + status_logs + invoice (varsa)
  Müşteri bilgileri decrypt edilmiş

POST /orders/:orderId/approve
  Middleware: requireRole('ADMIN')
  Aksiyon: NEW → PENDING_APPROVAL → PREPARING (iki adım)
  Background: stok düş + kargo etiketi kuyruğuna al
  Response: 200 + updated order

POST /orders/:orderId/cancel
  Body: { reason: string }
  Aksiyon: stateMachine.transition(orderId, 'CANCELLED')
  Response: 200

POST /orders/:orderId/mark-shipped
  Body: { trackingNumber: string, cargoCompany: CargoCompany }
  Aksiyon:
    1. Kargo etiketi oluşturulmuş mu kontrol et
    2. LABEL_CREATED → SHIPPED
    3. Pazaryerine takip no bildir (background queue)
  Response: 200

POST /orders/:orderId/approve-return
  Aksiyon: RETURN_REQUESTED → RETURN_APPROVED
  Response: 200

POST /orders/:orderId/reject-return
  Body: { reason: string }
  Aksiyon: RETURN_REQUESTED → RETURN_REJECTED
  Response: 200

POST /orders/:orderId/mark-returned
  Body: { condition: 'GOOD' | 'DAMAGED' }
  Aksiyon: RETURN_APPROVED → REFUNDED + stok geri ekle
  Response: 200

POST /orders/fetch
  Tüm pazaryerlerinden manuel tetikleme
  Response: 202 + jobId

GET /orders/stats
  Response:
  {
    byStatus: Record<OrderStatus, number>
    byMarketplace: Record<Marketplace, number>
    todayNew: number
    pendingApproval: number
    pendingReturn: number
  }

### Middleware Sırası
router.use(requireAuth)
admin-only: approve, cancel, mark-shipped, approve-return, reject-return, mark-returned

### Test (Vitest + supertest)
- GET /orders müşteri bilgileri decrypt edilmeli
- POST approve → stok düşmeli
- Geçersiz geçiş → 409 Conflict + hata mesajı
- Yetkisiz kullanıcı approve → 403
```

---

## PROMPT 6.4 — Kargo Adaptörleri

```
src/adapters/cargo/ klasöründe şu dosyaları yaz:
- BaseCargoAdapter.ts
- ArasCargoAdapter.ts
- YurticiCargoAdapter.ts
- SuratCargoAdapter.ts
- PttCargoAdapter.ts

### BaseCargoAdapter

abstract class BaseCargoAdapter {
  abstract createShipment(order: Order): Promise<ShipmentResult>
  abstract getStatus(trackingNumber: string): Promise<CargoStatus>
  abstract cancelShipment(trackingNumber: string): Promise<void>

  // normalize: API öncesi ham veriyi normalleştir
  protected buildReceiverInfo(order: Order): ReceiverInfo
}

interface ShipmentResult {
  trackingNumber: string
  labelPdfUrl: string
  rawResponse: unknown
}

interface CargoStatus {
  code: string              // kargo firmasının ham kodu
  normalizedStatus:         // sistem durumu
    'IN_TRANSIT' | 'DELIVERED' | 'DELIVERY_FAILED' | 'RETURNING' | 'CARGO_ISSUE'
  description: string
  location: string | null
  timestamp: DateTime
}

### Desi Hesaplama
calculateDesi(product: { weight?: number; width?: number; height?: number; depth?: number })
  Eğer boyut varsa: (width * height * depth) / 3000
  Yoksa: varsayılan 1 desi (env: DEFAULT_DESI=1)
  En az 1 desi

### ArasCargoAdapter
- API: REST + JSON
- Auth: Bearer token (credentials'tan alınır)
- Timeout: 30 saniye
- Rate limit: 100 req/dk
- Status kod eşleştirmesi:
  '65' → IN_TRANSIT
  '70' → IN_TRANSIT  (dağıtımda)
  '71' → DELIVERED
  '75' → DELIVERY_FAILED
  '80' → RETURNING
  '99' → CARGO_ISSUE

### SuratCargoAdapter
- SOAP/XML API → axios + xml2js kullan (fast-xml-parser)
- Her SOAP response XML parse edilmeli
- Status kod eşleştirmesi kargo firmasından alınmalı (placeholder bırak)

### CargoService (src/services/CargoService.ts)
async createLabel(orderId: string): Promise<void>
  1. Order + ürün bilgilerini çek
  2. Siparişteki cargoCompany'e göre adapter seç
  3. adapter.createShipment(order) çağır
  4. Sonucu shipments tablosuna kaydet
  5. orders.trackingNumber + orders.cargoLabelUrl güncelle
  6. orders.status → LABEL_CREATED
  7. Pazaryerine takip no bildir (notifyMarketplace)

async notifyMarketplace(orderId: string): Promise<void>
  Her pazaryerinin kendi tracking update metodunu çağır:
  - Trendyol: PUT /shipment-packages/{packageId}/update-tracking-number
  - Pazarama: PUT /order/updateOrderStatus (cargoCompanyId UUID ile)
  - HB/N11: ilgili endpointler

### Test (Vitest)
- Desi hesaplama: 20×30×10 / 3000 = 2.0
- Boyut yoksa default 1 desi
- ArasCargoAdapter status '71' → 'DELIVERED'
- createLabel başarısız → CargoLabelError, order statüsü değişmemeli
- notifyMarketplace hata verse → retry kuyruğuna alınmalı (ana akışı bloklamamalı)
```
