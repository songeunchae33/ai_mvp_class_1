-- 예산 대비 실제 지출 (기준일이 있는 달, 1일 ~ 기준일)
-- 앱의 '이번 달 예산'과 같은 기준: 분류별 지출은 나간 돈 합계(환불은 빼지 않음), 예산은 만원 단위
-- 쓰는 기술: CTE, LEFT JOIN(쓴 돈이 0원인 분류도 남기기), 계산 칸
WITH params AS (
    SELECT as_of,
           date_trunc('month', as_of)::DATE AS month_start,
           last_day(as_of)                  AS month_end
    FROM as_of
),
mtd AS (
    SELECT t.user_id, t.cat, sum(t.amount) AS spent
    FROM tx_class t, params p
    WHERE t.kind = 'spend' AND t.date BETWEEN p.month_start AND p.as_of
    GROUP BY t.user_id, t.cat
)
SELECT
    b.user_id,
    b.cat,
    b.budget_man * 10000                                              AS budget,
    coalesce(m.spent, 0)                                              AS spent,
    b.budget_man * 10000 - coalesce(m.spent, 0)                       AS remaining,
    round(100.0 * coalesce(m.spent, 0) / (b.budget_man * 10000), 1)   AS used_pct,
    (SELECT date_diff('day', as_of, month_end) + 1 FROM params)       AS days_left,   -- 오늘 포함
    CASE WHEN coalesce(m.spent, 0) > b.budget_man * 10000 THEN '초과'
         WHEN coalesce(m.spent, 0) > b.budget_man * 10000 * 0.8 THEN '주의'
         ELSE '여유' END                                               AS status
FROM budgets b
LEFT JOIN mtd m USING (user_id, cat)
ORDER BY b.user_id, used_pct DESC;
