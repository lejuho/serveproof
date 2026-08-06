import { createHash } from "node:crypto";
import type {
  DateRange,
  EvidenceProvider,
  ProviderHealth,
  ProviderShiftEvidence,
  ProviderTipEvidence,
} from "./provider.js";

export const SQUARE_API_VERSION = "2026-07-15";
export type SquareEnvironment = "sandbox" | "production";

export interface SquareTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id: string;
}

export class SquareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function businessDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function apiBase(environment: SquareEnvironment): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

export function squareAuthorizationUrl(input: {
  environment: SquareEnvironment;
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`${apiBase(input.environment)}/oauth2/authorize`);
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("scope", "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ TIMECARDS_READ");
  url.searchParams.set("session", "false");
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}

export class SquareClient implements EvidenceProvider {
  readonly provider = "square";
  private readonly baseUrl: string;
  private readonly timecardCache = new Map<string, Promise<Record<string, unknown>[]>>();

  constructor(
    private readonly accessToken: string,
    readonly environment: SquareEnvironment,
    private readonly timezone = "UTC",
  ) {
    this.baseUrl = apiBase(environment);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_API_VERSION,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        errors?: { code?: string; detail?: string }[];
      };
      const detail = body.errors
        ?.map((error) => error.code ?? error.detail)
        .filter(Boolean)
        .join(", ");
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new SquareApiError(
        `Square API ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    return (await response.json()) as T;
  }

  static async obtainToken(input: {
    environment: SquareEnvironment;
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    code?: string;
    refreshToken?: string;
  }): Promise<SquareTokenResponse> {
    const body = input.code
      ? {
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri,
        }
      : {
          client_id: input.clientId,
          client_secret: input.clientSecret,
          refresh_token: input.refreshToken,
          grant_type: "refresh_token",
        };
    const response = await fetch(`${apiBase(input.environment)}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": SQUARE_API_VERSION },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as SquareTokenResponse & {
      errors?: { code?: string; detail?: string }[];
    };
    if (!response.ok) {
      const detail = payload.errors
        ?.map((error) => error.code ?? error.detail)
        .filter(Boolean)
        .join(", ");
      throw new SquareApiError(
        `Square OAuth ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    return payload;
  }

  async listLocations(): Promise<
    { id: string; name?: string; status?: string; timezone?: string }[]
  > {
    const result = await this.request<{
      locations?: { id: string; name?: string; status?: string; timezone?: string }[];
    }>("/v2/locations");
    return result.locations ?? [];
  }

  async fetchTipEvidence(locationId: string, period: DateRange): Promise<ProviderTipEvidence[]> {
    const payments: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      // Square filters payments by UTC timestamp, while our period is expressed
      // as venue-local business dates. Widen the request and filter locally.
      const begin = new Date(`${period.startDate}T00:00:00Z`);
      begin.setUTCDate(begin.getUTCDate() - 1);
      const end = new Date(`${period.endDate}T23:59:59.999Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      const query = new URLSearchParams({
        begin_time: begin.toISOString(),
        end_time: end.toISOString(),
        location_id: locationId,
        sort_order: "ASC",
        limit: "100",
      });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request<{ payments?: Record<string, unknown>[]; cursor?: string }>(
        `/v2/payments?${query}`,
      );
      payments.push(...(page.payments ?? []));
      cursor = page.cursor;
    } while (cursor);

    const missingTipOrderIds = payments
      .filter((payment) => !payment.tip_money && typeof payment.order_id === "string")
      .map((payment) => payment.order_id as string);
    const orderTips = new Map<string, number>();
    for (let index = 0; index < missingTipOrderIds.length; index += 100) {
      const orderIds = missingTipOrderIds.slice(index, index + 100);
      const result = await this.request<{ orders?: Record<string, unknown>[] }>(
        "/v2/orders/batch-retrieve",
        {
          method: "POST",
          body: JSON.stringify({ location_id: locationId, order_ids: orderIds }),
        },
      );
      for (const order of result.orders ?? []) {
        const money = order.total_tip_money as
          { amount?: number | string; currency?: string } | undefined;
        if (typeof order.id === "string" && money?.currency === "USD")
          orderTips.set(order.id, Number(money.amount ?? 0));
      }
    }

    return payments.flatMap((payment): ProviderTipEvidence[] => {
      const tipMoney = payment.tip_money as
        { amount?: number | string; currency?: string } | undefined;
      const orderId = typeof payment.order_id === "string" ? payment.order_id : undefined;
      const amount = tipMoney ? Number(tipMoney.amount ?? 0) : (orderTips.get(orderId ?? "") ?? 0);
      const currency = tipMoney?.currency ?? (amount > 0 ? "USD" : undefined);
      if (!payment.id || !payment.created_at || amount <= 0 || currency !== "USD") return [];
      const localBusinessDate = businessDate(new Date(String(payment.created_at)), this.timezone);
      if (localBusinessDate < period.startDate || localBusinessDate > period.endDate) return [];
      const refunded = Number(
        (payment.refunded_money as { amount?: number | string } | undefined)?.amount ?? 0,
      );
      const total = Number(
        (payment.total_money as { amount?: number | string } | undefined)?.amount ?? 0,
      );
      const status = String(payment.status ?? "PENDING");
      return [
        {
          provider: this.provider,
          externalPaymentId: String(payment.id),
          externalOrderId: orderId,
          tipType: "CARD_TIP",
          grossAmountUsdCents: amount,
          paymentStatus:
            status === "COMPLETED"
              ? "COMPLETED"
              : status === "CANCELED" || status === "FAILED"
                ? "CANCELED"
                : "PENDING",
          refundStatus:
            refunded <= 0 ? "NONE" : total > 0 && refunded >= total ? "FULL" : "PARTIAL",
          businessDate: localBusinessDate,
          sourceHash: hash(payment),
        },
      ];
    });
  }

