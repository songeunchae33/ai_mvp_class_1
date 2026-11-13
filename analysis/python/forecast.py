"""소비 인텔리전스 2단계: 이번 달 최종 지출 예측 · 분류별 예측 · 예산 초과 가능성 · 변수 중요도.

문제 정의
    '이번 달 c일까지의 가계부'만 보고 '이번 달 전체에 쓸 돈(쓴 돈 = 지출 − 환불)'을 맞힌다.
    학습·평가용 예: 사람 × (지난 기록이 2달 이상 있는) 다 끝난 달 × c = 1 … 말일−1  → 한 줄씩

미래 정보 누수 막기
    - 모든 특징은 c일(포함)까지의 거래만으로 만든다 (지난달 합계·최근 7/28/56일 속도 등)
    - 학습/검증은 '달' 기준 시간 순서로 나눈다: 2026-06까지 학습, 2026-07 ~ 2026-10 검증
      (같은 달의 다른 c를 학습과 검증에 나눠 넣지 않는다 → 그 달의 결과를 미리 보는 셈이 되므로)

모델
    B1 진행 속도  : 지금까지 변동비 ÷ 지난 날 × 남은 날 + 남은 고정비
    B2 최근 3달 평균: 지난 3달 '쓴 돈'의 평균 (이번 달 기록을 안 봄)
    B3 최근 28일 속도: 지금까지 쓴 돈 + 최근 28일 하루 평균 변동비 × 남은 날 + 남은 고정비   ← 앱에 쓰는 기준 모델
    Ridge 회귀, XGBoost : 아래 특징으로 '월말 쓴 돈'을 직접 학습

지표: MAE(평균 몇 원 틀렸나). 지출이 0에 가까운 달이 없어 MAPE도 보조로 함께 본다.

실행: python analysis/python/forecast.py   → analysis/results/forecast_*.csv
※ 합성 데이터 결과다. 실제 성능 주장이 아니다.
"""
from __future__ import annotations

import calendar
import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA, RES = ROOT / "data", ROOT / "results"
TRAIN_END = "2026-06"            # 이 달까지 학습
TEST_MONTHS = ["2026-07", "2026-08", "2026-09", "2026-10"]
WINDOW = 28                      # B3·앱이 쓰는 '최근 속도' 기간(일)
MIN_HISTORY_DAYS = 28            # 이보다 기록이 짧으면 앱은 예측을 보여주지 않는다

FEATURES = ["c", "days_in_month", "remaining", "to_date", "var_to_date", "fixed_remaining", "fixed_month",
            "rate7", "rate28", "rate56", "prev_total", "prev3_avg", "weekend_left", "weekend_rate28", "weekday_rate28"]


# ── 데이터 ────────────────────────────────────────────────────────────────
def load():
    tx = pd.read_csv(DATA / "synthetic_tx.csv", dtype={"fixed_id": str})
    tx["date"] = pd.to_datetime(tx["date"])
    tx["kind"] = np.select(
        [tx.cat.eq("내부이체"), tx.dir.eq("out"), tx.cat.eq("급여·수입")], ["transfer", "spend", "income"], "refund")
    tx["is_fixed"] = tx.src.eq("고정") | tx.fixed_id.notna()
    fixed = pd.read_csv(DATA / "synthetic_fixed.csv")
    budgets = pd.read_csv(DATA / "synthetic_budgets.csv")
    as_of = pd.Timestamp((DATA / "as_of.csv").read_text(encoding="utf-8").splitlines()[1])
    return tx, fixed, budgets, as_of


def daily_table(tx: pd.DataFrame, user: str, end: pd.Timestamp) -> pd.DataFrame:
    """사람 한 명의 하루별 지출(0원인 날 포함): spend(총, 환불 차감 전) · var(변동비) · refund · 분류별 변동비."""
    t = tx[tx.user_id.eq(user)]
    days = pd.date_range(t.date.min(), end, freq="D")
    s = t[t.kind.eq("spend")]
    d = pd.DataFrame(index=days)
    d["out"] = s.groupby("date").amount.sum()
    d["var"] = s[~s.is_fixed].groupby("date").amount.sum()
    d["refund"] = t[t.kind.eq("refund")].groupby("date").amount.sum()
    return d.fillna(0)


