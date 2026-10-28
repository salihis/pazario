import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { fetchAccounting, syncHepsiburadaFinance } from './HepsiburadaFinanceService'

vi.mock('axios', () => ({ default: { get: vi.fn(), isAxiosError: (e: any) => e?.isAxiosError === true } }))
vi.mock('./FieldEncryptionService', () => ({ decryptJson: () => ({ merchantId: 'test-merchant', serviceKey: 'test-key', userAgent: 'test-agent' }) }))
const credential = { merchantId: 'test-merchant', password: 'test-key', userAgent: 'test-agent', environment: 'production' as const }
const raw = (id = 'one') => ({ id, transactionType: 'Payment', transactionTypeCategory: 'OrderBased',
  orderNumber: 'order', packageNumber: 'package', sku: 'sku', amount: { value: 100, currencyCode: '949' },
  isIncome: true, isInvoice: false, status: 'WillBePaid' })

const database = () => {
  const snapshots = { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({ syncedAt: new Date() }) }
  const tx = { marketplaceFinanceSnapshot: snapshots, $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) }
  const db = { order: { findUnique: vi.fn().mockResolvedValue({ marketplace: 'HEPSIBURADA', marketplaceOrderNo: 'order' }) },
    marketplaceCredential: { findUnique: vi.fn().mockResolvedValue({ isActive: true, credentialsEncrypted: {} }) },
    marketplaceFinanceSnapshot: { upsert: vi.fn().mockResolvedValue({}) },
    orderItem: { update: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn().mockImplementation(fn => fn(tx)),
  }
  return { db, tx, snapshots }
}

describe('HB accounting sync isolation', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.HB_ENVIRONMENT = 'production' })
  it('queries only the finance host, by order number, without redirects', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { count: 1, items: [raw()] } })
    expect(await fetchAccounting(credential, 'order')).toHaveLength(1)
    expect(axios.get).toHaveBeenCalledWith('https://mpfinance-external.hepsiburada.com/transactions/merchantid/test-merchant', expect.objectContaining({
      params: { OrderNumber: 'order', Offset: 0, Limit: 100 }, maxRedirects: 0,
    }))
  })
  it('accepts a successful empty initial response without fabricating fees', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { count: 0, items: [] } })
    expect(await fetchAccounting(credential, 'order')).toEqual([])
  })
  it('fails on an incomplete page', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { count: 2, items: [raw()] } })
    await expect(fetchAccounting(credential, 'order')).rejects.toThrow('eksik')
  })
  it('does not persist duplicate records even if the server count matches', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { count: 2, items: [raw(), raw()] } })
    await expect(fetchAccounting(credential, 'order')).rejects.toThrow('tekrar')
  })
  it('updates only the separate snapshot, never manual order-item values', async () => {
    const { db, snapshots } = database()
    vi.mocked(axios.get).mockResolvedValue({ data: { count: 1, items: [raw()] } })
    await syncHepsiburadaFinance(db as any, 'local-order')
    expect(snapshots.upsert).toHaveBeenCalledOnce()
    expect(db.orderItem.update).not.toHaveBeenCalled()
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled()
  })
  it('preserves old movements if an empty or smaller snapshot comes back', async () => {
    const { db, snapshots } = database()
    snapshots.findUnique.mockResolvedValue({ transactions: [{ id: 'old' }] })
    vi.mocked(axios.get).mockResolvedValue({ data: { count: 0, items: [] } })
    await expect(syncHepsiburadaFinance(db as any, 'local-order')).rejects.toThrow('korundu')
    expect(snapshots.upsert).not.toHaveBeenCalled()
    expect(db.marketplaceFinanceSnapshot.upsert.mock.calls[0][0].update).not.toHaveProperty('transactions')
  })
  it('sanitizes auth failures, retains old data and does not retry', async () => {
    const { db, snapshots } = database()
    vi.mocked(axios.get).mockRejectedValue({ isAxiosError: true, response: { status: 403 }, config: { auth: { password: 'secret' } } })
    await expect(syncHepsiburadaFinance(db as any, 'local-order')).rejects.toThrow('HTTP 403')
    expect(axios.get).toHaveBeenCalledOnce()
    expect(snapshots.upsert).not.toHaveBeenCalled()
    expect(JSON.stringify(db.marketplaceFinanceSnapshot.upsert.mock.calls)).not.toContain('secret')
  })
  it('does not call the provider when another process owns the account lock', async () => {
    const { db, tx } = database()
    tx.$queryRaw.mockResolvedValue([{ locked: false }])
    await expect(syncHepsiburadaFinance(db as any, 'local-order')).rejects.toThrow('devam ediyor')
    expect(axios.get).not.toHaveBeenCalled()
  })
})
