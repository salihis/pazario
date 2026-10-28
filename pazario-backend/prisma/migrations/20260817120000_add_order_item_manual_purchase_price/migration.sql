-- Optional per-unit purchase cost override for finance rows.
-- NULL keeps the existing XML-derived purchase cost behavior.
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "manualPurchasePrice" DECIMAL(12,2);
