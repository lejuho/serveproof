import { z } from "zod";
import { PAYOUT_RAILS, TIP_TYPES } from "./enums.js";

/**
 * Spec §7.3 — common CSV fallback row for all external providers.
 *
 * provider,venue_external_id,worker_external_id,shift_external_id,tip_type,
 * gross_tip,clock_in,clock_out,role,payout_route,payroll_status
 */
export const csvEvidenceRowSchema = z.object({
  provider: z.string().min(1),
  venue_external_id: z.string().min(1),
  worker_external_id: z.string().min(1),
  shift_external_id: z.string().min(1),
  tip_type: z.enum(TIP_TYPES),
  gross_tip: z.string().regex(/^\d+(\.\d{1,2})?$/, "gross_tip must be a non-negative USD amount"),
  clock_in: z.iso.datetime(),
  clock_out: z.iso.datetime(),
  role: z.string().min(1),
  payout_route: z.enum(PAYOUT_RAILS),
  payroll_status: z.string().min(1),
});

export type CsvEvidenceRow = z.infer<typeof csvEvidenceRowSchema>;

export const CSV_EVIDENCE_HEADERS = Object.keys(
  csvEvidenceRowSchema.shape,
) as (keyof CsvEvidenceRow)[];
