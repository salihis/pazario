import axios from 'axios'
import { Prisma, PrismaClient } from '@prisma/client'
import { hepsiburadaEnvironment, hepsiburadaUserAgent } from '../config/hepsiburada'
import { decryptJson } from './FieldEncryptionService'
import { normalizeFinanceTransactions } from './FinanceAccounting'

export async function financeCredential(prisma: PrismaClient) {
  const saved = await prisma.marketplaceCredential.findUnique({ where: { marketplace: 'HEPSIBURADA' } })
  if (!saved?.isActive) throw new Error('Aktif Hepsiburada API kaydi bulunamadi')
  const values = decryptJson(saved.credentialsEncrypted)
  const merchantId = String(values.merchantId || '').trim()
  const password = String(values.serviceKey || values.password || '').trim()
  if (!merchantId || !password) throw new Error('Hepsiburada API bilgileri eksik')
  return { merchantId, password, environment: hepsiburadaEnvironment(),
    userAgent: hepsiburadaUserAgent(String(values.userAgent || '')) }
}

export async function fetchAccounting(credential: Awaited<ReturnType<typeof financeCredential>>, orderNumber: string) {
  const host = credential.environment === 'production' ? 'mpfinance-external.hepsiburada.com' : 'mpfinance-external-sit.hepsiburada.com'
  const records: unknown[] = []
  let expected: number | undefined
  for (let page = 0; page < 10; page++) {
    const response = await axios.get(`https://${host}/transactions/merchantid/${encodeURIComponent(credential.merchantId)}`, {
      auth: { username: credential.merchantId, password: credential.password },
      headers: { Accept: 'application/json', 'User-Agent': credential.userAgent },
      params: { OrderNumber: orderNumber, Offset: page * 100, Limit: 100 },
      timeout: 20000, maxRedirects: 0,
    })
    const { items, count } = response.data ?? {}
    if (!Array.isArray(items) || !Number.isInteger(count) || count < 0 || items.length > 100
      || (expected !== undefined && count !== expected)) throw new Error('Muhasebe sayfalama sonucu tutarsiz; tekrar guncelleyin')
    expected = count
    records.push(...items)
    if (records.length === count) {
      const normalized = normalizeFinanceTransactions(records, orderNumber)
      if (normalized.length !== count) throw new Error('Muhasebe sayfalarinda tekrar eden kayit var')
      return normalized
    }
    if (items.length < 100 || records.length > count) throw new Error('Muhasebe kayitlari eksik geldi')
    await new Promise(resolve => setTimeout(resolve, 1100))
  }
  throw new Error('Muhasebe sorgusu guvenli sayfa sinirina ulasti')
}

const inFlight = new Set<string>()

export async function syncHepsiburadaFinance(prisma: PrismaClient, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.marketplace !== 'HEPSIBURADA' || !order.marketplaceOrderNo) {
    throw new Error('Hepsiburada siparis numarasi bulunamadi')
  }
  const credential = await financeCredential(prisma)
  const scope = { marketplace: 'HEPSIBURADA' as const, environment: credential.environment,
    merchantId: credential.merchantId, orderNumber: order.marketplaceOrderNo }
  const key = `${scope.environment}:${scope.merchantId}`
  if (inFlight.has(key)) throw new Error('Muhasebe guncellemesi devam ediyor')
  inFlight.add(key)
  try {
    return await prisma.$transaction(async tx => {
      const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${`finance:${key}`})) AS locked`
      if (!locks[0]?.locked) throw new Error('Muhasebe guncellemesi devam ediyor')
      const transactions = await fetchAccounting(credential, scope.orderNumber)
      const previous = await tx.marketplaceFinanceSnapshot.findUnique({ where: { marketplace_environment_merchantId_orderNumber: scope } })
      const ids = new Set(transactions.map(t => t.id))
      if (previous && (previous.transactions as unknown as Array<{ id: string }>).some(t => !ids.has(t.id))) {
        throw new Error('Onceki muhasebe hareketlerinin bir kismi donmedi; onceki kayitlar korundu')
      }
      // Atomic snapshot replacement: failed or incomplete pages never replace a previous snapshot.
      const snapshot = await tx.marketplaceFinanceSnapshot.upsert({
        where: { marketplace_environment_merchantId_orderNumber: scope },
        create: { ...scope, transactions: transactions as unknown as Prisma.InputJsonValue, syncedAt: new Date() },
        update: { transactions: transactions as unknown as Prisma.InputJsonValue, syncedAt: new Date(), lastError: null },
      })
      return { orderNumber: scope.orderNumber, count: transactions.length, syncedAt: snapshot.syncedAt }
    }, { timeout: 230000, maxWait: 5000 })
  } catch (error) {
    const message = axios.isAxiosError(error)
      ? `Hepsiburada muhasebe sorgusu basarisiz (HTTP ${error.response?.status ?? 'baglanti hatasi'})`
      : error instanceof Error ? error.message : 'Muhasebe sorgusu basarisiz'
    await prisma.marketplaceFinanceSnapshot.upsert({
      where: { marketplace_environment_merchantId_orderNumber: scope },
      create: { ...scope, transactions: [], lastError: message.slice(0, 500) },
      update: { lastError: message.slice(0, 500) },
    })
    throw new Error(message)
  } finally {
    inFlight.delete(key)
  }
}
