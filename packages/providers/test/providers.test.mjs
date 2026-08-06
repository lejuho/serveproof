import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptProviderToken,
  encryptProviderToken,
  SquareClient,
  squareAuthorizationUrl,
} from "../dist/index.js";

test("provider token encryption round-trips without exposing plaintext", () => {
  const token = "square-secret-access-token";
  const encrypted = encryptProviderToken(token, "a-long-provider-encryption-secret");
  assert.equal(encrypted.includes(token), false);
  assert.equal(decryptProviderToken(encrypted, "a-long-provider-encryption-secret"), token);
  assert.throws(() => decryptProviderToken(encrypted, "the-wrong-provider-encryption-secret"));
});

test("Square OAuth URL requests only evidence read scopes", () => {
  const url = new URL(
    squareAuthorizationUrl({
      environment: "sandbox",
      appId: "sandbox-app-id",
      redirectUri: "http://localhost:3001/providers/square/callback",
      state: "opaque-state",
    }),
  );
  assert.equal(url.origin, "https://connect.squareupsandbox.com");
  assert.equal(url.searchParams.get("state"), "opaque-state");
  assert.match(url.searchParams.get("scope"), /PAYMENTS_READ/);
  assert.match(url.searchParams.get("scope"), /TIMECARDS_READ/);
});

test("Square evidence normalizes order tips, refunds, timecards, and cash tips", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/v2/payments?")) {
      return Response.json({
        payments: [
          {
            id: "payment-1",
            order_id: "order-1",
            created_at: "2026-08-05T18:00:00Z",
            status: "COMPLETED",
            total_money: { amount: 2500, currency: "USD" },
            refunded_money: { amount: 500, currency: "USD" },
          },
        ],
      });
    }
    if (url.endsWith("/v2/orders/batch-retrieve")) {
      return Response.json({
        orders: [{ id: "order-1", total_tip_money: { amount: 500, currency: "USD" } }],
      });
    }
    if (url.endsWith("/v2/labor/timecards/search")) {
      return Response.json({
        timecards: [
          {
            id: "timecard-1",
            team_member_id: "worker-1",
            start_at: "2026-08-05T17:00:00Z",
            end_at: "2026-08-05T22:00:00Z",
            status: "CLOSED",
            wage: { title: "SERVER" },
            declared_cash_tip_money: { amount: 1200, currency: "USD" },
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new SquareClient("access-token", "sandbox", "UTC");
  const period = { startDate: "2026-08-05", endDate: "2026-08-05" };
  const [cardTips, cashTips, shifts] = await Promise.all([
    client.fetchTipEvidence("location-1", period),
    client.fetchCashTipEvidence("location-1", period),
    client.fetchShiftEvidence("location-1", period),
  ]);
  assert.equal(cardTips[0].grossAmountUsdCents, 500);
  assert.equal(cardTips[0].refundStatus, "PARTIAL");
  assert.equal(cashTips[0].grossAmountUsdCents, 1200);
  assert.equal(shifts[0].workedMinutes, 300);
  assert.equal(shifts[0].externalWorkerId, "worker-1");
});
