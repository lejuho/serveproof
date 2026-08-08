// Square Sandbox fixture — creates the §26 demo dataset in the sandbox so the
// live sync path (OAuth → provider-sync → allocation) has real data to pull:
//   - 3 team members (worker_001..003 as reference ids)
//   - card payments with tips totalling $120 (CARD_TIP inflow)
//   - closed timecards SERVER/SERVER/BUSSER, one with $35.50 declared cash tips
//
// Idempotent: team members are matched by reference_id; payments/timecards use
// fixed idempotency keys, so re-runs do not duplicate.
//
// Usage: node scripts/square-fixture.mjs [businessDate=YYYY-MM-DD (UTC), default: yesterday]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", ".env"), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);

const TOKEN = env.SQUARE_ACCESS_TOKEN;
if (!TOKEN) throw new Error("SQUARE_ACCESS_TOKEN missing in .env");
const BASE = "https://connect.squareupsandbox.com";
const VERSION = "2026-07-15";

// Payments cannot be backdated (created_at = call time), so tips always land
// on TODAY's UTC business date. Default the whole fixture to today and place
// timecards in already-elapsed windows of the same day.
const dateArg = process.argv[2];
const day = dateArg ? new Date(`${dateArg}T00:00:00Z`) : new Date();
const ymd = day.toISOString().slice(0, 10);
const FIXTURE = `serveproof-${ymd}`;

async function sq(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": VERSION,
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body.errors ?? []).map((e) => `${e.code}:${e.detail ?? ""}`).join(", ");
    throw new Error(`Square ${res.status} ${path} — ${detail}`);
  }
  return body;
}

// ── 1) location ─────────────────────────────────────────────────
const { locations = [] } = await sq("/v2/locations");
const location = locations.find((l) => l.status === "ACTIVE") ?? locations[0];
if (!location) throw new Error("No sandbox location found");
console.log(`location: ${location.id} (${location.name}, tz=${location.timezone})`);

// ── 2) team members (idempotent by reference_id) ────────────────
const WORKERS = [
  { referenceId: "worker_001", givenName: "Alice", familyName: "Server", role: "SERVER" },
  { referenceId: "worker_002", givenName: "Bob", familyName: "Server", role: "SERVER" },
  { referenceId: "worker_003", givenName: "Carol", familyName: "Busser", role: "BUSSER" },
];

const existing = await sq("/v2/team-members/search", {
  method: "POST",
  body: JSON.stringify({ query: { filter: { status: "ACTIVE" } }, limit: 200 }),
});
const byReference = new Map(
  (existing.team_members ?? []).filter((m) => m.reference_id).map((m) => [m.reference_id, m]),
);

const teamMembers = {};
for (const worker of WORKERS) {
  let member = byReference.get(worker.referenceId);
  if (!member) {
    const created = await sq("/v2/team-members", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `${FIXTURE}-tm-${worker.referenceId}`,
        team_member: {
          reference_id: worker.referenceId,
          given_name: worker.givenName,
          family_name: worker.familyName,
          assigned_locations: {
            assignment_type: "EXPLICIT_LOCATIONS",
            location_ids: [location.id],
          },
        },
      }),
    });
    member = created.team_member;
    console.log(`created team member ${worker.referenceId} → ${member.id}`);
  } else {
    console.log(`team member exists ${worker.referenceId} → ${member.id}`);
  }
  teamMembers[worker.referenceId] = member;
}

// ── 3) card payments with tips (total tips $120.00) ─────────────
const PAYMENTS = [
  { key: "p1", amountCents: 50000, tipCents: 8000 },
  { key: "p2", amountCents: 30000, tipCents: 4000 },
];
for (const p of PAYMENTS) {
  try {
    const created = await sq("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `${FIXTURE}-${p.key}`,
        source_id: "cnon:card-nonce-ok",
        amount_money: { amount: p.amountCents, currency: "USD" },
        tip_money: { amount: p.tipCents, currency: "USD" },
        location_id: location.id,
        autocomplete: true,
        note: `ServeProof fixture ${ymd}`,
      }),
    });
    console.log(
      `payment ${p.key}: ${created.payment.id} tip $${(p.tipCents / 100).toFixed(2)} (${created.payment.status})`,
    );
  } catch (error) {
    console.log(`payment ${p.key}: ${error.message}`);
  }
}

// ── 4) closed timecards on the same business date ───────────────
// For today: windows must already be in the past → anchor to now-10m and go
// backwards (worked-minute ratios mirror the §26 demo: 300/360/270 scaled).
const isToday = ymd === new Date().toISOString().slice(0, 10);
const anchor = new Date(Date.now() - 10 * 60 * 1000);
const startOfDay = new Date(`${ymd}T00:00:00Z`);
const clampedStart = (minutes) => {
  const start = new Date(anchor.getTime() - minutes * 60 * 1000);
  return start < startOfDay ? startOfDay : start;
};
const win = (minutes) =>
  isToday ? { start: clampedStart(minutes).toISOString(), end: anchor.toISOString() } : null;
const TIMECARDS = [
  {
    ref: "worker_001",
    ...(win(100) ?? { start: `${ymd}T17:00:00Z`, end: `${ymd}T22:00:00Z` }),
    role: "SERVER",
  },
  {
    ref: "worker_002",
    ...(win(120) ?? { start: `${ymd}T17:00:00Z`, end: `${ymd}T23:00:00Z` }),
    role: "SERVER",
  },
  {
    ref: "worker_003",
    ...(win(90) ?? { start: `${ymd}T18:00:00Z`, end: `${ymd}T22:30:00Z` }),
    role: "BUSSER",
    cashTipCents: 3550,
  },
];
for (const t of TIMECARDS) {
  try {
    const created = await sq("/v2/labor/timecards", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `${FIXTURE}-tc-${t.ref}`,
        timecard: {
          location_id: location.id,
          team_member_id: teamMembers[t.ref].id,
          start_at: t.start,
          end_at: t.end,
          wage: {
            title: t.role,
            hourly_rate: { amount: 1500, currency: "USD" },
            tip_eligible: true,
          },
          ...(t.cashTipCents
            ? { declared_cash_tip_money: { amount: t.cashTipCents, currency: "USD" } }
            : {}),
        },
      }),
    });
    console.log(`timecard ${t.ref}: ${created.timecard.id} (${created.timecard.status})`);
  } catch (error) {
    console.log(`timecard ${t.ref}: ${error.message}`);
  }
}

// ── 5) verify via the same reads the adapter uses ───────────────
const begin = new Date(`${ymd}T00:00:00Z`);
const end = new Date(`${ymd}T23:59:59Z`);
const payments = await sq(
  `/v2/payments?begin_time=${begin.toISOString()}&end_time=${end.toISOString()}&location_id=${location.id}&limit=100`,
);
const tipTotal = (payments.payments ?? []).reduce(
  (sum, p) => sum + Number(p.tip_money?.amount ?? 0),
  0,
);
const timecards = await sq("/v2/labor/timecards/search", {
  method: "POST",
  body: JSON.stringify({
    query: {
      filter: {
        location_ids: [location.id],
        workday: {
          date_range: { start_date: ymd, end_date: ymd },
          match_timecards_by: "START_AT",
          default_timezone: "UTC",
        },
      },
    },
    limit: 200,
  }),
});
console.log("── verification (adapter-equivalent reads) ──");
console.log(
  `business date ${ymd}: payments=${payments.payments?.length ?? 0} (card tips $${(tipTotal / 100).toFixed(2)}), timecards=${timecards.timecards?.length ?? 0}`,
);
