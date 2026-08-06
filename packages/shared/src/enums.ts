// Spec §9.1 — organization-scoped roles
export const ORG_ROLES = ["OWNER", "MANAGER", "PAYROLL_ADMIN", "VIEWER"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

// Spec §7.1 — tip inflow types
export const TIP_TYPES = [
  "CASH_TIP",
  "CARD_TIP",
  "QR_TIP",
  "AUTOMATIC_GRATUITY",
  "SERVICE_CHARGE",
] as const;
export type TipType = (typeof TIP_TYPES)[number];

// Spec §7.1 — worker payout routes
export const PAYOUT_RAILS = [
  "CASH_RETAINED",
  "CASH_DRAWER",
  "PAYROLL",
  "PAYOUT_PROVIDER",
  "BANK_REFERENCE",
  "USDC",
] as const;
export type PayoutRail = (typeof PAYOUT_RAILS)[number];

// Spec §9.10 / §25 — allocation batch state machine
export const ALLOCATION_BATCH_STATUSES = [
  "DRAFT",
  "CALCULATED",
  "REVIEW_REQUIRED",
  "APPROVED",
  "PAYABLE",
  "PARTIALLY_PAID",
  "PAID",
  "CORRECTED",
  "REVERSED",
  "DISPUTED",
] as const;
export type AllocationBatchStatus = (typeof ALLOCATION_BATCH_STATUSES)[number];

// Spec §9.12 / §25 — payout state machine
export const PAYOUT_STATUSES = [
  "CREATED",
  "INITIATED",
  "SUBMITTED",
  "CONFIRMED",
  "FINALIZED",
  "FAILED",
  "REVERSED",
  "CORRECTED",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

// Spec §25 — report state machine
export const REPORT_STATUSES = ["DRAFT", "ISSUED", "EXPIRED", "CORRECTED", "REVOKED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

// Spec §18 — evidence grades
export const EVIDENCE_GRADES = ["A", "B", "C", "D", "E"] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

// Spec §17.2 — discrepancy alert types
export const DISCREPANCY_TYPES = [
  "ALLOCATION_GAP",
  "PAYOUT_GAP",
  "PAYROLL_GAP",
  "WITHHOLDING_UNKNOWN",
  "REFUND_ADJUSTMENT_REQUIRED",
  "DUPLICATE_EVIDENCE",
  "UNMAPPED_WORKER",
  "STALE_PROVIDER_DATA",
] as const;
export type DiscrepancyType = (typeof DISCREPANCY_TYPES)[number];

// Spec §8 — adapter registry keys
export const EVIDENCE_PROVIDERS = ["square_sandbox", "csv", "toast_mock"] as const;
export type EvidenceProviderKey = (typeof EVIDENCE_PROVIDERS)[number];

export const SETTLEMENT_RAILS = ["SOLANA_USDC", "LEGACY_REFERENCE"] as const;
export type SettlementRail = (typeof SETTLEMENT_RAILS)[number];
