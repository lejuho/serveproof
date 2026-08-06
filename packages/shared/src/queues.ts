// Spec §29.5 — BullMQ queue names shared by API (producers) and Worker (consumers).
export const QUEUES = {
  providerSync: "provider-sync",
  csvImport: "csv-import",
  allocationCalculate: "allocation-calculate",
  solanaConfirmation: "solana-confirmation",
  payoutReconcile: "payout-reconcile",
  payrollImport: "payroll-import",
  reportGenerate: "report-generate",
  disclosureExpire: "disclosure-expire",
  auditCleanup: "audit-cleanup",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
