// 시세: 코스피·코스닥 지수와 원/달러 환율은 한국은행 ECOS(ECOS_KEY), 관심 종목은 공공데이터포털 금융위원회(전일 종가).
// ECOS_KEY가 아직 없으면 지수는 금융위원회, 환율은 한국수출입은행으로 예전처럼 받는다.
// GET /api/market?stocks=삼성전자,카카오   → 홈 화면 데이터
// GET /api/market?search=삼성              → 종목 이름 검색 (관심 종목 추가용)
// GET /api/market?game=1                   → 모의투자 '가상 시장' (가상 기업 10곳, 실제 정부 보도자료에 반응하는 가격, api/_game 참고 아래)
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

// ───────────────────────── 모의투자 '가상 시장' ─────────────────────────
// 실제 주가는 한국거래소 자료라 앱 화면에 다시 보여줄 수 없어서(공공누리 제4유형), 가상 기업 10곳으로 겨룬다.
// 가격은 실제 정부 보도자료(정책브리핑, 공공저작물)에 반응한다: 날마다 업종별 좋은 소식·나쁜 소식을 세고,
// 그 소식이 하루~나흘 뒤 가격에 조금씩 반영된다(힌트를 보고 판단할 시간이 있게). 나머지는 정해진 무작위.
// 같은 날·같은 시즌이면 누구에게나 같은 값이 나온다(순위가 공정하게). GAME_SECRET이 있으면 폭탄주를 미리 계산할 수 없다.
// 수상한 두 회사(대박바이오·번쩍에너지) 중 하나가 시즌마다 '폭탄주': 부실을 숨기고 오르다가 시즌 중간(12~26일)에 크게 떨어진다.
const GAME_SECRET = process.env.GAME_SECRET || "lumi-market";
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
const POS = ["호조", "증가", "확대", "지원", "성장", "최대", "개선", "상승", "회복", "활성화", "타결", "완화", "육성", "유치", "기대", "흑자"];
const NEG = ["감소", "둔화", "하락", "규제", "위기", "우려", "적자", "부진", "축소", "단속", "과징금", "제재", "피해", "중단"];
const COMPANIES = [
  { id: "lumichip", name: "루미반도체", sector: "chip", base: 82000, vol: 0.02, sens: 1.2, desc: "메모리 반도체를 만들어요. AI 서버가 늘면 많이 팔려요.",
    info: { debt: "45%", op: "흑자 · 1년 1.8조 원", sales: "+12%", audit: "적정", notice: "새 공장 투자를 발표했어요" } },
  { id: "saessak", name: "새싹자동차", sector: "car", base: 64000, vol: 0.015, sens: 1, desc: "자동차를 만들어 해외에 많이 팔아요. 수출·관세 소식에 움직여요.",
    info: { debt: "110%", op: "흑자 · 1년 9,800억 원", sales: "+6%", audit: "적정", notice: "해외 공장 가동을 시작했어요" } },
  { id: "dundun", name: "든든은행", sector: "bank", base: 21000, vol: 0.01, sens: 0.8, desc: "예금을 받아 대출해 주고 이자 차이로 벌어요. 금리 소식에 민감해요.",
    info: { debt: "은행은 따로 봐요", op: "흑자 · 1년 2.4조 원", sales: "+3%", audit: "적정", notice: "배당을 늘린다고 했어요" } },
  { id: "banjjak", name: "반짝배터리", sector: "battery", base: 45000, vol: 0.022, sens: 1.1, desc: "전기차 배터리를 만들어요. 전기차가 잘 팔리면 같이 커요.",
    info: { debt: "150%", op: "흑자 · 1년 2,100억 원", sales: "-4%", audit: "적정", notice: "유럽 공장 증설을 미뤘어요" } },
  { id: "kkuljaem", name: "꿀잼엔터", sector: "content", base: 28000, vol: 0.019, sens: 1.1, desc: "드라마·예능·공연을 만들어요. 한류와 관광 소식에 움직여요.",
    info: { debt: "70%", op: "흑자 · 1년 650억 원", sales: "+18%", audit: "적정", notice: "해외 공동제작 계약을 맺었어요" } },
  { id: "teunteun", name: "튼튼건설", sector: "build", base: 17000, vol: 0.014, sens: 1, desc: "아파트와 도로를 지어요. 주택 공급·부동산 정책에 따라 움직여요.",
    info: { debt: "190% (건설사는 원래 높은 편)", op: "흑자 · 1년 1,200억 원", sales: "+2%", audit: "적정", notice: "신도시 공사를 따냈어요" } },
  { id: "basak", name: "바삭식품", sector: "food", base: 36000, vol: 0.008, sens: 0.6, desc: "과자와 라면을 만들어요. 경기가 나빠도 잘 안 흔들리는 편이에요.",
    info: { debt: "60%", op: "흑자 · 1년 900억 원", sales: "+5%", audit: "적정", notice: "원재료 값이 올라 가격 인상을 검토해요" } },
  { id: "gureum", name: "구름플랫폼", sector: "platform", base: 52000, vol: 0.018, sens: 1, desc: "메신저와 쇼핑 앱을 운영해요. 디지털·AI 정책에 민감해요.",
    info: { debt: "55%", op: "흑자 · 1년 1,500억 원", sales: "+9%", audit: "적정", notice: "AI 비서 서비스를 내놨어요" } },
  { id: "daebak", name: "대박바이오", sector: "bio", base: 15000, vol: 0.028, sens: 1.3, suspect: true, desc: "신약을 개발해요. 성공하면 크게 오르지만 실패하면 크게 떨어져요." },
  { id: "beonjjeok", name: "번쩍에너지", sector: "battery", base: 9000, vol: 0.028, sens: 1.3, suspect: true, desc: "새로운 배터리 소재를 개발한다고 해요. 요즘 관심이 많아요." },
];
// 폭탄주의 기업 정보(단서): 빚이 많고, 적자인데 매출만 크게 늘고, 감사인이 '계속기업 불확실성'을 적었고, 대표가 주식을 판다
const BOMB_INFO = { debt: "380%", op: "3년째 적자 · 1년 -380억 원", sales: "+85%", audit: "적정이지만 '계속기업 불확실성'이 적혀 있어요", notice: "대표가 자기 주식을 일부 팔았어요 · 전환사채를 또 발행했어요" };
// 수상하지만 실제로는 괜찮은 회사의 정보: 위험해 보이지만 숫자는 나아지는 중
const HONEST_INFO = { debt: "140%", op: "적자가 줄어드는 중 · 1년 -40억 원", sales: "+35%", audit: "적정", notice: "새 제품 시험 결과를 곧 발표해요" };

