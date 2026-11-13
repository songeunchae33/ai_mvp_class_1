"""합성 가계부 데이터 만들기 (실제 개인정보 대신 개발·테스트용).

앱의 거래 한 건(ledger.tx)과 같은 모양으로 만든다:
    user_id, id, date, merchant, amount, dir(in/out), cat, src(직접 기록/캡처/고정), fixed_id
- 가상의 세 사람(대학생 · 사회초년생 · 절약형), 13개월(2025-11-01 ~ 기준일 2026-11-12)
- 앱과 같은 중복 규칙(날짜·금액·가게 이름 앞 10글자·방향이 같으면 같은 거래)으로 겹치는 거래는 뺀다
- 일부러 넣은 '이상 지출'은 정답표(anomalies_truth.csv)에 따로 적어, 탐지 규칙을 평가할 때 쓴다
- 가게 이름은 모두 일반 명사(실제 회사 이름 없음). 숫자는 그럴듯하게 지어낸 값이라 실제 통계가 아니다

실행: python analysis/python/make_synthetic.py   → analysis/data/ 아래 CSV 4개
"""
from __future__ import annotations

import csv
import datetime as dt
import random
from pathlib import Path

SEED = 42
START = dt.date(2025, 11, 1)
AS_OF = dt.date(2026, 11, 12)  # 기준일(오늘로 보는 날). 이 날까지만 거래가 있다
OUT = Path(__file__).resolve().parents[1] / "data"

rng = random.Random(SEED)


def days():
    d = START
    while d <= AS_OF:
        yield d
        d += dt.timedelta(days=1)


