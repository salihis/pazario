import axios from 'axios'
import { Marketplace } from '@prisma/client'
import { prisma } from '../db'
import { decryptJson } from './FieldEncryptionService'
import { hepsiburadaOrderApiUrl, hepsiburadaAuthHeaders } from '../config/hepsiburada'
import { buildHepsiburadaInvoicePayload } from './HepsiburadaInvoicePayload'

type Credentials = Record<string, string>

type MarketplaceInvoiceInput = {
  marketplace: Marketplace
  marketplaceOrderId: string
  marketplaceOrderNo?: string | null
  invoiceNumber?: string | null
  issuedAt: Date
  publicUrl: string
}

async function credentials(marketplace: Marketplace): Promise<Credentials> {
  const record = await prisma.marketplaceCredential.findUnique({ where: { marketplace } })
  if (!record?.isActive) throw new Error(`${marketplace} API bilgileri aktif değil`)
  return decryptJson(record.credentialsEncrypted)
}

async function pazaramaToken(values: Credentials): Promise<string> {
  const attempts: Array<Record<string, string>> = [
    { grant_type: 'client_credentialsscope', scope: 'merchantgatewayapi.fullaccess' },
    { grant_type: 'client_credentials', scope: 'merchantgatewayapi.fullaccess' },
    { grant_type: 'client_credentials' },
  ]
  for (const attempt of attempts) {
    try {
      const response = await axios.post('https://isortagimgiris.pazarama.com/connect/token', new URLSearchParams(attempt).toString(), {
        auth: { username: values.clientId, password: values.clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000,
      })
      const token = response.data?.access_token ?? response.data?.accessToken
      if (token) return String(token)
    } catch { /* sonraki resmi kimlik doğrulama varyantını dene */ }
  }
  throw new Error('Pazarama erişim anahtarı alınamadı')
}

export async function sendInvoiceToMarketplace(input: MarketplaceInvoiceInput): Promise<{ externalId?: string; message: string }> {
  const values = await credentials(input.marketplace)
  const orderNumber = input.marketplaceOrderNo || input.marketplaceOrderId

  if (input.marketplace === 'TRENDYOL') {
    const response = await axios.post(
      `https://apigw.trendyol.com/integration/sellers/${encodeURIComponent(values.supplierId)}/seller-invoice-links`,
      { invoiceLink: input.publicUrl, shipmentPackageId: input.marketplaceOrderId },
      { auth: { username: values.apiKey, password: values.apiSecret }, headers: { 'User-Agent': `${values.supplierId} - SelfIntegration` }, timeout: 30000 }
    )
    return { externalId: response.data?.batchRequestId, message: 'Trendyol fatura bağlantısını kabul etti' }
  }

  if (input.marketplace === 'HEPSIBURADA') {
    await axios.put(
      hepsiburadaOrderApiUrl(`/packages/merchantid/${encodeURIComponent(values.merchantId)}/packagenumber/${encodeURIComponent(input.marketplaceOrderId)}/invoice`),
      buildHepsiburadaInvoicePayload(input),
      { headers: hepsiburadaAuthHeaders(values.merchantId, values.serviceKey || values.password, values.username || values.merchantId, values.password || values.serviceKey, values.userAgent), timeout: 30000 }
    )
    return { message: 'Hepsiburada fatura bağlantısını kabul etti' }
  }

  if (input.marketplace === 'N11') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sch="http://www.n11.com/ws/schemas"><soapenv:Header/><soapenv:Body><sch:SaveLinkSellerInvoiceRequest><auth><appKey>${values.appKey}</appKey><appSecret>${values.appSecret}</appSecret></auth><orderNumber>${orderNumber}</orderNumber><invoiceNumber>${input.invoiceNumber || orderNumber}</invoiceNumber><invoiceDate>${input.issuedAt.toISOString()}</invoiceDate><url>${input.publicUrl.replace(/&/g, '&amp;')}</url></sch:SaveLinkSellerInvoiceRequest></soapenv:Body></soapenv:Envelope>`
    const response = await axios.post('https://api.n11.com/ws/SellerInvoiceService', xml, { headers: { 'Content-Type': 'text/xml; charset=utf-8' }, timeout: 30000 })
    if (/status>failure|result>failure|error/i.test(String(response.data))) throw new Error('N11 fatura bağlantısını reddetti')
    return { message: 'N11 fatura bağlantısını kabul etti' }
  }

  const token = await pazaramaToken(values)
  await axios.post('https://isortagimapi.pazarama.com/order/invoice-link', {
    invoiceLink: input.publicUrl, orderid: input.marketplaceOrderId, deliveryCompanyId: null, trackingNumber: null,
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 })
  return { message: 'Pazarama fatura bağlantısını kabul etti' }
}
