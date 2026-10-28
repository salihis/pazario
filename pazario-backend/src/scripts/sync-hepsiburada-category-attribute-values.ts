import 'dotenv/config'
import { prisma } from '../db'
import { hepsiburadaEnvironment } from '../config/hepsiburada'
import { CategoryAttributeService } from '../services/CategoryAttributeService'

const delayMs = Math.max(0, Number(process.env.HB_ATTRIBUTE_SYNC_DELAY_MS || 20_000))

function hasValues(values: unknown): boolean {
  return Array.isArray(values) && values.length > 0
}

async function categoryCoverage(categoryId: string) {
  const attributes = await prisma.marketplaceCategoryAttribute.findMany({
    where: { marketplace: 'HEPSIBURADA', categoryId, attributeType: 'dropdown' },
    select: { values: true },
  })
  return {
    dropdowns: attributes.length,
    populated: attributes.filter(attribute => hasValues(attribute.values)).length,
  }
}

async function main() {
  if (hepsiburadaEnvironment() !== 'production') {
    throw new Error('Bu script yalnizca HB_ENVIRONMENT=production ile calistirilabilir.')
  }

  const requestedIds = String(process.env.HB_CATEGORY_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const mappings = await prisma.categoryMapping.findMany({
    where: {
      marketplace: 'HEPSIBURADA',
      status: 'APPROVED',
      marketplaceCategoryId: requestedIds.length > 0 ? { in: requestedIds } : { not: null },
    },
    select: { marketplaceCategoryId: true, marketplaceCategoryPath: true },
    orderBy: { marketplaceCategoryPath: 'asc' },
  })
  const categories = Array.from(new Map(
    mappings
      .filter(mapping => mapping.marketplaceCategoryId)
      .map(mapping => [mapping.marketplaceCategoryId as string, {
        categoryId: mapping.marketplaceCategoryId as string,
        categoryPath: mapping.marketplaceCategoryPath,
      }])
  ).values())

  const service = new CategoryAttributeService(prisma)
  const results: Array<Record<string, unknown>> = []

  for (const [index, category] of categories.entries()) {
    const before = await categoryCoverage(category.categoryId)
    const fetchedAttributes = await service.refreshFromAPI('HEPSIBURADA', category.categoryId)
    const after = await categoryCoverage(category.categoryId)
    results.push({
      ...category,
      fetchedAttributes,
      before,
      after,
      completed: after.dropdowns > 0 && after.populated === after.dropdowns,
    })
    console.log(JSON.stringify(results[results.length - 1]))

    if (index < categories.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  const totals = results.reduce<{
    categories: number
    completedCategories: number
    dropdowns: number
    populated: number
  }>((acc, result) => {
    const after = result.after as { dropdowns: number; populated: number }
    acc.dropdowns += after.dropdowns
    acc.populated += after.populated
    if (result.completed) acc.completedCategories++
    return acc
  }, { categories: results.length, completedCategories: 0, dropdowns: 0, populated: 0 })

  console.log(JSON.stringify({ status: 'DONE', totals, results }, null, 2))
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
