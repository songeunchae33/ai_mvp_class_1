// 시세: 코스피·코스닥 지수와 원/달러 환율은 한국은행 ECOS(ECOS_KEY), 관심 종목은 공공데이터포털 금융위원회(전일 종가).
// ECOS_KEY가 아직 없으면 지수는 금융위원회, 환율은 한국수출입은행으로 예전처럼 받는다.
// GET /api/market?stocks=삼성전자,카카오   → 홈 화면 데이터
// GET /api/market?search=삼성              → 종목 이름 검색 (관심 종목 추가용)
// GET /api/market?game=1&extra=종목,종목   → 모의투자 '실제 시장' (대표 종목 12개 + 산 종목의 이번 시즌 시가·종가, 실제 코스피)
// 미국 주식(MASSIVE_KEY + Firestore가 있을 때): 종목 id는 "US:티커", 값은 원화(그날 종가 × 유럽중앙은행 기준 환율). api/_us.js
// GET /api/market?game=hints              → 모의투자 힌트 (시장 소식 + 보도자료, 제미나이 검수)
// 키가 없거나 호출이 실패하면 예시 데이터를 sample:true 로 돌려준다.
import { kstYmd, fetchJson, num, dataGoItems, dataGoKey, cache, adminReady, adminToken, fsReq, toFs, fromFs, fsList, fsSet, fsGetMany } from "./_util.js";
import { pressReleases, isEcon } from "./_policy.js";
import { generate } from "./_ai.js";
import crypto from "node:crypto";
import { US_PREFIX, US_CORE, US_INDEX, usReady, usName, usFill, usSeries, usSearch } from "./_us.js";

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

