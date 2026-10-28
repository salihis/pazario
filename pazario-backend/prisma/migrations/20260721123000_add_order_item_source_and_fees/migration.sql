-- Bring order_items in sync with the Prisma model used by order ingestion.
-- IF NOT EXISTS keeps this migration safe for databases where any column or
-- index may already have been added manually.
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "sourceId" UUID,
  ADD COLUMN IF NOT EXISTS "shippingFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "serviceFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "extraFees" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "order_items_sourceId_idx"
  ON "order_items"("sourceId");

CREATE INDEX IF NOT EXISTS "order_items_productId_idx"
  ON "order_items"("productId");

DO $$ BEGIN
  ALTER TABLE "order_items"
    ADD CONSTRAINT "order_items_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "xml_sources"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
