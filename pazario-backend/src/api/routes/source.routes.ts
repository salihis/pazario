// src/api/routes/source.routes.ts

import { Router } from 'express'
import {
  getSources,
  createSource,
  updateSource,
  deleteSource,
  testSource,
  syncSource,
  getSyncJobs,
  uploadXML,
} from '../controllers/source.controller'

const router = Router()

router.get('/sources', getSources)
router.post('/sources', createSource)
router.post('/sources/upload', uploadXML)
router.put('/sources/:id', updateSource)
router.delete('/sources/:id', deleteSource)
router.post('/sources/test', testSource)
router.post('/sources/:id/sync', syncSource)
router.get('/sync-jobs', getSyncJobs)

export default router