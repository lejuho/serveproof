-- Preserve source settlement intent separately from the rail used by a
-- completed payout. This lets close views remain accurate before settlement.
ALTER TABLE "TipEvidence"
  ADD COLUMN "sourcePayoutRail" "WorkerPayoutRail",
  ADD COLUMN "sourcePayrollStatus" TEXT;

ALTER TABLE "ShiftEvidence"
  ADD COLUMN "sourcePayoutRail" "WorkerPayoutRail",
  ADD COLUMN "sourcePayrollStatus" TEXT;

ALTER TABLE "WorkerAllocation"
  ADD COLUMN "plannedPayoutRail" "WorkerPayoutRail";
