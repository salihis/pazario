import { Router } from 'express'
import {
  createMarketplaceCredential,
  deleteMarketplaceCredential,
  getMarketplaceCredential,
  listMarketplaceCredentials,
  marketplaceCredentialSchema,
  marketplaceCredentialUpdateSchema,
  testMarketplaceCredential,
  updateMarketplaceCredential,
} from '../controllers/marketplaceCredential.controller'
import { validateBody } from '../middleware/validate'

const router = Router()

router.get('/marketplace-credentials', listMarketplaceCredentials)
router.get('/marketplace-credentials/:id', getMarketplaceCredential)
router.post('/marketplace-credentials', validateBody(marketplaceCredentialSchema), createMarketplaceCredential)
router.put('/marketplace-credentials/:id', validateBody(marketplaceCredentialUpdateSchema), updateMarketplaceCredential)
router.delete('/marketplace-credentials/:id', deleteMarketplaceCredential)
router.post('/marketplace-credentials/:id/test', testMarketplaceCredential)

export default router
