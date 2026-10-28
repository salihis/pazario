import { Router } from 'express'
import { getOperation, listOperations, retryOperation } from '../controllers/operation.controller'

const router = Router()

router.get('/operations', listOperations)
router.get('/operations/:id', getOperation)
router.post('/operations/:id/retry', retryOperation)

export default router
