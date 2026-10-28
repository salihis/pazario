export type PurchaseCostSource = {
  priceIncludesVat?: boolean | null
  purchaseVatRate?: unknown
  purchaseExtraFee?: unknown
}

export function toMoneyNumber(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function calculatePurchaseCost(basePrice: unknown, source?: PurchaseCostSource | null): number {
  const base = toMoneyNumber(basePrice)
  if (base <= 0) return 0

  const vatRate = Math.max(0, toMoneyNumber(source?.purchaseVatRate))
  const extraFee = Math.max(0, toMoneyNumber(source?.purchaseExtraFee))
  const vatMultiplier = source?.priceIncludesVat === false ? 1 + vatRate / 100 : 1
  return Math.round((base * vatMultiplier + extraFee) * 100) / 100
}

export function purchaseCostSettingsFromBody(body: Record<string, unknown>) {
  const data: {
    priceIncludesVat?: boolean
    purchaseVatRate?: number
    purchaseExtraFee?: number
  } = {}

  if (typeof body.priceIncludesVat === 'boolean') data.priceIncludesVat = body.priceIncludesVat
  if (body.purchaseVatRate !== undefined) data.purchaseVatRate = Math.min(Math.max(toMoneyNumber(body.purchaseVatRate), 0), 100)
  if (body.purchaseExtraFee !== undefined) data.purchaseExtraFee = Math.max(toMoneyNumber(body.purchaseExtraFee), 0)

  return data
}
