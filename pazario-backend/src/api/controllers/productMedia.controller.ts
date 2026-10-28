import { Request, Response } from 'express'
import { Prisma, PrismaClient } from '@prisma/client'
import { mkdir, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildMediaOverrides, effectiveProductMedia, inspectMediaUpload, mediaInput, readMediaOverrides } from '../../services/ProductMediaService'

const prisma = new PrismaClient()
export const mediaDirectory = () => path.resolve(process.env.PRODUCT_MEDIA_DIR || './media')
const idValid = (id: string) => /^[a-f0-9-]{36}$/i.test(id)

export async function getProductMedia(req: Request, res: Response) {
  if (!idValid(req.params.id)) { res.status(400).json({ error: 'Gecersiz urun' }); return }
  const product = await prisma.product.findUnique({ where: { id: req.params.id } })
  if (!product) { res.status(404).json({ error: 'Urun bulunamadi' }); return }
  const media = effectiveProductMedia(product)
  const manual = readMediaOverrides(product.manualMedia)
  res.json({ success: true, data: { ...media, version: product.mediaVersion, xmlImages: product.images,
    manualImages: manual.addedImages, title: product.title, sku: product.sku } })
}

export async function saveProductMedia(req: Request, res: Response) {
  const input = mediaInput.safeParse(req.body)
  if (!idValid(req.params.id) || !input.success) {
    res.status(400).json({ error: input.success ? 'Gecersiz urun' : input.error.issues[0].message }); return
  }
  try {
    await prisma.$transaction(async tx => {
      const ids = [...new Set([req.params.id, ...(input.data.productIds ?? [])])].sort()
      await tx.$queryRaw`SELECT id FROM products WHERE id::text IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
      const product = await tx.product.findUnique({ where: { id: req.params.id } })
      if (!product) throw new Error('Urun bulunamadi')
      if (product.mediaVersion !== input.data.version) throw new Error('Medya baska bir oturumda degisti. Ekrani yeniden acin.')
      const targets = await tx.product.findMany({ where: { id: { in: ids }, sourceId: product.sourceId } })
      if (targets.length !== ids.length) throw new Error('Urunler ayni kaynaga ait olmali')
      for (const target of targets) {
        const manualMedia = buildMediaOverrides(target, input.data.images, input.data.videos)
        await tx.product.update({ where: { id: target.id }, data: {
          manualMedia: manualMedia as unknown as Prisma.InputJsonValue, mediaVersion: { increment: 1 },
        } })
      }
      // Mark content stale without publishing or changing live listing status.
      await tx.marketplaceListing.updateMany({ where: { productId: { in: ids } }, data: { hashAtPublish: null } })
    })
    res.json({ success: true })
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Medya kaydedilemedi' })
  }
}

export async function uploadProductMedia(req: Request, res: Response) {
  try {
    if (!idValid(req.params.id)) throw new Error('Gecersiz urun')
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!product) { res.status(404).json({ error: 'Urun bulunamadi' }); return }
    if (!Buffer.isBuffer(req.body)) throw new Error('Dosya icerigi gerekli')
    const extension = inspectMediaUpload(req.body, (req.headers['content-type'] || '').split(';')[0])
    const base = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:3000')
    if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('PUBLIC_BASE_URL HTTPS olmali')
    const name = `${randomUUID()}.${extension}`
    await mkdir(mediaDirectory(), { recursive: true })
    const disk = await statfs(mediaDirectory())
    if (disk.bavail * disk.bsize < req.body.length + 256 * 1024 * 1024) throw new Error('Medya icin yeterli disk alani yok')
    await writeFile(path.join(mediaDirectory(), name), req.body, { flag: 'wx', mode: 0o644 })
    res.status(201).json({ success: true, data: { url: `${base.origin}/api/product-media/${name}`, kind: extension === 'mp4' ? 'video' : 'image' } })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Dosya yuklenemedi' })
  }
}
