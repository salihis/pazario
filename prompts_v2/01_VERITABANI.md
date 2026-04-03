# Modül 1 — Veritabanı Şeması & Migration Promptları

Her prompt Claude API'ye sırayla gönderilir.
Bir sonraki prompt, öncekinin çıktısı üzerine inşa edilir.

---

## PROMPT 1.1 — Prisma Schema (Temel Tablolar)

```
Aşağıdaki PostgreSQL tablolarını Prisma schema.prisma formatında yaz.

### Tablolar

**xml_sources** — XML kaynak tanımları
- id: UUID @id @default(uuid())
- name: String @db.VarChar(100)
- url: String (HTTP GET endpoint)
- fetchTimeoutSec: Int @default(60)
- active: Boolean @default(true)
- createdAt: DateTime @default(now())
- İlişki: SyncJob[], Product[]

**sync_jobs** — Senkronizasyon işleri
- id: UUID
- sourceId: UUID → xml_sources
- status: Enum (PENDING, RUNNING, DONE, FAILED)
- totalProducts: Int?
- changedProducts: Int?
- publishedCount: Int?
- failedCount: Int?
- errorMessage: String?
- startedAt: DateTime?
- finishedAt: DateTime?
- createdAt: DateTime @default(now())

**products** — Ürün kataloğu
- id: UUID
- sourceId: UUID → xml_sources
- externalId: String @db.VarChar(100)
- sku: String @db.VarChar(100)
- barcode: String? @db.VarChar(20)
- title: String @db.VarChar(500)
- description: String? @db.Text
- brand: String? @db.VarChar(100)
- categoryRaw: String? @db.VarChar(500)
- price: Decimal @db.Decimal(12,2)
- listPrice: Decimal? @db.Decimal(12,2)
- currency: String @default("TRY") @db.VarChar(3)
- stock: Int @default(0)
- images: String[] (URL array)
- attributes: Json @default("{}")
- contentHash: String @db.Char(32)
- lastSeenAt: DateTime?
- createdAt: DateTime @default(now())
- updatedAt: DateTime @updatedAt
- @@unique([sourceId, externalId])
- @@index([contentHash])
- @@index([barcode])

**marketplace_listings** — Pazaryeri yayın durumları
- id: UUID
- productId: UUID → products
- marketplace: Enum (TRENDYOL, HEPSIBURADA, N11, PAZARAMA)
- status: Enum (PENDING, PUBLISHED, FAILED, DELISTED)
- externalListingId: String? @db.VarChar(200)
- lastSyncJobId: UUID? → sync_jobs
- publishedAt: DateTime?
- lastUpdatedAt: DateTime?
- hashAtPublish: String? @db.Char(32)
- @@unique([productId, marketplace])
- @@index([status, marketplace])

**publish_errors** — Hata kayıtları
- id: UUID
- jobId: UUID → sync_jobs
- productId: UUID → products
- marketplace: String @db.VarChar(50)
- errorType: Enum (VALIDATION, API, NETWORK, MAPPING)
- errorCode: String? @db.VarChar(50)
- errorMessage: String @db.Text
- retryCount: Int @default(0)
- resolved: Boolean @default(false)
- createdAt: DateTime @default(now())
- @@index([resolved, marketplace])

### Gereksinimler
- PostgreSQL provider kullan
- Her enum için ayrı Prisma enum tanımla
- Tüm foreign key ilişkileri explicit yaz
- @@map ile snake_case tablo adları kullan (xml_sources, sync_jobs vb.)
- Schema başına generator ve datasource bloklarını ekle
```

---

## PROMPT 1.2 — Fiyat ve Kategori Tabloları

