-- 반복 결제 탐지 (최근 180일)
-- 규칙: 같은 가게에 3번 이상, 금액이 가운데 값(중앙값)의 ±10% 안, 결제 간격이 거의 일정(매주 6~8일 · 매달 27~33일, 간격 흔들림 3일 이하)
-- 매일 가는 카페처럼 간격이 짧은 습관은 '반복 결제'가 아니라서 빠진다
-- 쓰는 기술: 윈도우 함수 LAG로 간격 구하기, median·stddev 집계, CTE 여러 단계
-- ※ 앱(index.html의 recurringPayments)과 같은 규칙. scripts/check-metrics.mjs가 두 결과를 비교한다
WITH params AS (
    SELECT as_of, as_of - INTERVAL 179 DAY AS start_day FROM as_of
),
recent AS (
    SELECT t.*
    FROM tx_class t, params p
    WHERE t.kind = 'spend' AND t.date BETWEEN p.start_day AND p.as_of
),
gaps AS (
    SELECT
        user_id, merchant, cat, date, amount, is_fixed,
        date - LAG(date) OVER (PARTITION BY user_id, merchant ORDER BY date, id) AS gap_days
    FROM recent
),
stats AS (
    SELECT
        user_id, merchant,
        any_value(cat)                       AS cat,
        count(*)                             AS n,
        median(amount)                       AS typical_amount,
        min(amount)                          AS min_amount,
        max(amount)                          AS max_amount,
        median(gap_days)                     AS median_gap,
        coalesce(stddev_pop(gap_days), 0)    AS gap_sd,
        max(date)                            AS last_date,
        bool_or(is_fixed)                    AS is_fixed
    FROM gaps
    GROUP BY user_id, merchant
)
SELECT
    user_id,
    merchant,
    cat,
    n,
    typical_amount,
    CASE WHEN median_gap BETWEEN 6 AND 8 THEN '매주' ELSE '매달' END   AS cycle,
    median_gap,
    round(gap_sd, 2)                                                  AS gap_sd,
    last_date,
    (last_date + CAST(round(median_gap) AS INTEGER))::DATE            AS next_expected,
    is_fixed
FROM stats
WHERE n >= 3
  AND min_amount >= typical_amount * 0.9
  AND max_amount <= typical_amount * 1.1
  AND (median_gap BETWEEN 6 AND 8 OR median_gap BETWEEN 27 AND 33)
  AND gap_sd <= 3
ORDER BY user_id, typical_amount DESC, merchant;
