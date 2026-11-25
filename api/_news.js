// 뉴스 API들이 같이 쓰는 도구. 파일명이 _로 시작해서 주소로 노출되지 않는다.
// 출처를 여러 곳으로 나눈다(한 곳이 막혀도 뉴스가 끊기지 않게): 정책브리핑 보도자료(api/_policy.js)
// · GDELT(전 세계 뉴스 목록, 무료 공개 데이터, 해외 뉴스) · NewsData.io(NEWSDATA_KEY가 있을 때만, 무료 등급 하루 200번).
// 모두 제목과 링크만 보여준다(본문 없음, 네이버·NewsData 결과는 AI 요약에 쓰지 않음).
import { fetchJson, adminReady, fsReq, fromFs, fsSet } from "./_util.js";

// 취향(선호) → 그 사람에게 의미 있는 뉴스 검색어
export const PREF_QUERY = {
  쇼핑: "소비 물가",
  여행: "환율 여행",
  음식: "외식 물가",
  자기계발: "청년 정책",
  저축: "예금 금리",
  부동산: "부동산 금리",
  취미: "소비 트렌드",
  // 돈 목표
  비상금: "예금 금리", "첫 투자": "ETF 투자", "내 집 마련": "청약 전세", "대출 갚기": "대출 금리",
  "여행 자금": "환율 여행", "취업·이직": "청년 취업", "노후·연금": "연금",
  // 관심 분야
  반도체: "반도체", "2차전지": "2차전지", AI: "인공지능", 바이오: "바이오", 자동차: "자동차 수출", "게임·엔터": "게임 엔터", "은행·금융": "은행 금융",
};

// 오늘의 키워드 후보 (제목에 많이 나온 순으로 3개)
const TERMS = [
  "기준금리", "금리", "환율", "FOMC", "연준", "금통위", "코스피", "코스닥", "반도체", "2차전지", "배터리", "AI",
  "부동산", "전세", "청약", "물가", "인플레이션", "관세", "수출", "유가", "달러", "엔화", "비트코인", "실적",
  "배당", "공모주", "IPO", "채권", "국채", "고용", "소비", "무역", "외국인", "공매도", "ETF", "가계부채", "트럼프",
];

const SOURCES = {
  "hankyung.com": "한국경제", "mk.co.kr": "매일경제", "yna.co.kr": "연합뉴스", "chosun.com": "조선일보",
  "joongang.co.kr": "중앙일보", "donga.com": "동아일보", "hani.co.kr": "한겨레", "khan.co.kr": "경향신문",
  "sedaily.com": "서울경제", "edaily.co.kr": "이데일리", "mt.co.kr": "머니투데이", "fnnews.com": "파이낸셜뉴스",
  "heraldcorp.com": "헤럴드경제", "asiae.co.kr": "아시아경제", "newsis.com": "뉴시스", "news1.kr": "뉴스1",
  "biz.chosun.com": "조선비즈", "kbs.co.kr": "KBS", "imbc.com": "MBC", "sbs.co.kr": "SBS", "ytn.co.kr": "YTN",
  "yonhapnewstv.co.kr": "연합뉴스TV", "nocutnews.co.kr": "노컷뉴스", "etnews.com": "전자신문", "bizwatch.co.kr": "비즈니스워치",
};

export function clean(s) {
  return hanjaKo(String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim());
}

// 제목에 자주 쓰는 한자를 한글로 (李대통령 → 이대통령, 美 연준 → 미 연준). 金은 金값·金리처럼 돈 이야기면 '금', 아니면 '김'
const HANJA = {
  李: "이", 尹: "윤", 文: "문", 朴: "박", 盧: "노", 崔: "최", 鄭: "정", 韓: "한", 美: "미", 中: "중", 日: "일", 北: "북", 南: "남",
  與: "여", 野: "야", 英: "영", 佛: "프", 獨: "독", 露: "러", 印: "인", 伊: "이", 靑: "청", 檢: "검", 警: "경", 軍: "군", 前: "전",
  現: "현", 新: "신", 株: "주", 銀: "은", 車: "차", 稅: "세", 對: "대", 反: "반", 親: "친", 非: "비", 故: "고", 黨: "당", 法: "법",
  女: "여", 男: "남", 核: "핵", 亞: "아", 歐: "구", 億: "억", 兆: "조", 萬: "만", 社: "사", 證: "증", 港: "항", 高: "고", 低: "저",
  大: "대", 小: "소", 上: "상", 下: "하", 年: "년", 月: "월", 重: "중", 輕: "경", 號: "호", 外: "외", 內: "내", 全: "전", 半: "반",
  總: "총", 長: "장", 官: "관", 國: "국", 民: "민", 政: "정", 府: "부", 會: "회", 議: "의", 院: "원", 線: "선", 市: "시", 道: "도",
};
export function hanjaKo(s) {
  return String(s || "")
    .replace(/金(?=\s?(값|리|융|시세|가격|투자|선물|ETF|펀드|거래|시장|보유|매입))/g, "금").replace(/金/g, "김")
    .replace(/[一-鿿]/g, (c) => HANJA[c] || c);
}

