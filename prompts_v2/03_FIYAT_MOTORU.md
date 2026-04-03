# Modül 3 — Fiyat Motoru Promptları

---

## PROMPT 3.1 — Fiyat Hesaplama Servisi

```
src/services/PriceEngine.ts dosyasını yaz.

### Kesin Formül (değiştirilemez)
Satış Fiyatı = ROUND(
  ( (base_price + ek_tutar) * kar_orani + kargo )
  / (1 - komisyon_orani)
, 2)

### Adım Adım
ara1 = base_price + ek_tutar
ara2 = ara1 * kar_orani
ara3 = ara2 + kargo
raw  = ara3 / (1 - komisyon_orani)
final = Math.round(raw * 100) / 100

### PriceEngine.calculate() Metodu

Input:
interface PriceInput {
  basePrice: number        // XML'den gelen KDV hariç fiyat
  marketplace: Marketplace // 'TRENDYOL' | 'HEPSIBURADA' | 'N11' | 'PAZARAMA'
  productId: string
  syncJobId: string
}

Output:
interface PriceCalculationResult {
  ruleId: string
  ruleName: string
  basePrice: number
  ekTutar: number
  karOrani: number
  kargo: number
  komisyonOrani: number
  ara1BaseEk: number
  ara2Kar: number
  ara3Kargo: number
  rawPrice: number
  minPriceApplied: boolean
  finalPrice: number
}

### Kural Seçim Mantığı (first-match-wins, priority ASC)
Öncelik sırası:
1. scope: PRODUCT + productId eşleşmesi
2. scope: BRAND + brand eşleşmesi
3. scope: CATEGORY + category içeriyorsa eşleşme (LIKE '%value%')
4. scope: MARKETPLACE + marketplace eşleşmesi
5. scope: GLOBAL (her zaman eşleşir)

### Global Minimum Fiyat
- finalPrice < globalMinPrice → finalPrice = globalMinPrice + minPriceApplied = true
- finalPrice <= 0 → PriceCalculationError fırlat

### Audit Log
Her hesaplama price_calculations tablosuna yazılmalı (tüm ara adımlarla)

### calculateBatch(inputs: PriceInput[]) → Map<string, PriceCalculationResult>
Aynı anda birden fazla ürün × pazaryeri hesaplaması için

### Test (Vitest)
- Temel formül doğruluğu: base=200, ek=10, kar=1.25, kargo=15, kom=0.15 → 326.47
- Komisyon neden bölme: 277.50 / 0.85 = 326.47 (çarpma değil)
- Global min fiyat uygulandığında minPriceApplied=true
- Kural bulunamazsa PriceRuleNotFoundError fırlatmalı
- kar_orani < 1.0 → InvalidRuleError
- Her pazaryeri için farklı kural seçimi testi
```

---

## PROMPT 3.2 — Fiyat Motoru API Endpoint'leri

```
src/api/routes/price.routes.ts ve src/api/controllers/price.controller.ts dosyalarını yaz.

### Endpoint'ler

GET /price-rules
  Query: ?marketplace=&scopeType=&active=true&page=1&limit=25
  Response: { data: PriceRule[], meta: { total, page, limit } }

POST /price-rules
  Body: { name, marketplace, scopeType, scopeValue?, ekTutar, karOrani, kargo, komisyonOrani, priority }
  Validation (zod):
    - karOrani: min 1.0, max 9.9999
    - komisyonOrani: min 0, max 0.99
    - priority: positive integer
  Response: 201 Created + created rule

PUT /price-rules/:ruleId
  Body: aynı alanlar (partial)
  Response: updated rule

DELETE /price-rules/:ruleId (soft delete: active=false)
  Response: 200 { success: true }

POST /price-rules/simulate
  Body: { basePrice, ekTutar, karOrani, kargo, komisyonOrani }
  Response:
  {
    success: true,
    data: {
      ara1BaseEk: number,
      ara2Kar: number,
      ara3Kargo: number,
      rawPrice: number,
      finalPrice: number,
      minPriceApplied: boolean
    }
  }
  NOT: DB kaydı oluşturma, sadece hesapla

GET /price-rules/preview/:productId
  Ürün için 4 pazaryerinin fiyatını hesapla ve döndür
  Response: { productId, basePrice, results: [{marketplace, ruleName, finalPrice, minApplied}] }

GET /price-settings
  Response: { minPrice, currency, updatedAt }

PUT /price-settings
  Body: { minPrice: number }
  Validation: minPrice > 0
  Side effect: etkilenen ürünlerin hashAtPublish'ini sıfırla (arka planda)

GET /price-calculations
  Query: ?productId=&marketplace=&syncJobId=&page=&limit=
  Response: paginated audit log

### Middleware
- requireAuth: JWT doğrulama
- requireRole('ADMIN'): sadece admin erişebilir
- validateBody(schema): zod validation

### Test (Vitest + supertest)
- POST /simulate doğru hesaplama yapmalı
- karOrani < 1 → 400 Bad Request
- komisyonOrani > 0.99 → 400 Bad Request
- GET /preview/:productId → 4 pazaryeri sonucu dönmeli
```
