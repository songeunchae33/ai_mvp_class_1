-- 이상 지출 탐지: 같은 분류의 '평소 금액'보다 훨씬 큰 지출
-- 평소 = 그 거래 전날까지 최근 90일, 같은 분류 지출의 95번째 백분위수(P95: 100번 중 95번째로 큰 금액)
-- 규칙: 지난 90일에 같은 분류 지출이 3번 이상 있고, 3만원 이상이며, 금액 > P95 × 2
--
-- 왜 이 규칙인가 (합성 데이터 정답표로 비교, analysis/notebooks/01_eda.ipynb 참고)
--   처음 규칙(중앙값 + 3.5×1.4826×MAD, 5번 이상)은 140건을 잡았다. 식비 안에 '구내식당 1만원'과 '배달·식당 2~5만원'이
--   섞여 있어서(두 봉우리 분포) 평범한 배달까지 이상으로 잡혔기 때문. 평소의 '윗부분'(P95)과 비교하면 이런 섞임에 덜 흔들린다.
--   5번 이상 조건은 가끔 사는 분류(쇼핑)를 놓쳐서 3번으로 낮췄다.
-- 쓰는 기술: 날짜 범위 윈도우(RANGE BETWEEN … PRECEDING), quantile_cont를 윈도우로, CTE
-- ※ 앱(index.html의 unusualSpends)과 같은 규칙. scripts/check-metrics.mjs가 두 결과를 비교한다
WITH spend AS (
    SELECT * FROM tx_class WHERE kind = 'spend'
),
history AS (
    SELECT
        s.*,
        count(*)                       OVER w AS n_prior,
        median(amount)                 OVER w AS prior_median,
        quantile_cont(amount, 0.95)    OVER w AS prior_p95
    FROM spend s
    WINDOW w AS (PARTITION BY user_id, cat ORDER BY date
                 RANGE BETWEEN INTERVAL 90 DAY PRECEDING AND INTERVAL 1 DAY PRECEDING)
)
SELECT
    user_id, id, date, merchant, cat, amount,
    n_prior,
    prior_median,
    round(prior_p95)                                    AS prior_p95,
    round(amount / nullif(prior_median, 0), 1)          AS times_usual
FROM history
WHERE n_prior >= 3
  AND amount >= 30000
  AND amount > prior_p95 * 2
ORDER BY user_id, date, id;
