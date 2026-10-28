import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import { Marketplace } from '@prisma/client'
import { hepsiburadaProductApiUrl } from '../config/hepsiburada'

export type MarketplaceTestResult = {
  status: 'SUCCESS' | 'FAILED'
  message: string
}

type MarketplaceCredentials = Record<string, string>

const REQUIRED_FIELDS: Record<Marketplace, string[]> = {
  TRENDYOL: ['supplierId', 'apiKey', 'apiSecret'],
  PAZARAMA: ['clientId', 'clientSecret'],
  N11: ['appKey', 'appSecret'],
  HEPSIBURADA: ['merchantId'],
}

const TEST_TIMEOUT_MS = 15000

function missingFields(marketplace: Marketplace, credentials: MarketplaceCredentials): string[] {
  return REQUIRED_FIELDS[marketplace].filter(field => !String(credentials[field] ?? '').trim())
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function maskSecret(value: string): string {
  if (value.length <= 6) return '***'
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}

function safeAxiosMessage(error: unknown, credentials: MarketplaceCredentials): string {
  const secrets = Object.values(credentials).map(clean).filter(Boolean)
  let message = 'API testi basarisiz'

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError
    const status = axiosError.response?.status
    const data = axiosError.response?.data
    const responseText = typeof data === 'string'
      ? data
      : data
        ? JSON.stringify(data)
        : axiosError.message
    message = status ? `HTTP ${status}: ${responseText}` : axiosError.message
  } else if (error instanceof Error) {
    message = error.message
  } else {
    message = String(error)
  }

  for (const secret of secrets) {
    message = message.split(secret).join(maskSecret(secret))
  }

  return message.replace(/\s+/g, ' ').slice(0, 800)
}

function validateRequired(marketplace: Marketplace, credentials: MarketplaceCredentials): MarketplaceTestResult | null {
  const missing = missingFields(marketplace, credentials)
  if (marketplace === 'HEPSIBURADA') {
    const hasLegacyServiceKey = Boolean(clean(credentials.serviceKey))
    const hasBasicPair = Boolean(clean(credentials.username) && clean(credentials.password))
    if (!hasLegacyServiceKey && !hasBasicPair) {
      missing.push('username/password veya serviceKey')
    }
  }
  if (missing.length === 0) return null
  return {
    status: 'FAILED',
    message: `Eksik alanlar: ${missing.join(', ')}`,
  }
}

function success(message: string): MarketplaceTestResult {
  return { status: 'SUCCESS', message }
}

function failed(message: string): MarketplaceTestResult {
  return { status: 'FAILED', message }
}

function extractToken(data: unknown): string {
  const payload = data as Record<string, unknown>
  const nested = payload?.data as Record<string, unknown> | undefined
  const token = payload?.access_token
    ?? payload?.accessToken
    ?? payload?.token
    ?? nested?.access_token
    ?? nested?.accessToken
    ?? nested?.token
  return typeof token === 'string' ? token : ''
}

async function tryRequests(
  marketplace: Marketplace,
  credentials: MarketplaceCredentials,
  requests: AxiosRequestConfig[],
  successMessage: string
): Promise<MarketplaceTestResult> {
  let lastMessage = `${marketplace} API testi basarisiz`

  for (const request of requests) {
    try {
      const response = await axios.request({
        timeout: TEST_TIMEOUT_MS,
        validateStatus: status => status >= 200 && status < 300,
        ...request,
      })
      return success(`${successMessage} HTTP ${response.status}.`)
    } catch (error) {
      lastMessage = safeAxiosMessage(error, credentials)
    }
  }

  return failed(`${marketplace} gercek API testi basarisiz: ${lastMessage}`)
}

