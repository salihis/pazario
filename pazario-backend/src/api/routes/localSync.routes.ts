import { Router } from 'express'
import {
  bulkSyncLocalProducts,
  createLocalSyncXmlSource,
  getLocalSyncStatus,
  listLocalSyncXmlSources,
} from '../controllers/localSync.controller'
import { requireLocalAgentOrJwt, requireLocalAgentToken } from '../middleware/localAgentAuth.middleware'

const router = Router()

router.get('/local-sync/status', requireLocalAgentOrJwt, getLocalSyncStatus)
router.get('/local-sync/xml-sources', requireLocalAgentOrJwt, listLocalSyncXmlSources)
router.post('/local-sync/xml-sources', requireLocalAgentToken, createLocalSyncXmlSource)
router.post('/local-sync/products/bulk', requireLocalAgentToken, bulkSyncLocalProducts)

export default router
