// src/utils/redis.ts

import { Redis } from 'ioredis'

export const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null,
})

redis.on('error', (err) => {
  process.stderr.write(`Redis bağlantı hatası: ${err.message}\n`)
})