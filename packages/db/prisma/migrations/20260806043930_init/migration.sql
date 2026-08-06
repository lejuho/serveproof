-- CreateEnum
CREATE TYPE "GlobalRole" AS ENUM ('WORKER', 'VENUE_OWNER', 'VENUE_MANAGER', 'PAYROLL_ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'MANAGER', 'PAYROLL_ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "VenueStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "WorkerVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('EXTERNAL', 'EMBEDDED');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "TipType" AS ENUM ('CASH_TIP', 'CARD_TIP', 'QR_TIP', 'AUTOMATIC_GRATUITY', 'SERVICE_CHARGE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('COMPLETED', 'PENDING', 'CANCELED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('NONE', 'PARTIAL', 'FULL');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'APPROVED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AllocationType" AS ENUM ('HOURS_WEIGHTED', 'ROLE_WEIGHTED_HOURS', 'EQUAL_SPLIT');

-- CreateEnum
CREATE TYPE "AllocationBatchStatus" AS ENUM ('DRAFT', 'CALCULATED', 'REVIEW_REQUIRED', 'APPROVED', 'PAYABLE', 'PARTIALLY_PAID', 'PAID', 'CORRECTED', 'REVERSED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "WorkerPayoutRail" AS ENUM ('CASH_RETAINED', 'CASH_DRAWER', 'PAYROLL', 'PAYOUT_PROVIDER', 'BANK_REFERENCE', 'USDC');

-- CreateEnum
CREATE TYPE "WorkerAllocationPayoutStatus" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('CREATED', 'INITIATED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'REVERSED', 'CORRECTED');

-- CreateEnum
CREATE TYPE "PayrollRecordStatus" AS ENUM ('PENDING', 'PROVIDER_CONFIRMED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "WithholdingStatus" AS ENUM ('UNKNOWN', 'PENDING', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "EvidenceGrade" AS ENUM ('A', 'B', 'C', 'D', 'E');

-- CreateEnum
CREATE TYPE "IncomeEntryEffectiveStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('ALLOCATION_GAP', 'PAYOUT_GAP', 'PAYROLL_GAP', 'WITHHOLDING_UNKNOWN', 'REFUND_ADJUSTMENT_REQUIRED', 'DUPLICATE_EVIDENCE', 'UNMAPPED_WORKER', 'STALE_PROVIDER_DATA');

-- CreateEnum
CREATE TYPE "DisclosureLevel" AS ENUM ('LEVEL_1', 'LEVEL_2', 'LEVEL_3');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'ISSUED', 'EXPIRED', 'CORRECTED', 'REVOKED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "authUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "GlobalRole" NOT NULL DEFAULT 'WORKER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "country" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "VenueStatus" NOT NULL DEFAULT 'ACTIVE',
    "externalIds" JSONB NOT NULL DEFAULT '{}',
    "solanaVenuePda" TEXT,
    "vaultTokenAccount" TEXT,
    "payoutSignerWallet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultWalletId" TEXT,
    "verificationStatus" "WorkerVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalWorkerAccount" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalWorkerId" TEXT NOT NULL,
    "mappingStatus" "MappingStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalWorkerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerWallet" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "address" TEXT NOT NULL,
    "walletType" "WalletType" NOT NULL DEFAULT 'EXTERNAL',
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TipEvidence" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "externalPaymentId" TEXT NOT NULL,
    "externalOrderId" TEXT,
    "tipType" "TipType" NOT NULL,
    "grossAmountUsdCents" INTEGER NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'COMPLETED',
    "refundStatus" "RefundStatus" NOT NULL DEFAULT 'NONE',
    "businessDate" TEXT NOT NULL,
    "sourcePayloadUri" TEXT,
    "sourceHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftEvidence" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "externalShiftId" TEXT NOT NULL,
    "externalWorkerId" TEXT NOT NULL,
    "mappedWorkerId" TEXT,
    "role" TEXT NOT NULL,
    "clockIn" TIMESTAMP(3) NOT NULL,
    "clockOut" TIMESTAMP(3),
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "shiftStatus" "ShiftStatus" NOT NULL DEFAULT 'COMPLETED',
    "businessDate" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationPolicy" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "allocationType" "AllocationType" NOT NULL DEFAULT 'ROLE_WEIGHTED_HOURS',
    "roleWeights" JSONB NOT NULL DEFAULT '{}',
    "tipOutRules" JSONB NOT NULL DEFAULT '[]',
    "poolInclusion" JSONB NOT NULL DEFAULT '{}',
    "excludedRoles" JSONB NOT NULL DEFAULT '[]',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationBatch" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "tipPoolAmountUsdCents" INTEGER NOT NULL DEFAULT 0,
    "policyId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "status" "AllocationBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "evidenceHash" TEXT,
    "allocationHash" TEXT,
    "reviewIssues" JSONB NOT NULL DEFAULT '[]',
    "calculatedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerAllocation" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "grossTipUsdCents" INTEGER NOT NULL DEFAULT 0,
    "pooledTipUsdCents" INTEGER NOT NULL DEFAULT 0,
    "tipOutGivenUsdCents" INTEGER NOT NULL DEFAULT 0,
    "tipOutReceivedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "netAllocatedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "payoutRail" "WorkerPayoutRail",
    "payoutStatus" "WorkerAllocationPayoutStatus" NOT NULL DEFAULT 'UNPAID',

    CONSTRAINT "WorkerAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "walletId" TEXT,
    "rail" "WorkerPayoutRail" NOT NULL,
    "asset" TEXT NOT NULL,
    "amountBaseUnits" BIGINT NOT NULL DEFAULT 0,
    "amountUsdCents" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'CREATED',
    "externalReference" TEXT,
    "txSignature" TEXT,
    "settlementPda" TEXT,
    "slot" BIGINT,
    "blockTime" TIMESTAMP(3),
    "initiatedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRecord" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "reportedTipUsdCents" INTEGER NOT NULL DEFAULT 0,
    "federalWithholdingUsdCents" INTEGER,
    "stateWithholdingUsdCents" INTEGER,
    "socialSecurityUsdCents" INTEGER,
    "medicareUsdCents" INTEGER,
    "status" "PayrollRecordStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomeEntry" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "shiftId" TEXT,
    "payoutId" TEXT,
    "earnedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "allocatedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "paidUsdCents" INTEGER NOT NULL DEFAULT 0,
    "payrollReportedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "withholdingStatus" "WithholdingStatus" NOT NULL DEFAULT 'UNKNOWN',
    "payoutRail" "WorkerPayoutRail",
    "evidenceGrade" "EvidenceGrade" NOT NULL DEFAULT 'E',
    "effectiveStatus" "IncomeEntryEffectiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "originalEntryId" TEXT,
    "correctionOfId" TEXT,
    "correctionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscrepancyAlert" (
    "id" TEXT NOT NULL,
    "workerId" TEXT,
    "venueId" TEXT NOT NULL,
    "shiftId" TEXT,
    "type" "DiscrepancyType" NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscrepancyAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisclosureGrant" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "purpose" TEXT NOT NULL,
    "level" "DisclosureLevel" NOT NULL DEFAULT 'LEVEL_2',
    "fieldScope" JSONB NOT NULL DEFAULT '[]',
    "venueScope" JSONB NOT NULL DEFAULT '[]',
    "dateRangeStart" TIMESTAMP(3) NOT NULL,
    "dateRangeEnd" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "allowDownload" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "accessTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisclosureGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisclosureAccessLog" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisclosureAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationReport" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "disclosureGrantId" TEXT NOT NULL,
    "reportHash" TEXT NOT NULL,
    "reportUri" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "previousReportId" TEXT,
    "onchainRecordReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "venueId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authUserId_key" ON "User"("authUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Venue_organizationId_idx" ON "Venue"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_userId_key" ON "Worker"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_defaultWalletId_key" ON "Worker"("defaultWalletId");

-- CreateIndex
CREATE INDEX "ExternalWorkerAccount_workerId_idx" ON "ExternalWorkerAccount"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalWorkerAccount_venueId_provider_externalWorkerId_key" ON "ExternalWorkerAccount"("venueId", "provider", "externalWorkerId");

-- CreateIndex
CREATE INDEX "WorkerWallet_workerId_idx" ON "WorkerWallet"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerWallet_workerId_chain_address_key" ON "WorkerWallet"("workerId", "chain", "address");

-- CreateIndex
CREATE INDEX "TipEvidence_venueId_businessDate_idx" ON "TipEvidence"("venueId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "TipEvidence_venueId_provider_externalPaymentId_tipType_key" ON "TipEvidence"("venueId", "provider", "externalPaymentId", "tipType");

-- CreateIndex
CREATE INDEX "ShiftEvidence_venueId_businessDate_idx" ON "ShiftEvidence"("venueId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftEvidence_mappedWorkerId_idx" ON "ShiftEvidence"("mappedWorkerId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftEvidence_venueId_provider_externalShiftId_key" ON "ShiftEvidence"("venueId", "provider", "externalShiftId");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationPolicy_venueId_version_key" ON "AllocationPolicy"("venueId", "version");

-- CreateIndex
CREATE INDEX "AllocationBatch_venueId_status_idx" ON "AllocationBatch"("venueId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationBatch_venueId_businessDate_policyVersion_key" ON "AllocationBatch"("venueId", "businessDate", "policyVersion");

-- CreateIndex
CREATE INDEX "WorkerAllocation_workerId_idx" ON "WorkerAllocation"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerAllocation_batchId_workerId_key" ON "WorkerAllocation"("batchId", "workerId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_paymentId_key" ON "Payout"("paymentId");

-- CreateIndex
CREATE INDEX "Payout_venueId_status_idx" ON "Payout"("venueId", "status");

-- CreateIndex
CREATE INDEX "Payout_workerId_idx" ON "Payout"("workerId");

-- CreateIndex
CREATE INDEX "PayrollRecord_workerId_periodStart_idx" ON "PayrollRecord"("workerId", "periodStart");

-- CreateIndex
CREATE INDEX "PayrollRecord_venueId_idx" ON "PayrollRecord"("venueId");

-- CreateIndex
CREATE INDEX "IncomeEntry_workerId_createdAt_idx" ON "IncomeEntry"("workerId", "createdAt");

-- CreateIndex
CREATE INDEX "IncomeEntry_venueId_idx" ON "IncomeEntry"("venueId");

-- CreateIndex
CREATE INDEX "DiscrepancyAlert_workerId_idx" ON "DiscrepancyAlert"("workerId");

-- CreateIndex
CREATE INDEX "DiscrepancyAlert_venueId_type_idx" ON "DiscrepancyAlert"("venueId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "DisclosureGrant_accessTokenHash_key" ON "DisclosureGrant"("accessTokenHash");

-- CreateIndex
CREATE INDEX "DisclosureGrant_workerId_idx" ON "DisclosureGrant"("workerId");

-- CreateIndex
CREATE INDEX "DisclosureAccessLog_grantId_accessedAt_idx" ON "DisclosureAccessLog"("grantId", "accessedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationReport_previousReportId_key" ON "VerificationReport"("previousReportId");

-- CreateIndex
CREATE INDEX "VerificationReport_workerId_idx" ON "VerificationReport"("workerId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_defaultWalletId_fkey" FOREIGN KEY ("defaultWalletId") REFERENCES "WorkerWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalWorkerAccount" ADD CONSTRAINT "ExternalWorkerAccount_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalWorkerAccount" ADD CONSTRAINT "ExternalWorkerAccount_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerWallet" ADD CONSTRAINT "WorkerWallet_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TipEvidence" ADD CONSTRAINT "TipEvidence_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftEvidence" ADD CONSTRAINT "ShiftEvidence_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationPolicy" ADD CONSTRAINT "AllocationPolicy_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationBatch" ADD CONSTRAINT "AllocationBatch_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationBatch" ADD CONSTRAINT "AllocationBatch_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AllocationPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerAllocation" ADD CONSTRAINT "WorkerAllocation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "AllocationBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerAllocation" ADD CONSTRAINT "WorkerAllocation_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "WorkerAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WorkerWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "ShiftEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_correctionOfId_fkey" FOREIGN KEY ("correctionOfId") REFERENCES "IncomeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisclosureGrant" ADD CONSTRAINT "DisclosureGrant_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisclosureAccessLog" ADD CONSTRAINT "DisclosureAccessLog_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "DisclosureGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationReport" ADD CONSTRAINT "VerificationReport_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationReport" ADD CONSTRAINT "VerificationReport_disclosureGrantId_fkey" FOREIGN KEY ("disclosureGrantId") REFERENCES "DisclosureGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationReport" ADD CONSTRAINT "VerificationReport_previousReportId_fkey" FOREIGN KEY ("previousReportId") REFERENCES "VerificationReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
