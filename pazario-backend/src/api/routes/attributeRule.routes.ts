import { Router } from 'express'
import {
  applyMappingAttributeRules,
  attributeRuleRunSchema,
  attributeRuleSchema,
  createAttributeRule,
  deleteAttributeRule,
  listAttributeRules,
  previewMappingAttributeRules,
  updateAttributeRule,
} from '../controllers/attributeRule.controller'
import { validateBody } from '../middleware/validate'

const router = Router()

router.get('/attribute-rules', listAttributeRules)
router.post('/attribute-rules', validateBody(attributeRuleSchema), createAttributeRule)
router.put('/attribute-rules/:id', validateBody(attributeRuleSchema), updateAttributeRule)
router.delete('/attribute-rules/:id', deleteAttributeRule)
router.post('/category-mappings/:id/attribute-rules/preview', validateBody(attributeRuleRunSchema), previewMappingAttributeRules)
router.post('/category-mappings/:id/attribute-rules/apply', validateBody(attributeRuleRunSchema), applyMappingAttributeRules)

export default router
