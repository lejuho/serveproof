# 데모 CSV 세트

대시보드(1. CSV Import)에 파일 내용을 붙여넣고 → 해당 **business date**로 계산 → 승인하는 시연용
데이터입니다. 로그인: `manager@demo.serveproof.local`.

전제: Demo Diner의 활성 정책 v1 —
roleWeights `SERVER 1.0 / BUSSER 0.7 / BARTENDER 1.0`, 풀 포함 `CARD_TIP·QR_TIP만`,
제외 role `MANAGER·SUPERVISOR`.

> ⚠️ 승인된 batch는 재계산할 수 없습니다(409). 같은 파일을 다시 시연하려면 CSV의 날짜(및
> shift id 접두사)를 미사용 날짜로 바꿔서 import 하세요. 이미 사용된 날짜: 2026-08-04~06,
> 2026-03-xx(자동 테스트).

## demo1_basic.csv — 기본 흐름 (business date: 2026-08-01)

§26 데모 시나리오 그대로: 카드 팁 $120 풀, 현금 팁은 CASH_RETAINED로 분리(풀 제외).

| Worker     | 근무  | 가중치 반영 점수 | 예상 배분  |
| ---------- | ----- | ---------------- | ---------- |
| A (SERVER) | 300분 | 300              | **$42.40** |
| B (SERVER) | 360분 | 360              | **$50.88** |
| C (BUSSER) | 270분 | 189              | **$26.72** |

합계 = 풀 $120.00 정확히 일치. 승인 후 B에게 USDC 지급 → C에는 PAYOUT_GAP 경고가 뜨는 것까지
이어서 시연 가능.

## demo2_multi_shift.csv — 복수 시프트·풀 포함 규칙 (2026-08-02)

한 사람이 두 시프트(A: 240분×2), BARTENDER 가중치, **SERVICE_CHARGE $80은 정책상 풀 제외**.

- 풀 = $45 + $30 + $60(QR_TIP) = **$135.00** (service charge 미포함)
- 점수: A 480 / B(BARTENDER) 420 / C(BUSSER) 210
- 예상 배분: A **$58.38** / B **$51.08** / C **$25.54**

## demo3_exclusions.csv — 제외 규칙 모음 (2026-08-03)

- AUTOMATIC_GRATUITY $50 → 풀 제외 (정책)
- B의 MANAGER 시프트(240분) → 점수 계산에서 제외 (제외 role)
- 현금 팁 $20 → CASH_RETAINED 분리

- 풀 = **$90.00** (카드 팁만)
- 점수: A 300 / B 300(SERVER 시프트만) / C 126
- 예상 배분: A **$37.19** / B **$37.19** / C **$15.62**

## demo_tips_shifts.csv (기존)

최초 데모(2026-08-05)에 사용된 원본 fixture — 해당 날짜는 이미 승인·지급 완료 상태라
재시연에는 위의 demo1~3을 사용하세요.

## curl로 import 하려면

```bash
CSV=$(cat fixtures/csv/demo1_basic.csv | jq -Rs .)
curl -X POST http://localhost:3001/providers/csv/import \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"venueId\":\"$VENUE_ID\",\"csvText\":$CSV}"
```
