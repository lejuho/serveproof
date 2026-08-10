import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createTransport } from "nodemailer";

/**
 * OTP delivery over plain SMTP so any provider works with the same four
 * variables (Gmail app password, Resend smtp.resend.com, SendGrid, …).
 * When SMTP_HOST is unset the service is disabled and AuthService falls
 * back to devCode/allowlist behavior.
 *
 * The host is resolved to IPv4 here because nodemailer picks a random
 * address among A+AAAA records, and Railway containers have no IPv6
 * egress (ENETUNREACH) — same class of problem as Redis ?family=0.
 * `servername` keeps TLS SNI/certificate validation on the hostname.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly host = process.env.SMTP_HOST;
  private readonly port = Number(process.env.SMTP_PORT ?? 587);
  private readonly from =
    process.env.EMAIL_FROM ?? process.env.SMTP_USER ?? "no-reply@serveproof.local";

  get enabled(): boolean {
    return Boolean(this.host);
  }

  async sendOtp(to: string, code: string): Promise<void> {
    if (!this.host) {
      throw new ServiceUnavailableException("Email delivery is not configured (SMTP_HOST unset)");
    }
    try {
      const ipv4Host = isIP(this.host) ? this.host : (await resolve4(this.host))[0];
      if (!ipv4Host) throw new Error(`no IPv4 address for ${this.host}`);
      const transporter = createTransport({
        host: ipv4Host,
        tls: { servername: this.host },
        port: this.port,
        secure: this.port === 465,
        connectionTimeout: 15_000,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
      try {
        await transporter.sendMail({
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
      } finally {
        transporter.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`OTP mail send failed for ${to}: ${message}`);
      throw new ServiceUnavailableException(`OTP email delivery failed: ${message}`);
    }
  }
}
