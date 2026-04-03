import { describe, it, expect } from 'vitest'
import { PriceEngine, PriceRuleNotFoundError, InvalidRuleError, PriceCalculationError } from '../services/PriceEngine'

describe('PriceEngine', () => {
  describe('Error classes', () => {
    it('should create PriceRuleNotFoundError', () => {
      const error = new PriceRuleNotFoundError('TRENDYOL', 'prod-1')
      expect(error.message).toContain('No price rule found')
      expect(error.name).toBe('PriceRuleNotFoundError')
    })

    it('should create InvalidRuleError', () => {
      const error = new InvalidRuleError('Invalid kar_orani')
      expect(error.message).toBe('Invalid kar_orani')
      expect(error.name).toBe('InvalidRuleError')
    })

    it('should create PriceCalculationError', () => {
      const error = new PriceCalculationError('Invalid price')
      expect(error.message).toBe('Invalid price')
      expect(error.name).toBe('PriceCalculationError')
    })
  })
})