import { Request, Response } from 'express'
import { InvoiceStatus, Marketplace, Prisma } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { z } from 'zod'
import { prisma } from '../../db'
import { env } from '../../config/env'
import { OrderFetchService } from '../../services/OrderFetchService'
import { createInvoiceDraftPdf } from '../../services/InvoicePdfService'
import { sendInvoiceToMarketplace } from '../../services/InvoiceMarketplaceService'

const fetchService = new OrderFetchService(prisma)
const profileSchema = z.object({
  companyName: z.string().trim().min(1).max(200), address: z.string().trim().min(1).max(2000),
  phone: z.string().trim().max(50).nullable().optional(), fax: z.string().trim().max(50).nullable().optional(),
  website: z.string().trim().max(255).nullable().optional(), email: z.string().trim().email().max(255).nullable().optional(),
  taxOffice: z.string().trim().max(150).nullable().optional(), taxNumber: z.string().trim().max(20).nullable().optional(),
  defaultVatRate: z.coerce.number().int().min(0).max(100), invoicePrefix: z.string().trim().min(3).max(3).toUpperCase(),
})
const draftSchema = z.object({
  invoiceNumber: z.string().trim().max(100).nullable().optional(), ettn: z.string().trim().max(100).nullable().optional(),
  scenario: z.enum(['EARSIVFATURA', 'TEMELFATURA', 'TICARIFATURA']).default('EARSIVFATURA'),
  invoiceType: z.enum(['INVOICE', 'CREDIT_NOTE']).default('INVOICE'), issuedAt: z.coerce.date().optional(),
})

const orderInclude = { items: { include: { source: { select: { id: true, name: true } } } }, invoice: true } satisfies Prisma.OrderInclude

function nullable(value: string | null | undefined) { return value?.trim() || null }
function publicUrl(token: string) { return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/public/invoices/${token}.pdf` }
function safeName(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'fatura.pdf' }

function decryptOrder(order: any) {
  try { return { ...order, ...fetchService.decryptOrderFields(order) } }
  catch { return { ...order, customerName: 'Bilgi çözülemedi', shippingAddress: null, billingAddress: null } }
}

function addressRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function first(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) if (record[key] != null && String(record[key]).trim()) return String(record[key]).trim()
  return ''
}
function formatAddress(value: unknown): string {
  const r = addressRecord(value)
  return [
    first(r, ['fullAddress', 'address', 'addressText', 'addressLine', 'addressLine1', 'address1', 'description', 'street']),
    first(r, ['addressLine2', 'neighborhood']), first(r, ['district', 'town']), first(r, ['city']), first(r, ['postalCode']), first(r, ['country']),
  ].filter(Boolean).join(', ')
}
function buyerTaxNumber(value: unknown): string | null {
  const r = addressRecord(value)
  return nullable(first(r, ['taxNumber', 'identityNumber', 'tcIdentityNumber', 'vkn', 'tckn']))
}

async function profile() {
  return prisma.invoiceProfile.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} })
}

async function ensureInvoice(order: any, body: z.infer<typeof draftSchema> = draftSchema.parse({})) {
  return prisma.invoice.upsert({
    where: { orderId: order.id },
    create: { orderId: order.id, invoiceType: body.invoiceType, status: 'DRAFT', invoiceNumber: nullable(body.invoiceNumber), ettn: nullable(body.ettn), scenario: body.scenario, issuedAt: body.issuedAt || new Date(), totalAmount: order.totalAmount },
    update: { invoiceType: body.invoiceType, invoiceNumber: nullable(body.invoiceNumber), ettn: nullable(body.ettn), scenario: body.scenario, issuedAt: body.issuedAt || undefined, totalAmount: order.totalAmount },
  })
}

export async function getInvoiceProfile(_req: Request, res: Response) {
  res.json({ success: true, data: await profile() })
}
export async function updateInvoiceProfile(req: Request, res: Response) {
  const parsed = profileSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Fatura profili alanlarını kontrol edin', details: parsed.error.flatten() }); return }
  const data = { ...parsed.data, phone: nullable(parsed.data.phone), fax: nullable(parsed.data.fax), website: nullable(parsed.data.website), email: nullable(parsed.data.email), taxOffice: nullable(parsed.data.taxOffice), taxNumber: nullable(parsed.data.taxNumber) }
  res.json({ success: true, data: await prisma.invoiceProfile.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data }) })
}

export async function listInvoices(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25))
  const where: Prisma.OrderWhereInput = {}
  if (req.query.marketplace) where.marketplace = String(req.query.marketplace) as Marketplace
  if (req.query.status) where.invoice = { is: { status: String(req.query.status) as InvoiceStatus } }
  if (req.query.search) where.OR = [{ marketplaceOrderId: { contains: String(req.query.search), mode: 'insensitive' } }, { marketplaceOrderNo: { contains: String(req.query.search), mode: 'insensitive' } }]
  const [orders, total] = await Promise.all([
    prisma.order.findMany({ where, include: orderInclude, orderBy: { orderedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.order.count({ where }),
  ])
  res.json({ success: true, data: orders.map(decryptOrder), meta: { page, limit, total } })
}

export async function saveInvoiceDraft(req: Request, res: Response) {
  const parsed = draftSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Fatura bilgileri geçersiz', details: parsed.error.flatten() }); return }
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId }, include: orderInclude })
  if (!order) { res.status(404).json({ success: false, error: 'Sipariş bulunamadı' }); return }
  const invoice = await ensureInvoice(order, parsed.data)
  res.json({ success: true, data: invoice })
}

export async function downloadDraftPdf(req: Request, res: Response) {
  const rawOrder = await prisma.order.findUnique({ where: { id: req.params.orderId }, include: orderInclude })
  if (!rawOrder) { res.status(404).json({ success: false, error: 'Sipariş bulunamadı' }); return }
  const order = decryptOrder(rawOrder); const currentProfile = await profile(); const invoice = rawOrder.invoice || await ensureInvoice(rawOrder)
  const bill = order.billingAddress || order.shippingAddress
  const buffer = await createInvoiceDraftPdf({
    profile: currentProfile, buyerName: order.customerName || 'Bilgi yok', buyerAddress: formatAddress(bill), buyerTaxNumber: buyerTaxNumber(bill),
    invoiceNumber: invoice.invoiceNumber, ettn: invoice.ettn, scenario: invoice.scenario, invoiceType: invoice.invoiceType,
    issuedAt: invoice.issuedAt || new Date(), marketplace: order.marketplace, orderNumber: order.marketplaceOrderNo || order.marketplaceOrderId,
    items: order.items.map((item: any) => ({ title: item.title, quantity: item.quantity, unitPrice: Number(item.unitPrice), vatRate: item.vatRate ?? currentProfile.defaultVatRate, totalPrice: Number(item.totalPrice), discountAmount: Number(item.discountAmount || 0) })), totalAmount: Number(order.totalAmount),
  })
  if (!['APPROVED', 'SENT'].includes(invoice.status)) await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'GENERATED' } })
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="taslak-${safeName(order.marketplaceOrderNo || order.marketplaceOrderId)}.pdf"`); res.send(buffer)
}

