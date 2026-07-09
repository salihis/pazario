import { Router } from 'express'
import {
  bulkCheckProductMarketplacePublish,
  checkProductMarketplacePublish,
  getProductCategories,
  getProducts,
  publishProductToSocial,
  updateProduct,
} from '../controllers/product.controller'

const router = Router()
router.get('/products/categories', getProductCategories)
router.post('/products/marketplace-check', bulkCheckProductMarketplacePublish)
router.post('/products/:id/marketplace-check', checkProductMarketplacePublish)
router.post('/products/:id/social-publish', publishProductToSocial)
router.patch('/products/:id', updateProduct)
router.get('/products', getProducts)
export default router
