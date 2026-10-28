import 'dotenv/config'
import { Request, Response } from 'express'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { syncMarketplaceCategories } from '../api/controllers/category.controller'

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  let statusCode = 200
  let payload: unknown
  const request = { params: { marketplace: 'HEPSIBURADA' } } as unknown as Request
  const response = {
    status(code: number) {
      statusCode = code
      return this
    },
    json(value: unknown) {
      payload = value
      return this
    },
  } as unknown as Response

  await syncMarketplaceCategories(request, response)
  console.log(JSON.stringify({ statusCode, payload }, null, 2))
  process.exit(statusCode >= 200 && statusCode < 300 ? 0 : 1)
}

main().catch(error => {
  console.error(JSON.stringify({
    status: 'FAILED',
    message: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exit(1)
})
