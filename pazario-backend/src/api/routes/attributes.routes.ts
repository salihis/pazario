// src/api/routes/attributes.routes.ts

import { Router } from 'express'
import {
  getCategoryAttributes,
  refreshCategoryAttributes,
  getProductAttributes,
  saveProductAttributes,
  bulkApplyAttributes,
  getCompleteness,
  submitPublish,
  getPublishJobs,
  getPublishJob,
  retryPublishJob,
  retryAllFailed,
  getPublishStatus,
} from '../controllers/attributes.controller'

const router = Router()

// Kategori özellikler
router.get('/category-attributes/:marketplace/:categoryId', getCategoryAttributes)
router.post('/category-attributes/:marketplace/:categoryId/refresh', refreshCategoryAttributes)
router.get('/products/:productId/attributes/:marketplace', getProductAttributes)
router.put('/products/:productId/attributes/:marketplace', saveProductAttributes)
router.post('/products/attributes/bulk-apply', bulkApplyAttributes)
router.get('/products/attributes/completeness', getCompleteness)

// Gönderim
router.post('/publish/submit', submitPublish)
router.get('/publish/jobs', getPublishJobs)
router.post('/publish/jobs/retry-failed', retryAllFailed)
router.get('/publish/jobs/:jobId', getPublishJob)
router.post('/publish/jobs/:jobId/retry', retryPublishJob)
router.get('/publish/status/:productId/:marketplace', getPublishStatus)

export default router