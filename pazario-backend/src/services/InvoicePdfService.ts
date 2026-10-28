import PDFDocument from 'pdfkit'
import { existsSync } from 'node:fs'

export interface InvoicePdfProfile {
  companyName: string
  address: string
  phone?: string | null
  fax?: string | null
  website?: string | null
  email?: string | null
  taxOffice?: string | null
  taxNumber?: string | null
}

export interface InvoicePdfItem {
  title: string
  quantity: number
  unitPrice: number
  vatRate: number
  totalPrice: number
  discountAmount: number
}

export interface InvoicePdfInput {
  profile: InvoicePdfProfile
  buyerName: string
  buyerAddress: string
  buyerTaxNumber?: string | null
  invoiceNumber?: string | null
  ettn?: string | null
  scenario: string
  invoiceType: string
  issuedAt: Date
  marketplace: string
  orderNumber: string
  items: InvoicePdfItem[]
  totalAmount: number
}

const money = (value: number) => `${value.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`

const ONES = ['', 'Bir', 'İki', 'Üç', 'Dört', 'Beş', 'Altı', 'Yedi', 'Sekiz', 'Dokuz']
const TENS = ['', 'On', 'Yirmi', 'Otuz', 'Kırk', 'Elli', 'Altmış', 'Yetmiş', 'Seksen', 'Doksan']
const GROUPS = ['', 'Bin', 'Milyon', 'Milyar']

function threeDigits(value: number): string {
  const hundreds = Math.floor(value / 100)
  const tens = Math.floor((value % 100) / 10)
  const ones = value % 10
  return [hundreds ? `${hundreds === 1 ? '' : ONES[hundreds]} Yüz`.trim() : '', TENS[tens], ONES[ones]].filter(Boolean).join(' ')
}

function integerWords(value: number): string {
  if (value === 0) return 'Sıfır'
  const parts: string[] = []
  let remaining = value
  let group = 0
  while (remaining > 0 && group < GROUPS.length) {
    const current = remaining % 1000
    if (current) {
      const prefix = group === 1 && current === 1 ? '' : threeDigits(current)
      parts.unshift([prefix, GROUPS[group]].filter(Boolean).join(' '))
    }
    remaining = Math.floor(remaining / 1000)
    group += 1
  }
  return parts.join(' ')
}

export function amountInTurkishWords(value: number): string {
  const rounded = Math.round(Math.max(0, value) * 100)
  const lira = Math.floor(rounded / 100)
  const kurus = rounded % 100
  return `Yalnız ${integerWords(lira)} Türk Lirası${kurus ? ` ${integerWords(kurus)} Kuruş` : ''}`
}

