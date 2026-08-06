import { Injectable, Logger } from "@nestjs/common";
import {
  decryptProviderToken,
  encryptProviderToken,
  SquareApiError,
  SquareClient,
  type DateRange,
  type ProviderShiftEvidence,
  type ProviderTipEvidence,
  type SquareEnvironment,
} from "@serveproof/providers";
import { PrismaService } from "./prisma.service";

export interface ProviderSyncJob {
  venueId: string;
  provider: "square";
  startDate: string;
  endDate: string;
}

@Injectable()
export class SquareSyncService {
  private readonly logger = new Logger(SquareSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  private config() {
    const appId = process.env.SQUARE_APP_ID;
    const appSecret = process.env.SQUARE_APP_SECRET;
    const encryptionSecret = process.env.PROVIDER_ENCRYPTION_KEY ?? process.env.AUTH_SECRET;
    if (!appId || !appSecret || !encryptionSecret)
      throw new Error("Square provider configuration is incomplete");
    const environment: SquareEnvironment =
      process.env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";
    return { appId, appSecret, encryptionSecret, environment };
  }

  private async client(
    connection: {
      id: string;
      encryptedAccessToken: string | null;
      encryptedRefreshToken: string | null;
      tokenExpiresAt: Date | null;
      environment: string;
    },
    timezone: string,
    forceRefresh = false,
  ): Promise<SquareClient> {
    const config = this.config();
    let accessToken = connection.encryptedAccessToken
      ? decryptProviderToken(connection.encryptedAccessToken, config.encryptionSecret)
      : null;
    const shouldRefresh =
      forceRefresh ||
      (connection.tokenExpiresAt !== null &&
        connection.tokenExpiresAt.getTime() < Date.now() + 24 * 60 * 60_000);
    if (shouldRefresh && connection.encryptedRefreshToken) {
      const refreshToken = decryptProviderToken(
        connection.encryptedRefreshToken,
        config.encryptionSecret,
      );
      const tokens = await SquareClient.obtainToken({
        environment: config.environment,
        clientId: config.appId,
        clientSecret: config.appSecret,
        refreshToken,
      });
      accessToken = tokens.access_token;
      await this.prisma.providerConnection.update({
        where: { id: connection.id },
        data: {
          encryptedAccessToken: encryptProviderToken(tokens.access_token, config.encryptionSecret),
          encryptedRefreshToken: tokens.refresh_token
            ? encryptProviderToken(tokens.refresh_token, config.encryptionSecret)
            : connection.encryptedRefreshToken,
          tokenExpiresAt: tokens.expires_at ? new Date(tokens.expires_at) : null,
          status: "CONNECTED",
        },
      });
    }
    if (!accessToken) throw new Error("Square access token is missing");
    return new SquareClient(accessToken, config.environment, timezone);
  }

  private async persist(
    venueId: string,
    tips: ProviderTipEvidence[],
    shifts: ProviderShiftEvidence[],
  ) {
    const mappings = await this.prisma.externalWorkerAccount.findMany({
      where: { venueId, provider: "square", mappingStatus: "CONFIRMED" },
    });
    const workerByExternalId = new Map(
      mappings.map((mapping) => [mapping.externalWorkerId, mapping.workerId]),
    );
    let mappedShifts = 0;
    let unmappedShifts = 0;

    for (const tip of tips) {
      await this.prisma.tipEvidence.upsert({
        where: {
          venueId_provider_externalPaymentId_tipType: {
            venueId,
            provider: tip.provider,
            externalPaymentId: tip.externalPaymentId,
            tipType: tip.tipType,
          },
        },
        update: {
          externalOrderId: tip.externalOrderId,
          grossAmountUsdCents: tip.grossAmountUsdCents,
          paymentStatus: tip.paymentStatus,
          refundStatus: tip.refundStatus,
          businessDate: tip.businessDate,
          sourceHash: tip.sourceHash,
          observedAt: new Date(),
        },
        create: { venueId, ...tip },
      });
    }

    for (const shift of shifts) {
      const mappedWorkerId = workerByExternalId.get(shift.externalWorkerId) ?? null;
      if (mappedWorkerId) mappedShifts++;
      else unmappedShifts++;
      await this.prisma.shiftEvidence.upsert({
        where: {
          venueId_provider_externalShiftId: {
            venueId,
            provider: shift.provider,
            externalShiftId: shift.externalShiftId,
          },
        },
        update: { ...shift, mappedWorkerId, observedAt: new Date() },
        create: { venueId, ...shift, mappedWorkerId },
      });
    }
    return {
      tipsUpserted: tips.length,
      shiftsUpserted: shifts.length,
      mappedShifts,
      unmappedShifts,
    };
  }

  async sync(input: ProviderSyncJob) {
    const connection = await this.prisma.providerConnection.findUnique({
      where: { venueId_provider: { venueId: input.venueId, provider: input.provider } },
      include: { venue: true },
    });
    if (!connection || connection.status === "REVOKED" || !connection.locationId) {
      throw new Error("Connected Square provider not found for venue");
    }
    await this.prisma.providerConnection.update({
      where: { id: connection.id },
      data: { lastSyncStartedAt: new Date() },
    });
    const range: DateRange = { startDate: input.startDate, endDate: input.endDate };

    try {
      let client = await this.client(connection, connection.venue.timezone);
      let evidence;
      try {
        evidence = await Promise.all([
          client.fetchTipEvidence(connection.locationId, range),
          client.fetchCashTipEvidence(connection.locationId, range),
          client.fetchShiftEvidence(connection.locationId, range),
        ]);
      } catch (error) {
        if (
          !(error instanceof SquareApiError) ||
          error.status !== 401 ||
          !connection.encryptedRefreshToken
        )
          throw error;
        client = await this.client(connection, connection.venue.timezone, true);
        evidence = await Promise.all([
          client.fetchTipEvidence(connection.locationId, range),
          client.fetchCashTipEvidence(connection.locationId, range),
          client.fetchShiftEvidence(connection.locationId, range),
        ]);
      }
      const [cardTips, cashTips, shifts] = evidence;
      const summary = await this.persist(input.venueId, [...cardTips, ...cashTips], shifts);
      await this.prisma.$transaction([
        this.prisma.providerConnection.update({
          where: { id: connection.id },
          data: {
            status: "CONNECTED",
            lastSyncSucceededAt: new Date(),
            lastError: null,
            consecutiveFailures: 0,
          },
        }),
        this.prisma.discrepancyAlert.updateMany({
          where: { venueId: input.venueId, type: "STALE_PROVIDER_DATA", resolvedAt: null },
          data: { resolvedAt: new Date() },
        }),
      ]);
      this.logger.log(
        `Square sync succeeded venue=${input.venueId} tips=${summary.tipsUpserted} shifts=${summary.shiftsUpserted}`,
      );
      return summary;
    } catch (error) {
      const safeMessage =
        error instanceof SquareApiError
          ? `Square API ${error.status}`
          : error instanceof Error
            ? error.message.slice(0, 300)
            : "Provider sync failed";
      await this.prisma.providerConnection.update({
        where: { id: connection.id },
        data: {
          status: "ERROR",
          lastSyncFailedAt: new Date(),
          lastError: safeMessage,
          consecutiveFailures: { increment: 1 },
        },
      });
      throw error;
    }
  }

  async syncConnectedVenues() {
    const connections = await this.prisma.providerConnection.findMany({
      where: { provider: "square", status: { in: ["CONNECTED", "ERROR"] } },
      select: { venueId: true },
    });
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    // Let the scheduled job fail when any venue fails so BullMQ applies its
    // exponential retry policy. Successful venue writes remain idempotent.
    return Promise.all(
      connections.map(({ venueId }) =>
        this.sync({ venueId, provider: "square", startDate: yesterday, endDate: today }),
      ),
    );
  }

  async flagStaleConnections() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    const stale = await this.prisma.providerConnection.findMany({
      where: {
        provider: "square",
        status: { in: ["CONNECTED", "ERROR"] },
        OR: [{ lastSyncSucceededAt: null }, { lastSyncSucceededAt: { lt: cutoff } }],
      },
    });
    for (const connection of stale) {
      const existing = await this.prisma.discrepancyAlert.findFirst({
        where: { venueId: connection.venueId, type: "STALE_PROVIDER_DATA", resolvedAt: null },
      });
      if (!existing) {
        await this.prisma.discrepancyAlert.create({
          data: {
            venueId: connection.venueId,
            type: "STALE_PROVIDER_DATA",
            detail: { provider: "square", lastSuccessAt: connection.lastSyncSucceededAt },
          },
        });
      }
    }
    return { staleConnections: stale.length };
  }
}
