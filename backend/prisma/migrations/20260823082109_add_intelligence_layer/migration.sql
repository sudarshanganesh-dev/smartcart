-- CreateEnum
CREATE TYPE "DemandFailureReason" AS ENUM ('NO_MATCH', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK', 'NO_MORE_OPTIONS');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "ProductSourceType" ADD VALUE 'AI_OPPORTUNITY';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "originOpportunityId" TEXT;

-- CreateTable
CREATE TABLE "DemandEvent" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" "DemandFailureReason" NOT NULL,
    "groupKey" TEXT NOT NULL,
    "queryText" VARCHAR(200),
    "category" TEXT,
    "minPrice" DECIMAL(10,2),
    "maxPrice" DECIMAL(10,2),
    "requestedQuantity" INTEGER,
    "productId" TEXT,
    "availableQuantity" INTEGER,
    "estimatedValue" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "reason" "DemandFailureReason" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "dismissedAt" TIMESTAMP(3),
    "actionedAt" TIMESTAMP(3),
    "generatedProductId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemandEvent_merchantId_groupKey_createdAt_idx" ON "DemandEvent"("merchantId", "groupKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DemandEvent_conversationId_groupKey_key" ON "DemandEvent"("conversationId", "groupKey");

-- CreateIndex
CREATE INDEX "Opportunity_merchantId_status_idx" ON "Opportunity"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_merchantId_groupKey_key" ON "Opportunity"("merchantId", "groupKey");

-- AddForeignKey
ALTER TABLE "DemandEvent" ADD CONSTRAINT "DemandEvent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
