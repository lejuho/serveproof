-- Additive indexes for worker overview and history reads. Existing indexes
-- stay in place to keep this deploy reversible and low-risk.

CREATE INDEX "IncomeEntry_workerId_effectiveStatus_createdAt_id_idx"
  ON "IncomeEntry"("workerId", "effectiveStatus", "createdAt", "id");

CREATE INDEX "IncomeEntry_workerId_venueId_effectiveStatus_updatedAt_idx"
  ON "IncomeEntry"("workerId", "venueId", "effectiveStatus", "updatedAt");

CREATE INDEX "DiscrepancyAlert_workerId_resolvedAt_createdAt_idx"
  ON "DiscrepancyAlert"("workerId", "resolvedAt", "createdAt");

CREATE INDEX "Payout_workerId_venueId_createdAt_idx"
  ON "Payout"("workerId", "venueId", "createdAt");

CREATE INDEX "DisclosureGrant_workerId_createdAt_idx"
  ON "DisclosureGrant"("workerId", "createdAt");
