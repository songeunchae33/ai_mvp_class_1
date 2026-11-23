// 뉴스 API들이 같이 쓰는 도구. 파일명이 _로 시작해서 주소로 노출되지 않는다.
// 출처를 여러 곳으로 나눈다(한 곳이 막혀도 뉴스가 끊기지 않게): 네이버 뉴스 검색 · 정책브리핑 보도자료(api/_policy.js)
// · GDELT(전 세계 뉴스 목록, 무료 공개 데이터, 해외 뉴스) · NewsData.io(NEWSDATA_KEY가 있을 때만, 무료 등급 하루 200번).
// 모두 제목과 링크만 보여준다(본문 없음, 네이버·NewsData 결과는 AI 요약에 쓰지 않음).
import { fetchJson } from "./_util.js";

// 취향(선호) → 그 사람에게 의미 있는 뉴스 검색어
export const PREF_QUERY = {
  쇼핑: "소비 물가",
  여행: "환율 여행",
  음식: "외식 물가",
  자기계발: "청년 정책",
  저축: "예금 금리",
  부동산: "부동산 금리",
  취미: "소비 트렌드",
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
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
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

// 네이버 뉴스 검색. 새 방식(NAVER API HUB, 네이버 클라우드 플랫폼)을 먼저 쓰고,
// 예전 개발자센터 키만 있으면 그걸 쓴다. 약관상 결과는 '그대로 보여주기'에만 쓴다 (AI 요약 금지).
export function newsReady() {
  return !!((process.env.NAVER_HUB_ID && process.env.NAVER_HUB_SECRET) || (process.env.NAVER_SEARCH_ID && process.env.NAVER_SEARCH_SECRET));
}

export async function naver(query, { display = 10, sort = "date" } = {}) {
  const qs = new URLSearchParams({ query, display: String(display), sort });
  const hub = process.env.NAVER_HUB_ID && process.env.NAVER_HUB_SECRET;
  const json = hub
    ? await fetchJson(`https://naverapihub.apigw.ntruss.com/search/v1/news?${qs}`, {
        headers: { "X-NCP-APIGW-API-KEY-ID": process.env.NAVER_HUB_ID, "X-NCP-APIGW-API-KEY": process.env.NAVER_HUB_SECRET },
      })
    : await fetchJson(`https://openapi.naver.com/v1/search/news.json?${qs}`, {
        headers: { "X-Naver-Client-Id": process.env.NAVER_SEARCH_ID, "X-Naver-Client-Secret": process.env.NAVER_SEARCH_SECRET },
      });
  return (json.items || []).map((it) => {
    const url = it.originallink || it.link;
    return { title: clean(it.title), url, source: source(url), at: new Date(it.pubDate).toISOString() };
  });
}

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
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

// ── 국내 뉴스 보조: NewsData.io (NEWSDATA_KEY가 있을 때만) ──
export async function newsdata() {
  if (!process.env.NEWSDATA_KEY) return [];
  const j = await fetchJson(`https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(process.env.NEWSDATA_KEY)}&country=kr&language=ko&category=business`, {}, 8000);
  return (j.results || []).filter((a) => a.title && a.link).map((a) => ({ title: clean(a.title), url: a.link, source: source(a.link) || a.source_name || a.source_id || "", at: new Date(a.pubDate ? a.pubDate.replace(" ", "T") + "Z" : Date.now()).toISOString() }));
}
