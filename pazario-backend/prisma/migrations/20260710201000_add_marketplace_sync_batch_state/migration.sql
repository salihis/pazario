ALTER TABLE "marketplace_sync_settings"
  ADD COLUMN IF NOT EXISTS "batchStartedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "batchNextRunAt" TIMESTAMPTZ;
