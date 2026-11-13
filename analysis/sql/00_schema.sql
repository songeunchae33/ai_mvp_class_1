-- 소비 인텔리전스 1단계: 테이블 설계 (DuckDB)
-- 앱의 가계부(ledger.tx)를 CSV로 내보낸 모양 그대로 받는다. user_id는 여러 사람(합성 데이터)을 한 번에 분석하려고 둔 칸.

CREATE OR REPLACE TABLE tx (
    user_id   VARCHAR NOT NULL,
    id        VARCHAR NOT NULL,
    date      DATE    NOT NULL,
    merchant  VARCHAR,
    amount    BIGINT  NOT NULL CHECK (amount > 0),   -- 원, 늘 양수. 방향은 dir로
    dir       VARCHAR NOT NULL CHECK (dir IN ('in', 'out')),
    cat       VARCHAR NOT NULL,
    src       VARCHAR,                               -- 직접 기록 / 캡처 / 고정
    fixed_id  VARCHAR,                               -- 고정 수입·지출에서 자동으로 만든 거래면 그 항목 번호
    PRIMARY KEY (user_id, id)
);

CREATE OR REPLACE TABLE budgets (       -- 분류별 한 달 예산 (앱의 profile.budgets, 만원)
    user_id    VARCHAR NOT NULL,
    cat        VARCHAR NOT NULL,
    budget_man INTEGER NOT NULL,
    PRIMARY KEY (user_id, cat)
);

CREATE OR REPLACE TABLE fixed_items (   -- 고정 수입·지출 (앱의 ledger.fixed)
    user_id  VARCHAR NOT NULL,
    fixed_id VARCHAR NOT NULL,
    name     VARCHAR,
    amount   BIGINT,
    day      INTEGER,
    dir      VARCHAR,
    cat      VARCHAR,
    PRIMARY KEY (user_id, fixed_id)
);

CREATE OR REPLACE TABLE as_of (as_of DATE);   -- 기준일(오늘로 보는 날)

-- 거래마다 '무엇으로 셀지'를 한 번에 정해 두는 보기(view). 모든 분석 쿼리가 이 기준을 같이 쓴다.
--   지출   : 나간 돈이면서 내부이체가 아닌 것
--   수입   : 들어온 돈이면서 급여·수입
--   환불   : 들어온 돈이면서 급여·수입·내부이체가 아닌 것 → 그 기간 총지출에서 뺀다 (분류별 지출에서는 빼지 않음: 앱과 같은 기준)
--   내부이체: 내 통장끼리 옮긴 돈이라 계산에서 뺀다
--   고정비 : src = '고정' 이거나 fixed_id가 있는 지출. 나머지 지출은 변동비
CREATE OR REPLACE VIEW tx_class AS
SELECT
    t.*,
    CASE
        WHEN t.cat = '내부이체'                    THEN 'transfer'
        WHEN t.dir = 'out'                         THEN 'spend'
        WHEN t.cat = '급여·수입'                   THEN 'income'
        ELSE 'refund'
    END                                                         AS kind,
    (t.src = '고정' OR t.fixed_id IS NOT NULL)                  AS is_fixed,
    date_trunc('month', t.date)::DATE                           AS month,
    (t.date - (isodow(t.date) - 1) * INTERVAL 1 DAY)::DATE      AS week_start,   -- 그 주 월요일
    isodow(t.date)                                              AS weekday       -- 1=월 … 7=일
FROM tx t;