export async function testTrendyolCredentials(credentials: MarketplaceCredentials): Promise<MarketplaceTestResult> {
  const validation = validateRequired('TRENDYOL', credentials)
  if (validation) return validation

  const supplierId = clean(credentials.supplierId)
  const apiKey = clean(credentials.apiKey)
  const apiSecret = clean(credentials.apiSecret)
  const token = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')

  return tryRequests(
    'TRENDYOL',
    credentials,
    [
      {
        method: 'GET',
        url: `https://apigw.trendyol.com/integration/product/sellers/${encodeURIComponent(supplierId)}/products`,
        params: { page: 0, size: 1 },
        headers: {
          Authorization: `Basic ${token}`,
          'User-Agent': `${supplierId} - SelfIntegration`,
          Accept: 'application/json',
        },
      },
    ],
    'Trendyol API baglantisi dogrulandi.'
  )
}

export async function testPazaramaCredentials(credentials: MarketplaceCredentials): Promise<MarketplaceTestResult> {
  const validation = validateRequired('PAZARAMA', credentials)
  if (validation) return validation

  const clientId = clean(credentials.clientId)
  const clientSecret = clean(credentials.clientSecret)
  const attempts: Array<Record<string, string>> = [
    { grant_type: 'client_credentialsscope', scope: 'merchantgatewayapi.fullaccess' },
    { grant_type: 'client_credentials', scope: 'merchantgatewayapi.fullaccess' },
    { grant_type: 'client_credentials' },
  ]

  let lastMessage = 'Pazarama token alinamadi'
  for (const body of attempts) {
    try {
      const response = await axios.post(
        'https://isortagimgiris.pazarama.com/connect/token',
        new URLSearchParams(body).toString(),
        {
          auth: { username: clientId, password: clientSecret },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: TEST_TIMEOUT_MS,
        }
      )
      const token = extractToken(response.data)
      if (token) return success('Pazarama API token testi basarili. HTTP 200.')
      lastMessage = 'Pazarama token cevabinda access token yok'
    } catch (error) {
      lastMessage = safeAxiosMessage(error, credentials)
    }
  }

  return failed(`PAZARAMA gercek API testi basarisiz: ${lastMessage}`)
}

export async function testN11Credentials(credentials: MarketplaceCredentials): Promise<MarketplaceTestResult> {
  const validation = validateRequired('N11', credentials)
  if (validation) return validation

  const appKey = clean(credentials.appKey)
  const appSecret = clean(credentials.appSecret)

  return tryRequests(
    'N11',
    credentials,
    [
      {
        method: 'GET',
        url: 'https://api.n11.com/ms/product-query',
        params: { page: 0, size: 1 },
        headers: {
          appkey: appKey,
          appsecret: appSecret,
          Accept: 'application/json',
        },
      },
    ],
    'N11 API baglantisi dogrulandi.'
  )
}

export async function testHepsiburadaCredentials(credentials: MarketplaceCredentials): Promise<MarketplaceTestResult> {
  const validation = validateRequired('HEPSIBURADA', credentials)
  if (validation) return validation

  const merchantId = clean(credentials.merchantId)
  const serviceKey = clean(credentials.serviceKey)
  const username = merchantId
  const password = clean(serviceKey || credentials.password)
  const basic = Buffer.from(`${username}:${password}`).toString('base64')
  const userAgent = clean(credentials.userAgent || credentials.developerUsername || process.env.HB_USER_AGENT || process.env.HB_DEVELOPER_USERNAME || 'Pazario')

  return tryRequests(
    'HEPSIBURADA',
    credentials,
    [
      {
        method: 'GET',
        url: hepsiburadaProductApiUrl('/products/products-by-merchant-and-status'),
        params: {
          merchantId,
          productStatus: 'MATCHED',
          page: 0,
          size: 1,
          version: 1,
        },
        headers: {
          Authorization: `Basic ${basic}`,
          'User-Agent': userAgent,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
    ],
    'Hepsiburada API baglantisi dogrulandi.'
  )
}

export async function testMarketplaceCredentials(
  marketplace: Marketplace,
  credentials: MarketplaceCredentials
): Promise<MarketplaceTestResult> {
  if (marketplace === 'TRENDYOL') return testTrendyolCredentials(credentials)
  if (marketplace === 'PAZARAMA') return testPazaramaCredentials(credentials)
  if (marketplace === 'N11') return testN11Credentials(credentials)
  return testHepsiburadaCredentials(credentials)
}
