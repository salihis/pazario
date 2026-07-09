CREATE TABLE "marketplace_external_products" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "marketplace" "marketplace" NOT NULL,
  "listingKey" VARCHAR(200) NOT NULL,
  "externalListingId" VARCHAR(200),
  "stockCode" VARCHAR(200),
  "barcode" VARCHAR(200),
  "title" VARCHAR(700) NOT NULL,
  "brand" VARCHAR(200),
  "categoryName" VARCHAR(700),
  "imageUrl" TEXT,
  "price" DECIMAL(12,2),
  "stock" INTEGER,
  "status" "listing_status" NOT NULL DEFAULT 'PUBLISHED',
  "raw" JSONB NOT NULL DEFAULT '{}',
  "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "marketplace_external_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketplace_external_products_marketplace_listingKey_key"
  ON "marketplace_external_products"("marketplace", "listingKey");

CREATE INDEX "marketplace_external_products_marketplace_status_idx"
  ON "marketplace_external_products"("marketplace", "status");

CREATE INDEX "marketplace_external_products_stockCode_idx"
  ON "marketplace_external_products"("stockCode");

CREATE INDEX "marketplace_external_products_barcode_idx"
  ON "marketplace_external_products"("barcode");
