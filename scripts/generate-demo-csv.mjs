// Deterministic demo CSV generator for repeatable rehearsals and live demos.
//
// Usage: node scripts/generate-demo-csv.mjs [options] > demo.csv
//   --days N              business dates to generate (default 5)
//   --end-date YYYY-MM-DD last generated business date (default yesterday UTC)
//   --seed VALUE          deterministic amounts and shifts
//   --profile default     worker_001/002 USDC, worker_003 PAYROLL
//   --profile history     all three workers PAYROLL, for prefilled history
//   --profile live        worker_001/002 USDC only, for the on-stage batch
//   --unmapped            adds worker_099 rows to demo held shares
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSV_EVIDENCE_HEADERS } from "../packages/shared/dist/csv.js";

const pad = (n) => String(n).padStart(2, "0");

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function seededRandom(seedText) {
  let state = 2166136261;
  for (const character of seedText) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDemoCsv({
  days = 5,
  endDate,
  seed = "serveproof-demo",
  profile = "default",
  unmapped = false,
} = {}) {
  const safeDays = Math.max(1, Number(days) || 5);
  const defaultEnd = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const parsedEnd = new Date(`${endDate ?? defaultEnd}T12:00:00Z`);
  if (Number.isNaN(parsedEnd.getTime())) throw new Error(`Invalid --end-date: ${endDate}`);
  if (!["default", "history", "live"].includes(profile)) {
    throw new Error(`Invalid --profile: ${profile}`);
  }

  const baseWorkers = [
    { id: "worker_001", role: "SERVER", route: "USDC", payrollStatus: "UNKNOWN" },
    { id: "worker_002", role: "SERVER", route: "USDC", payrollStatus: "UNKNOWN" },
    { id: "worker_003", role: "BUSSER", route: "PAYROLL", payrollStatus: "PROVIDER_CONFIRMED" },
  ];
  const workers = (profile === "live" ? baseWorkers.slice(0, 2) : baseWorkers).map((worker) =>
    profile === "history"
      ? { ...worker, route: "PAYROLL", payrollStatus: "PROVIDER_CONFIRMED" }
      : worker,
  );
  if (unmapped) {
    workers.push({
      id: "worker_099",
      role: "SERVER",
      route: "USDC",
      payrollStatus: "UNKNOWN",
    });
  }

  const endYmd = parsedEnd.toISOString().slice(0, 10);
  const random = seededRandom(`${seed}:${profile}:${endYmd}:${safeDays}:${unmapped}`);
  const randInt = (min, max) => min + Math.floor(random() * (max - min + 1));
  const rows = [CSV_EVIDENCE_HEADERS.join(",")];
  let usdcCents = 0;
  let payrollCents = 0;
  let shiftCount = 0;

  for (let offset = safeDays - 1; offset >= 0; offset--) {
    const day = new Date(parsedEnd.getTime() - offset * 86_400_000);
    const ymd = day.toISOString().slice(0, 10);
    for (const worker of workers) {
      const startHour = profile === "live" ? 16 : randInt(15, 18);
      const minutes = profile === "live" ? 300 : randInt(210, 360);
      const startMinute = profile === "live" ? 0 : randInt(0, 59);
      const start = new Date(`${ymd}T${pad(startHour)}:${pad(startMinute)}:00Z`);
      const end = new Date(start.getTime() + minutes * 60_000);
      const tipCents = profile === "live" ? 1500 : randInt(800, 3000);
      rows.push(
        [
          "toast_mock",
          "venue_001",
          worker.id,
          `shift_${ymd}_${worker.id}`,
          "CARD_TIP",
          (tipCents / 100).toFixed(2),
          start.toISOString(),
          end.toISOString(),
          worker.role,
          worker.route,
          worker.payrollStatus,
        ].join(","),
      );
      shiftCount += 1;
      if (worker.route === "USDC") usdcCents += tipCents;
      else payrollCents += tipCents;
    }
  }

  return {
    csv: rows.join("\n") + "\n",
    meta: { days: safeDays, shiftCount, usdcCents, payrollCents, profile, endDate: endYmd },
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  const result = generateDemoCsv({
    days: option(args, "--days", "5"),
    endDate: option(args, "--end-date", undefined),
    seed: option(args, "--seed", "serveproof-demo"),
    profile: option(args, "--profile", "default"),
    unmapped: args.includes("--unmapped"),
  });
  process.stdout.write(result.csv);
  console.error(
    `generated ${result.meta.days} business dates, ${result.meta.shiftCount} shifts — ` +
      `USDC pool ~$${(result.meta.usdcCents / 100).toFixed(2)}, ` +
      `PAYROLL pool ~$${(result.meta.payrollCents / 100).toFixed(2)} ` +
      `(${result.meta.profile}, through ${result.meta.endDate})`,
  );
}
