import { Router } from 'express'
import {
  archiveUnmatchedTrendyolListings,
  getMarketplaceDailyReport,
  getMarketplaceListings,
  getMarketplaceStats,
  getMarketplaceSyncSettings,
  getUnmatchedMarketplaceListings,
  importMarketplaceListingsController,
  importPazaramaListings,
  markExistingMarketplaceProducts,
  syncMarketplacePrice,
  syncMarketplaceStock,
  syncMarketplaceStockAndPrice,
  updateMarketplaceSyncSetting,
} from '../controllers/marketplace.controller'

const router = Router()

router.get('/marketplace-listings', getMarketplaceListings)
router.get('/marketplace-listings/stats', getMarketplaceStats)
router.get('/marketplace-listings/daily-report', getMarketplaceDailyReport)
router.get('/marketplace-listings/unmatched', getUnmatchedMarketplaceListings)
router.post('/marketplace-listings/stock-sync', syncMarketplaceStock)
router.post('/marketplace-listings/price-sync', syncMarketplacePrice)
router.post('/marketplace-listings/stock-price-sync', syncMarketplaceStockAndPrice)
router.get('/marketplace-sync-settings', getMarketplaceSyncSettings)
router.put('/marketplace-sync-settings/:marketplace', updateMarketplaceSyncSetting)
router.post('/marketplace-listings/archive-unmatched', archiveUnmatchedTrendyolListings)
router.post('/marketplace-listings/import/pazarama', importPazaramaListings)
router.post('/marketplace-listings/import/:marketplace', importMarketplaceListingsController)
router.post('/marketplace-listings/mark-existing', markExistingMarketplaceProducts)

export default router
