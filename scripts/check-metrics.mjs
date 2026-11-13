// 앱 계산(index.html의 METRICS 블록) = SQL 결과(analysis/results)인지 합성 데이터로 확인하는 테스트
// 실행: python analysis/python/run_sql.py --quiet && node scripts/check-metrics.mjs
// 확인하는 것
//  1) 이번 달 현황(monthToDate) = 08_month_to_date.sql
//  2) 반복 결제(recurringPayments) = 05_recurring.sql
//  3) 평소보다 큰 지출(unusualSpends) = 06_anomaly.sql
//  4) 새 계산이 거래 목록을 바꾸지 않는다(읽기만)
//  5) 이번 달 합계가 기존 앱의 spendSummary('이번 달')와 같다(기존 기준 유지)
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const block = html.slice(html.indexOf("// ── METRICS:START"), html.indexOf("// ── METRICS:END"));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(block + "\nthis.api = { MX, monthToDate, recurringPayments, unusualSpends };", ctx);
const { monthToDate, recurringPayments, unusualSpends } = ctx.api;

// 기존 spendSummary를 그대로 꺼내, 필요한 것(ledger·periodRange)만 넣어 돌린다
const ssStart = html.indexOf("function spendSummary(");
const ssEnd = html.slice(ssStart).search(/\r?\n}\r?\n/);   // 윈도우(CRLF)·LF 줄바꿈 모두
const ssCode = html.slice(ssStart, ssStart + ssEnd) + "\n}\n";

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim();
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur); rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const DATA = path.join(ROOT, "analysis", "data"), RES = path.join(ROOT, "analysis", "results");
if (!fs.existsSync(path.join(RES, "08_month_to_date.csv"))) {
  console.error("먼저 python analysis/python/run_sql.py --quiet 를 실행하세요");
  process.exit(1);
}
const asOf = readCsv(path.join(DATA, "as_of.csv"))[0].as_of;
const all = readCsv(path.join(DATA, "synthetic_tx.csv")).map((r) => ({
  user: r.user_id, id: r.id, date: r.date, merchant: r.merchant, amount: Number(r.amount),
  dir: r.dir, cat: r.cat, src: r.src, ...(r.fixed_id ? { fixed: r.fixed_id } : {}),
}));
const users = [...new Set(all.map((t) => t.user))];
const num = (v) => (v === "" || v === undefined ? 0 : Number(v));
let fail = 0, pass = 0;
const check = (ok, msg) => { if (ok) pass++; else { fail++; console.log("✗", msg); } };

const sql08 = readCsv(path.join(RES, "08_month_to_date.csv"));
const sql05 = readCsv(path.join(RES, "05_recurring.csv"));
const sql06 = readCsv(path.join(RES, "06_anomaly.csv"));

for (const u of users) {
  const tx = all.filter((t) => t.user === u);
  const before = JSON.stringify(tx);

  // 1) 이번 달 현황
  const M = monthToDate(tx, asOf);
  const s08 = sql08.filter((r) => r.user_id === u);
  const tot = s08.find((r) => r.cat === "합계");
  check(M.cur === num(tot.cur_spend) && M.prev === num(tot.prev_spend) && M.curFixed === num(tot.cur_fixed),
    `${u} 이번 달 합계: 앱 ${M.cur}/${M.prev}/${M.curFixed} · SQL ${tot.cur_spend}/${tot.prev_spend}/${tot.cur_fixed}`);
  const sqlCats = s08.filter((r) => r.cat !== "합계");
  check(sqlCats.length === M.cats.length, `${u} 이번 달 분류 수: 앱 ${M.cats.length} · SQL ${sqlCats.length}`);
  for (const r of sqlCats) {
    const c = M.cats.find((x) => x.cat === r.cat);
    check(c && c.cur === num(r.cur_spend) && c.prev === num(r.prev_spend), `${u} ${r.cat}: 앱 ${c?.cur}/${c?.prev} · SQL ${r.cur_spend}/${r.prev_spend}`);
  }

  // 2) 반복 결제
  const R = recurringPayments(tx, asOf), s05 = sql05.filter((r) => r.user_id === u);
  check(R.length === s05.length, `${u} 반복 결제 수: 앱 ${R.length} · SQL ${s05.length}`);
  for (const r of s05) {
    const a = R.find((x) => x.merchant === r.merchant);
    check(a && a.n === num(r.n) && a.typical === num(r.typical_amount) && a.cycle === r.cycle && a.next === r.next_expected
      && a.isFixed === (r.is_fixed === "True" || r.is_fixed === "true"),
      `${u} 반복 결제 ${r.merchant}: 앱 ${JSON.stringify(a)} · SQL ${JSON.stringify(r)}`);
  }

  // 3) 평소보다 큰 지출
  const U = unusualSpends(tx), s06 = sql06.filter((r) => r.user_id === u);
  check(JSON.stringify(U.map((x) => x.id)) === JSON.stringify(s06.map((r) => r.id)),
    `${u} 평소보다 큰 지출: 앱 ${U.map((x) => x.id)} · SQL ${s06.map((r) => r.id)}`);
  for (const r of s06) {
    const a = U.find((x) => x.id === r.id);
    check(a && Math.round(a.p95) === num(r.prior_p95) && a.nPrior === num(r.n_prior), `${u} ${r.id} 기준값: 앱 ${a?.p95}/${a?.nPrior} · SQL ${r.prior_p95}/${r.n_prior}`);
  }

  // 4) 읽기만 하는지
  check(JSON.stringify(tx) === before, `${u} 계산 뒤 거래 목록이 바뀜`);

  // 5) 기존 spendSummary('이번 달')와 같은지
  const sctx = { ledger: { tx }, periodRange: () => [M.curStart, asOf], Math };
  vm.createContext(sctx);
  vm.runInContext(ssCode + "\nthis.r = spendSummary('month');", sctx);
  check(sctx.r.total === M.cur, `${u} 기존 spendSummary ${sctx.r.total} · 새 계산 ${M.cur}`);
}

console.log(`\n${fail ? "실패" : "통과"}: 맞음 ${pass} · 틀림 ${fail} (사람 ${users.length}명, 기준일 ${asOf})`);
process.exit(fail ? 1 : 0);
