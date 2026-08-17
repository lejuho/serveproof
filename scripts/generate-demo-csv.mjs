// Demo CSV generator — many small USDC settlements with some payroll mixed in,
// to show why Solana fits high-frequency micro-settlement.
//
// Emits §7.3 fallback CSV rows for the seeded toast_mock workers
// (worker_001/002 → USDC rail, worker_003 → PAYROLL), one shift row per worker
// per business date with small card-tip totals ($8–30). Rails arrive
// pre-assigned via payout_route, so each date's batch is payable without
// manual route selection: calculate → approve → USDC buttons per worker.
//
// Shift ids are stable per (date, worker), so re-importing the same dates
// upserts instead of duplicating (amounts may change — that's a recalculation).
//
// Usage: node scripts/generate-demo-csv.mjs [--days N] [--unmapped] > demo.csv
//   --days N     business dates to generate, ending yesterday (default 5)
//   --unmapped   adds worker_099 rows (no mapping) to also demo held shares
import { CSV_EVIDENCE_HEADERS } from "../packages/shared/dist/csv.js";

const args = process.argv.slice(2);
const daysFlag = args.indexOf("--days");
const DAYS = daysFlag >= 0 ? Math.max(1, Number(args[daysFlag + 1]) || 5) : 5;
const UNMAPPED = args.includes("--unmapped");

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pad = (n) => String(n).padStart(2, "0");

const WORKERS = [
  { id: "worker_001", role: "SERVER", route: "USDC", payrollStatus: "UNKNOWN" },
  { id: "worker_002", role: "SERVER", route: "USDC", payrollStatus: "UNKNOWN" },
  { id: "worker_003", role: "BUSSER", route: "PAYROLL", payrollStatus: "PROVIDER_CONFIRMED" },
  ...(UNMAPPED
    ? [{ id: "worker_099", role: "SERVER", route: "USDC", payrollStatus: "UNKNOWN" }]
    : []),
];

const rows = [CSV_EVIDENCE_HEADERS.join(",")];
let usdcCents = 0;
let payrollCents = 0;
let shiftCount = 0;

for (let back = DAYS; back >= 1; back--) {
  const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000);
  const ymd = day.toISOString().slice(0, 10);
  for (const worker of WORKERS) {
    // 하루 한 명 정도는 쉬어서 날짜별 구성이 달라 보이게 한다
    if (Math.random() < 0.15) continue;
    const startHour = randInt(15, 18);
    const minutes = randInt(180, 360);
    const start = new Date(`${ymd}T${pad(startHour)}:${pad(randInt(0, 59))}:00Z`);
    const end = new Date(start.getTime() + minutes * 60 * 1000);
    const tipCents = randInt(800, 3000); // 소액: $8.00–$30.00
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

process.stdout.write(rows.join("\n") + "\n");
console.error(
  `generated ${DAYS} business dates, ${shiftCount} shifts — ` +
    `USDC pool ~$${(usdcCents / 100).toFixed(2)}, PAYROLL pool ~$${(payrollCents / 100).toFixed(2)}` +
    (UNMAPPED ? " (+ unmapped worker_099 for held-share demo)" : ""),
);
