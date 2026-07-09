ALTER TABLE "price_rules"
ADD COLUMN IF NOT EXISTS "priceStart" DECIMAL(12, 2),
ADD COLUMN IF NOT EXISTS "priceEnd" DECIMAL(12, 2);

CREATE INDEX IF NOT EXISTS "price_rules_marketplace_active_price_range_idx"
ON "price_rules" ("marketplace", "active", "priceStart", "priceEnd");
