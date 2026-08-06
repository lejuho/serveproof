import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationShutdown,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import IORedis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";

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

@Injectable()
export class AuthService implements OnApplicationShutdown {
  private readonly logger = new Logger(AuthService.name);
  private readonly redis: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {
    this.redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
    });
  }

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }

  // ── OTP (spec §4.2 — email OTP login) ──────────────────────────

  async requestOtp(email: string): Promise<{ sent: boolean; devCode?: string }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const key = `otp:${email.toLowerCase()}`;
    await this.redis.set(key, sha256(code), "EX", OTP_TTL_SECONDS);
    await this.redis.set(`${key}:attempts`, "0", "EX", OTP_TTL_SECONDS);

    // TODO(staging): send via email provider. Never log the code outside local.
    if ((process.env.APP_ENV ?? "local") === "local") {
      this.logger.debug(`OTP for ${email}: ${code}`);
      return { sent: true, devCode: code };
    }
    return { sent: true };
  }

  async verifyOtp(email: string, code: string): Promise<TokenPair & { userId: string }> {
    const key = `otp:${email.toLowerCase()}`;
    const attempts = await this.redis.incr(`${key}:attempts`);
    if (attempts > OTP_MAX_ATTEMPTS) {
      await this.redis.del(key);
      throw new UnauthorizedException("Too many attempts; request a new code");
    }

    const storedHash = await this.redis.get(key);
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
    // Workers get a Worker profile on first login (spec §4.2 internal structure)
    if (user.role === "WORKER") {
      await this.prisma.worker.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
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
    // Rotation: the presented token is single-use.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(stored.user.id, stored.user.email, stored.user.role);
  }

  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count > 0 };
  }

  private async issueTokens(userId: string, email: string, role: string): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, role, typ: "access" },
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