// 같은 값을 여러 곳에서 받으면 날짜가 가장 최근인 것을 쓴다 (한 곳이 늦게 올라와도 화면이 멈추지 않게)
function newest(...xs) { return xs.filter((x) => x?.v != null).sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1))[0] || null; }

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
// GET /api/market?game=1&extra=종목A,종목B → { season, today, index, series: { 종목: [[YYYYMMDD, 시가, 종가]] }, companies, indexName, indexDate, sample }
// GET /api/market?game=hints → { pool: 힌트들, reviewed: 제미나이 검수 여부 }
const SECTORS = { // 보도자료 '제목'에 이 낱말이 있으면 그 업종 소식으로 본다
  chip: { name: "반도체", words: ["반도체", "메모리", "파운드리", "데이터센터"] },
  car: { name: "자동차·수출", words: ["자동차", "전기차", "완성차", "관세", "수출"] },
  bank: { name: "은행·금리", words: ["금리", "대출", "은행", "가계부채", "예금"] },
  battery: { name: "배터리", words: ["배터리", "이차전지", "2차전지", "리튬", "재생에너지", "전기차"] },
  content: { name: "콘텐츠·관광", words: ["콘텐츠", "관광", "한류", "K-컬처", "공연", "영화", "드라마"] },
  build: { name: "건설·부동산", words: ["부동산", "주택", "건설", "청약", "전세", "SOC", "아파트"] },
  food: { name: "식품·생활", words: ["물가", "농산물", "식품", "외식", "먹거리"] },
  platform: { name: "인터넷·플랫폼", words: ["플랫폼", "디지털", "인공지능", "AI", "온라인"] },
  bio: { name: "바이오", words: ["바이오", "신약", "의약품", "제약", "임상"] },
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

async function realMarket(extraAll) {
  const today = kstYmd(0), season = `${today.slice(0, 4)}-${today.slice(4, 6)}`;
  const start = `${today.slice(0, 6)}01`, from = ymdAdd(start, -10); // 전날 대비를 알 수 있게 시즌 전 며칠도 받는다
  const sample = !process.env.DATA_GO_KR_KEY;
  const extra = extraAll.filter((n) => !n.startsWith(US_PREFIX)), usExtra = extraAll.filter((n) => n.startsWith(US_PREFIX)).map((n) => n.slice(US_PREFIX.length));
  const usP = usMarket(usExtra, from, start).catch((e) => { console.error("us", e.message); return null; });
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
  const sectorOf = Object.fromEntries(UNIVERSE.map(([n, s]) => [n, SECTORS[s].name]));
  const companies = names.filter((n) => series[n]).map((n) => ({ id: n, name: n, sector: sectorOf[n] || meta[n]?.market || "", code: meta[n]?.code || "", core: !!sectorOf[n] }));
  const U = await usP;
  if (U) { Object.assign(series, U.series); companies.push(...U.companies); }
  return {
    season, today, sample, index, series, indexName: "코스피", indexDate: K[K.length - 1]?.[0] || null, companies,
    us: U ? { ready: true, usd: U.usd, fx: U.fx, index: U.index, indexName: "S&P 500(SPY)", indexDate: U.indexDate } : { ready: false },
  };
}
// 미국: 빠진 날을 조금 채우고(1분에 5번 한도), 대표 12종목 + 산 종목 + SPY의 원화 시리즈
async function usMarket(usExtra, from, start) {
  if (!usReady() || !adminReady()) return null;
  await usFill(usFs, from, 2).catch((e) => console.error("us fill", e.message));
  const tickers = [...US_CORE.map(([t]) => t), US_INDEX, ...usExtra];
  const R = await usSeries(usFs, tickers, from);
  const core = new Set(US_CORE.map(([t]) => t)), sector = Object.fromEntries(US_CORE.map(([t, , s]) => [t, s]));
  const idx = R.series[US_PREFIX + US_INDEX] || [];
  delete R.series[US_PREFIX + US_INDEX];
  const companies = Object.keys(R.series).map((id) => { const t = id.slice(US_PREFIX.length); return { id, name: usName(t), ticker: t, us: true, sector: `미국 · ${sector[t] || t}`, code: "", core: core.has(t) }; });
  let index = idx.filter((r) => r[0] >= start).map((r) => [r[0], r[2]]);
  if (!index.length && idx.length) index = [[idx[idx.length - 1][0], idx[idx.length - 1][2]]];
  return { series: R.series, usd: R.usd, fx: R.fx, companies, index, indexDate: idx[idx.length - 1]?.[0] || null };
}

// ── 모의투자 힌트 (/api/market?game=hints, 모두에게 같은 묶음을 1시간 재사용) ──
// ① 시장 소식: 실제 코스피·대표 종목의 마지막 거래일 움직임 (늘 있어서 힌트가 0개가 되지 않는다)
// ② 정책 소식: 최근 7일 경제 보도자료 중 제목에 업종 낱말이 있는 것
// ③ 제미나이 검수: ②를 하나씩 보고 실제로 그 종목에 영향이 있을 만한 것만 남기고, 종목·방향을 고치고, 이유를 한 줄로 쓴다
//    (제미나이가 안 되면 ②는 규칙으로 고른 그대로, OpenAI로 넘기지 않는다)
const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["i", "keep", "stocks", "dir", "why"],
    properties: {
      i: { type: "integer", description: "후보 번호" },
      keep: { type: "boolean", description: "이 소식이 고른 종목의 주가에 실제로 영향을 줄 만하면 true, 관계가 약하거나 엉뚱하면 false" },
      stocks: { type: "array", items: { type: "string" }, description: "영향받을 종목 1~3개, 반드시 주어진 종목 목록의 이름 그대로" },
      dir: { type: "string", enum: ["up", "down"], description: "그 종목들에 좋은 소식이면 up, 나쁜 소식이면 down" },
      why: { type: "string", description: "왜 그 종목에 영향이 있을 수 있는지 쉬운 존댓말 한 문장(60자 이내). 사람 이름·사라/팔라는 말 금지" },
    } } } },
};
const REVIEW_RULES = `너는 20대에게 경제 소식을 알려주는 모의투자 게임의 힌트 검수자야.
- 후보마다 보도자료 제목이 주어진 종목들의 주가에 실제로 영향을 줄 만한지 엄격하게 판단해. 업종 낱말만 겹치고 내용이 무관하면 keep=false.
- 예: '김 수출 최대' → 자동차 회사와 무관(keep=false 또는 식품 종목으로 바꿈). 'AI 데이터센터 구축 지원' → 반도체·인터넷 종목과 관련(keep=true).
- stocks는 아래 종목 목록의 이름만 그대로 써. 목록에 맞는 종목이 없으면 keep=false.
- why는 확정이 아니라 가능성으로("~할 수 있어요"). 추천·사람 이름·없는 숫자 금지.`;

