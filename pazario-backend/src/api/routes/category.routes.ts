// src/api/routes/category.routes.ts

import { Router } from 'express'
import {
  getPendingMappings,
  approveMapping,
  approveManual,
  rejectMapping,
  bulkApprove,
  searchCategories,
  getCategoryStats,
} from '../controllers/category.controller'

const router = Router()

router.get('/category-mappings/pending', getPendingMappings)
router.put('/category-mappings/:id/approve', approveMapping)
router.put('/category-mappings/:id/approve-manual', approveManual)
router.put('/category-mappings/:id/reject', rejectMapping)
router.post('/category-mappings/bulk-approve', bulkApprove)
router.get('/marketplace-categories/:marketplace/search', searchCategories)
router.get('/category-stats', getCategoryStats)

export default router