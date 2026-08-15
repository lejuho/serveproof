import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import PDFDocument from "pdfkit";
import * as QRCode from "qrcode";
import { PrismaService } from "../prisma/prisma.service";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

// Local stand-in for the private object storage bucket (spec §29.8) —
// swapped for S3-compatible storage + signed URLs in staging.
const REPORTS_DIR = join(process.cwd(), "var", "reports");
mkdirSync(REPORTS_DIR, { recursive: true });

export type DisclosureLevel = "LEVEL_1" | "LEVEL_2" | "LEVEL_3";

@Injectable()
export class DisclosureService {
  constructor(private readonly prisma: PrismaService) {}

  private async workerOf(userId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { userId },
      include: { user: { select: { displayName: true } } },
    });
    if (!worker) throw new NotFoundException("No worker profile for this user");
    return worker;
  }

  // ── 4.1 Grants (spec §20) ──────────────────────────────────────

  /** Raw token is returned exactly once; only its hash is stored (§29.8). */
  async createGrant(
    userId: string,
    input: {
      purpose: string;
      level: DisclosureLevel;
      dateRangeStart: string;
      dateRangeEnd: string;
      expiresAt: string;
      recipientEmail?: string;
      allowDownload?: boolean;
      thresholdUsdCents?: number; // LEVEL_1 criterion
    },
  ) {
    const worker = await this.workerOf(userId);
    if (input.level === "LEVEL_1" && !input.thresholdUsdCents) {
      throw new BadRequestException("LEVEL_1 requires thresholdUsdCents");
    }
    const rawToken = randomBytes(24).toString("base64url");
    const grant = await this.prisma.disclosureGrant.create({
      data: {
        workerId: worker.id,
        purpose: input.purpose,
        level: input.level,
        fieldScope: input.thresholdUsdCents ? { thresholdUsdCents: input.thresholdUsdCents } : {},
        venueScope: [],
        dateRangeStart: new Date(input.dateRangeStart),
        dateRangeEnd: new Date(input.dateRangeEnd),
        expiresAt: new Date(input.expiresAt),
        allowDownload: input.allowDownload ?? false,
        recipientEmail: input.recipientEmail?.toLowerCase() ?? null,
        accessTokenHash: sha256Hex(rawToken),
      },
    });
    return { grant, rawToken };
  }

  async listGrants(userId: string) {
    const worker = await this.workerOf(userId);
    return this.prisma.disclosureGrant.findMany({
      where: { workerId: worker.id },
      include: { reports: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Spec §20.1 — worker can revoke at any time; issued reports go REVOKED. */
  async revokeGrant(userId: string, grantId: string) {
    const worker = await this.workerOf(userId);
    const grant = await this.prisma.disclosureGrant.findUnique({ where: { id: grantId } });
    if (!grant || grant.workerId !== worker.id) {
      throw new NotFoundException("Disclosure grant not found");
    }
    await this.prisma.$transaction([
      this.prisma.disclosureGrant.update({
        where: { id: grantId },
        data: { revokedAt: new Date() },
      }),
      this.prisma.verificationReport.updateMany({
        where: { disclosureGrantId: grantId, status: { in: ["ISSUED", "CORRECTED"] } },
        data: { status: "REVOKED", revokedAt: new Date() },
      }),
    ]);
    return { revoked: true };
  }

  // ── 4.2 Report generation (spec §21) ───────────────────────────

  private async buildSnapshot(grant: {
    workerId: string;
    level: string;
    fieldScope: unknown;
    dateRangeStart: Date;
    dateRangeEnd: Date;
  }) {
    const entries = await this.prisma.incomeEntry.findMany({
      where: { workerId: grant.workerId, effectiveStatus: "ACTIVE" },
      include: {
        shift: { select: { businessDate: true, role: true, ingestSource: true } },
        venue: { select: { name: true } },
      },
    });
    const inRange = entries.filter((e) => {
      const d = e.shift?.businessDate;
      if (!d) return false;
      const date = new Date(`${d}T12:00:00Z`);
      return date >= grant.dateRangeStart && date <= grant.dateRangeEnd;
    });

    const totalAllocated = inRange.reduce((s, e) => s + e.allocatedUsdCents, 0);
    const totalPaid = inRange.reduce((s, e) => s + e.paidUsdCents, 0);
    const months = new Set(inRange.map((e) => e.shift?.businessDate?.slice(0, 7)));
    const payers = new Set(inRange.map((e) => e.venueId));
    const avgMonthly = months.size > 0 ? Math.round(totalAllocated / months.size) : 0;
    const grades: Record<string, number> = {};
    for (const e of inRange) grades[e.evidenceGrade] = (grades[e.evidenceGrade] ?? 0) + 1;
    const bestGrade = ["A", "B", "C", "D", "E"].find((g) => grades[g]) ?? "E";
    const hasCorrections = inRange.some((e) => e.correctionOfId !== null);
    // No extrapolation (spec §21 — a proof states observations, not estimates):
    // the average divides by observed calendar months, so the verifier also
    // gets the per-month breakdown and the actual observed day count.
    const monthlyBreakdown: Record<string, number> = {};
    for (const e of inRange) {
      const month = e.shift?.businessDate?.slice(0, 7);
      if (!month) continue;
      monthlyBreakdown[month] = (monthlyBreakdown[month] ?? 0) + e.allocatedUsdCents;
    }
    const observedShiftDays = new Set(inRange.map((e) => e.shift?.businessDate).filter(Boolean))
      .size;
    // share of shifts whose evidence came straight from a POS/provider API,
    // i.e. not self-reported by the venue — a verifier-facing trust signal
    const posVerifiedSharePct =
      inRange.length > 0
        ? Math.round(
            (inRange.filter((e) => e.shift?.ingestSource === "PROVIDER_API").length /
              inRange.length) *
              100,
          )
        : 0;

    // LEVEL_1 — only the boolean criterion result (spec §20.2)
    if (grant.level === "LEVEL_1") {
      const threshold =
        (grant.fieldScope as { thresholdUsdCents?: number })?.thresholdUsdCents ?? 0;
      return {
        level: "LEVEL_1",
        criterion: `평균 월소득 ≥ $${(threshold / 100).toFixed(2)}`,
        result: avgMonthly >= threshold,
      };
    }

    const level2 = {
      level: grant.level,
      avgMonthlyIncomeUsdCents: avgMonthly,
      monthsCovered: months.size,
      payerCount: payers.size,
      verificationGrades: grades,
      bestGrade,
      hasCorrections,
      totalVerifiedIncomeUsdCents: totalAllocated,
      totalPaidUsdCents: totalPaid,
      posVerifiedSharePct,
      monthlyBreakdown,
      observedShiftDays,
    };
    if (grant.level === "LEVEL_2") return level2;

    // LEVEL_3 — per-venue / per-shift detail incl. payroll & withholding
    return {
      ...level2,
      entries: inRange.map((e) => ({
        businessDate: e.shift?.businessDate,
        venue: e.venue.name,
        role: e.shift?.role,
        allocatedUsdCents: e.allocatedUsdCents,
        paidUsdCents: e.paidUsdCents,
        payrollReportedUsdCents: e.payrollReportedUsdCents,
        withholdingStatus: e.withholdingStatus,
        payoutRail: e.payoutRail,
        evidenceGrade: e.evidenceGrade,
        ingestSource: e.shift?.ingestSource ?? null,
        corrected: e.correctionOfId !== null,
      })),
    };
  }

  async issueReport(userId: string, grantId: string, verifyBaseUrl: string) {
    const worker = await this.workerOf(userId);
    const grant = await this.prisma.disclosureGrant.findUnique({ where: { id: grantId } });
    if (!grant || grant.workerId !== worker.id) {
      throw new NotFoundException("Disclosure grant not found");
    }
    if (grant.revokedAt) throw new BadRequestException("Grant is revoked");
    if (grant.expiresAt < new Date()) throw new BadRequestException("Grant is expired");

    const snapshot = await this.buildSnapshot(grant);
    const issuedAt = new Date();

    // reportHash = HMAC(REPORT_SIGNING_KEY, canonical snapshot) — §21.2 hash match
    const signingKey = process.env.REPORT_SIGNING_KEY ?? "dev-report-signing-key";
    const reportHash = createHmac("sha256", signingKey)
      .update(JSON.stringify({ snapshot, grantId, issuedAt: issuedAt.toISOString() }))
      .digest("hex");

    // supersede previous report of this grant (report chain)
    const previous = await this.prisma.verificationReport.findFirst({
      where: { disclosureGrantId: grantId, status: { in: ["ISSUED", "CORRECTED"] } },
      orderBy: { createdAt: "desc" },
    });

    const report = await this.prisma.verificationReport.create({
      data: {
        workerId: worker.id,
        disclosureGrantId: grantId,
        reportHash,
        snapshot: JSON.parse(JSON.stringify(snapshot)),
        status: "ISSUED",
        issuedAt,
        expiresAt: grant.expiresAt,
        previousReportId: previous?.id ?? null,
      },
    });

    // PDF (spec §21.1) — stored outside any public path
    const pdfPath = join(REPORTS_DIR, `${report.id}.pdf`);
    await this.renderPdf(pdfPath, {
      workerName: worker.user.displayName,
      purpose: grant.purpose,
      period: `${grant.dateRangeStart.toISOString().slice(0, 10)} ~ ${grant.dateRangeEnd.toISOString().slice(0, 10)}`,
      snapshot,
      reportId: report.id,
      reportHash,
      issuedAt,
      expiresAt: grant.expiresAt,
      verifyUrl: verifyBaseUrl,
    });
    await this.prisma.verificationReport.update({
      where: { id: report.id },
      data: { reportUri: pdfPath },
    });

    return { report: { ...report, reportUri: undefined }, verifyUrl: verifyBaseUrl };
  }

  private async renderPdf(
    path: string,
    data: {
      workerName: string;
      purpose: string;
      period: string;
      snapshot: Record<string, unknown>;
      reportId: string;
      reportHash: string;
      issuedAt: Date;
      expiresAt: Date;
      verifyUrl: string;
    },
  ) {
    const qrPng = await QRCode.toBuffer(data.verifyUrl, { width: 140, margin: 1 });
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));

    doc.fontSize(20).text("ServeProof Income Verification Report");
    doc.moveDown(0.3);
    doc
      .fontSize(9)
      .fillColor("#b45309")
      .text("This report may reference Devnet test tokens with no monetary value.");
    doc.fillColor("black").moveDown();

    doc.fontSize(11);
    doc.text(`Worker: ${data.workerName}`);
    doc.text(`Purpose: ${data.purpose}`);
    doc.text(`Period: ${data.period}`);
    doc.text(`Issued: ${data.issuedAt.toISOString()}`);
    doc.text(`Expires: ${data.expiresAt.toISOString()}`);
    doc.moveDown();

    doc.fontSize(13).text("Disclosed fields", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10);
    const s = data.snapshot as Record<string, unknown>;
    if (s.level === "LEVEL_1") {
      doc.text(`${s.criterion}`);
      doc.fontSize(16).text(s.result ? "TRUE" : "FALSE");
    } else {
      const usd = (c: unknown) => `$${((c as number) / 100).toFixed(2)}`;
      doc.text(`Verified income (allocated): ${usd(s.totalVerifiedIncomeUsdCents)}`);
      doc.text(`Average monthly income: ${usd(s.avgMonthlyIncomeUsdCents)}`);
      doc.text(`Months covered: ${s.monthsCovered}  ·  Payer count: ${s.payerCount}`);
      doc.text(`Best evidence grade: ${s.bestGrade}`);
      doc.text(`Corrections present: ${s.hasCorrections ? "yes" : "no"}`);
      if (typeof s.posVerifiedSharePct === "number") {
        doc.text(`POS-verified evidence share: ${s.posVerifiedSharePct}%`);
      }
      if (typeof s.observedShiftDays === "number") {
        doc.text(`Observed shift days: ${s.observedShiftDays}`);
      }
      if (s.monthlyBreakdown && typeof s.monthlyBreakdown === "object") {
        doc.moveDown(0.3);
        doc.text("Monthly breakdown (observed, not extrapolated):");
        for (const [month, cents] of Object.entries(s.monthlyBreakdown as Record<string, number>)
          .sort()) {
          doc.text(`  ${month}: ${usd(cents)}`);
        }
      }
      if (Array.isArray(s.entries)) {
        doc.moveDown(0.5);
        doc.text("Shift detail:", { underline: true });
        for (const entry of s.entries as Record<string, unknown>[]) {
          doc.text(
            `${entry.businessDate} · ${entry.venue} · alloc ${usd(entry.allocatedUsdCents)} · paid ${usd(entry.paidUsdCents)} · payroll ${usd(entry.payrollReportedUsdCents)} · ${entry.withholdingStatus} · grade ${entry.evidenceGrade}`,
          );
        }
      }
    }

    doc.moveDown();
    doc.fontSize(8).fillColor("#555");
    doc.text(`Report ID: ${data.reportId}`);
    doc.text(`Report hash: ${data.reportHash}`);
    doc.text(`Issuer: ServeProof POC`);
    doc.text(`Verify: ${data.verifyUrl}`);
    doc.image(qrPng, doc.page.width - 48 - 140, doc.page.height - 48 - 140, { width: 140 });
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks);
    await writeFile(path, pdf);
  }

  /** Worker-only PDF access (public verifiers never receive the file, §29.8). */
  async getPdfPath(userId: string, reportId: string): Promise<string> {
    const worker = await this.workerOf(userId);
    const report = await this.prisma.verificationReport.findUnique({ where: { id: reportId } });
    if (!report || report.workerId !== worker.id) {
      throw new NotFoundException("Report not found");
    }
    if (report.status === "REVOKED") {
      throw new ForbiddenException("Report is revoked; PDF access is blocked");
    }
    if (!report.reportUri) throw new NotFoundException("PDF not generated");
    return report.reportUri;
  }

  // ── 4.3 Public verification (spec §21.2, §29.8) ────────────────

  async verifyByToken(rawToken: string, meta: { ip?: string; userAgent?: string }) {
    const grant = await this.prisma.disclosureGrant.findUnique({
      where: { accessTokenHash: sha256Hex(rawToken) },
      include: {
        worker: { include: { user: { select: { displayName: true } } } },
        reports: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!grant) throw new NotFoundException("Unknown verification token");

    await this.prisma.disclosureAccessLog.create({
      data: { grantId: grant.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    });

    const report = grant.reports[0] ?? null;
    let status: "VALID" | "EXPIRED" | "REVOKED" | "CORRECTED" | "NOT_ISSUED";
    if (grant.revokedAt || report?.status === "REVOKED") status = "REVOKED";
    else if (!report) status = "NOT_ISSUED";
    else if (grant.expiresAt < new Date() || report.status === "EXPIRED") status = "EXPIRED";
    else if (report.status === "CORRECTED") status = "CORRECTED";
    else status = "VALID";

    const base = {
      status,
      issuer: "ServeProof POC",
      purpose: grant.purpose,
      level: grant.level,
      workerDisplayName: grant.worker.user.displayName,
      issuedAt: report?.issuedAt ?? null,
      expiresAt: grant.expiresAt,
      reportId: report?.id ?? null,
      reportHash: report?.reportHash ?? null,
    };
    // Revoked links never render income data (§28: 철회된 링크 접근 차단)
    if (status === "REVOKED" || status === "NOT_ISSUED") return base;
    return { ...base, disclosed: report?.snapshot ?? null };
  }

  /** disclosure-expire sweep (worker job) + read-time backstop. */
  async expireOverdue() {
    const now = new Date();
    const reports = await this.prisma.verificationReport.updateMany({
      where: { status: "ISSUED", expiresAt: { lt: now } },
      data: { status: "EXPIRED" },
    });
    return { expiredReports: reports.count };
  }
}
