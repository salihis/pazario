import 'dotenv/config'
import axios from 'axios'
import { Marketplace, PrismaClient } from '@prisma/client'
import { hepsiburadaOrderApiUrl, hepsiburadaUserAgent } from '../config/hepsiburada'
import { decryptJson } from '../services/FieldEncryptionService'

const prisma = new PrismaClient()

function list(data: unknown): Record<string, unknown>[] {
  const root = data as Record<string, unknown> | undefined
  for (const candidate of [data, root?.items, root?.data, (root?.data as Record<string, unknown> | undefined)?.items, root?.content]) {
    if (Array.isArray(candidate)) return candidate as Record<string, unknown>[]
  }
  return []
}

async function main() {
  const wanted = String(process.argv[2] || '').trim()
  if (!wanted) throw new Error('Siparis numarasi gerekli')
  const credential = await prisma.marketplaceCredential.findUnique({ where: { marketplace: Marketplace.HEPSIBURADA } })
  if (!credential?.isActive) throw new Error('Aktif Hepsiburada API kaydi bulunamadi')
  const values = decryptJson(credential.credentialsEncrypted)
  const merchantId = String(values.merchantId || '').trim()
  const password = String(values.serviceKey || values.password || '').trim()
  const userAgent = String(values.userAgent || process.env.HB_USER_AGENT || '').trim()
  const config = {
    auth: { username: merchantId, password },
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': hepsiburadaUserAgent(userAgent) },
    timeout: 60000,
  }
  const paths = ['', '/shipped', '/delivered', '/undelivered']
  for (const suffix of paths) {
    for (let page = 0; page < 100; page += 1) {
      const response = await axios.get(hepsiburadaOrderApiUrl(`/packages/merchantid/${encodeURIComponent(merchantId)}${suffix}`), {
        ...config,
        params: { timespan: 720, offset: page * 50, limit: 50 },
      })
      const values = list(response.data)
      const match = values.find(value => JSON.stringify(value).includes(wanted))
      if (match) {
        const detailResponse = await axios.get(
          hepsiburadaOrderApiUrl(`/orders/merchantid/${encodeURIComponent(merchantId)}/ordernumber/${encodeURIComponent(wanted)}`),
          config,
        )
        console.log(JSON.stringify({ endpoint: suffix || 'active', value: match, detail: detailResponse.data }, null, 2))
        return
      }
      if (values.length < 50) break
    }
  }
  console.log(JSON.stringify({ found: false, wanted }))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
