import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import IORedis from "ioredis";
import PDFDocument from "pdfkit";
import * as QRCode from "qrcode";
import { MailService } from "../auth/mail.service";
import { PrismaService } from "../prisma/prisma.service";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const REPORT_FONT_NAME = "NotoSansKR";
const REPORT_FONT_PATH =
  require.resolve("@fontsource/noto-sans-kr/files/noto-sans-kr-korean-400-normal.woff2");

// Local stand-in for the private object storage bucket (spec §29.8) —
// swapped for S3-compatible storage + signed URLs in staging.
const REPORTS_DIR = join(process.cwd(), "var", "reports");
mkdirSync(REPORTS_DIR, { recursive: true });

export type DisclosureLevel = "LEVEL_1" | "LEVEL_2" | "LEVEL_3";
export type DisclosureAccessMode = "LINK" | "RECIPIENT_OTP";

const ACCESS_OTP_TTL_SECONDS = 300;
const ACCESS_OTP_MAX_ATTEMPTS = 5;
const ACCESS_SESSION_TTL_SECONDS = 15 * 60;
const ACCESS_OTP_COOLDOWN_SECONDS = 60;
const ACCESS_OTP_MAX_REQUESTS_PER_HOUR = 5;

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, Math.min(2, local.length))}${"*".repeat(Math.max(3, local.length - 2))}@${domain}`;
}

function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const normalized = ip.replace(/^::ffff:/, "");
  if (normalized.includes(".")) {
    const parts = normalized.split(".");
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.*` : "***";
  }
  const parts = normalized.split(":").filter(Boolean);
  return parts.length ? `${parts.slice(0, 3).join(":")}:…` : "***";
}

