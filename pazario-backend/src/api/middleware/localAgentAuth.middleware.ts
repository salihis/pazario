import { RequestHandler } from 'express'
import { env } from '../../config/env'
import { ApiResponseBuilder } from '../../utils/apiResponse'
import { requireAuth } from './auth.middleware'

function hasValidLocalAgentToken(header: string): boolean {
  const [scheme, token] = header.split(' ')
  return Boolean(env.LOCAL_AGENT_SYNC_TOKEN && scheme === 'Bearer' && token === env.LOCAL_AGENT_SYNC_TOKEN)
}

export const requireLocalAgentToken: RequestHandler = (req, res, next) => {
  if (!env.LOCAL_AGENT_SYNC_TOKEN) {
    res.status(503).json(ApiResponseBuilder.error('Local agent token tanimli degil', 'LOCAL_AGENT_TOKEN_MISSING'))
    return
  }

  const header = req.headers.authorization ?? ''

  if (!hasValidLocalAgentToken(header)) {
    res.status(401).json(ApiResponseBuilder.unauthorized())
    return
  }

  next()
}

export const requireLocalAgentOrJwt: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization ?? ''
  if (hasValidLocalAgentToken(header)) {
    next()
    return
  }

  requireAuth(req, res, next)
}
