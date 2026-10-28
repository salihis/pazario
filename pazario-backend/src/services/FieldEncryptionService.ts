import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from '../config/env'

const ALGORITHM = 'aes-256-gcm'

type EncryptedPayload = {
  v: 1
  alg: typeof ALGORITHM
  iv: string
  tag: string
  data: string
}

function encryptionKey(): Buffer {
  if (!env.FIELD_ENCRYPTION_KEY) {
    throw new Error('FIELD_ENCRYPTION_KEY tanimli degil')
  }

  return createHash('sha256').update(env.FIELD_ENCRYPTION_KEY).digest()
}

export function encryptJson(value: Record<string, string>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])

  const payload: EncryptedPayload = {
    v: 1,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  }

  return JSON.stringify(payload)
}

export function decryptJson(value: string): Record<string, string> {
  const payload = JSON.parse(value) as EncryptedPayload
  if (payload.v !== 1 || payload.alg !== ALGORITHM) {
    throw new Error('Desteklenmeyen sifreli alan formati')
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ])

  return JSON.parse(decrypted.toString('utf8')) as Record<string, string>
}