async function gameHints() {
  const today = kstYmd(0), from = ymdAdd(today, -12);
  const sectorOf = Object.fromEntries(UNIVERSE.map(([n, s]) => [n, SECTORS[s].name]));
  const pool = [];
  // ① 시장 소식
  if (process.env.DATA_GO_KR_KEY) {
    const last = {};
    let K = [];
    await Promise.all([
      kospiDaily(from).then((v) => (K = v)).catch(() => {}),
      ...UNIVERSE.map(([n]) => stockDaily(n, from).then((v) => { const r = v.rows; if (r.length > 1) last[n] = { d: r[r.length - 1][0], pct: (r[r.length - 1][2] / r[r.length - 2][2] - 1) * 100 }; }).catch(() => {})),
    ]);
    const md = (d) => `${Number(d.slice(4, 6))}월 ${Number(d.slice(6, 8))}일`;
    const movers = Object.entries(last).sort((a, b) => Math.abs(b[1].pct) - Math.abs(a[1].pct));
    const src = [{ title: "금융위원회 주식·지수 시세", url: "https://www.data.go.kr/data/15094808/openapi.do", source: "금융위원회" }];
    if (K.length > 1) {
      const [d, v] = K[K.length - 1], c = (v / K[K.length - 2][1] - 1) * 100;
      if (Math.abs(c) >= 1) pool.push({ id: `m-kospi-${d}`, kind: "market", sector: "시장 전체", dir: "swing", days: 3,
        title: `코스피가 ${md(d)} 하루 ${Math.abs(c).toFixed(1)}% ${c < 0 ? "떨어졌어요" : "올랐어요"}`,
        why: `시장 전체가 크게 움직인 날 뒤에는 며칠 더 출렁이기도 해요. 이날 가장 크게 움직인 대표 종목이에요.`,
        stocks: movers.slice(0, 3).map(([n]) => n), sources: src });
    }
    // 크게 움직인 대표 종목 (없으면 가장 많이 움직인 하나라도 → 힌트가 0개가 되지 않게)
    const big = movers.filter(([, x]) => Math.abs(x.pct) >= 4).slice(0, 2);
    for (const [n, x] of big.length ? big : movers.slice(0, 1)) pool.push({ id: `m-${n}-${x.d}`, kind: "market", sector: sectorOf[n], dir: "swing", days: 3,
      title: `${n}${/[가-힣]$/.test(n) && (n.charCodeAt(n.length - 1) - 44032) % 28 ? "이" : "가"} ${md(x.d)} 하루 ${x.pct > 0 ? "+" : ""}${x.pct.toFixed(1)}% 움직였어요`,
      why: `크게 움직인 종목은 다음 며칠 동안도 오르내림이 커질 수 있어요.`, stocks: [n], sources: src });
  }
  // ② 정책 소식 후보
  const cands = [];
  try {
    const rel = !process.env.DATA_GO_KR_KEY ? [] : (await pressReleases(7)).sort((x, y) => (relYmd(y.at) > relYmd(x.at) ? 1 : -1));
    const seen = new Set();
    for (const r of rel) {
      const d = relYmd(r.at);
      if ((d && d < ymdAdd(today, -6)) || !isEcon(r) || seen.has(r.title)) continue;
      const t = newsTone(`${r.title} ${r.sub}`);
      const secs = Object.entries(SECTORS).filter(([, S]) => S.words.some((w) => r.title.includes(w))).map(([k]) => k);
      if (!t || !secs.length) continue;
      seen.add(r.title);
      cands.push({ d, title: r.title, sub: r.sub, dir: t > 0 ? "up" : "down", sector: secs.map((k) => SECTORS[k].name).join(", "),
        stocks: UNIVERSE.filter(([, s]) => secs.includes(s)).map(([n]) => n), sources: [{ title: r.title, url: r.url, source: r.org || "정책브리핑" }] });
      if (cands.length >= 15) break;
    }
  } catch (e) { console.error("hint news", e.message); }
  // ③ 제미나이 검수
  let reviewed = false, news = cands;
  if (cands.length && process.env.GEMINI_API_KEY) {
    try {
      const list = UNIVERSE.map(([n, s]) => `${n}(${SECTORS[s].name})`).join(", ");
      const text = `종목 목록: ${list}\n\n후보:\n` + cands.map((c, i) => `[${i}] ${c.title} — ${c.sub || ""} (규칙이 고른 종목: ${c.stocks.join("·")}, 방향: ${c.dir})`).join("\n");
      const out = await generate({ system: REVIEW_RULES, text, schema: REVIEW_SCHEMA, schemaName: "review", maxTokens: 1500, geminiOnly: true });
      const names = new Set(UNIVERSE.map(([n]) => n));
      news = [];
      for (const it of JSON.parse(out.text).items || []) {
        const c = cands[it.i], stocks = (it.stocks || []).filter((n) => names.has(n)).slice(0, 3);
        if (!c || !it.keep || !stocks.length) continue;
        news.push({ ...c, stocks, dir: it.dir === "down" ? "down" : "up", why: String(it.why || "").slice(0, 80), sector: [...new Set(stocks.map((n) => sectorOf[n]))].join(", ") });
      }
      reviewed = true;
    } catch (e) { console.error("hint review", e.message); }
  }
  news.slice(0, 9).forEach((c, k) => pool.push({ id: `n-${k}-${c.d}-${c.title.length}`, kind: "news", sector: c.sector, dir: c.dir, days: 3 + Math.floor(seeded(c.title) * 5),
    title: c.title, why: c.why || "", stocks: c.stocks, sources: c.sources }));
  if (!pool.length) pool.push({ id: "s-chip", kind: "news", sector: "반도체", dir: "up", days: 5, title: "(예시) 반도체 쪽에 좋은 정부 발표가 나왔어요", stocks: ["삼성전자", "SK하이닉스"], sources: [] });
  return { pool, reviewed, at: new Date().toISOString() };
}

