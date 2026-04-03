// src/utils/logger.ts
import pino from 'pino'

const logLevel = (process.env.LOG_LEVEL || 'info') as pino.LevelWithSilent

export const logger = pino(
  {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
              singleLine: false,
            },
          },
  },
  pino.destination()
)

// Context-aware logging helpers
export const createLogger = (context: string) => {
  return {
    info: (msg: string, data?: Record<string, any>) =>
      logger.info({ context, ...data }, msg),
    error: (msg: string, error?: Error | any, data?: Record<string, any>) =>
      logger.error({ context, error, ...data }, msg),
    warn: (msg: string, data?: Record<string, any>) =>
      logger.warn({ context, ...data }, msg),
    debug: (msg: string, data?: Record<string, any>) =>
      logger.debug({ context, ...data }, msg),
  }
}

// Marketplace-specific logger
export const createMarketplaceLogger = (marketplace: string, context: string) => {
  return {
    info: (msg: string, data?: Record<string, any>) =>
      logger.info({ marketplace, context, ...data }, msg),
    error: (msg: string, error?: Error | any, data?: Record<string, any>) =>
      logger.error({ marketplace, context, error, ...data }, msg),
    warn: (msg: string, data?: Record<string, any>) =>
      logger.warn({ marketplace, context, ...data }, msg),
    debug: (msg: string, data?: Record<string, any>) =>
      logger.debug({ marketplace, context, ...data }, msg),
  }
}

// Request logging middleware
export const requestLogger = (req: any, res: any, next: any) => {
  const start = Date.now()

  res.on('finish', () => {
    const duration = Date.now() - start
    logger.info(
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        timestamp: new Date().toISOString(),
      },
      `${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`
    )
  })

  next()
}
