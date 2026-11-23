// 시세: 코스피·코스닥 지수와 원/달러 환율은 한국은행 ECOS(ECOS_KEY), 관심 종목은 공공데이터포털 금융위원회(전일 종가).
// ECOS_KEY가 아직 없으면 지수는 금융위원회, 환율은 한국수출입은행으로 예전처럼 받는다.
// GET /api/market?stocks=삼성전자,카카오   → 홈 화면 데이터
// GET /api/market?search=삼성              → 종목 이름 검색 (관심 종목 추가용)
// GET /api/market?game=1&extra=종목,종목   → 모의투자 '실제 시장' (대표 종목 12개 + 산 종목의 이번 시즌 시가·종가, 실제 코스피, 보도자료 힌트)
// 키가 없거나 호출이 실패하면 예시 데이터를 sample:true 로 돌려준다.
import { kstYmd, fetchJson, num, dataGoItems, dataGoKey, cache } from "./_util.js";
import { pressReleases } from "./_policy.js";

const BASE = "https://apis.data.go.kr/1160100"; // 금융위원회 시세 API (V2 주소)

const SAMPLE = {
  kospi: { v: 7250.32, vs: 60.4, pct: 0.84 },
  kosdaq: { v: 912.4, vs: -2.84, pct: -0.31 },
  usd: { v: 1470.5, vs: 3.2, pct: 0.22, date: kstYmd(0) },
  stockPrice: { v: 50000, o: 49600, vs: 600, pct: 1.21 },
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
  const it = latest(await dataGo("GetMarketIndexInfoService_V2/getStockMarketIndex_V2", { idxNm: name }));
  if (!it) return null;
  return { v: num(it.clpr), vs: num(it.vs), pct: num(it.fltRt), date: it.basDt };
}