// ───────────────────────── 서버 관리자 일: 순위 검증 · 아침 알림 ─────────────────────────
// Firebase 서버용 열쇠(FIREBASE_SA, 서비스 계정 JSON)로 Firestore에 관리자로 들어간다(보안 규칙을 거치지 않음).
// 새 라이브러리 없이 Node 기본 crypto로 서명한다.
// · 순위: 휴대폰은 거래 기록만 invest/{시즌}/trades/{uid}에 올리고, 서버가 공식 종가로 다시 계산해 invest/{시즌}/players/{uid}에 쓴다.
//   (규칙: players는 서버만 쓰기, trades는 본인만) 산 가격이 그날 공식 종가와 다르거나 돈이 모자란 거래는 빼고 bad로 센다.
// · 알림: 웹 푸시(VAPID). 내용 없이 '깨우기'만 보내고, 휴대폰(sw.js)이 /api/market?push=today 로 문구를 받아 띄운다.
// GET  /api/market?cron=daily     → Vercel이 매일 아침(vercel.json) 부름: 순위 다시 계산 + 알림 보내기 (CRON_SECRET 확인)
// GET  /api/market?game=settle    → 순위 다시 계산 (10분에 한 번만 실제로 계산)
// POST /api/market?push=subscribe { endpoint } · ?push=unsubscribe { endpoint }
// GET  /api/market?push=today     → 알림 문구 { title, body }

