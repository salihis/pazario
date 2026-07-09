import axios from 'axios'
import http from 'http'
import https from 'https'
import path from 'path'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { TextDecoder } from 'node:util'

const xmlHttpClient = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'python-requests/2.28.0',
    'Accept-Encoding': 'gzip, deflate',
    Accept: 'text/xml,application/xml,*/*;q=0.9',
    Connection: 'keep-alive',
  },
  maxRedirects: 10,
  responseType: 'arraybuffer',
  transformResponse: data => data,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
  }),
})

const FALLBACK_ENCODINGS = ['utf-8', 'windows-1254', 'iso-8859-9', 'iso-8859-1']

function normalizeCharset(value?: string): string | undefined {
  if (!value) return undefined

  const normalized = value.trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (!normalized) return undefined

  if (['utf8', 'utf-8'].includes(normalized)) return 'utf-8'
  if (['windows-1254', 'cp1254', 'x-cp1254'].includes(normalized)) return 'windows-1254'
  if (['iso-8859-9', 'iso8859-9', 'latin5', 'latin-5'].includes(normalized)) return 'iso-8859-9'
  if (['iso-8859-1', 'iso8859-1', 'latin1', 'latin-1'].includes(normalized)) return 'iso-8859-1'

  return normalized
}

function getCharsetFromContentType(contentType?: string): string | undefined {
  const match = contentType?.match(/charset\s*=\s*("?)([^";\s]+)\1/i)
  return normalizeCharset(match?.[2])
}

function getCharsetFromXmlDeclaration(buffer: Buffer): string | undefined {
  const head = buffer.subarray(0, 512).toString('ascii')
  const match = head.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i)
  return normalizeCharset(match?.[1])
}

function decode(buffer: Buffer, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer)
  } catch {
    return undefined
  }
}

function corruptionScore(text: string): number {
  const replacementChars = text.match(/\uFFFD/g)?.length ?? 0
  const questionRuns = text.match(/\?{2,}/g)?.length ?? 0
  const brokenTurkishWords = text.match(
    /\b(B\?y\?k|Kad\?n|Tak\?m|K\?rm\?z\?|G\?m\?\?|Geceli\?|Pijama|Fantezi \?\?|Beden \?\?)\b/gi
  )?.length ?? 0

  return replacementChars * 20 + questionRuns * 8 + brokenTurkishWords * 10
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

export function decodeXmlBuffer(input: ArrayBuffer | Buffer, contentType?: string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const declaredEncoding = getCharsetFromContentType(contentType) ?? getCharsetFromXmlDeclaration(buffer)
  const encodings = unique([declaredEncoding, ...FALLBACK_ENCODINGS])

  let bestText = ''
  let bestScore = Number.POSITIVE_INFINITY

  for (const encoding of encodings) {
    const text = decode(buffer, encoding)
    if (text === undefined) continue

    const score = corruptionScore(text)
    if (score < bestScore) {
      bestText = text
      bestScore = score
    }

    if (score === 0 && encoding === declaredEncoding) break
  }

  return bestText || buffer.toString('utf8')
}

export async function fetchXml(url: string, timeoutMs = 30000): Promise<string> {
  if (url.startsWith('data:text/xml;base64,')) {
    return Buffer.from(url.replace('data:text/xml;base64,', ''), 'base64').toString('utf8')
  }

  if (url.startsWith('file://')) {
    const importDir = path.resolve(process.env.XML_IMPORT_DIR || path.join(process.cwd(), 'imports'))
    const filePath = path.resolve(fileURLToPath(url))
    const relativePath = path.relative(importDir, filePath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`XML dosyasi izin verilen klasor disinda: ${filePath}`)
    }
    const buffer = await readFile(filePath)
    return decodeXmlBuffer(buffer)
  }

  const response = await xmlHttpClient.get<ArrayBuffer>(url, { timeout: timeoutMs })
  return decodeXmlBuffer(response.data, response.headers['content-type'])
}
