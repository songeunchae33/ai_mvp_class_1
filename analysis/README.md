# 소비 인텔리전스 · 데이터 분석 (포트폴리오)

'나만의 경제' 앱의 가계부 거래로 **소비 패턴을 SQL로 분석**하고(1단계), **소비를 예측**하고(2단계),
그 결과를 **루미(AI)가 쉬운 말로 설명**하는(3단계) 과정을 담은 폴더다.
이 폴더는 배포 사이트에 올라가지 않는다(`.vercelignore`).

> 이 폴더의 데이터는 모두 **합성 데이터**다. 실제 개인정보는 쓰지 않았고, 결과 숫자는 실제 사람들의 소비 통계가 아니다.

## 폴더 구조

| 경로 | 내용 |
| --- | --- |
| `python/make_synthetic.py` | 합성 거래 데이터 생성 (가상의 세 사람 × 13개월, 고정 거래·구독·환불·내부이체·일부러 넣은 이상 지출 포함) |
| `data/` | 합성 데이터 CSV, 이상 지출 정답표(`anomalies_truth.csv`), 기준일(`as_of.csv`) |
| `sql/00_schema.sql` | 테이블 설계와 거래 분류 기준(`tx_class` 보기) |
| `sql/01~08_*.sql` | 분석 쿼리 8개 (아래 표) |
| `python/run_sql.py` | CSV를 DuckDB에 넣고 쿼리를 돌려 `results/`에 저장 |
| `python/build_eda_notebook.py` → `notebooks/01_eda.ipynb` | 탐색적 분석(EDA)과 규칙 비교. 실행 결과(표·그림) 포함 |
| `results/` | 쿼리 결과 CSV |
| `../scripts/check-metrics.mjs` | SQL 결과와 앱(자바스크립트) 계산이 같은지 자동 비교 |

## 실행 방법

```bash
python -m pip install --user -r analysis/requirements.txt
python analysis/python/make_synthetic.py          # 합성 데이터
python analysis/python/run_sql.py                 # SQL 분석 → analysis/results/
python analysis/python/build_eda_notebook.py      # 노트북 실행·저장
node scripts/check-metrics.mjs                    # 앱 계산 = SQL 결과인지 확인
```

앱에서 내보낸 내 가계부로 돌리기: 나의 자산관리 → 분석 탭 맨 아래 '가계부 CSV로 내보내기' → `python analysis/python/run_sql.py --tx 내보낸파일.csv`

## 거래를 세는 기준 (모든 쿼리와 앱이 같이 씀)

| 종류 | 기준 | 계산 |
| --- | --- | --- |
| 지출 | 나간 돈 · 내부이체 아님 | 더함 |
| 수입 | 들어온 돈 · 급여·수입 | 따로 셈 |
| 환불 | 들어온 돈 · 급여·수입·내부이체 아님 | 그 기간 **총지출에서 뺌** (분류별 지출에서는 빼지 않음 — 앱의 예산 화면과 같은 기준) |
| 내부이체 | 분류가 내부이체 | 계산에서 뺌 |
| 고정비 | `src = 고정` 또는 `fixed_id` 있음 | 지출 중 고정 / 나머지는 변동비 |

## 분석 쿼리와 쓴 SQL 기술

| 파일 | 무엇을 | 쓴 기술 |
| --- | --- | --- |
| `01_monthly_summary` | 월별 쓴 돈·수입·고정/변동, 지난달 대비 증감률 | CTE, `FILTER` 조건부 집계, `LAG` |
| `02_category_trend` | 분류별 월 지출, 비중, 증감률, 3개월 이동평균 | 사람×달×분류 격자(JOIN)로 0원 달 채우기, 윈도우(`LAG`, `AVG … ROWS 2 PRECEDING`, 비중) |
| `03_weekday` | 요일별 하루 평균 변동비(최근 12주) | `generate_series` 달력 + `LEFT JOIN`(지출 없는 날 0원) |
| `04_fixed_variable` | 고정비·변동비 비중, 고정 항목 이름 | `JOIN`, 상관 서브쿼리, `string_agg` |
| `05_recurring` | 반복 결제(구독 등) 탐지 | `LAG`로 결제 간격, `median`·`stddev_pop` |
| `06_anomaly` | 평소보다 훨씬 큰 지출 | 날짜 범위 윈도우(`RANGE BETWEEN 90 DAY PRECEDING …`), `quantile_cont`를 윈도우로 |
| `07_budget` | 분류별 예산 대비 지출 | `LEFT JOIN`(0원 분류 유지), 상태 분류 `CASE` |
| `08_month_to_date` | 이번 달 1일~오늘 vs 지난달 같은 기간 | 날짜 계산, `GROUPING SETS`로 합계 줄 |

