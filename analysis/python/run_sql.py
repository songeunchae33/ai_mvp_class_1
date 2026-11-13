"""SQL 분석 실행: 합성(또는 내보낸) 가계부 CSV를 DuckDB에 넣고 analysis/sql/의 쿼리를 차례로 돌린다.

실행:
    python analysis/python/run_sql.py                       # 합성 데이터(analysis/data/synthetic_*.csv)
    python analysis/python/run_sql.py --tx 내보낸파일.csv --as-of 2026-11-12   # 앱에서 내보낸 내 가계부

결과는 analysis/results/쿼리이름.csv 로 저장된다.

DuckDB를 고른 이유: 서버 없이 파이썬 안에서 돌아가는 '분석용' SQL 데이터베이스라서
CSV를 바로 읽고, CTE·윈도우 함수·median/mad 같은 통계 함수를 쓸 수 있다. 무료이고 설치가 가볍다.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT / "sql"
DATA = ROOT / "data"
RESULTS = ROOT / "results"


def connect(tx: Path, budgets: Path | None, fixed: Path | None, as_of: str | None) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute((SQL / "00_schema.sql").read_text(encoding="utf-8"))
    con.execute("INSERT INTO tx SELECT user_id, id, date, merchant, amount, dir, cat, src, nullif(fixed_id, '') "
                "FROM read_csv(?, header = true, all_varchar = false, "
                "types = {'fixed_id': 'VARCHAR', 'amount': 'BIGINT', 'date': 'DATE'})", [str(tx)])
    if budgets and budgets.exists():
        con.execute("INSERT INTO budgets SELECT * FROM read_csv(?, header = true)", [str(budgets)])
    if fixed and fixed.exists():
        con.execute("INSERT INTO fixed_items SELECT * FROM read_csv(?, header = true)", [str(fixed)])
    if as_of is None:
        as_of = con.execute("SELECT max(date) FROM tx").fetchone()[0].isoformat()
    con.execute("INSERT INTO as_of VALUES (?::DATE)", [as_of])
    return con


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tx", type=Path, default=DATA / "synthetic_tx.csv")
    ap.add_argument("--budgets", type=Path, default=DATA / "synthetic_budgets.csv")
    ap.add_argument("--fixed", type=Path, default=DATA / "synthetic_fixed.csv")
    ap.add_argument("--as-of", default=None, help="기준일 YYYY-MM-DD (없으면 마지막 거래일)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    as_of = args.as_of
    if as_of is None and (DATA / "as_of.csv").exists() and args.tx == DATA / "synthetic_tx.csv":
        as_of = (DATA / "as_of.csv").read_text(encoding="utf-8").splitlines()[1].strip()

    con = connect(args.tx, args.budgets, args.fixed, as_of)
    RESULTS.mkdir(exist_ok=True)
    for f in sorted(SQL.glob("[0-9][0-9]_*.sql")):
        if f.name.startswith("00_"):
            continue
        df = con.execute(f.read_text(encoding="utf-8")).df()
        df.to_csv(RESULTS / f"{f.stem}.csv", index=False, encoding="utf-8")
        if not args.quiet:
            print(f"\n== {f.stem} ({len(df)}줄) ==")
            print(df.head(8).to_string(index=False))


if __name__ == "__main__":
    main()