def won(lo: int, hi: int, step: int = 100) -> int:
    return rng.randrange(lo // step, hi // step + 1) * step


# 사람마다: 고정 수입·지출(앱의 '고정'으로 자동 기록되는 것), 예산(만원), 매일의 소비 습관
PERSONAS = {
    "u_student": {
        "label": "대학생",
        "fixed": [  # (fixed_id, 이름, 금액, 매월 며칠, 방향, 분류)
            ("f_allow", "용돈·알바", 900_000, 25, "in", "급여·수입"),
            ("f_phone", "통신비", 55_000, 10, "out", "주거·통신"),
        ],
        "subs": [("OTT 구독", 13_900, 3, "구독")],  # 고정으로 등록하지 않은 매달 결제(반복 결제 탐지 대상)
        "budget": {"식비": 30, "카페·간식": 8, "쇼핑": 10, "교통": 6, "문화·여가": 5},
        "cafe_rate": 0.45, "cafe_up_from": dt.date(2026, 9, 1),  # 9월부터 카페가 늘어남
    },
    "u_junior": {
        "label": "사회초년생",
        "fixed": [
            ("f_salary", "월급", 2_800_000, 25, "in", "급여·수입"),
            ("f_rent", "월세", 450_000, 1, "out", "주거·통신"),
            ("f_phone", "통신비", 70_000, 12, "out", "주거·통신"),
            ("f_saving", "적금 이체", 500_000, 26, "out", "내부이체"),
        ],
        "subs": [("헬스장", 59_000, 15, "의료·건강"), ("음악 구독", 10_900, 7, "구독")],
        "budget": {"식비": 45, "카페·간식": 10, "쇼핑": 25, "교통": 8, "문화·여가": 15, "여행": 30},
        "cafe_rate": 0.55, "cafe_up_from": None,
    },
    "u_saver": {
        "label": "절약형",
        "fixed": [
            ("f_salary", "월급", 2_300_000, 10, "in", "급여·수입"),
            ("f_rent", "관리비", 120_000, 20, "out", "주거·통신"),
            ("f_phone", "통신비", 33_000, 5, "out", "주거·통신"),
        ],
        "subs": [],
        "budget": {"식비": 25, "카페·간식": 3, "쇼핑": 8, "교통": 7},
        "cafe_rate": 0.12, "cafe_up_from": None,
    },
}

# 일부러 넣는 이상 지출: (사람, 날짜, 가게, 금액, 분류)
INJECTED = [
    ("u_student", dt.date(2026, 10, 18), "식당", 96_000, "식비"),
    ("u_student", dt.date(2026, 11, 8), "온라인쇼핑", 189_000, "쇼핑"),
    ("u_junior", dt.date(2026, 6, 14), "식당", 210_000, "식비"),
    ("u_junior", dt.date(2026, 11, 2), "카페", 64_000, "카페·간식"),
    ("u_saver", dt.date(2026, 8, 22), "온라인쇼핑", 240_000, "쇼핑"),
]


def daily(uid: str, p: dict, d: dt.date) -> list[tuple]:
    """하루치 변동 지출 (가게, 금액, 분류, 기록 방식)."""
    out = []
    weekend = d.weekday() >= 5
    src = lambda: "캡처" if rng.random() < 0.7 else "직접 기록"
    # 식비
    if uid == "u_junior" and not weekend:
        out.append(("구내식당", won(8_000, 12_000), "식비", src()))
    elif rng.random() < (0.55 if uid != "u_saver" else 0.35):
        out.append(("김밥집" if rng.random() < 0.5 else "학생식당", won(5_000, 11_000), "식비", src()))
    if weekend and rng.random() < (0.6 if uid == "u_student" else 0.35 if uid == "u_junior" else 0.1):
        out.append(("배달앱", won(16_000, 32_000), "식비", src()))
    if uid == "u_junior" and d.weekday() == 4 and rng.random() < 0.5:
        out.append(("식당", won(25_000, 55_000), "식비", src()))
    # 카페 (대학생은 9월부터 늘어남)
    rate = p["cafe_rate"] + (0.35 if p["cafe_up_from"] and d >= p["cafe_up_from"] else 0)
    if rng.random() < min(rate, 0.95):
        out.append(("카페", won(3_800, 6_800), "카페·간식", src()))
    if rng.random() < 0.15:
        out.append(("편의점", won(1_500, 8_000), "카페·간식", src()))
    # 교통
    if not weekend or rng.random() < 0.3:
        out.append(("지하철·버스", 1_550 * rng.choice([1, 2, 2]), "교통", "직접 기록"))
    # 쇼핑·문화
    if rng.random() < (0.07 if uid != "u_saver" else 0.03):
        out.append(("온라인쇼핑", won(15_000, 90_000), "쇼핑", src()))
    if weekend and rng.random() < (0.12 if uid != "u_saver" else 0.03):
        out.append(("영화관", won(12_000, 16_000), "문화·여가", src()))
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows, truth, seen = [], [], set()
    n = 0

    def add(uid, d, merchant, amount, direction, cat, src, fixed_id=""):
        nonlocal n
        key = (uid, d.isoformat(), amount, merchant.replace(" ", "")[:10], direction)  # 앱의 txKey와 같은 규칙
        if key in seen:
            return False
        seen.add(key)
        n += 1
        rows.append({"user_id": uid, "id": f"t{n:05d}", "date": d.isoformat(), "merchant": merchant, "amount": amount,
                     "dir": direction, "cat": cat, "src": src, "fixed_id": fixed_id})
        return True

    for uid, p in PERSONAS.items():
        for d in days():
            last = (dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1) - dt.timedelta(days=1)).day
            for fid, name, amt, day, direction, cat in p["fixed"]:
                if d.day == min(day, last):
                    add(uid, d, name, amt, direction, cat, "고정", fid)
            for name, amt, day, cat in p["subs"]:
                if d.day == min(day, last):
                    add(uid, d, name, amt, "out", cat, "캡처")
            for merchant, amount, cat, src in daily(uid, p, d):
                add(uid, d, merchant, amount, "out", cat, src)
            # 가끔 환불(들어온 돈, 쇼핑)
            if rng.random() < 0.01 and uid != "u_saver":
                add(uid, d, "온라인쇼핑 환불", won(10_000, 40_000), "in", "쇼핑", "캡처")
        # 사회초년생: 여름휴가(정상적인 큰 지출, '이상'으로 잡혀도 정답표엔 없음)
        if uid == "u_junior":
            add(uid, dt.date(2026, 8, 3), "숙소", 320_000, "out", "여행", "캡처")
            add(uid, dt.date(2026, 8, 3), "기차표", 59_800, "out", "여행", "캡처")

    for uid, d, merchant, amount, cat in INJECTED:
        if add(uid, d, merchant, amount, "out", cat, "직접 기록"):
            truth.append({"user_id": uid, "id": rows[-1]["id"], "date": d.isoformat(), "merchant": merchant, "amount": amount, "cat": cat})

    rows.sort(key=lambda r: (r["user_id"], r["date"], r["id"]))
    write(OUT / "synthetic_tx.csv", rows)
    write(OUT / "synthetic_budgets.csv",
          [{"user_id": u, "cat": c, "budget_man": v} for u, p in PERSONAS.items() for c, v in p["budget"].items()])
    write(OUT / "synthetic_fixed.csv",
          [{"user_id": u, "fixed_id": f[0], "name": f[1], "amount": f[2], "day": f[3], "dir": f[4], "cat": f[5]}
           for u, p in PERSONAS.items() for f in p["fixed"]])
    write(OUT / "anomalies_truth.csv", truth)
    write(OUT / "as_of.csv", [{"as_of": AS_OF.isoformat()}])
    print(f"거래 {len(rows)}건 · 사람 {len(PERSONAS)}명 · 일부러 넣은 이상 지출 {len(truth)}건 → {OUT}")


def write(path: Path, rows: list[dict]):
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
