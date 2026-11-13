-- 월별 소비 요약 + 지난달 대비 증감률
-- 쓰는 기술: CTE, 조건부 집계(FILTER), 윈도우 함수 LAG
WITH monthly AS (
    SELECT
        user_id,
        month,
        sum(amount) FILTER (WHERE kind = 'spend')                    AS out_sum,
        coalesce(sum(amount) FILTER (WHERE kind = 'refund'), 0)      AS refund_sum,
        coalesce(sum(amount) FILTER (WHERE kind = 'income'), 0)      AS income,
        sum(amount) FILTER (WHERE kind = 'spend' AND is_fixed)       AS fixed_spend,
        sum(amount) FILTER (WHERE kind = 'spend' AND NOT is_fixed)   AS variable_spend,
        count(*) FILTER (WHERE kind = 'spend')                       AS n_spend
    FROM tx_class
    GROUP BY user_id, month
)
SELECT
    user_id,
    month,
    greatest(out_sum - refund_sum, 0)                                         AS spend,        -- 앱의 '쓴 돈'과 같은 기준
    income,
    coalesce(fixed_spend, 0)                                                  AS fixed_spend,
    coalesce(variable_spend, 0)                                               AS variable_spend,
    n_spend,
    LAG(greatest(out_sum - refund_sum, 0)) OVER w                             AS prev_spend,
    round(100.0 * (greatest(out_sum - refund_sum, 0) - LAG(greatest(out_sum - refund_sum, 0)) OVER w)
          / nullif(LAG(greatest(out_sum - refund_sum, 0)) OVER w, 0), 1)      AS spend_change_pct
FROM monthly
WINDOW w AS (PARTITION BY user_id ORDER BY month)
ORDER BY user_id, month;
