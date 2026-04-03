#!/usr/bin/env node
/**
 * Pazar.io — Proje Kurulum Scripti
 * 
 * Çalıştır: node setup.js
 * 
 * Yapar:
 *   1. Node.js versiyonu kontrol
 *   2. Klasör yapısını oluşturur
 *   3. package.json yazar
 *   4. npm install çalıştırır
 *   5. .env.example oluşturur
 *   6. Hazır olduğunda komutu gösterir
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = path.join(__dirname, '..', 'pazario-backend')

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

function ok(msg) { console.log(`${GREEN}  ✓${RESET} ${msg}`) }
function warn(msg) { console.log(`${YELLOW}  ⚠${RESET} ${msg}`) }
function err(msg) { console.log(`${RED}  ✗${RESET} ${msg}`) }
function step(msg) { console.log(`\n${BOLD}${msg}${RESET}`) }

// ── 1. Node.js versiyonu ──────────────────────────────────────────────────
step('1. Node.js versiyonu kontrol ediliyor...')
const nodeVer = process.version
const major = parseInt(nodeVer.slice(1))
if (major < 20) {
  err(`Node.js 20+ gerekli — mevcut: ${nodeVer}`)
  err('https://nodejs.org adresinden güncelle')
  process.exit(1)
}
ok(`Node.js ${nodeVer}`)

// ── 2. Klasör yapısı ──────────────────────────────────────────────────────
step('2. Proje klasörü oluşturuluyor...')
const dirs = [
  PROJECT_DIR,
  `${PROJECT_DIR}/src/parser`,
  `${PROJECT_DIR}/src/validators`,
  `${PROJECT_DIR}/src/adapters/pazaryeri`,
  `${PROJECT_DIR}/src/adapters/cargo`,
  `${PROJECT_DIR}/src/services`,
  `${PROJECT_DIR}/src/api/routes`,
  `${PROJECT_DIR}/src/api/controllers`,
  `${PROJECT_DIR}/src/api/middleware`,
  `${PROJECT_DIR}/src/queue/workers`,
  `${PROJECT_DIR}/src/db`,
  `${PROJECT_DIR}/src/utils`,
  `${PROJECT_DIR}/src/shared`,
  `${PROJECT_DIR}/prisma`,
  `${PROJECT_DIR}/tests`,
  `${PROJECT_DIR}/.github/workflows`,
]
dirs.forEach(d => { fs.mkdirSync(d, { recursive: true }); ok(d.replace(PROJECT_DIR, '.')) })

// ── 3. package.json ───────────────────────────────────────────────────────
step('3. package.json yazılıyor...')
const pkg = {
  name: "pazario-backend",
  version: "1.0.0",
  description: "Pazar.io — XML → Pazaryeri Entegrasyon Platformu",
  type: "module",
  engines: { node: ">=20.0.0" },
  scripts: {
    dev: "tsx watch src/index.ts",
    build: "tsc",
    start: "node dist/index.js",
    test: "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:seed": "tsx prisma/seed.ts",
    "db:studio": "prisma studio",
    lint: "eslint src --ext .ts",
    typecheck: "tsc --noEmit",
  },
  dependencies: {
    "@anthropic-ai/sdk": "^0.39.0",
    "@prisma/client": "^5.14.0",
    "bullmq": "^5.12.0",
    "express": "^5.0.0",
    "fast-xml-parser": "^4.4.0",
    "ioredis": "^5.4.1",
    "pino": "^9.3.2",
    "pino-pretty": "^11.2.1",
    "zod": "^3.23.8",
    "bcrypt": "^5.1.1",
    "jsonwebtoken": "^9.0.2",
    "axios": "^1.7.2",
  },
  devDependencies: {
    "@types/bcrypt": "^5.0.2",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^20.14.9",
    "@vitest/coverage-v8": "^1.6.0",
    "nock": "^13.5.4",
    "prisma": "^5.14.0",
    "tsx": "^4.16.2",
    "typescript": "^5.5.2",
    "vitest": "^1.6.0",
  }
}
fs.writeFileSync(`${PROJECT_DIR}/package.json`, JSON.stringify(pkg, null, 2))
ok('package.json')

// ── 4. tsconfig.json ──────────────────────────────────────────────────────
const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: ["ES2022"],
    outDir: "./dist",
    rootDir: "./src",
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
  },
  include: ["src/**/*"],
  exclude: ["node_modules", "dist", "**/*.test.ts"]
}
fs.writeFileSync(`${PROJECT_DIR}/tsconfig.json`, JSON.stringify(tsconfig, null, 2))
ok('tsconfig.json')

// ── 5. vitest.config.ts ───────────────────────────────────────────────────
fs.writeFileSync(`${PROJECT_DIR}/vitest.config.ts`,
`import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
})
`)
ok('vitest.config.ts')

