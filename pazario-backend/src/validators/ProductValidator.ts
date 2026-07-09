// src/validators/ProductValidator.ts

import type { ParsedProduct } from '../parser/XMLParser'
import { MARKETPLACE_BRAND_NAME, marketplaceBarcode } from '../services/MarketplacePayloadTransform'

// ─── INTERFACE'LER ────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  errors: string[]    // bloklayan hatalar
  warnings: string[]  // devam edilebilir uyarılar
}

interface MarketplaceRules {
  required: (keyof ParsedProduct)[]
  maxTitleLength: number
  maxDescriptionLength: number
  minPrice: number
  minImages: number
  maxImages: number
  barcodePattern?: RegExp
  skuPattern?: RegExp
  minDescriptionLength?: number
}

// ─── PAZARYERI KURALLARI ─────────────────────────────────────────────────────

const RULES: Record<string, MarketplaceRules> = {
  TRENDYOL: {
    required: ['title', 'barcode', 'price', 'stock', 'brand', 'images', 'category'],
    maxTitleLength: 250,
    maxDescriptionLength: 30000,
    minPrice: 0.01,
    minImages: 1,
    maxImages: 8,
    barcodePattern: /^([0-9]{8,13}|BRS[a-zA-Z0-9\-_]{1,50})$/,
  },
  HEPSIBURADA: {
    required: ['title', 'sku', 'price', 'stock', 'images', 'category'],
    maxTitleLength: 255,
    maxDescriptionLength: 50000,
    minPrice: 0.01,
    minImages: 1,
    maxImages: 10,
    skuPattern: /^[a-zA-Z0-9\-_]{1,50}$/,
  },
  N11: {
    required: ['title', 'price', 'stock', 'images', 'category', 'description'],
    maxTitleLength: 200,
    maxDescriptionLength: 50000,
    minPrice: 0.01,
    minImages: 1,
    maxImages: 5,
    minDescriptionLength: 50,
  },
  PAZARAMA: {
    required: ['title', 'barcode', 'price', 'stock', 'brand', 'images'],
    maxTitleLength: 300,
    maxDescriptionLength: 50000,
    minPrice: 0.01,
    minImages: 1,
    maxImages: 10,
    barcodePattern: /^([0-9]{8,14}|BRS[a-zA-Z0-9\-_]{1,50})$/,
  },
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const HTML_TAG_REGEX = /<[^>]+>/g
const ONLY_PUNCTUATION_REGEX = /^[^a-zA-Z0-9\u00C0-\u024F]+$/
const MAX_PRICE_WARNING = 1_000_000
export const MIN_MARKETPLACE_STOCK = 6

// ─── VALIDATOR SINIFI ─────────────────────────────────────────────────────────

export class ProductValidatorImpl {
  /**
   * Tek bir pazaryeri için ürünü validate eder
   */
  validate(product: ParsedProduct, marketplace: string): ValidationResult {
    const rules = RULES[marketplace.toUpperCase()]
    if (!rules) {
      return {
        valid: false,
        errors: [`Unknown marketplace: ${marketplace}`],
        warnings: [],
      }
    }

    const errors: string[] = []
    const warnings: string[] = []

    // ── Required field validation ──────────────────────────────────────────────
    for (const field of rules.required) {
      const val = field === 'barcode'
        ? marketplaceBarcode(product.barcode, product.sku)
        : field === 'brand'
          ? product.brand || MARKETPLACE_BRAND_NAME
          : product[field]
      if (
        val === null ||
        val === undefined ||
        val === '' ||
        (Array.isArray(val) && val.length === 0)
      ) {
        errors.push(`Missing required field: ${field}`)
      }
    }

    // ── Price validation ───────────────────────────────────────────────────────
    if (product.price !== undefined) {
      if (product.price < rules.minPrice) {
        errors.push(`Invalid price: ${product.price} (min: ${rules.minPrice})`)
      }
      if (product.price < 0) {
        errors.push(`Price cannot be negative: ${product.price}`)
      }
      if (product.price > MAX_PRICE_WARNING) {
        warnings.push(`Price is very high, please review: ${product.price}`)
      }
    }

    // ── Title validation ───────────────────────────────────────────────────────
    if (product.title) {
      if (product.title.length > rules.maxTitleLength) {
        errors.push(`Title too long: ${product.title.length} chars (max: ${rules.maxTitleLength})`)
      }
      if (HTML_TAG_REGEX.test(product.title)) {
        warnings.push('Title contains HTML tags')
      }
    }

    // ── Description validation ─────────────────────────────────────────────────
    if (product.description) {
      if (rules.minDescriptionLength && product.description.length < rules.minDescriptionLength) {
        errors.push(`Description too short: ${product.description.length} chars (min: ${rules.minDescriptionLength})`)
      }
      if (ONLY_PUNCTUATION_REGEX.test(product.description)) {
        warnings.push('Description contains only punctuation')
      }
    }

    // ── Image validation ───────────────────────────────────────────────────────
    if (product.images !== undefined) {
      if (product.images.length < rules.minImages) {
        errors.push(`Not enough images: ${product.images.length} < ${rules.minImages}`)
      }
      if (product.images.length > rules.maxImages) {
        warnings.push(`Too many images: ${product.images.length} > ${rules.maxImages}, will use first ${rules.maxImages}`)
      }
      // HTTP (not HTTPS) images
      const httpImages = product.images.filter(img => img.startsWith('http://'))
      if (httpImages.length > 0) {
        warnings.push(`${httpImages.length} image(s) use HTTP instead of HTTPS`)
      }
    }

    // ── Stock validation ───────────────────────────────────────────────────────
    if (product.stock <= MIN_MARKETPLACE_STOCK) {
      errors.push(`Insufficient stock: ${product.stock} (must be > ${MIN_MARKETPLACE_STOCK})`)
    }

    // ── Barcode format validation ──────────────────────────────────────────────
    const effectiveBarcode = marketplaceBarcode(product.barcode, product.sku)
    if (rules.barcodePattern && effectiveBarcode) {
      if (!rules.barcodePattern.test(effectiveBarcode)) {
        errors.push(`Invalid barcode format: ${effectiveBarcode}`)
      }
    }

    // ── SKU format validation ──────────────────────────────────────────────────
    if (rules.skuPattern && product.sku) {
      if (!rules.skuPattern.test(product.sku)) {
        errors.push(`Invalid SKU format: ${product.sku}`)
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Birden fazla pazaryeri için aynı anda validate eder
   */
  validateAll(
    product: ParsedProduct,
    marketplaces: string[]
  ): Record<string, ValidationResult> {
    const results: Record<string, ValidationResult> = {}
    for (const mp of marketplaces) {
      results[mp] = this.validate(product, mp)
    }
    return results
  }

  /**
   * Desteklenen pazaryeri listesi
   */
  getSupportedMarketplaces(): string[] {
    return Object.keys(RULES)
  }
}

// ─── SINGLETON EXPORT ────────────────────────────────────────────────────

export const ProductValidator = new ProductValidatorImpl()

