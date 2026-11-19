// 시세: 코스피·코스닥 지수와 원/달러 환율은 한국은행 ECOS(ECOS_KEY), 관심 종목은 공공데이터포털 금융위원회(전일 종가).
// ECOS_KEY가 아직 없으면 지수는 금융위원회, 환율은 한국수출입은행으로 예전처럼 받는다.
// GET /api/market?stocks=삼성전자,카카오   → 홈 화면 데이터
// GET /api/market?search=삼성              → 종목 이름 검색 (관심 종목 추가용)
// GET /api/market?history=삼성전자,SK하이닉스&days=40 → 모의투자 그래프용 날마다 종가·시가 (+ 같은 기간 코스피)
// GET /api/market?stocks=...&yields=1       → 모의투자 채권 금리(국고채·회사채 3년, 한국은행 ECOS)도 함께
// 키가 없거나 호출이 실패하면 예시 데이터를 sample:true 로 돌려준다.
import { kstYmd, fetchJson, num, dataGoItems, dataGoKey, cache } from "./_util.js";

const BASE = "https://apis.data.go.kr/1160100"; // 금융위원회 시세 API (V2 주소)

const SAMPLE = {
  kospi: { v: 7250.32, vs: 60.4, pct: 0.84 },
  kosdaq: { v: 912.4, vs: -2.84, pct: -0.31 },
  usd: { v: 1470.5, vs: 3.2, pct: 0.22, date: kstYmd(0) },
  stockPrice: { v: 50000, o: 49600, vs: 600, pct: 1.21 },
};
// 모의투자 채권 금리: ECOS 817Y002 시장금리(일). 키가 없거나 실패하면 예시 금리(sample)
const YIELDS = [
  { id: "ktb3", name: "국고채 3년", item: "010200000", sample: 2.9 },
  { id: "corp3", name: "회사채 3년 (AA-)", item: "010300000", sample: 3.4 },
];

async function dataGo(path, params) {
  const qs = new URLSearchParams({
    resultType: "json",
    numOfRows: "40",
    pageNo: "1",
    beginBasDt: kstYmd(14), // 최근 2주 안에서 가장 최근 거래일을 고른다
    ...params,
  });
  const json = await fetchJson(`${BASE}/${path}?serviceKey=${dataGoKey()}&${qs}`);
  return dataGoItems(json);
}

// 같은 이름이 여러 날짜로 오면 가장 최근 거래일 하나만
function latest(items) {
  return items.reduce((a, b) => (!a || b.basDt > a.basDt ? b : a), null);
}

async function index(name) {
  const it = latest(await dataGo("GetMarketIndexInfoService_V2/getStockMarketIndex_V2", { idxNm: name }));
  if (!it) return null;
  return { v: num(it.clpr), vs: num(it.vs), pct: num(it.fltRt), date: it.basDt };
}

async function stock(name) {
  const it = latest(await dataGo("GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2", { itmsNm: name }));
  if (!it) return { name, missing: true };
  return { name: it.itmsNm, code: it.srtnCd, market: it.mrktCtg, v: num(it.clpr), o: num(it.mkp), vs: num(it.vs), pct: num(it.fltRt), date: it.basDt };
}

