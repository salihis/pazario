// src/config/env.ts

import { z } from 'zod'
import { readFileSync } from 'node:fs'

if (!process.env.JWT_PUBLIC_KEY && process.env.JWT_PUBLIC_KEY_FILE) {
  process.env.JWT_PUBLIC_KEY = readFileSync(process.env.JWT_PUBLIC_KEY_FILE, 'utf8')
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
  JWT_PUBLIC_KEY_FILE: z.string().optional(),
  ALLOWED_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://localhost:5174,http://localhost:3456,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:3456'
    ),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  ANTHROPIC_API_KEY: optionalString,
  FIELD_ENCRYPTION_KEY: optionalString,
  // Trendyol
  TY_API_KEY: optionalString,
  TY_API_SECRET: optionalString,
  TY_SUPPLIER_ID: optionalString,
  // N11
  N11_APPKEY: optionalString,
  N11_APPSECRET: optionalString,
  // Hepsiburada
  HB_MERCHANT_ID: optionalString,
  HB_SERVICE_KEY: optionalString,
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
