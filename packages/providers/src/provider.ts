export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface ProviderTipEvidence {
  provider: string;
  externalPaymentId: string;
  externalOrderId?: string;
  tipType: "CASH_TIP" | "CARD_TIP";
  grossAmountUsdCents: number;
  paymentStatus: "COMPLETED" | "PENDING" | "CANCELED";
  refundStatus: "NONE" | "PARTIAL" | "FULL";
  businessDate: string;
  sourceHash: string;
}

export interface ProviderShiftEvidence {
  provider: string;
  externalShiftId: string;
  externalWorkerId: string;
  role: string;
  clockIn: Date;
  clockOut: Date | null;
  workedMinutes: number;
  shiftStatus: "IN_PROGRESS" | "COMPLETED" | "VOIDED";
  businessDate: string;
  sourceHash: string;
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  latencyMs: number;
  error?: string;
}

export interface EvidenceProvider {
  readonly provider: string;
  fetchTipEvidence(locationId: string, period: DateRange): Promise<ProviderTipEvidence[]>;
  fetchShiftEvidence(locationId: string, period: DateRange): Promise<ProviderShiftEvidence[]>;
  healthCheck(): Promise<ProviderHealth>;
}
