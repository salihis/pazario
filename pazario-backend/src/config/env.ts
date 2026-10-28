// src/config/env.ts

import { z } from 'zod'
import { readFileSync } from 'node:fs'

if (!process.env.JWT_PUBLIC_KEY && process.env.JWT_PUBLIC_KEY_FILE) {
  process.env.JWT_PUBLIC_KEY = readFileSync(process.env.JWT_PUBLIC_KEY_FILE, 'utf8')
}

if (!process.env.JWT_PRIVATE_KEY && process.env.JWT_PRIVATE_KEY_FILE) {
  process.env.JWT_PRIVATE_KEY = readFileSync(process.env.JWT_PRIVATE_KEY_FILE, 'utf8')
}

const optionalString = z.preprocess(value => value === '' ? undefined : value, z.string().optional())
const optionalUrl = z.preprocess(value => value === '' ? undefined : value, z.string().url().optional())

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** RS256 public key (PEM) — JWT doğrulaması için */
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY_FILE: z.string().optional(),
  JWT_PRIVATE_KEY_FILE: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('8h'),
  ALLOWED_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://localhost:5174,http://localhost:3456,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:3456'
    ),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  ANTHROPIC_API_KEY: optionalString,
  FIELD_ENCRYPTION_KEY: optionalString,
  LOCAL_AGENT_SYNC_TOKEN: optionalString,
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  INVOICE_STORAGE_DIR: z.string().default('./invoices'),
  // Trendyol
  TY_API_KEY: optionalString,
  TY_API_SECRET: optionalString,
  TY_SUPPLIER_ID: optionalString,
  // N11
  N11_APPKEY: optionalString,
  N11_APPSECRET: optionalString,
  // Hepsiburada
  HB_MERCHANT_ID: optionalString,
  HB_USERNAME: optionalString,
  HB_PASSWORD: optionalString,
  HB_USER_AGENT: optionalString,
  HB_DEVELOPER_USERNAME: optionalString,
  HB_SERVICE_KEY: optionalString,
  HB_ENVIRONMENT: z.enum(['sit', 'test', 'prod', 'production', 'live']).optional(),
  HEPSIBURADA_ENVIRONMENT: z.enum(['sit', 'test', 'prod', 'production', 'live']).optional(),
  HB_PRODUCT_API_BASE_URL: optionalUrl,
  HEPSIBURADA_PRODUCT_API_BASE_URL: optionalUrl,
  HB_LISTING_API_BASE_URL: optionalUrl,
  HEPSIBURADA_LISTING_API_BASE_URL: optionalUrl,
  HB_ORDER_API_BASE_URL: optionalUrl,
  HEPSIBURADA_ORDER_API_BASE_URL: optionalUrl,
  HB_ORDER_STUB_API_BASE_URL: optionalUrl,
  // Pazarama
  PZ_CLIENT_ID: optionalString,
  PZ_CLIENT_SECRET: optionalString,
  // Kargo
  ARAS_API_KEY: optionalString,
  YURTICI_API_KEY: optionalString,
  SURAT_API_KEY: optionalString,
  PTT_API_KEY: optionalString,
  // Monitoring
  SLACK_WEBHOOK_URL: optionalUrl,
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  process.stderr.write(
    `[env] Geçersiz environment değişkenleri:\n${JSON.stringify(parsed.error.format(), null, 2)}\n`
  )
  process.exit(1)
}

export const env = parsed.data
