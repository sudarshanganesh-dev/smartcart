-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "historicalFitAddressableAtProposal" INTEGER,
ADD COLUMN     "historicalFitComputedAt" TIMESTAMP(3),
ADD COLUMN     "historicalFitObservedValueAtProposal" DECIMAL(10,2),
ADD COLUMN     "historicalFitTotalAtProposal" INTEGER;

-- CreateIndex
CREATE INDEX "DemandEvent_merchantId_reason_category_idx" ON "DemandEvent"("merchantId", "reason", "category");
