DO $$
BEGIN
  CREATE TYPE "attribute_rule_match_type" AS ENUM (
    'ALWAYS',
    'TITLE_CONTAINS',
    'BRAND_EQUALS',
    'XML_ATTRIBUTE_EQUALS'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "attribute_rules" (
  "id" UUID NOT NULL,
  "marketplace" "marketplace" NOT NULL,
  "sourceId" UUID,
  "sourceCategory" TEXT,
  "marketplaceCategoryId" VARCHAR(100),
  "name" VARCHAR(200) NOT NULL,
  "attributeId" VARCHAR(100) NOT NULL,
  "attributeName" VARCHAR(200),
  "valueId" VARCHAR(100),
  "valueText" TEXT,
  "matchType" "attribute_rule_match_type" NOT NULL DEFAULT 'ALWAYS',
  "matchField" VARCHAR(200),
  "matchValue" TEXT,
  "confidence" DECIMAL(4, 3) NOT NULL DEFAULT 1,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" VARCHAR(100),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "attribute_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attribute_rules_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "xml_sources"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "attribute_rules_marketplace_sourceId_sourceCategory_idx"
  ON "attribute_rules"("marketplace", "sourceId", "sourceCategory");

CREATE INDEX IF NOT EXISTS "attribute_rules_marketplace_marketplaceCategoryId_isActive_idx"
  ON "attribute_rules"("marketplace", "marketplaceCategoryId", "isActive");

CREATE INDEX IF NOT EXISTS "attribute_rules_attributeId_isActive_idx"
  ON "attribute_rules"("attributeId", "isActive");
