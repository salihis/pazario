#!/usr/bin/env node
/**
 * Pazar.io — Prompt Runner v2
 *
 * Özellikler:
 *   --parallel   Tüm modülleri aynı anda çalıştır (Worker threads)
 *   --tdd        Her modülde önce test prompt'unu gönder, sonra implement
 *   --module 02  Tek modül
 *   --step 1     Tek adım
 *   --all        Sıralı, tüm modüller
 *
 * Kullanım:
 *   node prompt_runner_v2.js --parallel --tdd
 *   node prompt_runner_v2.js --module 04 --tdd
 *   node prompt_runner_v2.js --all
 *
 * Env:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   OUTPUT_DIR=./generated
 *   MAX_PARALLEL=4        (varsayılan: 3)
 *   MODEL=claude-sonnet-4-20250514
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Yapılandırma ──────────────────────────────────────────────────────────
const CONFIG = {
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
  maxTokens: 8192,
  promptsDir: path.join(__dirname),
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, '..', 'generated'),
  systemPromptFile: '00_SYSTEM_PROMPT.md',
  maxParallel: parseInt(process.env.MAX_PARALLEL || '3'),
}

// ── Modül Tanımları ───────────────────────────────────────────────────────
const MODULES = {
  '01': { file: '01_VERITABANI.md',                  name: 'Veritabanı & Migration',          priority: 1 },
  '02': { file: '02_XML_PARSER.md',                   name: 'XML Parser & Validator',           priority: 2 },
  '03': { file: '03_FIYAT_MOTORU.md',                 name: 'Fiyat Motoru',                     priority: 2 },
  '04': { file: '04_KATEGORI_VE_ADAPTORLER.md',       name: 'Kategori + Pazaryeri Adaptörleri', priority: 2 },
  '05': { file: '05_SIPARIS_KARGO.md',                name: 'Sipariş & Kargo',                  priority: 3 },
  '06': { file: '06_ADMIN_PANEL.md',                  name: 'Admin Panel (React)',               priority: 3 },
  '07': { file: '07_PIPELINE_VE_QUEUE.md',            name: 'Pipeline & BullMQ',                priority: 3 },
  '08': { file: '08_KATEGORI_OZELLIK_GONDERIM.md',    name: 'Kategori Özellik & Gönderim',      priority: 4 },
  '09': { file: '09_GITHUB_DEPLOY.md',                name: 'GitHub Pages Deploy',              priority: 4 },
}

// Paralel çalıştırmada öncelik 1 (DB) önce, sonra 2'ler birlikte, vb.
const PRIORITY_GROUPS = {
  1: ['01'],
  2: ['02', '03', '04'],
  3: ['05', '06', '07'],
  4: ['08', '09'],
}

// ── TDD Prompt Eklentisi ──────────────────────────────────────────────────
/**
 * TDD modunda her prompt'tan önce eklenen prefix.
 * Claude'u önce test yazmaya, sonra implement etmeye yönlendirir.
 */
const TDD_PREFIX = `
ÇALIŞMA MODU: TDD (Test-Driven Development)

Aşağıdaki görevi şu KESIN sırayla yap:

1. ÖNCE testleri yaz (Vitest)
   - Her public fonksiyon/metod için en az 3 test case
   - Happy path, edge case, hata senaryosu
   - Mock'ları tanımla (DB, API çağrıları vb.)
   - Testler başlangıçta FAIL etmeli (implementasyon yok henüz)

2. SONRA implementasyonu yaz
   - Testleri geçirecek minimum kod
   - Sonra refactor et
   - Her test geçtikten sonra bir sonrakine geç

3. Dosya yapısı:
   src/{modül}/{DosyaAdı}.ts          ← implementasyon
   src/{modül}/{DosyaAdı}.test.ts     ← testler

4. Test çalıştırma komutu göster:
   npx vitest run src/{modül}/{DosyaAdı}.test.ts

---
GÖREV:
`

// ── Prompt Parser ─────────────────────────────────────────────────────────
function parsePrompts(markdown) {
  const prompts = []
  const lines = markdown.split('\n')
  let inBlock = false
  let blockLines = []
  let stepNum = 0

  for (const line of lines) {
    if (line.startsWith('## PROMPT')) {
      stepNum++
    }
    if (line === '```' && !inBlock) {
      inBlock = true
      blockLines = []
    } else if (line === '```' && inBlock) {
      inBlock = false
      if (blockLines.length > 10) { // çok kısa blokları atla
        prompts.push({ index: stepNum, content: blockLines.join('\n').trim() })
      }
    } else if (inBlock) {
      blockLines.push(line)
    }
  }
  return prompts
}

