# Modül 2 — XML Parser & Validator Promptları

---

## PROMPT 2.1 — XML Parser (Temel)

```
src/parser/XMLParser.ts dosyasını yaz.

### Sorumluluk
XML string'i parse edip normalize edilmiş ürün dizisi döndürür.

### Interface Tanımları (önce bunları yaz)

interface ParsedProduct {
  id: string
  sku: string
  barcode: string | null
  title: string
  description: string | null
  brand: string | null
  category: string | null
  price: number
  listPrice: number | null
  currency: string
  stock: number
  images: string[]
  attributes: Record<string, string>
  contentHash: string  // MD5(id + price + stock + title)
}

interface ParseResult {
  products: ParsedProduct[]
  meta: {
    totalNodes: number
    parsed: number
    failed: number
    durationMs: number
    feedType: 'RSS_SHOPPING' | 'ATOM' | string
  }
  errors: ParseError[]
}

interface ParseError {
  type: 'ERROR' | 'WARN'
  code: string
  message: string
  raw?: unknown
}

### Desteklenecek XML Formatları (sırayla dene)
1. Google Shopping RSS: rss.channel.item[]
2. Atom feed: feed.entry[]
3. <products><product>[] — custom
4. <catalog><item>[] — custom
5. <items><product>[] — custom
6. Root array — fallback

### Fiyat Parse Kuralları
- "1.299,99 TL" → 1299.99 (Türk formatı)
- "1299.99 TRY" → 1299.99
- "TL" → "TRY" dönüşümü
- Parse edilemeyen fiyat → null (hata değil, sadece log)

### Encoding Düzeltme
- XML declaration'daki encoding değerini UTF-8 olarak güncelle
- Bare & karakterlerini &amp; yap (XML entity hariç)
- Null byte temizle (\x00)

### Gereksinimler
- fast-xml-parser v4 kullan
- parseAttributeValue: true
- isArray callback: item, product, offer, entry her zaman array
- removeNSPrefix: true (Google namespace temizleme)
- Stream modu: 50MB+ dosyalarda SAX parser'a geç (parseStream metodu)
- contentHash: crypto.createHash('md5') ile üret
- Hata fırlatma: XMLParseError extends Error sınıfı

### Test (Vitest)
- Google Shopping RSS formatı parse testi
- Custom <products> formatı testi
- Türk fiyat formatı parse testi ("1.299,99 TL" → 1299.99)
- Bozuk XML → XMLParseError fırlatma testi
- Boş feed → empty array, EMPTY_FEED warn testi
- HTML entity temizleme testi (&amp; → &)
```

---

## PROMPT 2.2 — Ürün Validatörü

```
Bir önceki adımda üretilen XMLParser.ts dosyasına bak.
Şimdi src/validators/ProductValidator.ts dosyasını yaz.

### Pazaryeri Kuralları

interface MarketplaceRules {
  required: string[]
  maxTitleLength: number
  maxDescriptionLength: number
  minPrice: number
  minImages: number
  maxImages: number
}

Aşağıdaki kuralları implement et:

TRENDYOL:
  required: ['title', 'barcode', 'price', 'stock', 'brand', 'images', 'category']
  maxTitleLength: 250, minImages: 1, maxImages: 8
  barcode format: /^[0-9]{8,13}$/

HEPSIBURADA:
  required: ['title', 'sku', 'price', 'stock', 'images', 'category']
  maxTitleLength: 255, minImages: 1, maxImages: 10
  sku format: /^[a-zA-Z0-9\-_]{1,50}$/

N11:
  required: ['title', 'price', 'stock', 'images', 'category', 'description']
  description min length: 50 karakter
  maxTitleLength: 200, minImages: 1, maxImages: 5

PAZARAMA:
  required: ['title', 'barcode', 'price', 'stock', 'brand', 'images']
  maxTitleLength: 300, minImages: 1, maxImages: 10
  barcode format: /^[0-9]{8,14}$/

### validate() Dönüş Tipi
interface ValidationResult {
  valid: boolean
  errors: string[]    // bloklayan hatalar
  warnings: string[]  // uyarılar (devam edilebilir)
}

### Kalite Kontrolleri (her pazaryeri için)
- Başlıkta HTML tag varsa → warning
- Açıklama sadece noktalama içeriyorsa → warning
- HTTP görsel URL varsa (HTTPS değil) → warning
- Stok 0 ise → warning (pasif yüklenecek)
- Fiyat > 1.000.000 ise → warning (kontrol et)

### validateAll(product, marketplaces[])
Tüm pazaryerleri için tek seferde sonuç döndür:
Record<string, ValidationResult>

### Test (Vitest)
- Geçerli ürün tüm pazaryerlerini geçmeli
- Eksik barcode Trendyol'da hata vermeli
- Negatif fiyat reddedilmeli
- Sıfır görsel hata vermeli
- 260 karakter başlık Trendyol'da hata vermeli (max 250)
- Geçersiz barkod format Pazarama'da hata vermeli
- N11 kısa description hata vermeli (<50 karakter)
```

---

## PROMPT 2.3 — Hash Tabanlı Değişim Tespiti

```
src/services/ChangeDetectionService.ts dosyasını yaz.

### Amaç
XML'den gelen ürünleri veritabanındaki mevcut ürünlerle karşılaştırarak
yalnızca değişen ürünleri tespit et. Bu hem gereksiz API çağrısını önler
hem de hızı artırır.

### Algorithm
1. products tablosundan (sourceId, externalId) → contentHash map'i çek (tek sorgu)
2. Gelen her ParsedProduct için:
   a. externalId ile map'te ara
   b. Bulunamazsa → YENİ ürün
   c. Bulunursa ve hash farklıysa → DEĞİŞMİŞ ürün
   d. Hash aynıysa → DEĞİŞMEMİŞ (sadece lastSeenAt güncelle)
3. Veritabanında olan ama XML'de olmayan ürünleri bul → SİLİNMİŞ

### Dönüş Tipi
interface ChangeDetectionResult {
  newProducts: ParsedProduct[]
  changedProducts: Array<{ product: ParsedProduct; existingId: string }>
  unchangedIds: string[]      // sadece lastSeenAt güncellenecek
  deletedExternalIds: string[] // 30 gün sonra delisted yapılacak
}

### Veritabanı Optimizasyonu
- N+1 sorgusu yapma: tek sorguda tüm hash'leri çek
- Batch upsert: Prisma transaction içinde createMany + updateMany kullan
- Batch size: 500 kayıt (yapılandırılabilir)

### Test (Vitest)
- Yeni ürün doğru tespit edilmeli
- Hash değişince CHANGED dönmeli
- Hash aynıysa UNCHANGED dönmeli
- DB'de var XML'de yok → DELETED dönmeli
- Büyük batch (1000 ürün) performans testi: < 2 saniye
```
