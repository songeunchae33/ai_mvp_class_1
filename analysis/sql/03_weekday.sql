-- 요일별 소비 성향 (최근 12주, 고정비 제외 변동비만)
-- 지출이 없는 날도 0원으로 세야 평균이 부풀지 않는다 → 날짜 달력을 만들어 LEFT JOIN
-- 쓰는 기술: generate_series로 달력 만들기, LEFT JOIN, GROUP BY, 비중 윈도우
WITH params AS (
    SELECT as_of, as_of - INTERVAL 83 DAY AS start_day FROM as_of        -- 오늘 포함 84일 = 12주
),
calendar AS (
    SELECT u.user_id, d::DATE AS date, isodow(d::DATE) AS weekday
    FROM (SELECT DISTINCT user_id FROM tx) u,
         params p,
         generate_series(p.start_day, p.as_of, INTERVAL 1 DAY) AS g(d)
),
daily AS (
    SELECT user_id, date, sum(amount) AS spend
    FROM tx_class
    WHERE kind = 'spend' AND NOT is_fixed
    GROUP BY user_id, date
)
SELECT
    c.user_id,
    c.weekday,
    ['월', '화', '수', '목', '금', '토', '일'][c.weekday]                        AS weekday_name,
    count(*)                                                                  AS n_days,
    round(avg(coalesce(d.spend, 0)))                                          AS avg_daily_spend,
    round(100.0 * sum(coalesce(d.spend, 0)) / sum(sum(coalesce(d.spend, 0))) OVER (PARTITION BY c.user_id), 1)
                                                                              AS share_pct
FROM calendar c
LEFT JOIN daily d USING (user_id, date)
GROUP BY c.user_id, c.weekday
ORDER BY c.user_id, c.weekday;
