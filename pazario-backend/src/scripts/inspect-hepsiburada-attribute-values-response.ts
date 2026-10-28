import 'dotenv/config'
import { prisma } from '../db'
import { hepsiburadaEnvironment, hepsiburadaProductApiUrl } from '../config/hepsiburada'
import { CategoryAttributeService } from '../services/CategoryAttributeService'

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  const categoryId = process.env.HB_CATEGORY_ID || '60001620'
  const attributeId = process.env.HB_ATTRIBUTE_ID || 'cinsiyet'
  const service = new CategoryAttributeService(prisma) as unknown as {
    buildHeaders(marketplace: 'HEPSIBURADA'): Promise<Record<string, string>>
  }
  const headers = await service.buildHeaders('HEPSIBURADA')
  const response = await fetch(hepsiburadaProductApiUrl(
    `/categories/${encodeURIComponent(categoryId)}/attribute/${encodeURIComponent(attributeId)}/values?version=5&page=0&size=1000`
  ), { headers })
  const payload = await response.json().catch(() => null)

  console.log(JSON.stringify({
    status: response.status,
    totalCount: response.headers.get('total-count') ?? response.headers.get('x-total-count'),
    payload,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(JSON.stringify({
      status: 'FAILED',
      message: error instanceof Error ? error.message : String(error),
    }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
