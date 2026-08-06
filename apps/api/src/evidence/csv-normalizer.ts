import { createHash } from "node:crypto";
import {
  businessDateInTimezone,
  csvEvidenceRowSchema,
  parseUsdToCents,
  type CsvEvidenceRow,
} from "@serveproof/shared";

export interface NormalizedTipEvidence {
  provider: string;
  externalPaymentId: string;
  tipType: CsvEvidenceRow["tip_type"];
  grossAmountUsdCents: number;
  businessDate: string;
  sourceHash: string;
}

export interface NormalizedShiftEvidence {
  provider: string;
  externalShiftId: string;
  externalWorkerId: string;
  role: string;
  clockIn: Date;
  clockOut: Date;
  workedMinutes: number;
  businessDate: string;
  sourceHash: string;
}

export interface CsvNormalizationResult {
  tips: NormalizedTipEvidence[];
  shifts: NormalizedShiftEvidence[];
  errors: { line: number; message: string }[];
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Minimal CSV split supporting double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Spec §7.3 — normalize the common CSV fallback into tip/shift evidence.
 * The CSV has no external payment id, so tips are keyed by shift row:
 * externalPaymentId = `csv:<shift_external_id>` (stable across re-imports).
 */
export function normalizeCsv(csvText: string, venueTimezone: string): CsvNormalizationResult {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const result: CsvNormalizationResult = { tips: [], shifts: [], errors: [] };
  if (lines.length < 2) {
    result.errors.push({ line: 0, message: "CSV has no data rows" });
    return result;
  }

  const headers = splitCsvLine(lines[0]!);

  for (let lineNo = 1; lineNo < lines.length; lineNo++) {
    const values = splitCsvLine(lines[lineNo]!);
    const rowObject = Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
    const parsed = csvEvidenceRowSchema.safeParse(rowObject);
    if (!parsed.success) {
      result.errors.push({
        line: lineNo + 1,
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    const row = parsed.data;
    const clockIn = new Date(row.clock_in);
    const clockOut = new Date(row.clock_out);
    const workedMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60_000);
    const businessDate = businessDateInTimezone(clockIn, venueTimezone);
    const rowHash = sha256(JSON.stringify(row));

    result.shifts.push({
      provider: row.provider,
      externalShiftId: row.shift_external_id,
      externalWorkerId: row.worker_external_id,
      role: row.role,
      clockIn,
      clockOut,
      workedMinutes,
      businessDate,
      sourceHash: rowHash,
    });

    const grossCents = parseUsdToCents(row.gross_tip);
    if (grossCents > 0) {
      result.tips.push({
        provider: row.provider,
        externalPaymentId: `csv:${row.shift_external_id}`,
        tipType: row.tip_type,
        grossAmountUsdCents: grossCents,
        businessDate,
        sourceHash: rowHash,
      });
    }
  }

  return result;
}
