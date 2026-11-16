"""Berka(PKDD'99 체코 은행, 실제 거래를 익명화한 공개 연구 데이터)를 우리 가계부 모양으로 바꾼다.

입력 : analysis/private/berka/raw/*.asc   (data_berka.zip을 푼 것. 라이선스 문구를 확인하지 못해 GitHub에 올리지 않음)
출력 : analysis/private/berka/berka_tx.csv · berka_fixed.csv · as_of.csv   (모두 git이 무시하는 폴더)

바꾸는 규칙 (원본 type · operation · k_symbol → 우리 dir · cat · 고정 여부)
    PRIJEM(들어온 돈)
        DUCHOD(연금) · PREVOD Z UCTU(다른 은행에서 입금) · UROK(이자)  → in · 급여·수입
        VKLAD(현금 입금)                                            → in · 내부이체  (내 돈을 옮긴 것이라 계산에서 뺌)
    VYDAJ · VYBER(나간 돈)
        SIPO(공과금 자동이체)                                        → out · 주거·통신 · 고정
        UVER(대출 상환) · POJISTNE(보험료)                           → out · 금융·수수료 · 고정
        SLUZBY(계좌 수수료) · SANKC. UROK(연체 이자)                  → out · 금융·수수료
        PREVOD NA UCET(송금, 받는 사람 계좌별로 가게 이름을 따로)     → out · 기타
        VYBER(현금 인출) · VYBER KARTOU(카드 출금)                   → out · 기타
    '고정'은 원본의 자동이체 주문(order.asc)에 있는 종류(SIPO·UVER·POJISTNE)만. 고정 항목의 '매월 며칠'은 실제 거래가 가장 많이 나온 날

금액: 체코 코루나(CZK)를 1 CZK = 60원으로 고정 환산(분석 규칙의 '3만원' 같은 기준을 그대로 쓰려는 근사치. 실제 1990년대 환율이 아님)
날짜: 1993-01-01 ~ 1998-12-31. 사람 = 계좌(account_id)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "private" / "berka" / "raw"
OUT = ROOT / "private" / "berka"
KRW_PER_CZK = 60

FIXED_K = {"SIPO": ("주거·통신", "공과금 자동이체"), "UVER": ("금융·수수료", "대출 상환"), "POJISTNE": ("금융·수수료", "보험료")}


def main():
    t = pd.read_csv(RAW / "trans.asc", sep=";", dtype=str, low_memory=False)
    t["k"] = t.k_symbol.fillna("").str.strip()
    t["op"] = t.operation.fillna("").str.strip()
    t["amount_krw"] = (t.amount.astype(float) * KRW_PER_CZK).round().astype("int64")
    t["date"] = pd.to_datetime("19" + t.date, format="%Y%m%d")
    inn = t.type.eq("PRIJEM")

    cat = np.select(
        [inn & t.op.eq("VKLAD"), inn,
         t.k.eq("SIPO"), t.k.isin(["UVER", "POJISTNE", "SLUZBY", "SANKC. UROK"])],
        ["내부이체", "급여·수입", "주거·통신", "금융·수수료"], "기타")
    merchant = np.select(
        [inn & t.k.eq("DUCHOD"), inn & t.k.eq("UROK"), inn & t.op.eq("VKLAD"), inn,
         t.k.eq("SIPO"), t.k.eq("UVER"), t.k.eq("POJISTNE"), t.k.eq("SLUZBY"), t.k.eq("SANKC. UROK"),
         t.op.eq("PREVOD NA UCET"), t.op.eq("VYBER KARTOU")],
        ["연금", "이자", "현금 입금", "입금(다른 은행)",
         "공과금 자동이체", "대출 상환", "보험료", "계좌 수수료", "연체 이자",
         "송금", "카드 출금"], "현금 인출")
    # 송금은 받는 계좌별로 다른 '가게'로 본다 (매달 같은 사람에게 보내는 돈 = 반복 결제 후보)
    to = (t.bank.fillna("") + t.account.fillna("").str.replace(".0", "", regex=False)).str.strip()
    merchant = np.where((merchant == "송금") & (to != ""), "송금 " + to.str[-4:], merchant)
    fixed = (~inn) & t.k.isin(list(FIXED_K))

    tx = pd.DataFrame({
        "user_id": "a" + t.account_id, "id": "b" + t.trans_id, "date": t.date.dt.strftime("%Y-%m-%d"),
        "merchant": merchant, "amount": t.amount_krw, "dir": np.where(inn, "in", "out"), "cat": cat,
        "src": np.where(fixed, "고정", "원본"), "fixed_id": np.where(fixed, t.k, ""),
    })
    tx = tx[tx.amount > 0].sort_values(["user_id", "date", "id"])
    tx.to_csv(OUT / "berka_tx.csv", index=False, encoding="utf-8")

    # 고정 항목: 계좌 × 종류마다 금액(중앙값)과 '매월 며칠'(가장 많이 나온 날)
    f = t[fixed].assign(day=t.date.dt.day)
    items = f.groupby(["account_id", "k"]).agg(amount=("amount_krw", "median"), day=("day", lambda s: s.mode().iloc[0])).reset_index()
    fixed_items = pd.DataFrame({
        "user_id": "a" + items.account_id, "fixed_id": items.k, "name": items.k.map(lambda k: FIXED_K[k][1]),
        "amount": items.amount.round().astype("int64"), "day": items.day, "dir": "out", "cat": items.k.map(lambda k: FIXED_K[k][0]),
    })
    fixed_items.to_csv(OUT / "berka_fixed.csv", index=False, encoding="utf-8")
    (OUT / "as_of.csv").write_text("as_of\n1998-12-31\n", encoding="utf-8")

    print(f"거래 {len(tx):,}건 · 계좌 {tx.user_id.nunique():,}개 · 고정 항목 {len(fixed_items):,}개 → {OUT}")
    print(tx.groupby(["dir", "cat"]).amount.agg(["count", "median"]).to_string())


if __name__ == "__main__":
    main()
