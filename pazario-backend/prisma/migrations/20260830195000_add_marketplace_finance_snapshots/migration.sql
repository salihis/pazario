CREATE TABLE "marketplace_finance_snapshots" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "merchantId" VARCHAR(100) NOT NULL,
    "orderNumber" VARCHAR(100) NOT NULL,
    "transactions" JSONB NOT NULL,
    "syncedAt" TIMESTAMPTZ,
    "lastError" VARCHAR(500),
    "updatedAt" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "marketplace_finance_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "marketplace_finance_snapshots_scope_key" ON "marketplace_finance_snapshots"("marketplace", "environment", "merchantId", "orderNumber");
