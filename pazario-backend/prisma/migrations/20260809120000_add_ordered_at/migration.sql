ALTER TABLE "orders" ADD COLUMN "orderedAt" TIMESTAMPTZ;

UPDATE "orders"
SET "orderedAt" = "createdAt"
WHERE "orderedAt" IS NULL;

CREATE INDEX "orders_status_orderedAt_idx" ON "orders"("status", "orderedAt");
