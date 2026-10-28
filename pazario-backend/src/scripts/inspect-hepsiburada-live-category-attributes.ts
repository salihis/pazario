import 'dotenv/config'
import { prisma } from '../db'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { CategoryAttributeService } from '../services/CategoryAttributeService'

const CATEGORY_IDS = process.env.HB_CATEGORY_IDS
  ? process.env.HB_CATEGORY_IDS.split(',').map(value => value.trim()).filter(Boolean)
  : ['60006906', '60002741', '60006829', '60006830', '12105746', '80809035', '60000819']

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  const service = new CategoryAttributeService(prisma)
  const results = []
  for (const categoryId of CATEGORY_IDS) {
    try {
      if (process.env.HB_REFRESH_ATTRIBUTES === 'true') {
        await service.refreshFromAPI('HEPSIBURADA', categoryId)
      }
      const category = await prisma.marketplaceCategory.findUnique({
        where: {
          marketplace_categoryId: {
            marketplace: 'HEPSIBURADA',
            categoryId,
          },
        },
      })
      const result = await service.getAttributes('HEPSIBURADA', categoryId)
      results.push({
        categoryId,
        categoryName: category?.categoryName,
        categoryPath: category?.categoryPath,
        parentId: category?.parentId,
        source: result.source,
        attributes: result.attributes.map(attribute => ({
          id: attribute.attributeId,
          name: attribute.attributeName,
          mandatory: attribute.isMandatory,
          type: attribute.attributeType,
          values: attribute.values.slice(0, 12),
        })),
      })
    } catch (error) {
      results.push({
        categoryId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  console.log(JSON.stringify({ results }, null, 2))
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