export async function uploadApprovedInvoice(req: Request, res: Response) {
  const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (file.length < 5 || file.subarray(0, 5).toString() !== '%PDF-') { res.status(400).json({ success: false, error: 'Yalnızca geçerli PDF dosyası yüklenebilir' }); return }
  if (file.length > 10 * 1024 * 1024) { res.status(413).json({ success: false, error: 'PDF en fazla 10 MB olabilir' }); return }
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId }, include: orderInclude })
  if (!order) { res.status(404).json({ success: false, error: 'Sipariş bulunamadı' }); return }
  const invoice = order.invoice || await ensureInvoice(order); const directory = path.resolve(env.INVOICE_STORAGE_DIR); await mkdir(directory, { recursive: true })
  const target = path.join(directory, `${invoice.id}.pdf`); const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`; await writeFile(temp, file); await rename(temp, target)
  const token = invoice.publicToken || randomBytes(32).toString('hex'); const fileName = safeName(String(req.query.fileName || 'onayli-fatura.pdf'))
  const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'APPROVED', approvedFilePath: target, approvedFileName: fileName, approvedFileSize: file.length, publicToken: token, pdfUrl: publicUrl(token), marketplaceStatus: null, marketplaceMessage: null } })
  await prisma.order.update({ where: { id: order.id }, data: { invoiceId: updated.id } })
  res.json({ success: true, data: updated })
}

export async function downloadApprovedInvoice(req: Request, res: Response) {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.invoiceId } })
  if (!invoice?.approvedFilePath || !existsSync(invoice.approvedFilePath)) { res.status(404).json({ success: false, error: 'Onaylı fatura bulunamadı' }); return }
  res.download(invoice.approvedFilePath, invoice.approvedFileName || 'onayli-fatura.pdf')
}

export async function servePublicInvoice(req: Request, res: Response) {
  const invoice = await prisma.invoice.findUnique({ where: { publicToken: req.params.token } })
  if (!invoice?.approvedFilePath || !existsSync(invoice.approvedFilePath)) { res.status(404).end(); return }
  const storage = path.resolve(env.INVOICE_STORAGE_DIR); const file = path.resolve(invoice.approvedFilePath)
  if (!file.startsWith(`${storage}${path.sep}`)) { res.status(404).end(); return }
  const info = await stat(file); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Length', info.size); res.setHeader('Cache-Control', 'private, max-age=300'); res.send(await readFile(file))
}

export async function sendApprovedInvoice(req: Request, res: Response) {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.invoiceId }, include: { order: true } })
  if (!invoice?.publicToken || !invoice.approvedFilePath || !existsSync(invoice.approvedFilePath)) { res.status(400).json({ success: false, error: 'Önce onaylı PDF yükleyin' }); return }
  try {
    const result = await sendInvoiceToMarketplace({ marketplace: invoice.order.marketplace, marketplaceOrderId: invoice.order.marketplaceOrderId, marketplaceOrderNo: invoice.order.marketplaceOrderNo, invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt || new Date(), publicUrl: publicUrl(invoice.publicToken) })
    const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT', externalInvoiceId: result.externalId, marketplaceStatus: 'SENT', marketplaceMessage: result.message, marketplaceSentAt: new Date() } })
    res.json({ success: true, data: updated })
  } catch (error: any) {
    const responseDetail = axios.isAxiosError(error)
      ? (typeof error.response?.data === 'string' ? error.response.data : JSON.stringify(error.response?.data ?? ''))
      : ''
    const message = error?.response?.status
      ? `Pazaryeri HTTP ${error.response.status} hatası verdi${responseDetail ? `: ${responseDetail}` : ''}`.slice(0, 500)
      : String(error?.message || 'Fatura gönderilemedi').slice(0, 500)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'FAILED', marketplaceStatus: 'FAILED', marketplaceMessage: message } })
    res.status(502).json({ success: false, error: message })
  }
}
