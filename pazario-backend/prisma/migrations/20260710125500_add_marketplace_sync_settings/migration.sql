-- CreateTable
CREATE TABLE "marketplace_sync_settings" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'stock-price',
    "scheduleTime" VARCHAR(5) NOT NULL DEFAULT '03:00',
    "limit" INTEGER NOT NULL DEFAULT 1000,
    "lastRunAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "marketplace_sync_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_sync_settings_marketplace_key" ON "marketplace_sync_settings"("marketplace");
