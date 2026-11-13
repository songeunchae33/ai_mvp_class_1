"""EDA 노트북(analysis/notebooks/01_eda.ipynb)을 만들고 실행해서 결과(표·그림)까지 저장한다.

실행: python analysis/python/build_eda_notebook.py
노트북을 직접 고쳐도 되지만, 이 스크립트로 다시 만들면 항상 같은 순서·같은 결과가 나온다(재현성).
"""
from pathlib import Path

import nbformat as nbf
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "notebooks" / "01_eda.ipynb"

md = nbf.v4.new_markdown_cell
code = nbf.v4.new_code_cell

cells = [
    md("""# 소비 인텔리전스 1단계 · 탐색적 데이터 분석(EDA)

**목적**: 가계부 거래 데이터를 SQL(DuckDB)로 집계하고, 소비 패턴 · 반복 결제 · 이상 지출 규칙을 확인한다.

> ⚠️ 이 노트북의 데이터는 **합성 데이터**(`make_synthetic.py`로 만든 가상의 세 사람, 13개월)다.
> 숫자는 규칙이 제대로 동작하는지 확인하려고 지어낸 값이며 **실제 사람들의 소비 통계가 아니다**.
> 실제 가계부로 돌리려면 앱에서 내보낸 CSV로 `run_sql.py --tx 파일.csv`를 실행한다."""),
    code("""import sys, duckdb, pandas as pd, matplotlib.pyplot as plt
from pathlib import Path
ROOT = Path.cwd().parent if Path.cwd().name == "notebooks" else Path("analysis")
sys.path.insert(0, str(ROOT / "python"))
from run_sql import connect
plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
D = ROOT / "data"
as_of = (D / "as_of.csv").read_text(encoding="utf-8").splitlines()[1]
con = connect(D / "synthetic_tx.csv", D / "synthetic_budgets.csv", D / "synthetic_fixed.csv", as_of)
q = lambda name: con.execute((ROOT / "sql" / f"{name}.sql").read_text(encoding="utf-8")).df()
LABEL = {"u_student": "대학생", "u_junior": "사회초년생", "u_saver": "절약형"}
print("기준일", as_of)"""),
    md("## 1. 데이터 한눈에 보기\n거래가 어떤 종류(지출·수입·환불·내부이체)로 나뉘는지, 사람마다 몇 건인지 본다. 분류 기준은 `00_schema.sql`의 `tx_class` 보기에 한 번만 정의했다."),
    code("""con.execute(\"\"\"
SELECT user_id, kind, count(*) AS n, sum(amount) AS amount, min(date) AS first, max(date) AS last
FROM tx_class GROUP BY ALL ORDER BY user_id, kind\"\"\").df()"""),
    md("## 2. 월별 소비 추세 (`01_monthly_summary.sql`)\n'쓴 돈' = 지출 − 환불(앱과 같은 기준). 마지막 달은 기준일까지라 덜 찼다."),
    code("""m = q("01_monthly_summary")
fig, ax = plt.subplots(figsize=(9, 3.6))
for u, g in m.groupby("user_id"):
    ax.plot(g["month"], g["spend"] / 1e4, marker="o", label=LABEL[u])
ax.set_ylabel("쓴 돈(만원)"); ax.set_title("월별 쓴 돈 (마지막 달은 기준일까지)"); ax.legend(); ax.grid(alpha=.3)
plt.show()
m.tail(6)"""),
    md("## 3. 분류별 추세와 증감률 (`02_category_trend.sql`)\n대학생의 카페·간식 지출이 9월부터 늘어나도록 합성 데이터를 만들었다. 3개월 이동평균(ma3)과 지난달 대비 증감률로 그 변화가 보이는지 확인한다."),
    code("""c = q("02_category_trend")
s = c[(c.user_id == "u_student") & (c.cat == "카페·간식")]
fig, ax = plt.subplots(figsize=(9, 3.2))
ax.bar(s["month"], s["spend"] / 1e4, width=20, alpha=.5, label="월 지출")
ax.plot(s["month"], s["ma3"] / 1e4, color="C3", marker="o", label="3개월 이동평균")
ax.set_ylabel("만원"); ax.set_title("대학생 · 카페·간식"); ax.legend(); ax.grid(alpha=.3)
plt.show()
s[["month", "spend", "share_pct", "change_pct", "ma3"]].tail(6)"""),
    md("## 4. 요일별 소비 성향 (`03_weekday.sql`)\n지출이 없는 날도 0원으로 세야 평균이 부풀지 않아서, 날짜 달력을 만들어 LEFT JOIN 했다(최근 12주, 고정비 제외)."),
    code("""w = q("03_weekday")
p = w.pivot(index="weekday_name", columns="user_id", values="avg_daily_spend").reindex(list("월화수목금토일"))
p.rename(columns=LABEL).div(1e4).plot.bar(figsize=(9, 3.2), rot=0, title="요일별 하루 평균 변동비(만원)").grid(alpha=.3)
plt.show()"""),
    md("## 5. 고정비 · 변동비 (`04_fixed_variable.sql`)"),
    code("""f = q("04_fixed_variable"); f[f.month == f.month.max()]"""),
    md("## 6. 반복 결제 탐지 (`05_recurring.sql`)\n고정으로 등록하지 않은 구독(OTT·음악·헬스장)도 잡히는지, 매일 가는 카페는 빠지는지 본다."),
    code("""q("05_recurring")"""),
    md("""## 7. 이상 지출 규칙 비교 (`06_anomaly.sql`)

합성 데이터에 **일부러 넣은 이상 지출 5건**(`anomalies_truth.csv`)을 정답으로 두고 두 규칙을 비교한다.
- **규칙 A (처음 안)**: 같은 분류 최근 90일 중앙값 + 3.5 × 1.4826 × MAD, 지난 기록 5번 이상
- **규칙 B (채택)**: 같은 분류 최근 90일 P95 × 2, 3만원 이상, 지난 기록 3번 이상

정밀도(precision) = 잡은 것 중 정답 비율, 재현율(recall) = 정답 중 잡은 비율."""),
    code("""truth = pd.read_csv(D / "anomalies_truth.csv")
rule_a = con.execute(\"\"\"
WITH h AS (SELECT s.*, count(*) OVER w n, median(amount) OVER w med, mad(amount) OVER w mad
           FROM tx_class s WHERE kind = 'spend'
           WINDOW w AS (PARTITION BY user_id, cat ORDER BY date RANGE BETWEEN INTERVAL 90 DAY PRECEDING AND INTERVAL 1 DAY PRECEDING))
SELECT id FROM h WHERE n >= 5 AND amount >= 10000
  AND CASE WHEN mad > 0 THEN amount > med + 3.5 * 1.4826 * mad ELSE amount > med * 3 END\"\"\").df()
rule_b = q("06_anomaly")
def score(name, ids):
    hit = len(set(ids) & set(truth.id))
    return {"규칙": name, "잡은 수": len(ids), "맞힘": hit, "정밀도": round(hit / max(len(ids), 1), 2), "재현율": round(hit / len(truth), 2)}
pd.DataFrame([score("A 중앙값+MAD", rule_a.id), score("B P95×2 (채택)", rule_b.id)])"""),
    code("""rule_b.assign(정답=rule_b.id.isin(truth.id))"""),
    md("""**해석**
- 규칙 A는 식비 안에 '구내식당 1만원'과 '배달·식당 2~5만원'이 섞인 **두 봉우리 분포** 때문에 평범한 배달까지 잡아 정밀도가 낮다.
- 규칙 B는 평소의 '윗부분'(P95)과 비교해 이 섞임에 덜 흔들린다. 다만 지난 기록이 적은 분류(절약형의 쇼핑)는 기준을 세울 수 없어 놓친다(**콜드 스타트** 한계).
- 정답 밖에서 잡힌 '식당 5만원'은 실제로도 평소보다 큰 지출이라, 사용자에게는 '평소보다 큰 지출' 정도로 부드럽게 알린다.
- 정답표가 합성 데이터에서 온 것이라 이 숫자는 **규칙이 의도대로 동작하는지 확인하는 용도**이고, 실제 성능 주장이 아니다."""),
    md("## 8. 예산 대비 (`07_budget.sql`) · 이번 달 현황 (`08_month_to_date.sql`)"),
    code("""q("07_budget")"""),
    code("""q("08_month_to_date")"""),
    md("""## 9. 한계
- 합성 데이터는 규칙을 만든 사람이 만든 데이터라, 규칙이 데이터에 맞춰질 위험이 있다 → 실제 내보낸 데이터로 다시 확인해야 한다.
- 분류는 사용자가 고른 값이라 틀릴 수 있다(예: 월급을 다른 분류로 기록). 앱에서는 '들어온 돈'을 고르면 '급여·수입'이 자동 선택되게 해 두었다.
- 반복 결제는 180일, 이상 지출은 90일 기록이 있어야 의미가 있다. 기록이 부족하면 앱은 숫자 대신 안내 문구를 보여 준다."""),
]

nb = nbf.v4.new_notebook(cells=cells, metadata={"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}})
OUT.parent.mkdir(parents=True, exist_ok=True)
NotebookClient(nb, timeout=300, kernel_name="python3", resources={"metadata": {"path": str(OUT.parent)}}).execute()
nbf.write(nb, OUT)
print("저장:", OUT)
