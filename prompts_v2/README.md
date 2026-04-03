# Pazar.io — Claude API Prompt Sistemi

Bu klasör, Pazar.io — pazaryeri entegrasyon platformunin tüm modüllerini
Claude API üzerinden kod ürettirmek için hazırlanmış prompt setidir.

## Dosya Yapısı

```
prompts/
├── 00_SYSTEM_PROMPT.md          ← Her API çağrısında system olarak gönderilir
├── 01_VERITABANI.md             ← Prisma schema + seed
├── 02_XML_PARSER.md             ← XMLParser + Validator + ChangeDetection
├── 03_FIYAT_MOTORU.md           ← PriceEngine + API endpoints
├── 04_KATEGORI_VE_ADAPTORLER.md ← CategoryService + 4 pazaryeri adaptörü
├── 05_SIPARIS_KARGO.md          ← OrderFetch + StateMachine + CargoAdapters
├── 06_ADMIN_PANEL.md            ← React bileşenleri (5 ekran)
├── 07_PIPELINE_VE_QUEUE.md      ← BullMQ + Pipeline + Refinement
└── prompt_runner.js             ← Otomatik çalıştırma scripti
```

## Çalıştırma Yöntemleri

### Yöntem 1: Manuel (önerilen başlangıç)

Her prompt'u kopyalayıp claude.ai veya API playground'a yapıştır.
Bir önceki yanıtı bir sonraki konuşmaya ekle (context chain).

**Sıra:**
1. `00_SYSTEM_PROMPT.md` → system prompt olarak ayarla
2. `01_VERITABANI.md` → PROMPT 1.1 → yanıt al → PROMPT 1.2 → ...
3. `02_XML_PARSER.md` → aynı sıra

### Yöntem 2: Otomatik Script

```bash
# Kurulum
npm init -y
npm install @anthropic-ai/sdk

# .env
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
echo "OUTPUT_DIR=./generated" >> .env

# Tek modül çalıştır
node prompt_runner.js --module 02

# Tek adım çalıştır (hata düzeltme için)
node prompt_runner.js --module 02 --step 1

# Tümünü çalıştır (dikkatli: çok token tüketir)
node prompt_runner.js --all
```

### Yöntem 3: Cursor IDE Entegrasyonu

Her prompt dosyasını `.cursorrules` ile birleştir:
```bash
cat 00_SYSTEM_PROMPT.md 02_XML_PARSER.md > .cursorrules
```
Ardından Cursor'da `Cmd+K` ile ilgili prompt bloğunu seç ve çalıştır.

---

## Önerilen Geliştirme Sırası

```
Hafta 1:
  01 → Veritabanı şeması + migration + seed
  02 → XMLParser + Validator

Hafta 2:
  03 → Fiyat Motoru
  04 (ilk yarı) → Kategori Motoru

Hafta 3:
  04 (ikinci yarı) → Pazaryeri Adaptörleri
  07 (ilk) → BullMQ Queue yapısı

Hafta 4:
  07 → Ana Pipeline
  05 → Sipariş & Kargo

Hafta 5:
  06 → Admin Panel (React)
  07 → Refinement + Güvenlik taraması
```

---

## Iteratif Geliştirme Döngüsü

Her modül için şu döngüyü uygula:

```
1. Prompt gönder → ilk kod üretimi
      ↓
2. Testleri çalıştır: npx vitest run
      ↓
3. Hatalı testleri listele
      ↓
4. PROMPT 8.3 (Refinement) ile hataları Claude'a gönder
      ↓
5. Düzeltmeleri uygula
      ↓
6. Tüm testler geçiyor mu? → Evet → sonraki modül
                            → Hayır → 3'e dön
```

---

## Token Tüketim Tahmini

| Modül            | Tahmini Input | Tahmini Output | Toplam |
|------------------|--------------|----------------|--------|
| 01 Veritabanı    | ~3K           | ~5K            | ~8K    |
| 02 XML Parser    | ~4K           | ~8K            | ~12K   |
| 03 Fiyat Motoru  | ~3K           | ~6K            | ~9K    |
| 04 Kategori+Adap | ~8K           | ~15K           | ~23K   |
| 05 Sipariş+Kargo | ~6K           | ~12K           | ~18K   |
| 06 Admin Panel   | ~7K           | ~15K           | ~22K   |
| 07 Pipeline+Queue| ~5K           | ~10K           | ~15K   |
| 08 Kategori Özellik  | ~5K       | ~10K           | ~15K      |
| 09 GitHub Deploy     | ~1K       | ~2K            | ~3K       |
| **Toplam**           | **~42K**  | **~83K**       | **~125K** |

Claude Sonnet 4 fiyatı: ~$3/M input + ~$15/M output
Tahmini toplam maliyet: **~$1.2** (tek geçiş, refinement dahil değil)

---


## v1.1 Değişiklikleri (CHG-001 ~ CHG-017)

Bu prompt seti v1.1 ile güncellendi. Önemli değişiklikler:

| CHG | Dosya | Değişiklik |
|-----|-------|------------|
| CHG-002 | 04_KATEGORI_VE_ADAPTORLER.md | N11: SOAP → REST/JSON, SOAP kütüphanesi kaldırıldı |
| CHG-003 | 04_KATEGORI_VE_ADAPTORLER.md | TY: User-Agent header zorunlu (`{sellerId} - SelfIntegration`) |
| CHG-004 | 04_KATEGORI_VE_ADAPTORLER.md | HB: `apiKey/apiSecret` → `merchantId/serviceKey` |
| CHG-007 | 05_SIPARIS_KARGO.md | TY sipariş tarihi: YYYY-MM-DD → epoch ms |
| CHG-011 | 04, 05, 07 | Retry: 3→5, backoff 1→2→4→8→16 sn |
| CHG-014 | 00_SYSTEM_PROMPT.md | Express 5 / Fastify 4 notu |
| CHG-017 | 00, 07 | Bull Board UI eklendi |

## İpuçları

- **Context zincirleme**: Bir modülün çıktısını bir sonraki modüle bağlam olarak ver
  ("Önceki adımda üretilen XMLParser.ts'e bak" ifadesi context'e dahil et)

- **Dosya referansı**: Yanıt üretilince gerçek dosya içeriğini bir sonraki prompt'a ekle
  ("Mevcut src/parser/XMLParser.ts içeriği: [DOSYA İÇERİĞİ]" şeklinde)

- **Refinement döngüsü**: PROMPT 8.3 şablonunu kullan, test hatalarını yapıştır

- **Güvenlik**: PROMPT 8.4'ü her modül tamamlandıktan sonra çalıştır

- **Model seçimi**: Karmaşık mimari kararlar için Opus 4, rutin kod üretimi için Sonnet 4
