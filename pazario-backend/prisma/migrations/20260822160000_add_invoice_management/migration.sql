CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'GENERATED', 'APPROVED', 'SENT', 'FAILED');

ALTER TABLE "invoices"
  ADD COLUMN "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "ettn" VARCHAR(100),
  ADD COLUMN "scenario" VARCHAR(30) NOT NULL DEFAULT 'EARSIVFATURA',
  ADD COLUMN "approvedFilePath" TEXT,
  ADD COLUMN "approvedFileName" VARCHAR(255),
  ADD COLUMN "approvedFileSize" INTEGER,
  ADD COLUMN "publicToken" VARCHAR(100),
  ADD COLUMN "marketplaceStatus" VARCHAR(50),
  ADD COLUMN "marketplaceMessage" TEXT,
  ADD COLUMN "marketplaceSentAt" TIMESTAMPTZ,
  ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "invoices_publicToken_key" ON "invoices"("publicToken");

CREATE TABLE "invoice_profiles" (
  "id" VARCHAR(50) NOT NULL DEFAULT 'default',
  "companyName" VARCHAR(200) NOT NULL DEFAULT '',
  "address" TEXT NOT NULL DEFAULT '',
  "phone" VARCHAR(50),
  "fax" VARCHAR(50),
  "website" VARCHAR(255),
  "email" VARCHAR(255),
  "taxOffice" VARCHAR(150),
  "taxNumber" VARCHAR(20),
  "defaultVatRate" INTEGER NOT NULL DEFAULT 20,
  "invoicePrefix" VARCHAR(3) NOT NULL DEFAULT 'GIB',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_profiles_pkey" PRIMARY KEY ("id")
);
