import { api } from '../api/client'
import JsBarcode from 'jsbarcode'

export type CargoLabelOrder = {
  marketplace: string
  marketplaceOrderId: string
  marketplaceOrderNo?: string | null
  customerName?: string | null
  customerPhone?: string | null
  shippingAddress?: unknown
  cargoCompany?: string | null
  trackingNumber?: string | null
  cargoLabelUrl?: string | null
  shipment?: { labelPdfUrl?: string | null } | null
  items: Array<{ title: string; quantity: number; sku?: string | null }>
}

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;')

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const firstText = (value: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const result = String(value[key] ?? '').trim()
    if (result) return result
  }
  return ''
}

function addressLines(value: unknown) {
  const address = record(value)
  return [
    firstText(address, ['fullAddress', 'address', 'addressText', 'addressLine', 'addressLine1', 'address1', 'description', 'street']),
    firstText(address, ['addressLine2', 'neighborhood']),
    firstText(address, ['district', 'town']),
    firstText(address, ['city']),
    firstText(address, ['postalCode']),
  ].filter(Boolean)
}

function createBarcodeSvg(value: string): string {
  const data = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (!data) return ''
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    JsBarcode(svg, data, {
      format: 'CODE128',
      width: 1.45,
      height: 42,
      displayValue: false,
      margin: 0,
      lineColor: '#111827',
    })
    return svg.outerHTML
  } catch {
    return ''
  }
}

export function getCargoLabelUrl(order: CargoLabelOrder): string | null {
  const value = order.cargoLabelUrl || order.shipment?.labelPdfUrl
  if (!value) return null
  try {
    const url = new URL(value, window.location.origin)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export function createCargoLabelHtml(order: CargoLabelOrder): string {
  const address = record(order.shippingAddress)
  const recipient = order.customerName || firstText(address, ['recipientName', 'name', 'fullName']) || 'Alıcı bilgisi yok'
  const orderNo = order.marketplaceOrderNo || order.marketplaceOrderId
  const tracking = order.trackingNumber || 'Henüz atanmadı'
  const barcodeValue = order.trackingNumber?.trim() || orderNo
  const barcode = createBarcodeSvg(barcodeValue)
  const addressText = addressLines(order.shippingAddress).map(escapeHtml).join('<br>') || 'Teslimat adresi pazaryerinden alınamadı.'
  const products = order.items.map(item => `
    <li><strong>${escapeHtml(item.quantity)} adet</strong> ${escapeHtml(item.title)}${item.sku ? ` <small>(${escapeHtml(item.sku)})</small>` : ''}</li>
  `).join('') || '<li>Ürün bilgisi yok</li>'

  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>Kargo Etiketi - ${escapeHtml(orderNo)}</title>
  <style>
    @page { size: 100mm 150mm; margin: 5mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111827; font: 11pt Arial, sans-serif; }
    .label { border: 2px solid #111827; min-height: 140mm; padding: 5mm; }
    .top { display: flex; justify-content: space-between; gap: 8mm; border-bottom: 2px solid #111827; padding-bottom: 4mm; }
    .marketplace { font-weight: 700; font-size: 14pt; }
    .caption { color: #4b5563; font-size: 8pt; text-transform: uppercase; margin-bottom: 1.5mm; }
    .barcode { margin-top: 5mm; text-align: center; }
    .barcode svg { max-width: 100%; height: 18mm; }
    .tracking { font: 700 11pt/1.2 monospace; letter-spacing: 1px; margin-top: 2mm; text-align: center; word-break: break-all; }
    .recipient { padding: 5mm 0; border-bottom: 1px solid #9ca3af; }
    .recipient h1 { font-size: 17pt; margin: 0 0 3mm; }
    .address { font-size: 12pt; line-height: 1.35; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; padding: 4mm 0; border-bottom: 1px solid #9ca3af; }
    .products { padding-top: 4mm; }
    .products ul { margin: 2mm 0 0; padding-left: 5mm; line-height: 1.35; }
    small { color: #4b5563; }
    .notice { margin-top: 5mm; color: #6b7280; font-size: 8pt; }
    @media screen { body { background: #f3f4f6; padding: 12mm; } .label { background: white; max-width: 100mm; margin: auto; } }
  </style>
</head>
<body>
  <main class="label">
    <section class="top">
      <div><div class="caption">Pazaryeri</div><div class="marketplace">${escapeHtml(order.marketplace)}</div></div>
      <div><div class="caption">Sipariş No</div><strong>${escapeHtml(orderNo)}</strong></div>
    </section>
    <section class="recipient">
      <div class="caption">Teslim Alacak Kişi</div>
      <h1>${escapeHtml(recipient)}</h1>
      <div class="address">${addressText}</div>
      ${order.customerPhone ? `<div style="margin-top: 3mm">Tel: ${escapeHtml(order.customerPhone)}</div>` : ''}
    </section>
    <section class="meta">
      <div><div class="caption">Kargo Firması</div><strong>${escapeHtml(order.cargoCompany || 'Pazaryeri tarafından atanacak')}</strong></div>
      <div><div class="caption">Takip / Barkod No</div><strong>${escapeHtml(tracking)}</strong></div>
    </section>
    ${barcode ? `<div class="barcode">${barcode}</div>` : ''}
    <div class="tracking">${escapeHtml(barcodeValue)}</div>
    <section class="products"><div class="caption">Paket İçeriği</div><ul>${products}</ul></section>
    <p class="notice">Bu hazırlama etiketidir. Pazaryerinden alınmış resmi kargo etiketi varsa yazdırma ekranında öncelikli olarak o açılır.</p>
  </main>
  <script>window.onload = () => window.setTimeout(() => window.print(), 150)</script>
</body>
</html>`
}

export async function printCargoLabel(orderId: string, openWindow: Window | null): Promise<void> {
  if (!openWindow) throw new Error('Tarayıcı yazdırma penceresini engelledi. Açılır pencereye izin verin.')
  openWindow.document.write('<title>Kargo etiketi hazırlanıyor</title><p style="font-family:Arial;padding:24px">Kargo etiketi hazırlanıyor...</p>')
  openWindow.document.close()

  let body: { data?: CargoLabelOrder; error?: string } | null = null
  try {
    body = (await api.get(`/orders/${encodeURIComponent(orderId)}`)).data
  } catch (error: any) {
    openWindow.close()
    throw new Error(error?.response?.data?.error || 'Sipariş detayı alınamadı')
  }
  if (!body?.data) { openWindow.close(); throw new Error('Sipariş detayı alınamadı') }

  const order = body.data as CargoLabelOrder
  const labelUrl = getCargoLabelUrl(order)
  if (labelUrl) {
    openWindow.location.replace(labelUrl)
    return
  }

  openWindow.document.open()
  openWindow.document.write(createCargoLabelHtml(order))
  openWindow.document.close()
}
