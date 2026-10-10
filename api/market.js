// 시세: 코스피·코스닥 지수, 관심 종목 (공공데이터포털 금융위원회, 전일 종가) + 원/달러 환율 (한국수출입은행).
// GET /api/market?stocks=삼성전자,카카오   → 홈 화면 데이터
// GET /api/market?search=삼성              → 종목 이름 검색 (관심 종목 추가용)
// 키가 없거나 호출이 실패하면 예시 데이터를 sample:true 로 돌려준다.
import { kstYmd, fetchJson, num, dataGoItems, dataGoKey, cache } from "./_util.js";

const BASE = "https://apis.data.go.kr/1160100/service";

const SAMPLE = {
  kospi: { v: 7250.32, vs: 60.4, pct: 0.84 },
  kosdaq: { v: 912.4, vs: -2.84, pct: -0.31 },
  usd: { v: 1470.5, vs: 3.2, pct: 0.22, date: kstYmd(0) },
  stockPrice: { v: 50000, vs: 600, pct: 1.21 },
};

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
  const it = latest(await dataGo("GetMarketIndexInfoService/getStockMarketIndex", { idxNm: name }));
  if (!it) return null;
  return { v: num(it.clpr), vs: num(it.vs), pct: num(it.fltRt), date: it.basDt };
}

async function stock(name) {
  const it = latest(await dataGo("GetStockSecuritiesInfoService/getStockPriceInfo", { itmsNm: name }));
  if (!it) return { name, missing: true };
  return { name: it.itmsNm, code: it.srtnCd, market: it.mrktCtg, v: num(it.clpr), vs: num(it.vs), pct: num(it.fltRt), date: it.basDt };
}

async function search(q) {
  const items = await dataGo("GetStockSecuritiesInfoService/getStockPriceInfo", {
    likeItmsNm: q,
    beginBasDt: kstYmd(7),
    numOfRows: "100",
  });
  const seen = new Map();
  for (const it of items) if (!seen.has(it.itmsNm)) seen.set(it.itmsNm, { name: it.itmsNm, market: it.mrktCtg });
  // 검색어로 시작하는 이름을 먼저
  return [...seen.values()].sort((a, b) => b.name.startsWith(q) - a.name.startsWith(q) || a.name.length - b.name.length).slice(0, 8);
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

  const names = String(req.query.stocks || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  const out = { sample: !hasData || !hasExim };
  const tasks = [];

  if (hasData) {
    tasks.push(
      index("코스피").then((v) => (out.kospi = v)).catch((e) => console.error("kospi", e.message)),
      index("코스닥").then((v) => (out.kosdaq = v)).catch((e) => console.error("kosdaq", e.message)),
      Promise.all(names.map((n) => stock(n).catch(() => ({ name: n, missing: true })))).then((v) => (out.stocks = v))
    );
  }
  if (hasExim) tasks.push(usd().then((v) => (out.usd = v)).catch((e) => console.error("usd", e.message)));
  await Promise.all(tasks);

  // 빠진 값은 예시로 채우고 sample 표시
  for (const k of ["kospi", "kosdaq", "usd"]) {
    if (!out[k]) {
      out[k] = { ...SAMPLE[k], date: k === "usd" ? kstYmd(0) : kstYmd(1) };
      out.sample = true;
    }
  }
  if (!out.stocks) {
    out.stocks = names.map((name, i) => ({ name, ...SAMPLE.stockPrice, pct: [1.21, -0.55, 2.87, -1.4][i % 4], date: kstYmd(1) }));
    out.sample = true;
  }

  cache(res, out.sample ? 60 : 1800);
  res.status(200).json(out);
}
