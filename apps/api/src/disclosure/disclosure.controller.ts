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
import { parseBody } from "../common/zod";
import { DisclosureService } from "./disclosure.service";

const createGrantSchema = z.object({
  purpose: z.string().min(1),
  level: z.enum(["LEVEL_1", "LEVEL_2", "LEVEL_3"]),
  dateRangeStart: z.iso.datetime(),
  dateRangeEnd: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  recipientEmail: z.email().optional(),
  allowDownload: z.boolean().optional(),
  thresholdUsdCents: z.number().int().positive().optional(),
});

const issueReportSchema = z.object({
  disclosureGrantId: z.uuid(),
  // The worker holds the raw token (returned once at grant creation); the
  // backend only stores its hash, so the QR target comes from the client.
  shareUrl: z.url().optional(),
});

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

@Controller()
export class DisclosureController {
  constructor(private readonly disclosure: DisclosureService) {}

  // Spec §22 — POST /disclosures (raw token returned exactly once)
  @Post("disclosures")
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(createGrantSchema, body);
    const { grant, rawToken } = await this.disclosure.createGrant(user.id, input);
    return {
      grant,
      shareUrl: `${WEB_ORIGIN}/verify/${rawToken}`,
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
  ) {
    return this.disclosure.verifyByToken(token, { ip, userAgent });
  }
}
