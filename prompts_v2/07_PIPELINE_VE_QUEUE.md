# Modül 8 — Ana Pipeline, Queue & Refinement Promptları

---

## PROMPT 8.1 — BullMQ Queue Yapısı

```
src/queue/ klasöründe aşağıdaki dosyaları yaz.

### Queue Tanımları (src/queue/queues.ts)

import { Queue } from 'bullmq'
import { redis } from '../utils/redis'

export const syncQueue = new Queue('sync', { connection: redis })
export const publishQueue = new Queue('publish', { connection: redis })
export const cargoQueue = new Queue('cargo', { connection: redis })
export const orderFetchQueue = new Queue('order-fetch', { connection: redis })
export const notifyQueue = new Queue('notify', { connection: redis })

### Job Tipleri (src/queue/jobs.ts)

type SyncJobData = { sourceId: string; triggeredBy: 'cron' | 'manual'; userId?: string }
type PublishJobData = { productId: string; marketplace: Marketplace; syncJobId: string }
type CargoJobData = { orderId: string; action: 'create_label' | 'notify_marketplace' | 'check_status' }
type OrderFetchJobData = { marketplace: Marketplace | 'all' }
type NotifyJobData = { type: 'slack' | 'email'; message: string; level: 'info' | 'warn' | 'error' }

### Worker'lar (her biri ayrı dosya)

src/queue/workers/syncWorker.ts
  - syncQueue worker
  - concurrency: 1 (tek seferde bir sync)
  - Her adım:
    1. XML fetch (timeout: 60sn)
    2. XMLParser.parse()
    3. ChangeDetectionService.detect()
    4. ProductValidator.validateAll() → geçersizleri yayınlama
    5. PriceEngine.calculateBatch()
    6. CategoryMappingService.resolveAll()
    7. Her ürün için publishQueue'ya iş ekle (batch: 100)
    8. sync_jobs kaydını güncelle

src/queue/workers/publishWorker.ts
  - publishQueue worker
  - concurrency: 4 (paralel yayın)
  - Rate limit: bulkhead pattern ile adaptör başına max 10 aktif iş

src/queue/workers/cargoWorker.ts
  - cargoQueue worker
  - create_label → CargoService.createLabel()
  - notify_marketplace → CargoService.notifyMarketplace()
  - check_status → CargoService.pollStatus()

src/queue/workers/orderFetchWorker.ts
  - orderFetchQueue worker
  - Cron: her 5 dakikada bir (cron: '*/5 * * * *')
  - OrderFetchService.fetchAll()

### Hata Yönetimi (tüm worker'lar için ortak)
- maxRetries: 3
- Backoff: exponential (1sn, 2sn, 4sn)
- Tüm retryleri bitince: dead letter'a al (publish_errors tablosuna yaz) + notify slack

### Cron Scheduler (src/queue/scheduler.ts)
- Gece 03:00–05:00 arası sync penceresi:
  new CronJob('0 3 * * *', () => syncQueue.add('scheduled-sync', ...))
- Her 5dk order fetch:
  new CronJob('*/5 * * * *', () => orderFetchQueue.add('fetch-all', { marketplace: 'all' }))
- Her 2 saat kargo durum kontrolü:
  new CronJob('0 */2 * * *', () => cargoQueue.add('check-all-status', ...))

### Test (Vitest)
- syncWorker: XMLParser hatası → job FAILED, sync_jobs güncellenmeli
- publishWorker: rate limit → backoff ile tekrar denenmeli
- cargoWorker: notify başarısız → retry + dead letter
- Cron trigger: doğru saatte iş oluşturulmalı
```

---

## PROMPT 8.2 — Ana Pipeline Orkestratörü