// ── API Çağrısı ───────────────────────────────────────────────────────────
async function callClaude(client, systemPrompt, messages, moduleId, step) {
  const start = Date.now()
  try {
    const response = await client.messages.create({
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      system: systemPrompt,
      messages,
    })
    const duration = ((Date.now() - start) / 1000).toFixed(1)
    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
    return { text, duration, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
  } catch (err) {
    if (err.status === 429) {
      console.log(`  ⏳ [${moduleId}] Rate limit — 30sn bekleniyor...`)
      await sleep(30000)
      return callClaude(client, systemPrompt, messages, moduleId, step)
    }
    throw err
  }
}

// ── Kod Kayıt ─────────────────────────────────────────────────────────────
async function saveOutput(response, moduleId, stepNum, outputDir) {
  const moduleDir = path.join(outputDir, `module_${moduleId}`)
  await fs.mkdir(moduleDir, { recursive: true })

  // Ham yanıt
  const rawPath = path.join(moduleDir, `step_${stepNum}_response.md`)
  await fs.writeFile(rawPath, response)

  // TypeScript dosyaları — src/... yolu olan blokları çıkar
  const codeBlocks = [...response.matchAll(/```(?:typescript|ts|javascript|js|prisma|sql)?\n([\s\S]*?)```/g)]
  const savedFiles = []

  for (const [, code] of codeBlocks) {
    // Dosya yolu yorumu: // src/parser/XMLParser.ts
    const pathMatch = code.match(/^\/\/ (src\/[^\s]+\.(ts|tsx|js|jsx|prisma|sql))\n/)
    if (pathMatch) {
      const filePath = path.join(outputDir, pathMatch[1])
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, code.replace(pathMatch[0], '').trim())
      savedFiles.push(pathMatch[1])
    }
  }

  if (savedFiles.length === 0) {
    // Dosya yolu bulunamadıysa tek blok olarak kaydet
    const fallback = path.join(moduleDir, `step_${stepNum}_output.ts`)
    if (codeBlocks.length > 0) {
      await fs.writeFile(fallback, codeBlocks[0][1].trim())
      savedFiles.push(fallback)
    }
  }

  return savedFiles
}

// ── Tek Modül Çalıştır ────────────────────────────────────────────────────
async function runModule(client, moduleId, systemPrompt, opts = {}) {
  const { stepFilter = null, tdd = false } = opts
  const module = MODULES[moduleId]
  if (!module) throw new Error(`Modül bulunamadı: ${moduleId}`)

  const label = `[${moduleId}] ${module.name}`
  console.log(`\n${'─'.repeat(55)}`)
  console.log(`📦 ${label}${tdd ? ' [TDD]' : ''}`)
  console.log('─'.repeat(55))

  const promptFile = await fs.readFile(
    path.join(CONFIG.promptsDir, module.file), 'utf-8'
  )
  const prompts = parsePrompts(promptFile)
  const conversationHistory = []
  const outputDir = CONFIG.outputDir
  let totalInputTokens = 0
  let totalOutputTokens = 0

  for (let i = 0; i < prompts.length; i++) {
    const stepNum = i + 1
    if (stepFilter !== null && stepFilter !== stepNum) continue

    const prompt = prompts[i]
    const userContent = tdd ? TDD_PREFIX + prompt.content : prompt.content

    console.log(`\n  ⚡ ${label} — Adım ${stepNum}/${prompts.length}`)

    conversationHistory.push({ role: 'user', content: userContent })

    try {
      const result = await callClaude(client, systemPrompt, conversationHistory, moduleId, stepNum)

      conversationHistory.push({ role: 'assistant', content: result.text })

      const savedFiles = await saveOutput(result.text, moduleId, stepNum, outputDir)

      totalInputTokens  += result.inputTokens
      totalOutputTokens += result.outputTokens

      console.log(`  ✅ ${result.duration}s | in:${result.inputTokens} out:${result.outputTokens} tokens`)
      savedFiles.forEach(f => console.log(`     📄 ${f}`))

      // Adımlar arası bekleme (rate limit)
      if (i < prompts.length - 1) await sleep(2000)

    } catch (err) {
      console.error(`  ❌ Adım ${stepNum} başarısız: ${err.message}`)
      // Devam et — sonraki adım bağlamı olmadan çalışır
    }
  }

  console.log(`\n  📊 ${label} tamamlandı — toplam: in:${totalInputTokens} out:${totalOutputTokens} token`)
  return { moduleId, totalInputTokens, totalOutputTokens }
}