  private async timecards(
    locationId: string,
    period: DateRange,
  ): Promise<Record<string, unknown>[]> {
    const cacheKey = `${locationId}:${period.startDate}:${period.endDate}`;
    const cached = this.timecardCache.get(cacheKey);
    if (cached) return cached;
    const request = (async () => {
      const timecards: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const result = await this.request<{
          timecards?: Record<string, unknown>[];
          cursor?: string;
        }>("/v2/labor/timecards/search", {
          method: "POST",
          body: JSON.stringify({
            query: {
              filter: {
                location_ids: [locationId],
                workday: {
                  date_range: { start_date: period.startDate, end_date: period.endDate },
                  match_timecards_by: "START_AT",
                  default_timezone: this.timezone,
                },
              },
            },
            limit: 200,
            ...(cursor ? { cursor } : {}),
          }),
        });
        timecards.push(...(result.timecards ?? []));
        cursor = result.cursor;
      } while (cursor);
      return timecards;
    })();
    this.timecardCache.set(cacheKey, request);
    return request;
  }

  async fetchShiftEvidence(
    locationId: string,
    period: DateRange,
  ): Promise<ProviderShiftEvidence[]> {
    const timecards = await this.timecards(locationId, period);
    return timecards.flatMap((timecard): ProviderShiftEvidence[] => {
      if (!timecard.id || !timecard.team_member_id || !timecard.start_at) return [];
      const start = new Date(String(timecard.start_at));
      const end = timecard.end_at ? new Date(String(timecard.end_at)) : null;
      const wage = timecard.wage as { title?: string } | undefined;
      return [
        {
          provider: this.provider,
          externalShiftId: String(timecard.id),
          externalWorkerId: String(timecard.team_member_id),
          role: wage?.title ?? "TEAM_MEMBER",
          clockIn: start,
          clockOut: end,
          workedMinutes: end
            ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
            : 0,
          shiftStatus: String(timecard.status) === "OPEN" ? "IN_PROGRESS" : "COMPLETED",
          businessDate: businessDate(start, this.timezone),
          sourceHash: hash(timecard),
        },
      ];
    });
  }

  async fetchCashTipEvidence(
    locationId: string,
    period: DateRange,
  ): Promise<ProviderTipEvidence[]> {
    const timecards = await this.timecards(locationId, period);
    return timecards.flatMap((timecard): ProviderTipEvidence[] => {
      const money = timecard.declared_cash_tip_money as
        { amount?: number | string; currency?: string } | undefined;
      const amount = Number(money?.amount ?? 0);
      if (!timecard.id || !timecard.start_at || amount <= 0 || money?.currency !== "USD") return [];
      return [
        {
          provider: this.provider,
          externalPaymentId: `timecard:${String(timecard.id)}`,
          tipType: "CASH_TIP",
          grossAmountUsdCents: amount,
          paymentStatus: String(timecard.status) === "OPEN" ? "PENDING" : "COMPLETED",
          refundStatus: "NONE",
          businessDate: businessDate(new Date(String(timecard.start_at)), this.timezone),
          sourceHash: hash(timecard),
        },
      ];
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.listLocations();
      return { ok: true, provider: this.provider, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        provider: this.provider,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : "Square health check failed",
      };
    }
  }
}