function fontPath(bold = false): string | undefined {
  const paths = process.platform === 'win32'
    ? [bold ? 'C:/Windows/Fonts/arialbd.ttf' : 'C:/Windows/Fonts/arial.ttf']
    : [bold ? '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
  return paths.find(existsSync)
}

export async function createInvoiceDraftPdf(input: InvoicePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 38, bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const regular = fontPath(false)
    const bold = fontPath(true)
    if (regular) doc.registerFont('Regular', regular)
    if (bold) doc.registerFont('Bold', bold)
    const setRegular = () => doc.font(regular ? 'Regular' : 'Helvetica')
    const setBold = () => doc.font(bold ? 'Bold' : 'Helvetica-Bold')

    setBold().fontSize(16).fillColor('#123f40').text(input.profile.companyName || 'Firma Bilgisi Girilmedi', 38, 35, { width: 330 })
    setRegular().fontSize(8).fillColor('#333').text(input.profile.address || '-', 38, 58, { width: 330 })
    doc.text([input.profile.phone && `Tel: ${input.profile.phone}`, input.profile.email, input.profile.website].filter(Boolean).join(' | '), 38, 82, { width: 330 })
    setBold().fontSize(18).fillColor('#123f40').text('FATURA TASLAĞI', 370, 34, { width: 185, align: 'right', lineBreak: false })
    setRegular().fontSize(7).fillColor('#b45309').text('Bu belge mali açıdan geçerli e-Fatura/e-Arşiv Fatura değildir.', 370, 70, { width: 185, align: 'right' })

    doc.moveTo(38, 105).lineTo(557, 105).strokeColor('#d6c58f').stroke()
    setBold().fontSize(9).fillColor('#123f40').text('ALICI', 38, 116)
    setRegular().fontSize(9).fillColor('#222').text(input.buyerName || 'Bilgi yok', 38, 134, { width: 280 })
    setBold().fontSize(7).fillColor('#666').text('FATURA ADRESİ', 38, 153)
    setRegular().fontSize(8).fillColor('#222').text(input.buyerAddress || 'Fatura adresi pazaryerinden alınamadı.', 38, 166, { width: 280, height: 42 })
    if (input.buyerTaxNumber) doc.text(`TCKN/VKN: ${input.buyerTaxNumber}`, 38, 207)

    const meta = [
      ['Senaryo', input.scenario],
      ['Fatura Tipi', input.invoiceType === 'CREDIT_NOTE' ? 'İADE' : 'SATIŞ'],
      ['Fatura No', input.invoiceNumber || 'Taslak'],
      ['Fatura Tarihi', input.issuedAt.toLocaleString('tr-TR')],
      ['ETTN', input.ettn || '-'],
    ]
    let metaY = 116
    meta.forEach(([label, value]) => {
      setBold().fontSize(8).fillColor('#555').text(label, 340, metaY, { width: 75 })
      setRegular().fillColor('#222').text(value, 418, metaY, { width: 139, align: 'right' })
      metaY += 17
    })

    const columns = { no: 38, item: 62, qty: 310, unit: 345, discount: 409, vat: 468, total: 503 }
    let y = 235
    const header = () => {
      doc.rect(38, y, 519, 24).fill('#123f40')
      setBold().fontSize(8).fillColor('#fff')
      doc.text('#', columns.no + 5, y + 8).text('Mal/Hizmet', columns.item, y + 8)
      doc.text('Miktar', columns.qty, y + 8).text('Birim Fiyat', columns.unit, y + 8)
      doc.text('İskonto', columns.discount, y + 8)
      doc.text('KDV', columns.vat, y + 8).text('Tutar', columns.total, y + 8)
      y += 24
    }
    header()
    input.items.forEach((item, index) => {
      if (y > 675) {
        doc.addPage()
        y = 40
        header()
      }
      const rowHeight = Math.max(28, doc.heightOfString(item.title, { width: 235 }) + 12)
      if (index % 2 === 0) doc.rect(38, y, 519, rowHeight).fill('#f7f4ea')
      setRegular().fontSize(8).fillColor('#222')
      doc.text(String(index + 1), columns.no + 5, y + 8)
      doc.text(item.title, columns.item, y + 8, { width: 235 })
      doc.text(String(item.quantity), columns.qty, y + 8, { width: 30, align: 'right' })
      doc.text(money(item.unitPrice), columns.unit, y + 8, { width: 58, align: 'right' })
      doc.text(money(item.discountAmount), columns.discount, y + 8, { width: 53, align: 'right' })
      doc.text(`%${item.vatRate}`, columns.vat, y + 8, { width: 30, align: 'right' })
      doc.text(money(item.totalPrice), columns.total, y + 8, { width: 54, align: 'right' })
      y += rowHeight
    })

    const vatTotal = input.items.reduce((sum, item) => sum + item.totalPrice * item.vatRate / (100 + item.vatRate), 0)
    const discountTotal = input.items.reduce((sum, item) => sum + item.discountAmount, 0)
    const grossTotal = input.items.reduce((sum, item) => sum + item.totalPrice + item.discountAmount, 0)
    y = Math.min(Math.max(y + 18, 500), 700)
    setRegular().fontSize(8).fillColor('#333').text(`${input.marketplace} Sipariş No: ${input.orderNumber}`, 38, y, { width: 300 })
    setBold().fontSize(8).fillColor('#123f40').text(amountInTurkishWords(input.totalAmount), 38, y + 20, { width: 290 })
    const totals: Array<[string, number]> = [
      ['Mal/Hizmet Toplamı', grossTotal || input.totalAmount],
      ...(discountTotal > 0 ? [['Toplam İskonto', discountTotal] as [string, number]] : []),
      ['Hesaplanan KDV', vatTotal],
      ['Ödenecek Tutar', input.totalAmount],
    ]
    totals.forEach(([label, value], index) => {
      if (index === totals.length - 1) setBold(); else setRegular()
      doc.text(label, 350, y + index * 18, { width: 110, align: 'right' })
      doc.text(money(value), 470, y + index * 18, { width: 87, align: 'right' })
    })
    doc.end()
  })
}