// ── Paralel Çalıştırma ────────────────────────────────────────────────────
async function runParallel(client, systemPrompt, opts) {
  const results = []
  let grand = { input: 0, output: 0 }

  for (const [priority, moduleIds] of Object.entries(PRIORITY_GROUPS).sort()) {
    console.log(`\n${'═'.repeat(55)}`)
    console.log(`🚀 Öncelik ${priority} — Paralel: [${moduleIds.join(', ')}]`)
    console.log('═'.repeat(55))

    // Öncelik grubunu paralel çalıştır (max MAX_PARALLEL aynı anda)
    const chunks = chunk(moduleIds, CONFIG.maxParallel)
    for (const batch of chunks) {
      const batchResults = await Promise.allSettled(
        batch.map(id => runModule(client, id, systemPrompt, opts))
      )
      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          results.push(r.value)
          grand.input  += r.value.totalInputTokens
          grand.output += r.value.totalOutputTokens
        } else {
          console.error(`\n❌ Modül başarısız: ${r.reason?.message}`)
        }
      }
    }

    // Öncelik grupları arasında bekleme
    if (priority < Math.max(...Object.keys(PRIORITY_GROUPS))) {
      console.log('\n  ⏸  Sonraki öncelik grubuna geçmeden önce 5sn bekleniyor...')
      await sleep(5000)
    }
  }

  return { results, grand }
}

// ── Yardımcı ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size))

// ── Maliyet Hesabı ────────────────────────────────────────────────────────
function estimateCost(inputTokens, outputTokens) {
  // Claude Sonnet 4: $3/M input, $15/M output
  const cost = (inputTokens / 1e6 * 3) + (outputTokens / 1e6 * 15)
  return cost.toFixed(3)
}

// ── Ana Fonksiyon ─────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY env değişkeni gerekli')
    process.exit(1)
  }

  const client = new Anthropic({ apiKey })

  // System prompt oku
  const systemRaw = await fs.readFile(
    path.join(CONFIG.promptsDir, CONFIG.systemPromptFile), 'utf-8'
  )
  const systemPrompt = systemRaw.match(/```\n([\s\S]*?)```/)?.[1]?.trim() || systemRaw

  await fs.mkdir(CONFIG.outputDir, { recursive: true })

  const args = process.argv.slice(2)
  const parallelMode = args.includes('--parallel')
  const tddMode = args.includes('--tdd')
  const allMode = args.includes('--all')
  const moduleFlag = args.indexOf('--module')
  const stepFlag = args.indexOf('--step')
  const opts = { tdd: tddMode }

  console.log(`\n🏁 Pazar.io Prompt Runner v2`)
  console.log(`   Model: ${CONFIG.model}`)
  console.log(`   TDD: ${tddMode ? 'AÇIK ✓' : 'kapalı'}`)
  console.log(`   Mod: ${parallelMode ? `Paralel (max ${CONFIG.maxParallel})` : 'Sıralı'}`)
  console.log(`   Çıktı: ${CONFIG.outputDir}`)

  const startTime = Date.now()

  if (parallelMode) {
    const { results, grand } = await runParallel(client, systemPrompt, opts)
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1)

    console.log(`\n${'═'.repeat(55)}`)
    console.log(`✨ Tüm modüller tamamlandı — ${duration} dakika`)
    console.log(`📊 Toplam: ${grand.input.toLocaleString()} input + ${grand.output.toLocaleString()} output token`)
    console.log(`💰 Tahmini maliyet: ~$${estimateCost(grand.input, grand.output)}`)

  } else if (allMode) {
    let totalIn = 0, totalOut = 0
    for (const id of Object.keys(MODULES)) {
      const r = await runModule(client, id, systemPrompt, opts)
      totalIn += r.totalInputTokens
      totalOut += r.totalOutputTokens
    }
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
    console.log(`\n✨ Tamamlandı — ${duration} dakika`)
    console.log(`💰 Tahmini maliyet: ~$${estimateCost(totalIn, totalOut)}`)

  } else if (moduleFlag !== -1) {
    const moduleId = args[moduleFlag + 1]
    const stepFilter = stepFlag !== -1 ? parseInt(args[stepFlag + 1]) : null
    await runModule(client, moduleId, systemPrompt, { ...opts, stepFilter })

  } else {
    // Yardım
    console.log('\nKullanım:')
    console.log('  node prompt_runner_v2.js --parallel --tdd    # Paralel + TDD (önerilen)')
    console.log('  node prompt_runner_v2.js --all --tdd         # Sıralı + TDD')
    console.log('  node prompt_runner_v2.js --module 04 --tdd   # Tek modül + TDD')
    console.log('  node prompt_runner_v2.js --module 04 --step 2 # Tek adım')
    console.log('\nModüller:')
    for (const [id, m] of Object.entries(MODULES)) {
      console.log(`  ${id}: [P${m.priority}] ${m.name}`)
    }
    console.log('\nParalel öncelik grupları:')
    for (const [p, ids] of Object.entries(PRIORITY_GROUPS)) {
      console.log(`  Öncelik ${p}: ${ids.join(', ')}`)
    }
  }

  console.log(`\n📁 Çıktılar: ${CONFIG.outputDir}`)
}

main().catch(err => {
  console.error('\n💥 Fatal:', err.message)
  process.exit(1)
})
