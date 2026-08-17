CREATE TYPE "OpenShiftStatus" AS ENUM ('DRAFT', 'OPEN', 'FILLED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "ShiftAssignmentStatus" AS ENUM ('INVITED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'CLOCKED_IN', 'CLOCKED_OUT', 'APPROVED', 'NO_SHOW');
ALTER TYPE "EvidenceIngestSource" ADD VALUE 'PLATFORM_ATTESTED';

CREATE TABLE "OpenShift" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "description" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "hourlyRateUsdCents" INTEGER NOT NULL,
  "expectedTipUsdCents" INTEGER NOT NULL DEFAULT 0,
  "headcount" INTEGER NOT NULL DEFAULT 1,
  "status" "OpenShiftStatus" NOT NULL DEFAULT 'DRAFT',
  "createdByUserId" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OpenShift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShiftAssignment" (
  "id" TEXT NOT NULL,
  "openShiftId" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "status" "ShiftAssignmentStatus" NOT NULL DEFAULT 'INVITED',
  "invitedByUserId" TEXT,
  "respondedAt" TIMESTAMP(3),
  "checkInAt" TIMESTAMP(3),
  "checkOutAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "approvedByUserId" TEXT,
  "shiftEvidenceId" TEXT,
  "cancellationReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OpenShift_venueId_startsAt_idx" ON "OpenShift"("venueId", "startsAt");
CREATE INDEX "OpenShift_venueId_status_idx" ON "OpenShift"("venueId", "status");
CREATE UNIQUE INDEX "ShiftAssignment_shiftEvidenceId_key" ON "ShiftAssignment"("shiftEvidenceId");
CREATE UNIQUE INDEX "ShiftAssignment_openShiftId_workerId_key" ON "ShiftAssignment"("openShiftId", "workerId");
CREATE INDEX "ShiftAssignment_workerId_status_idx" ON "ShiftAssignment"("workerId", "status");
CREATE INDEX "ShiftAssignment_openShiftId_status_idx" ON "ShiftAssignment"("openShiftId", "status");

ALTER TABLE "OpenShift" ADD CONSTRAINT "OpenShift_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_openShiftId_fkey" FOREIGN KEY ("openShiftId") REFERENCES "OpenShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_shiftEvidenceId_fkey" FOREIGN KEY ("shiftEvidenceId") REFERENCES "ShiftEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
