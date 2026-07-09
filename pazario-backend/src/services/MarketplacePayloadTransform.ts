import type { Product } from '../adapters/BaseAdapter'

export const MARKETPLACE_BRAND_NAME = 'Berselya Underwear&Accessoires'
export const MARKETPLACE_BARCODE_PREFIX = 'BRS'

export function marketplaceBarcode(value?: string | null, fallback?: string | null): string {
  const raw = String(value || fallback || '').trim()
  if (!raw) return ''
  return raw.toUpperCase().startsWith(MARKETPLACE_BARCODE_PREFIX) ? raw : `${MARKETPLACE_BARCODE_PREFIX}${raw}`
}

export function transformMarketplaceProduct(product: Product): Product {
  return {
    ...product,
    brand: MARKETPLACE_BRAND_NAME,
    barcode: marketplaceBarcode(product.barcode, product.sku),
  }
}