async function stock(name) {
  const it = latest(await dataGo("GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2", { itmsNm: name }));
  if (!it) return { name, missing: true };
  return { name: it.itmsNm, code: it.srtnCd, market: it.mrktCtg, v: num(it.clpr), o: num(it.mkp), vs: num(it.vs), pct: num(it.fltRt), date: it.basDt };
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

// ───────────────────────── 모의투자 '실제 시장' ─────────────────────────
// 실제 종목·실제 가격(금융위원회 주식시세, 전일 종가)으로 겨룬다. 비교 지수는 실제 코스피.
// 주의: 시세는 공공누리 제4유형(상업적 이용 금지·변경 금지, 원천 한국거래소)이라 광고·구독 등 상업화 전에는 다시 검토해야 한다.
// 힌트는 실제 정부 보도자료(정책브리핑, 공공저작물)에서 업종별 좋은·나쁜 소식을 골라, 그 업종의 대표 종목과 이어 준다(방향은 가능성일 뿐).
// GET /api/market?game=1&extra=종목A,종목B → { season, today, index, series: { 종목: [[YYYYMMDD, 시가, 종가]] }, companies, pool, indexName, indexDate, sample }
const SECTORS = {
  chip: { name: "반도체", words: ["반도체", "메모리", "인공지능", "AI", "파운드리", "칩"] },
  car: { name: "자동차·수출", words: ["자동차", "전기차", "수출", "관세", "통상"] },
  bank: { name: "은행·금리", words: ["금리", "대출", "은행", "가계부채", "예금", "금융"] },
  battery: { name: "배터리", words: ["배터리", "이차전지", "2차전지", "리튬", "전기차", "에너지"] },
  content: { name: "콘텐츠·관광", words: ["콘텐츠", "관광", "한류", "문화", "게임", "공연", "K-"] },
  build: { name: "건설·부동산", words: ["부동산", "주택", "건설", "청약", "공급", "SOC", "전세"] },
  food: { name: "식품·생활", words: ["물가", "농산물", "식품", "외식", "소비", "생활"] },
  platform: { name: "인터넷·플랫폼", words: ["플랫폼", "디지털", "데이터", "인터넷", "온라인", "AI"] },
  bio: { name: "바이오", words: ["바이오", "신약", "의약", "제약", "임상", "헬스"] },
};
// 모의투자 첫 화면에 늘 보여 줄 대표 종목 (업종별, 너무 많지 않게 12개). 다른 종목은 검색으로 산다
const UNIVERSE = [
  ["삼성전자", "chip"], ["SK하이닉스", "chip"], ["현대차", "car"], ["KB금융", "bank"], ["LG에너지솔루션", "battery"], ["하이브", "content"],
  ["현대건설", "build"], ["CJ제일제당", "food"], ["NAVER", "platform"], ["카카오", "platform"], ["삼성바이오로직스", "bio"], ["셀트리온", "bio"],
];
const POS = ["호조", "증가", "확대", "지원", "성장", "최대", "개선", "상승", "회복", "활성화", "타결", "완화", "육성", "유치", "기대", "흑자"];
const NEG = ["감소", "둔화", "하락", "규제", "위기", "우려", "적자", "부진", "축소", "단속", "과징금", "제재", "피해", "중단"];

function seeded(...k) { // 0~1 사이 정해진 무작위 (같은 열쇠면 같은 값) — 힌트 기간, 키가 없을 때 예시 값에만 쓴다
  let h = 2166136261;
  for (const ch of k.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function ymdAdd(d, n) { const t = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10).replace(/-/g, ""); }
function relYmd(at) { // 보도자료 승인일 → YYYYMMDD
  const s = String(at || "");
  let m = s.match(/(\d{4})[-./]?(\d{2})[-./]?(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}` : "";
}
function newsTone(text) {
  const p = POS.filter((w) => text.includes(w)).length, n = NEG.filter((w) => text.includes(w)).length;
  return p > n ? 1 : n > p ? -1 : 0;
}
// 실제 코스피 날마다 종가 [[YYYYMMDD, 값]] (오래된 날부터). ECOS 키가 있으면 한국은행 ECOS, 없으면 공공데이터포털 금융위원회
async function kospiDaily(from) {
  if (process.env.ECOS_KEY) {
    try {
      const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(process.env.ECOS_KEY)}/json/kr/1/100/802Y001/D/${from}/${kstYmd(0)}/0001000`;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const rows = ((r.ok ? await r.json() : {}).StatisticSearch?.row || []).map((x) => [x.TIME, num(x.DATA_VALUE)]).filter((x) => x[1] != null);
      if (rows.length) return rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    } catch (e) { console.error("kospi ecos", e.message); }
  }
  const items = await dataGo("GetMarketIndexInfoService_V2/getStockMarketIndex_V2", { idxNm: "코스피", beginBasDt: from, numOfRows: "100" });
  return items.map((it) => [it.basDt, num(it.clpr)]).filter((x) => x[1] != null).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
// 한 종목의 날마다 [날짜, 시가, 종가] (오래된 날부터) + 종목 코드
async function stockDaily(name, from) {
  const items = await dataGo("GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2", { itmsNm: name, beginBasDt: from, numOfRows: "100" });
  const mine = items.filter((it) => it.itmsNm === name);
  return { code: mine[0]?.srtnCd || "", market: mine[0]?.mrktCtg || "", rows: mine.map((it) => [it.basDt, num(it.mkp), num(it.clpr)]).filter((r) => r[2] != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
}
// 키가 없을 때(로컬 확인용) 예시 값: 평일만, 이름마다 같은 모양
function sampleDaily(seed, from, base) {
  const out = [];
  let v = base;
  for (let d = from; d <= kstYmd(1); d = ymdAdd(d, 1)) {
    const wd = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const o = Math.round(v * (1 + (seeded(seed, d, "o") - 0.5) * 0.01));
    v = Math.round(v * (1 + (seeded(seed, d) - 0.49) * 0.03));
    out.push([d, o, v]);
  }
  return out;
}

async function realMarket(extra) {
  const today = kstYmd(0), season = `${today.slice(0, 4)}-${today.slice(4, 6)}`;
  const start = `${today.slice(0, 6)}01`, from = ymdAdd(start, -10); // 전날 대비를 알 수 있게 시즌 전 며칠도 받는다
  const sample = !process.env.DATA_GO_KR_KEY;
  const names = [...UNIVERSE.map(([n]) => n), ...extra.filter((n) => !UNIVERSE.some(([u]) => u === n))];
  const series = {}, meta = {};
  let K = [];
  if (!sample) {
    await Promise.all([
      kospiDaily(from).then((v) => (K = v)).catch((e) => console.error("kospi", e.message)),
      ...names.map((n) => stockDaily(n, from).then((v) => { if (v.rows.length) { series[n] = v.rows; meta[n] = v; } }).catch((e) => console.error("stock", n, e.message))),
    ]);
  }
  if (!K.length) K = sampleDaily("코스피", from, 5000).map(([d, , c]) => [d, c]);
  for (const n of names) if (!series[n] && sample) series[n] = sampleDaily(n, from, 20000 + Math.round(seeded(n) * 200000));
  // 비교 지수: 실제 코스피. 시즌 안의 날들(아직 없으면 시즌 전 마지막 날 하나)
  let index = K.filter((x) => x[0] >= start);
  if (!index.length) index = K.slice(-1);
  // 힌트 묶음: 최근 7일 보도자료(새 것 먼저)에서 업종별 소식을 골라 그 업종 대표 종목과 잇는다 (같은 보도자료는 하나로 합침)
  const pool = [];
  try {
    const rel = sample ? [] : (await pressReleases(7)).sort((x, y) => (relYmd(y.at) > relYmd(x.at) ? 1 : -1)); // 주말에도 힌트가 있게 최근 7일, 새 소식 먼저
    const byTitle = new Map();
    for (const r of rel) {
      const d = relYmd(r.at);
      if (d && d < ymdAdd(today, -6)) continue;
      const text = `${r.title} ${r.sub}`, t = newsTone(text);
      if (!t) continue;
      for (const [sec, S] of Object.entries(SECTORS)) if (S.words.some((w) => text.includes(w))) {
        const stocks = UNIVERSE.filter(([, s]) => s === sec).map(([n]) => n);
        const same = byTitle.get(r.title);
        if (same) {
          if (!same.sector.split(", ").includes(S.name)) same.sector += `, ${S.name}`;
          for (const n of stocks) if (!same.stocks.includes(n)) same.stocks.push(n);
          continue;
        }
        const h = { id: `n-${sec}-${pool.length}-${d}`, kind: "news", sector: S.name, dir: t > 0 ? "up" : "down", days: 3 + Math.floor(seeded(r.title, sec) * 5),
          title: r.title, stocks: [...stocks], sources: [{ title: r.title, url: r.url, source: r.org || "정책브리핑" }] };
        byTitle.set(r.title, h);
        pool.push(h);
      }
    }
  } catch (e) { console.error("hints", e.message); }
  if (sample) pool.push({ id: "s-chip", kind: "news", sector: "반도체", dir: "up", days: 5, title: "(예시) 반도체 쪽에 좋은 정부 발표가 나왔어요", stocks: ["삼성전자", "SK하이닉스"], sources: [] });
  const sectorOf = Object.fromEntries(UNIVERSE.map(([n, s]) => [n, SECTORS[s].name]));
  return {
    season, today, sample, index, series, indexName: "코스피", indexDate: K[K.length - 1]?.[0] || null,
    companies: names.filter((n) => series[n]).map((n) => ({ id: n, name: n, sector: sectorOf[n] || meta[n]?.market || "", code: meta[n]?.code || "", core: !!sectorOf[n] })),
    pool: pool.slice(0, 12),
  };
}

export default async function handler(req, res) {
  const hasData = !!process.env.DATA_GO_KR_KEY;
  const hasExim = !!process.env.KOREAEXIM_KEY;
  const hasEcos = !!process.env.ECOS_KEY;

  if (req.query.game !== undefined) {
    try {
      const extra = String(req.query.extra || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10);
      const out = await realMarket(extra);
      cache(res, out.sample ? 120 : 1800);
      return res.status(200).json(out);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "가상 시장을 불러오지 못했어요" });
    }
  }

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
    out.stocks = names.map((name, i) => ({ name, ...SAMPLE.stockPrice, pct: [1.21, -0.55, 2.87, -1.4][i % 4], date: kstYmd(1) }));
    out.sample = true;
  }

  cache(res, out.sample ? 60 : 1800);
  res.status(200).json(out);
}