// 제목이 회사 이름뿐인 공지성 기사(「[인사] 삼성전자」 「[부고] …」 「[포토]」)는 홈 뉴스에서 뺀다
export function meaty(n) {
  const t = String(n?.title || "");
  if (/^\s*[\[【(]\s*(인사|부고|부음|포토|사진|화보|게시판|알림|모집|공고)\s*[\]】)]/.test(t)) return false;
  return t.replace(/\[[^\]]*\]|【[^】]*】/g, "").trim().length >= 10;
}

// 해외 뉴스(영어 제목)를 한국어로 옮긴다. 제미나이 무료 등급만 쓰고, 안 되면 영어 그대로. 같은 제목은 다시 묻지 않는다
const koCache = new Map();
export const translateState = { why: "" }; // 마지막 번역 실패 이유(확인용, 키 없음)
export async function translateTitles(items) {
  const todo = [...new Set(items.filter((a) => a.lang === "en" && !koCache.has(a.title)).map((a) => a.title))].slice(0, 15);
  if (todo.length && process.env.GEMINI_API_KEY) {
    try {
      const { generate } = await import("./_ai.js");
      // 제미나이 무료 등급은 사람이 몰리면 503(바빠요)을 자주 낸다 → 잠깐 쉬었다가 두 번 더
      const ask = (n) => generate({
        system: "영어 뉴스 제목을 자연스러운 한국어 뉴스 제목으로 옮긴다. 뜻만 옮기고 덧붙이거나 줄이지 않는다. 사람·회사 이름은 한국에서 흔히 쓰는 표기로.",
        text: todo.map((t, i) => `[${i}] ${t}`).join("\n"),
        schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, ko: { type: "string" } }, required: ["i", "ko"], additionalProperties: false } } }, required: ["items"], additionalProperties: false },
        schemaName: "titles", maxTokens: 1200, geminiOnly: true,
      }).catch(async (e) => {
        if (n >= 2 || !/(503|429|500)|UNAVAILABLE|high demand/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (n + 1)));
        return ask(n + 1);
      });
      const out = await ask(0);
      for (const it of JSON.parse(out.text).items || []) {
        const ko = String(it.ko || "").trim();
        if (todo[it.i] && /[가-힣]/.test(ko)) koCache.set(todo[it.i], ko.slice(0, 200));
      }
      if (koCache.size > 500) koCache.delete(koCache.keys().next().value);
      translateState.why = "";
    } catch (e) { console.error("translate", e.message); translateState.why = String(e.message).slice(0, 160); }
  }
  return items.map((a) => (koCache.has(a.title) ? { ...a, title: koCache.get(a.title), orig: a.title, lang: "ko" } : a));
}

function source(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www|m|news|biz)\./, "");
    const hit = Object.keys(SOURCES).find((d) => host === d || host.endsWith("." + d));
    return hit ? SOURCES[hit] : host;
  } catch {
    return "";
  }
}

// 국내 뉴스 검색은 NewsData(무료 등급, 하루 200번)로 한다. 네이버 뉴스 검색 API는 유료라 쓰지 않는다.
export function newsReady() { return !!process.env.NEWSDATA_KEY; }