```
src/MarketplacePipeline.ts dosyasını yaz.

### Sorumluluk
Sync job'ını uçtan uca yöneten ana orchestrator.
BullMQ worker içinden çağrılır.

class MarketplacePipeline {
  constructor(
    private parser: XMLParser,
    private validator: ProductValidator,
    private changeDetector: ChangeDetectionService,
    private priceEngine: PriceEngine,
    private categoryMapper: CategoryMappingService,
    private adapters: Record<Marketplace, BaseAdapter>
  )

  async run(syncJobId: string): Promise<PipelineResult>
}

### run() Adımları
1. sync_jobs.status = RUNNING, startedAt = now()
2. xml_sources'tan URL'yi çek
3. XMLParser.parse(xml) → ParseResult
4. Hata varsa: FAILED + errorMessage
5. ChangeDetectionService.detect()
   → newProducts + changedProducts birleştir → toProcess
   → unchangedIds: lastSeenAt güncelle (batch updateMany)
6. Her ürün için:
   a. Validator.validateAll() → geçersizler publishErrors'a yaz, atla
   b. PriceEngine.calculateBatch() → 4 pazaryeri için fiyat
   c. CategoryMapper.resolveCategory() → her pazaryeri için
7. Yayınlanacak ürünler publishQueue'ya ekle (batch 100)
8. sync_jobs.status = DONE, finishedAt = now(), counts güncelle
9. Hata sayısı > eşik (%20) → notify slack

### PipelineResult
interface PipelineResult {
  syncJobId: string
  totalFetched: number
  newProducts: number
  changedProducts: number
  unchanged: number
  published: number
  failed: number
  skippedValidation: number
  durationMs: number
}

### Graceful Shutdown
- SIGTERM → aktif işi tamamla, yeni iş alma
- SIGKILL → sync_jobs.status = INTERRUPTED

### Test (Vitest — tüm bağımlılıklar mock)
- Başarılı akış → DONE status + doğru sayılar
- XMLParser hatası → FAILED + errorMessage
- Kısmi hata (%10 ürün) → DONE, failedCount doğru
- Eşik aşımı (%30 hata) → slack bildirimi tetiklenmeli
```

---

## PROMPT 8.3 — Iteratif Refinement: Hata Geliştirme

```
Bir önceki adımda oluşturulan [DOSYA ADI] kodunu incele.

### Tespit edilen sorunlar:

[BURAYA TESTLERDEN GELEN HATALARI YAZ — örnek:]
1. XMLParser: "1.299,99 TL" formatını 1.29999 olarak parse ediyor, doğrusu 1299.99
2. PriceEngine: komisyon_orani=0 durumunda ZeroDivisionError (sonsuz sonuç)
3. TrendyolAdapter: User-Agent header encode edilmiyor, Türkçe karakter sorunu
4. ChangeDetectionService: 1000 ürün için N+1 sorgu yapıyor
5. OrderStateMachine: eş zamanlı iki onay için race condition var

### Her sorun için:
a. Hatanın kök nedeni nedir?
b. Düzeltilmiş kod bloğunu göster (tüm dosyayı değil, sadece değişen kısmı)
c. Bu hatayı yakalayan Vitest test case'ini yaz
d. Benzer edge case'ler var mı? (bono: önce test yaz, sonra düzelt)

### Düzeltme Kuralları
- Mevcut interface'leri değiştirme
- Geriye dönük uyumluluk bozma
- Her düzeltme isolated, bağımsız olsun

### Onay Kriteri
Tüm testler geçtikten sonra bir sonraki modüle geç.
```

---

## PROMPT 8.4 — Kod Review ve Güvenlik Taraması

```
Aşağıdaki dosyaları güvenlik açısından incele:
[DOSYALAR LİSTESİ]

### Kontrol Listesi

**Injection Riskleri**
- SQL injection: tüm DB sorguları parameterized mi?
- NoSQL injection: JSON alanları sanitize ediliyor mu?
- Command injection: exec/spawn kullanılıyor mu?

**Kimlik Doğrulama & Yetkilendirme**
- JWT secret environment'tan mı geliyor?
- Token expiry kontrol ediliyor mu?
- Role kontrolü middleware'de mi, controller'da mı?

**Hassas Veri**
- API key'ler loglara düşüyor mu?
- customerName/phone şifresiz kaydediliyor mu?
- Error response'larda stack trace dönüyor mu (production'da)?

**Rate Limiting**
- Tüm public endpoint'lerde rate limit var mı?
- Pazaryeri API'leri rate limit aşılmasına karşı korunuyor mu?

**Bağımlılık Güvenliği**
- npm audit çıktısını göster
- Kritik/yüksek riskli bağımlılık var mı?

### Çıktı Formatı
Her bulgu için:
  SEVERITY: CRITICAL | HIGH | MEDIUM | LOW
  FILE: src/...
  LINE: X
  ISSUE: açıklama
  FIX: düzeltilmiş kod
```