function seeded(...k) { // 0~1 사이 정해진 무작위 (같은 열쇠면 같은 값)
  let h = 2166136261;
  for (const ch of `${GAME_SECRET}|${k.join("|")}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
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
function roundPrice(v) { return v >= 10000 ? Math.round(v / 50) * 50 : v >= 1000 ? Math.round(v / 10) * 10 : Math.round(v); }

async function virtualMarket() {
  const today = kstYmd(0), season = `${today.slice(0, 4)}-${today.slice(4, 6)}`;
  const start = `${today.slice(0, 6)}01`;
  const days = [];
  for (let d = start; d <= today; d = ymdAdd(d, 1)) days.push(d);
  // 업종별 그날의 소식 점수(-2~2)와 근거 보도자료
  const sig = {}, news = {};
  let sample = !process.env.DATA_GO_KR_KEY;
  if (!sample) {
    try {
      const rel = await pressReleases(Math.min(35, days.length + 5));
      if (!rel.length) sample = true;
      for (const r of rel) {
        const d = relYmd(r.at), text = `${r.title} ${r.sub}`, t = newsTone(text);
        if (!d || !t) continue;
        for (const [sec, S] of Object.entries(SECTORS)) if (S.words.some((w) => text.includes(w))) {
          const k = `${sec}|${d}`;
          sig[k] = Math.max(-2, Math.min(2, (sig[k] || 0) + t));
          (news[k] ||= []).push({ title: r.title, url: r.url, org: r.org, tone: t });
        }
      }
    } catch (e) { console.error("game news", e.message); sample = true; }
  }
  if (sample) for (const sec of Object.keys(SECTORS)) for (let d = ymdAdd(start, -5); d <= today; d = ymdAdd(d, 1)) {
    const x = seeded("sample", sec, d);
    if (x < 0.12) sig[`${sec}|${d}`] = -1; else if (x > 0.86) sig[`${sec}|${d}`] = 1;
  }
  const S = (sec, d) => sig[`${sec}|${d}`] || 0;
  const secs = Object.keys(SECTORS);
  const allSig = (d) => secs.reduce((s, sec) => s + S(sec, d), 0) / secs.length;

  const bomb = seeded(season, "bomb") < 0.5 ? "daebak" : "beonjjeok";
  const crashAt = 11 + Math.floor(seeded(season, "crash") * 15); // 12~26일
  const series = {}, info = {};
  for (const c of COMPANIES) {
    let prev = c.base * (0.95 + seeded(season, c.id, "start") * 0.1);
    const rows = [];
    days.forEach((d, i) => {
      let effect = 0;
      for (let lag = 1; lag <= 4; lag++) effect += S(c.sector, ymdAdd(d, -lag)) * 0.0035 * c.sens * (1 - (lag - 1) * 0.2);
      const mkt = (seeded(season, "mkt", d) - 0.5) * 0.012 + allSig(ymdAdd(d, -1)) * 0.003;
      const noise = (seeded(season, c.id, d) - 0.5) * 2 * c.vol;
      let r = effect + mkt + noise + 0.0003 - (prev / c.base - 1) * 0.02; // 너무 멀리 가면 조금씩 제자리로
      if (c.id === bomb) {
        if (i < crashAt) r = Math.abs(r) * 0.6 + 0.012;
        else if (i === crashAt) r = -0.55;
        else if (i <= crashAt + 3) r = -0.04 + noise * 0.5;
      }
      const open = roundPrice(prev * (1 + (seeded(season, c.id, d, "gap") - 0.5) * 0.01 + effect * 0.4));
      const close = roundPrice(Math.max(100, prev * (1 + r)));
      rows.push([d, open, close]);
      prev = close;
    });
    series[c.id] = rows;
    info[c.id] = c.suspect ? (c.id === bomb ? BOMB_INFO : HONEST_INFO) : c.info;
  }
  // 가상 시장 지수(루미지수): 수상한 두 회사를 뺀 8곳의 평균 변화, 시즌 첫날 시가 = 1,000
  const core = COMPANIES.filter((c) => !c.suspect);
  const index = days.map((d, i) => [d, Math.round((core.reduce((s, c) => s + series[c.id][i][2] / series[c.id][0][1], 0) / core.length) * 100000) / 100]);
  // 힌트 묶음: 오늘·어제 보도자료 소식 + 수상한 회사의 '소문'(근거 없음). 사람마다 이 중 몇 개를 무작위로 본다
  const pool = [];
  for (const d of [today, ymdAdd(today, -1)]) for (const sec of secs) for (const [j, n] of (news[`${sec}|${d}`] || []).slice(0, 2).entries()) {
    const cos = COMPANIES.filter((c) => c.sector === sec && !c.suspect).map((c) => c.id);
    pool.push({ id: `n-${sec}-${d}-${j}`, kind: "news", sector: SECTORS[sec].name, dir: n.tone > 0 ? "up" : "down", days: 3 + Math.floor(seeded(d, sec, j) * 3),
      title: n.title, stocks: cos.length ? cos : COMPANIES.filter((c) => c.sector === sec).map((c) => c.id), sources: [{ title: n.title, url: n.url, source: n.org || "정책브리핑" }] });
  }
  if (sample) for (const sec of secs) if (S(sec, today) || S(sec, ymdAdd(today, -1))) {
    const v = S(sec, today) || S(sec, ymdAdd(today, -1));
    pool.push({ id: `s-${sec}-${today}`, kind: "news", sector: SECTORS[sec].name, dir: v > 0 ? "up" : "down", days: 4,
      title: `(예시) ${SECTORS[sec].name} 쪽에 ${v > 0 ? "좋은" : "나쁜"} 정부 발표가 나왔어요`, stocks: COMPANIES.filter((c) => c.sector === sec && !c.suspect).map((c) => c.id), sources: [] });
  }
  for (const c of COMPANIES.filter((x) => x.suspect)) pool.push({ id: `r-${c.id}-${today}`, kind: "rumor", sector: SECTORS[c.sector].name, dir: "up", days: 7,
    title: `"${c.name} 곧 몇 배 간다"는 소문이 돌아요`, stocks: [c.id], sources: [] });
  const crashed = days.length > crashAt ? { id: bomb, day: days[crashAt] } : null;
  return {
    season, today, sample, index, series, crashed,
    companies: COMPANIES.map((c) => ({ id: c.id, name: c.name, sector: SECTORS[c.sector].name, desc: c.desc, suspect: !!c.suspect, info: info[c.id] })),
    pool,
  };
}

export default async function handler(req, res) {
  const hasData = !!process.env.DATA_GO_KR_KEY;
  const hasExim = !!process.env.KOREAEXIM_KEY;
  const hasEcos = !!process.env.ECOS_KEY;

  if (req.query.game !== undefined) {
    try {
      const out = await virtualMarket();
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