const RATES_SV = { cma: 2.2, dep: 2.8, ktb3: 2.7, corp3: 3.3 }; // index.html RATES와 같은 게임 금리
const RATE_NAMES = { cma: "CMA", dep: "정기예금 1년", ktb3: "국고채 3년", corp3: "회사채 3년" };
// 로그인한 사람 확인: 휴대폰이 보낸 Firebase 로그인 표(ID token)를 Google에 물어 uid를 받는다
async function whoIs(req) {
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok || !process.env.FIREBASE_API_KEY) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: tok }), signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  return (await r.json()).users?.[0]?.localId || null;
}
// 다른 사람의 보유 종목: 나와 그 사람이 둘 다 공유에 동의했을 때만
async function holdOf(req, uid) {
  const me = await whoIs(req);
  if (!me) return { status: 401, body: { error: "로그인이 필요해요" } };
  const season = `${kstYmd(0).slice(0, 4)}-${kstYmd(0).slice(4, 6)}`;
  const mine = await fsReq(`investMeta/${me}`);
  if (fromFs(mine?.fields?.share) !== true) return { status: 403, body: { error: "내 투자 정보 공유에 동의하면 볼 수 있어요", need: "share" } };
  const doc = await fsReq(`privHold/${season}_${uid}`);
  if (!doc) return { status: 404, body: { error: "이 사람은 종목을 공유하지 않았어요" } };
  const f = fromFs({ mapValue: { fields: doc.fields || {} } });
  let hold = [];
  try { hold = JSON.parse(f.hold || "[]"); } catch {}
  return { status: 200, body: { hold, cash: f.cash, at: f.at } };
}
const usFs = { get: fsGetMany, set: fsSet };
const fsDel = (path) => fsReq(path, { method: "DELETE" });
const kstDay = (at) => new Date(at + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

// 순위 다시 계산: 시즌의 모든 거래 기록을 공식 종가로 따라가며 검증
async function settle(force) {
  const today = kstYmd(0), season = `${today.slice(0, 4)}-${today.slice(4, 6)}`;
  const meta = await fsReq(`invest/${season}`);
  const last = fromFs(meta?.fields?.settledAt) || 0;
  if (!force && Date.now() - last < 10 * 60e3) return { season, skipped: true };
  const players = await fsList(`invest/${season}/trades`);
  // 공유 동의·가입일 (investMeta/{uid}, 서버만 씀)
  const metas = players.length ? await fsGetMany(players.map((p) => `investMeta/${p.id}`), ["share", "joined"]).catch(() => ({})) : {};
  for (const p of players) { const mt = metas[`investMeta/${p.id}`]; if (mt) { p.share = mt.share; p.joined = mt.joined; } }
  const logs = {}, names = new Set();
  for (const p of players) {
    try { logs[p.id] = JSON.parse(p.log || "[]"); } catch { logs[p.id] = []; }
    for (const t of logs[p.id]) if (t?.kind === "stock") names.add(String(t.id));
  }
  const S = {}, from = ymdAdd(`${today.slice(0, 6)}01`, -10);
  const kr = [...names].filter((n) => !n.startsWith(US_PREFIX)), us = [...names].filter((n) => n.startsWith(US_PREFIX)).map((n) => n.slice(US_PREFIX.length));
  await Promise.all([
    ...kr.slice(0, 80).map((n) => stockDaily(n, from).then((v) => (S[n] = v.rows)).catch(() => {})),
    us.length && usReady() ? usSeries(usFs, us.slice(0, 80), from).then((R) => Object.assign(S, R.series)).catch((e) => console.error("settle us", e.message)) : null,
  ]);
  const now = Date.now(), YEAR = 365 * 86400e3;
  for (const p of players) {
    let cash = 10000000, bad = 0;
    const qty = {}, lots = [];
    for (const t of (logs[p.id] || []).filter((x) => x && x.at <= now + 60e3).sort((a, b) => a.at - b.at)) {
      if (t.kind === "stock") {
        const rows = S[t.id], d = kstDay(t.at);
        // 미국 종목은 날짜가 뉴욕 기준이고 종가가 하루 늦게 모일 수 있어서 마지막 3일 안에서 찾는다
        const fair = rows && Number.isInteger(t.qty) && t.qty > 0 && rows.filter((r) => r[0] <= d).slice(String(t.id).startsWith(US_PREFIX) ? -3 : -2).some((r) => r[2] === t.price);
        if (!fair) { bad++; continue; }
        if (t.side === "buy") { if (t.qty * t.price > cash + 1) { bad++; continue; } cash -= t.qty * t.price; qty[t.id] = (qty[t.id] || 0) + t.qty; }
        else { if ((qty[t.id] || 0) < t.qty) { bad++; continue; } cash += t.qty * t.price; qty[t.id] -= t.qty; }
      } else if (t.kind === "rate" && RATES_SV[t.id]) {
        if (t.side === "buy") { if (!(t.amt > 0) || t.amt > cash + 1) { bad++; continue; } cash -= t.amt; lots.push({ id: t.id, amt: t.amt, at: t.at }); }
        else {
          const mine = lots.filter((l) => l.id === t.id);
          if (!mine.length) { bad++; continue; }
          cash += mine.reduce((s, l) => s + l.amt * (1 + (RATES_SV[l.id] / 100) * Math.max(0, t.at - l.at) / YEAR), 0);
          for (let i = lots.length - 1; i >= 0; i--) if (lots[i].id === t.id) lots.splice(i, 1);
        }
      } else bad++;
    }
    let total = cash + lots.reduce((s, l) => s + l.amt * (1 + (RATES_SV[l.id] / 100) * Math.max(0, now - l.at) / YEAR), 0);
    // 투자 비중: 국내 주식·미국 주식·채권·예금·CMA·현금 %만 쓴다 (종목 이름은 순위표에 절대 쓰지 않음)
    const part = { kr: 0, us: 0, bond: 0, dep: 0, cash };
    for (const l of lots) part[l.id === "ktb3" || l.id === "corp3" ? "bond" : "dep"] += l.amt * (1 + (RATES_SV[l.id] / 100) * Math.max(0, now - l.at) / YEAR);
    for (const [id, q] of Object.entries(qty)) if (q > 0) { const r = S[id], v = q * (r?.length ? r[r.length - 1][2] : 0); total += v; part[id.startsWith(US_PREFIX) ? "us" : "kr"] += v; }
    total = Math.round(total);
    const mix = Object.fromEntries(Object.entries(part).map(([k, v]) => [k, total > 0 ? Math.round((v / total) * 100) : 0]));
    const share = p.share === true, joined = /^\d{4}-\d{2}-\d{2}$/.test(String(p.joined || "")) ? p.joined : null;
    await fsSet(`invest/${season}/players/${p.id}`, { nick: String(p.nick || "익명").slice(0, 12), total, ret: Math.round((total / 1e7 - 1) * 10000) / 100, at: now, verified: true, bad, mix, share, joined });
    // 보유 종목은 공유에 동의한 사람만, 순위표와 다른 곳(privHold)에 둔다. 읽을 때는 /api/market?game=hold 가 '둘 다 동의했는지' 확인한다
    if (share) {
      const hold = Object.entries(qty).filter(([, q]) => q > 0).map(([id, q]) => { const r = S[id]; return { id, name: id.startsWith(US_PREFIX) ? usName(id.slice(US_PREFIX.length)) : id, qty: q, value: Math.round(q * (r?.length ? r[r.length - 1][2] : 0)) }; })
        .concat(Object.values(lots.reduce((o, l) => { const v = l.amt * (1 + (RATES_SV[l.id] / 100) * Math.max(0, now - l.at) / YEAR); (o[l.id] ||= { id: l.id, name: RATE_NAMES[l.id], qty: 0, value: 0 }).value += Math.round(v); return o; }, {})))
        .sort((a, b) => b.value - a.value);
      await fsSet(`privHold/${season}_${p.id}`, { hold: JSON.stringify(hold), cash: Math.round(cash), at: now });
    } else await fsDel(`privHold/${season}_${p.id}`).catch(() => {});
  }
  await fsSet(`invest/${season}`, { settledAt: now, players: players.length });
  return { season, players: players.length };
}

// 웹 푸시: 내용 없이 VAPID 서명만 붙여 보낸다 (내용이 없으면 암호화가 필요 없다)
function vapidHeaders(endpoint) {
  const pub = process.env.VAPID_PUBLIC, raw = Buffer.from(pub, "base64url");
  const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: process.env.VAPID_PRIVATE, x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") }, format: "jwk" });
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://aimvpclass1.vercel.app" })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { Authorization: `vapid t=${unsigned}.${sig}, k=${pub}`, TTL: "43200", Urgency: "normal", "Content-Length": "0" };
}
const subId = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 40);
async function pushAll() {
  const subs = await fsList("pushSubs");
  let sent = 0, gone = 0;
  for (let i = 0; i < subs.length; i += 10) {
    await Promise.all(subs.slice(i, i + 10).map(async (s) => {
      try {
        const r = await fetch(s.endpoint, { method: "POST", headers: vapidHeaders(s.endpoint), body: "", signal: AbortSignal.timeout(8000) });
        if (r.status === 404 || r.status === 410) { gone++; await fsDel(`pushSubs/${s.id}`); } else if (r.ok) sent++;
      } catch (e) { console.error("push", e.message); }
    }));
  }
  return { subs: subs.length, sent, gone };
}
// 알림 문구: 실제 코스피 마지막 거래일 움직임 + 앱으로 오라는 말
async function pushToday() {
  let body = "오늘 나에게 중요한 3가지를 1분 만에 확인해 보세요.";
  try {
    const K = await kospiDaily(kstYmd(10));
    if (K.length > 1) {
      const [d, v] = K[K.length - 1], c = (v / K[K.length - 2][1] - 1) * 100;
      body = `코스피 ${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))} ${c > 0 ? "+" : ""}${c.toFixed(1)}%. 오늘 나에게 중요한 3가지를 1분 만에 확인해 보세요.`;
    }
  } catch {}
  return { title: "루미의 아침 1분", body };
}

