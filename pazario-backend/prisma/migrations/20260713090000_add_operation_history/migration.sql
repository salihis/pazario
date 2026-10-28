DO $$ BEGIN
  CREATE TYPE "operation_type" AS ENUM (
    'PRODUCT_PUBLISH',
    'VARIANT_UPDATE',
    'STOCK_UPDATE',
    'PRICE_UPDATE',
    'STOCK_PRICE_UPDATE',
    'XML_SYNC',
    'ORDER_FETCH',
    'MARKETPLACE_IMPORT'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "operation_status" AS ENUM (
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'PARTIALLY_FAILED',
    'WAITING_MARKETPLACE',
    'RETRYING'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "operation_item_status" AS ENUM (
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'SKIPPED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "operation_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "type" "operation_type" NOT NULL,
  "status" "operation_status" NOT NULL DEFAULT 'QUEUED',
  "title" VARCHAR(250) NOT NULL,
  "marketplace" "marketplace",
  "queueName" VARCHAR(100),
  "queueJobId" VARCHAR(100),
  "externalBatchId" VARCHAR(250),
  "requestedBy" VARCHAR(100),
  "sourceId" UUID,
  "syncJobId" UUID,
  "productPublishJobId" UUID,
  "targetCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "maxRetryCount" INTEGER NOT NULL DEFAULT 3,
  "errorMessage" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "retryPayload" JSONB,
  "startedAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operation_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "operation_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operationId" UUID NOT NULL,
  "productId" UUID,
  "sku" VARCHAR(150),
  "barcode" VARCHAR(150),
  "variantGroupKey" VARCHAR(250),
  "status" "operation_item_status" NOT NULL DEFAULT 'QUEUED',
  "externalListingId" VARCHAR(250),
  "externalBatchId" VARCHAR(250),
  "errorMessage" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "startedAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operation_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "operation_history_status_type_createdAt_idx"
  ON "operation_history"("status", "type", "createdAt");

CREATE INDEX IF NOT EXISTS "operation_history_marketplace_status_idx"
  ON "operation_history"("marketplace", "status");

CREATE INDEX IF NOT EXISTS "operation_history_queueName_queueJobId_idx"
  ON "operation_history"("queueName", "queueJobId");

CREATE INDEX IF NOT EXISTS "operation_items_operationId_status_idx"
  ON "operation_items"("operationId", "status");

CREATE INDEX IF NOT EXISTS "operation_items_productId_idx"
  ON "operation_items"("productId");

CREATE INDEX IF NOT EXISTS "operation_items_sku_idx"
  ON "operation_items"("sku");

DO $$ BEGIN
  ALTER TABLE "operation_items"
    ADD CONSTRAINT "operation_items_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "operation_history"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "operation_items"
    ADD CONSTRAINT "operation_items_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
