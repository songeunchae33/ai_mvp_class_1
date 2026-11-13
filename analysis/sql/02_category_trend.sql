-- 분류별 월 지출 추세: 비중, 지난달 대비 증감률, 3개월 이동평균
-- 쓰는 기술: CTE, CROSS JOIN으로 '지출이 0원인 달'까지 채우기, 윈도우 함수(LAG, 이동평균, 비중)
WITH months AS (
    SELECT DISTINCT user_id, month FROM tx_class
),
cats AS (
    SELECT DISTINCT user_id, cat FROM tx_class WHERE kind = 'spend'
),
grid AS (                       -- 사람 × 달 × 분류 (안 쓴 달도 0원으로 남기려고)
    SELECT m.user_id, m.month, c.cat
    FROM months m JOIN cats c USING (user_id)
),
spend AS (
    SELECT user_id, month, cat, sum(amount) AS spend, count(*) AS n
    FROM tx_class
    WHERE kind = 'spend'
    GROUP BY user_id, month, cat
)
SELECT
    g.user_id,
    g.month,
    g.cat,
    coalesce(s.spend, 0)                                                        AS spend,
    coalesce(s.n, 0)                                                            AS n,
    round(100.0 * coalesce(s.spend, 0) / nullif(sum(coalesce(s.spend, 0)) OVER (PARTITION BY g.user_id, g.month), 0), 1)
                                                                                AS share_pct,
    LAG(coalesce(s.spend, 0)) OVER w                                            AS prev_spend,
    round(100.0 * (coalesce(s.spend, 0) - LAG(coalesce(s.spend, 0)) OVER w)
          / nullif(LAG(coalesce(s.spend, 0)) OVER w, 0), 1)                     AS change_pct,
    round(avg(coalesce(s.spend, 0)) OVER (w ROWS BETWEEN 2 PRECEDING AND CURRENT ROW))
                                                                                AS ma3
FROM grid g
LEFT JOIN spend s USING (user_id, month, cat)
WINDOW w AS (PARTITION BY g.user_id, g.cat ORDER BY g.month)
ORDER BY g.user_id, g.cat, g.month;
