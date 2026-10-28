CREATE TABLE "local_sync_state" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lastSeenAt" TIMESTAMPTZ,
    "lastSyncAt" TIMESTAMPTZ,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "pendingProducts" INTEGER NOT NULL DEFAULT 0,
    "syncedProducts" INTEGER NOT NULL DEFAULT 0,
    "failedProducts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "local_sync_state_pkey" PRIMARY KEY ("id")
);
