import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { XMLParser } from '../../parser/XMLParser'
import axios from 'axios'
import https from 'https'
import http from 'http'

const prisma = new PrismaClient()
const parser = new XMLParser()

const httpClient = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'python-requests/2.28.0',
    'Accept-Encoding': 'gzip, deflate',
    'Accept': '*/*',
    'Connection': 'keep-alive',
  },
  maxRedirects: 10,
  responseType: 'text',
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
  }),
})

export async function getSources(req: Request, res: Response) {
  try {
    const data = await prisma.xmlSource.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { products: true } } },
    })
    res.json({ success: true, data })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

export async function createSource(req: Request, res: Response) {
  try {
    const { name, url, fetchTimeoutSec } = req.body
    if (!name || !url) {
      res.status(400).json({ success: false, error: 'name ve url zorunlu' })
      return
    }
    const source = await prisma.xmlSource.create({
      data: { name, url, fetchTimeoutSec: fetchTimeoutSec ?? 60, active: true },
    })
    res.status(201).json({ success: true, data: source })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Kaynak olusturulamadi' })
  }
}

export async function updateSource(req: Request, res: Response) {
  try {
    const source = await prisma.xmlSource.update({
      where: { id: req.params.id },
      data: req.body,
    })
    res.json({ success: true, data: source })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Kaynak bulunamadi' })
  }
}

export async function deleteSource(req: Request, res: Response) {
  try {
    await prisma.xmlSource.update({
      where: { id: req.params.id },
      data: { active: false },
    })
    res.json({ success: true })
  } catch (e) {
    res.status(404).json({ success: false, error: 'Kaynak bulunamadi' })
  }
}

export async function testSource(req: Request, res: Response) {
  try {
    const { url } = req.body
    if (!url) {
      res.status(400).json({ success: false, error: 'url zorunlu' })
      return
    }

    let xml: string

    const response = await httpClient.get(url)
    xml = String(response.data)

    if (!xml || xml.trim().length === 0) {
      throw new Error('Feed bos dondu')
    }

    const result = await parser.parse(xml)

    res.json({
      success: true,
      data: {
        feedType: result.meta.feedType,
        totalProducts: result.meta.totalNodes,
        parsed: result.meta.parsed,
        failed: result.meta.failed,
        durationMs: result.meta.durationMs,
        sample: result.products.slice(0, 3).map(p => ({
          id: p.id,
          title: p.title,
          price: p.price,
          stock: p.stock,
          images: p.images.length,
        })),
        errors: result.errors.slice(0, 5),
      },
    })
  } catch (e) {
    const err = e as { message?: string; code?: string }
    res.status(400).json({
      success: false,
      error: err.message ?? 'Feed test edilemedi',
    })
  }
}

export async function syncSource(req: Request, res: Response) {
  try {
    const source = await prisma.xmlSource.findUnique({
      where: { id: req.params.id },
    })
    if (!source) {
      res.status(404).json({ success: false, error: 'Kaynak bulunamadi' })
      return
    }

    const syncJob = await prisma.syncJob.create({
      data: { sourceId: source.id, status: 'PENDING' },
    })

    runSync(source.id, syncJob.id).catch(() => {})

    res.status(202).json({ success: true, data: { syncJobId: syncJob.id } })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

async function runSync(sourceId: string, syncJobId: string) {
  const { MarketplacePipeline } = await import('../../MarketplacePipeline')
  const pipeline = new MarketplacePipeline(prisma)

  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: { status: 'RUNNING', startedAt: new Date() },
  })

  try {
    const result = await pipeline.run(syncJobId)
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: 'DONE',
        finishedAt: new Date(),
        totalProducts: result.totalFetched,
        changedProducts: result.changedProducts,
        publishedCount: result.published,
        failedCount: result.failed,
      },
    })
  } catch (e) {
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    })
  }
}

export async function getSyncJobs(req: Request, res: Response) {
  try {
    const sourceId = req.query.sourceId as string | undefined
    const where = sourceId ? { sourceId } : {}
    const data = await prisma.syncJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    res.json({ success: true, data })
  } catch (e) {
    res.status(500).json({ success: false, error: 'Sunucu hatasi' })
  }
}

// ─── XML UPLOAD (Direct XML content) ───────────────────────────────────────

export async function uploadXML(req: Request, res: Response) {
  try {
    const { xml, name } = req.body

    if (!xml || !name) {
      res.status(400).json({
        success: false,
        error: 'xml ve name alanları zorunlu',
        code: 'BAD_REQUEST'
      })
      return
    }

    if (typeof xml !== 'string') {
      res.status(400).json({
        success: false,
        error: 'xml string olmalı',
        code: 'BAD_REQUEST'
      })
      return
    }

    // Create a temporary source for direct XML upload
    const source = await prisma.xmlSource.create({
      data: {
        name: `${name} (Direct Upload)`,
        url: 'data:text/xml;base64,' + Buffer.from(xml).toString('base64'),
        active: true,
        fetchTimeoutSec: 30,
      },
    })

    // Create sync job
    const syncJob = await prisma.syncJob.create({
      data: {
        sourceId: source.id,
        status: 'PENDING',
      },
    })

    // Queue the sync job (process it)
    const { syncQueue } = await import('../../queue/queues')
    await syncQueue.add('sync', { sourceId: source.id, syncJobId: syncJob.id })

    res.status(201).json({
      success: true,
      data: {
        sourceId: source.id,
        syncJobId: syncJob.id,
        message: 'XML uploaded successfully - sync job queued'
      }
    })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    res.status(500).json({
      success: false,
      error,
      code: 'UPLOAD_ERROR'
    })
  }
}