def fixed_remaining(fixed: pd.DataFrame, user: str, year: int, month: int, c: int, cats=None) -> int:
    """이번 달 c일 뒤에 나갈 고정 지출(내부이체 제외). 앱의 ledger.fixed와 같은 규칙: 말일보다 큰 날은 말일로."""
    last = calendar.monthrange(year, month)[1]
    f = fixed[fixed.user_id.eq(user) & fixed.dir.eq("out") & fixed.cat.ne("내부이체")]
    if cats is not None:
        f = f[f.cat.isin(cats)]
    return int(f[f.day.clip(upper=last) > c].amount.sum())


def month_total(d: pd.DataFrame, start, end) -> float:
    w = d.loc[start:end]
    return max(w.out.sum() - w.refund.sum(), 0)


# ── 한 시점(c일)의 특징 ───────────────────────────────────────────────────
def features_at(d: pd.DataFrame, fixed: pd.DataFrame, user: str, day: pd.Timestamp) -> dict:
    y, m, c = day.year, day.month, day.day
    dim = calendar.monthrange(y, m)[1]
    mstart = day.replace(day=1)
    upto = d.loc[mstart:day]
    rate = lambda n: d.loc[day - pd.Timedelta(days=n - 1):day, "var"].sum() / n
    last28 = d.loc[day - pd.Timedelta(days=27):day]
    wk = last28.index.dayofweek >= 5
    # 지난 1~3달의 '쓴 돈' (이번 달은 절대 넣지 않는다).
    # ⚠️ 처음엔 날짜 오프셋(prev_end - MonthBegin(k))으로 계산했는데, k=0이 '이번 달 1일'로 넘어가 이번 달 정답이
    #    특징으로 새어 들어갔다(검증 MAE가 비현실적으로 작아 발견). 달 번호(Period)로 명시적으로 계산해 고쳤다.
    cur_p = pd.Period(mstart, freq="M")
    # 기록이 그 달 1일부터 다 있는 달만 센다(첫 달이 중간부터 시작하면 적게 잡히므로). 앱과 같은 규칙
    prev_tot = [month_total(d, (cur_p - k).start_time, (cur_p - k).end_time.normalize())
                for k in (1, 2, 3) if (cur_p - k).start_time >= d.index[0]]
    assert all(p < cur_p for p in [cur_p - 1]), "지난달 계산이 이번 달을 가리키면 안 된다"
    left = pd.date_range(day + pd.Timedelta(days=1), mstart + pd.offsets.MonthEnd(0), freq="D")
    f_month = fixed[fixed.user_id.eq(user) & fixed.dir.eq("out") & fixed.cat.ne("내부이체")].amount.sum()
    return {
        "c": c, "days_in_month": dim, "remaining": dim - c,
        "to_date": max(upto.out.sum() - upto.refund.sum(), 0),
        "var_to_date": upto["var"].sum(),
        "fixed_remaining": fixed_remaining(fixed, user, y, m, c),
        "fixed_month": f_month,
        "rate7": rate(7), "rate28": rate(28), "rate56": rate(56),
        "prev_total": prev_tot[0] if prev_tot else np.nan,
        "prev3_avg": np.mean(prev_tot) if prev_tot else np.nan,
        "n_prev_months": len(prev_tot),
        "weekend_left": int((left.dayofweek >= 5).sum()),
        "weekend_rate28": last28[wk]["var"].mean() if wk.any() else 0,
        "weekday_rate28": last28[~wk]["var"].mean() if (~wk).any() else 0,
        "history_days": (day - d.index[0]).days + 1,
    }