```
Mevcut schema.prisma dosyasına aşağıdaki tabloları ekle.

### Yeni Tablolar

**price_rules** — Fiyat kuralları
- id: UUID
- name: String @db.VarChar(150)
- marketplace: String @db.VarChar(50) ("*" = hepsi)
- scopeType: Enum (GLOBAL, MARKETPLACE, CATEGORY, BRAND, PRODUCT)
- scopeValue: String? @db.VarChar(500)
- ekTutar: Decimal @default(0) @db.Decimal(10,2)
- karOrani: Decimal @default(1.0) @db.Decimal(6,4)
- kargo: Decimal @default(0) @db.Decimal(10,2)
- komisyonOrani: Decimal @db.Decimal(5,4)
- priority: Int
- active: Boolean @default(true)
- createdBy: String? @db.VarChar(100)
- createdAt: DateTime @default(now())
- updatedAt: DateTime @updatedAt
- @@index([marketplace, scopeType, active])

**price_calculations** — Fiyat hesaplama audit log
- id: UUID
- productId: UUID → products
- marketplace: String @db.VarChar(50)
- ruleId: UUID → price_rules
- syncJobId: UUID → sync_jobs
- basePrice: Decimal @db.Decimal(12,2)
- ekTutar: Decimal @db.Decimal(10,2)
- karOrani: Decimal @db.Decimal(6,4)
- kargo: Decimal @db.Decimal(10,2)
- komisyonOrani: Decimal @db.Decimal(5,4)
- ara1BaseEk: Decimal @db.Decimal(12,2)
- ara2Kar: Decimal @db.Decimal(12,2)
- ara3Kargo: Decimal @db.Decimal(12,2)
- rawPrice: Decimal @db.Decimal(12,2)
- minPriceApplied: Boolean @default(false)
- finalPrice: Decimal @db.Decimal(12,2)
- calculatedAt: DateTime @default(now())
- @@index([productId, marketplace, calculatedAt(sort: Desc)])

**global_price_settings** — Global minimum fiyat (singleton)
- id: UUID
- minPrice: Decimal @db.Decimal(12,2)
- currency: String @default("TRY") @db.VarChar(3)
- updatedBy: String? @db.VarChar(100)
- updatedAt: DateTime @updatedAt

**category_mappings** — Kategori eşleştirme merkezi
- id: UUID
- sourceId: UUID → xml_sources
- sourceCategory: String @db.Text
- marketplace: Enum (4 pazar)
- marketplaceCategoryId: String? @db.VarChar(100)
- marketplaceCategoryPath: String? @db.Text
- status: Enum (PENDING, APPROVED, REJECTED)
- aiSuggested: Boolean @default(false)
- aiConfidence: Decimal? @db.Decimal(4,3)
- aiReason: String? @db.Text
- allSuggestions: Json?
- approvedBy: String? @db.VarChar(100)
- approvedAt: DateTime?
- createdAt: DateTime @default(now())
- updatedAt: DateTime @updatedAt
- @@unique([sourceId, sourceCategory, marketplace])
- @@index([marketplace, status])

**marketplace_categories** — Pazaryeri kategori ağacı cache
- id: UUID
- marketplace: Enum (4 pazar)
- categoryId: String @db.VarChar(100)
- categoryPath: String @db.Text
- categoryName: String @db.VarChar(500)
- parentId: String? @db.VarChar(100)
- isLeaf: Boolean @default(true)
- fetchedAt: DateTime
- @@unique([marketplace, categoryId])
```

---

## PROMPT 1.3 — Sipariş ve Kargo Tabloları

