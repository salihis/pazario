import { z } from 'zod'

export const mediaUrl = z.string().trim().max(2048).refine(value => {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password
      && !u.hostname.includes(':') && !/^\d+\./.test(u.hostname)
      && u.hostname.includes('.') && !/\.(local|localhost|internal)$/.test(u.hostname)
  } catch { return false }
}, 'Herkese acik bir HTTPS baglantisi gerekli')

export const mediaInput = z.object({
  images: z.array(mediaUrl).max(20),
  videos: z.array(mediaUrl.refine(value => {
    try { return /\.mp4$/i.test(new URL(value).pathname) } catch { return false }
  }, 'Video baglantisi MP4 olmali')).max(3),
  version: z.number().int().min(0),
  productIds: z.array(z.string().uuid()).max(100).optional(),
}).strict()

type Overrides = { addedImages: string[]; hiddenImages: string[]; order: string[]; videos: string[] }
type MediaProduct = { images: string[]; manualMedia?: unknown }
const unique = (values: string[]) => [...new Set(values)]
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

export function readMediaOverrides(value: unknown): Overrides {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return { addedImages: strings(o.addedImages), hiddenImages: strings(o.hiddenImages), order: strings(o.order), videos: strings(o.videos) }
}

export function effectiveProductMedia(product: MediaProduct) {
  const o = readMediaOverrides(product.manualMedia)
  const available = unique([...o.addedImages, ...product.images.filter(url => !o.hiddenImages.includes(url))])
  const images = unique([...o.order.filter(url => available.includes(url)), ...available])
  return { images, videos: o.videos }
}

export function buildMediaOverrides(product: MediaProduct, images: string[], videos: string[]): Overrides {
  const previous = readMediaOverrides(product.manualMedia)
  return {
    addedImages: unique(images.filter(url => previous.addedImages.includes(url) || !product.images.includes(url))),
    hiddenImages: unique([...previous.hiddenImages, ...product.images].filter(url => !images.includes(url))),
    order: unique(images), videos: unique(videos),
  }
}

export function inspectMediaUpload(buffer: Buffer, mime: string): string {
  if (!buffer.length) throw new Error('Dosya bos')
  if (mime.startsWith('image/') && buffer.length > 8 * 1024 * 1024) throw new Error('Gorsel en fazla 8 MB olabilir')
  if (buffer.length > 40 * 1024 * 1024) throw new Error('Video en fazla 40 MB olabilir')
  if (mime === 'image/jpeg' && buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpg'
  if (mime === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png'
  if (mime === 'video/mp4' && buffer.toString('ascii', 4, 8) === 'ftyp'
    && ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(buffer.toString('ascii', 8, 12))) return 'mp4'
  throw new Error('Dosya icerigi desteklenen JPG, PNG veya MP4 turuyle uyusmuyor')
}