def baselines(f: dict) -> dict:
    return {
        "B1_진행속도": f["to_date"] + (f["var_to_date"] / f["c"]) * f["remaining"] + f["fixed_remaining"],
        "B2_최근3달평균": f["prev3_avg"],
        "B3_최근28일속도": f["to_date"] + f["rate28"] * f["remaining"] + f["fixed_remaining"],
        # B4: 달 초반엔 '최근 3달 평균'을, 날이 갈수록 '최근 28일 속도'를 더 믿는다 (지난 날 비율로 섞기). 3달 기록이 없으면 B3
        "B4_혼합": (f["c"] / f["days_in_month"]) * (f["to_date"] + f["rate28"] * f["remaining"] + f["fixed_remaining"])
                   + (1 - f["c"] / f["days_in_month"]) * f["prev3_avg"]
                   if not np.isnan(f["prev3_avg"]) else f["to_date"] + f["rate28"] * f["remaining"] + f["fixed_remaining"],
    }


# ── 학습·평가용 표 ────────────────────────────────────────────────────────
def build_dataset(tx, fixed, as_of) -> pd.DataFrame:
    rows = []
    for user in tx.user_id.unique():
        d = daily_table(tx, user, as_of)
        for mstart in pd.date_range(d.index[0], as_of, freq="MS"):
            mend = mstart + pd.offsets.MonthEnd(0)
            if mend > as_of or (mstart - d.index[0]).days < 56:       # 다 끝난 달 · 지난 기록 2달 이상
                continue
            target = month_total(d, mstart, mend)
            for c in range(1, mend.day):
                f = features_at(d, fixed, user, mstart + pd.Timedelta(days=c - 1))
                rows.append({"user_id": user, "month": mstart.strftime("%Y-%m"), "target": target, **f, **baselines(f)})
    return pd.DataFrame(rows)


def evaluate(df: pd.DataFrame):
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.inspection import permutation_importance
    from xgboost import XGBRegressor

    train = df[df.month <= TRAIN_END].dropna(subset=FEATURES)
    test = df[df.month.isin(TEST_MONTHS)].dropna(subset=FEATURES).copy()
    X, y = train[FEATURES], train.target
    ridge = make_pipeline(StandardScaler(), Ridge(alpha=1.0)).fit(X, y)
    xgb = XGBRegressor(n_estimators=300, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8,
                       random_state=0, n_jobs=1).fit(X, y)
    test["Ridge"] = ridge.predict(test[FEATURES])
    test["XGBoost"] = xgb.predict(test[FEATURES])

    models = ["B1_진행속도", "B2_최근3달평균", "B3_최근28일속도", "B4_혼합", "Ridge", "XGBoost"]
    test["구간"] = pd.cut(test.c, [0, 10, 20, 31], labels=["1~10일", "11~20일", "21일~"])
    rows = []
    for mname in models:
        err = (test[mname] - test.target).abs()
        r = {"모델": mname, "MAE(원)": round(err.mean()), "MAPE(%)": round(100 * (err / test.target).mean(), 1)}
        for g, sub in test.groupby("구간", observed=True):
            r[f"MAE {g}"] = round((sub[mname] - sub.target).abs().mean())
        rows.append(r)
    scores = pd.DataFrame(rows)

    gain = pd.Series(xgb.get_booster().get_score(importance_type="gain")).reindex(FEATURES).fillna(0)
    perm = permutation_importance(xgb, test[FEATURES], test.target, scoring="neg_mean_absolute_error",
                                  n_repeats=10, random_state=0)
    imp = pd.DataFrame({"feature": FEATURES, "xgb_gain_share": (gain / gain.sum()).round(3).values,
                        "permutation_mae_increase": perm.importances_mean.round(0)}).sort_values(
        "permutation_mae_increase", ascending=False)
    return scores, imp, test, {"train_rows": len(train), "test_rows": len(test),
                               "train_months": sorted(train.month.unique()), "test_months": sorted(test.month.unique())}