```
Mevcut schema.prisma dosyasına sipariş ve kargo tablolarını ekle.

### Sipariş Tabloları

**orders**
- id: UUID
- marketplace: Enum (4 pazar)
- marketplaceOrderId: String @db.VarChar(100) @unique
- marketplaceOrderNo: String? @db.VarChar(100)
- status: Enum (NEW, PENDING_APPROVAL, PREPARING, LABEL_CREATED, SHIPPED,
                IN_TRANSIT, DELIVERED, COMPLETED, CANCELLATION_REQUESTED,
                CANCELLED, RETURN_REQUESTED, RETURN_APPROVED, REFUNDED)
- customerName: String? @db.VarChar(200) — AES şifreli
- customerPhone: String? @db.VarChar(20) — AES şifreli
- shippingAddress: Json? — AES şifreli
- billingAddress: Json? — AES şifreli
- totalAmount: Decimal @db.Decimal(12,2)
- currency: String @default("TRY") @db.VarChar(3)
- cargoCompany: String? @db.VarChar(50)
- trackingNumber: String? @db.VarChar(100)
- cargoLabelUrl: String? @db.Text
- invoiceId: UUID? → invoices
- approvedBy: String? @db.VarChar(100)
- approvedAt: DateTime?
- fetchedAt: DateTime
- createdAt: DateTime @default(now())
- updatedAt: DateTime @updatedAt
- @@index([status, marketplace])

**order_items**
- id: UUID
- orderId: UUID → orders
- productId: UUID? → products
- marketplaceProductId: String? @db.VarChar(100)
- sku: String? @db.VarChar(100)
- title: String @db.VarChar(500)
- quantity: Int
- unitPrice: Decimal @db.Decimal(12,2)
- totalPrice: Decimal @db.Decimal(12,2)
- vatRate: Int?

**order_status_logs**
- id: UUID
- orderId: UUID → orders
- fromStatus: String? @db.VarChar(50)
- toStatus: String @db.VarChar(50)
- changedBy: String? @db.VarChar(100)
- note: String? @db.Text
- createdAt: DateTime @default(now())

**invoices**
- id: UUID
- orderId: UUID → orders @unique
- invoiceType: Enum (INVOICE, CREDIT_NOTE)
- invoiceNumber: String? @db.VarChar(100)
- externalInvoiceId: String? @db.VarChar(100)
- pdfUrl: String? @db.Text
- totalAmount: Decimal @db.Decimal(12,2)
- issuedAt: DateTime?
- createdAt: DateTime @default(now())

### Kargo Tabloları

**shipments**
- id: UUID
- orderId: UUID → orders @unique
- cargoCompany: Enum (ARAS, YURTICI, SURAT, PTT)
- trackingNumber: String @db.VarChar(100)
- labelPdfUrl: String? @db.Text
- desi: Decimal? @db.Decimal(6,2)
- weightKg: Decimal? @db.Decimal(6,3)
- status: String @db.VarChar(50) @default("CREATED")
- rawStatus: String? @db.VarChar(100)
- statusDescription: String? @db.Text
- lastLocation: String? @db.VarChar(200)
- estimatedDelivery: DateTime?
- deliveredAt: DateTime?
- lastCheckedAt: DateTime?
- marketplaceNotifiedAt: DateTime?
- createdAt: DateTime @default(now())

**cargo_company_mappings**
- id: UUID
- cargoCompany: Enum (ARAS, YURTICI, SURAT, PTT)
- marketplace: Enum (4 pazar)
- marketplaceCargoCode: String @db.VarChar(50)
- marketplaceCargoName: String? @db.VarChar(100)
- @@unique([cargoCompany, marketplace])

### Görev
- Tüm bu tabloları mevcut şemaya ekle
- Sipariş status geçiş validasyonunu Prisma middleware olarak yaz:
  geçersiz status geçişini engelle (NEW→SHIPPED doğrudan geçiş yasak)
- migration dosyasını da oluştur: prisma migrate dev --name add_orders_cargo
```

---

## PROMPT 1.4 — Seed Verisi

```
Aşağıdaki seed.ts dosyasını yaz. Bu dosya prisma db seed komutuyla çalışacak.

### Seed İçeriği

1. **global_price_settings** — min fiyat 50 TRY
2. **cargo_company_mappings** — 4 kargo × 4 pazaryeri = 16 satır:
   - Aras: Trendyol='ARAS', HB='ArasKargo', N11='10', Pazarama='ARAS'
   - Yurtiçi: Trendyol='YURTICI', HB='YurticiKargo', N11='12', Pazarama='YK'
   - Sürat: Trendyol='SURAT', HB='SuratKargo', N11='6', Pazarama='SURAT'
   - PTT: Trendyol='PTT', HB='PttKargo', N11='8', Pazarama='PTT'
3. **users** (SUPER_ADMIN):
   - email: admin@example.com
   - şifre: bcrypt hash (Admin123!@#)
   - rol: SUPER_ADMIN
4. **xml_sources** örnek kayıt:
   - name: 'Tedarikçi A (Örnek)'
   - url: 'https://example.com/feed.xml'
   - active: false (gerçek URL ile aktifleştirilmeli)

### Gereksinimler
- idempotent olsun: zaten varsa güncelleme yapmasın (upsert kullan)
- Türkçe yorum satırları ekle
- Her seed grubu try/catch ile sarmalı, hata loglanmalı ama durmamalı
```
