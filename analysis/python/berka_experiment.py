"""Berka(실제 거래를 익명화한 체코 은행 데이터)로 2단계 예측 비교를 다시 해 본다.

합성 데이터(사람 3명)에서는 '머신러닝이 기준 모델을 못 이긴다'는 결론이 났지만, 사람이 3명뿐이라 한계가 컸다.
여기서는 기록이 충분한 계좌 400개로 같은 코드(forecast.py)를 돌린다.

- 사람: 1995-10-01 이전부터 기록이 있는 계좌 중 무작위 400개 (seed 0)
- 학습: 1996-01 ~ 1997-12 · 검증: 1998-01 ~ 1998-12 (달 단위 시간 순서)
- 이번 달 몇 일까지 봤나(c): 5 · 10 · 15 · 20 · 25일
- 처음 보는 사람 검증: 사람을 5묶음으로 나눠, 4묶음의 학습 기간으로 배우고 남은 1묶음의 검증 기간으로 평가(GroupKFold)

입력 : analysis/private/berka/berka_tx.csv · berka_fixed.csv (berka_adapter.py로 만든 것)
출력 : analysis/private/berka/results/forecast_*.csv  (git이 무시하는 폴더)
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd

import forecast as F

ROOT = Path(__file__).resolve().parents[1]
B = ROOT / "private" / "berka"
OUT = B / "results"
N_USERS, SEED = 400, 0
CUTOFFS = [5, 10, 15, 20, 25]


def load():
    tx = pd.read_csv(B / "berka_tx.csv", dtype={"fixed_id": str})
    tx["date"] = pd.to_datetime(tx["date"])
    tx["kind"] = np.select([tx.cat.eq("내부이체"), tx.dir.eq("out"), tx.cat.eq("급여·수입")], ["transfer", "spend", "income"], "refund")
    tx["is_fixed"] = tx.src.eq("고정") | tx.fixed_id.notna()
    fixed = pd.read_csv(B / "berka_fixed.csv")
    return tx, fixed, pd.Timestamp("1998-12-31")


def new_user_eval(df: pd.DataFrame) -> pd.DataFrame:
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from xgboost import XGBRegressor
    d = df.dropna(subset=F.FEATURES).reset_index(drop=True)
    rows = []
    for k, (tr_i, te_i) in enumerate(GroupKFold(n_splits=5).split(d, groups=d.user_id)):
        tr = d.iloc[tr_i]; tr = tr[tr.month <= F.TRAIN_END]
        te = d.iloc[te_i]; te = te[te.month.isin(F.TEST_MONTHS)]
        ridge = make_pipeline(StandardScaler(), Ridge(alpha=1.0)).fit(tr[F.FEATURES], tr.target)
        xgb = XGBRegressor(n_estimators=300, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8,
                           random_state=0, n_jobs=1).fit(tr[F.FEATURES], tr.target)
        for name, pred in [("Ridge", ridge.predict(te[F.FEATURES])), ("XGBoost", xgb.predict(te[F.FEATURES])),
                           ("B3_최근28일속도", te["B3_최근28일속도"]), ("B4_혼합", te["B4_혼합"])]:
            rows.append({"묶음": k + 1, "모델": name, "MAE(원)": float(np.abs(np.asarray(pred) - te.target.to_numpy()).mean())})
    r = pd.DataFrame(rows)
    return r.groupby("모델")["MAE(원)"].agg(평균="mean", 가장작은묶음="min", 가장큰묶음="max").round().reset_index().sort_values("평균")


def bootstrap_gap(test: pd.DataFrame, n: int = 2000) -> pd.DataFrame:
    """XGBoost가 B4보다 정말 나은가: 사람 단위로 다시 뽑기(부트스트랩)를 2000번 해서 'B4 MAE − XGBoost MAE'의 95% 범위를 본다.
    범위가 모두 0보다 크면 우연이 아니라고 볼 수 있다. 사람 단위로 뽑는 이유: 같은 사람의 줄들은 서로 닮아서."""
    rng = np.random.default_rng(0)
    rows = []
    for g, sub in [("전체", test)] + [(str(k), x) for k, x in test.groupby("구간", observed=True)]:
        per = sub.assign(gap=(sub["B4_혼합"] - sub.target).abs() - (sub["XGBoost"] - sub.target).abs()).groupby("user_id").gap.agg(["sum", "count"])
        s_, c_ = per["sum"].to_numpy(), per["count"].to_numpy()
        draws = [s_[i].sum() / c_[i].sum() for i in (rng.integers(0, len(per), len(per)) for _ in range(n))]
        lo, hi = np.percentile(draws, [2.5, 97.5])
        rows.append({"구간": g, "B4−XGBoost MAE 차이(원)": round(s_.sum() / c_.sum()), "95% 범위 아래": round(lo), "95% 범위 위": round(hi),
                     "판단": "XGBoost가 나음" if lo > 0 else "B4가 나음" if hi < 0 else "차이 확실하지 않음"})
    return pd.DataFrame(rows)


def main():
    t0 = time.time()
    tx, fixed, as_of = load()
    first = tx.groupby("user_id").date.min()
    pool = sorted(first[first <= "1995-10-01"].index)
    users = list(np.random.default_rng(SEED).choice(pool, size=min(N_USERS, len(pool)), replace=False))
    F.TRAIN_END = "1997-12"
    F.TEST_MONTHS = [f"1998-{m:02d}" for m in range(1, 13)]

    cache = B / "berka_dataset.csv"     # 특징 계산이 오래 걸려서 한 번 만든 표를 다시 쓴다(같은 사람·같은 설정일 때)
    if cache.exists():
        df = pd.read_csv(cache)
    else:
        df = F.build_dataset(tx[tx.user_id.isin(users)], fixed, as_of, cutoffs=CUTOFFS, users=users)
        df = df[df.month >= "1996-01"]
        df.to_csv(cache, index=False, encoding="utf-8")
    scores, imp, test, info = F.evaluate(df)
    nu = new_user_eval(df)
    boot = bootstrap_gap(test)
    test[["user_id", "month", "c", "target", "B4_혼합", "Ridge", "XGBoost"]].to_csv(OUT / "forecast_test_predictions.csv", index=False, encoding="utf-8")

    OUT.mkdir(parents=True, exist_ok=True)
    scores.to_csv(OUT / "forecast_eval.csv", index=False, encoding="utf-8")
    imp.to_csv(OUT / "forecast_feature_importance.csv", index=False, encoding="utf-8")
    nu.to_csv(OUT / "forecast_eval_new_user.csv", index=False, encoding="utf-8")
    med = df.groupby(["user_id", "month"]).target.first().median()
    print(f"계좌 {len(users)}개 (후보 {len(pool)}개) · 줄 {len(df):,} · 한 달 쓴 돈 중앙값 {med:,.0f}원")
    print("학습/검증", {k: (v if not isinstance(v, list) else f"{v[0]}~{v[-1]} ({len(v)}달)") for k, v in info.items()})
    print(scores.to_string(index=False))
    print("\n처음 보는 사람 검증 (5묶음 GroupKFold)")
    print(nu.to_string(index=False))
    boot.to_csv(OUT / "forecast_bootstrap_gap.csv", index=False, encoding="utf-8")
    print("\nXGBoost vs B4 차이 (사람 단위 부트스트랩 2000번)")
    print(boot.to_string(index=False))
    print("\n변수 중요도")
    print(imp.head(8).to_string(index=False))


if __name__ == "__main__":
    main()