# ── 분류별 예측 · 예산 초과 가능성 (앱과 같은 규칙) ─────────────────────────
def category_forecast(tx, fixed, user, day: pd.Timestamp) -> pd.DataFrame:
    """분류마다: 이번 달 지금까지 + 그 분류 최근 28일 하루 평균 변동비 × 남은 날 + 그 분류 남은 고정비."""
    t = tx[tx.user_id.eq(user) & tx.kind.eq("spend")]
    mstart = day.replace(day=1)
    dim = calendar.monthrange(day.year, day.month)[1]
    rem = dim - day.day
    cur = t[(t.date >= mstart) & (t.date <= day)].groupby("cat").amount.sum()
    win = t[(t.date > day - pd.Timedelta(days=WINDOW)) & (t.date <= day) & ~t.is_fixed].groupby("cat").amount.sum() / WINDOW
    cats = sorted(set(cur.index) | set(win.index))
    rows = []
    for cat in cats:
        fr = fixed_remaining(fixed, user, day.year, day.month, day.day, [cat])
        rows.append({"user_id": user, "cat": cat, "to_date": int(cur.get(cat, 0)),
                     "forecast": float(cur.get(cat, 0) + win.get(cat, 0) * rem + fr)})
    return pd.DataFrame(rows)


def overrun_probability(tx, fixed, budgets, user, day: pd.Timestamp) -> dict | None:
    """예산이 있는 분류들의 합계가 예산 합계를 넘을 가능성.
    최근 84일의 '남은 날 수만큼 이어진 기간'들의 변동비 합을 하나씩 대입해, 넘는 경우의 비율을 센다(같은 입력이면 늘 같은 값)."""
    b = budgets[budgets.user_id.eq(user)]
    if b.empty:
        return None
    cats = list(b.cat)
    total_budget = int(b.budget_man.sum() * 10000)
    t = tx[tx.user_id.eq(user) & tx.kind.eq("spend") & tx.cat.isin(cats)]
    mstart = day.replace(day=1)
    rem = calendar.monthrange(day.year, day.month)[1] - day.day
    to_date = int(t[(t.date >= mstart) & (t.date <= day)].amount.sum())
    fr = fixed_remaining(fixed, user, day.year, day.month, day.day, cats)
    days = pd.date_range(day - pd.Timedelta(days=83), day, freq="D")
    v = t[~t.is_fixed].groupby("date").amount.sum().reindex(days, fill_value=0).to_numpy()
    if rem == 0:
        sums = np.array([0])
    else:
        sums = np.array([v[i:i + rem].sum() for i in range(0, len(v) - rem + 1)])
    p = float((to_date + sums + fr > total_budget).mean())
    return {"user_id": user, "budget": total_budget, "to_date": to_date, "fixed_remaining": fr,
            "remaining_days": rem, "n_windows": len(sums), "prob_over": round(p, 4)}


def eval_overrun(tx, fixed, budgets, as_of) -> pd.DataFrame:
    """검증 달(15일 시점)마다: 예측한 초과 가능성 vs 실제 초과 여부 → Brier 점수(작을수록 좋음)."""
    rows = []
    for user in budgets.user_id.unique():
        cats = list(budgets[budgets.user_id.eq(user)].cat)
        b = int(budgets[budgets.user_id.eq(user)].budget_man.sum() * 10000)
        t = tx[tx.user_id.eq(user) & tx.kind.eq("spend") & tx.cat.isin(cats)]
        for m in TEST_MONTHS:
            day = pd.Timestamp(f"{m}-15")
            pr = overrun_probability(tx, fixed, budgets, user, day)
            actual = int(t[(t.date >= day.replace(day=1)) & (t.date <= day + pd.offsets.MonthEnd(0))].amount.sum())
            rows.append({"user_id": user, "month": m, "prob_over": pr["prob_over"], "actual_over": int(actual > b),
                         "budget": b, "actual": actual})
    df = pd.DataFrame(rows)
    df.attrs["brier"] = float(((df.prob_over - df.actual_over) ** 2).mean())
    return df


