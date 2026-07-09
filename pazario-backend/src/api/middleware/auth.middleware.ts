// src/api/middleware/auth.middleware.ts

import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../../config/env'
import { logger } from '../../utils/logger'

interface JwtPayload {
  id: string
  email: string
  role: string
}

export interface AuthRequest extends Request {
  user?: JwtPayload
}

/**
 * JWT Bearer token'ı RS256 algoritmasıyla doğrular.
 * Geçersiz veya süresi dolmuş token'da 401 döndürür.
 */
export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization header missing or invalid' })
      return
    }

    const token = authHeader.substring(7)

    const decoded = jwt.verify(token, env.JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
    }) as JwtPayload

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
    }

    next()
  } catch (error) {
    logger.warn({ err: error }, 'JWT doğrulama hatası')
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
