-- DropIndex
DROP INDEX "Order_merchantId_idx";

-- CreateIndex
CREATE INDEX "Order_merchantId_createdAt_idx" ON "Order"("merchantId", "createdAt");
