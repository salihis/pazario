import { Router, raw } from 'express'
import { getProductMedia, saveProductMedia, uploadProductMedia } from '../controllers/productMedia.controller'
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
router.get('/products/:id/media', getProductMedia)
router.put('/products/:id/media', saveProductMedia)
router.post('/products/:id/media/upload', raw({ type: ['image/jpeg', 'image/png', 'video/mp4'], limit: '40mb' }), uploadProductMedia)
router.post('/products/marketplace-check', bulkCheckProductMarketplacePublish)
router.post('/products/:id/marketplace-check', checkProductMarketplacePublish)
router.post('/products/:id/social-publish', publishProductToSocial)
router.patch('/products/:id', updateProduct)
router.get('/products', getProducts)
export default router
