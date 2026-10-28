import type { Prisma } from '@prisma/client'

type IncomingItem = Omit<Prisma.OrderItemCreateManyInput, 'id' | 'orderId'>
type ItemIdentity = {
  id: string
  sku: string | null
  marketplaceProductId: string | null
  title: string
}

function identity(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

export function planOrderItemSync(existing: ItemIdentity[], incoming: IncomingItem[]) {
  const used = new Set<string>()
  const seen = new Set<string>()
  const plan = incoming.map(item => {
    const sku = identity(item.sku)
    const externalId = identity(item.marketplaceProductId)
    const key = JSON.stringify([sku, externalId, sku || externalId ? '' : item.title])
    if (seen.has(key)) throw new Error('Siparis kalemi tekrari: finans verileri korunarak guncelleme durduruldu.')
    seen.add(key)

    let matches = existing.filter(row => sku && identity(row.sku) === sku)
    if (matches.length > 1 && externalId) {
      matches = matches.filter(row => identity(row.marketplaceProductId) === externalId)
    }
    if (!matches.length && externalId) {
      matches = existing.filter(row => identity(row.marketplaceProductId) === externalId
        && (!sku || !identity(row.sku) || identity(row.sku) === sku))
    }
    if (!sku && !externalId) {
      matches = existing.filter(row => !identity(row.sku) && !identity(row.marketplaceProductId)
        && row.title === item.title)
    }
    if (matches.length > 1 || (matches[0] && used.has(matches[0].id))) {
      throw new Error('Siparis kalemi eslesmesi belirsiz: finans verileri korunarak guncelleme durduruldu.')
    }
    const match = matches[0]
    if (match) used.add(match.id)
    return { item, existingId: match?.id }
  })

  // Incomplete API responses must not delete financial entries or create replacement rows.
  if (existing.some(item => !used.has(item.id))) {
    throw new Error('Mevcut siparis kalemleri API cevabiyla eslesmedi: finans verileri korunarak guncelleme durduruldu.')
  }
  return plan
}

export async function syncOrderItemsPreservingFinance(
  tx: Prisma.TransactionClient,
  orderId: string,
  incoming: IncomingItem[],
) {
  const existing = await tx.orderItem.findMany({ where: { orderId } })
  const plan = planOrderItemSync(existing, incoming)
  for (const { item, existingId } of plan) {
    if (!existingId) {
      await tx.orderItem.create({ data: { ...item, orderId } })
      continue
    }
    // Fees and manual purchase cost belong to Finance after the initial import.
    // Omit them entirely so concurrent manual edits are not overwritten either.
    await tx.orderItem.update({
      where: { id: existingId },
      data: {
        marketplaceProductId: item.marketplaceProductId ?? undefined,
        sku: item.sku ?? undefined,
        title: item.title,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        discountAmount: item.discountAmount,
        vatRate: item.vatRate ?? undefined,
        productId: item.productId ?? undefined,
        sourceId: item.sourceId ?? undefined,
      },
    })
  }
}