## 기술을 고른 이유

- **DuckDB**: 서버 없이 파이썬 안에서 도는 *분석용* SQL 데이터베이스. CSV를 바로 읽고, 윈도우 함수·`median`·`quantile_cont`를 쓸 수 있다. 무료.
  - SQLite: 가볍지만 거래 기록용(OLTP)이라 통계·윈도우 함수가 부족하다.
  - PostgreSQL(서버): 여러 사용자 서비스엔 맞지만 서버·권한·비용·Firebase와의 이중 저장 문제가 생긴다 → 사용자가 늘고 동의를 받은 뒤 검토.
- **SQL을 '정답'으로, 앱은 같은 규칙을 자바스크립트로**: 거래 기록이 각자 휴대폰에만 있어 서버에서 SQL을 돌릴 수 없다. 대신 같은 합성 데이터로 두 결과가 같은지 `check-metrics.mjs`로 자동 검증한다.
- **로버스트 통계(중앙값·백분위수)**: 큰 지출 한두 번에 '평소' 기준이 끌려 올라가지 않게.

## 1단계 결과 요약 (합성 데이터)

- **반복 결제**: 고정으로 등록하지 않은 구독(OTT·음악·헬스장)을 잡고, 매일 가는 카페는 빠졌다.
- **이상 지출 규칙 비교** (일부러 넣은 5건이 정답):

  | 규칙 | 잡은 수 | 맞힘 | 정밀도 | 재현율 |
  | --- | --- | --- | --- | --- |
  | A 중앙값 + 3.5×MAD | 140 | 4 | 0.03 | 0.8 |
  | **B P95 × 2 (채택)** | 7 | 4 | 0.57 | 0.8 |

  A는 식비 안에 섞인 두 봉우리 분포(구내식당 vs 배달·식당) 때문에 평범한 배달까지 잡았다. B는 지난 기록이 적은 분류(절약형의 쇼핑)를 놓친다(콜드 스타트).

## 한계

- 합성 데이터는 규칙을 만든 사람이 만든 것이라, 규칙이 데이터에 맞춰질 위험이 있다. 실제 데이터로 다시 확인해야 한다.
- 정밀도·재현율은 *규칙이 의도대로 동작하는지* 보는 용도이고, 실제 성능 주장이 아니다.
- 분류는 사용자가 고른 값이라 틀릴 수 있다.
- 반복 결제는 180일, 이상 지출은 같은 분류 90일 안 3번 이상의 기록이 있어야 의미가 있다.

## 앱과의 연결 (1단계)

```
가계부(휴대폰 localStorage · Firebase) ──읽기만──▶ 앱 계산(monthToDate · recurringPayments · unusualSpends)
        │                                                    ▲ 같은 규칙
        └─ 동의 후 CSV 내보내기 ─▶ DuckDB SQL(analysis/sql) ──┘ check-metrics.mjs로 결과 비교
```

새 기능은 거래를 **읽기만** 하고 저장·삭제하지 않는다.

## 다음 단계

- 2단계: 이동평균·진행 속도 기준 모델 → XGBoost, 시간 순서 검증과 MAE 비교, 앱에는 기준 모델의 '월말 예상'
- 3단계: 계산된 집계값만 루미(AI)에게 보내 설명, AI 답의 숫자 검사
