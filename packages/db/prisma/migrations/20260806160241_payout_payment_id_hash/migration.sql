-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "paymentIdHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payout_paymentIdHash_key" ON "Payout"("paymentIdHash");

