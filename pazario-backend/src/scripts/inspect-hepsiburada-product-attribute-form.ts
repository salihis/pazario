import 'dotenv/config'
import { prisma } from '../db'
import { CategoryAttributeService } from '../services/CategoryAttributeService'

async function main() {
  const productId = process.env.PRODUCT_ID || '9ec604ba-bfe5-42d8-a327-c175a74d6020'
  const categoryId = process.env.HB_CATEGORY_ID || '60001620'
  const service = new CategoryAttributeService(prisma)
  const result = await service.getAttributes('HEPSIBURADA', categoryId, productId)
  const requested = new Set(['merchantSku', 'Barcode', 'Image1', 'Marka', 'tax_vat_rate', 'cinsiyet'])

  console.log(JSON.stringify({
    productId,
    categoryId,
    fields: result.attributes
      .filter(attribute => requested.has(attribute.attributeId))
      .map(attribute => ({
        attributeId: attribute.attributeId,
        name: attribute.attributeName,
        currentValue: attribute.currentValue,
        valuesCount: attribute.values.length,
        values: attribute.values.slice(0, 10),
        systemManaged: attribute.systemManaged,
        isValid: attribute.isValid,
      })),
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
