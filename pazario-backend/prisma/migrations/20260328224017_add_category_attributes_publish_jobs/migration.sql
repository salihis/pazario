-- CreateEnum
CREATE TYPE "attribute_type" AS ENUM ('dropdown', 'multi_select', 'free_text', 'number', 'boolean', 'color');

-- CreateEnum
CREATE TYPE "publish_status" AS ENUM ('QUEUED', 'SUBMITTED', 'POLLING', 'SUCCESS', 'FAILED', 'POLLING_TIMEOUT');

-- CreateTable
CREATE TABLE "marketplace_category_attributes" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "categoryId" VARCHAR(100) NOT NULL,
    "attributeId" VARCHAR(100) NOT NULL,
    "attributeName" VARCHAR(200) NOT NULL,
    "attributeType" "attribute_type" NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "allowCustomValue" BOOLEAN NOT NULL DEFAULT false,
    "values" JSONB,
    "validationRules" JSONB,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_category_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attributes" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "attributeId" VARCHAR(100) NOT NULL,
    "attributeName" VARCHAR(200),
    "valueId" VARCHAR(100),
    "valueText" TEXT,
    "isInherited" BOOLEAN NOT NULL DEFAULT false,
    "savedBy" VARCHAR(100),
    "savedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_publish_jobs" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "externalJobId" VARCHAR(200),
    "status" "publish_status" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMPTZ,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMPTZ,
    "resolvedAt" TIMESTAMPTZ,
    "triggeredBy" VARCHAR(100),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_publish_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_category_attributes_marketplace_categoryId_isMa_idx" ON "marketplace_category_attributes"("marketplace", "categoryId", "isMandatory");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_category_attributes_marketplace_categoryId_attr_key" ON "marketplace_category_attributes"("marketplace", "categoryId", "attributeId");

-- CreateIndex
CREATE INDEX "product_attributes_productId_marketplace_idx" ON "product_attributes"("productId", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "product_attributes_productId_marketplace_attributeId_key" ON "product_attributes"("productId", "marketplace", "attributeId");

-- CreateIndex
CREATE INDEX "product_publish_jobs_status_marketplace_lastPolledAt_idx" ON "product_publish_jobs"("status", "marketplace", "lastPolledAt");

-- CreateIndex
CREATE INDEX "product_publish_jobs_productId_marketplace_idx" ON "product_publish_jobs"("productId", "marketplace");

-- AddForeignKey
ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_publish_jobs" ADD CONSTRAINT "product_publish_jobs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
