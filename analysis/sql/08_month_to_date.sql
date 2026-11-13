-- 이번 달 소비 현황: 이번 달 1일~기준일 vs 지난달 같은 기간(1일~같은 날짜) 비교, 분류별 증감
-- '지난달 전체'와 비교하면 아직 덜 지난 이번 달이 늘 적어 보이므로, 같은 날짜까지만 비교한다
-- 쓰는 기술: CTE, 날짜 계산, FULL OUTER JOIN(한쪽 달에만 있는 분류도 남기기), GROUPING SETS로 합계 줄 함께 내기
-- ※ 앱(index.html의 monthToDate)과 같은 규칙. scripts/check-metrics.mjs가 두 결과를 비교한다
WITH params AS (
    SELECT as_of,
           date_trunc('month', as_of)::DATE                                        AS cur_start,
           (date_trunc('month', as_of) - INTERVAL 1 MONTH)::DATE                   AS prev_start,
           -- 지난달 같은 날짜 (지난달이 더 짧으면 그 달 마지막 날)
           least((date_trunc('month', as_of) - INTERVAL 1 MONTH + (day(as_of) - 1) * INTERVAL 1 DAY)::DATE,
                 (date_trunc('month', as_of) - INTERVAL 1 DAY)::DATE)              AS prev_end
    FROM as_of
),
tagged AS (
    SELECT t.user_id, t.cat, t.kind, t.is_fixed, t.amount,
           CASE WHEN t.date BETWEEN p.cur_start AND p.as_of THEN 'cur'
                WHEN t.date BETWEEN p.prev_start AND p.prev_end THEN 'prev' END AS period
    FROM tx_class t, params p
),
by_cat AS (
    SELECT user_id, coalesce(cat, '합계') AS cat,
           sum(amount) FILTER (WHERE period = 'cur'  AND kind = 'spend')  AS cur_out,
           sum(amount) FILTER (WHERE period = 'prev' AND kind = 'spend')  AS prev_out,
           sum(amount) FILTER (WHERE period = 'cur'  AND kind = 'refund') AS cur_refund,
           sum(amount) FILTER (WHERE period = 'prev' AND kind = 'refund') AS prev_refund,
           sum(amount) FILTER (WHERE period = 'cur'  AND kind = 'spend' AND is_fixed) AS cur_fixed
    FROM tagged
    WHERE period IS NOT NULL AND kind IN ('spend', 'refund')
    GROUP BY GROUPING SETS ((user_id, cat), (user_id))
)
SELECT
    user_id,
    cat,
    -- 합계 줄은 앱의 '쓴 돈'처럼 환불을 빼고, 분류 줄은 나간 돈 합계
    CASE WHEN cat = '합계' THEN greatest(coalesce(cur_out, 0) - coalesce(cur_refund, 0), 0) ELSE coalesce(cur_out, 0) END  AS cur_spend,
    CASE WHEN cat = '합계' THEN greatest(coalesce(prev_out, 0) - coalesce(prev_refund, 0), 0) ELSE coalesce(prev_out, 0) END AS prev_spend,
    coalesce(cur_fixed, 0)                                                                                                AS cur_fixed
FROM by_cat
WHERE NOT (cat <> '합계' AND coalesce(cur_out, 0) = 0 AND coalesce(prev_out, 0) = 0)
ORDER BY user_id, cat = '합계' DESC, cur_spend DESC, cat;
