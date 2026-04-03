// src/api/routes/price.routes.ts

import { Router } from 'express'
import {
  getRules,
  createRule,
  updateRule,
  deleteRule,
  simulatePrice,
  previewProductPrice,
  getSettings,
  updateSettings,
  getCalculations,
  createRuleSchema,
  simulateSchema,
} from '../controllers/price.controller'
import { validateBody } from '../middleware/validate'

const router = Router()

// Fiyat kuralları
router.get('/price-rules', getRules)
router.post('/price-rules', validateBody(createRuleSchema), createRule)
router.put('/price-rules/:ruleId', updateRule)
router.delete('/price-rules/:ruleId', deleteRule)

// Simülasyon ve önizleme
router.post('/price-rules/simulate', validateBody(simulateSchema), simulatePrice)
router.get('/price-rules/preview/:productId', previewProductPrice)

// Global ayarlar
router.get('/price-settings', getSettings)
router.put('/price-settings', updateSettings)

// Audit log
router.get('/price-calculations', getCalculations)

export default router