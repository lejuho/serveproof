-- Preserve the actors and signer identity shown in venue/worker connection views.
ALTER TABLE "AllocationBatch" ADD COLUMN "calculatedBy" TEXT;

ALTER TABLE "Payout"
ADD COLUMN "initiatedByUserId" TEXT,
ADD COLUMN "submittedByUserId" TEXT,
ADD COLUMN "signerWallet" TEXT;

ALTER TABLE "IncomeEntry" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
