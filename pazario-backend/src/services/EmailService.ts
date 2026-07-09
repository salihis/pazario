import nodemailer from 'nodemailer'

type OrderEmailItem = {
  title: string
  quantity: number
  totalPrice: unknown
  sourceName?: string | null
}

type OrderEmailPayload = {
  to: string
  orderNo: string
  marketplace: string
  customerName: string | null
  totalAmount: unknown
  currency: string
  trackingNumber?: string | null
  cargoCompany?: string | null
  items: OrderEmailItem[]
}

type OrderNotificationPayload = OrderEmailPayload

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function money(value: unknown): string {
  return Number(value || 0).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export class EmailService {
  private transporter() {
    const host = process.env.SMTP_HOST
    const port = Number(process.env.SMTP_PORT || 587)
    const user = process.env.SMTP_USER
    const pass = process.env.SMTP_PASS
    const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true'

    if (!host || !user || !pass) {
      throw new Error('SMTP ayarlari eksik: SMTP_HOST, SMTP_USER ve SMTP_PASS zorunlu')
    }

    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    })
  }

  async verify(): Promise<void> {
    await this.transporter().verify()
  }

  async sendOrderEmail(payload: OrderEmailPayload): Promise<{ messageId: string }> {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER
    if (!from) throw new Error('SMTP_FROM veya SMTP_USER tanimli degil')

    const subject = `Siparis bilgilendirme - ${payload.orderNo}`
    const itemRows = payload.items.map(item => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.title)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.sourceName || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center;">${item.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${money(item.totalPrice)} ${escapeHtml(payload.currency)}</td>
      </tr>
    `).join('')

    const trackingBlock = payload.trackingNumber
      ? `<p><strong>Kargo:</strong> ${escapeHtml(payload.cargoCompany || '')} - ${escapeHtml(payload.trackingNumber)}</p>`
      : ''

    const html = `
      <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
        <h2>Siparis Bilgilendirme</h2>
        <p>Merhaba ${escapeHtml(payload.customerName || 'Musterimiz')},</p>
        <p>${escapeHtml(payload.marketplace)} siparisiniz Pazario tarafinda isleme alinmistir.</p>
        <p><strong>Siparis No:</strong> ${escapeHtml(payload.orderNo)}</p>
        ${trackingBlock}
        <table style="border-collapse:collapse;width:100%;margin-top:16px;">
          <thead>
            <tr>
              <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db;">Urun</th>
              <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db;">XML Kaynagi</th>
              <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db;">Adet</th>
              <th style="padding:8px;text-align:right;border-bottom:2px solid #d1d5db;">Tutar</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
        <p style="font-size:18px;"><strong>Toplam:</strong> ${money(payload.totalAmount)} ${escapeHtml(payload.currency)}</p>
        <p>Ilginiz icin tesekkur ederiz.</p>
      </div>
    `

    const text = [
      `Siparis Bilgilendirme`,
      `Siparis No: ${payload.orderNo}`,
      `Pazaryeri: ${payload.marketplace}`,
      payload.trackingNumber ? `Kargo: ${payload.cargoCompany || ''} ${payload.trackingNumber}` : '',
      `Toplam: ${money(payload.totalAmount)} ${payload.currency}`,
    ].filter(Boolean).join('\n')

    const result = await this.transporter().sendMail({
      from,
      to: payload.to,
      subject,
      html,
      text,
    })

    return { messageId: result.messageId }
  }

  async sendNewOrderNotification(payload: OrderNotificationPayload): Promise<{ messageId: string }> {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER
    const to = process.env.ORDER_NOTIFICATION_EMAIL
    if (!from) throw new Error('SMTP_FROM veya SMTP_USER tanimli degil')
    if (!to) throw new Error('ORDER_NOTIFICATION_EMAIL tanimli degil')

    const subject = `Yeni siparis - ${payload.marketplace} - ${payload.orderNo}`
    const itemRows = payload.items.map(item => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.title)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center;">${item.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${money(item.totalPrice)} ${escapeHtml(payload.currency)}</td>
      </tr>
    `).join('')

    const trackingBlock = payload.trackingNumber
      ? `<p><strong>Kargo:</strong> ${escapeHtml(payload.cargoCompany || '')} - ${escapeHtml(payload.trackingNumber)}</p>`
      : ''

    const html = `
      <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
        <h2>Yeni Siparis Pazario'ya Dustu</h2>
        <p><strong>Pazaryeri:</strong> ${escapeHtml(payload.marketplace)}</p>
        <p><strong>Siparis No:</strong> ${escapeHtml(payload.orderNo)}</p>
        <p><strong>Musteri:</strong> ${escapeHtml(payload.customerName || '-')}</p>
        ${trackingBlock}
        <table style="border-collapse:collapse;width:100%;margin-top:16px;">
          <thead>
            <tr>
              <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db;">Urun</th>
              <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db;">Adet</th>
              <th style="padding:8px;text-align:right;border-bottom:2px solid #d1d5db;">Tutar</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
        <p style="font-size:18px;"><strong>Toplam:</strong> ${money(payload.totalAmount)} ${escapeHtml(payload.currency)}</p>
      </div>
    `

    const text = [
      `Yeni Siparis Pazario'ya Dustu`,
      `Pazaryeri: ${payload.marketplace}`,
      `Siparis No: ${payload.orderNo}`,
      `Musteri: ${payload.customerName || '-'}`,
      payload.trackingNumber ? `Kargo: ${payload.cargoCompany || ''} ${payload.trackingNumber}` : '',
      `Toplam: ${money(payload.totalAmount)} ${payload.currency}`,
      ...payload.items.map(item => `- ${item.title} | XML: ${item.sourceName || '-'} | ${item.quantity} adet: ${money(item.totalPrice)} ${payload.currency}`),
    ].filter(Boolean).join('\n')

    const result = await this.transporter().sendMail({
      from,
      to,
      subject,
      html,
      text,
    })

    return { messageId: result.messageId }
  }
}
