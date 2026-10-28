export type HepsiburadaEnvironment = 'sit' | 'production'

const DEFAULT_PRODUCT_API_BASE_URLS: Record<HepsiburadaEnvironment, string> = {
  sit: 'https://mpop-sit.hepsiburada.com/product/api',
  production: 'https://mpop.hepsiburada.com/product/api',
}

const DEFAULT_LISTING_API_BASE_URLS: Record<HepsiburadaEnvironment, string> = {
  sit: 'https://listing-external-sit.hepsiburada.com',
  production: 'https://listing-external.hepsiburada.com',
}

const DEFAULT_ORDER_API_BASE_URLS: Record<HepsiburadaEnvironment, string> = {
  sit: 'https://oms-external-sit.hepsiburada.com',
  production: 'https://oms-external.hepsiburada.com',
}

const DEFAULT_ORDER_STUB_API_BASE_URL = 'https://oms-stub-external-sit.hepsiburada.com'

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

export function hepsiburadaEnvironment(): HepsiburadaEnvironment {
  const raw = clean(process.env.HB_ENVIRONMENT || process.env.HEPSIBURADA_ENVIRONMENT).toLowerCase()
  if (raw === 'prod' || raw === 'production' || raw === 'live') return 'production'
  return 'sit'
}

export function hepsiburadaProductApiBaseUrl(): string {
  const explicit = clean(process.env.HB_PRODUCT_API_BASE_URL || process.env.HEPSIBURADA_PRODUCT_API_BASE_URL)
  return explicit.replace(/\/+$/, '') || DEFAULT_PRODUCT_API_BASE_URLS[hepsiburadaEnvironment()]
}

export function hepsiburadaProductApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${hepsiburadaProductApiBaseUrl()}${normalizedPath}`
}

export function hepsiburadaListingApiBaseUrl(): string {
  const explicit = clean(process.env.HB_LISTING_API_BASE_URL || process.env.HEPSIBURADA_LISTING_API_BASE_URL)
  return explicit.replace(/\/+$/, '') || DEFAULT_LISTING_API_BASE_URLS[hepsiburadaEnvironment()]
}

export function hepsiburadaListingApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${hepsiburadaListingApiBaseUrl()}${normalizedPath}`
}

export function hepsiburadaOrderApiBaseUrl(): string {
  const explicit = clean(process.env.HB_ORDER_API_BASE_URL || process.env.HEPSIBURADA_ORDER_API_BASE_URL)
  return explicit.replace(/\/+$/, '') || DEFAULT_ORDER_API_BASE_URLS[hepsiburadaEnvironment()]
}

export function hepsiburadaOrderApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${hepsiburadaOrderApiBaseUrl()}${normalizedPath}`
}

export function hepsiburadaOrderStubApiUrl(path: string): string {
  if (hepsiburadaEnvironment() !== 'sit') {
    throw new Error('Hepsiburada test siparisi olusturma servisi yalnizca SIT ortaminda kullanilabilir.')
  }
  const explicit = clean(process.env.HB_ORDER_STUB_API_BASE_URL)
  const baseUrl = explicit.replace(/\/+$/, '') || DEFAULT_ORDER_STUB_API_BASE_URL
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

export function hepsiburadaUserAgent(value?: string): string {
  return clean(value || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME || 'Pazario')
}

export function hepsiburadaAuthHeaders(
  merchantId: string,
  serviceKey: string,
  username: string = merchantId,
  password: string = serviceKey,
  userAgent?: string
) {
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    'User-Agent': hepsiburadaUserAgent(userAgent),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}