# 사람마다 다른 고정비 합계(fixed_month)·지난달 합계는 '누구인지'를 알려 주는 신호라, 같은 사람으로 학습·검증하면
# 모델이 소비 흐름이 아니라 사람을 외운다. 처음 보는 사람에게도 통하는지 보려면 사람을 빼고 학습해 본다.
NO_ID = [f for f in FEATURES if f not in ("fixed_month",)]


def evaluate_new_user(df: pd.DataFrame) -> pd.DataFrame:
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from xgboost import XGBRegressor
    rows = []
    for held in sorted(df.user_id.unique()):
        tr = df[(df.user_id != held) & (df.month <= TRAIN_END)].dropna(subset=FEATURES)
        te = df[(df.user_id == held) & df.month.isin(TEST_MONTHS)].dropna(subset=FEATURES).copy()
        for name, feats in [("전체 특징", FEATURES), ("고정비 합계 뺌", NO_ID)]:
            ridge = make_pipeline(StandardScaler(), Ridge(alpha=1.0)).fit(tr[feats], tr.target)
            xgb = XGBRegressor(n_estimators=300, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8,
                               random_state=0, n_jobs=1).fit(tr[feats], tr.target)
            for mname, pred in [("Ridge", ridge.predict(te[feats])), ("XGBoost", xgb.predict(te[feats]))]:
                rows.append({"검증한 사람": held, "특징": name, "모델": mname, "MAE(원)": round(np.abs(pred - te.target).mean())})
        for b in ["B3_최근28일속도", "B4_혼합"]:
            rows.append({"검증한 사람": held, "특징": "-", "모델": b, "MAE(원)": round((te[b] - te.target).abs().mean())})
    out = pd.DataFrame(rows)
    return out.pivot_table(index=["모델", "특징"], columns="검증한 사람", values="MAE(원)").assign(
        평균=lambda x: x.mean(axis=1).round()).reset_index()


def main():
    tx, fixed, budgets, as_of = load()
    RES.mkdir(exist_ok=True)
    df = build_dataset(tx, fixed, as_of)
    scores, imp, test, info = evaluate(df)
    scores.to_csv(RES / "forecast_eval.csv", index=False, encoding="utf-8")
    nu = evaluate_new_user(df)
    nu.to_csv(RES / "forecast_eval_new_user.csv", index=False, encoding="utf-8")
    imp.to_csv(RES / "forecast_feature_importance.csv", index=False, encoding="utf-8")
    ov = eval_overrun(tx, fixed, budgets, as_of)
    ov.to_csv(RES / "forecast_overrun_eval.csv", index=False, encoding="utf-8")

    # 기준일 시점의 앱용 결과 (앱 계산과 비교하는 기준값)
    now, cats, probs = [], [], []
    for user in tx.user_id.unique():
        d = daily_table(tx, user, as_of)
        f = features_at(d, fixed, user, as_of)
        now.append({"user_id": user, "as_of": as_of.date().isoformat(), "to_date": f["to_date"], "rate28": f["rate28"],
                    "remaining": f["remaining"], "fixed_remaining": f["fixed_remaining"],
                    "prev3_avg": f["prev3_avg"], "n_prev_months": f["n_prev_months"],
                    "forecast": baselines(f)["B4_혼합"], "history_days": f["history_days"]})
        cats.append(category_forecast(tx, fixed, user, as_of))
        pr = overrun_probability(tx, fixed, budgets, user, as_of)
        if pr:
            probs.append(pr)
    pd.DataFrame(now).to_csv(RES / "forecast_now.csv", index=False, encoding="utf-8")
    pd.concat(cats).to_csv(RES / "forecast_now_categories.csv", index=False, encoding="utf-8")
    pd.DataFrame(probs).to_csv(RES / "forecast_now_overrun.csv", index=False, encoding="utf-8")

    print("학습/검증", info)
    print(scores.to_string(index=False))
    print(imp.to_string(index=False))
    print("\n새 사람 검증 (두 사람으로 학습 → 남은 한 사람)")
    print(nu.to_string(index=False))
    print("예산 초과 가능성 Brier 점수", round(ov.attrs["brier"], 4))


if __name__ == "__main__":
    main()