// ── 6. .env.example ───────────────────────────────────────────────────────
const envExample = `# === Pazar.io Backend — Ortam Değişkenleri ===
# Bu dosyayı .env olarak kopyala: cp .env.example .env

# ── Veritabanı ────────────────────────────────
DATABASE_URL="postgresql://pazario:password@localhost:5432/pazario_db"

# ── Redis ─────────────────────────────────────
REDIS_URL="redis://localhost:6379"

# ── JWT ───────────────────────────────────────
JWT_SECRET="buraya-guclu-bir-secret-yaz-min-32-karakter"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"

# ── Şifreleme (KVKK — müşteri verisi) ─────────
FIELD_ENCRYPTION_KEY="32-karakter-hex-aes-256-anahtari"

# ── Anthropic (Kategori AI) ───────────────────
ANTHROPIC_API_KEY="sk-ant-..."

# ── Trendyol ──────────────────────────────────
TY_API_KEY="..."
TY_API_SECRET="..."
TY_SUPPLIER_ID="..."

# ── Hepsiburada (Ağustos 2024+ yeni yapı) ─────
HB_MERCHANT_ID="uuid-formatinda-merchant-id"
HB_SERVICE_KEY="12karakterservisanahtar"

# ── N11 (REST API — SOAP değil) ───────────────
N11_APPKEY="..."
N11_APPSECRET="..."
N11_INTEGRATOR="PazarioEntegrasyon"

# ── Pazarama ──────────────────────────────────
PZ_CLIENT_ID="..."
PZ_CLIENT_SECRET="..."

# ── Kargo ─────────────────────────────────────
ARAS_API_KEY="..."
YURTICI_API_KEY="..."
SURAT_API_KEY="..."
PTT_API_KEY="..."

# ── Uygulama ──────────────────────────────────
PORT=3000
NODE_ENV="development"
LOG_LEVEL="info"
DEFAULT_DESI=1

# ── Bildirim ──────────────────────────────────
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
`
fs.writeFileSync(`${PROJECT_DIR}/.env.example`, envExample)
ok('.env.example')

// ── 7. .gitignore ─────────────────────────────────────────────────────────
fs.writeFileSync(`${PROJECT_DIR}/.gitignore`,
`node_modules/
dist/
.env
*.log
coverage/
.DS_Store
`)
ok('.gitignore')

// ── 8. src/index.ts başlangıç ─────────────────────────────────────────────
fs.writeFileSync(`${PROJECT_DIR}/src/index.ts`,
`/**
 * Pazar.io Backend — Ana Giriş Noktası
 * 
 * Modüller prompt_runner_v2.js ile üretilip buraya entegre edilecek.
 */

console.log('🚀 Pazar.io backend başlatılıyor...')
console.log('📦 Modüller henüz üretilmedi — prompt_runner_v2.js çalıştır')
`)
ok('src/index.ts')

// ── 9. GitHub Actions ─────────────────────────────────────────────────────
fs.writeFileSync(`${PROJECT_DIR}/.github/workflows/ci.yml`,
`name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:coverage
`)
ok('.github/workflows/ci.yml')

// ── 10. npm install ───────────────────────────────────────────────────────
step('4. Bağımlılıklar yükleniyor (npm install)...')
try {
  execSync('npm install', { cwd: PROJECT_DIR, stdio: 'inherit' })
  ok('npm install tamamlandı')
} catch (e) {
  warn('npm install başarısız — manuel çalıştır: cd pazario-backend && npm install')
}

// ── Sonuç ─────────────────────────────────────────────────────────────────
console.log(`
${GREEN}${BOLD}═══════════════════════════════════════════════════${RESET}
${GREEN}${BOLD}✅ Proje hazır!${RESET}

Sonraki adımlar:

  1. API anahtarlarını ayarla:
     ${BOLD}cp pazario-backend/.env.example pazario-backend/.env${RESET}
     .env dosyasını düzenle

  2. PostgreSQL ve Redis başlat:
     ${BOLD}docker-compose up -d${RESET}  (veya lokal kurulum)

  3. Kod üretimini başlat:
     ${BOLD}cd prompts_v2${RESET}
     ${BOLD}ANTHROPIC_API_KEY=sk-ant-... OUTPUT_DIR=../pazario-backend node prompt_runner_v2.js --parallel --tdd${RESET}

  4. DB migration (kod üretiminden sonra):
     ${BOLD}cd pazario-backend && npm run db:migrate${RESET}

  5. Testleri çalıştır:
     ${BOLD}npm test${RESET}

${GREEN}${BOLD}═══════════════════════════════════════════════════${RESET}
`)