// 출처 등급: 0 공식 기관(정부·한국은행 등) · 1 주요 언론(SOURCES) · 2 그 밖. 같은 등급 안에서는 원래 순서를 지킨다
const OFFICIAL = /(\.go\.kr|korea\.kr|bok\.or\.kr|fss\.or\.kr|kdi\.re\.kr|krx\.co\.kr)$/;
export function tier(it) {
  try {
    const host = new URL(it.url).hostname;
    if (OFFICIAL.test(host)) return 0;
    return Object.keys(SOURCES).some((d) => host === d || host.endsWith("." + d)) ? 1 : 2;
  } catch { return 2; }
}
export function byTrust(items) {
  return items.map((it, i) => ({ it, i, t: tier(it) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.it);
}

// 거의 같은 제목(같은 사건을 여러 언론이 쓴 것) 걸러내기
export function dedupe(items) {
  const out = [];
  const key = (t) => t.replace(/[^가-힣A-Za-z0-9]/g, "").slice(0, 14);
  const seen = new Set();
  for (const it of items) {
    const k = key(it.title);
    if (!it.title || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function keywords(items) {
  const count = new Map();
  for (const { title } of items) {
    for (const t of TERMS) if (title.includes(t)) count.set(t, (count.get(t) || 0) + 1);
  }
  // '기준금리'가 잡히면 '금리'는 빼는 식으로 겹치는 단어 정리
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const picked = [];
  for (const t of ranked) {
    if (picked.some((p) => p.includes(t) || t.includes(p))) continue;
    picked.push(t);
    if (picked.length === 3) break;
  }
  return picked;
}

export function searchUrl(q) {
  return `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(q)}`;
}


// ── 해외 뉴스: GDELT DOC API (https://api.gdeltproject.org, 무료·키 없음). 5초에 한 번만 부를 수 있어서 1시간 재사용과 함께 쓴다 ──
const GLOBAL = { "reuters.com": "Reuters", "apnews.com": "AP", "cnbc.com": "CNBC", "bbc.com": "BBC", "bbc.co.uk": "BBC", "ft.com": "Financial Times",
  "bloomberg.com": "Bloomberg", "wsj.com": "WSJ", "nytimes.com": "New York Times", "theguardian.com": "Guardian", "economist.com": "Economist", "aljazeera.com": "Al Jazeera" };
export async function gdelt(max = 10) {
  const q = `(economy OR stocks OR markets OR "interest rates" OR tariffs OR inflation) sourcelang:english (${Object.keys(GLOBAL).map((d) => `domain:${d}`).join(" OR ")})`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=${Math.max(max * 2, 10)}&format=json&timespan=2d&sort=hybridrel`;
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); // 오래 기다리지 않고 BBC로 넘어간다
  const t = (await r.text()).trim();
  if (!t.startsWith("{")) throw new Error(`gdelt ${t.slice(0, 60)}`);
  const seen = new Set();
  return (JSON.parse(t).articles || []).filter((a) => a.title && a.url).map((a) => {
    const d = String(a.seendate || "");
    const at = d.length >= 15 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:00Z` : new Date().toISOString();
    const host = String(a.domain || "").replace(/^www\./, "");
    return { title: clean(a.title), url: a.url, source: GLOBAL[host] || host, at, lang: "en" };
  }).filter((a) => { const k = a.title.slice(0, 30); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max);
}

// ── 국내 뉴스: NewsData.io (NEWSDATA_KEY가 있을 때만, 무료 등급 하루 200번) ──
// q를 주면 그 낱말로 찾고(나를 위한 뉴스·키워드·종목 뉴스), 없으면 국내 경제 최신 뉴스.
// 하루 횟수를 아끼려고 이 서버가 결과를 기억한다(낱말 검색 3시간, 경제 최신 30분). 실패하면 기억해 둔 것을 쓴다
const ndCache = new Map();
const ndItems = (j) => (j.results || []).filter((a) => a.title && a.link).map((a) => ({ title: clean(a.title), url: a.link, source: source(a.link) || a.source_name || a.source_id || "", at: new Date(a.pubDate ? a.pubDate.replace(" ", "T") + "Z" : Date.now()).toISOString() }));
const ndUrl = (q, page) => `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(process.env.NEWSDATA_KEY)}&country=kr&language=ko${q ? `&q=${encodeURIComponent(q)}` : "&category=business"}${page ? `&page=${encodeURIComponent(page)}` : ""}`;
export async function newsdata(q) {
  if (!process.env.NEWSDATA_KEY) return [];
  if (!q && adminReady()) { try { return await newsPool(); } catch (e) { console.error("newsPool", e.message); } } // 하루치 모아 두기가 안 되면 예전처럼
  const key = q || "", hit = ndCache.get(key), ttl = q ? 3 * 3600e3 : 1800e3;
  if (hit && Date.now() - hit.at < ttl) return hit.items;
  try {
    const items = ndItems(await fetchJson(ndUrl(q), {}, 8000));
    if (items.length) { ndCache.set(key, { at: Date.now(), items }); if (ndCache.size > 300) ndCache.delete(ndCache.keys().next().value); }
    return items.length ? items : hit?.items || [];
  } catch (e) {
    if (hit) return hit.items;
    throw e;
  }
}

// ── 국내 경제 최신 뉴스 하루치 모아 두기 (Firestore newsPool/kr) ──
// 1시간에 한 번만 2쪽(기사 약 20개, NewsData 2번)을 새로 받아 최근 24시간치와 합친다 → 하루 약 48번.
// 한 번에 10개만 보면 아침에 쏟아진 큰 화제(예: 증안펀드)가 점심엔 사라지므로, 하루치 제목 전체로 화제 점수를 매기기 위함.
// 제목·링크·출처·시간만 저장한다(본문 없음).
const POOL_DOC = "newsPool/kr", POOL_EVERY = 3600e3, POOL_KEEP = 24 * 3600e3, POOL_MAX = 250;
let poolMem = null; // { at: 이 서버가 읽은 시각, fetchedAt, items }
export async function newsPool() {
  if (poolMem && Date.now() - poolMem.at < 5 * 60e3 && Date.now() - poolMem.fetchedAt < POOL_EVERY) return poolMem.items;
  const doc = await fsReq(POOL_DOC);
  const f = doc ? fromFs({ mapValue: { fields: doc.fields || {} } }) : {};
  let items = []; try { items = JSON.parse(f.items || "[]"); } catch {}
  let fetchedAt = Number(f.fetchedAt) || 0;
  if (Date.now() - fetchedAt >= POOL_EVERY || !items.length) {
    const got = [];
    try {
      const j1 = await fetchJson(ndUrl(""), {}, 8000);
      got.push(...ndItems(j1));
      if (j1.nextPage) got.push(...ndItems(await fetchJson(ndUrl("", j1.nextPage), {}, 8000).catch(() => ({}))));
    } catch (e) { console.error("newsdata pool", e.message); }
    if (got.length) {
      const now = Date.now(), byUrl = new Map(items.map((it) => [it.url, it]));
      for (const it of got) if (!byUrl.has(it.url)) byUrl.set(it.url, { ...it, seen: now });
      items = [...byUrl.values()].filter((it) => now - (it.seen || Date.parse(it.at) || 0) < POOL_KEEP)
        .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, POOL_MAX);
      fetchedAt = now;
      await fsSet(POOL_DOC, { items: JSON.stringify(items), fetchedAt, n: items.length }).catch((e) => console.error("pool save", e.message));
    } else if (!items.length) throw new Error("newsdata 빈 결과");
  }
  poolMem = { at: Date.now(), fetchedAt, items };
  return items;
}

// GDELT가 막히면(5초 제한 때문에 자주 429) BBC 경제 RSS로 대신한다 (제목·링크만, 출처 BBC 표시)
export async function bbc(max = 10) {
  const r = await fetch("https://feeds.bbci.co.uk/news/business/rss.xml", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`bbc ${r.status}`);
  const xml = await r.text();
  const pick = (b, tag) => (b.match(new RegExp(String.raw`<${tag}>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</${tag}>`)) || [])[1] || "";
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({ title: clean(pick(m[1], "title")), url: pick(m[1], "link").trim(), source: "BBC", at: new Date(pick(m[1], "pubDate") || Date.now()).toISOString(), lang: "en" }))
    .filter((a) => a.title && a.url).slice(0, max);
}
// 해외 뉴스: GDELT 먼저, 안 되면 BBC → { items, provider }
export async function globalNews(max = 10) {
  try { const items = await gdelt(max); if (items.length) return { items, provider: "GDELT" }; } catch (e) { console.error("gdelt", e.message); }
  return { items: await bbc(max), provider: "BBC" };
}