@Injectable()
export class DisclosureService implements OnApplicationShutdown {
  private readonly logger = new Logger(DisclosureService.name);
  private readonly redis: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {
    this.redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
    });
    this.redis.on("error", (error) => {
      this.logger.warn(`disclosure redis error (status=${this.redis.status}): ${error.message}`);
    });
  }

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }

  private async accessStore<T>(operation: () => Promise<T>): Promise<T> {
    if (["end", "close"].includes(this.redis.status)) {
      await this.redis.connect().catch(() => undefined);
    }
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(`Disclosure access store unavailable: ${message}`);
    }
  }

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
      accessMode?: DisclosureAccessMode;
      allowDownload?: boolean;
      thresholdUsdCents?: number; // LEVEL_1 criterion
    },
  ) {
    const worker = await this.workerOf(userId);
    if (input.level === "LEVEL_1" && !input.thresholdUsdCents) {
      throw new BadRequestException("LEVEL_1 requires thresholdUsdCents");
    }
    const accessMode = input.accessMode ?? "LINK";
    if (accessMode === "RECIPIENT_OTP" && !input.recipientEmail) {
      throw new BadRequestException("Recipient email is required for recipient-only access");
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
        accessMode,
        accessTokenHash: sha256Hex(rawToken),
      },
    });
    return { grant, rawToken };
  }

  async listGrants(userId: string) {
    const worker = await this.workerOf(userId);
    return this.prisma.disclosureGrant
      .findMany({
        where: { workerId: worker.id },
        select: {
          id: true,
          purpose: true,
          level: true,
          accessMode: true,
          recipientEmail: true,
          dateRangeStart: true,
          dateRangeEnd: true,
          expiresAt: true,
          allowDownload: true,
          revokedAt: true,
          createdAt: true,
          reports: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, status: true, issuedAt: true, expiresAt: true },
          },
          accesses: {
            orderBy: { accessedAt: "desc" },
            take: 5,
            select: { id: true, ip: true, userAgent: true, accessedAt: true },
          },
        },
        orderBy: { createdAt: "desc" },
      })
      .then((grants) =>
        grants.map((grant) => ({
          ...grant,
          accesses: grant.accesses.map(({ ip, ...access }) => ({
            ...access,
            ipMasked: maskIp(ip),
          })),
        })),
      );
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

    // PDFKit's built-in Helvetica font only supports WinAnsi. Dynamic fields
    // such as a Korean disclosure purpose are otherwise encoded as mojibake.
    // Resolve the bundled font through Node so this also works from dist/ in
    // the Railway image instead of depending on host-installed system fonts.
    doc.registerFont(REPORT_FONT_NAME, REPORT_FONT_PATH);
    doc.font(REPORT_FONT_NAME);

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
        for (const [month, cents] of Object.entries(
          s.monthlyBreakdown as Record<string, number>,
        ).sort()) {
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

  private reportStatus(grant: {
    revokedAt: Date | null;
    expiresAt: Date;
    reports: Array<{ status: string }>;
  }): "VALID" | "EXPIRED" | "REVOKED" | "CORRECTED" | "NOT_ISSUED" {
    const report = grant.reports[0] ?? null;
    if (grant.revokedAt || report?.status === "REVOKED") return "REVOKED";
    if (!report) return "NOT_ISSUED";
    if (grant.expiresAt < new Date() || report.status === "EXPIRED") return "EXPIRED";
    if (report.status === "CORRECTED") return "CORRECTED";
    return "VALID";
  }

  private async grantByToken(rawToken: string) {
    const grant = await this.prisma.disclosureGrant.findUnique({
      where: { accessTokenHash: sha256Hex(rawToken) },
      include: {
        worker: { include: { user: { select: { displayName: true } } } },
        reports: { orderBy: { createdAt: "desc" as const }, take: 1 },
      },
    });
    if (!grant) throw new NotFoundException("Unknown verification token");
    return grant;
  }

  private assertRecipientAccessAvailable(grant: Awaited<ReturnType<typeof this.grantByToken>>) {
    if (this.reportStatus(grant) !== "VALID") {
      throw new ForbiddenException("This report is not available for recipient access");
    }
    if (grant.accessMode !== "RECIPIENT_OTP" || !grant.recipientEmail) {
      throw new BadRequestException("This report does not require recipient authentication");
    }
  }

  async requestRecipientOtp(rawToken: string) {
    const grant = await this.grantByToken(rawToken);
    this.assertRecipientAccessAvailable(grant);
    const email = grant.recipientEmail!;
    const cooldownKey = `disclosure:otp:${grant.id}:cooldown`;
    const allowed = await this.accessStore(() =>
      this.redis.set(cooldownKey, "1", "EX", ACCESS_OTP_COOLDOWN_SECONDS, "NX"),
    );
    if (!allowed) {
      throw new HttpException(
        "Please wait before requesting another code",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const hourlyKey = `disclosure:otp:${grant.id}:hourly-requests`;
    const hourlyRequests = await this.accessStore(async () => {
      const count = await this.redis.incr(hourlyKey);
      if (count === 1) await this.redis.expire(hourlyKey, 60 * 60);
      return count;
    });
    if (hourlyRequests > ACCESS_OTP_MAX_REQUESTS_PER_HOUR) {
      throw new HttpException("Too many access-code requests", HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const otpKey = `disclosure:otp:${grant.id}`;
    await this.accessStore(async () => {
      await this.redis.set(otpKey, sha256Hex(code), "EX", ACCESS_OTP_TTL_SECONDS);
      await this.redis.set(`${otpKey}:attempts`, "0", "EX", ACCESS_OTP_TTL_SECONDS);
    });

    const domain = email.split("@")[1] ?? "";
    const devCodeDomains = (process.env.OTP_DEVCODE_DOMAINS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const exposeDevCode =
      (process.env.APP_ENV ?? "local") === "local" || devCodeDomains.includes(domain);
    if (!exposeDevCode) {
      try {
        await this.mail.send(
          email,
          "[ServeProof] 소득증명 열람 코드",
          [
            `ServeProof 소득증명 열람 코드: ${code}`,
            "",
            "이 코드는 5분간 유효하며, 5회 이상 틀리면 새 코드를 요청해야 합니다.",
            "본인이 소득증명을 열려고 요청한 것이 아니라면 이 메일을 무시하세요.",
            "",
            `Your ServeProof income-proof access code is ${code}. It expires in 5 minutes.`,
          ].join("\n"),
        );
      } catch (error) {
        await this.accessStore(async () => {
          await this.redis.del(otpKey, `${otpKey}:attempts`, cooldownKey);
          await this.redis.decr(hourlyKey);
        }).catch(() => undefined);
        throw error;
      }
    }

    return {
      sent: true,
      recipientEmailMasked: maskEmail(email),
      expiresInSeconds: ACCESS_OTP_TTL_SECONDS,
      ...(exposeDevCode ? { devCode: code } : {}),
    };
  }

  async verifyRecipientOtp(rawToken: string, code: string) {
    const grant = await this.grantByToken(rawToken);
    this.assertRecipientAccessAvailable(grant);
    const otpKey = `disclosure:otp:${grant.id}`;
    const storedHash = await this.accessStore(() => this.redis.get(otpKey));
    if (!storedHash) throw new UnauthorizedException("Invalid or expired code");
    const attempts = await this.accessStore(() => this.redis.incr(`${otpKey}:attempts`));
    if (attempts > ACCESS_OTP_MAX_ATTEMPTS) {
      await this.accessStore(() => this.redis.del(otpKey, `${otpKey}:attempts`));
      throw new UnauthorizedException("Too many attempts; request a new code");
    }
    if (storedHash !== sha256Hex(code)) {
      throw new UnauthorizedException("Invalid or expired code");
    }
    await this.accessStore(() => this.redis.del(otpKey, `${otpKey}:attempts`));

    const accessToken = randomBytes(32).toString("base64url");
    const expiresInSeconds = Math.max(
      1,
      Math.min(
        ACCESS_SESSION_TTL_SECONDS,
        Math.floor((grant.expiresAt.getTime() - Date.now()) / 1000),
      ),
    );
    await this.accessStore(() =>
      this.redis.set(
        `disclosure:session:${grant.id}:${sha256Hex(accessToken)}`,
        "1",
        "EX",
        expiresInSeconds,
      ),
    );
    return { accessToken, expiresInSeconds };
  }

  async verifyByToken(
    rawToken: string,
    meta: { ip?: string; userAgent?: string },
    accessSession?: string,
  ) {
    const grant = await this.grantByToken(rawToken);
    const report = grant.reports[0] ?? null;
    const status = this.reportStatus(grant);
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
      accessMode: grant.accessMode,
    };

    // Only a currently valid report can ever return its snapshot. Expired,
    // revoked, corrected, and unissued links expose metadata only.
    if (status !== "VALID") return base;

    if (grant.accessMode === "RECIPIENT_OTP") {
      const sessionValid = accessSession
        ? await this.accessStore(() =>
            this.redis.get(`disclosure:session:${grant.id}:${sha256Hex(accessSession)}`),
          )
        : null;
      if (!sessionValid) {
        return {
          status: "AUTH_REQUIRED" as const,
          accessMode: grant.accessMode,
          expiresAt: grant.expiresAt,
          recipientEmailMasked: maskEmail(grant.recipientEmail!),
        };
      }
    }

    await this.prisma.disclosureAccessLog.create({
      data: { grantId: grant.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    });
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