// 한 종목의 날마다 [날짜, 종가, 시가] (오래된 날부터)
async function stockHistory(name, days) {
  const items = await dataGo("GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2", { itmsNm: name, beginBasDt: kstYmd(days), numOfRows: "400" });
  return items.filter((it) => it.itmsNm === name).map((it) => [it.basDt, num(it.clpr), num(it.mkp)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function kospiHistory(days, hasEcos) {
  if (hasEcos) {
    const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(process.env.ECOS_KEY)}/json/kr/1/400/802Y001/D/${kstYmd(days)}/${kstYmd(0)}/0001000`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = r.ok ? await r.json() : {};
    const rows = (j.StatisticSearch?.row || []).map((x) => [x.TIME, num(x.DATA_VALUE)]).filter((x) => x[1] != null);
    if (rows.length) return rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  const items = await dataGo("GetMarketIndexInfoService_V2/getStockMarketIndex_V2", { idxNm: "코스피", beginBasDt: kstYmd(days), numOfRows: "400" });
  return items.map((it) => [it.basDt, num(it.clpr)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
// 키가 없을 때 그래프용 예시: 이름마다 같은 모양이 나오는 흔들리는 선 (평일만)
function sampleHistory(seed, days, base) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296);
  const out = [];
  let v = base;
  for (let i = days; i >= 1; i--) {
    const d = kstYmd(i);
    const wd = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const o = Math.round(v * (1 + (rnd() - 0.5) * 0.01));
    v = Math.round(v * (1 + (rnd() - 0.48) * 0.03));
    out.push([d, v, o]);
  }
  return out;
}
async function yields() {
  return Promise.all(YIELDS.map(async (y) => {
    try {
      const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(process.env.ECOS_KEY)}/json/kr/1/20/817Y002/D/${kstYmd(14)}/${kstYmd(0)}/${y.item}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const rows = ((r.ok ? await r.json() : {}).StatisticSearch?.row || []).filter((x) => num(x.DATA_VALUE) != null).sort((a, b) => (a.TIME < b.TIME ? -1 : 1));
      const last = rows[rows.length - 1];
      if (last) return { id: y.id, name: y.name, rate: num(last.DATA_VALUE), date: last.TIME, src: "한국은행 ECOS" };
    } catch (e) { console.error("yield", y.id, e.message); }
    return { id: y.id, name: y.name, rate: y.sample, sample: true };
  }));
}

async function search(q) {
  const items = await dataGo("GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2", {
    likeItmsNm: q,
    beginBasDt: kstYmd(7),
    numOfRows: "100",
  });
  const seen = new Map();
  for (const it of items) if (!seen.has(it.itmsNm)) seen.set(it.itmsNm, { name: it.itmsNm, market: it.mrktCtg });
  // 검색어로 시작하는 이름을 먼저
  return [...seen.values()].sort((a, b) => b.name.startsWith(q) - a.name.startsWith(q) || a.name.length - b.name.length).slice(0, 8);
}

// 한국은행 ECOS 통계 (https://ecos.bok.or.kr/api/). 키가 주소 안에 들어가므로 오류 메시지에 주소를 넣지 않는다.
// 802Y001 주식시장(일): 0001000 KOSPI지수 · 0089000 KOSDAQ지수 / 731Y001 주요국 통화의 대원화환율: 0000001 원/미국달러(매매기준율)
async function ecos(stat, item) {
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(process.env.ECOS_KEY)}/json/kr/1/10/${stat}/D/${kstYmd(14)}/${kstYmd(0)}/${item}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`ecos ${r.status}`);
  const j = await r.json();
  const rows = (j.StatisticSearch?.row || []).filter((x) => num(x.DATA_VALUE) != null).sort((a, b) => (a.TIME < b.TIME ? -1 : 1));
  if (!rows.length) throw new Error(`ecos ${j.RESULT?.CODE || "빈 결과"}`);
  const today = rows[rows.length - 1], prev = rows[rows.length - 2];
  const v = num(today.DATA_VALUE), p = prev ? num(prev.DATA_VALUE) : null;
  const vs = p != null ? Math.round((v - p) * 100) / 100 : 0;
  return { v, vs, pct: p ? Math.round((vs / p) * 10000) / 100 : 0, date: today.TIME };
}

// 수출입은행은 영업일 오전 11시쯤 그날 환율을 올린다. 주말·공휴일·발표 전이면 빈 배열이라 며칠 거슬러 올라간다.
async function usd() {
  const key = process.env.KOREAEXIM_KEY;
  const days = [...Array(8).keys()].map((i) => kstYmd(i));
  const results = await Promise.all(
    days.map((d) =>
      fetchJson(`https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${key}&searchdate=${d}&data=AP01`)
        .then((rows) => (Array.isArray(rows) ? rows.find((r) => r.cur_unit === "USD") : null))
        .catch(() => null)
    )
  );
  const found = results.map((r, i) => (r ? { date: days[i], v: num(r.deal_bas_r) } : null)).filter(Boolean);
  if (!found.length) return null;
  const [today, prev] = found;
  const vs = prev ? Math.round((today.v - prev.v) * 10) / 10 : 0;
  return { v: today.v, vs, pct: prev ? Math.round((vs / prev.v) * 10000) / 100 : 0, date: today.date };
}

export default async function handler(req, res) {
  const hasData = !!process.env.DATA_GO_KR_KEY;
  const hasExim = !!process.env.KOREAEXIM_KEY;
  const hasEcos = !!process.env.ECOS_KEY;

  if (req.query.search !== undefined) {
    const q = String(req.query.search).trim().slice(0, 20);
    if (!q) return res.status(200).json({ results: [] });
    if (!hasData) return res.status(200).json({ results: [], sample: true });
    try {
      cache(res, 3600);
      return res.status(200).json({ results: await search(q) });
    } catch (e) {
      console.error(e);
      return res.status(200).json({ results: [], error: "검색에 실패했어요" });
    }
  }

  // 모의투자 그래프: 종목들과 코스피의 날마다 종가
  if (req.query.history !== undefined) {
    const list = String(req.query.history).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10);
    const days = Math.min(400, Math.max(5, parseInt(req.query.days, 10) || 40));
    const out = { series: {}, kospi: [] };
    if (hasData) {
      await Promise.all([
        ...list.map((n) => stockHistory(n, days).then((v) => (out.series[n] = v)).catch((e) => console.error("hist", n, e.message))),
        kospiHistory(days, hasEcos).then((v) => (out.kospi = v)).catch((e) => console.error("kospi hist", e.message)),
      ]);
    }
    if (!out.kospi.length) { out.kospi = sampleHistory("코스피", days, SAMPLE.kospi.v).map(([d, c]) => [d, c]); out.sample = true; }
    for (const n of list) if (!out.series[n]?.length) { out.series[n] = sampleHistory(n, days, SAMPLE.stockPrice.v); out.sample = true; }
    cache(res, out.sample ? 60 : 3600);
    return res.status(200).json(out);
  }

  const names = String(req.query.stocks || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  const out = { sample: !hasData || !(hasEcos || hasExim) };
  out.src = { usd: hasEcos ? "ecos" : "exim", index: hasEcos ? "ecos" : "fsc" }; // 화면의 출처 표시용
  const tasks = [];

  if (hasEcos) {
    tasks.push(
      ecos("802Y001", "0001000").then((v) => (out.kospi = v)).catch((e) => { console.error("kospi", e.message); out.note = String(e.message).slice(0, 80); }),
      ecos("802Y001", "0089000").then((v) => (out.kosdaq = v)).catch((e) => console.error("kosdaq", e.message)),
      ecos("731Y001", "0000001").then((v) => (out.usd = v)).catch((e) => console.error("usd", e.message))
    );
  } else if (hasData) {
    tasks.push(
      index("코스피").then((v) => (out.kospi = v)).catch((e) => { console.error("kospi", e.message); out.note = String(e.message).slice(0, 80); }),
      index("코스닥").then((v) => (out.kosdaq = v)).catch((e) => console.error("kosdaq", e.message))
    );
  }
  if (hasData) tasks.push(Promise.all(names.map((n) => stock(n).catch(() => ({ name: n, missing: true })))).then((v) => (out.stocks = v)));
  if (req.query.yields) tasks.push((hasEcos ? yields() : Promise.resolve(YIELDS.map((y) => ({ id: y.id, name: y.name, rate: y.sample, sample: true }))))
    .then((v) => (out.yields = v)));
  if (!hasEcos && hasExim) tasks.push(usd().then((v) => (out.usd = v)).catch((e) => console.error("usd", e.message)));
  await Promise.all(tasks);

  // 빠진 값은 예시로 채우고 sample 표시
  for (const k of ["kospi", "kosdaq", "usd"]) {
    if (!out[k]) {
      out[k] = { ...SAMPLE[k], date: k === "usd" ? kstYmd(0) : kstYmd(1) };
      out.sample = true;
    }
  }
  if (!out.stocks) {
    out.stocks = names.map((name, i) => {
      const last = sampleHistory(name, 10, SAMPLE.stockPrice.v).slice(-2); // 그래프 예시와 같은 값
      const [d, v, o] = last[1], p = last[0][1];
      return { name, v, o, vs: v - p, pct: Math.round(((v - p) / p) * 10000) / 100, date: d };
    });
    out.sample = true;
  }

  cache(res, out.sample ? 60 : 1800);
  res.status(200).json(out);
}
