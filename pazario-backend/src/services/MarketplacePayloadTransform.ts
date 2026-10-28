import type { Product } from '../adapters/BaseAdapter'
import { createHash } from 'node:crypto'

export const MARKETPLACE_BRAND_NAME = 'Berselya Underwear&Accessoires'
export const TOPTANBUDUR_MARKETPLACE_BRAND_NAME = 'B&A'
export const MARKETPLACE_BARCODE_PREFIX = 'BRS'

export function marketplaceBarcode(value?: string | null, fallback?: string | null): string {
  const raw = String(value || fallback || '').trim()
  if (!raw) return ''
  return raw.toUpperCase().startsWith(MARKETPLACE_BARCODE_PREFIX) ? raw : `${MARKETPLACE_BARCODE_PREFIX}${raw}`
}

export function marketplaceUniqueBarcode(sku: string, stableKey: string): string {
  const normalizedSku = sku
    .toLocaleUpperCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/İ/g, 'I')
    .replace(/[^A-Z0-9]/g, '')
  const hash = createHash('sha1').update(stableKey).digest('hex').slice(0, 8).toUpperCase()
  return `${MARKETPLACE_BARCODE_PREFIX}${normalizedSku.slice(0, 24)}${hash}`
}

export function marketplaceBrandForSource(sourceName?: string | null): string | undefined {
  const normalized = String(sourceName ?? '')
    .toLocaleUpperCase('tr-TR')
    .replace(/[^A-Z0-9]/g, '')
  return normalized.includes('TOPTANBUDUR') ? TOPTANBUDUR_MARKETPLACE_BRAND_NAME : undefined
}

export function transformMarketplaceProduct(product: Product): Product {
  return {
    ...product,
    brand: product.marketplaceBrand || MARKETPLACE_BRAND_NAME,
    barcode: marketplaceBarcode(product.barcode, product.sku),
  }
}
