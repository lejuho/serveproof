import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  decryptProviderToken,
  encryptProviderToken,
  SquareClient,
  squareAuthorizationUrl,
  type SquareEnvironment,
} from "@serveproof/providers";
import { QUEUES } from "@serveproof/shared";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";

const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");

@Injectable()
export class ProvidersService implements OnModuleDestroy {
  private readonly redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  private readonly syncQueue = new Queue(QUEUES.providerSync, { connection: this.redis });

  constructor(private readonly prisma: PrismaService) {}

  private config() {
    const appId = process.env.SQUARE_APP_ID;
    const appSecret = process.env.SQUARE_APP_SECRET;
    const redirectUri = process.env.SQUARE_REDIRECT_URI;
    const encryptionSecret = process.env.PROVIDER_ENCRYPTION_KEY ?? process.env.AUTH_SECRET;
    if (!appId || !appSecret || !redirectUri || !encryptionSecret) {
      throw new ServiceUnavailableException(
        "Square OAuth or provider encryption is not configured",
      );
    }
    const environment: SquareEnvironment =
      process.env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";
    return { appId, appSecret, redirectUri, encryptionSecret, environment };
  }

  async createSquareAuthorization(venueId: string, locationId?: string) {
    const config = this.config();
    const state = randomBytes(32).toString("base64url");
    await this.prisma.providerConnection.upsert({
      where: { venueId_provider: { venueId, provider: "square" } },
      update: {
        environment: config.environment,
        status: "PENDING",
        locationId,
        oauthStateHash: stateHash(state),
        oauthStateExpiresAt: new Date(Date.now() + 10 * 60_000),
        lastError: null,
      },
      create: {
        venueId,
        provider: "square",
        environment: config.environment,
        locationId,
        oauthStateHash: stateHash(state),
        oauthStateExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    return {
      authorizationUrl: squareAuthorizationUrl({
        environment: config.environment,
        appId: config.appId,
        redirectUri: config.redirectUri,
        state,
      }),
      expiresInSeconds: 600,
    };
  }

  async completeSquareAuthorization(input: {
    state?: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }) {
    if (!input.state) throw new BadRequestException("Missing OAuth state");
    const connection = await this.prisma.providerConnection.findFirst({
      where: {
        provider: "square",
        oauthStateHash: stateHash(input.state),
        oauthStateExpiresAt: { gt: new Date() },
      },
      include: { venue: true },
    });
    if (!connection) throw new BadRequestException("OAuth state is invalid or expired");
    const consumed = await this.prisma.providerConnection.updateMany({
      where: { id: connection.id, oauthStateHash: stateHash(input.state) },
      data: { oauthStateHash: null, oauthStateExpiresAt: null },
    });
    if (consumed.count !== 1) throw new BadRequestException("OAuth state was already used");
    if (input.error) {
      await this.prisma.providerConnection.update({
        where: { id: connection.id },
        data: {
          status: "ERROR",
          lastError: input.error,
        },
      });
      throw new BadRequestException(input.errorDescription ?? input.error);
    }
    if (!input.code) throw new BadRequestException("Missing OAuth authorization code");

    const config = this.config();
    const tokens = await SquareClient.obtainToken({
      environment: config.environment,
      clientId: config.appId,
      clientSecret: config.appSecret,
      redirectUri: config.redirectUri,
      code: input.code,
    });
    const client = new SquareClient(
      tokens.access_token,
      config.environment,
      connection.venue.timezone,
    );
    const locations = await client.listLocations();
    const selected = connection.locationId
      ? locations.find((location) => location.id === connection.locationId)
      : (locations.find((location) => location.status === "ACTIVE") ?? locations[0]);
    if (!selected) throw new BadRequestException("Square seller has no accessible location");

    const externalIds = (connection.venue.externalIds ?? {}) as Record<string, unknown>;
    await this.prisma.$transaction([
      this.prisma.providerConnection.update({
        where: { id: connection.id },
        data: {
          status: "CONNECTED",
          merchantId: tokens.merchant_id,
          locationId: selected.id,
          encryptedAccessToken: encryptProviderToken(tokens.access_token, config.encryptionSecret),
          encryptedRefreshToken: tokens.refresh_token
            ? encryptProviderToken(tokens.refresh_token, config.encryptionSecret)
            : connection.encryptedRefreshToken,
          tokenExpiresAt: tokens.expires_at ? new Date(tokens.expires_at) : null,
          lastError: null,
          consecutiveFailures: 0,
        },
      }),
      this.prisma.venue.update({
        where: { id: connection.venueId },
        data: { externalIds: { ...externalIds, square: selected.id } },
      }),
    ]);
    return {
      connected: true,
      provider: "square",
      venueId: connection.venueId,
      merchantId: tokens.merchant_id,
      location: selected,
    };
  }

  async enqueueSync(input: {
    venueId: string;
    provider: "square";
    startDate: string;
    endDate: string;
  }) {
    const connection = await this.prisma.providerConnection.findUnique({
      where: { venueId_provider: { venueId: input.venueId, provider: input.provider } },
    });
    if (!connection || !["CONNECTED", "ERROR"].includes(connection.status))
      throw new NotFoundException("Connected Square provider not found for venue");
    const job = await this.syncQueue.add("sync", input, {
      attempts: 6,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return { jobId: job.id, status: "queued" };
  }

  async health(provider: string, venueId: string) {
    if (provider !== "square") throw new NotFoundException(`Provider ${provider} is not supported`);
    const connection = await this.prisma.providerConnection.findUnique({
      where: { venueId_provider: { venueId, provider } },
      include: { venue: true },
    });
    if (!connection?.encryptedAccessToken)
      throw new NotFoundException("Connected Square provider not found for venue");
    const config = this.config();
    const client = new SquareClient(
      decryptProviderToken(connection.encryptedAccessToken, config.encryptionSecret),
      config.environment,
      connection.venue.timezone,
    );
    const probe = await client.healthCheck();
    return {
      ...probe,
      connectionStatus: connection.status,
      lastSyncSucceededAt: connection.lastSyncSucceededAt,
      lastSyncFailedAt: connection.lastSyncFailedAt,
      consecutiveFailures: connection.consecutiveFailures,
      stale:
        !connection.lastSyncSucceededAt ||
        Date.now() - connection.lastSyncSucceededAt.getTime() > 24 * 60 * 60_000,
    };
  }

  async onModuleDestroy() {
    await this.syncQueue.close().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }
}
