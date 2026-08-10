import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";

/**
 * OTP delivery over plain SMTP so any provider works with the same four
 * variables (Gmail app password, Resend smtp.resend.com, SendGrid, …).
 * When SMTP_HOST is unset the service is disabled and AuthService falls
 * back to devCode/allowlist behavior.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor() {
    const host = process.env.SMTP_HOST;
    this.from = process.env.EMAIL_FROM ?? process.env.SMTP_USER ?? "no-reply@serveproof.local";
    if (!host) {
      this.transporter = null;
      return;
    }
    const port = Number(process.env.SMTP_PORT ?? 587);
    this.transporter = createTransport({
      host,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }

  get enabled(): boolean {
    return this.transporter !== null;
  }

  async sendOtp(to: string, code: string): Promise<void> {
    if (!this.transporter) {
      throw new ServiceUnavailableException("Email delivery is not configured (SMTP_HOST unset)");
    }
    try {
      await this.transporter.sendMail({
        from: `ServeProof <${this.from}>`,
        to,
        subject: `[ServeProof] 로그인 코드 ${code}`,
        text: [
          `ServeProof 로그인 인증 코드: ${code}`,
          "",
          "이 코드는 5분간 유효하며, 5회 이상 틀리면 새 코드를 요청해야 합니다.",
          "본인이 요청하지 않았다면 이 메일을 무시하세요.",
          "",
          `Your ServeProof login code is ${code}. It expires in 5 minutes.`,
        ].join("\n"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`OTP mail send failed for ${to}: ${message}`);
      throw new ServiceUnavailableException(`OTP email delivery failed: ${message}`);
    }
  }
}
