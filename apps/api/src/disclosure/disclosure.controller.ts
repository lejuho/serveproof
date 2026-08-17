import { createReadStream } from "node:fs";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Ip,
  Param,
  Post,
  StreamableFile,
} from "@nestjs/common";
import { z } from "zod";
import { Public } from "../auth/public.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { MailService } from "../auth/mail.service";
import { parseBody } from "../common/zod";
import { DisclosureService } from "./disclosure.service";

const createGrantSchema = z.object({
  purpose: z.string().min(1),
  level: z.enum(["LEVEL_1", "LEVEL_2", "LEVEL_3"]),
  dateRangeStart: z.iso.datetime(),
  dateRangeEnd: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  recipientEmail: z.email().optional(),
  accessMode: z.enum(["LINK", "RECIPIENT_OTP"]).optional(),
  allowDownload: z.boolean().optional(),
  thresholdUsdCents: z.number().int().positive().optional(),
  // issue the report in the same call — required for recipient email delivery
  // to never race ahead of report issuance
  autoIssue: z.boolean().optional(),
});

const issueReportSchema = z.object({
  disclosureGrantId: z.uuid(),
  // The worker holds the raw token (returned once at grant creation); the
  // backend only stores its hash, so the QR target comes from the client.
  shareUrl: z.url().optional(),
});

const verifyRecipientOtpSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

@Controller()
export class DisclosureController {
  constructor(
    private readonly disclosure: DisclosureService,
    private readonly mail: MailService,
  ) {}

  // Spec §22 — POST /disclosures (raw token returned exactly once)
  @Post("disclosures")
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(createGrantSchema, body);
    const { grant, rawToken } = await this.disclosure.createGrant(user.id, input);
    const shareUrl = `${WEB_ORIGIN}/verify/${rawToken}`;

    // Issue before the email goes out so the recipient never lands on an
    // unissued report.
    const report =
      input.autoIssue || input.recipientEmail
        ? (await this.disclosure.issueReport(user.id, grant.id, shareUrl)).report
        : undefined;

    // The raw token only exists right now, so recipient delivery must happen
    // here. A mail failure must not lose the one-time link — report it instead.
    let emailSent: boolean | undefined;
    let emailError: string | undefined;
    if (input.recipientEmail) {
      try {
        await this.mail.send(
          input.recipientEmail,
          `[ServeProof] 소득 증빙 공유 — ${input.purpose}`,
          [
            `ServeProof 소득 증빙이 공유되었습니다.`,
            "",
            `용도: ${input.purpose}`,
            `공개 수준: ${input.level}`,
            `만료: ${new Date(input.expiresAt).toISOString().slice(0, 10)}`,
            "",
            input.accessMode === "RECIPIENT_OTP"
              ? `아래 링크를 열고 이 이메일 주소로 열람 코드를 받아 확인하세요:`
              : `아래 링크에서 진위를 직접 확인할 수 있습니다 (계정 불필요):`,
            shareUrl,
            "",
            `An income proof has been shared with you via ServeProof.`,
            input.accessMode === "RECIPIENT_OTP"
              ? `Open the link and request an access code at this email address.`
              : `Verify it at the link above — no account required.`,
          ].join("\n"),
        );
        emailSent = true;
      } catch (error) {
        emailSent = false;
        emailError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      grant,
      report,
      shareUrl,
      emailSent,
      emailError,
      note: "이 URL은 지금 한 번만 표시됩니다. DB에는 토큰 해시만 저장됩니다.",
    };
  }

  @Get("disclosures")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.disclosure.listGrants(user.id);
  }

  // Spec §22 — DELETE /disclosures/:id (revoke)
  @Delete("disclosures/:id")
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.disclosure.revokeGrant(user.id, id);
  }

  // Spec §22 — POST /reports
  @Post("reports")
  issueReport(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { disclosureGrantId, shareUrl } = parseBody(issueReportSchema, body);
    return this.disclosure.issueReport(
      user.id,
      disclosureGrantId,
      shareUrl ?? `${WEB_ORIGIN}/verify`,
    );
  }

  @Get("reports/:id/pdf")
  async pdf(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const path = await this.disclosure.getPdfPath(user.id, id);
    return new StreamableFile(createReadStream(path), {
      type: "application/pdf",
      disposition: `attachment; filename="serveproof-report-${id}.pdf"`,
    });
  }

  // Spec §22 — GET /verify/:token (public, no account required §3.4)
  @Public()
  @Get("verify/:token")
  verify(
    @Param("token") token: string,
    @Ip() ip: string,
    @Headers("user-agent") userAgent?: string,
    @Headers("x-disclosure-session") accessSession?: string,
  ) {
    return this.disclosure.verifyByToken(token, { ip, userAgent }, accessSession);
  }

  @Public()
  @Post("verify/:token/access/request")
  requestRecipientAccess(@Param("token") token: string) {
    return this.disclosure.requestRecipientOtp(token);
  }

  @Public()
  @Post("verify/:token/access/verify")
  verifyRecipientAccess(@Param("token") token: string, @Body() body: unknown) {
    const { code } = parseBody(verifyRecipientOtpSchema, body);
    return this.disclosure.verifyRecipientOtp(token, code);
  }
}
