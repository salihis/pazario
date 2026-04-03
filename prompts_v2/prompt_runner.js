#!/usr/bin/env node
/**
 * Pazar.io — Prompt Runner
 * 
 * Her modülün promptlarını sırayla Claude API'ye gönderir.
 * Önceki yanıtı bir sonraki isteğe context olarak ekler.
 * 
 * Kullanım:
 *   node prompt_runner.js --module 02 --step 1
 *   node prompt_runner.js --module 02 --all
 *   node prompt_runner.js --all
 * 
 * Gerekli env:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   OUTPUT_DIR=./generated  (üretilen kodların kaydedileceği yer)
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Yapılandırma ─────────────────────────────────────────────────────────────

const CONFIG = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 8192,
  temperature: 0.2,        // düşük yaratıcılık, yüksek tutarlılık
  promptsDir: path.join(__dirname, 'prompts'),
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, 'generated'),
  systemPromptFile: '00_SYSTEM_PROMPT.md',
}

// ── Modül → Dosya Eşleştirmesi ────────────────────────────────────────────────

const MODULES = {
  '01': { file: '01_VERITABANI.md',         name: 'Veritabanı & Migration' },
  '02': { file: '02_XML_PARSER.md',          name: 'XML Parser & Validator' },
  '03': { file: '03_FIYAT_MOTORU.md',        name: 'Fiyat Motoru' },
  '04': { file: '04_KATEGORI_VE_ADAPTORLER.md', name: 'Kategori + Adaptörler' },
  '05': { file: '05_SIPARIS_KARGO.md',       name: 'Sipariş & Kargo' },
  '06': { file: '06_ADMIN_PANEL.md',         name: 'Admin Panel' },
  '07': { file: '07_PIPELINE_VE_QUEUE.md',   name: 'Pipeline & Queue' },
  '08': { file: '08_KATEGORI_OZELLIK_GONDERIM.md', name: 'Kategori Özellik & Gönderim' },
  '09': { file: '09_GITHUB_DEPLOY.md',        name: 'GitHub Pages Deploy' },
}

// ── Prompt Parser ─────────────────────────────────────────────────────────────

/**
 * Markdown dosyasındaki ``` bloklarını prompt olarak parse eder.
 * Her ## PROMPT X.Y başlığı altındaki ilk ``` bloğu bir prompt'tur.
 */
function parsePrompts(markdown) {
  const prompts = []
  const sections = markdown.split(/^## PROMPT \d+\.\d+/m)
  
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i]
    const titleMatch = sections[i - 1]?.match(/## PROMPT (\d+\.\d+)[^\n]*\n/) ||
                       section.match(/^[^\n]*\n/)
    
    // ``` ile ``` arasındaki içeriği al
    const codeMatch = section.match(/```\n([\s\S]*?)```/)
    if (codeMatch) {
      prompts.push({
        index: i,
        content: codeMatch[1].trim(),
      })
    }
  }
  
  return prompts
}

// ── API Çağrısı ───────────────────────────────────────────────────────────────

