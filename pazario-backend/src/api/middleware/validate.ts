// src/api/middleware/validate.ts

import { Request, Response, NextFunction } from 'express'
import { ZodSchema } from 'zod'

/**
 * Zod şeması ile request body validasyonu
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Validasyon hatası',
        details: result.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      })
      return
    }
    req.body = result.data
    next()
  }
}