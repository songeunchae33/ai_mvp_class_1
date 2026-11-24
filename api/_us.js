// 모의투자 미국 주식: Massive(옛 Polygon) 무료 등급의 하루 종가 + 유럽중앙은행 기준 환율(Frankfurter)로 원화 값을 만든다.
// 파일명이 _로 시작해서 주소(엔드포인트)는 생기지 않는다. api/market.js가 쓴다.
// - Massive 무료 등급은 1분에 5번만 부를 수 있어서, '그날 미국 전 종목 시가·종가'(grouped daily)를 날마다 한 번만 받아
//   Firestore usDays/{YYYYMMDD}에 종목마다 한 칸("시가,종가")으로 모아 둔다. 읽을 때는 필요한 종목 칸만 골라 읽는다(mask).
// - 무료 등급은 개인·비상업 용도. 광고·구독을 붙이기 전에 국내 시세(공공누리 제4유형)와 함께 다시 검토한다.
// - 원화 값 = 그날 종가(달러) × 그날 이전 가장 최근 유럽중앙은행 기준 환율, 원 단위 반올림. 순위 검증도 같은 계산을 쓴다.
import { fetchJson } from "./_util.js";

export const US_PREFIX = "US:";
export const usReady = () => !!process.env.MASSIVE_KEY;
// 모의투자 첫 화면의 미국 대표 종목 12개 [티커, 한글 이름, 업종]
export const US_CORE = [
  ["AAPL", "애플", "기술"], ["MSFT", "마이크로소프트", "기술"], ["NVDA", "엔비디아", "반도체"], ["TSLA", "테슬라", "자동차"],
  ["AMZN", "아마존", "쇼핑·클라우드"], ["GOOGL", "알파벳(구글)", "인터넷"], ["META", "메타", "인터넷"], ["NFLX", "넷플릭스", "콘텐츠"],
  ["KO", "코카콜라", "식품"], ["SBUX", "스타벅스", "외식"], ["DIS", "디즈니", "콘텐츠"], ["NKE", "나이키", "의류"],
];
export const US_INDEX = "SPY"; // 미국 대표 지수 S&P 500을 따라가는 ETF. 미국 종목 평가의 비교 기준
// 한글로 찾을 수 있게 자주 찾는 회사 이름
const KO = {
  ...Object.fromEntries(US_CORE.map(([t, n]) => [n, t])), 구글: "GOOGL", 알파벳: "GOOGL", 페이스북: "META", 맥도날드: "MCD", 코스트코: "COST", 월마트: "WMT",
  AMD: "AMD", 인텔: "INTC", 퀄컴: "QCOM", 브로드컴: "AVGO", 오라클: "ORCL", 어도비: "ADBE", 세일즈포스: "CRM", 팔란티어: "PLTR", 코인베이스: "COIN",
  우버: "UBER", 에어비앤비: "ABNB", 비자: "V", 마스터카드: "MA", JP모건: "JPM", 존슨앤드존슨: "JNJ", 화이자: "PFE", 일라이릴리: "LLY", 펩시: "PEP",
  보잉: "BA", 쿠팡: "CPNG", 스포티파이: "SPOT", 로블록스: "RBLX", TSMC: "TSM", ASML: "ASML", 아이온큐: "IONQ", 마이크로스트래티지: "MSTR",
  "S&P500": "SPY", 에스앤피: "SPY", 나스닥: "QQQ", 버라이즌: "VZ", 펠로톤: "PTON", 루시드: "LCID", 리비안: "RIVN", 쇼피파이: "SHOP", 줌: "ZM",
};
const KO_OF = Object.fromEntries(Object.entries(KO).filter(([k]) => /[가-힣]/.test(k)).map(([k, t]) => [t, k]));
for (const [t, n] of US_CORE) KO_OF[t] = n;
export const usName = (ticker) => KO_OF[ticker] || ticker;
const okTicker = (t) => /^[A-Z]{1,5}$/.test(t);

// 뉴욕 날짜 (YYYYMMDD)
export function nyYmd(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400e3);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replace(/-/g, "");
}
const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
function weekdays(from, to) {
  const out = [];
  for (let t = new Date(`${iso(from)}T00:00:00Z`); ; t.setUTCDate(t.getUTCDate() + 1)) {
    const d = t.toISOString().slice(0, 10).replace(/-/g, "");
    if (d > to) break;
    if (t.getUTCDay() % 6) out.push(d);
  }
  return out;
}