async function callClaude(client, systemPrompt, messages) {
  const response = await client.messages.create({
    model: CONFIG.model,
    max_tokens: CONFIG.maxTokens,
    system: systemPrompt,
    messages,
  })
  
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

// ── Kod Çıkarıcı ─────────────────────────────────────────────────────────────

/**
 * Claude'un yanıtından TypeScript/JavaScript kod bloklarını çıkarır.
 * Her dosya ayrı kaydedilir.
 */
async function extractAndSaveCode(response, outputDir, moduleId, stepIndex) {
  const files = []
  
  // Dosya yolu yorumundan dosya adını çıkar: // src/parser/XMLParser.ts
  const fileBlocks = response.matchAll(
    /\/\/ (src\/[^\s]+\.(?:ts|tsx|js|jsx|json|prisma|sql))\n([\s\S]*?)(?=\n\/\/ src\/|\n```|$)/g
  )
  
  for (const [, filePath, code] of fileBlocks) {
    const fullPath = path.join(outputDir, filePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, code.trim())
    files.push(filePath)
  }
  
  // Dosya yorumu bulunamazsa tümünü tek dosyaya yaz
  if (files.length === 0) {
    const rawPath = path.join(outputDir, `module_${moduleId}_step_${stepIndex}.txt`)
    await fs.writeFile(rawPath, response)
    files.push(rawPath)
  }
  
  return files
}

// ── Ana Runner ────────────────────────────────────────────────────────────────

async function runModule(client, moduleId, systemPrompt, stepFilter = null) {
  const module = MODULES[moduleId]
  if (!module) throw new Error(`Modül bulunamadı: ${moduleId}`)
  
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📦 Modül ${moduleId}: ${module.name}`)
  console.log('═'.repeat(60))
  
  const promptFile = await fs.readFile(
    path.join(CONFIG.promptsDir, module.file),
    'utf-8'
  )
  const prompts = parsePrompts(promptFile)
  
  // Konuşma geçmişi — her adım bir öncekinin çıktısını bağlam olarak alır
  const conversationHistory = []
  const outputDir = path.join(CONFIG.outputDir, `module_${moduleId}`)
  await fs.mkdir(outputDir, { recursive: true })
  
  for (let i = 0; i < prompts.length; i++) {
    const stepNum = i + 1
    
    // Belirli bir adım filtresi varsa atla
    if (stepFilter !== null && stepFilter !== stepNum) continue
    
    const prompt = prompts[i]
    console.log(`\n  ⚡ Adım ${stepNum}/${prompts.length}...`)
    
    // Konuşma geçmişine kullanıcı mesajı ekle
    conversationHistory.push({
      role: 'user',
      content: prompt.content,
    })
    
    try {
      const startTime = Date.now()
      const response = await callClaude(client, systemPrompt, conversationHistory)
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      
      // Yanıtı geçmişe ekle (bir sonraki adım için bağlam)
      conversationHistory.push({
        role: 'assistant',
        content: response,
      })
      
      // Yanıtı ham olarak kaydet
      const rawPath = path.join(outputDir, `step_${stepNum}_response.md`)
      await fs.writeFile(rawPath, response)
      
      // Kod dosyalarını çıkar ve kaydet
      const savedFiles = await extractAndSaveCode(response, CONFIG.outputDir, moduleId, stepNum)
      
      console.log(`  ✅ ${duration}s — ${savedFiles.length} dosya üretildi`)
      savedFiles.forEach(f => console.log(`     📄 ${f}`))
      
      // Rate limit: adımlar arası 2sn bekle
      if (i < prompts.length - 1) {
        await new Promise(r => setTimeout(r, 2000))
      }
      
    } catch (err) {
      console.error(`  ❌ Adım ${stepNum} başarısız:`, err.message)
      // Hata durumunda devam et (sonraki adım bağlamı olmadan çalışır)
    }
  }
  
  return outputDir
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY env değişkeni gerekli')
    process.exit(1)
  }
  
  const client = new Anthropic({ apiKey })
  
  // System prompt oku
  const systemPromptRaw = await fs.readFile(
    path.join(CONFIG.promptsDir, CONFIG.systemPromptFile),
    'utf-8'
  )
  // ``` bloğundaki metni çıkar
  const systemPrompt = systemPromptRaw.match(/```\n([\s\S]*?)```/)?.[1]?.trim() || systemPromptRaw
  
  await fs.mkdir(CONFIG.outputDir, { recursive: true })
  
  const args = process.argv.slice(2)
  const moduleFlag = args.indexOf('--module')
  const stepFlag = args.indexOf('--step')
  const allFlag = args.includes('--all')
  
  if (allFlag) {
    // Tüm modülleri sırayla çalıştır
    for (const moduleId of Object.keys(MODULES)) {
      await runModule(client, moduleId, systemPrompt)
    }
  } else if (moduleFlag !== -1) {
    const moduleId = args[moduleFlag + 1]
    const stepFilter = stepFlag !== -1 ? parseInt(args[stepFlag + 1]) : null
    await runModule(client, moduleId, systemPrompt, stepFilter)
  } else {
    console.log('Kullanım:')
    console.log('  node prompt_runner.js --module 02           # Modül 2 tüm adımlar')
    console.log('  node prompt_runner.js --module 02 --step 1  # Modül 2, sadece adım 1')
    console.log('  node prompt_runner.js --all                 # Tüm modüller sırayla')
    console.log('\nMevcut modüller:')
    Object.entries(MODULES).forEach(([id, m]) => {
      console.log(`  ${id}: ${m.name}`)
    })
  }
  
  console.log('\n✨ Tamamlandı. Çıktılar:', CONFIG.outputDir)
}

main().catch(console.error)
