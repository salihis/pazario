import { Marketplace, MarketplaceCredential } from '@prisma/client'
import { Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../../db'
import { decryptJson, encryptJson } from '../../services/FieldEncryptionService'
import { testMarketplaceCredentials } from '../../services/MarketplaceCredentialTestService'

const MARKETPLACES: Marketplace[] = ['TRENDYOL', 'PAZARAMA', 'N11', 'HEPSIBURADA']
const MASK_VALUE = '********'

export const marketplaceCredentialSchema = z.object({
  marketplace: z.enum(['TRENDYOL', 'PAZARAMA', 'N11', 'HEPSIBURADA']),
  name: z.string().trim().min(1).max(100),
  credentials: z.record(z.string().trim().max(1000)).default({}),
  isActive: z.boolean().default(false),
})

export const marketplaceCredentialUpdateSchema = marketplaceCredentialSchema.partial().extend({
  credentials: z.record(z.string().trim().max(1000)).optional(),
})

type CredentialPayload = z.infer<typeof marketplaceCredentialSchema>
type CredentialUpdatePayload = z.infer<typeof marketplaceCredentialUpdateSchema>

const credentialFields: Record<Marketplace, string[]> = {
  TRENDYOL: ['supplierId', 'apiKey', 'apiSecret'],
  PAZARAMA: ['clientId', 'clientSecret'],
  N11: ['appKey', 'appSecret'],
  HEPSIBURADA: ['merchantId', 'serviceKey'],
}

function publicCredential(record: MarketplaceCredential) {
  const credentials = decryptJson(record.credentialsEncrypted)
  const credentialStatus = Object.fromEntries(
    credentialFields[record.marketplace].map(field => [field, Boolean(credentials[field])])
  )

  return {
    id: record.id,
    marketplace: record.marketplace,
    name: record.name,
    isActive: record.isActive,
    credentialStatus,
    lastTestStatus: record.lastTestStatus,
    lastTestMessage: record.lastTestMessage,
    lastTestAt: record.lastTestAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function sanitizeCredentials(marketplace: Marketplace, credentials: Record<string, string>) {
  const allowedFields = credentialFields[marketplace]
  return Object.fromEntries(
    allowedFields.map(field => [field, String(credentials[field] ?? '').trim()])
  )
}

function mergeCredentials(
  marketplace: Marketplace,
  currentEncrypted: string | null,
  nextCredentials: Record<string, string> | undefined
) {
  const current = currentEncrypted ? decryptJson(currentEncrypted) : {}
  const allowedFields = credentialFields[marketplace]
  const merged: Record<string, string> = {}

  for (const field of allowedFields) {
    const nextValue = nextCredentials?.[field]
    merged[field] = nextValue === undefined || nextValue === MASK_VALUE
      ? String(current[field] ?? '')
      : String(nextValue ?? '').trim()
  }

  return merged
}

function marketplaceFromBody(body: CredentialPayload | CredentialUpdatePayload, fallback?: Marketplace): Marketplace | null {
  const marketplace = String(body.marketplace ?? fallback ?? '').toUpperCase() as Marketplace
  return MARKETPLACES.includes(marketplace) ? marketplace : null
}

export async function listMarketplaceCredentials(_req: Request, res: Response) {
  try {
    const records = await prisma.marketplaceCredential.findMany({
      orderBy: { marketplace: 'asc' },
    })

    res.json({ success: true, data: records.map(publicCredential) })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Pazaryeri API bilgileri listelenemedi' })
  }
}

export async function getMarketplaceCredential(req: Request, res: Response) {
  try {
    const record = await prisma.marketplaceCredential.findUnique({ where: { id: req.params.id } })
    if (!record) {
      res.status(404).json({ success: false, error: 'Pazaryeri API bilgisi bulunamadi' })
      return
    }

    res.json({ success: true, data: publicCredential(record) })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Pazaryeri API bilgisi alinamadi' })
  }
}

export async function createMarketplaceCredential(req: Request, res: Response) {
  try {
    const body = req.body as CredentialPayload
    const marketplace = marketplaceFromBody(body)
    if (!marketplace) {
      res.status(400).json({ success: false, error: 'Gecersiz pazaryeri' })
      return
    }

    const credentials = sanitizeCredentials(marketplace, body.credentials)
    const record = await prisma.marketplaceCredential.create({
      data: {
        marketplace,
        name: body.name,
        credentialsEncrypted: encryptJson(credentials),
        isActive: body.isActive,
      },
    })

    res.status(201).json({ success: true, data: publicCredential(record) })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, error: 'Bu pazaryeri icin API bilgisi zaten kayitli' })
      return
    }
    res.status(500).json({ success: false, error: 'Pazaryeri API bilgisi kaydedilemedi' })
  }
}

export async function updateMarketplaceCredential(req: Request, res: Response) {
  try {
    const current = await prisma.marketplaceCredential.findUnique({ where: { id: req.params.id } })
    if (!current) {
      res.status(404).json({ success: false, error: 'Pazaryeri API bilgisi bulunamadi' })
      return
    }

    const body = req.body as CredentialUpdatePayload
    const marketplace = marketplaceFromBody(body, current.marketplace)
    if (!marketplace) {
      res.status(400).json({ success: false, error: 'Gecersiz pazaryeri' })
      return
    }

    const credentials = mergeCredentials(marketplace, current.credentialsEncrypted, body.credentials)
    const record = await prisma.marketplaceCredential.update({
      where: { id: current.id },
      data: {
        marketplace,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.credentials !== undefined || marketplace !== current.marketplace
          ? { credentialsEncrypted: encryptJson(credentials) }
          : {}),
      },
    })

    res.json({ success: true, data: publicCredential(record) })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, error: 'Bu pazaryeri icin API bilgisi zaten kayitli' })
      return
    }
    res.status(500).json({ success: false, error: 'Pazaryeri API bilgisi guncellenemedi' })
  }
}

export async function deleteMarketplaceCredential(req: Request, res: Response) {
  try {
    await prisma.marketplaceCredential.delete({ where: { id: req.params.id } })
    res.status(204).send()
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ success: false, error: 'Pazaryeri API bilgisi bulunamadi' })
      return
    }
    res.status(500).json({ success: false, error: 'Pazaryeri API bilgisi silinemedi' })
  }
}

export async function testMarketplaceCredential(req: Request, res: Response) {
  try {
    const current = await prisma.marketplaceCredential.findUnique({ where: { id: req.params.id } })
    if (!current) {
      res.status(404).json({ success: false, error: 'Pazaryeri API bilgisi bulunamadi' })
      return
    }

    const result = await testMarketplaceCredentials(
      current.marketplace,
      decryptJson(current.credentialsEncrypted)
    )
    const record = await prisma.marketplaceCredential.update({
      where: { id: current.id },
      data: {
        lastTestStatus: result.status,
        lastTestMessage: result.message,
        lastTestAt: new Date(),
      },
    })

    res.json({ success: true, data: publicCredential(record) })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Pazaryeri baglanti testi calistirilamadi' })
  }
}
