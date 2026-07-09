// src/api/routes/category.routes.ts

import { Router } from 'express'
import {
  getCategoryMappings,
  generateCategoryMappings,
  getPendingMappings,
  suggestCategoryMappings,
  approveMapping,
  approveManual,
  getMappingDefaultAttributes,
  saveMappingDefaultAttributes,
  rejectMapping,
  resetMapping,
  bulkApprove,
  searchCategories,
  getCategoryStats,
  syncMarketplaceCategories,
} from '../controllers/category.controller'

const router = Router()

router.get('/category-mappings', getCategoryMappings)
router.post('/category-mappings/generate', generateCategoryMappings)
router.post('/category-mappings/suggest', suggestCategoryMappings)
router.get('/category-mappings/pending', getPendingMappings)
router.put('/category-mappings/:id/approve', approveMapping)
router.put('/category-mappings/:id/approve-manual', approveManual)
router.get('/category-mappings/:id/default-attributes', getMappingDefaultAttributes)
router.put('/category-mappings/:id/default-attributes', saveMappingDefaultAttributes)
router.put('/category-mappings/:id/reject', rejectMapping)
router.put('/category-mappings/:id/reset', resetMapping)
router.post('/category-mappings/bulk-approve', bulkApprove)
router.post('/marketplace-categories/:marketplace/sync', syncMarketplaceCategories)
router.get('/marketplace-categories/:marketplace/search', searchCategories)
router.get('/category-stats', getCategoryStats)

export default router
