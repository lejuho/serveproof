-- Held allocations: shares computed for not-yet-connected external workers.
-- workerId becomes nullable; provider + externalWorkerId identify the future
-- owner until the mapping is confirmed.
ALTER TABLE "WorkerAllocation" ALTER COLUMN "workerId" DROP NOT NULL;
ALTER TABLE "WorkerAllocation" ADD COLUMN "provider" TEXT;
ALTER TABLE "WorkerAllocation" ADD COLUMN "externalWorkerId" TEXT;

CREATE UNIQUE INDEX "WorkerAllocation_batchId_provider_externalWorkerId_key"
  ON "WorkerAllocation"("batchId", "provider", "externalWorkerId");
CREATE INDEX "WorkerAllocation_provider_externalWorkerId_idx"
  ON "WorkerAllocation"("provider", "externalWorkerId");
