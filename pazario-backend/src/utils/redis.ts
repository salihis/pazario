// src/utils/redis.ts

import { Redis } from 'ioredis'
import { env } from '../config/env'

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

redis.on('error', (err: Error) => {
  process.stderr.write(`Redis bağlantı hatası: ${err.message}\n`)
})
