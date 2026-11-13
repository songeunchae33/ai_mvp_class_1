-- 고정비 · 변동비 구분 (월별)
-- 고정비 = 고정 수입·지출로 자동 기록된 지출. 등록한 고정 항목(fixed_items)과 JOIN해서 이름도 함께 본다
-- 쓰는 기술: JOIN, GROUP BY, 비중 계산
WITH spend AS (
    SELECT * FROM tx_class WHERE kind = 'spend'
),
by_month AS (
    SELECT
        user_id, month,
        sum(amount) FILTER (WHERE is_fixed)       AS fixed_spend,
        sum(amount) FILTER (WHERE NOT is_fixed)   AS variable_spend
    FROM spend
    GROUP BY user_id, month
)
SELECT
    b.user_id,
    b.month,
    coalesce(b.fixed_spend, 0)                                                         AS fixed_spend,
    coalesce(b.variable_spend, 0)                                                      AS variable_spend,
    round(100.0 * coalesce(b.fixed_spend, 0) / nullif(coalesce(b.fixed_spend, 0) + coalesce(b.variable_spend, 0), 0), 1)
                                                                                       AS fixed_share_pct,
    (SELECT string_agg(DISTINCT f.name, ', ' ORDER BY f.name)
       FROM spend s JOIN fixed_items f ON f.user_id = s.user_id AND f.fixed_id = s.fixed_id
      WHERE s.user_id = b.user_id AND s.month = b.month)                               AS fixed_items
FROM by_month b
ORDER BY b.user_id, b.month;