// ── 환율: 유럽중앙은행 기준 환율(Frankfurter, 키 없음). 한 번에 기간 전체를 받는다 ──
let fxMemo = null;
async function fxTable(from) {
  if (fxMemo && fxMemo.from <= from && Date.now() - fxMemo.at < 3 * 3600e3) return fxMemo.rows;
  const start = new Date(`${iso(from)}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 10);
  const j = await fetchJson(`https://api.frankfurter.dev/v1/${start.toISOString().slice(0, 10)}..?base=USD&symbols=KRW`, {}, 6000);
  const rows = Object.entries(j.rates || {}).map(([d, r]) => [d.replace(/-/g, ""), r.KRW]).filter((x) => x[1] > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!rows.length) throw new Error("환율 없음");
  fxMemo = { from, at: Date.now(), rows };
  return rows;
}
const fxOn = (rows, d) => { let v = null; for (const [k, r] of rows) { if (k > d) break; v = r; } return v ?? rows[0][1]; };

// ── 하루 종가 모으기 (Firestore usDays) ──
// fs: market.js가 넘겨주는 { get(paths, fields) → { path: fields|null }, set(path, data) }
async function grouped(d) {
  const j = await fetchJson(`https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/${iso(d)}?adjusted=true&apiKey=${encodeURIComponent(process.env.MASSIVE_KEY)}`, {}, 8000);
  const day = { _n: 0 };
  for (const r of j.results || []) {
    // 거래가 아주 적은 종목은 뺀다(문서 크기를 줄이려고). 대표 종목·지수는 늘 남긴다
    if (!okTicker(r.T) || !(r.c > 0) || !(r.o > 0)) continue;
    if (r.v * r.c < 2e6 && !US_CORE.some(([t]) => t === r.T) && r.T !== US_INDEX) continue;
    day[r.T] = `${+r.o.toFixed(4)},${+r.c.toFixed(4)}`;
    day._n++;
  }
  return day;
}
// 빠진 날을 budget번까지 채운다 (새 날부터). 주말·휴장일은 _n 0으로 남겨 다시 부르지 않는다
export async function usFill(fs, from, budget = 2) {
  if (!usReady()) return 0;
  const days = weekdays(from, nyYmd(1)).reverse();
  const have = await fs.get(days.map((d) => `usDays/${d}`), ["_n"]);
  let n = 0;
  for (const d of days) {
    if (n >= budget) break;
    const h = have[`usDays/${d}`];
    if (h && (h._n > 0 || d < nyYmd(4))) continue; // 최근 며칠이 비어 있으면(아직 안 모였을 수도) 다시 받아 본다
    try { await fs.set(`usDays/${d}`, await grouped(d)); n++; }
    catch (e) { console.error("us grouped", d, e.message); break; } // 429면 다음 기회에
  }
  return n;
}
// 종목마다 [[YYYYMMDD, 시가, 종가]] (달러, 오래된 날부터)
async function usdRows(fs, tickers, from) {
  const days = weekdays(from, nyYmd(1));
  const got = await fs.get(days.map((d) => `usDays/${d}`), tickers);
  const out = Object.fromEntries(tickers.map((t) => [t, []]));
  for (const d of days) {
    const f = got[`usDays/${d}`];
    if (!f) continue;
    for (const t of tickers) if (typeof f[t] === "string") { const [o, c] = f[t].split(",").map(Number); out[t].push([d, o, c]); }
  }
  return out;
}
// 원화 시리즈: { "US:AAPL": [[날짜, 시가원, 종가원]] } + 달러 시리즈 + 최근 환율
export async function usSeries(fs, tickers, from) {
  tickers = [...new Set(tickers.filter(okTicker))];
  if (!tickers.length || !usReady()) return { series: {}, usd: {}, fx: null };
  const [rows, fx] = await Promise.all([usdRows(fs, tickers, from), fxTable(from)]);
  const series = {}, usd = {};
  for (const [t, r] of Object.entries(rows)) {
    if (!r.length) continue;
    usd[US_PREFIX + t] = r;
    series[US_PREFIX + t] = r.map(([d, o, c]) => { const x = fxOn(fx, d); return [d, Math.round(o * x), Math.round(c * x)]; });
  }
  const last = fx[fx.length - 1];
  return { series, usd, fx: { v: last[1], date: last[0] } };
}
// 검색: 한글 이름 먼저, 영어·티커는 Massive 종목 목록에서 (1번 부름)
export async function usSearch(q) {
  if (!usReady()) return [];
  const s = q.trim(), up = s.toUpperCase();
  const out = new Map();
  for (const [k, t] of Object.entries(KO)) if (k.toUpperCase().includes(up) || t === up) out.set(t, usName(t));
  if (/^[A-Za-z .&-]{1,20}$/.test(s)) {
    try {
      const j = await fetchJson(`https://api.massive.com/v3/reference/tickers?search=${encodeURIComponent(s)}&market=stocks&active=true&limit=12&apiKey=${encodeURIComponent(process.env.MASSIVE_KEY)}`, {}, 6000);
      for (const r of j.results || []) if (okTicker(r.ticker) && !out.has(r.ticker)) out.set(r.ticker, KO_OF[r.ticker] || r.name);
    } catch (e) { console.error("us search", e.message); }
  }
  return [...out.entries()].sort((a, b) => (b[0] === up) - (a[0] === up)).slice(0, 8)
    .map(([t, name]) => ({ name, id: US_PREFIX + t, market: `미국 · ${t}` }));
}
