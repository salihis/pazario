-- CreateTable
CREATE TABLE "marketplace_credentials" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "credentials_encrypted" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_test_status" VARCHAR(20),
    "last_test_message" TEXT,
    "last_test_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "marketplace_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_credentials_marketplace_key" ON "marketplace_credentials"("marketplace");

-- CreateIndex
CREATE INDEX "marketplace_credentials_marketplace_is_active_idx" ON "marketplace_credentials"("marketplace", "is_active");
