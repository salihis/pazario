-- CreateEnum
CREATE TYPE "sync_job_status" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "marketplace" AS ENUM ('TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA');

-- CreateEnum
CREATE TYPE "listing_status" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'DELISTED');

-- CreateEnum
CREATE TYPE "error_type" AS ENUM ('VALIDATION', 'API', 'NETWORK', 'MAPPING');

-- CreateEnum
CREATE TYPE "price_rule_scope" AS ENUM ('GLOBAL', 'MARKETPLACE', 'CATEGORY', 'BRAND', 'PRODUCT');

-- CreateEnum
CREATE TYPE "category_mapping_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('NEW', 'PENDING_APPROVAL', 'PREPARING', 'LABEL_CREATED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'DELIVERY_FAILED', 'CANCELLATION_REQUESTED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURN_APPROVED', 'RETURN_REJECTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "invoice_type" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "cargo_company" AS ENUM ('ARAS', 'YURTICI', 'SURAT', 'PTT');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VIEWER');

-- CreateTable
CREATE TABLE "xml_sources" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "url" TEXT NOT NULL,
    "fetchTimeoutSec" INTEGER NOT NULL DEFAULT 60,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xml_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "status" "sync_job_status" NOT NULL DEFAULT 'PENDING',
    "totalProducts" INTEGER,
    "changedProducts" INTEGER,
    "publishedCount" INTEGER,
    "failedCount" INTEGER,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMPTZ,
    "finishedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalId" VARCHAR(100) NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "barcode" VARCHAR(20),
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "brand" VARCHAR(100),
    "categoryRaw" VARCHAR(500),
    "price" DECIMAL(12,2) NOT NULL,
    "listPrice" DECIMAL(12,2),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "images" TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "contentHash" CHAR(32) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "status" "listing_status" NOT NULL DEFAULT 'PENDING',
    "externalListingId" VARCHAR(200),
    "lastSyncJobId" UUID,
    "publishedAt" TIMESTAMPTZ,
    "lastUpdatedAt" TIMESTAMPTZ,
    "hashAtPublish" CHAR(32),

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_errors" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "marketplace" VARCHAR(50) NOT NULL,
    "errorType" "error_type" NOT NULL,
    "errorCode" VARCHAR(50),
    "errorMessage" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_rules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "marketplace" VARCHAR(50) NOT NULL,
    "scopeType" "price_rule_scope" NOT NULL,
    "scopeValue" VARCHAR(500),
    "ekTutar" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "karOrani" DECIMAL(6,4) NOT NULL DEFAULT 1.0,
    "kargo" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "komisyonOrani" DECIMAL(5,4) NOT NULL,
    "priority" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" VARCHAR(100),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_calculations" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "marketplace" VARCHAR(50) NOT NULL,
    "ruleId" UUID NOT NULL,
    "syncJobId" UUID NOT NULL,
    "basePrice" DECIMAL(12,2) NOT NULL,
    "ekTutar" DECIMAL(10,2) NOT NULL,
    "karOrani" DECIMAL(6,4) NOT NULL,
    "kargo" DECIMAL(10,2) NOT NULL,
    "komisyonOrani" DECIMAL(5,4) NOT NULL,
    "ara1BaseEk" DECIMAL(12,2) NOT NULL,
    "ara2Kar" DECIMAL(12,2) NOT NULL,
    "ara3Kargo" DECIMAL(12,2) NOT NULL,
    "rawPrice" DECIMAL(12,2) NOT NULL,
    "minPriceApplied" BOOLEAN NOT NULL DEFAULT false,
    "finalPrice" DECIMAL(12,2) NOT NULL,
    "calculatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_calculations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_price_settings" (
    "id" UUID NOT NULL,
    "minPrice" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "updatedBy" VARCHAR(100),
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "global_price_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_mappings" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceCategory" TEXT NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "marketplaceCategoryId" VARCHAR(100),
    "marketplaceCategoryPath" TEXT,
    "status" "category_mapping_status" NOT NULL DEFAULT 'PENDING',
    "aiSuggested" BOOLEAN NOT NULL DEFAULT false,
    "aiConfidence" DECIMAL(4,3),
    "aiReason" TEXT,
    "allSuggestions" JSONB,
    "approvedBy" VARCHAR(100),
    "approvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "category_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_categories" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "categoryId" VARCHAR(100) NOT NULL,
    "categoryPath" TEXT NOT NULL,
    "categoryName" VARCHAR(500) NOT NULL,
    "parentId" VARCHAR(100),
    "isLeaf" BOOLEAN NOT NULL DEFAULT true,
    "fetchedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "marketplace_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "marketplaceOrderId" VARCHAR(100) NOT NULL,
    "marketplaceOrderNo" VARCHAR(100),
    "status" "order_status" NOT NULL DEFAULT 'NEW',
    "customerName" VARCHAR(200),
    "customerPhone" VARCHAR(20),
    "shippingAddress" JSONB,
    "billingAddress" JSONB,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "cargoCompany" VARCHAR(50),
    "trackingNumber" VARCHAR(100),
    "cargoLabelUrl" TEXT,
    "invoiceId" UUID,
    "approvedBy" VARCHAR(100),
    "approvedAt" TIMESTAMPTZ,
    "fetchedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID,
    "marketplaceProductId" VARCHAR(100),
    "sku" VARCHAR(100),
    "title" VARCHAR(500) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "vatRate" INTEGER,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_logs" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" VARCHAR(50),
    "toStatus" VARCHAR(50) NOT NULL,
    "changedBy" VARCHAR(100),
    "note" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "invoiceType" "invoice_type" NOT NULL,
    "invoiceNumber" VARCHAR(100),
    "externalInvoiceId" VARCHAR(100),
    "pdfUrl" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "issuedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "cargoCompany" "cargo_company" NOT NULL,
    "trackingNumber" VARCHAR(100) NOT NULL,
    "labelPdfUrl" TEXT,
    "desi" DECIMAL(6,2),
    "weightKg" DECIMAL(6,3),
    "status" VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    "rawStatus" VARCHAR(100),
    "statusDescription" TEXT,
    "lastLocation" VARCHAR(200),
    "estimatedDelivery" TIMESTAMPTZ,
    "deliveredAt" TIMESTAMPTZ,
    "lastCheckedAt" TIMESTAMPTZ,
    "marketplaceNotifiedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cargo_company_mappings" (
    "id" UUID NOT NULL,
    "cargoCompany" "cargo_company" NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "marketplaceCargoCode" VARCHAR(50) NOT NULL,
    "marketplaceCargoName" VARCHAR(100),

    CONSTRAINT "cargo_company_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(200) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_contentHash_idx" ON "products"("contentHash");

-- CreateIndex
CREATE INDEX "products_barcode_idx" ON "products"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "products_sourceId_externalId_key" ON "products"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "marketplace_listings_status_marketplace_idx" ON "marketplace_listings"("status", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_productId_marketplace_key" ON "marketplace_listings"("productId", "marketplace");

-- CreateIndex
CREATE INDEX "publish_errors_resolved_marketplace_idx" ON "publish_errors"("resolved", "marketplace");

-- CreateIndex
CREATE INDEX "price_rules_marketplace_scopeType_active_idx" ON "price_rules"("marketplace", "scopeType", "active");

-- CreateIndex
CREATE INDEX "price_calculations_productId_marketplace_calculatedAt_idx" ON "price_calculations"("productId", "marketplace", "calculatedAt" DESC);

-- CreateIndex
CREATE INDEX "category_mappings_marketplace_status_idx" ON "category_mappings"("marketplace", "status");

-- CreateIndex
CREATE UNIQUE INDEX "category_mappings_sourceId_sourceCategory_marketplace_key" ON "category_mappings"("sourceId", "sourceCategory", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_categories_marketplace_categoryId_key" ON "marketplace_categories"("marketplace", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_marketplaceOrderId_key" ON "orders"("marketplaceOrderId");

-- CreateIndex
CREATE INDEX "orders_status_marketplace_idx" ON "orders"("status", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_orderId_key" ON "invoices"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_orderId_key" ON "shipments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "cargo_company_mappings_cargoCompany_marketplace_key" ON "cargo_company_mappings"("cargoCompany", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "xml_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "xml_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_lastSyncJobId_fkey" FOREIGN KEY ("lastSyncJobId") REFERENCES "sync_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_errors" ADD CONSTRAINT "publish_errors_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "sync_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_errors" ADD CONSTRAINT "publish_errors_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_calculations" ADD CONSTRAINT "price_calculations_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "price_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "xml_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_logs" ADD CONSTRAINT "order_status_logs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
