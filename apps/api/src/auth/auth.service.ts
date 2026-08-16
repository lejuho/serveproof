import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import IORedis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "./mail.service";

const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

type AppMode = "worker" | "staff";

@Injectable()
export class AuthService implements OnApplicationShutdown {
  private readonly logger = new Logger(AuthService.name);
  private readonly redis: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {
    this.redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
    });
    this.redis.on("error", (error) => {
      this.logger.warn(`otp redis error (status=${this.redis.status}): ${error.message}`);
    });
  }

  /**
   * Run a Redis op with self-healing: a client that permanently gave up
   * ('end') is reconnected once, and failures surface as 503 with the real
   * cause instead of an opaque 500.
   */
  private async otpStore<T>(op: () => Promise<T>): Promise<T> {
    if (["end", "close"].includes(this.redis.status)) {
      await this.redis.connect().catch(() => undefined);
    }
    try {
      return await op();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`otp store failure (status=${this.redis.status}): ${message}`);
      throw new ServiceUnavailableException(
        `OTP store unavailable: ${message} (redis=${this.redis.status})`,
      );
    }
  }

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }

  // ── OTP (spec §4.2 — email OTP login) ──────────────────────────

  async requestOtp(email: string): Promise<{ sent: boolean; devCode?: string }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const key = `otp:${email.toLowerCase()}`;
    await this.otpStore(async () => {
      await this.redis.set(key, sha256(code), "EX", OTP_TTL_SECONDS);
      await this.redis.set(`${key}:attempts`, "0", "EX", OTP_TTL_SECONDS);
    });

    // Demo/E2E accounts keep the one-click devCode flow even in staging;
    // OTP_DEVCODE_DOMAINS is a comma-separated email-domain allowlist.
    const domain = email.toLowerCase().split("@")[1] ?? "";
    const devCodeDomains = (process.env.OTP_DEVCODE_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if ((process.env.APP_ENV ?? "local") === "local" || devCodeDomains.includes(domain)) {
      this.logger.debug(`OTP for ${email}: ${code}`);
      return { sent: true, devCode: code };
    }

    // Never expose the code outside local/allowlist — real delivery only.
    await this.mail.sendOtp(email, code);
    return { sent: true };
  }

  async verifyOtp(email: string, code: string): Promise<TokenPair & { userId: string }> {
    const key = `otp:${email.toLowerCase()}`;
    const attempts = await this.otpStore(() => this.redis.incr(`${key}:attempts`));
    if (attempts > OTP_MAX_ATTEMPTS) {
      await this.redis.del(key);
      throw new UnauthorizedException("Too many attempts; request a new code");
    }

    const storedHash = await this.otpStore(() => this.redis.get(key));
    if (!storedHash || storedHash !== sha256(code)) {
      throw new UnauthorizedException("Invalid or expired code");
    }
    await this.redis.del(key, `${key}:attempts`);

    const normalizedEmail = email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          authUserId: `otp:${normalizedEmail}`,
          email: normalizedEmail,
          displayName: normalizedEmail.split("@")[0] ?? normalizedEmail,
          role: "WORKER",
        },
      });
    }
    const tokens = await this.issueTokens(user.id, user.email, user.role);
    return { ...tokens, userId: user.id };
  }

  // ── Refresh rotation (spec §24) ────────────────────────────────

  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    // Rotation: atomically claim the presented token so concurrent requests
    // cannot both pass the read-before-write window and mint two token pairs.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null, expiresAt: { gte: new Date() } },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw new UnauthorizedException("Invalid refresh token");
    return this.issueTokens(stored.user.id, stored.user.email, stored.user.role);
  }

  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count > 0 };
  }

  async getSession(userId: string): Promise<{ userId: string; email: string; modes: AppMode[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        worker: { select: { id: true } },
        memberships: { select: { id: true }, take: 1 },
      },
    });
    if (!user) throw new UnauthorizedException("User no longer exists");
    const modes: AppMode[] = [];
    if (user.worker) modes.push("worker");
    if (user.memberships.length) modes.push("staff");
    return { userId, email: user.email, modes };
  }

  private async issueTokens(userId: string, email: string, role: string): Promise<TokenPair> {
    // An account represents a person, not a mutually exclusive app role.
    // Backfill older staff-only records as their sessions refresh so every
    // person can use their own worker view without a separate account.
    await this.prisma.worker.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
    const userCapabilities = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        worker: { select: { id: true } },
        memberships: { select: { id: true }, take: 1 },
      },
    });
    const modes: AppMode[] = [];
    if (userCapabilities?.worker) modes.push("worker");
    if (userCapabilities?.memberships.length) modes.push("staff");

    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, role, modes, typ: "access" },
      { expiresIn: ACCESS_TOKEN_TTL },
    );
    const refreshToken = randomBytes(32).toString("hex");
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    return { accessToken, refreshToken };
  }
}
