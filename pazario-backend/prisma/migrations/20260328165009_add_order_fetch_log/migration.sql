-- CreateTable
CREATE TABLE "order_fetch_logs" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "lastFetchedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_fetch_logs_pkey" PRIMARY KEY ("id")
);
