"use client";

import { Badge, Card, LanguageToggle, Logo } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

/**
 * Public explainer for evidence grades (spec §18). Mirrors computeGrade() in
 * packages/db/src/income-projector.ts — update both together.
 */
export default function GradesPage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  const grades = [
    {
      grade: "A",
      name: ko ? "완전 교차 확인" : "Fully cross-verified",
      meaning: ko
        ? "근무·팁·배분·지급·급여 신고가 서로 다른 출처로 모두 확인된 최고 등급입니다. 제3자가 가장 신뢰할 수 있는 기록입니다."
        : "The strongest grade: work, tips, allocation, payment, and payroll reporting are each confirmed by independent sources.",
      criteria: ko
        ? [
            "팁 결제 증빙(POS 정산 또는 CSV)과 근무 기록 증빙",
            "사업장이 승인한 배분 내역",
            "지급 확인 — USDC 온체인 확정 또는 사업장 증빙 지급",
            "급여 신고·원천징수 기록 확인",
          ]
        : [
            "Tip payment evidence (POS settlement or CSV) and a shift record",
            "A venue-approved allocation",
            "Payment confirmation — finalized on-chain USDC or a venue-attested payout",
            "Payroll reporting / withholding record confirmed",
          ],
    },
    {
      grade: "B",
      name: ko ? "온체인 지급 확정" : "On-chain payment finalized",
      meaning: ko
        ? "지급 사실이 Solana 블록체인에서 확정되어 위·변조가 불가능합니다. 급여 신고 확인만 더해지면 A로 올라갑니다."
        : "Payment is finalized on the Solana blockchain and cannot be altered. Confirming payroll reporting upgrades this to A.",
      criteria: ko
        ? [
            "팁 결제 증빙과 근무 기록 증빙",
            "사업장이 승인한 배분 내역",
            "USDC 온체인 지급 확정",
          ]
        : [
            "Tip payment evidence and a shift record",
            "A venue-approved allocation",
            "Finalized on-chain USDC payout",
          ],
    },
    {
      grade: "C",
      name: ko ? "사업장 증빙 지급" : "Venue-attested payment",
      meaning: ko
        ? "현금·계좌이체 등 오프체인 지급을 사업장이 증빙과 함께 기록한 경우입니다. 온체인 확정보다는 약하지만 지급 근거가 남아 있습니다."
        : "An off-chain payout (cash, bank transfer) recorded by the venue with supporting evidence — weaker than on-chain finality, but documented.",
      criteria: ko
        ? [
            "팁 결제 증빙과 근무 기록 증빙",
            "사업장이 승인한 배분 내역",
            "사업장이 증빙과 함께 기록한 오프체인 지급",
          ]
        : [
            "Tip payment evidence and a shift record",
            "A venue-approved allocation",
            "Off-chain payout recorded by the venue with evidence",
          ],
    },
    {
      grade: "D",
      name: ko ? "지급 확인 전" : "Payment not yet confirmed",
      meaning: ko
        ? "근무와 팁 발생은 증빙으로 확인되지만, 지급이 아직 확인되지 않았습니다. 배분 승인과 지급이 확인되면 등급이 올라갑니다."
        : "Work and tips are evidenced, but payment has not been confirmed yet. Approving the allocation and confirming payment raises the grade.",
      criteria: ko
        ? ["팁 결제 증빙과 근무 기록 증빙", "배분 승인 또는 지급 확인이 아직 없음"]
        : ["Tip payment evidence and a shift record", "No approved allocation or confirmed payment yet"],
    },
    {
      grade: "E",
      name: ko ? "증빙 불완전" : "Incomplete evidence",
      meaning: ko
        ? "팁 결제 기록이나 근무 기록 중 하나 이상이 없어 자가 신고 수준의 기록입니다. 사업장 연결과 POS 데이터 연동으로 보완할 수 있습니다."
        : "Missing tip payment records or shift records — effectively self-reported. Connecting the venue and its POS data fills the gap.",
      criteria: ko
        ? ["팁 결제 증빙 또는 근무 기록 증빙 누락"]
        : ["Tip payment evidence or shift record missing"],
    },
  ];

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-6">
          <a href="/">
            <Logo />
          </a>
          <LanguageToggle />
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
            {ko ? "확인 등급 안내" : "Verification grade guide"}
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-zinc-600">
            {ko
              ? "ServeProof는 근무일 단위 소득 기록마다 증빙의 강도를 A부터 E까지 자동으로 평가합니다. 등급은 사람이 매기는 것이 아니라 어떤 증빙이 실제로 존재하는지에 따라 계산되며, 새 증빙(지급 확정, 급여 신고 등)이 도착하면 자동으로 다시 계산됩니다."
              : "ServeProof automatically rates every per-day income record from A to E by the strength of its evidence. Grades are computed from which records actually exist — never assigned by hand — and are recalculated whenever new evidence (a finalized payout, a payroll report) arrives."}
          </p>
        </div>

        {grades.map((item) => (
          <Card
            key={item.grade}
            title={
              <span className="flex items-center gap-2.5">
                <Badge tone={item.grade}>{item.grade}</Badge>
                {item.name}
              </span>
            }
            description={item.meaning}
          >
            <ul className="flex flex-col gap-1.5 text-sm text-zinc-700">
              {item.criteria.map((criterion) => (
                <li key={criterion} className="flex gap-2">
                  <span aria-hidden className="text-emerald-600">
                    ✓
                  </span>
                  {criterion}
                </li>
              ))}
            </ul>
          </Card>
        ))}

        <Card
          title={ko ? "등급은 어떻게 올라가나요?" : "How does a grade improve?"}
          description={
            ko
              ? "노동자가 직접 할 일은 많지 않습니다. 증빙이 쌓이면 등급은 자동으로 올라갑니다."
              : "Workers rarely need to do anything — grades rise automatically as evidence accumulates."
          }
        >
          <ul className="flex flex-col gap-2 text-sm leading-relaxed text-zinc-700">
            <li>
              <b>E → D</b> ·{" "}
              {ko
                ? "사업장 계정을 연결하고 POS·근무 기록이 들어오면 기초 증빙이 채워집니다."
                : "Connect the venue account; incoming POS and shift records complete the base evidence."}
            </li>
            <li>
              <b>D → C/B</b> ·{" "}
              {ko
                ? "사업장이 배분을 승인하고 지급이 확인되면 올라갑니다. USDC 온체인 지급이면 B, 증빙을 남긴 오프체인 지급이면 C입니다."
                : "The venue approves the allocation and payment is confirmed — B for on-chain USDC, C for evidenced off-chain payouts."}
            </li>
            <li>
              <b>B/C → A</b> ·{" "}
              {ko
                ? "급여 신고·원천징수 기록까지 확인되면 최고 등급이 됩니다."
                : "Confirming payroll reporting and withholding completes the top grade."}
            </li>
          </ul>
          <p className="mt-4 rounded-xl bg-zinc-50 px-4 py-3 text-xs leading-relaxed text-zinc-600">
            {ko
              ? "참고: USDC 온체인 지급은 '지급 사실'을 강하게 증명하지만, 근무 사실이나 급여 신고를 단독으로 증명하지는 않습니다. 그래서 최고 등급 A는 한 가지 강한 증빙이 아니라 여러 출처의 교차 확인을 요구합니다."
              : "Note: an on-chain USDC payout strongly proves that payment happened, but by itself proves neither the work nor the payroll reporting. That is why grade A requires cross-confirmation from multiple sources rather than one strong record."}
          </p>
        </Card>
      </main>
    </div>
  );
}