export default async function handler(req, res) {
  const hasData = !!process.env.DATA_GO_KR_KEY;
  const hasExim = !!process.env.KOREAEXIM_KEY;
  const hasEcos = !!process.env.ECOS_KEY;

  // 매일 아침 자동 실행 (vercel.json crons): 순위 다시 계산 + 아침 알림
  if (req.query.cron === "daily") {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "no" });
    const out = {};
    if (adminReady()) {
      if (usReady()) { try { out.us = await usFill(usFs, ymdAdd(`${kstYmd(0).slice(0, 6)}01`, -10), 4); } catch (e) { out.us = { error: e.message.slice(0, 80) }; } }
      try { out.settle = await settle(true); } catch (e) { out.settle = { error: e.message.slice(0, 80) }; }
      if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) { try { out.push = await pushAll(); } catch (e) { out.push = { error: e.message.slice(0, 80) }; } }
    }
    return res.status(200).json(out);
  }
  // 내 투자 정보 공유 켜기·끄기 (+ 가입일). 로그인 표로 본인 확인 뒤 저장하고, 순위를 바로 다시 계산한다
  if (req.query.game === "share") {
    if (req.method !== "POST" || !adminReady()) return res.status(400).json({ error: "잘못된 요청이에요" });
    try {
      const me = await whoIs(req);
      if (!me) return res.status(401).json({ error: "로그인이 필요해요" });
      const share = req.body?.share === true, joined = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.joined || "")) ? req.body.joined : null;
      await fsSet(`investMeta/${me}`, { share, joined, at: Date.now() });
      await settle(true).catch((e) => console.error("settle after share", e.message));
      return res.status(200).json({ ok: true, share });
    } catch (e) { console.error(e); return res.status(200).json({ error: "공유 설정을 저장하지 못했어요" }); }
  }
  if (req.query.game === "hold") {
    if (!adminReady()) return res.status(200).json({ error: "아직 준비 중이에요" });
    const uid = String(req.query.uid || "");
    if (!/^[A-Za-z0-9]{10,64}$/.test(uid)) return res.status(400).json({ error: "잘못된 요청이에요" });
    res.setHeader("Cache-Control", "no-store");
    try { const r = await holdOf(req, uid); return res.status(r.status).json(r.body); } catch (e) { console.error(e); return res.status(200).json({ error: "불러오지 못했어요" }); }
  }
  if (req.query.game === "settle") {
    if (!adminReady()) return res.status(200).json({ available: false });
    try { return res.status(200).json(await settle(false)); } catch (e) { console.error(e); return res.status(200).json({ error: "순위를 계산하지 못했어요" }); }
  }
  if (req.query.push === "today") { cache(res, 1800); return res.status(200).json(await pushToday()); }
  if (req.query.push === "subscribe" || req.query.push === "unsubscribe") {
    const endpoint = String(req.body?.endpoint || "");
    if (req.method !== "POST" || !/^https:\/\/[^\s]{10,600}$/.test(endpoint)) return res.status(400).json({ error: "잘못된 요청이에요" });
    if (!adminReady()) return res.status(200).json({ available: false });
    try {
      if (req.query.push === "subscribe") await fsSet(`pushSubs/${subId(endpoint)}`, { endpoint, at: Date.now() });
      else await fsDel(`pushSubs/${subId(endpoint)}`);
      return res.status(200).json({ ok: true });
    } catch (e) { console.error(e); return res.status(200).json({ error: "알림 설정을 저장하지 못했어요" }); }
  }
  if (req.query.game === "hints") {
    try {
      const out = await gameHints();
      cache(res, out.reviewed ? 3600 : 600);
      return res.status(200).json(out);
    } catch (e) {
      console.error(e);
      return res.status(200).json({ pool: [], error: "힌트를 만들지 못했어요" });
    }
  }
  if (req.query.game !== undefined) {
    try {
      const extra = String(req.query.extra || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 14);
      const out = await realMarket(extra);
      cache(res, out.sample ? 120 : 600); // 새 종가가 올라오면 10분 안에 보이게
      return res.status(200).json(out);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "가상 시장을 불러오지 못했어요" });
    }
  }

  if (req.query.search !== undefined) {
    const q = String(req.query.search).trim().slice(0, 20);
    if (!q) return res.status(200).json({ results: [] });
    if (!hasData && !usReady()) return res.status(200).json({ results: [], sample: true });
    try {
      cache(res, 3600);
      const [kr, us] = await Promise.all([hasData ? search(q).catch(() => []) : [], req.query.kr ? [] : usSearch(q).catch(() => [])]);
      return res.status(200).json({ results: [...kr, ...us] });
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
  out.src = {};
  const tasks = [];
  // 지수: 한국은행 ECOS와 금융위원회 중 날짜가 최근인 값 (둘 다 하루 늦게 올라온다. 한국거래소 OPEN API는 약관상 제3자 제공 금지라 쓰지 않음)
  const pick = (k, name, code) => tasks.push(Promise.all([
    hasEcos ? ecos("802Y001", code).catch((e) => (console.error(k, "ecos", e.message), null)) : null,
    hasData ? index(name).catch((e) => (console.error(k, "fsc", e.message), (out.note ||= String(e.message).slice(0, 80)), null)) : null,
  ]).then(([a, b]) => { const v = newest(a, b); if (v) { out[k] = v; if (k === "kospi") out.src.index = v === a ? "ecos" : "fsc"; } }));
  pick("kospi", "코스피", "0001000");
  pick("kosdaq", "코스닥", "0089000");
  // 환율: 수출입은행은 영업일 오전 11시쯤 그날 값을 올리고, ECOS는 더 늦다. 둘 다 있으면 날짜가 최근인 쪽
  tasks.push(Promise.all([
    hasExim ? usd().catch((e) => (console.error("usd exim", e.message), null)) : null,
    hasEcos ? ecos("731Y001", "0000001").catch((e) => (console.error("usd ecos", e.message), null)) : null,
  ]).then(([a, b]) => { const v = newest(a, b); if (v) { out.usd = v; out.src.usd = v === a ? "exim" : "ecos"; } }));
  if (hasData) tasks.push(Promise.all(names.map((n) => stock(n).catch(() => ({ name: n, missing: true })))).then((v) => (out.stocks = v)));
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

  cache(res, out.sample ? 60 : 600); // 새 종가가 올라오면 10분 안에 보이게
  res.status(200).json(out);
}
